import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/index.js', () => ({
  config: {
    logLevel: 'error',
    foundry: {
      url: 'http://localhost:30000',
      socketPath: '/socket.io/',
      timeout: 1000,
      retryAttempts: 1,
      retryDelay: 10,
      writeEnabled: true,
    },
    events: { bufferSize: 10, defaultWaitMs: 100 },
    moduleBridge: { enabled: false, port: 31415 },
    headlessGm: { enabled: false },
    assets: {},
  },
}));

const route = vi.fn();
vi.mock('../tools/index.js', () => ({
  routeToolRequest: (name: string) => route(name),
  routeResourceRequest: vi.fn(),
}));

const { FoundryCore } = await import('../core.js');

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('FoundryCore write queue', () => {
  let events: string[];

  beforeEach(() => {
    events = [];
    route.mockImplementation(async (name: string) => {
      events.push(`start ${name}`);
      await tick(name === 'create_scene' ? 30 : 5);
      events.push(`end ${name}`);
      return { content: [{ type: 'text', text: name }] };
    });
  });

  it('serialises writes in arrival order while reads run alongside', async () => {
    const core = new FoundryCore();
    const calls = [
      core.callTool('create_scene', {}),
      core.callTool('update_journal_page', {}),
      core.callTool('get_users', {}),
    ];
    expect(core.status().writeQueue).toBe(2);
    await Promise.all(calls);

    // The read is not held behind the slow write…
    expect(events.indexOf('start get_users')).toBeLessThan(events.indexOf('end create_scene'));
    // …but the second write is.
    expect(events.indexOf('start update_journal_page')).toBeGreaterThan(
      events.indexOf('end create_scene'),
    );
    expect(core.status().writeQueue).toBe(0);
  });

  it('a failed write does not block the next one', async () => {
    route.mockRejectedValueOnce(new Error('denied'));
    const core = new FoundryCore();
    const failed = core.callTool('delete_scene', {});
    const next = core.callTool('create_scene', {});
    await expect(failed).rejects.toThrow('Tool execution failed: denied');
    await expect(next).resolves.toMatchObject({ content: [{ text: 'create_scene' }] });
  });
});
