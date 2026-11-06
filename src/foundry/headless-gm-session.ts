/**
 * @fileoverview Automatic, invisible GM-tier browser session for the module bridge.
 *
 * {@link ModuleBridge} hosts a WebSocket server that `foundry-module/` (a
 * companion Foundry module) dials into from inside a real, rendered browser
 * tab — canvas screenshots, native dice rolls, and `FilePicker` uploads only
 * exist inside an actual browser engine, not the headless `socket.io-client`
 * connection {@link FoundryClient} uses.
 *
 * The module's own `Hooks.once('ready')` handler only calls `transport.connect()`
 * when `game.user.isGM` — by design (a Player's canvas is fog-of-war-limited,
 * and `game.togglePause()`/`FilePicker.upload()` are GM-gated by Foundry core
 * itself, not just this module). That means *some* browser tab, logged in as
 * a GM/Assistant-GM user, must stay open for the whole session — previously a
 * manual, easy-to-forget setup step (and a common cause of "capture_scene
 * says no module connected" confusion when the human plays as a Player and
 * nobody is logged in as GM anywhere).
 *
 * This class removes that step: it drives a headless Chromium-based tab
 * (via `playwright-core` — the browser given by an explicit executable path,
 * else the first one installed among Chrome, Edge, Brave, Vivaldi, Chromium
 * and Playwright's own Chromium, see `browser-detect.ts`) and keeps it on `/game`
 * for as long as the server runs, in one of two modes:
 *
 * - **Shared** (default, one account): the page reuses {@link FoundryClient}'s
 *   own session cookie in a dedicated browser context and never fills the
 *   `/join` form. FoundryVTT keeps any number of sockets per session, so the
 *   two connections coexist. Only `FoundryClient` authenticates: when the
 *   cookie stops opening the game (server restart, world shutdown, 24-hour
 *   session expiry) the page asks it for a new session and waits for it.
 * - **Separate account** (`FOUNDRY_HEADLESS_GM_USERNAME` naming another
 *   user): the page logs that account in through `/join` itself and logs in
 *   again if Foundry kicks it back there.
 *
 * A separate watchdog covers a narrower failure the Foundry-level login
 * check above cannot see: the module's own WebSocket to {@link ModuleBridge}
 * can drop (the module's client-side reconnect logic gives up permanently
 * after 10 capped-backoff attempts) while the Foundry session itself stays
 * perfectly logged in — the page never navigates anywhere, so nothing about
 * the login state changes. `isBridgeConnected` in {@link HeadlessGmSessionOptions}
 * lets the caller wire in `ModuleBridge.isConnected()`; if it stays false for
 * a full grace window while the session is otherwise active, this class force-
 * reloads the page, which re-executes the module's `ready` hook and gives it
 * a fresh `transport.connect()` with its backoff counter reset.
 *
 * Best-effort throughout, matching {@link ModuleBridge}: a launch failure (no
 * browser found) or a login failure (wrong credentials, world not active
 * yet) never takes down the Socket.IO connection or the 100+ tools that don't
 * need a browser at all — canvas-only tools just keep reporting "module not
 * connected" until this resolves itself or the operator fixes the cause.
 */

import type { Browser, BrowserContext, ConsoleMessage, Frame, Page, Route } from 'playwright-core';
import { chromium } from 'playwright-core';
import { logger } from '../utils/logger.js';
import {
  type BrowserChoice,
  type BrowserSearch,
  browserNameFromPath,
  findBrowsers,
  noBrowserMessage,
} from './browser-detect.js';

/**
 * Detection with Playwright's own Chromium as the last candidate, for when
 * `playwright install chromium` was run.
 */
export function defaultBrowserSearch(): BrowserSearch {
  let playwrightPath: string | null = null;
  try {
    playwrightPath = chromium.executablePath() || null;
  } catch {
    // No Chromium build registered for this platform.
  }
  return findBrowsers({ playwrightPath });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** First line of an error: Playwright appends a multi-line call log. */
function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? text;
}

/**
 * Launches the headless browser: the explicit `executablePath` (no fallback),
 * else the first browser found that starts. Every launch gets
 * {@link HEADLESS_BROWSER_ARGS} and Playwright's throwaway profile.
 *
 * @throws with the real launch errors; install advice and the locations
 *   tried only when no browser was found at all
 */
