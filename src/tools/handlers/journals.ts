/**
 * Journal entry tool handlers
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { journalVersion } from '../../foundry/journal-integrity.js';
import { stripHtml } from '../../utils/sanitize.js';
import { withJournalWarnings, withToolError } from './utils.js';

/** Shown on cache-served journal reads while the snapshot is stale (#217). */
const STALE_JOURNAL_NOTICE =
  '⚠️ **Stale:** this comes from a cached snapshot that stopped following live changes when ' +
  'the connection dropped. Use `raw: true` to read the entry from the server, or ' +
  '`refresh_world_data` to resync everything.';

export async function handleSearchJournals(
  args: { query: string; limit?: number },
  foundryClient: FoundryClient,
) {
  return withToolError('search journals', async () => {
    const results = foundryClient.searchJournals(args.query);
    const limit = args.limit || 10;
    const limited = results.slice(0, limit);

    if (limited.length === 0) {
      return withJournalWarnings(foundryClient, {
        content: [
          {
            type: 'text',
            text: `No journals found matching "${args.query}".`,
          },
        ],
      });
    }

    const formatted = limited
      .map((j) => {
        const pageCount = j.pages?.length || 0;
        return `- **${j.name}** (${pageCount} page${pageCount !== 1 ? 's' : ''}) — ID: ${j._id}`;
      })
      .join('\n');

    return withJournalWarnings(foundryClient, {
      content: [
        {
          type: 'text',
          text: `**Journal Search** — "${args.query}" (${results.length} results)\n\n${formatted}`,
        },
      ],
    });
  });
}

export async function handleGetJournal(
  args: { journalId: string; raw?: boolean },
  foundryClient: FoundryClient,
) {
  return withToolError('get journal', async () => {
    const raw = args.raw === true;
    // raw reads the entry from the server: its HTML and version tokens are
    // what update_journal_page will be checked against.
    const journal = raw
      ? await foundryClient.fetchJournalEntry(args.journalId)
      : foundryClient.getJournal(args.journalId);

    if (!journal) {
      throw new McpError(ErrorCode.InvalidParams, `Journal not found: ${args.journalId}`);
    }

    const pages =
      journal.pages
        ?.map((p) => {
          const heading = `### ${p.name} — ID: ${p._id}`;
          // raw returns the stored HTML untouched so a caller can rewrite the
          // page with update_journal_page without losing markup or text.
          if (raw) {
            const body = p.text?.content ?? '';
            return `${heading}\nversion: ${journalVersion(body)}\n${body}`;
          }
          const content = stripHtml(p.text?.content || '')
            .trim()
            .slice(0, 500);
          return `${heading}\n${content}${content.length >= 500 ? '...' : ''}`;
        })
        .join('\n\n') || 'No pages.';

    const stale = !raw && foundryClient.isWorldDataStale() ? `${STALE_JOURNAL_NOTICE}\n\n` : '';
    return withJournalWarnings(foundryClient, {
      content: [
        {
          type: 'text',
          text: `${stale}**Journal: ${journal.name}**\nID: ${journal._id}\n\n${pages}`,
        },
      ],
    });
  });
}
