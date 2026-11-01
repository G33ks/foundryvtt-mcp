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
  routeToolRequest: (name: string, args: Record<string, unknown>) => route(name, args),
  routeResourceRequest: vi.fn(),
}));

const { FoundryCore } = await import('../core.js');
const { logger } = await import('../utils/logger.js');

describe('FoundryCore tool logging', () => {
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    route.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('logs tool calls without the page or message text', async () => {
    const core = new FoundryCore();
    await core.callTool('update_journal_page', {
      journalId: '0123456789abcdef',
      pageId: 'fedcba9876543210',
      mode: 'append',
      content: '<p>The party arrived in Terris.</p>',
    });
    await core.callTool('create_journal_entry', {
      name: 'Session 12',
      pages: [{ name: 'Recap', content: 'secret plot' }],
    });

    expect(info).toHaveBeenCalledWith('Executing tool', {
      name: 'update_journal_page',
      args: {
        journalId: '0123456789abcdef',
        pageId: 'fedcba9876543210',
        mode: 'append',
        content: '<35 chars>',
      },
    });
    expect(info).toHaveBeenCalledWith('Executing tool', {
      name: 'create_journal_entry',
      args: { name: 'Session 12', pages: [{ name: 'Recap', content: '<11 chars>' }] },
    });
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/Terris|secret plot/);
  });
});
