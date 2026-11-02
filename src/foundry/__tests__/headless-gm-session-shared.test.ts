/**
 * @fileoverview Shared mode of the headless GM session: the page reuses the
 * connector's session cookie, never fills the /join form, keeps the page on
 * /game, and asks the connector for a new session when the cookie is refused.
 */

import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeadlessGmSession, type SessionSource } from '../headless-gm-session.js';

const launchMock = vi.fn();
vi.mock('playwright-core', () => ({
  chromium: { launch: (...args: unknown[]) => launchMock(...args) },
}));
// One browser "installed", whatever this machine has.
vi.mock('../browser-detect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../browser-detect.js')>()),
  findBrowsers: () => ({
    found: [{ name: 'Chrome', path: '/opt/google/chrome/chrome' }],
    tried: [],
  }),
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const FOUNDRY_URL = 'https://foundry.example:30000';

type RouteHandler = (route: unknown) => Promise<void>;

/**
 * Fake page. `goto` lands on `landing(url)` (a server redirect when it
 * differs); `waitForFunction` resolves when `state.ready`.
 */
function fakeEnvironment() {
  const state = {
    url: 'about:blank',
    ready: true,
    landing: (url: string) => url,
  };
  let navigated: ((frame: unknown) => void) | undefined;
  let routeHandler: RouteHandler | undefined;
  const mainFrame = { url: () => state.url };
  const page = {
    on: vi.fn((event: string, handler: (frame: unknown) => void) => {
      if (event === 'framenavigated') {
        navigated = handler;
      }
    }),
    mainFrame: vi.fn(() => mainFrame),
    goto: vi.fn(async (url: string) => {
      state.url = state.landing(url);
      navigated?.(mainFrame);
    }),
    url: vi.fn(() => state.url),
    waitForFunction: vi.fn(async () => {
      if (!state.ready) {
        throw new Error('Timeout');
      }
    }),
    route: vi.fn(async (_pattern: RegExp, handler: RouteHandler) => {
      routeHandler = handler;
    }),
    reload: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    exposeBinding: vi.fn().mockResolvedValue(undefined),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    $: vi.fn(),
    click: vi.fn(),
    waitForSelector: vi.fn(),
  };
  const context = {
    newPage: vi.fn().mockResolvedValue(page),
    clearCookies: vi.fn().mockResolvedValue(undefined),
    addCookies: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    newPage: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };

  /** Simulates the page itself navigating (e.g. `game.logOut()`). */
  async function pageNavigates(path: string, { navigation = true, main = true } = {}) {
    const route = {
      request: () => ({
        isNavigationRequest: () => navigation,
        frame: () => (main ? mainFrame : {}),
        url: () => `${FOUNDRY_URL}${path}`,
      }),
      abort: vi.fn().mockResolvedValue(undefined),
      continue: vi.fn().mockResolvedValue(undefined),
    };
    await routeHandler?.(route);
    return route;
  }

  return {
    state,
    page,
    context,
    browser,
    pageNavigates,
    redirectTo(path: string) {
      state.url = `${FOUNDRY_URL}${path}`;
      navigated?.(mainFrame);
    },
  };
}

