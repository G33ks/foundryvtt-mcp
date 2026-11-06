import { beforeEach, describe, expect, it, vi } from 'vitest';

const testConfig = vi.hoisted(() => ({
  logLevel: 'error',
  foundry: {
    url: 'http://localhost:30000',
    socketPath: '/socket.io/',
    timeout: 1000,
    retryAttempts: 1,
    retryDelay: 10,
    writeEnabled: true,
    username: 'mcp-api',
    password: 'secret',
  } as Record<string, unknown>,
  events: { bufferSize: 10, defaultWaitMs: 100 },
  moduleBridge: { enabled: true, port: 31415 },
  headlessGm: { enabled: true } as Record<string, unknown>,
  assets: {},
}));
vi.mock('../config/index.js', () => ({ config: testConfig }));

const route = vi.fn();
vi.mock('../tools/index.js', () => ({
  routeToolRequest: (name: string) => route(name),
  routeResourceRequest: vi.fn(),
}));

const { FoundryCore, BRIDGE_CONNECT_WAIT_MS, BRIDGE_LOGGED_IN_GRACE_MS } = await import(
  '../core.js'
);
const { ModuleBridge } = await import('../foundry/module-bridge.js');
const { HeadlessGmSession } = await import('../foundry/headless-gm-session.js');
const { isRefusal } = await import('../utils/refusal.js');

/** The core's private parts these tests set up, as the startup would. */
interface CoreInternals {
  moduleBridge: InstanceType<typeof ModuleBridge> | null;
  headlessGmSession: InstanceType<typeof HeadlessGmSession> | null;
  bridgeError: string | null;
  headlessLaunchError: string | null;
}

function internals(core: InstanceType<typeof FoundryCore>): CoreInternals {
  return core as unknown as CoreInternals;
}

async function refusalOf(attempt: Promise<unknown>): Promise<Error> {
  const error = await attempt.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e,
  );
  expect(isRefusal(error)).toBe(true);
  return error as Error;
}

