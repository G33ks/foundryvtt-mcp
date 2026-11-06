import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
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
const { RefusedError, refusalError } = await import('../utils/refusal.js');
const { withToolError } = await import('../tools/handlers/utils.js');

describe('FoundryCore tool logging', () => {
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
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

  it('logs a refusal from below the handler once, as a warning without a stack', async () => {
    route.mockImplementation(() =>
      withToolError('update journal page', async () => {
        throw new RefusedError('Page "Recap" has changed since it was read. Nothing was written.');
      }),
    );
    const core = new FoundryCore();

    const call = core.callTool('update_journal_page', {});
    // The refusal's own message, with no "Failed to update journal page: " in front.
    await expect(call).rejects.toThrow(
      /^MCP error -32600: Page "Recap" has changed since it was read\. Nothing was written\.$/,
    );

    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    // The logged reason carries no "MCP error -32600: " prefix either.
    expect(warn).toHaveBeenCalledWith('Tool call refused', {
      name: 'update_journal_page',
      reason: 'Page "Recap" has changed since it was read. Nothing was written.',
    });
  });

  it('logs a refusal raised by a handler once, as a warning', async () => {
    route.mockRejectedValue(
      refusalError(ErrorCode.InvalidParams, 'Replacing a page body requires expectedVersion'),
    );
    const core = new FoundryCore();

    await expect(core.callTool('update_journal_page', {})).rejects.toThrow(McpError);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('still logs real failures as errors', async () => {
    route.mockImplementation(() =>
      withToolError('update journal page', async () => {
        throw new Error('socket hang up');
      }),
    );
    const core = new FoundryCore();

    await expect(core.callTool('update_journal_page', {})).rejects.toThrow(/socket hang up/);
    expect(error).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
