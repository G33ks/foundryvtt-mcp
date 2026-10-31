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
 * This class removes that step: it drives a headless Chromium/Chrome/Edge tab
 * (via `playwright-core`, no bundled browser download required — it launches
 * whatever Chrome/Edge is already installed) through Foundry's own `/join`
 * login form using the same account {@link FoundryClient} already
 * authenticates as, and keeps it logged in for as long as the server runs,
 * re-logging in automatically if Foundry kicks it back to `/join` (a world
 * restart, a server restart, a session timeout).
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

import type { Browser, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { logger } from '../utils/logger.js';

/** Chrome/Edge release channels tried in order when no explicit path is configured. */
const BROWSER_CHANNELS: Array<string | undefined> = ['chrome', 'msedge', undefined];

const JOIN_SELECTOR_TIMEOUT_MS = 20000;
const LOGIN_NAV_TIMEOUT_MS = 15000;
const BASE_RETRY_MS = 5000;
const MAX_RETRY_MS = 120000;

/** How often the bridge-connectivity watchdog polls `isBridgeConnected`. */
const WATCHDOG_INTERVAL_MS = 20000;
/** Consecutive down polls (≈60s) tolerated before forcing a page reload. */
const WATCHDOG_GRACE_TICKS = 3;

export interface HeadlessGmSessionOptions {
  foundryUrl: string;
  username: string;
  password: string;
  /** Explicit browser executable path; skips the channel-detection fallback chain. */
  executablePath?: string;
  /**
   * Polled every {@link WATCHDOG_INTERVAL_MS} while logged in; sustained
   * `false` triggers a page reload to recover a dropped module-bridge
   * WebSocket the Foundry-level login check has no visibility into. Omit to
   * disable the watchdog (e.g. in tests that don't care about it).
   */
  isBridgeConnected?: () => boolean;
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
  private page: Page | null = null;
  private active = false;
  private lastError: string | null = null;
  private retryDelayMs = BASE_RETRY_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private bridgeDownTicks = 0;
  private stopped = false;

  constructor(options: HeadlessGmSessionOptions) {
    this.options = options;
  }

  /**
   * Launches the browser and returns once it is up. Login itself happens in
   * the background (see {@link attemptLogin}): Foundry may not be reachable
   * yet, and that must not block server startup or take other tools down.
   *
   * @throws if no usable browser could be launched at all (explicit path
   *   invalid, or none of chrome/msedge/bundled chromium are installed) —
   *   the one genuinely fatal condition, caught by the caller and logged
   *   the same way a `ModuleBridge` port conflict is.
   */
  async start(): Promise<void> {
    this.stopped = false;
    this.browser = await this.launchBrowser();
    this.page = await this.browser.newPage();
    this.page.on('framenavigated', (frame) => {
      if (frame !== this.page?.mainFrame()) {
        return;
      }
      const path = new URL(frame.url()).pathname;
      if (this.active && LOGGED_OUT_PATHS[path]) {
        logger.warn('Headless GM session logged out unexpectedly — re-logging in', {
          url: frame.url(),
        });
        this.active = false;
        this.scheduleLogin(0);
      }
    });
    this.scheduleLogin(0);
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
    this.active = false;
    await this.page?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = null;
    this.browser = null;
  }

  /** True once the session is logged in with a live GM-tier Foundry client. */
  isActive(): boolean {
    return this.active;
  }

  /** Short human-readable status line for `get_health_status`. */
  statusText(): string {
    if (this.active) {
      return `✅ Logged in as \`${this.options.username}\``;
    }
    return this.lastError ? `⏳ Not connected yet — ${this.lastError}` : '⏳ Logging in…';
  }

  private async launchBrowser(): Promise<Browser> {
    if (this.options.executablePath) {
      return chromium.launch({ headless: true, executablePath: this.options.executablePath });
    }

    const attempts: string[] = [];
    for (const channel of BROWSER_CHANNELS) {
      try {
        return await chromium.launch(
          channel !== undefined ? { headless: true, channel } : { headless: true },
        );
      } catch (error) {
        attempts.push(
          `${channel ?? 'bundled chromium'}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    throw new Error(
      `No usable browser found for the headless GM session (tried chrome, msedge, bundled chromium). ` +
        `Install Google Chrome or Microsoft Edge, set FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH to a browser ` +
        `binary, or set FOUNDRY_HEADLESS_GM_ENABLED=false to fall back to a manually-opened GM browser tab. ` +
        `Attempts: ${attempts.join('; ')}`,
    );
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
        await passwordInput.fill(this.options.password);
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