describe('FoundryCore: calls that need the companion module', () => {
  beforeEach(() => {
    testConfig.moduleBridge = { enabled: true, port: 31415 };
    testConfig.headlessGm = { enabled: true };
    route.mockReset();
    route.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    vi.restoreAllMocks();
  });

  it('runs at once when the module is connected', async () => {
    const core = new FoundryCore();
    const bridge = internals(core).moduleBridge;
    if (!bridge) {
      throw new Error('no bridge');
    }
    vi.spyOn(bridge, 'isConnected').mockReturnValue(true);
    const wait = vi.spyOn(bridge, 'waitUntilConnected');

    await core.callTool('capture_scene', {});

    expect(wait).not.toHaveBeenCalled();
    expect(route).toHaveBeenCalledWith('capture_scene');
  });

  it('waits for the module while the page is on its way, then runs', async () => {
    const core = new FoundryCore();
    const bridge = internals(core).moduleBridge;
    if (!bridge) {
      throw new Error('no bridge');
    }
    const wait = vi.spyOn(bridge, 'waitUntilConnected').mockResolvedValue(true);

    await core.callTool('get_targets', {});

    expect(wait).toHaveBeenCalledWith(BRIDGE_CONNECT_WAIT_MS);
    expect(route).toHaveBeenCalledWith('get_targets');
  });

  it('refuses when the wait runs out, with the session status', async () => {
    const core = new FoundryCore();
    const bridge = internals(core).moduleBridge;
    if (!bridge) {
      throw new Error('no bridge');
    }
    vi.spyOn(bridge, 'waitUntilConnected').mockResolvedValue(false);

    const error = await refusalOf(core.callTool('ping_canvas', { x: 1, y: 2 }));

    expect(error.message).toMatch(
      /The companion module is not connected: still waiting for it after 10 s — ⏳ .*Try again in a moment\./,
    );
    expect(route).not.toHaveBeenCalled();
  });

  it('does not wait for the module on an inline item, but does on a compendium one', async () => {
    const core = new FoundryCore();
    const bridge = internals(core).moduleBridge;
    if (!bridge) {
      throw new Error('no bridge');
    }
    const wait = vi.spyOn(bridge, 'waitUntilConnected').mockResolvedValue(true);
    vi.spyOn(core.foundryClient, 'isReconnecting').mockReturnValue(false);

    await core.callTool('create_actor_item', { source: { type: 'inline', item: {} } });
    expect(wait).not.toHaveBeenCalled();

    await core.callTool('create_actor_item', { source: { type: 'compendium' } });
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('refuses at once when the bridge is disabled', async () => {
    testConfig.moduleBridge = { enabled: false, port: 31415 };
    const core = new FoundryCore();

    const error = await refusalOf(core.callTool('capture_scene', {}));

    expect(error.message).toContain(
      'The companion module is not connected: the module bridge is disabled. Set FOUNDRY_MODULE_BRIDGE_ENABLED=true',
    );
  });

  it('says the bridge failed to start, not that it is disabled', async () => {
    const core = new FoundryCore();
    internals(core).bridgeError = 'listen EADDRINUSE: address already in use 127.0.0.1:31415';
    internals(core).moduleBridge = null;
    internals(core).headlessGmSession = null;

    const error = await refusalOf(core.callTool('capture_scene', {}));

    expect(error.message).toContain(
      'the module bridge failed to start (listen EADDRINUSE: address already in use 127.0.0.1:31415)',
    );
    expect(error.message).not.toContain('disabled');
  });

  it('refuses at once when the browser could not be launched', async () => {
    const core = new FoundryCore();
    internals(core).headlessLaunchError = 'No browser found';
    internals(core).headlessGmSession = null;
    const bridge = internals(core).moduleBridge;
    if (!bridge) {
      throw new Error('no bridge');
    }
    const wait = vi.spyOn(bridge, 'waitUntilConnected');

    const error = await refusalOf(core.callTool('set_pause', {}));

    expect(error.message).toContain(
      'the headless GM browser could not be launched (No browser found)',
    );
    expect(wait).not.toHaveBeenCalled();
  });

  it('refuses at once without a headless session', async () => {
    testConfig.headlessGm = { enabled: false };
    const core = new FoundryCore();

    const error = await refusalOf(core.callTool('capture_scene', {}));

    expect(error.message).toContain('no headless GM session is configured');
  });

  it('refuses at once while the session is failing', async () => {
    const core = new FoundryCore();
    const session = internals(core).headlessGmSession;
    const bridge = internals(core).moduleBridge;
    if (!session || !bridge) {
      throw new Error('no session');
    }
    vi.spyOn(session, 'isRetrying').mockReturnValue(true);
    const wait = vi.spyOn(bridge, 'waitUntilConnected');

    const error = await refusalOf(core.callTool('capture_scene', {}));

    expect(error.message).toContain('the headless GM session is failing and retries on its own');
    expect(wait).not.toHaveBeenCalled();
  });

  it('waits for a page logged in moments ago, refuses one logged in long ago', async () => {
    const core = new FoundryCore();
    const session = internals(core).headlessGmSession;
    const bridge = internals(core).moduleBridge;
    if (!session || !bridge) {
      throw new Error('no session');
    }
    const wait = vi.spyOn(bridge, 'waitUntilConnected').mockResolvedValue(true);
    const since = vi.spyOn(session, 'loggedInSince').mockReturnValue(Date.now() - 1000);

    await core.callTool('capture_scene', {});
    expect(wait).toHaveBeenCalledTimes(1);

    since.mockReturnValue(Date.now() - BRIDGE_LOGGED_IN_GRACE_MS - 1000);
    const error = await refusalOf(core.callTool('capture_scene', {}));
    expect(error.message).toContain('logged in but the module has not connected');
    expect(wait).toHaveBeenCalledTimes(1);
  });
});
