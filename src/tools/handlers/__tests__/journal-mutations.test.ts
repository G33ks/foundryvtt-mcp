import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FoundryClient } from '../../../foundry/client.js';
import { journalVersion } from '../../../foundry/journal-integrity.js';
import type { WorldJournal } from '../../../foundry/types.js';
import {
  handleAddJournalPage,
  handleCreateJournalEntry,
  handleUpdateJournalEntry,
  handleUpdateJournalPage,
} from '../journal-mutations.js';

const VALID_FOLDER_ID = 'abcdefABCDEF0123';
const JOURNAL_ID = '0123456789abcdef';
const PAGE_ID = 'fedcba9876543210';
const WRITE_DISABLED =
  'Write operations are disabled. Set FOUNDRY_WRITE_ENABLED=true to allow game-state mutation.';

const sampleJournal: WorldJournal = {
  _id: '0123456789abcdef',
  name: 'Session 11 Recap',
  pages: [
    {
      _id: 'fedcba9876543210',
      name: 'Summary',
      type: 'text',
      text: { content: '<p>The party arrived in Terris.</p>', format: 1 },
    },
  ],
};

const READ_VERSION = 'abcdef012345';
const NEW_VERSION = '0123456789ab';

const writeResult = (overrides = {}) => ({
  journalName: 'Session 11 Recap',
  page: sampleJournal.pages?.[0],
  version: NEW_VERSION,
  notices: [] as string[],
  historyPath: '/state/journal-history/x.html',
  ...overrides,
});

const createMockClient = (overrides: Partial<FoundryClient> = {}): FoundryClient => {
  return {
    createJournalEntry: vi.fn(async () => sampleJournal),
    getJournal: vi.fn(() => sampleJournal),
    updateJournalPage: vi.fn(async () => writeResult()),
    appendJournalPage: vi.fn(async () => writeResult()),
    addJournalPage: vi.fn(async () => ({
      _id: 'newpage000000000',
      name: 'Loot',
      text: { content: '<p>Rope</p>' },
    })),
    updateJournalEntry: vi.fn(async () => ({ _id: JOURNAL_ID })),
    drainJournalWarnings: vi.fn(() => []),
    ...overrides,
  } as unknown as FoundryClient;
};