export async function launchHeadlessBrowser(options: {
  executablePath?: string;
  findBrowsers?: () => BrowserSearch;
}): Promise<{ browser: Browser; choice: BrowserChoice }> {
  const args = [...HEADLESS_BROWSER_ARGS];
  const { executablePath } = options;
  if (executablePath) {
    try {
      const browser = await chromium.launch({ headless: true, executablePath, args });
      return {
        browser,
        choice: {
          name: browserNameFromPath(executablePath),
          path: executablePath,
          origin: 'configured',
        },
      };
    } catch (error) {
      throw new Error(
        `Could not launch the browser at FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH=${executablePath}: ` +
          `${errorText(error)}. Check the path: it must point to the executable of a ` +
          'Chromium-based browser (Chrome, Edge, Brave, Chromium).',
      );
    }
  }

  const { found, tried } = (options.findBrowsers ?? defaultBrowserSearch)();
  // Install advice only when nothing was found: a browser that is there
  // but fails to start needs its real error, not a hint to install another.
  if (found.length === 0) {
    throw new Error(noBrowserMessage(tried));
  }
  const failures: string[] = [];
  for (const candidate of found) {
    try {
      const browser = await chromium.launch({
        headless: true,
        executablePath: candidate.path,
        args,
      });
      if (failures.length > 0) {
        logger.warn(`Headless GM session: using ${candidate.name} — ${failures.join('; ')}`);
      }
      return { browser, choice: { ...candidate, origin: 'detected' } };
    } catch (error) {
      failures.push(`${candidate.name} (${candidate.path}): ${firstLine(errorText(error))}`);
    }
  }
  throw new Error(
    `Could not launch a browser for the headless GM session. Attempts: ${failures.join('; ')}`,
  );
}

/**
 * Chromium features that stop the companion module from reaching
 * {@link ModuleBridge}. The page is served from `FOUNDRY_URL` (often a public
 * origin) while the bridge listens on `ws://localhost`, and recent Chromium
 * builds block public → local requests: Local Network Access (and its
 * predecessor, Private Network Access) gates them behind a permission prompt,
 * and Brave adds its own "localhost access" permission. A headless browser
 * cannot show or accept a prompt, so the WebSocket just fails with no detail.
 *
 * `LocalNetworkAccessChecks` alone unblocks current builds (verified on
 * Brave 156); the Private Network Access and Brave flags cover older Chromium
 * releases and Brave variants. Unknown feature names are silently ignored, so
 * listing them all is harmless on any given browser.
 *
 * Disabling these checks is acceptable here because this browser is
 * throwaway: a fresh, empty profile per launch that only ever loads
 * `FOUNDRY_URL`, never arbitrary sites — the user's own browser keeps its
 * protections.
 */
export const HEADLESS_BROWSER_ARGS: readonly string[] = [
  `--disable-features=${[
    'LocalNetworkAccessChecks',
    'BlockInsecurePrivateNetworkRequests',
    'PrivateNetworkAccessSendPreflights',
    'PrivateNetworkAccessRespectPreflightResults',
    'BraveLocalhostAccessPermission',
  ].join(',')}`,
];

/**
 * Size of the headless GM page. Playwright's default, 1280x720, is below
 * FoundryVTT's 1366x768 minimum: Foundry warns, and canvas work such as
 * `capture_scene` misbehaves.
 */
export const HEADLESS_VIEWPORT = { width: 1920, height: 1080 } as const;

/** Where the companion module's scripts are served from. */
const BRIDGE_SCRIPT_PATH = '/modules/foundryvtt-mcp-bridge/';
/** The prefixes the companion module puts on its console lines. */
const BRIDGE_CONSOLE_PREFIXES = ['FoundryVTT MCP Bridge | ', 'foundryvtt-mcp-bridge | '];
const BRIDGE_CONSOLE_MAX_LENGTH = 500;
const BRIDGE_PAGE_ERROR_MAX_LENGTH = 200;
/** A stack frame (Chromium format) inside one of the module's scripts. */
const BRIDGE_STACK_FRAME = /^\s+at .*\/modules\/foundryvtt-mcp-bridge\//m;

function isBridgeScript(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith(BRIDGE_SCRIPT_PATH);
  } catch {
    return false;
  }
}

