/**
 * @fileoverview Tests for the automatic headless GM browser session.
 */

import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../utils/logger.js';
import {
  bridgeConsoleText,
  bridgePageErrorText,
  HEADLESS_BROWSER_ARGS,
  HEADLESS_VIEWPORT,
  HeadlessGmSession,
} from '../headless-gm-session.js';

const launchMock = vi.fn();
vi.mock('playwright-core', () => ({
  chromium: { launch: (...args: unknown[]) => launchMock(...args) },
}));

/** The installed browsers, as detection would report them. */
const searchMock = vi.fn();
vi.mock('../browser-detect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../browser-detect.js')>()),
  findBrowsers: () => searchMock(),
}));

const BRAVE = {
  name: 'Brave',
  path: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
};
const CHROMIUM = {
  name: 'Chromium',
  path: 'C:\\Users\\me\\AppData\\Local\\Chromium\\Application\\chrome.exe',
};

/** Minimal fake of the Playwright `Page` surface this module drives. */
interface FakePage {
  on: Mock;
  mainFrame: Mock;
  goto: Mock;
  waitForSelector: Mock;
  evaluate: Mock;
  $: Mock;
  click: Mock;
  waitForURL: Mock;
  url: Mock;
  reload: Mock;
  close: Mock;
  exposeBinding: Mock;
  addInitScript: Mock;
  /** Test helper: fires the captured `framenavigated` listener. */
  emitFrameNavigated: (url: string) => void;
}

interface FakeBrowser {
  newPage: Mock;
  close: Mock;
}

/** A fake `page.$()` element handle whose `.fill()` is observable. */
function fakeElementHandle() {
  return { fill: vi.fn().mockResolvedValue(undefined) };
}

/**
 * Builds a fake Playwright `Page`. `state.url` is a mutable ref: `click()`
 * flips it to `/game` when `succeedOnClick` is true, simulating a real
 * navigation — the code under test reads `page.url()` after
 * `click()`/`waitForURL()` settle rather than trusting `waitForURL()`'s own
 * resolution.
 */
function fakePage(state: {
  url: string;
  evaluateResult: boolean;
  succeedOnClick: boolean;
}): FakePage {
  let framenavigatedHandler: ((frame: unknown) => void) | undefined;
  const mainFrame = { url: () => state.url };
  return {
    on: vi.fn((event: string, handler: (frame: unknown) => void) => {
      if (event === 'framenavigated') {
        framenavigatedHandler = handler;
      }
    }),
    mainFrame: vi.fn(() => mainFrame),
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation(async () => state.evaluateResult),
    $: vi.fn().mockResolvedValue(fakeElementHandle()),
    click: vi.fn().mockImplementation(async () => {
      if (state.succeedOnClick) {
        state.url = 'http://localhost:30000/game';
      }
    }),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    url: vi.fn(() => state.url),
    reload: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    exposeBinding: vi.fn().mockResolvedValue(undefined),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    emitFrameNavigated(url: string) {
      mainFrame.url = () => url;
      framenavigatedHandler?.(mainFrame);
    },
  };
}

const BRIDGE_SCRIPT = 'http://localhost:30000/modules/foundryvtt-mcp-bridge/scripts/transport.js';
const CORE_SCRIPT = 'http://localhost:30000/scripts/foundry.mjs';

/** A fake Playwright `ConsoleMessage`: `console.<type>(...args)` from `scriptUrl`. */
function consoleMessage(type: string, scriptUrl: string, args: unknown[]) {
  return {
    type: () => type,
    text: vi.fn(() => args.map(String).join(' ')),
    location: () => ({ url: scriptUrl, lineNumber: 1, columnNumber: 1 }),
    args: () => args.map((value) => ({ jsonValue: vi.fn().mockResolvedValue(value) })),
  };
}

/** An error as Playwright's `pageerror` reports it, thrown from `scriptUrl`. */
function errorWithStack(name: string, message: string, scriptUrl: string): Error {
  const error = new Error(message);
  error.name = name;
  error.stack = `${name}: ${message}\n    at handle (${scriptUrl}:109:15)`;
  return error;
}