describe('journal mutation handlers', () => {
  describe('handleCreateJournalEntry', () => {
    it('creates a journal entry with a single page', async () => {
      const mockClient = createMockClient();
      const result = await handleCreateJournalEntry(
        {
          name: 'Session 11 Recap',
          pages: [{ name: 'Summary', content: '<p>The party arrived in Terris.</p>' }],
        },
        mockClient,
      );

      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Journal Entry Created');
      expect(result.content[0].text).toContain('Session 11 Recap');
      expect(result.content[0].text).toContain(
        `- Summary — ID: ${PAGE_ID} — version: ${journalVersion('<p>The party arrived in Terris.</p>')}`,
      );
      expect(mockClient.createJournalEntry).toHaveBeenCalledWith(
        'Session 11 Recap',
        [{ name: 'Summary', content: '<p>The party arrived in Terris.</p>' }],
        undefined,
        undefined,
      );
    });

    it('defaults to GM-only visibility and says so in the response', async () => {
      const mockClient = createMockClient();
      const result = await handleCreateJournalEntry(
        { name: 'Session 11 Recap', pages: [{ name: 'Summary', content: 'text' }] },
        mockClient,
      );
      expect(result.content[0].text).toContain('**Visible to:** GM only');
    });

    it('passes visibility through and reports player-readable', async () => {
      const mockClient = createMockClient();
      const result = await handleCreateJournalEntry(
        {
          name: 'Session 11 Recap',
          pages: [{ name: 'Summary', content: 'text' }],
          visibility: 'observer',
        },
        mockClient,
      );
      expect(mockClient.createJournalEntry).toHaveBeenCalledWith(
        'Session 11 Recap',
        [{ name: 'Summary', content: 'text' }],
        undefined,
        'observer',
      );
      expect(result.content[0].text).toContain('all players (read-only)');
    });

    it('rejects an unknown visibility with InvalidParams', async () => {
      const mockClient = createMockClient();
      await expect(
        handleCreateJournalEntry(
          {
            name: 'Session 11 Recap',
            pages: [{ name: 'Summary', content: 'text' }],
            visibility: 'everyone' as unknown as 'observer',
          },
          mockClient,
        ),
      ).rejects.toThrow(McpError);
    });

    it('passes an optional folder id through', async () => {
      const mockClient = createMockClient();
      await handleCreateJournalEntry(
        {
          name: 'Session 11 Recap',
          pages: [{ name: 'Summary', content: 'text' }],
          folder: VALID_FOLDER_ID,
        },
        mockClient,
      );

      expect(mockClient.createJournalEntry).toHaveBeenCalledWith(
        'Session 11 Recap',
        [{ name: 'Summary', content: 'text' }],
        VALID_FOLDER_ID,
        undefined,
      );
    });

    it('rejects an empty name with InvalidParams', async () => {
      const mockClient = createMockClient();
      await expect(
        handleCreateJournalEntry(
          { name: '', pages: [{ name: 'Summary', content: 'text' }] },
          mockClient,
        ),
      ).rejects.toThrow(McpError);
    });

    it('rejects an empty pages array with InvalidParams', async () => {
      const mockClient = createMockClient();
      await expect(
        handleCreateJournalEntry({ name: 'Session 11 Recap', pages: [] }, mockClient),
      ).rejects.toThrow(McpError);
    });

    it('rejects a page missing content with InvalidParams', async () => {
      const mockClient = createMockClient();
      await expect(
        handleCreateJournalEntry(
          {
            name: 'Session 11 Recap',
            pages: [{ name: 'Summary' } as unknown as { name: string; content: string }],
          },
          mockClient,
        ),
      ).rejects.toThrow(McpError);
    });

    it('propagates a client error', async () => {
      const mockClient = createMockClient({
        createJournalEntry: vi.fn(async () => {
          throw new Error('FoundryVTT rejected create JournalEntry: some failure');
        }),
      });
      await expect(
        handleCreateJournalEntry(
          { name: 'Session 11 Recap', pages: [{ name: 'Summary', content: 'text' }] },
          mockClient,
        ),
      ).rejects.toThrow(McpError);
    });

    it('surfaces the write-disabled guard error', async () => {
      const mockClient = createMockClient({
        createJournalEntry: vi.fn(async () => {
          throw new Error(
            'Write operations are disabled. Set FOUNDRY_WRITE_ENABLED=true to allow game-state mutation.',
          );
        }),
      });
      await expect(
        handleCreateJournalEntry(
          { name: 'Session 11 Recap', pages: [{ name: 'Summary', content: 'text' }] },
          mockClient,
        ),
      ).rejects.toThrow('FOUNDRY_WRITE_ENABLED');
    });
  });

  describe('handleUpdateJournalPage', () => {
    it('replaces content and name by default (mode "replace")', async () => {
      const mockClient = createMockClient();
      const result = await handleUpdateJournalPage(
        {
          journalId: JOURNAL_ID,
          pageId: PAGE_ID,
          name: 'Recap',
          content: '<p>new</p>',
          expectedVersion: READ_VERSION,
        },
        mockClient,
      );

      expect(mockClient.updateJournalPage).toHaveBeenCalledWith(JOURNAL_ID, PAGE_ID, {
        name: 'Recap',
        content: '<p>new</p>',
        expectedVersion: READ_VERSION,
      });
      expect(mockClient.appendJournalPage).not.toHaveBeenCalled();
      const text = result.content[0].text;
      expect(text).toContain('Journal Page Updated');
      expect(text).toContain('Session 11 Recap');
      expect(text).toContain(PAGE_ID);
      expect(text).toContain('replace');
      expect(text).toContain(`**Version:** ${NEW_VERSION}`);
    });

    it('requires expectedVersion to replace content, pointing at get_journal raw', async () => {
      const mockClient = createMockClient();
      const call = handleUpdateJournalPage(
        { journalId: JOURNAL_ID, pageId: PAGE_ID, content: '<p>new</p>' },
        mockClient,
      );
      await expect(call).rejects.toThrow(McpError);
      await expect(call).rejects.toThrow(/expectedVersion.*get_journal with raw: true/);
      expect(mockClient.updateJournalPage).not.toHaveBeenCalled();
    });

    it('surfaces a refused stale version as an error', async () => {
      const mockClient = createMockClient({
        updateJournalPage: vi.fn(async () => {
          throw new Error('Page "Summary" (x) has changed since it was read. Nothing was written.');
        }),
      });
      await expect(
        handleUpdateJournalPage(
          { journalId: JOURNAL_ID, pageId: PAGE_ID, content: 'x', expectedVersion: READ_VERSION },
          mockClient,
        ),
      ).rejects.toThrow(/has changed since it was read/);
    });

    it('shows the write notices and pending warnings', async () => {
      const mockClient = createMockClient({
        appendJournalPage: vi.fn(async () =>
          writeResult({ notices: ['The page had changed since the last sync.'] }),
        ),
        drainJournalWarnings: vi.fn(() => ['⚠️ **Journal overwrite detected:** earlier']),
      });
      const result = await handleUpdateJournalPage(
        { journalId: JOURNAL_ID, pageId: PAGE_ID, mode: 'append', content: '<p>more</p>' },
        mockClient,
      );
      expect(result.content[0].text).toMatch(
        /^⚠️ \*\*Journal overwrite detected:\*\* earlier\n\nThe page had changed since the last sync\.\n\n📝/,
      );
    });

    it('can rename a page without touching its content', async () => {
      const mockClient = createMockClient();
      await handleUpdateJournalPage(
        { journalId: JOURNAL_ID, pageId: PAGE_ID, name: 'Recap' },
        mockClient,
      );
      expect(mockClient.updateJournalPage).toHaveBeenCalledWith(JOURNAL_ID, PAGE_ID, {
        name: 'Recap',
      });
    });

    it('rejects an empty expectedVersion', async () => {
      const mockClient = createMockClient();
      await expect(
        handleUpdateJournalPage(
          { journalId: JOURNAL_ID, pageId: PAGE_ID, name: 'Recap', expectedVersion: '' },
          mockClient,
        ),
      ).rejects.toThrow(McpError);
    });

    it('appends content in mode "append"', async () => {
      const mockClient = createMockClient();
      const result = await handleUpdateJournalPage(
        { journalId: JOURNAL_ID, pageId: PAGE_ID, mode: 'append', content: '<p>more</p>' },
        mockClient,
      );

      expect(mockClient.appendJournalPage).toHaveBeenCalledWith(
        JOURNAL_ID,
        PAGE_ID,
        '<p>more</p>',
        undefined,
      );
      expect(mockClient.updateJournalPage).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('append');
      expect(result.content[0].text).toContain(`**Version:** ${NEW_VERSION}`);
    });

    it('passes an optional expectedVersion through in append mode', async () => {
      const mockClient = createMockClient();
      await handleUpdateJournalPage(
        {
          journalId: JOURNAL_ID,
          pageId: PAGE_ID,
          mode: 'append',
          content: '<p>more</p>',
          expectedVersion: READ_VERSION,
        },
        mockClient,
      );
      expect(mockClient.appendJournalPage).toHaveBeenCalledWith(
        JOURNAL_ID,
        PAGE_ID,
        '<p>more</p>',
        READ_VERSION,
      );
    });

    it('rejects an unknown mode with InvalidParams', async () => {
      const mockClient = createMockClient();
      await expect(
        handleUpdateJournalPage(
          {
            journalId: JOURNAL_ID,
            pageId: PAGE_ID,
            mode: 'prepend' as unknown as 'append',
            content: 'x',
          },
          mockClient,
        ),
      ).rejects.toThrow(McpError);
    });

    it('rejects a replace with neither name nor content', async () => {
      const mockClient = createMockClient();
      await expect(
        handleUpdateJournalPage({ journalId: JOURNAL_ID, pageId: PAGE_ID }, mockClient),
      ).rejects.toThrow(McpError);
    });

    it('rejects an append without content', async () => {
      const mockClient = createMockClient();
      await expect(
        handleUpdateJournalPage(
          { journalId: JOURNAL_ID, pageId: PAGE_ID, mode: 'append' },
          mockClient,
        ),
      ).rejects.toThrow(McpError);
    });

    it('rejects a rename in append mode instead of silently ignoring it', async () => {
      const mockClient = createMockClient();
      await expect(
        handleUpdateJournalPage(
          { journalId: JOURNAL_ID, pageId: PAGE_ID, mode: 'append', name: 'Recap', content: 'x' },
          mockClient,
        ),
      ).rejects.toThrow(McpError);
    });

    it('rejects a missing pageId with InvalidParams', async () => {
      const mockClient = createMockClient();
      await expect(
        handleUpdateJournalPage({ journalId: JOURNAL_ID, pageId: '', content: 'x' }, mockClient),
      ).rejects.toThrow(McpError);
    });

    it('surfaces the write-disabled guard error', async () => {
      const mockClient = createMockClient({
        updateJournalPage: vi.fn(async () => {
          throw new Error(WRITE_DISABLED);
        }),
      });
      await expect(
        handleUpdateJournalPage(
          { journalId: JOURNAL_ID, pageId: PAGE_ID, content: 'x', expectedVersion: READ_VERSION },
          mockClient,
        ),
      ).rejects.toThrow('FOUNDRY_WRITE_ENABLED');
    });
  });

  describe('handleAddJournalPage', () => {
    it('adds a text page and reports its new id', async () => {
      const mockClient = createMockClient();
      const result = await handleAddJournalPage(
        { journalId: JOURNAL_ID, name: 'Loot', content: '<p>Rope</p>' },
        mockClient,
      );

      expect(mockClient.addJournalPage).toHaveBeenCalledWith(JOURNAL_ID, {
        name: 'Loot',
        content: '<p>Rope</p>',
      });
      const text = result.content[0].text;
      expect(text).toContain('Journal Page Added');
      expect(text).toContain('newpage000000000');
      expect(text).toContain('Session 11 Recap');
      expect(text).toContain(`**Version:** ${journalVersion('<p>Rope</p>')}`);
    });

    it('rejects an empty name with InvalidParams', async () => {
      const mockClient = createMockClient();
      await expect(
        handleAddJournalPage({ journalId: JOURNAL_ID, name: '', content: 'x' }, mockClient),
      ).rejects.toThrow(McpError);
    });

    it('rejects a missing content with InvalidParams', async () => {
      const mockClient = createMockClient();
      await expect(
        handleAddJournalPage(
          { journalId: JOURNAL_ID, name: 'Loot' } as unknown as {
            journalId: string;
            name: string;
            content: string;
          },
          mockClient,
        ),
      ).rejects.toThrow(McpError);
    });

    it('surfaces the write-disabled guard error', async () => {
      const mockClient = createMockClient({
        addJournalPage: vi.fn(async () => {
          throw new Error(WRITE_DISABLED);
        }),
      });
      await expect(
        handleAddJournalPage({ journalId: JOURNAL_ID, name: 'Loot', content: 'x' }, mockClient),
      ).rejects.toThrow('FOUNDRY_WRITE_ENABLED');
    });
  });

  describe('handleUpdateJournalEntry', () => {
    it('passes only the supplied fields through', async () => {
      const mockClient = createMockClient();
      const result = await handleUpdateJournalEntry(
        { journalId: JOURNAL_ID, visibility: 'observer' },
        mockClient,
      );

      expect(mockClient.updateJournalEntry).toHaveBeenCalledWith(JOURNAL_ID, {
        visibility: 'observer',
      });
      const text = result.content[0].text;
      expect(text).toContain('Journal Entry Updated');
      expect(text).toContain('all players (read-only)');
    });

    it('renames and refiles an entry', async () => {
      const mockClient = createMockClient();
      await handleUpdateJournalEntry(
        { journalId: JOURNAL_ID, name: 'Session 12', folder: VALID_FOLDER_ID },
        mockClient,
      );
      expect(mockClient.updateJournalEntry).toHaveBeenCalledWith(JOURNAL_ID, {
        name: 'Session 12',
        folder: VALID_FOLDER_ID,
      });
    });

    it('rejects a call that changes nothing', async () => {
      const mockClient = createMockClient();
      await expect(handleUpdateJournalEntry({ journalId: JOURNAL_ID }, mockClient)).rejects.toThrow(
        McpError,
      );
    });

    it('rejects an unknown visibility with InvalidParams', async () => {
      const mockClient = createMockClient();
      await expect(
        handleUpdateJournalEntry(
          { journalId: JOURNAL_ID, visibility: 'everyone' as unknown as 'observer' },
          mockClient,
        ),
      ).rejects.toThrow(McpError);
    });

    it('surfaces the write-disabled guard error', async () => {
      const mockClient = createMockClient({
        updateJournalEntry: vi.fn(async () => {
          throw new Error(WRITE_DISABLED);
        }),
      });
      await expect(
        handleUpdateJournalEntry({ journalId: JOURNAL_ID, name: 'Session 12' }, mockClient),
      ).rejects.toThrow('FOUNDRY_WRITE_ENABLED');
    });
  });
});