/**
 * The part of a page console message worth copying to the log: a companion
 * module line, printed by one of the module's own scripts, reduced to its
 * first argument. Further arguments (a received command, an error) and
 * every other script's lines stay out of the log, so no page, document or
 * command content reaches it. `msg.text()` is never used: it renders every
 * argument, including an object's own fields.
 *
 * @returns the line, cut to {@link BRIDGE_CONSOLE_MAX_LENGTH}, or `null`
 */
export async function bridgeConsoleText(
  message: Pick<ConsoleMessage, 'location' | 'args'>,
): Promise<string | null> {
  if (!isBridgeScript(message.location().url)) {
    return null;
  }
  const first = message.args()[0];
  if (!first) {
    return null;
  }
  let value: unknown;
  try {
    value = await first.jsonValue();
  } catch {
    // The page navigated away before the argument could be read.
    return null;
  }
  if (typeof value !== 'string' || !BRIDGE_CONSOLE_PREFIXES.some((p) => value.startsWith(p))) {
    return null;
  }
  return value.slice(0, BRIDGE_CONSOLE_MAX_LENGTH);
}

/**
 * `name: message` of an uncaught page error thrown from the companion
 * module's code (a stack frame in its scripts), without the stack.
 *
 * @returns the text, cut to {@link BRIDGE_PAGE_ERROR_MAX_LENGTH}, or `null`
 */
export function bridgePageErrorText(error: Error): string | null {
  if (!BRIDGE_STACK_FRAME.test(error.stack ?? '')) {
    return null;
  }
  return `${error.name}: ${error.message}`.slice(0, BRIDGE_PAGE_ERROR_MAX_LENGTH);
}

/** Page binding behind `window.foundryMcpBridge`; see {@link BRIDGE_INIT_SCRIPT}. */
const BRIDGE_BINDING = '__foundryMcpBridgeCall';

/**
 * Defines `window.foundryMcpBridge`, which the companion module looks for
 * before dialling the bridge, on top of {@link BRIDGE_BINDING}. Runs before
 * any page script on every navigation (join form, /game, reloads); the
 * binding is looked up at call time, so the order in which Playwright
 * installs the two never matters.
 */
const BRIDGE_INIT_SCRIPT = `(() => {
  const call = (method, arg) => globalThis.${BRIDGE_BINDING}(method, arg);
  Object.defineProperty(globalThis, 'foundryMcpBridge', {
    value: Object.freeze({
      getInfo: () => call('getInfo'),
      prove: (serverNonce) => call('prove', serverNonce),
    }),
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();`;

/**
 * Shared mode: main-frame navigations the page may make are to `/game` only;
 * see {@link HeadlessGmSession.guardNavigations}. Matches same-origin URLs
 * whose path has no file extension (pages, not assets) other than `/game`,
 * so only those few requests are intercepted.
 */