function fakeSource(initial: string | null) {
  let current = initial;
  const listeners = new Set<(session: string) => void>();
  const source: SessionSource & { reauthenticate: Mock } = {
    currentSession: () => current,
    onSessionChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reauthenticate: vi.fn().mockReturnValue(new Promise(() => undefined)),
  };
  return {
    source,
    newSession(session: string) {
      current = session;
      for (const listener of listeners) {
        listener(session);
      }
    },
    listenerCount: () => listeners.size,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function startShared(initial: string | null = 'cookie-1') {
  const env = fakeEnvironment();
  launchMock.mockResolvedValue(env.browser);
  const src = fakeSource(initial);
  const session = new HeadlessGmSession({
    foundryUrl: FOUNDRY_URL,
    username: 'mcp-api',
    sessionSource: src.source,
  });
  await session.start();
  await settle();
  return { session, env, src };
}

const gotoPaths = (page: { goto: Mock }) =>
  page.goto.mock.calls.map(([url]) => new URL(String(url)).pathname);

describe('HeadlessGmSession shared mode', () => {
  beforeEach(() => {
    launchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the connector session without navigating', async () => {
    const { session, env } = await startShared(null);

    expect(env.page.goto).not.toHaveBeenCalled();
    expect(session.sessionState()).toBe('waiting-for-session');
    expect(session.statusText()).toBe(
      "⏳ Waiting for the connector's session — sharing the connector's session (mcp-api)",
    );
    await session.stop();
  });

  it('installs the cookie in its own context and loads /game, never /join', async () => {
    const { session, env } = await startShared('cookie-1');

    expect(env.browser.newContext).toHaveBeenCalledTimes(1);
    expect(env.browser.newPage).not.toHaveBeenCalled();
    expect(env.context.clearCookies).toHaveBeenCalled();
    expect(env.context.addCookies).toHaveBeenCalledWith([
      {
        name: 'session',
        value: 'cookie-1',
        domain: 'foundry.example',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
      },
    ]);
    expect(gotoPaths(env.page)).toEqual(['/game']);
    expect(env.page.$).not.toHaveBeenCalled();
    expect(env.page.click).not.toHaveBeenCalled();
    expect(session.isActive()).toBe(true);
    expect(session.sessionState()).toBe('logged-in');
    expect(session.mode()).toBe('shared');
    expect(session.modeText()).toBe("sharing the connector's session (mcp-api)");
    await session.stop();
  });

  it('marks the cookie insecure on plain http', async () => {
    const env = fakeEnvironment();
    launchMock.mockResolvedValue(env.browser);
    const session = new HeadlessGmSession({
      foundryUrl: 'http://localhost:30000',
      username: 'mcp-api',
      sessionSource: fakeSource('cookie-1').source,
    });
    await session.start();
    await settle();

    expect(env.context.addCookies).toHaveBeenCalledWith([
      expect.objectContaining({ domain: 'localhost', secure: false }),
    ]);
    await session.stop();
  });

  it('swaps the cookie and reloads /game when the connector authenticates again', async () => {
    const { session, env, src } = await startShared('cookie-1');

    src.newSession('cookie-2');
    await settle();

    expect(env.context.addCookies).toHaveBeenLastCalledWith([
      expect.objectContaining({ name: 'session', value: 'cookie-2' }),
    ]);
    expect(env.context.clearCookies).toHaveBeenCalledTimes(2);
    expect(gotoPaths(env.page)).toEqual(['/game', '/game']);
    expect(session.isActive()).toBe(true);
    await session.stop();
  });

  it('asks the connector for a new session once when FoundryVTT redirects to /join', async () => {
    const env = fakeEnvironment();
    env.state.landing = () => `${FOUNDRY_URL}/join`;
    launchMock.mockResolvedValue(env.browser);
    const src = fakeSource('cookie-1');
    const session = new HeadlessGmSession({
      foundryUrl: FOUNDRY_URL,
      username: 'mcp-api',
      sessionSource: src.source,
    });
    await session.start();
    await settle();
    env.redirectTo('/join');
    env.redirectTo('/join');

    expect(src.source.reauthenticate).toHaveBeenCalledTimes(1);
    expect(session.isActive()).toBe(false);
    expect(session.sessionState()).toBe('reauthenticating');

    // The new session arrives: the page is back, and a later refusal asks again.
    env.state.landing = (url) => url;
    src.newSession('cookie-2');
    await settle();
    expect(session.isActive()).toBe(true);
    env.redirectTo('/join');
    expect(src.source.reauthenticate).toHaveBeenCalledTimes(2);
    await session.stop();
  });

  it('asks for a new session when /game never becomes ready', async () => {
    const env = fakeEnvironment();
    env.state.ready = false;
    launchMock.mockResolvedValue(env.browser);
    const src = fakeSource('cookie-1');
    const session = new HeadlessGmSession({
      foundryUrl: FOUNDRY_URL,
      username: 'mcp-api',
      sessionSource: src.source,
    });
    await session.start();
    await settle();

    expect(src.source.reauthenticate).toHaveBeenCalledTimes(1);
    expect(session.statusText()).toContain('never became ready');
    await session.stop();
  });

  it('does not ask again when a new cookie arrives while the old one is still loading', async () => {
    const env = fakeEnvironment();
    let finishLoad: () => void = () => undefined;
    env.page.waitForFunction.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          finishLoad = () => reject(new Error('Timeout'));
        }),
    );
    launchMock.mockResolvedValue(env.browser);
    const src = fakeSource('cookie-1');
    const session = new HeadlessGmSession({
      foundryUrl: FOUNDRY_URL,
      username: 'mcp-api',
      sessionSource: src.source,
    });
    await session.start();
    await settle();

    // The connector already authenticated again while /game was still loading.
    src.newSession('cookie-2');
    finishLoad();
    await settle();

    expect(src.source.reauthenticate).not.toHaveBeenCalled();
    expect(session.isActive()).toBe(true);
    expect(env.context.addCookies).toHaveBeenLastCalledWith([
      expect.objectContaining({ value: 'cookie-2' }),
    ]);
    await session.stop();
  });

  it('does not read as logged in while a blocked navigation reloads /game', async () => {
    const { session, env } = await startShared('cookie-1');
    let finishReady: () => void = () => undefined;
    env.page.waitForFunction.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishReady = resolve;
        }),
    );

    await env.pageNavigates('/');
    await settle();
    expect(session.sessionState()).toBe('reconnecting');
    expect(session.statusText()).toContain('loading /game');

    finishReady();
    await settle();
    expect(session.sessionState()).toBe('logged-in');
    await session.stop();
  });

  it('stops reading as logged in when the page reloads /game into "No Active Game"', async () => {
    const { session, env, src } = await startShared('cookie-1');
    expect(session.isActive()).toBe(true);

    // FoundryVTT restarted without a world: the page's client reloads /game,
    // which answers its "No Active Game" page — no redirect, no `game`.
    env.state.ready = false;
    env.redirectTo('/game');
    expect(session.isActive()).toBe(false);
    expect(session.sessionState()).toBe('reconnecting');
    await settle();

    expect(src.source.reauthenticate).toHaveBeenCalledTimes(1);
    expect(session.sessionState()).toBe('reauthenticating');
    await session.stop();
  });

  it('reads as logged in again after the page reloaded /game with a world', async () => {
    const { session, env, src } = await startShared('cookie-1');

    env.redirectTo('/game');
    await settle();

    expect(session.isActive()).toBe(true);
    expect(src.source.reauthenticate).not.toHaveBeenCalled();
    await session.stop();
  });

  it('retries /game with the same cookie when FoundryVTT cannot be reached', async () => {
    const env = fakeEnvironment();
    launchMock.mockResolvedValue(env.browser);
    const src = fakeSource('cookie-1');
    const session = new HeadlessGmSession({
      foundryUrl: FOUNDRY_URL,
      username: 'mcp-api',
      sessionSource: src.source,
    });
    await session.start();
    await settle();
    expect(session.isActive()).toBe(true);

    vi.useFakeTimers();
    const offline = new Error(
      'page.goto: net::ERR_INTERNET_DISCONNECTED at https://foundry.example:30000/game\nCall log:\n  - navigating',
    );
    env.page.goto.mockRejectedValueOnce(offline).mockRejectedValueOnce(offline);
    // The page's own client gives up reconnecting and heads for /no.
    await env.pageNavigates('/no');
    await vi.advanceTimersByTimeAsync(0);

    expect(session.sessionState()).toBe('reconnecting');
    expect(session.statusText()).toBe(
      "⏳ Reconnecting — sharing the connector's session (mcp-api) (page.goto: net::ERR_INTERNET_DISCONNECTED at https://foundry.example:30000/game)",
    );
    expect(src.source.reauthenticate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000); // second failure, next wait 10 s
    expect(gotoPaths(env.page)).toEqual(['/game', '/game', '/game']);
    await vi.advanceTimersByTimeAsync(10000); // back online
    expect(gotoPaths(env.page)).toHaveLength(4);
    expect(session.isActive()).toBe(true);
    expect(src.source.reauthenticate).not.toHaveBeenCalled();
    expect(env.context.addCookies).toHaveBeenCalledTimes(1);
    await session.stop();
  });

  it('blocks a navigation to /join and reloads /game instead, without reauthenticating', async () => {
    const { session, env, src } = await startShared('cookie-1');

    const route = await env.pageNavigates('/join');
    await settle();

    expect(route.abort).toHaveBeenCalled();
    expect(route.continue).not.toHaveBeenCalled();
    expect(gotoPaths(env.page)).toEqual(['/game', '/game']);
    expect(src.source.reauthenticate).not.toHaveBeenCalled();
    expect(session.isActive()).toBe(true);
    await session.stop();
  });

  it('lets non-navigation requests and subframe navigations through', async () => {
    const { session, env } = await startShared('cookie-1');

    const upload = await env.pageNavigates('/upload', { navigation: false });
    const frame = await env.pageNavigates('/join', { main: false });

    expect(upload.continue).toHaveBeenCalled();
    expect(frame.continue).toHaveBeenCalled();
    expect(upload.abort).not.toHaveBeenCalled();
    expect(gotoPaths(env.page)).toEqual(['/game']);
    await session.stop();
  });

  it('intercepts page paths other than /game, not assets', async () => {
    const { session, env } = await startShared('cookie-1');
    const pattern = env.page.route.mock.calls[0]?.[0] as RegExp;

    for (const path of ['/join', '/', '/setup', '/join?x=1', '/players', '/auth']) {
      expect(pattern.test(`${FOUNDRY_URL}${path}`), path).toBe(true);
    }
    for (const path of ['/game', '/game?x=1', '/scripts/foundry.mjs', '/css/foundry2.css']) {
      expect(pattern.test(`${FOUNDRY_URL}${path}`), path).toBe(false);
    }
    expect(pattern.test('https://other.example/join')).toBe(false);
    await session.stop();
  });

  it('stops listening for sessions on stop()', async () => {
    const { session, src, env } = await startShared('cookie-1');
    expect(src.listenerCount()).toBe(1);

    await session.stop();

    expect(src.listenerCount()).toBe(0);
    expect(env.context.close).toHaveBeenCalled();
    expect(env.browser.close).toHaveBeenCalled();
  });
});

describe('HeadlessGmSession separate-account mode', () => {
  it('says which account it logs in as', () => {
    const session = new HeadlessGmSession({
      foundryUrl: FOUNDRY_URL,
      username: 'mcp-gm',
      password: 'secret',
    });
    expect(session.mode()).toBe('separate');
    expect(session.modeText()).toBe('separate account (mcp-gm)');
  });
});