// ----------------------------------------------------------------------------
// Client-level: exercises the real createJournalEntry over a mocked Socket.IO
// socket (modifyDocument protocol).
// ----------------------------------------------------------------------------
describe('FoundryClient journal mutations (modifyDocument)', () => {
  type SocketEmitMock = (event: string, payload: unknown, cb: (response: unknown) => void) => void;

  const buildClient = (opts: { writeEnabled?: boolean; connected?: boolean } = {}) => {
    const client = new FoundryClient({
      baseUrl: 'http://localhost:30000',
      writeEnabled: opts.writeEnabled ?? true,
    });
    const emit = vi.fn(((_event, payload, cb) => {
      const op = (payload as { operation?: { data?: unknown[] } }).operation;
      const echoed = op?.data?.[0];
      cb({ result: echoed ? [echoed] : [] });
    }) as SocketEmitMock);
    if (opts.connected !== false) {
      (client as unknown as { socket: { connected: boolean; emit: SocketEmitMock } }).socket = {
        connected: true,
        emit,
      };
    }
    return client;
  };

  const lastRequest = (client: FoundryClient) => {
    const emitMock = (client as unknown as { socket: { emit: ReturnType<typeof vi.fn> } }).socket
      .emit;
    return emitMock.mock.calls[0];
  };

  it('creates a top-level JournalEntry modifyDocument request with no parentUuid', async () => {
    const client = buildClient();
    await client.createJournalEntry('Session 11 Recap', [
      { name: 'Summary', content: '<p>The party arrived in Terris.</p>' },
    ]);
    const [event, body] = lastRequest(client);
    expect(event).toBe('modifyDocument');
    expect(body).toMatchObject({
      type: 'JournalEntry',
      action: 'create',
      operation: {
        data: [
          {
            name: 'Session 11 Recap',
            pages: [
              {
                name: 'Summary',
                type: 'text',
                text: { content: '<p>The party arrived in Terris.</p>', format: 1 },
                sort: 100000,
              },
            ],
          },
        ],
        broadcast: true,
        pack: null,
      },
    });
    expect(body.operation.parentUuid).toBeUndefined();
  });

  it('maps multiple pages in order', async () => {
    const client = buildClient();
    await client.createJournalEntry('Session 11 Recap', [
      { name: 'Summary', content: 'a' },
      { name: 'NPCs', content: 'b' },
    ]);
    const [, body] = lastRequest(client);
    expect(body.operation.data[0].pages).toHaveLength(2);
    expect(body.operation.data[0].pages[0].name).toBe('Summary');
    expect(body.operation.data[0].pages[1].name).toBe('NPCs');
  });

  it('assigns ascending sort values so pages render in the supplied order', async () => {
    const client = buildClient();
    await client.createJournalEntry('Session 11 Recap', [
      { name: 'Summary', content: 'a' },
      { name: 'NPCs', content: 'b' },
      { name: 'Loot', content: 'c' },
    ]);
    const [, body] = lastRequest(client);
    expect(body.operation.data[0].pages.map((p: { sort: number }) => p.sort)).toEqual([
      100000, 200000, 300000,
    ]);
  });

  it('includes folder when provided', async () => {
    const client = buildClient();
    await client.createJournalEntry(
      'Session 11 Recap',
      [{ name: 'Summary', content: 'a' }],
      VALID_FOLDER_ID,
    );
    const [, body] = lastRequest(client);
    expect(body.operation.data[0].folder).toBe(VALID_FOLDER_ID);
  });

  it('omits ownership entirely when no visibility is given, leaving Foundry to default it', async () => {
    const client = buildClient();
    await client.createJournalEntry('Session 11 Recap', [{ name: 'Summary', content: 'a' }]);
    const [, body] = lastRequest(client);
    expect(body.operation.data[0].ownership).toBeUndefined();
  });

  it.each([
    ['observer', 2],
    ['owner', 3],
    ['gm-only', 0],
  ] as const)('maps visibility %s to ownership.default %i', async (visibility, level) => {
    const client = buildClient();
    await client.createJournalEntry(
      'Session 11 Recap',
      [{ name: 'Summary', content: 'a' }],
      undefined,
      visibility,
    );
    const [, body] = lastRequest(client);
    expect(body.operation.data[0].ownership).toEqual({ default: level });
  });

  it('rejects an unknown visibility before emitting', async () => {
    const client = buildClient();
    await expect(
      client.createJournalEntry(
        'Session 11 Recap',
        [{ name: 'Summary', content: 'a' }],
        undefined,
        'everyone' as unknown as 'observer',
      ),
    ).rejects.toThrow(/Invalid visibility/);
  });

  it('rejects an empty pages array before emitting', async () => {
    const client = buildClient();
    await expect(client.createJournalEntry('Session 11 Recap', [])).rejects.toThrow(
      /at least one page/,
    );
  });

  it('rejects a malformed folder id before emitting', async () => {
    const client = buildClient();
    await expect(
      client.createJournalEntry('Session 11 Recap', [{ name: 'Summary', content: 'a' }], 'short'),
    ).rejects.toThrow(/Invalid folder/);
  });

  it('rejects writes when FOUNDRY_WRITE_ENABLED is false', async () => {
    const client = buildClient({ writeEnabled: false });
    await expect(
      client.createJournalEntry('Session 11 Recap', [{ name: 'Summary', content: 'a' }]),
    ).rejects.toThrow(/FOUNDRY_WRITE_ENABLED/);
  });

  it('rejects writes when the socket is not connected', async () => {
    const client = buildClient({ connected: false });
    await expect(
      client.createJournalEntry('Session 11 Recap', [{ name: 'Summary', content: 'a' }]),
    ).rejects.toThrow(/Socket\.IO connection/);
  });
});