function guardedNavigationPattern(origin: string): RegExp {
  const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}/(?!game(?:[/?#]|$))[^.?#]*(?:[?#].*)?$`);
}

/** Shared mode: how long a loaded `/game` may take to report `game.ready`. */
const GAME_READY_TIMEOUT_MS = 60000;

const JOIN_SELECTOR_TIMEOUT_MS = 20000;
const LOGIN_NAV_TIMEOUT_MS = 15000;
const BASE_RETRY_MS = 5000;
const MAX_RETRY_MS = 120000;

/** How often the bridge-connectivity watchdog polls `isBridgeConnected`. */
const WATCHDOG_INTERVAL_MS = 20000;
/** Consecutive down polls (≈60s) tolerated before forcing a page reload. */
const WATCHDOG_GRACE_TICKS = 3;

/**
 * Answers the companion module's `window.foundryMcpBridge` calls in the
 * headless page. Implemented by `ModuleBridge`, which keeps the handshake
 * secret to itself: only nonces and proofs ever reach the page.
 */
export interface BridgeCredentials {
  info(): { protocol: number; port: number };
  /** @throws on an invalid server nonce */
  prove(serverNonce: unknown): { nonce: string; clientProof: string; serverProof: string };
}

/**
 * The connector's own FoundryVTT session, shared with the page (one account
 * for both). Implemented by `FoundryClient`, the only side that authenticates.
 */
export interface SessionSource {
  /** Current session cookie; `null` before the first authentication. */
  currentSession(): string | null;
  /** @returns a function that removes the listener */
  onSessionChanged(listener: (session: string) => void): () => void;
  /** Authenticates again; concurrent requests share one attempt. */
  reauthenticate(reason: string): Promise<void>;
}

/**
 * Where a session stands. Shared mode: `waiting-for-session` (no cookie
 * yet), `logged-in`, `reauthenticating` (the cookie was refused; a new one
 * was asked for), `reconnecting` (FoundryVTT could not be reached; the page
 * retries with the same cookie). Separate account: `logging-in` or `logged-in`.
 */
export type HeadlessSessionState =
  | 'waiting-for-session'
  | 'logging-in'
  | 'logged-in'
  | 'reauthenticating'
  | 'reconnecting';

export interface HeadlessGmSessionOptions {
  foundryUrl: string;
  /** Account the page runs as (shown in status lines). */
  username: string;
  /** Separate-account mode: password for the page's own `/join` login. */
  password?: string;
  /**
   * Shared mode: the page reuses this session cookie and never fills the
   * `/join` form; `password` is then unused.
   */
  sessionSource?: SessionSource;
  /** Explicit browser executable path; skips detection, with no fallback. */
  executablePath?: string;
  /** Finds the installed browsers; {@link defaultBrowserSearch} unless a test injects one. */
  findBrowsers?: () => BrowserSearch;
  /**
   * Polled every {@link WATCHDOG_INTERVAL_MS} while logged in; sustained
   * `false` triggers a page reload to recover a dropped module-bridge
   * WebSocket the Foundry-level login check has no visibility into. Omit to
   * disable the watchdog (e.g. in tests that don't care about it).
   */
  isBridgeConnected?: () => boolean;
  /**
   * Exposed to the page as `window.foundryMcpBridge`; without it the module
   * finds no credentials and stays disconnected.
   */
  bridgeCredentials?: BridgeCredentials;
}

/** The origin of `url`, or `null` when it has none (`about:blank`, a malformed URL). */
function frameOrigin(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** URL pathnames Foundry serves when nobody is logged in for this session. */
const LOGGED_OUT_PATHS: Record<string, true> = {
  '/join': true,
  '/setup': true,
  '/license': true,
  '/no-auth': true,
};

/**
 * Drives an invisible, persistently-logged-in GM browser session so the
 * companion module's bridge stays connected without any manual browser tab.
 */
export class HeadlessGmSession {
  private readonly options: HeadlessGmSessionOptions;
  private browser: Browser | null = null;
  /** Shared mode: the dedicated context holding the shared cookie. */
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private active = false;
  private sharedState: HeadlessSessionState = 'waiting-for-session';
  /** Shared mode: a new session was asked for and has not arrived yet. */
  private reauthRequested = false;
  /** Shared mode: a new cookie waits its turn; a load still using the old one may fail. */
  private sessionQueued = false;
  /** Shared mode: cookie updates and `/game` loads, one after the other. */
  private pageTask: Promise<void> = Promise.resolve();
  private loadingGame = false;
  /** Shared mode: loads of /game keep failing (one warning per outage). */
  private loadRetrying = false;
  private unsubscribeSession: (() => void) | null = null;
  private lastError: string | null = null;
  private retryDelayMs = BASE_RETRY_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private bridgeDownTicks = 0;
  private stopped = false;
  private browserChoice: BrowserChoice | null = null;

  constructor(options: HeadlessGmSessionOptions) {
    this.options = options;
  }

  /**
   * Launches the browser and returns once it is up. Login itself happens in
   * the background (see {@link attemptLogin}): Foundry may not be reachable
   * yet, and that must not block server startup or take other tools down.
   *
   * @throws if no browser could be launched at all — the explicit path
   *   failed, or no browser was found or none of those found would start.
   *   The message carries the real launch errors (install advice and the
   *   locations tried only when nothing was found); the caller logs it and keeps it for
   *   `status` and `get_health_status`.
   */
  async start(): Promise<void> {
    this.stopped = false;
    this.browser = await this.launchBrowser();
    const { sessionSource } = this.options;
    if (sessionSource) {
      // A context of its own: the shared cookie never mixes with anything else.
      this.context = await this.browser.newContext({ viewport: HEADLESS_VIEWPORT });
      this.page = await this.context.newPage();
    } else {
      this.page = await this.browser.newPage({ viewport: HEADLESS_VIEWPORT });
    }
    // The companion module reports bridge failures only in the browser console.
    this.page.on('console', (message) => {
      void this.logBridgeConsole(message);
    });
    this.page.on('pageerror', (error) => {
      const text = bridgePageErrorText(error);
      if (text) {
        logger.warn(`Headless GM page error (bridge): ${text}`);
      }
    });
    if (this.options.bridgeCredentials) {
      // Before the first navigation, so the module finds it on its first `ready`.
      await this.exposeBridgeCredentials(this.page, this.options.bridgeCredentials);
    }
    this.page.on('framenavigated', (frame) => {
      if (frame !== this.page?.mainFrame()) {
        return;
      }
      const path = new URL(frame.url()).pathname;
      if (sessionSource && path === '/game' && !this.loadingGame) {
        // The page reloaded /game by itself (its client after a server
        // restart, the bridge watchdog). With no world, FoundryVTT serves
        // its "No Active Game" page there instead of redirecting: only
        // `game.ready` tells.
        this.active = false;
        this.sharedState = 'reconnecting';
        this.lastError = 'the page reloaded; waiting for the game';
        this.enqueuePageTask(() => this.confirmGameReady());
        return;
      }
      if (!LOGGED_OUT_PATHS[path]) {
        return;
      }
      if (sessionSource) {
        // Only a server redirect gets here (guardNavigations blocks the
        // page's own navigations), and FoundryVTT redirects to /join only
        // when the session is no longer valid.
        this.onSessionRefused(`FoundryVTT redirected the page to ${path}`);
        return;
      }
      if (this.active) {
        logger.warn('Headless GM session logged out unexpectedly — re-logging in', {
          url: frame.url(),
        });
        this.active = false;
        this.scheduleLogin(0);
      }
    });
    if (sessionSource) {
      await this.guardNavigations(this.page);
      this.unsubscribeSession = sessionSource.onSessionChanged((session) => {
        this.useSession(session);
      });
      const session = sessionSource.currentSession();
      if (session) {
        this.useSession(session);
      }
    } else {
      this.sharedState = 'logging-in';
      this.scheduleLogin(0);
    }
    if (this.options.isBridgeConnected) {
      this.watchdogTimer = setInterval(() => this.checkBridgeHealth(), WATCHDOG_INTERVAL_MS);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer ?? undefined);
    this.retryTimer = null;
    clearInterval(this.watchdogTimer ?? undefined);
    this.watchdogTimer = null;
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    this.active = false;
    await this.page?.close().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  /** True once {@link start} has launched the browser, until {@link stop}. */
  isStarted(): boolean {
    return this.browser !== null;
  }

  /** True once the session is logged in with a live GM-tier Foundry client. */
  isActive(): boolean {
    return this.active;
  }

  /** `shared`: the page reuses the connector's session; `separate`: its own account. */
  mode(): 'shared' | 'separate' {
    return this.options.sessionSource ? 'shared' : 'separate';
  }

  /** Account the page runs as. */
  username(): string {
    return this.options.username;
  }

  /** See {@link HeadlessSessionState}. */
  sessionState(): HeadlessSessionState {
    if (this.active) {
      return 'logged-in';
    }
    return this.sharedState;
  }

  /** e.g. "sharing the connector's session (mcp-api)" or "separate account (mcp-gm)". */
  modeText(): string {
    return this.mode() === 'shared'
      ? `sharing the connector's session (${this.options.username})`
      : `separate account (${this.options.username})`;
  }

  /** Short human-readable status line for `get_health_status`. */
  statusText(): string {
    const mode = this.modeText();
    if (this.active) {
      return `✅ Logged in — ${mode}`;
    }
    const state = this.sessionState();
    if (state === 'waiting-for-session') {
      return `⏳ Waiting for the connector's session — ${mode}`;
    }
    if (state === 'reauthenticating') {
      return `⏳ Reauthenticating — ${mode}${this.lastError ? ` (${this.lastError})` : ''}`;
    }
    if (state === 'reconnecting') {
      return `⏳ Reconnecting — ${mode}${this.lastError ? ` (${this.lastError})` : ''}`;
    }
    return this.lastError
      ? `⏳ Not connected yet — ${mode} — ${this.lastError}`
      : `⏳ Logging in — ${mode}`;
  }

  /**
   * Shared mode: blocks every main-frame navigation away from `/game` —
   * `game.logOut()` (the "Log Out" button, or the client reacting to its
   * own role change) loads `/join`, and a GET /join logs the SHARED session
   * out of the world (server sessions.mjs `logoutWorld`), which would leave
   * the connector's socket anonymous at its next reconnection. The page
   * reloads `/game` instead.
   *
   * A server redirect escapes this: Playwright calls a route handler only
   * for the first URL of a redirect chain, so GET /game → 302 /join is not
   * intercepted. That is harmless: FoundryVTT redirects /game to /join only
   * when the session no longer names a user (server views/game.mjs), so the
   * GET /join it causes has nothing left to log out, and the
   * `framenavigated` handler asks for a new session.
   */
  private async guardNavigations(page: Page): Promise<void> {
    const origin = new URL(this.options.foundryUrl).origin;
    await page.route(guardedNavigationPattern(origin), async (route: Route) => {
      const request = route.request();
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) {
        await route.continue().catch(() => undefined);
        return;
      }
      logger.warn('Headless GM session blocked a navigation away from /game — reloading /game', {
        path: new URL(request.url()).pathname,
      });
      await route.abort('aborted').catch(() => undefined);
      if (this.active && !this.loadingGame) {
        this.active = false;
        this.enqueuePageTask(() => this.loadGame());
      }
    });
  }

  /** Shared mode: installs a new session cookie, then (re)loads `/game`. */
  private useSession(session: string): void {
    this.reauthRequested = false;
    clearTimeout(this.retryTimer ?? undefined);
    this.retryTimer = null;
    this.sessionQueued = true;
    this.enqueuePageTask(async () => {
      this.sessionQueued = false;
      if (!this.context) {
        return;
      }
      const url = new URL(this.options.foundryUrl);
      await this.context.clearCookies();
      await this.context.addCookies([
        {
          name: 'session',
          value: session,
          domain: url.hostname,
          path: '/',
          httpOnly: true,
          secure: url.protocol === 'https:',
          sameSite: 'Strict',
        },
      ]);
      await this.loadGame();
    });
  }

  private enqueuePageTask(task: () => Promise<void>): void {
    this.pageTask = this.pageTask.then(task).catch((error: unknown) => {
      // loadGame() handles its own failures; this guards the chain itself.
      logger.error('Headless GM session page task failed unexpectedly', error);
    });
  }

  /**
   * Shared mode: loads `/game` with the current cookie and waits for
   * `game.ready`. FoundryVTT answers /game with its "No Active Game" page
   * (HTTP 200, no `game`) when no world runs, hence the ready check.
   */
  private async loadGame(): Promise<void> {
    if (this.stopped || !this.page) {
      return;
    }
    this.loadingGame = true;
    this.active = false;
    if (this.sharedState === 'logged-in') {
      // Not logged in until the game is ready again.
      this.sharedState = 'reconnecting';
      this.lastError = 'loading /game';
    }
    try {
      const gameUrl = new URL('/game', this.options.foundryUrl).toString();
      await this.page.goto(gameUrl, { waitUntil: 'domcontentloaded' });
      const path = new URL(this.page.url()).pathname;
      if (path !== '/game') {
        this.onSessionRefused(`FoundryVTT redirected the page to ${path}`);
        return;
      }
      await this.awaitGameReady(true);
    } catch (error) {
      // The page could not load at all (network down, server restarting):
      // nothing says the cookie is bad, so keep it and try again.
      this.retryLoadGame(firstLine(errorText(error)));
    } finally {
      this.loadingGame = false;
    }
  }

  /**
   * Shared mode: after the page reloaded `/game` on its own, waits for
   * the game again. Skipped when a load of ours started meanwhile.
   */
  private async confirmGameReady(): Promise<void> {
    if (this.stopped || !this.page || this.active || this.loadingGame) {
      return;
    }
    if (new URL(this.page.url()).pathname !== '/game') {
      return;
    }
    this.loadingGame = true;
    try {
      await this.awaitGameReady(false);
    } finally {
      this.loadingGame = false;
    }
  }

  /**
   * Shared mode: `game.ready` within the timeout, or a request for a new session.
   *
   * @param announce - log the login even when the page already counted as
   *   logged in (a load with a new cookie), not only after a loss
   */
  private async awaitGameReady(announce: boolean): Promise<void> {
    if (!this.page) {
      return;
    }
    const ready = await this.page
      .waitForFunction(
        () => (globalThis as { game?: { ready?: boolean } }).game?.ready === true,
        null,
        { timeout: GAME_READY_TIMEOUT_MS },
      )
      .then(
        () => true,
        () => false,
      );
    if (this.stopped) {
      return;
    }
    if (!ready) {
      this.onSessionRefused('the game never became ready (no active world?)');
      return;
    }
    const wasLoggedIn = this.sharedState === 'logged-in';
    this.active = true;
    this.sharedState = 'logged-in';
    this.lastError = null;
    this.retryDelayMs = BASE_RETRY_MS;
    this.loadRetrying = false;
    if (announce || !wasLoggedIn) {
      logger.info(`Headless GM session logged in — ${this.modeText()}`);
    }
  }

  /**
   * Shared mode: `/game` could not be loaded. Tries again with the same
   * cookie, waiting {@link BASE_RETRY_MS} and doubling up to
   * {@link MAX_RETRY_MS}; one warning per outage, not per attempt.
   */
  private retryLoadGame(reason: string): void {
    if (this.stopped) {
      return;
    }
    if (!this.loadRetrying) {
      this.loadRetrying = true;
      logger.warn(
        `Headless GM session could not load /game (${reason}) — retrying with the same session`,
      );
    }
    this.active = false;
    this.sharedState = 'reconnecting';
    this.lastError = reason;
    clearTimeout(this.retryTimer ?? undefined);
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.enqueuePageTask(() => this.loadGame());
    }, delay);
  }

  /**
   * Shared mode: the cookie no longer opens the game. Asks the connector for
   * a new session — once, however many events report it, until one arrives.
   */
  private onSessionRefused(reason: string): void {
    const { sessionSource } = this.options;
    if (!sessionSource || this.stopped) {
      return;
    }
    this.active = false;
    this.sharedState = 'reauthenticating';
    this.lastError = reason;
    // A newer cookie is about to be tried: this refusal was the old one's.
    if (this.reauthRequested || this.sessionQueued) {
      return;
    }
    this.reauthRequested = true;
    logger.warn(`Headless GM session: ${reason} — asking the connector for a new session`);
    sessionSource.reauthenticate(`headless GM page: ${reason}`).catch((error: unknown) => {
      // The connector keeps retrying on its own; the page waits for its cookie.
      this.lastError = `${reason}; reauthentication failed: ${errorText(error)}`;
    });
  }

  /**
   * Gives the page `window.foundryMcpBridge`. The binding and the init
   * script are page-wide and survive navigations and reloads, so this runs
   * once per page. Only frames served from `FOUNDRY_URL`'s origin get an
   * answer: an embedded third-party iframe sees the object, but its calls
   * are refused.
   */
  private async exposeBridgeCredentials(page: Page, credentials: BridgeCredentials): Promise<void> {
    const foundryOrigin = new URL(this.options.foundryUrl).origin;
    await page.exposeBinding(
      BRIDGE_BINDING,
      (source: { frame: Frame }, method: unknown, arg: unknown) => {
        if (frameOrigin(source.frame.url()) !== foundryOrigin) {
          logger.warn('Headless GM session refused a foundryMcpBridge call from another origin', {
            url: source.frame.url(),
          });
          throw new Error('foundryMcpBridge is only available to the Foundry page');
        }
        if (method === 'getInfo') {
          return credentials.info();
        }
        if (method === 'prove') {
          return credentials.prove(arg);
        }
        throw new Error('Unknown foundryMcpBridge call');
      },
    );
    await page.addInitScript({ content: BRIDGE_INIT_SCRIPT });
  }

  /** The browser this session launched; `null` until {@link start} launches one. */
  browserInfo(): BrowserChoice | null {
    return this.browserChoice;
  }

  private async launchBrowser(): Promise<Browser> {
    const { browser, choice } = await launchHeadlessBrowser(this.options);
    this.browserChoice = choice;
    return browser;
  }

  private scheduleLogin(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.retryTimer ?? undefined);
    this.retryTimer = setTimeout(() => {
      this.attemptLogin().catch((error) => {
        // attemptLogin itself never throws (see its own try/catch) — this is
        // a last-resort guard so a bug there can never kill the retry loop.
        logger.error('Headless GM session login attempt threw unexpectedly', error);
      });
    }, delayMs);
  }

  private async attemptLogin(): Promise<void> {
    if (this.stopped || !this.page) {
      return;
    }

    try {
      const joinUrl = new URL('/join', this.options.foundryUrl).toString();
      await this.page.goto(joinUrl, { waitUntil: 'domcontentloaded' });
      // FoundryVTT v14 renamed the join form's user list from `userid` (v13)
      // to `userId` (camelCase), so match either.
      const userSelectSelector = 'select[name="userId"], select[name="userid"]';
      await this.page.waitForSelector(userSelectSelector, {
        timeout: JOIN_SELECTOR_TIMEOUT_MS,
      });

      const selected = await this.page.evaluate(
        ({ username, selector }: { username: string; selector: string }) => {
          const select = document.querySelector<HTMLSelectElement>(selector);
          if (!select) {
            return false;
          }
          const option = Array.from(select.options).find(
            (o) => o.text.trim().toLowerCase() === username.trim().toLowerCase(),
          );
          if (!option) {
            return false;
          }
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        },
        { username: this.options.username, selector: userSelectSelector },
      );

      if (!selected) {
        throw new Error(
          `No user named "${this.options.username}" is registered in this world's join list`,
        );
      }

      // FoundryVTT v14's join form has two password fields: the player
      // `password` and the world's `adminPassword`. Target the player field by
      // name and never touch `adminPassword`; fall back to the first password
      // input only for forms without a named `password` field.
      const passwordInput =
        (await this.page.$('input[name="password"]')) ??
        (await this.page.$('input[type="password"]'));
      if (passwordInput) {
        await passwordInput.fill(this.options.password ?? '');
      }

      await Promise.all([
        this.page
          .waitForURL((url) => url.pathname === '/game', { timeout: LOGIN_NAV_TIMEOUT_MS })
          .catch(() => undefined),
        this.page.click('button[name="join"]'),
      ]);

      if (!this.page.url() || new URL(this.page.url()).pathname !== '/game') {
        throw new Error(
          'Join submitted but the session never reached /game — check the password and that the world is active',
        );
      }

      this.active = true;
      this.lastError = null;
      this.retryDelayMs = BASE_RETRY_MS;
      logger.info(`Headless GM session logged in as ${this.options.username}`);
    } catch (error) {
      this.active = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      logger.warn(
        `Headless GM session login failed — retrying in ${Math.round(this.retryDelayMs / 1000)}s`,
        { error: this.lastError },
      );
      const delay = this.retryDelayMs;
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_MS);
      this.scheduleLogin(delay);
    }
  }

  /**
   * Polled by the watchdog interval. A single down poll is normal — the
   * module's own client-side reconnect logic should recover most drops on
   * its own within a few seconds — so this only acts once the down count
   * reaches {@link WATCHDOG_GRACE_TICKS}, at which point that logic has
   * plausibly given up (it caps out after 10 attempts) and a page reload
   * gives it a completely fresh start.
   */
  private checkBridgeHealth(): void {
    if (this.stopped || !this.active || !this.options.isBridgeConnected) {
      this.bridgeDownTicks = 0;
      return;
    }
    if (this.options.isBridgeConnected()) {
      this.bridgeDownTicks = 0;
      return;
    }
    this.bridgeDownTicks++;
    if (this.bridgeDownTicks < WATCHDOG_GRACE_TICKS) {
      return;
    }
    this.bridgeDownTicks = 0;
    this.reloadForBridgeRecovery();
  }

  /** Copies a companion module console line to the log ({@link bridgeConsoleText}). Never throws. */
  private async logBridgeConsole(message: ConsoleMessage): Promise<void> {
    const text = await bridgeConsoleText(message);
    if (!text) {
      return;
    }
    const type = message.type();
    if (type === 'warning' || type === 'error') {
      logger.warn(
        `Headless GM page [bridge console.${type === 'warning' ? 'warn' : type}]: ${text}`,
      );
    } else {
      logger.info(`Headless GM page [bridge console.${type}]: ${text}`);
    }
  }

  /**
   * Forces a fresh page load: the Foundry session cookie survives a reload,
   * so this does not need to repeat the login form — it just re-executes
   * every module's `init`/`ready` hooks, giving the companion module a new
   * `transport.connect()` attempt with its reconnect backoff reset to zero.
   * Never throws: a failed reload just leaves the next watchdog tick to try
   * again.
   */
  private reloadForBridgeRecovery(): void {
    if (!this.page) {
      return;
    }
    logger.warn(
      'Module bridge has been disconnected while the headless GM session stayed logged in — reloading the page to recover',
    );
    this.page.reload({ waitUntil: 'domcontentloaded' }).catch((error) => {
      logger.error('Headless GM session bridge-recovery reload failed', error);
    });
  }
}
