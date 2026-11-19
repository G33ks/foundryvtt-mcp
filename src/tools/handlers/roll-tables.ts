/**
 * @fileoverview Roll table tool handlers (read + local weighted draw)
 *
 * Neither tool mutates FoundryVTT — `roll_table` draws locally against the
 * cached table data (see `FoundryClient#rollOnTable`) and does not require
 * FOUNDRY_WRITE_ENABLED.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { deletionNote, withToolError } from './utils.js';

/**
 * Handles listing the world's roll tables.
 */
export async function handleListRollTables(
  _args: Record<string, unknown>,
  foundryClient: FoundryClient,
) {
  return withToolError('list roll tables', async () => {
    const tables = foundryClient.getRollTables();

    if (tables.length === 0) {
      return { content: [{ type: 'text', text: 'No roll tables found in this world.' }] };
    }

    const formatted = tables
      .map((t) => {
        const results = Array.isArray(t.results) ? t.results.length : 0;
        return `- **${t.name}** (${results} result${results !== 1 ? 's' : ''}) — ID: ${t._id}`;
      })
      .join('\n');

    return {
      content: [{ type: 'text', text: `🎲 **Roll Tables** (${tables.length})\n\n${formatted}` }],
    };
  });
}

/**
 * Handles drawing a result from a roll table.
 */
export async function handleRollTable(args: { tableId: string }, foundryClient: FoundryClient) {
  const { tableId } = args;

  if (!tableId || typeof tableId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'tableId is required and must be a string');
  }

  return withToolError('roll table', async () => {
    const draw = foundryClient.rollOnTable(tableId);

    const text = draw.result?.text ?? draw.result?.name ?? '(unnamed result)';

    return {
      content: [
        {
          type: 'text',
          text: `🎲 **Table Draw: ${draw.table}**
**Roll:** ${draw.roll}
**Result:** ${draw.result ? text : 'No result configured for this roll — the table is incompletely set up.'}`,
        },
      ],
    };
  });
}

/**
 * Handles creating a new RollTable document with text results.
 */
export async function handleCreateRollTable(
  args: {
    name: string;
    results: Array<{ text: string; weight?: number; range?: [number, number] }>;
    description?: string;
    formula?: string;
    replacement?: boolean;
    displayRoll?: boolean;
    folder?: string;
  },
  foundryClient: FoundryClient,
) {
  const { name, results } = args;
  if (!name || typeof name !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'name is required and must be a string');
  }
  if (!Array.isArray(results) || results.length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'results is required and must be a non-empty array',
    );
  }

  return withToolError('create roll table', async () => {
    const created = (await foundryClient.createRollTable(name, results, args)) as
      | { _id?: string }
      | undefined;
    const tableId = created?._id ?? 'unknown';

    return {
      content: [
        {
          type: 'text',
          text: `🎲 **Roll Table Created**\n**ID:** ${tableId}\n**Name:** ${name}\n**Results Count:** ${results.length}`,
        },
      ],
    };
  });
}

/**
 * Handles permanently deleting a RollTable document.
 */
export async function handleDeleteRollTable(
  args: { tableId: string },
  foundryClient: FoundryClient,
) {
  const { tableId } = args;
  if (!tableId || typeof tableId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'tableId is required and must be a string');
  }

  return withToolError('delete roll table', async () => {
    const note = await foundryClient.deleteRollTable(tableId);

    return {
      content: [
        {
          type: 'text',
          text: `🗑️ **Roll Table Deleted**\n**ID:** ${tableId}${deletionNote(note)}`,
        },
      ],
    };
  });
}