// ----------------------------------------------------------------------------
// Client-level page editing: real FoundryClient over a mocked socket standing
// in for a FoundryVTT v14 server. The server keeps its own copy of the entry,
// answers `get` from it, and stores page bodies the way v14 does (`<br/>` →
// `<br>`), so the cache can lag behind it the way it does in a live world.
// ----------------------------------------------------------------------------
describe('FoundryClient journal page editing (modifyDocument)', () => {
  type SocketEmitMock = (event: string, payload: unknown, cb: (response: unknown) => void) => void;
  type Request = {
    type: string;
    action: string;
    operation: {
      data?: Array<Record<string, unknown>>;
      updates?: Array<Record<string, unknown>>;
      query?: { _id?: string };
      parentUuid?: string;
    };
  };

  const CONNECTOR_ID = 'mcpapi0000000001';
  const HEADLESS_ID = 'mcpgm00000000001';
  const ALICE_ID = 'alice00000000001';
  const GM_ID = 'gamemaster000001';
  const SECOND_PAGE = 'aaaaaaaaaaaaaaa2';

  const buildWorldJournal = (): WorldJournal => ({
    _id: JOURNAL_ID,
    name: 'Session 11 Recap',
    pages: [
      {
        _id: PAGE_ID,
        name: 'Summary',
        type: 'text',
        text: { content: '<p>The party arrived in Terris.</p>', format: 1 },
        sort: 100000,
      },
      {
        _id: SECOND_PAGE,
        name: 'NPCs',
        type: 'text',
        text: { content: '<p>Mira</p>', format: 1 },
        sort: 200000,
      },
    ],
  });

  /** v14 rewrites bodies on save; enough of it to tell sent from stored. */
  const serverClean = (html: string) => html.replace(/<br\/>/g, '<br>');

  let historyDir: string;
  beforeEach(() => {
    historyDir = mkdtempSync(path.join(os.tmpdir(), 'journal-history-'));
  });
  afterEach(() => {
    rmSync(historyDir, { recursive: true, force: true });
  });

  const buildClient = (
    opts: {
      writeEnabled?: boolean;
      journal?: WorldJournal | null;
      server?: WorldJournal | null;
      language?: string;
      /** Runs while an update is in flight, before the server acknowledges it. */
      duringUpdate?: () => void;
    } = {},
  ) => {
    const client = new FoundryClient({
      baseUrl: 'http://localhost:30000',
      writeEnabled: opts.writeEnabled ?? true,
      journalHistoryDir: historyDir,
      connectorUsernames: ['mcp-gm'],
    });
    const server: { journal: WorldJournal | null } = {
      journal: opts.server === undefined ? buildWorldJournal() : opts.server,
    };
    const emit = vi.fn(((_event, payload, cb) => {
      const { type, action, operation: op } = payload as Request;
      if (action === 'get') {
        const found = server.journal && op.query?._id === server.journal._id;
        cb({ result: found ? [structuredClone(server.journal)] : [] });
        return;
      }
      if (type === 'JournalEntryPage' && action === 'update' && op.updates) {
        opts.duringUpdate?.();
        const result = op.updates.map((u) => {
          const page = server.journal?.pages?.find((p) => p._id === u._id);
          const diff: Record<string, unknown> = { _id: u._id };
          if (typeof u.name === 'string' && page) {
            page.name = u.name;
            diff.name = u.name;
          }
          const content = u['text.content'];
          if (typeof content === 'string' && page) {
            const stored = serverClean(content);
            if (stored !== page.text?.content) {
              page.text = { content: stored, format: 1 };
              diff.text = { content: stored };
            }
          }
          return diff;
        });
        cb({ result });
        return;
      }
      if (op.updates) {
        cb({ result: op.updates });
        return;
      }
      cb({
        result: (op.data ?? []).map((d) => {
          const created = { _id: 'newpage000000000', ...d };
          if (type === 'JournalEntryPage' && server.journal) {
            server.journal.pages = [...(server.journal.pages ?? []), created as never];
          }
          return created;
        }),
      });
    }) as SocketEmitMock);
    const internals = client as unknown as {
      socket: { connected: boolean; emit: SocketEmitMock };
      worldData: Record<string, unknown> & { journal: WorldJournal[] };
      worldDataStale: boolean;
      onDocumentBroadcast: (payload: unknown) => void;
      onEditorAutosave: (uuid: unknown, html: unknown) => void;
    };
    internals.socket = { connected: true, emit };
    internals.worldData = {
      userId: CONNECTOR_ID,
      users: [
        { _id: CONNECTOR_ID, name: 'mcp-api', role: 4 },
        { _id: HEADLESS_ID, name: 'mcp-gm', role: 4 },
        { _id: GM_ID, name: 'Marie', role: 4 },
        { _id: ALICE_ID, name: 'Alice', role: 1 },
      ],
      options: { language: opts.language ?? 'en.core' },
      journal: opts.journal === null ? [] : [opts.journal ?? buildWorldJournal()],
    };
    return { client, emit, server, internals };
  };

  const cachedPage = (client: FoundryClient, pageId = PAGE_ID) =>
    client.getJournal(JOURNAL_ID)?.pages?.find((p) => p._id === pageId);
  const requests = (emit: ReturnType<typeof vi.fn>) =>
    emit.mock.calls.map((call) => call[1] as Request);
  const updates = (emit: ReturnType<typeof vi.fn>) =>
    requests(emit).filter((r) => r.action === 'update');
  const versionOf = (html: string) => journalVersion(html);
  const pageBroadcast = (userId: string, content: string, pageId = PAGE_ID) => ({
    type: 'JournalEntryPage',
    action: 'update',
    result: [{ _id: pageId, text: { content } }],
    operation: { parentUuid: `JournalEntry.${JOURNAL_ID}` },
    userId,
  });
  const autosaveUuid = `JournalEntry.${JOURNAL_ID}.JournalEntryPage.${PAGE_ID}#text.content`;
  const historyFiles = () => {
    try {
      return readdirSync(path.join(historyDir, JOURNAL_ID, PAGE_ID));
    } catch {
      return [];
    }
  };
  const ORIGINAL = '<p>The party arrived in Terris.</p>';
  const setServerBody = (server: { journal: WorldJournal | null }, content: string) => {
    const page = server.journal?.pages?.find((p) => p._id === PAGE_ID);
    if (page) {
      page.text = { content, format: 1 };
    }
  };

  describe('fetchJournalEntry', () => {
    it('reads the entry with a non-broadcast get and refreshes only that cache entry', async () => {
      const { client, emit, server, internals } = buildClient();
      internals.worldDataStale = true;
      setServerBody(server, '<p>Newer</p>');

      const journal = await client.fetchJournalEntry(JOURNAL_ID);

      expect(requests(emit)[0]).toEqual({
        type: 'JournalEntry',
        action: 'get',
        operation: { query: { _id: JOURNAL_ID }, pack: null },
      });
      expect(journal?.pages?.[0]?.text?.content).toBe('<p>Newer</p>');
      expect(cachedPage(client)?.text?.content).toBe('<p>Newer</p>');
      expect(client.isWorldDataStale()).toBe(true);
    });

    it('returns undefined and drops the cached entry when the server has none', async () => {
      const { client } = buildClient({ server: null });
      expect(await client.fetchJournalEntry(JOURNAL_ID)).toBeUndefined();
      expect(client.getJournal(JOURNAL_ID)).toBeUndefined();
    });

    it('falls back to a full refresh when the get is rejected', async () => {
      const { client, emit, internals } = buildClient();
      emit.mockImplementationOnce(((_e, _p, cb) =>
        cb({ error: { message: 'Invalid action' } })) as SocketEmitMock);
      const refreshed = { ...buildWorldJournal(), name: 'From refresh' };
      const refresh = vi.spyOn(client, 'refreshWorldData').mockImplementation(async () => {
        internals.worldData.journal = [refreshed];
      });

      const journal = await client.fetchJournalEntry(JOURNAL_ID);

      expect(refresh).toHaveBeenCalledOnce();
      expect(journal?.name).toBe('From refresh');
    });
  });

  describe('updateJournalPage', () => {
    it('reads the page back, then sends an update scoped to the parent entry', async () => {
      const { client, emit } = buildClient();
      await client.updateJournalPage(JOURNAL_ID, PAGE_ID, {
        name: 'Recap',
        content: '<p>new</p>',
        expectedVersion: versionOf(ORIGINAL),
      });

      expect(requests(emit)[0]?.action).toBe('get');
      const [event, body] = emit.mock.calls[1];
      expect(event).toBe('modifyDocument');
      expect(body).toMatchObject({
        type: 'JournalEntryPage',
        action: 'update',
        operation: {
          updates: [{ _id: PAGE_ID, name: 'Recap', 'text.content': '<p>new</p>' }],
          parentUuid: `JournalEntry.${JOURNAL_ID}`,
          diff: true,
          broadcast: true,
        },
      });
    });

    it('renames a page without a version token', async () => {
      const { client, emit } = buildClient();
      const written = await client.updateJournalPage(JOURNAL_ID, PAGE_ID, { name: 'Recap' });

      expect(updates(emit)[0]?.operation.updates).toEqual([{ _id: PAGE_ID, name: 'Recap' }]);
      expect(written.version).toBe(versionOf(ORIGINAL));
      expect(written.page.name).toBe('Recap');
    });

    it('refuses to replace content without a version token, before any request', async () => {
      const { client, emit } = buildClient();
      await expect(
        client.updateJournalPage(JOURNAL_ID, PAGE_ID, { content: '<p>new</p>' }),
      ).rejects.toThrow(/expectedVersion/);
      expect(emit).not.toHaveBeenCalled();
    });

    it('refuses a stale version token and writes nothing', async () => {
      const { client, emit, server } = buildClient();
      const read = versionOf(ORIGINAL);
      // Someone edits the page after Claude read it.
      setServerBody(server, '<p>Edited</p>');

      await expect(
        client.updateJournalPage(JOURNAL_ID, PAGE_ID, {
          content: '<p>new</p>',
          expectedVersion: read,
        }),
      ).rejects.toThrow(/has changed since it was read.*Nothing was written/);
      expect(updates(emit)).toHaveLength(0);
      expect(historyFiles()).toHaveLength(0);
    });

    it('returns the version of the body as the server stored it', async () => {
      const { client } = buildClient();
      const written = await client.updateJournalPage(JOURNAL_ID, PAGE_ID, {
        content: '<p>a<br/>b</p>',
        expectedVersion: versionOf(ORIGINAL),
      });
      expect(written.version).toBe(versionOf('<p>a<br>b</p>'));
      expect(cachedPage(client)?.text?.content).toBe('<p>a<br>b</p>');
    });

    it('keeps a before-replace copy of the previous body', async () => {
      const { client } = buildClient();
      const written = await client.updateJournalPage(JOURNAL_ID, PAGE_ID, {
        content: '<p>new</p>',
        expectedVersion: versionOf(ORIGINAL),
      });

      expect(written.historyPath).toMatch(/-before-replace\.html$/);
      expect(readFileSync(written.historyPath, 'utf8')).toBe(ORIGINAL);
      const meta = JSON.parse(
        readFileSync(written.historyPath.replace(/\.html$/, '.json'), 'utf8'),
      );
      expect(meta).toMatchObject({
        journalName: 'Session 11 Recap',
        pageName: 'Summary',
        reason: 'before-replace',
        version: versionOf(ORIGINAL),
        user: 'mcp-api',
      });
    });

    it('writes nothing when the local copy cannot be saved', async () => {
      const { client, emit } = buildClient();
      writeFileSync(path.join(historyDir, JOURNAL_ID), 'not a folder');

      await expect(
        client.updateJournalPage(JOURNAL_ID, PAGE_ID, {
          content: '<p>new</p>',
          expectedVersion: versionOf(ORIGINAL),
        }),
      ).rejects.toThrow(/Could not save a local copy.*Nothing was written/);
      expect(updates(emit)).toHaveLength(0);
    });

    it.each([
      ['journalId', 'short', PAGE_ID],
      ['pageId', JOURNAL_ID, 'short'],
    ])('rejects a malformed %s before emitting', async (field, journalId, pageId) => {
      const { client, emit } = buildClient();
      await expect(client.updateJournalPage(journalId, pageId, { name: 'x' })).rejects.toThrow(
        new RegExp(`Invalid ${field}`),
      );
      expect(emit).not.toHaveBeenCalled();
    });

    it('rejects an update that changes nothing', async () => {
      const { client, emit } = buildClient();
      await expect(client.updateJournalPage(JOURNAL_ID, PAGE_ID, {})).rejects.toThrow(
        /name or content/,
      );
      expect(emit).not.toHaveBeenCalled();
    });

    it('rejects writes when FOUNDRY_WRITE_ENABLED is false', async () => {
      const { client, emit } = buildClient({ writeEnabled: false });
      await expect(client.updateJournalPage(JOURNAL_ID, PAGE_ID, { name: 'x' })).rejects.toThrow(
        /FOUNDRY_WRITE_ENABLED/,
      );
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('appendJournalPage', () => {
    it('appends to the body read from the server and keeps a before-append copy', async () => {
      const { client, emit } = buildClient();
      const written = await client.appendJournalPage(JOURNAL_ID, PAGE_ID, '<p>They met Mira.</p>');

      expect(updates(emit)[0]?.operation.updates).toEqual([
        { _id: PAGE_ID, 'text.content': `${ORIGINAL}<p>They met Mira.</p>` },
      ]);
      expect(cachedPage(client)?.text?.content).toBe(`${ORIGINAL}<p>They met Mira.</p>`);
      expect(written.version).toBe(versionOf(`${ORIGINAL}<p>They met Mira.</p>`));
      expect(written.notices).toEqual([]);
      expect(written.historyPath).toMatch(/-before-append\.html$/);
      expect(readFileSync(written.historyPath, 'utf8')).toBe(ORIGINAL);
    });

    it('appends to the current body when the cache is stale, and says so', async () => {
      const { client, emit, server } = buildClient();
      // Written by a player since the last sync; the cache never saw it.
      setServerBody(server, `${ORIGINAL}<p>Player note</p>`);

      const written = await client.appendJournalPage(JOURNAL_ID, PAGE_ID, '<p>Ours</p>');

      expect(updates(emit)[0]?.operation.updates).toEqual([
        { _id: PAGE_ID, 'text.content': `${ORIGINAL}<p>Player note</p><p>Ours</p>` },
      ]);
      expect(written.notices).toEqual([expect.stringMatching(/had changed since the last sync/)]);
    });

    it('accepts a matching version token and refuses a stale one', async () => {
      const { client, emit } = buildClient();
      await expect(
        client.appendJournalPage(JOURNAL_ID, PAGE_ID, '<p>x</p>', 'ffffffffffff'),
      ).rejects.toThrow(/has changed since it was read/);
      expect(updates(emit)).toHaveLength(0);

      await client.appendJournalPage(JOURNAL_ID, PAGE_ID, '<p>x</p>', versionOf(ORIGINAL));
      expect(updates(emit)).toHaveLength(1);
    });

    it('warns when an editor autosaved the page recently', async () => {
      const { client, internals } = buildClient();
      internals.onEditorAutosave(autosaveUuid, ORIGINAL);

      const written = await client.appendJournalPage(JOURNAL_ID, PAGE_ID, '<p>x</p>');

      expect(written.notices).toEqual([expect.stringMatching(/probably open in an editor/)]);
    });

    it('fails clearly when the page is not in the journal', async () => {
      const { client, emit } = buildClient();
      await expect(
        client.appendJournalPage(JOURNAL_ID, 'zzzzzzzzzzzzzzzz', '<p>x</p>'),
      ).rejects.toThrow(`Journal page not found: zzzzzzzzzzzzzzzz in journal ${JOURNAL_ID}`);
      expect(updates(emit)).toHaveLength(0);
    });

    it('fails clearly when the server has no such journal', async () => {
      const { client, emit } = buildClient({ server: null });
      await expect(client.appendJournalPage(JOURNAL_ID, PAGE_ID, '<p>x</p>')).rejects.toThrow(
        `Journal not found: ${JOURNAL_ID}`,
      );
      expect(updates(emit)).toHaveLength(0);
    });

    it('rejects empty html', async () => {
      const { client } = buildClient();
      await expect(client.appendJournalPage(JOURNAL_ID, PAGE_ID, '')).rejects.toThrow(/html/);
    });

    it('rejects writes when FOUNDRY_WRITE_ENABLED is false', async () => {
      const { client } = buildClient({ writeEnabled: false });
      await expect(client.appendJournalPage(JOURNAL_ID, PAGE_ID, '<p>x</p>')).rejects.toThrow(
        /FOUNDRY_WRITE_ENABLED/,
      );
    });
  });

  describe('addJournalPage', () => {
    it('creates a text page sorted after the last page on the server', async () => {
      const { client, emit, server } = buildClient();
      // A page added elsewhere since the last sync.
      server.journal?.pages?.push({
        _id: 'bbbbbbbbbbbbbbb3',
        name: 'Loot',
        type: 'text',
        text: { content: '', format: 1 },
        sort: 500000,
      });

      const page = await client.addJournalPage(JOURNAL_ID, { name: 'Map', content: '<p>Rope</p>' });

      const create = requests(emit).find((r) => r.action === 'create');
      expect(create).toMatchObject({
        type: 'JournalEntryPage',
        operation: {
          data: [
            {
              name: 'Map',
              type: 'text',
              text: { content: '<p>Rope</p>', format: 1 },
              sort: 600000,
            },
          ],
          parentUuid: `JournalEntry.${JOURNAL_ID}`,
        },
      });
      expect(page).toMatchObject({ _id: 'newpage000000000', name: 'Map' });
    });

    it('uses the first sort slot for an entry without pages', async () => {
      const empty = { _id: JOURNAL_ID, name: 'Empty', pages: [] };
      const { client, emit } = buildClient({ journal: empty, server: structuredClone(empty) });
      await client.addJournalPage(JOURNAL_ID, { name: 'Loot', content: 'x' });

      expect(requests(emit).find((r) => r.action === 'create')?.operation.data?.[0]?.sort).toBe(
        100000,
      );
    });

    it('adds the created page to the cached journal', async () => {
      const { client } = buildClient();
      await client.addJournalPage(JOURNAL_ID, { name: 'Loot', content: 'x' });
      expect(client.getJournal(JOURNAL_ID)?.pages).toHaveLength(3);
    });

    it('fails clearly when the server has no such journal', async () => {
      const { client, emit } = buildClient({ server: null });
      await expect(
        client.addJournalPage(JOURNAL_ID, { name: 'Loot', content: 'x' }),
      ).rejects.toThrow(`Journal not found: ${JOURNAL_ID}`);
      expect(requests(emit).some((r) => r.action === 'create')).toBe(false);
    });

    it('rejects a missing name before emitting', async () => {
      const { client, emit } = buildClient();
      await expect(client.addJournalPage(JOURNAL_ID, { name: '', content: 'x' })).rejects.toThrow(
        /name/,
      );
      expect(emit).not.toHaveBeenCalled();
    });

    it('rejects writes when FOUNDRY_WRITE_ENABLED is false', async () => {
      const { client } = buildClient({ writeEnabled: false });
      await expect(
        client.addJournalPage(JOURNAL_ID, { name: 'Loot', content: 'x' }),
      ).rejects.toThrow(/FOUNDRY_WRITE_ENABLED/);
    });
  });

  describe('overwrite detection', () => {
    const appendOurs = async (client: FoundryClient) =>
      client.appendJournalPage(JOURNAL_ID, PAGE_ID, '<p>Ours</p>');

    it('reports a later save by another user that dropped the appended text', async () => {
      const { client, internals } = buildClient();
      const onConflict = vi.fn();
      client.onJournalConflict = onConflict;
      await appendOurs(client);

      internals.onDocumentBroadcast(pageBroadcast(ALICE_ID, ORIGINAL));

      const [conflict] = client.getRecentJournalConflicts();
      expect(conflict).toMatchObject({
        journalId: JOURNAL_ID,
        pageId: PAGE_ID,
        journalName: 'Session 11 Recap',
        pageName: 'Summary',
        reason: 'overwritten-by-Alice',
        savedBy: 'Alice',
      });
      expect(onConflict).toHaveBeenCalledWith(conflict);
      // The lost version — ours — is kept.
      expect(readFileSync(conflict?.historyPath ?? '', 'utf8')).toBe(`${ORIGINAL}<p>Ours</p>`);
      const warnings = client.drainJournalWarnings();
      expect(warnings).toEqual([expect.stringMatching(/Journal overwrite detected.*Alice/)]);
      expect(client.drainJournalWarnings()).toEqual([]);
    });

    it('stays quiet when the later save kept the appended text', async () => {
      const { client, internals } = buildClient();
      await appendOurs(client);

      internals.onDocumentBroadcast(
        pageBroadcast(ALICE_ID, `${ORIGINAL}<div>Ours</div><p>Alice adds</p>`),
      );
      // The watch ended with that save: a later loss is no longer ours to flag.
      internals.onDocumentBroadcast(pageBroadcast(ALICE_ID, ORIGINAL));

      expect(client.getRecentJournalConflicts()).toEqual([]);
      expect(client.drainJournalWarnings()).toEqual([]);
    });

    it("ignores the connector's own sessions", async () => {
      const { client, internals } = buildClient();
      await appendOurs(client);

      internals.onDocumentBroadcast(pageBroadcast(CONNECTOR_ID, ORIGINAL));
      internals.onDocumentBroadcast(pageBroadcast(HEADLESS_ID, ORIGINAL));

      expect(client.getRecentJournalConflicts()).toEqual([]);
    });

    it('reports an editor autosave that reverted the write, even with nothing typed', async () => {
      const { client, internals } = buildClient();
      await appendOurs(client);

      // The editor session still holds the pre-write body and saves it back.
      internals.onEditorAutosave(autosaveUuid, ORIGINAL);

      expect(client.getRecentJournalConflicts()).toEqual([
        expect.objectContaining({ reason: 'overwritten-by-editor-autosave', savedBy: null }),
      ]);
    });

    it('re-reads the entry after an editor autosave', async () => {
      const { client, emit, internals, server } = buildClient();
      setServerBody(server, '<p>Typed</p>');

      internals.onEditorAutosave(autosaveUuid, '<p>Typed</p>');
      await vi.waitFor(() => expect(cachedPage(client)?.text?.content).toBe('<p>Typed</p>'));
      expect(requests(emit)[0]?.action).toBe('get');
    });

    it('ignores autosaves of anything but a journal page body', async () => {
      const { client, emit, internals } = buildClient();
      internals.onEditorAutosave(`Actor.${JOURNAL_ID}#system.details.biography`, '<p>x</p>');
      expect(emit).not.toHaveBeenCalled();
      expect(client.getRecentJournalConflicts()).toEqual([]);
    });

    it('reports a change that landed while the write was in flight', async () => {
      const ctx: { internals?: { onDocumentBroadcast: (p: unknown) => void } } = {};
      const theirs = `${ORIGINAL}<p>Alice, just before us</p>`;
      const { client, internals } = buildClient({
        duringUpdate: () => ctx.internals?.onDocumentBroadcast(pageBroadcast(ALICE_ID, theirs)),
      });
      ctx.internals = internals;

      await appendOurs(client);

      const [conflict] = client.getRecentJournalConflicts();
      expect(conflict).toMatchObject({ reason: 'overwritten-by-connector', savedBy: 'Alice' });
      // Their version is the one that was overwritten.
      expect(readFileSync(conflict?.historyPath ?? '', 'utf8')).toBe(theirs);
      expect(client.drainJournalWarnings()).toEqual([
        expect.stringMatching(/while the connector was writing the page/),
      ]);
    });

    it('does not blame a rename for a body change that crossed it', async () => {
      const ctx: { internals?: { onDocumentBroadcast: (p: unknown) => void } } = {};
      const theirs = `${ORIGINAL}<p>Alice</p>`;
      const { client, internals } = buildClient({
        duringUpdate: () => ctx.internals?.onDocumentBroadcast(pageBroadcast(ALICE_ID, theirs)),
      });
      ctx.internals = internals;

      const written = await client.updateJournalPage(JOURNAL_ID, PAGE_ID, { name: 'Recap' });

      expect(client.getRecentJournalConflicts()).toEqual([]);
      // The returned version is that of the body now stored: Alice's.
      expect(written.version).toBe(versionOf(theirs));
    });

    it('ignores in-flight changes to other pages', async () => {
      const ctx: { internals?: { onDocumentBroadcast: (p: unknown) => void } } = {};
      const { client, internals } = buildClient({
        duringUpdate: () =>
          ctx.internals?.onDocumentBroadcast(pageBroadcast(ALICE_ID, '<p>x</p>', SECOND_PAGE)),
      });
      ctx.internals = internals;

      await appendOurs(client);
      expect(client.getRecentJournalConflicts()).toEqual([]);
    });
  });

  describe('whisperJournalConflict', () => {
    const conflict = {
      at: 0,
      journalId: JOURNAL_ID,
      pageId: PAGE_ID,
      journalName: 'Session <11>',
      pageName: 'Summary',
      reason: 'overwritten-by-Alice',
      savedBy: 'Alice',
      historyPath: 'C:\\state\\journal-history\\x.html',
    };

    it('whispers the GMs, leaving out the connector accounts', async () => {
      const { client, emit } = buildClient();
      const recipients = await client.whisperJournalConflict(conflict);

      expect(recipients).toEqual([GM_ID]);
      const message = requests(emit).find((r) => r.type === 'ChatMessage');
      expect(message?.operation.data?.[0]).toMatchObject({
        whisper: [GM_ID],
        author: CONNECTOR_ID,
      });
      const content = String(message?.operation.data?.[0]?.content);
      expect(content).toContain('journal overwrite detected');
      expect(content).toContain('Session &lt;11&gt;');
      expect(content).toContain('Alice');
      expect(content).toContain('C:\\state\\journal-history\\x.html');
    });

    it('writes in French when the server language is French', async () => {
      const { client, emit } = buildClient({ language: 'fr.core' });
      await client.whisperJournalConflict({
        ...conflict,
        savedBy: null,
        reason: 'overwritten-by-editor-autosave',
      });

      const content = String(
        requests(emit).find((r) => r.type === 'ChatMessage')?.operation.data?.[0]?.content,
      );
      expect(content).toContain('écrasement de journal détecté');
      expect(content).toContain('un éditeur ouvert (sauvegarde automatique)');
    });

    it('sends nothing when no other GM exists', async () => {
      const { client, emit, internals } = buildClient();
      internals.worldData.users = [{ _id: CONNECTOR_ID, name: 'mcp-api', role: 4 }];
      expect(await client.whisperJournalConflict(conflict)).toEqual([]);
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('updateJournalEntry', () => {
    it('sends a top-level JournalEntry update with name and folder', async () => {
      const { client, emit } = buildClient();
      await client.updateJournalEntry(JOURNAL_ID, { name: 'Session 12', folder: VALID_FOLDER_ID });

      const [, body] = emit.mock.calls[0];
      expect(body).toMatchObject({
        type: 'JournalEntry',
        action: 'update',
        operation: {
          updates: [{ _id: JOURNAL_ID, name: 'Session 12', folder: VALID_FOLDER_ID }],
          diff: true,
        },
      });
      expect(body.operation.parentUuid).toBeUndefined();
    });

    it.each([
      ['observer', 2],
      ['owner', 3],
      ['gm-only', 0],
    ] as const)('maps visibility %s to ownership.default %i', async (visibility, level) => {
      const { client, emit } = buildClient();
      await client.updateJournalEntry(JOURNAL_ID, { visibility });

      const [, body] = emit.mock.calls[0];
      expect(body.operation.updates).toEqual([{ _id: JOURNAL_ID, ownership: { default: level } }]);
    });

    it('updates the cached entry', async () => {
      const { client } = buildClient();
      await client.updateJournalEntry(JOURNAL_ID, { name: 'Session 12' });

      expect(client.getJournal(JOURNAL_ID)?.name).toBe('Session 12');
      expect(client.getJournal(JOURNAL_ID)?.pages).toHaveLength(2);
    });

    it('rejects an update that changes nothing', async () => {
      const { client, emit } = buildClient();
      await expect(client.updateJournalEntry(JOURNAL_ID, {})).rejects.toThrow(
        /name, folder or visibility/,
      );
      expect(emit).not.toHaveBeenCalled();
    });

    it('rejects an unknown visibility before emitting', async () => {
      const { client } = buildClient();
      await expect(
        client.updateJournalEntry(JOURNAL_ID, {
          visibility: 'everyone' as unknown as 'observer',
        }),
      ).rejects.toThrow(/Invalid visibility/);
    });

    it('rejects a malformed folder id before emitting', async () => {
      const { client } = buildClient();
      await expect(client.updateJournalEntry(JOURNAL_ID, { folder: 'short' })).rejects.toThrow(
        /Invalid folder/,
      );
    });

    it('rejects a malformed journalId before emitting', async () => {
      const { client } = buildClient();
      await expect(client.updateJournalEntry('short', { name: 'x' })).rejects.toThrow(
        /Invalid journalId/,
      );
    });

    it('rejects writes when FOUNDRY_WRITE_ENABLED is false', async () => {
      const { client } = buildClient({ writeEnabled: false });
      await expect(client.updateJournalEntry(JOURNAL_ID, { name: 'x' })).rejects.toThrow(
        /FOUNDRY_WRITE_ENABLED/,
      );
    });
  });
});