function fakeBrowser(page: FakePage): FakeBrowser {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('HeadlessGmSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    launchMock.mockReset();
    searchMock.mockReset();
    searchMock.mockReturnValue({ found: [BRAVE], tried: [BRAVE.path] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('launches the first browser found by its executable path', async () => {
    const page = fakePage({
      url: 'http://localhost:30000/join',
      evaluateResult: true,
      succeedOnClick: true,
    });
    launchMock.mockResolvedValue(fakeBrowser(page));
    searchMock.mockReturnValue({ found: [BRAVE, CHROMIUM], tried: [BRAVE.path, CHROMIUM.path] });

    const session = new HeadlessGmSession({
      foundryUrl: 'http://localhost:30000',
      username: 'mcp-api',
      password: 'mcp',
    });
    await session.start();

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(launchMock).toHaveBeenCalledWith({
      headless: true,
      executablePath: BRAVE.path,
      args: HEADLESS_BROWSER_ARGS,
    });
    expect(session.browserInfo()).toEqual({ ...BRAVE, origin: 'detected' });
    await session.stop();
  });

  it('moves on to the next browser found when one fails to start', async () => {
    const page = fakePage({
      url: 'http://localhost:30000/join',
      evaluateResult: true,
      succeedOnClick: true,
    });
    launchMock
      .mockRejectedValueOnce(
        new Error(
          'browserType.launch: Target page, context or browser has been closed\nCall log: …',
        ),
      )
      .mockResolvedValueOnce(fakeBrowser(page));
    searchMock.mockReturnValue({ found: [BRAVE, CHROMIUM], tried: [] });

    const session = new HeadlessGmSession({
      foundryUrl: 'http://localhost:30000',
      username: 'mcp-api',
      password: 'mcp',
    });
    await session.start();

    expect(launchMock).toHaveBeenNthCalledWith(2, {
      headless: true,
      executablePath: CHROMIUM.path,
      args: HEADLESS_BROWSER_ARGS,
    });
    expect(session.browserInfo()).toEqual({ ...CHROMIUM, origin: 'detected' });
    await session.stop();
  });

  it('disables the local network access checks on every launch path', async () => {
    launchMock.mockRejectedValue(new Error('boom'));
    searchMock.mockReturnValue({ found: [BRAVE, CHROMIUM], tried: [] });

    const autoDetected = new HeadlessGmSession({
      foundryUrl: 'http://localhost:30000',
      username: 'mcp-api',
      password: 'mcp',
    });
    await expect(autoDetected.start()).rejects.toThrow();

    const explicit = new HeadlessGmSession({
      foundryUrl: 'http://localhost:30000',
      username: 'mcp-api',
      password: 'mcp',
      executablePath: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    });
    await expect(explicit.start()).rejects.toThrow();

    // Both detected browsers, then the explicit executable path.
    expect(launchMock).toHaveBeenCalledTimes(3);
    for (const [options] of launchMock.mock.calls) {
      expect(options.args).toContain(
        '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,' +
          'PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,' +
          'BraveLocalhostAccessPermission',
      );
    }
  });

  it('advises installing a browser, listing the locations tried, when none was found', async () => {
    searchMock.mockReturnValue({ found: [], tried: ['C:\\a\\chrome.exe', 'C:\\b\\msedge.exe'] });

    const session = new HeadlessGmSession({
      foundryUrl: 'http://localhost:30000',
      username: 'mcp-api',
      password: 'mcp',
    });

    const error = await session.start().catch((e: unknown) => e);
    expect(String(error)).toMatch(/No browser found/);
    expect(String(error)).toMatch(/FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH/);
    expect(String(error)).toContain('C:\\a\\chrome.exe; C:\\b\\msedge.exe');
    expect(launchMock).not.toHaveBeenCalled();
    expect(session.browserInfo()).toBeNull();
  });

  it('shows the real launch errors, without install advice, when no browser found will start', async () => {
    launchMock
      .mockRejectedValueOnce(
        new Error('browserType.launch: Target page, context or browser has been closed'),
      )
      .mockRejectedValueOnce(new Error('spawn EACCES'));
    searchMock.mockReturnValue({ found: [BRAVE, CHROMIUM], tried: [] });

    const session = new HeadlessGmSession({
      foundryUrl: 'http://localhost:30000',
      username: 'mcp-api',
      password: 'mcp',
    });

    const error = await session.start().catch((e: unknown) => e);
    expect(String(error)).toContain(
      `Brave (${BRAVE.path}): browserType.launch: Target page, context or browser has been closed`,
    );
    expect(String(error)).toContain(`Chromium (${CHROMIUM.path}): spawn EACCES`);
    expect(String(error)).not.toMatch(/Install Google Chrome/);
  });

  it('names the explicit executablePath and its real error, with no fallback', async () => {
    launchMock.mockRejectedValue(new Error("Executable doesn't exist at C:\\Brave\\brave.exe"));

    const session = new HeadlessGmSession({
      foundryUrl: 'http://localhost:30000',
      username: 'mcp-api',
      password: 'mcp',
      executablePath: 'C:\\Brave\\brave.exe',
    });

    const error = await session.start().catch((e: unknown) => e);
    expect(String(error)).toContain('FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH=C:\\Brave\\brave.exe');
    expect(String(error)).toContain("Executable doesn't exist at C:\\Brave\\brave.exe");
    expect(String(error)).toMatch(/check the path/i);
    expect(String(error)).not.toMatch(/Install Google Chrome/);
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('uses an explicit executablePath without any detection', async () => {
    const page = fakePage({
      url: 'http://localhost:30000/join',
      evaluateResult: true,
      succeedOnClick: true,
    });
    launchMock.mockResolvedValue(fakeBrowser(page));

    const session = new HeadlessGmSession({
      foundryUrl: 'http://localhost:30000',
      username: 'mcp-api',
      password: 'mcp',
      executablePath: '/opt/vivaldi/vivaldi',
    });
    await session.start();

    expect(searchMock).not.toHaveBeenCalled();
    expect(launchMock).toHaveBeenCalledWith({
      headless: true,
      executablePath: '/opt/vivaldi/vivaldi',
      args: HEADLESS_BROWSER_ARGS,
    });
    expect(session.browserInfo()).toEqual({
      name: 'Vivaldi',
      path: '/opt/vivaldi/vivaldi',
      origin: 'configured',
    });
    await session.stop();
  });

  it('logs in successfully, filling the password and reporting active status', async () => {
    const state = {
      url: 'http://localhost:30000/join',
      evaluateResult: true,
      succeedOnClick: true,
    };
    const page = fakePage(state);
    const browser = fakeBrowser(page);
    launchMock.mockResolvedValue(browser);

    const session = new HeadlessGmSession({
      foundryUrl: 'http://localhost:30000',
      username: 'mcp-api',
      password: 'mcp',
    });
    await session.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(page.goto).toHaveBeenCalledWith('http://localhost:30000/join', {
      waitUntil: 'domcontentloaded',
    });
    expect(session.isActive()).toBe(true);
    expect(session.statusText()).toContain('mcp-api');
    await session.stop();
  });

  it('opens its page at 1920x1080, above FoundryVTT minimum window size', async () => {
    const page = fakePage({
      url: 'http://localhost:30000/join',
      evaluateResult: true,
      succeedOnClick: true,
    });
    const browser = fakeBrowser(page);
    launchMock.mockResolvedValue(browser);

    const session = new HeadlessGmSession({
      foundryUrl: 'http://localhost:30000',
      username: 'mcp-api',
      password: 'mcp',
    });
    await session.start();

    expect(HEADLESS_VIEWPORT).toEqual({ width: 1920, height: 1080 });
    expect(browser.newPage).toHaveBeenCalledWith({ viewport: HEADLESS_VIEWPORT });
    await session.stop();
  });

  it("logs the companion module's console lines and page errors, nothing else", async () => {
    const page = fakePage({
      url: 'http://localhost:30000/join',
      evaluateResult: true,
      succeedOnClick: true,
    });
    launchMock.mockResolvedValue(fakeBrowser(page));
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const session = new HeadlessGmSession({
      foundryUrl: 'http://localhost:30000',
      username: 'mcp-api',
      password: 'mcp',
    });
    await session.start();
    const handler = (event: string) =>
      page.on.mock.calls.find(([name]) => name === event)?.[1] as (arg: unknown) => void;
    // The login runs alongside and logs lines of its own.
    const pageLines = (spy: typeof info) =>
      spy.mock.calls.filter(([line]) => String(line).startsWith('Headless GM page'));

    handler('console')(
      consoleMessage('log', BRIDGE_SCRIPT, ['FoundryVTT MCP Bridge | authenticated']),
    );
    handler('console')(
      consoleMessage('warning', BRIDGE_SCRIPT, ['FoundryVTT MCP Bridge | handshake failed: x']),
    );
    handler('console')(consoleMessage('log', CORE_SCRIPT, ['Foundry VTT | Drawing game canvas']));
    handler('pageerror')(errorWithStack('TypeError', 'boom', BRIDGE_SCRIPT));
    handler('pageerror')(errorWithStack('Error', 'core failure', CORE_SCRIPT));
    await vi.advanceTimersByTimeAsync(0);

    expect(pageLines(info)).toEqual([
      ['Headless GM page [bridge console.log]: FoundryVTT MCP Bridge | authenticated'],
    ]);
    // Console lines wait for their argument to be read; page errors do not.
    expect(pageLines(warn).sort()).toEqual([
      ['Headless GM page [bridge console.warn]: FoundryVTT MCP Bridge | handshake failed: x'],
      ['Headless GM page error (bridge): TypeError: boom'],
    ]);
    info.mockRestore();
    warn.mockRestore();
    await session.stop();
  });

  it('retries with backoff when the account is not in the join list', async () => {
    const state = {
      url: 'http://localhost:30000/join',
      evaluateResult: false,
      succeedOnClick: false,
    };
    const page = fakePage(state);
    const browser = fakeBrowser(page);
    launchMock.mockResolvedValue(browser);

    const session = new HeadlessGmSession({
      foundryUrl: 'http://localhost:30000',
      username: 'missing-user',
      password: 'mcp',
    });
    await session.start();
    // The first attempt is scheduled, not failing yet.
    expect(session.isRetrying()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(session.isActive()).toBe(false);
    expect(session.isRetrying()).toBe(true);
    expect(session.statusText()).toContain('No user named "missing-user"');
    expect(page.goto).toHaveBeenCalledTimes(1);

    // Base retry delay (5s) elapses -> a second attempt fires automatically.
    await vi.advanceTimersByTimeAsync(5000);
    expect(page.goto).toHaveBeenCalledTimes(2);

    await session.stop();
  });

  it('re-logs in when the page navigates back to /join while active', async () => {
    const state = {
      url: 'http://localhost:30000/join',
      evaluateResult: true,
      succeedOnClick: true,
    };
    const page = fakePage(state);
    const browser = fakeBrowser(page);
    launchMock.mockResolvedValue(browser);

    const session = new HeadlessGmSession({
      foundryUrl: 'http://localhost:30000',
      username: 'mcp-api',
      password: 'mcp',
    });
    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.isActive()).toBe(true);
    expect(page.goto).toHaveBeenCalledTimes(1);

    // Simulate an unrelated logout (world restart, session timeout).
    page.emitFrameNavigated('http://localhost:30000/join');
    expect(session.isActive()).toBe(false);

    await vi.advanceTimersByTimeAsync(0);
    expect(page.goto).toHaveBeenCalledTimes(2);

    await session.stop();
  });

  it('stop() prevents further retries and closes the browser', async () => {
    const state = {
      url: 'http://localhost:30000/join',
      evaluateResult: false,
      succeedOnClick: false,
    };
    const page = fakePage(state);
    const browser = fakeBrowser(page);
    launchMock.mockResolvedValue(browser);

    const session = new HeadlessGmSession({
      foundryUrl: 'http://localhost:30000',
      username: 'missing-user',
      password: 'mcp',
    });
    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(page.goto).toHaveBeenCalledTimes(1);

    await session.stop();
    expect(page.close).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60000);
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  describe('join form compatibility', () => {
    /**
     * Wires a fake `/join` form into a fake page: `waitForSelector`, `$` and
     * `evaluate` resolve against named elements, and `evaluate` runs the real
     * in-page callback against a stubbed `document`.
     */
    function withJoinForm(
      page: FakePage,
      form: { userSelectName: string; users: string[]; passwordFields: string[] },
    ) {
      const select = {
        value: '',
        options: form.users.map((name, i) => ({ text: name, value: `id-${i}` })),
        dispatchEvent: vi.fn(),
      };
      const elements = new Map<string, unknown>([
        [`select[name="${form.userSelectName}"]`, select],
      ]);
      const passwordInputs = new Map<string, ReturnType<typeof fakeElementHandle>>();
      for (const name of form.passwordFields) {
        const input = fakeElementHandle();
        passwordInputs.set(name, input);
        elements.set(`input[name="${name}"]`, input);
      }
      const firstPassword = passwordInputs.values().next().value;
      if (firstPassword) {
        elements.set('input[type="password"]', firstPassword);
      }
      const query = (selector: string) =>
        selector
          .split(',')
          .map((s) => elements.get(s.trim()))
          .find((el) => el !== undefined) ?? null;

      page.waitForSelector.mockImplementation(async (selector: string) => {
        if (!query(selector)) {
          throw new Error(`Timeout waiting for ${selector}`);
        }
      });
      page.$.mockImplementation(async (selector: string) => query(selector));
      page.evaluate.mockImplementation(async (fn: (arg: unknown) => unknown, arg: unknown) => {
        vi.stubGlobal('document', { querySelector: query });
        try {
          return fn(arg);
        } finally {
          vi.unstubAllGlobals();
        }
      });
      return { select, passwordInputs };
    }

    async function loginWith(form: {
      userSelectName: string;
      users: string[];
      passwordFields: string[];
    }) {
      const state = {
        url: 'http://localhost:30000/join',
        evaluateResult: true,
        succeedOnClick: true,
      };
      const page = fakePage(state);
      const dom = withJoinForm(page, form);
      launchMock.mockResolvedValue(fakeBrowser(page));

      const session = new HeadlessGmSession({
        foundryUrl: 'http://localhost:30000',
        username: 'mcp-api',
        password: 'mcp',
      });
      await session.start();
      await vi.advanceTimersByTimeAsync(0);
      return { session, page, ...dom };
    }

    it('logs in through a v13 form (select[name="userid"])', async () => {
      const { session, page, select, passwordInputs } = await loginWith({
        userSelectName: 'userid',
        users: ['Gamemaster', 'mcp-api', 'Player'],
        passwordFields: ['password'],
      });

      expect(session.isActive()).toBe(true);
      expect(select.value).toBe('id-1');
      expect(passwordInputs.get('password')?.fill).toHaveBeenCalledWith('mcp');
      expect(page.click).toHaveBeenCalledWith('button[name="join"]');
      await session.stop();
    });

    it('logs in through a v14 form (userId) and never fills adminPassword', async () => {
      const { session, page, select, passwordInputs } = await loginWith({
        userSelectName: 'userId',
        users: ['Gamemaster', 'mcp-api', 'Player'],
        passwordFields: ['password', 'adminPassword'],
      });

      expect(session.isActive()).toBe(true);
      expect(select.value).toBe('id-1');
      expect(passwordInputs.get('password')?.fill).toHaveBeenCalledWith('mcp');
      expect(passwordInputs.get('adminPassword')?.fill).not.toHaveBeenCalled();
      expect(page.click).toHaveBeenCalledWith('button[name="join"]');
      await session.stop();
    });
  });

  describe('bridge-connectivity watchdog', () => {
    async function loggedInSession(isBridgeConnected: () => boolean) {
      const state = {
        url: 'http://localhost:30000/join',
        evaluateResult: true,
        succeedOnClick: true,
      };
      const page = fakePage(state);
      const browser = fakeBrowser(page);
      launchMock.mockResolvedValue(browser);

      const session = new HeadlessGmSession({
        foundryUrl: 'http://localhost:30000',
        username: 'mcp-api',
        password: 'mcp',
        isBridgeConnected,
      });
      await session.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.isActive()).toBe(true);
      return { session, page };
    }

    it('does not reload while the bridge stays connected', async () => {
      const { session, page } = await loggedInSession(() => true);

      await vi.advanceTimersByTimeAsync(120000);
      expect(page.reload).not.toHaveBeenCalled();

      await session.stop();
    });

    it('reloads the page after the bridge stays down for the full grace window', async () => {
      const { session, page } = await loggedInSession(() => false);

      // Grace window is 3 ticks * 20s = 60s; under that, no reload yet.
      await vi.advanceTimersByTimeAsync(40000);
      expect(page.reload).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(20000);
      expect(page.reload).toHaveBeenCalledTimes(1);
      expect(page.reload).toHaveBeenCalledWith({ waitUntil: 'domcontentloaded' });

      await session.stop();
    });

    it('resets the down counter on a single connected tick, requiring a fresh full window', async () => {
      let connected = false;
      const { session, page } = await loggedInSession(() => connected);

      await vi.advanceTimersByTimeAsync(40000); // 2 down ticks
      connected = true;
      await vi.advanceTimersByTimeAsync(20000); // 1 connected tick resets the counter
      connected = false;
      await vi.advanceTimersByTimeAsync(40000); // only 2 more down ticks since the reset
      expect(page.reload).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(20000); // 3rd consecutive down tick
      expect(page.reload).toHaveBeenCalledTimes(1);

      await session.stop();
    });

    it('never starts the watchdog when isBridgeConnected is not provided', async () => {
      const state = {
        url: 'http://localhost:30000/join',
        evaluateResult: true,
        succeedOnClick: true,
      };
      const page = fakePage(state);
      const browser = fakeBrowser(page);
      launchMock.mockResolvedValue(browser);

      const session = new HeadlessGmSession({
        foundryUrl: 'http://localhost:30000',
        username: 'mcp-api',
        password: 'mcp',
      });
      await session.start();
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(120000);
      expect(page.reload).not.toHaveBeenCalled();

      await session.stop();
    });

    it('stops polling once stop() is called', async () => {
      const { session, page } = await loggedInSession(() => false);

      await session.stop();
      await vi.advanceTimersByTimeAsync(120000);
      expect(page.reload).not.toHaveBeenCalled();
    });
  });

  describe('window.foundryMcpBridge', () => {
    const credentials = {
      info: vi.fn(() => ({ protocol: 1, port: 31415 })),
      prove: vi.fn((serverNonce: unknown) => {
        if (serverNonce !== 'Ns') {
          throw new Error('Invalid server nonce');
        }
        return { nonce: 'Nc', clientProof: 'Pc', serverProof: 'Ps' };
      }),
    };

    async function startWithCredentials() {
      const page = fakePage({
        url: 'http://localhost:30000/join',
        evaluateResult: true,
        succeedOnClick: true,
      });
      launchMock.mockResolvedValue(fakeBrowser(page));
      const session = new HeadlessGmSession({
        foundryUrl: 'http://localhost:30000/',
        username: 'mcp-api',
        password: 'mcp',
        bridgeCredentials: credentials,
      });
      await session.start();
      const [name, binding] = page.exposeBinding.mock.calls[0] as [
        string,
        (source: { frame: { url(): string } }, method: unknown, arg?: unknown) => unknown,
      ];
      const call = (frameUrl: string, method: unknown, arg?: unknown) =>
        binding({ frame: { url: () => frameUrl } }, method, arg);
      return { session, page, name, call };
    }

    it('is exposed before the first navigation, through a binding and an init script', async () => {
      const { session, page, name } = await startWithCredentials();
      expect(page.addInitScript).toHaveBeenCalledTimes(1);
      const script = String(page.addInitScript.mock.calls[0]?.[0]?.content);
      expect(script).toContain('foundryMcpBridge');
      expect(script).toContain(name);
      expect(page.exposeBinding.mock.invocationCallOrder[0]).toBeLessThan(
        page.goto.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(page.addInitScript.mock.invocationCallOrder[0]).toBeLessThan(
        page.goto.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      await session.stop();
    });

    it('is installed once, not again on re-login or reload', async () => {
      const { session, page } = await startWithCredentials();
      await vi.advanceTimersByTimeAsync(0);
      page.emitFrameNavigated('http://localhost:30000/join');
      await vi.advanceTimersByTimeAsync(0);
      expect(page.goto).toHaveBeenCalledTimes(2);
      expect(page.exposeBinding).toHaveBeenCalledTimes(1);
      expect(page.addInitScript).toHaveBeenCalledTimes(1);
      await session.stop();
    });

    it('answers getInfo and prove for frames of the Foundry origin', async () => {
      const { session, call } = await startWithCredentials();
      expect(call('http://localhost:30000/game', 'getInfo')).toEqual({ protocol: 1, port: 31415 });
      expect(call('http://localhost:30000/game', 'prove', 'Ns')).toEqual({
        nonce: 'Nc',
        clientProof: 'Pc',
        serverProof: 'Ps',
      });
      expect(() => call('http://localhost:30000/game', 'prove', 'bad')).toThrow(
        'Invalid server nonce',
      );
      await session.stop();
    });

    it('refuses other origins and unknown calls', async () => {
      const { session, call } = await startWithCredentials();
      credentials.prove.mockClear();
      expect(() => call('https://www.youtube.com/embed/x', 'prove', 'Ns')).toThrow(
        /only available to the Foundry page/,
      );
      expect(() => call('about:blank', 'getInfo')).toThrow(/only available/);
      expect(() => call('http://localhost:30001/game', 'getInfo')).toThrow(/only available/);
      expect(credentials.prove).not.toHaveBeenCalled();
      expect(() => call('http://localhost:30000/game', 'secret')).toThrow(
        'Unknown foundryMcpBridge call',
      );
      await session.stop();
    });

    it('is not exposed without bridge credentials', async () => {
      const page = fakePage({
        url: 'http://localhost:30000/join',
        evaluateResult: true,
        succeedOnClick: true,
      });
      launchMock.mockResolvedValue(fakeBrowser(page));
      const session = new HeadlessGmSession({
        foundryUrl: 'http://localhost:30000',
        username: 'mcp-api',
        password: 'mcp',
      });
      await session.start();
      expect(page.exposeBinding).not.toHaveBeenCalled();
      expect(page.addInitScript).not.toHaveBeenCalled();
      await session.stop();
    });
  });
});

describe('bridgeConsoleText', () => {
  it("keeps a companion module line, from the module's own script", async () => {
    const message = consoleMessage('log', BRIDGE_SCRIPT, ['FoundryVTT MCP Bridge | authenticated']);

    await expect(bridgeConsoleText(message)).resolves.toBe('FoundryVTT MCP Bridge | authenticated');
  });

  it('accepts the foundryvtt-mcp-bridge prefix too', async () => {
    const message = consoleMessage('warning', BRIDGE_SCRIPT, [
      'foundryvtt-mcp-bridge | Failed to search documents in world.monsters:',
    ]);

    await expect(bridgeConsoleText(message)).resolves.toBe(
      'foundryvtt-mcp-bridge | Failed to search documents in world.monsters:',
    );
  });

  it('keeps the first argument only, never the rendered text', async () => {
    const message = consoleMessage('error', BRIDGE_SCRIPT, [
      'FoundryVTT MCP Bridge | received malformed command',
      { id: 'a', content: '<p>page body</p>' },
    ]);

    await expect(bridgeConsoleText(message)).resolves.toBe(
      'FoundryVTT MCP Bridge | received malformed command',
    );
    expect(message.text).not.toHaveBeenCalled();
  });

  it('cuts the line at 500 characters', async () => {
    const long = `FoundryVTT MCP Bridge | ${'x'.repeat(600)}`;

    const text = await bridgeConsoleText(consoleMessage('log', BRIDGE_SCRIPT, [long]));

    expect(text).toBe(long.slice(0, 500));
  });

  it('ignores the prefix when another script prints it', async () => {
    const message = consoleMessage('log', CORE_SCRIPT, ['FoundryVTT MCP Bridge | spoofed']);

    await expect(bridgeConsoleText(message)).resolves.toBeNull();
  });

  it('ignores module lines without a prefix, or whose first argument is not a string', async () => {
    await expect(
      bridgeConsoleText(consoleMessage('log', BRIDGE_SCRIPT, ['some other line'])),
    ).resolves.toBeNull();
    await expect(
      bridgeConsoleText(
        consoleMessage('log', BRIDGE_SCRIPT, [{ text: 'FoundryVTT MCP Bridge | x' }]),
      ),
    ).resolves.toBeNull();
    await expect(bridgeConsoleText(consoleMessage('log', BRIDGE_SCRIPT, []))).resolves.toBeNull();
  });

  it('ignores a line whose argument can no longer be read (page navigated)', async () => {
    const message = consoleMessage('log', BRIDGE_SCRIPT, ['FoundryVTT MCP Bridge | x']);
    message.args = () => [{ jsonValue: vi.fn().mockRejectedValue(new Error('context destroyed')) }];

    await expect(bridgeConsoleText(message)).resolves.toBeNull();
  });
});

describe('bridgePageErrorText', () => {
  it('keeps name and message of an error thrown from the companion module', () => {
    expect(bridgePageErrorText(errorWithStack('TypeError', 'boom', BRIDGE_SCRIPT))).toBe(
      'TypeError: boom',
    );
  });

  it('cuts it at 200 characters', () => {
    const error = errorWithStack('Error', 'y'.repeat(300), BRIDGE_SCRIPT);

    expect(bridgePageErrorText(error)).toBe(`Error: ${'y'.repeat(300)}`.slice(0, 200));
  });

  it('ignores errors whose stack has no frame in the module', () => {
    expect(bridgePageErrorText(errorWithStack('Error', 'core failure', CORE_SCRIPT))).toBeNull();
    const mentionsPath = errorWithStack(
      'Error',
      'cannot load /modules/foundryvtt-mcp-bridge/x.js',
      CORE_SCRIPT,
    );
    expect(bridgePageErrorText(mentionsPath)).toBeNull();
  });
});
