/**
 * @fileoverview Tests for the automatic headless GM browser session.
 */

import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeadlessGmSession } from '../headless-gm-session.js';

const launchMock = vi.fn();
vi.mock('playwright-core', () => ({
  chromium: { launch: (...args: unknown[]) => launchMock(...args) },
}));

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
    emitFrameNavigated(url: string) {
      mainFrame.url = () => url;
      framenavigatedHandler?.(mainFrame);
    },
  };
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('launches with the chrome channel by default', async () => {
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

    expect(launchMock).toHaveBeenCalledWith({ headless: true, channel: 'chrome' });
    await session.stop();
  });

  it('falls back to msedge then bundled chromium when earlier channels fail', async () => {
    const state = {
      url: 'http://localhost:30000/join',
      evaluateResult: true,
      succeedOnClick: true,
    };
    const page = fakePage(state);
    const browser = fakeBrowser(page);
    launchMock.mockRejectedValueOnce(new Error('chrome not found')).mockResolvedValueOnce(browser);

    const session = new HeadlessGmSession({
      foundryUrl: 'http://localhost:30000',
      username: 'mcp-api',
      password: 'mcp',
    });
    await session.start();

    expect(launchMock).toHaveBeenNthCalledWith(1, { headless: true, channel: 'chrome' });
    expect(launchMock).toHaveBeenNthCalledWith(2, { headless: true, channel: 'msedge' });
    await session.stop();
  });

  it('throws with a clear message when no browser can be launched at all', async () => {
    launchMock.mockRejectedValue(new Error('not installed'));

    const session = new HeadlessGmSession({
      foundryUrl: 'http://localhost:30000',
      username: 'mcp-api',
      password: 'mcp',
    });

    await expect(session.start()).rejects.toThrow(/FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH/);
    expect(launchMock).toHaveBeenCalledTimes(3);
  });

  it('uses an explicit executablePath without trying any channel', async () => {
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
      executablePath: '/opt/chrome/chrome',
    });
    await session.start();

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(launchMock).toHaveBeenCalledWith({
      headless: true,
      executablePath: '/opt/chrome/chrome',
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
    await vi.advanceTimersByTimeAsync(0);

    expect(session.isActive()).toBe(false);
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
});
