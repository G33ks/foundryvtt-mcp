/**
 * @fileoverview Unit tests for journals handlers — search_journals and get_journal
 */

import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { journalVersion } from '../../../foundry/journal-integrity.js';
import { handleGetJournal, handleSearchJournals } from '../journals.js';

interface MockJournal {
  _id: string;
  name: string;
  pages?: Array<{
    _id: string;
    name: string;
    type: string;
    text?: { content: string; format: number };
  }>;
}

function mockClient(overrides: Record<string, unknown>): FoundryClient {
  return {
    drainJournalWarnings: vi.fn(() => []),
    isWorldDataStale: vi.fn(() => false),
    ...overrides,
  } as unknown as FoundryClient;
}

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? '';
}

function makeJournal(id: string, name: string, pageCount: number): MockJournal {
  return {
    _id: id,
    name,
    pages: Array.from({ length: pageCount }, (_, i) => ({
      _id: `${id}-page-${i}`,
      name: `Page ${i + 1}`,
      type: 'text',
      text: { content: `<p>Page ${i + 1} content for ${name}.</p>`, format: 1 },
    })),
  };
}

describe('handleSearchJournals', () => {
  describe('happy path', () => {
    it('formats matching journals with page count and ID', async () => {
      const journals: MockJournal[] = [
        makeJournal('jrnl-1', 'Adventure Log', 5),
        makeJournal('jrnl-2', 'Lore Compendium', 1),
        makeJournal('jrnl-3', 'Empty Journal', 0),
      ];
      const client = mockClient({ searchJournals: vi.fn((_q: string) => journals) });

      const result = await handleSearchJournals({ query: 'adventure' }, client);
      const text = getText(result);

      expect(text).toContain('Journal Search');
      expect(text).toContain('"adventure"');
      expect(text).toContain('(3 results)');
      expect(text).toContain('**Adventure Log** (5 pages)');
      expect(text).toContain('**Lore Compendium** (1 page)');
      expect(text).toContain('**Empty Journal** (0 pages)');
      expect(text).toContain('ID: jrnl-1');
      expect(text).toContain('ID: jrnl-2');
      expect(client.searchJournals).toHaveBeenCalledWith('adventure');
    });

    it('honors a caller-supplied limit', async () => {
      const journals: MockJournal[] = Array.from({ length: 25 }, (_, i) =>
        makeJournal(`jrnl-${i}`, `Journal ${i}`, 1),
      );
      const client = mockClient({ searchJournals: vi.fn(() => journals) });

      const result = await handleSearchJournals({ query: 'j', limit: 5 }, client);
      const text = getText(result);

      // Total count still reflects the full result set
      expect(text).toContain('(25 results)');
      // But only the first 5 entries are listed
      expect(text).toContain('**Journal 0**');
      expect(text).toContain('**Journal 4**');
      expect(text).not.toContain('**Journal 5**');
    });
  });

  describe('edge cases', () => {
    it('returns "No journals found" placeholder when search returns empty', async () => {
      const client = mockClient({ searchJournals: vi.fn(() => []) });

      const result = await handleSearchJournals({ query: 'xyzzy' }, client);
      const text = getText(result);

      expect(text).toContain('No journals found matching "xyzzy".');
    });
  });
});

