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

const { FoundryCore, isSharedAccount, TOOL_RECONNECT_WAIT_MS } = await import('../core.js');
const { gamemasterAccountWarning } = await import('../foundry/client.js');
const { isRefusal } = await import('../utils/refusal.js');

describe('isSharedAccount', () => {
  it('shares the session unless another account is named', () => {
    expect(isSharedAccount(undefined, 'mcp-api')).toBe(true);
    expect(isSharedAccount('mcp-api', 'mcp-api')).toBe(true);
    expect(isSharedAccount('mcp-gm', 'mcp-api')).toBe(false);
  });
});

describe('gamemasterAccountWarning', () => {
  it('warns only for a Gamemaster account in shared mode', () => {
    expect(gamemasterAccountWarning(true, { name: 'mcp-api', role: 4 })).toMatch(
      /"mcp-api" is a Gamemaster .* may become the active GM .* Make this account an Assistant GM\./,
    );
    expect(gamemasterAccountWarning(true, { name: 'mcp-api', role: 3 })).toBeNull();
    expect(gamemasterAccountWarning(false, { name: 'mcp-api', role: 4 })).toBeNull();
    expect(gamemasterAccountWarning(true, null)).toBeNull();
  });
});

describe('FoundryCore single-account mode', () => {
  beforeEach(() => {
    testConfig.headlessGm = { enabled: true };
    route.mockReset();
    route.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('shares the connector session when no headless account is named', () => {
    const core = new FoundryCore();
    const status = core.status();
    expect(status.headlessGm.mode).toBe('shared');
    expect(status.headlessGm.modeText).toBe("sharing the connector's session (mcp-api)");
    expect(status.headlessGm.sessionState).toBe('waiting-for-session');
    expect(status.staleCache).toBeNull();
    const clientConfig = (core.foundryClient as unknown as { config: Record<string, unknown> })
      .config;
    expect(clientConfig.connectorUsernames).toBeUndefined();
    // The list of journal overwrites is kept next to the local copies.
    expect(String(clientConfig.journalConflictsFile)).toMatch(/journal-conflicts\.json$/);
  });

  it('keeps a separate account when FOUNDRY_HEADLESS_GM_USERNAME names another one', () => {
    testConfig.headlessGm = { enabled: true, username: 'mcp-gm', password: 'other' };
    const core = new FoundryCore();
    const status = core.status();
    expect(status.headlessGm.mode).toBe('separate');
    expect(status.headlessGm.modeText).toBe('separate account (mcp-gm)');
    const clientConfig = (core.foundryClient as unknown as { config: Record<string, unknown> })
      .config;
    expect(clientConfig.connectorUsernames).toEqual(['mcp-gm']);
  });

  it('treats the same name as the shared mode', () => {
    testConfig.headlessGm = { enabled: true, username: 'mcp-api', password: 'secret' };
    expect(new FoundryCore().status().headlessGm.mode).toBe('shared');
  });

  it('reports the account role and the Gamemaster warning in status', () => {
    const core = new FoundryCore();
    vi.spyOn(core.foundryClient, 'accountInfo').mockReturnValue({
      userId: 'u',
      name: 'mcp-api',
      role: 4,
    });
    const { account } = core.status();
    expect(account?.name).toBe('mcp-api');
    expect(account?.role).toBe('Gamemaster');
    expect(account?.warning).toMatch(/may become the active GM/);
  });

  it('has a tool call wait for a reconnection in progress, then run', async () => {
    const core = new FoundryCore();
    vi.spyOn(core.foundryClient, 'isReconnecting').mockReturnValue(true);
    const wait = vi.spyOn(core.foundryClient, 'waitUntilConnected').mockResolvedValue(true);

    await core.callTool('get_users', {});

    expect(wait).toHaveBeenCalledWith(TOOL_RECONNECT_WAIT_MS);
    expect(route).toHaveBeenCalledWith('get_users');
  });

  it('refuses a call whose wait ran out, without running it', async () => {
    const core = new FoundryCore();
    vi.spyOn(core.foundryClient, 'isReconnecting').mockReturnValue(true);
    vi.spyOn(core.foundryClient, 'waitUntilConnected').mockResolvedValue(false);
    vi.spyOn(core.foundryClient, 'connectionStatus').mockReturnValue({
      state: 'waiting-for-world',
      error: 'No active world on FoundryVTT: launch it from the Setup screen.',
    });

    const attempt = core.callTool('update_journal_page', {});

    await expect(attempt).rejects.toThrow(
      'Reconnecting to FoundryVTT… (waiting-for-world: No active world on FoundryVTT: launch it from the Setup screen.). The connector retries on its own; try again in a moment.',
    );
    await attempt.catch((error: unknown) => expect(isRefusal(error)).toBe(true));
    expect(route).not.toHaveBeenCalled();
  });

  it('keeps writes in order while the first one waits for the reconnection', async () => {
    const core = new FoundryCore();
    vi.spyOn(core.foundryClient, 'isReconnecting').mockReturnValue(true);
    let reconnect: (ok: boolean) => void = () => undefined;
    vi.spyOn(core.foundryClient, 'waitUntilConnected')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            reconnect = resolve;
          }),
      )
      .mockResolvedValue(true);

    const first = core.callTool('create_scene', {});
    const second = core.callTool('update_journal_page', {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(route).not.toHaveBeenCalled();

    reconnect(true);
    await Promise.all([first, second]);
    expect(route.mock.calls.map(([name]) => name)).toEqual(['create_scene', 'update_journal_page']);
  });

  it('answers get_health_status without waiting', async () => {
    const core = new FoundryCore();
    vi.spyOn(core.foundryClient, 'isReconnecting').mockReturnValue(true);
    const wait = vi.spyOn(core.foundryClient, 'waitUntilConnected');

    await core.callTool('get_health_status', {});

    expect(wait).not.toHaveBeenCalled();
    expect(route).toHaveBeenCalledWith('get_health_status');
  });

  it('runs module, REST and local tools at once during a reconnection', async () => {
    const core = new FoundryCore();
    vi.spyOn(core.foundryClient, 'isReconnecting').mockReturnValue(true);
    const wait = vi.spyOn(core.foundryClient, 'waitUntilConnected');
    // The module is connected: the bridge wait (if any) has nothing to wait for.
    vi.spyOn(
      (core as unknown as { moduleBridge: { isConnected(): boolean } }).moduleBridge,
      'isConnected',
    ).mockReturnValue(true);

    for (const name of ['get_targets', 'search_compendium', 'roll_dice', 'generate_npc']) {
      await core.callTool(name, {});
    }

    expect(wait).not.toHaveBeenCalled();
    expect(route.mock.calls.map(([name]) => name)).toEqual([
      'get_targets',
      'search_compendium',
      'roll_dice',
      'generate_npc',
    ]);
  });

  it('has a mixed tool wait for the socket', async () => {
    const core = new FoundryCore();
    vi.spyOn(core.foundryClient, 'isReconnecting').mockReturnValue(true);
    const wait = vi.spyOn(core.foundryClient, 'waitUntilConnected').mockResolvedValue(true);

    await core.callTool('create_actor_item', { source: { type: 'inline', item: {} } });

    expect(wait).toHaveBeenCalledWith(TOOL_RECONNECT_WAIT_MS);
  });

  it('has a cache resource wait for a reconnection, not the REST diagnostics', async () => {
    const core = new FoundryCore();
    vi.spyOn(core.foundryClient, 'isReconnecting').mockReturnValue(true);
    const wait = vi.spyOn(core.foundryClient, 'waitUntilConnected').mockResolvedValue(false);
    vi.spyOn(core.foundryClient, 'connectionStatus').mockReturnValue({
      state: 'disconnected',
      error: 'the socket dropped',
    });

    await expect(core.readResource('foundry://actors')).rejects.toThrow(
      'Reconnecting to FoundryVTT… (disconnected: the socket dropped).',
    );
    expect(wait).toHaveBeenCalledTimes(1);

    await core.readResource('foundry://system/diagnostics');
    expect(wait).toHaveBeenCalledTimes(1);
  });
});