describe('handleGetJournal', () => {
  describe('happy path', () => {
    it('returns journal with HTML-stripped page content', async () => {
      const journal: MockJournal = {
        _id: 'jrnl-1',
        name: 'Test Journal',
        pages: [
          {
            _id: 'p-1',
            name: 'Introduction',
            type: 'text',
            text: { content: '<p>Hello <b>world</b>.</p>', format: 1 },
          },
        ],
      };
      const client = mockClient({ getJournal: vi.fn((_id: string) => journal) });

      const result = await handleGetJournal({ journalId: 'jrnl-1' }, client);
      const text = getText(result);

      expect(text).toContain('**Journal: Test Journal**');
      expect(text).toContain('ID: jrnl-1');
      expect(text).toContain('### Introduction');
      expect(text).toContain('Hello world.');
      // HTML tags should have been stripped
      expect(text).not.toContain('<p>');
      expect(text).not.toContain('<b>');
      expect(client.getJournal).toHaveBeenCalledWith('jrnl-1');
    });

    it("shows each page's id next to its name", async () => {
      const journal = makeJournal('jrnl-1', 'Adventure Log', 2);
      const client = mockClient({ getJournal: vi.fn(() => journal) });

      const text = getText(await handleGetJournal({ journalId: 'jrnl-1' }, client));

      expect(text).toContain('### Page 1 — ID: jrnl-1-page-0');
      expect(text).toContain('### Page 2 — ID: jrnl-1-page-1');
    });

    it('falls back to "No pages." when journal has no pages', async () => {
      const journal: MockJournal = { _id: 'jrnl-2', name: 'Empty', pages: [] };
      const client = mockClient({ getJournal: vi.fn(() => journal) });

      const result = await handleGetJournal({ journalId: 'jrnl-2' }, client);
      const text = getText(result);

      expect(text).toContain('**Journal: Empty**');
      expect(text).toContain('No pages.');
    });
  });

  describe('edge cases', () => {
    it('throws McpError when journal not found', async () => {
      const client = mockClient({ getJournal: vi.fn(() => undefined) });

      await expect(handleGetJournal({ journalId: 'missing' }, client)).rejects.toThrow(
        /Journal not found: missing/,
      );
    });

    it('truncates page content longer than 500 chars with ellipsis', async () => {
      const longText = 'a'.repeat(600);
      const journal: MockJournal = {
        _id: 'jrnl-3',
        name: 'Long',
        pages: [
          {
            _id: 'p-1',
            name: 'Big Page',
            type: 'text',
            text: { content: longText, format: 1 },
          },
        ],
      };
      const client = mockClient({ getJournal: vi.fn(() => journal) });

      const result = await handleGetJournal({ journalId: 'jrnl-3' }, client);
      const text = getText(result);

      expect(text).toContain('### Big Page');
      expect(text).toContain('...');
      // The 500-char slice should be present but the full 600-char string should not
      expect(text).not.toContain('a'.repeat(600));
    });
  });

  describe('raw mode', () => {
    const html = `<h2>Loot</h2><p>${'b'.repeat(600)}</p><ul><li>Rope</li></ul>`;
    const journal: MockJournal = {
      _id: 'jrnl-4',
      name: 'Raw',
      pages: [{ _id: 'p-1', name: 'Big Page', type: 'text', text: { content: html, format: 1 } }],
    };

    it('reads the entry from the server and returns full HTML with a version per page', async () => {
      const client = mockClient({
        getJournal: vi.fn(() => undefined),
        fetchJournalEntry: vi.fn(async () => journal),
      });

      const text = getText(await handleGetJournal({ journalId: 'jrnl-4', raw: true }, client));

      expect(client.fetchJournalEntry).toHaveBeenCalledWith('jrnl-4');
      expect(client.getJournal).not.toHaveBeenCalled();
      expect(text).toContain(`### Big Page — ID: p-1\nversion: ${journalVersion(html)}\n${html}`);
    });

    it('does not flag a raw read as stale: it came from the server', async () => {
      const client = mockClient({
        fetchJournalEntry: vi.fn(async () => journal),
        isWorldDataStale: vi.fn(() => true),
      });
      const text = getText(await handleGetJournal({ journalId: 'jrnl-4', raw: true }, client));
      expect(text).not.toContain('Stale');
    });

    it('throws McpError when the server has no such entry', async () => {
      const client = mockClient({ fetchJournalEntry: vi.fn(async () => undefined) });
      await expect(handleGetJournal({ journalId: 'missing', raw: true }, client)).rejects.toThrow(
        /Journal not found: missing/,
      );
    });

    it('keeps the stripped, truncated preview when raw is false', async () => {
      const client = mockClient({ getJournal: vi.fn(() => journal) });

      const text = getText(await handleGetJournal({ journalId: 'jrnl-4', raw: false }, client));

      expect(text).not.toContain('<h2>');
      expect(text).not.toContain('b'.repeat(600));
      expect(text).toContain('...');
    });

    it('returns an empty body for a page without text content', async () => {
      const imageJournal: MockJournal = {
        _id: 'jrnl-5',
        name: 'Maps',
        pages: [{ _id: 'p-1', name: 'Map', type: 'image' }],
      };
      const client = mockClient({ fetchJournalEntry: vi.fn(async () => imageJournal) });

      const text = getText(await handleGetJournal({ journalId: 'jrnl-5', raw: true }, client));

      expect(text).toContain(`### Map — ID: p-1\nversion: ${journalVersion('')}`);
      expect(text).not.toContain('undefined');
    });
  });

  describe('cache staleness and pending warnings', () => {
    const journal = makeJournal('jrnl-6', 'Log', 1);

    it('flags a cache-served read while the snapshot is stale', async () => {
      const client = mockClient({
        getJournal: vi.fn(() => journal),
        isWorldDataStale: vi.fn(() => true),
      });
      const text = getText(await handleGetJournal({ journalId: 'jrnl-6' }, client));
      expect(text.startsWith('⚠️ **Stale:**')).toBe(true);
    });

    it('puts pending overwrite warnings at the top, once', async () => {
      const pending = ['⚠️ **Journal overwrite detected:** one'];
      const client = mockClient({
        getJournal: vi.fn(() => journal),
        drainJournalWarnings: vi.fn(() => pending.splice(0)),
      });
      const first = getText(await handleGetJournal({ journalId: 'jrnl-6' }, client));
      const second = getText(await handleGetJournal({ journalId: 'jrnl-6' }, client));
      expect(first.startsWith('⚠️ **Journal overwrite detected:** one\n\n**Journal: Log**')).toBe(
        true,
      );
      expect(second.startsWith('**Journal: Log**')).toBe(true);
    });

    it('shows pending warnings on search_journals too', async () => {
      const client = mockClient({
        searchJournals: vi.fn(() => []),
        drainJournalWarnings: vi.fn(() => ['⚠️ warning']),
      });
      const text = getText(await handleSearchJournals({ query: 'x' }, client));
      expect(text.startsWith('⚠️ warning\n\nNo journals found')).toBe(true);
    });
  });
});
