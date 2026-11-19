/**
 * @fileoverview The note of a deletion that only a re-read confirmed
 * (`FoundryClient.deleteScene` and the like) reaches each deletion tool's
 * response; a deletion acknowledged in time keeps its response unchanged.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { handleDeleteWorldActor } from '../actor-mutations.js';
import { handleEndCombat } from '../combat-mutations.js';
import { handleDeleteJournalEntry } from '../journal-mutations.js';
import { handleDeleteRollTable } from '../roll-tables.js';
import { handleDeleteScene } from '../scene-mutations.js';
import { handleDeleteMacro, handleDeletePlaylist } from '../world-documents.js';

vi.mock('../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const NOTE =
  'FoundryVTT deleted the document but its acknowledgement timed out; verified by re-reading it.';
const ID = 'docAAAAAAAAAAAAA';

const TOOLS: Array<{
  tool: string;
  method: keyof FoundryClient;
  run: (client: FoundryClient) => Promise<{ content: Array<{ text: string }> }>;
}> = [
  {
    tool: 'delete_scene',
    method: 'deleteScene',
    run: (c) => handleDeleteScene({ sceneId: ID }, c),
  },
  {
    tool: 'delete_world_actor',
    method: 'deleteWorldActor',
    run: (c) => handleDeleteWorldActor({ actorId: ID }, c),
  },
  { tool: 'end_combat', method: 'endCombat', run: (c) => handleEndCombat({}, c) },
  {
    tool: 'delete_journal_entry',
    method: 'deleteJournalEntry',
    run: (c) => handleDeleteJournalEntry({ journalId: ID }, c),
  },
  {
    tool: 'delete_macro',
    method: 'deleteMacro',
    run: (c) => handleDeleteMacro({ macroId: ID }, c),
  },
  {
    tool: 'delete_roll_table',
    method: 'deleteRollTable',
    run: (c) => handleDeleteRollTable({ tableId: ID }, c),
  },
  {
    tool: 'delete_playlist',
    method: 'deletePlaylist',
    run: (c) => handleDeletePlaylist({ playlistId: ID }, c),
  },
];

function mockClient(method: keyof FoundryClient, note: string | undefined) {
  return {
    getScenes: vi.fn(() => []),
    getJournal: vi.fn(() => undefined),
    getCombatState: vi.fn(() => ({ _id: ID })),
    drainJournalWarnings: vi.fn(() => []),
    [method]: vi.fn().mockResolvedValue(note),
  } as unknown as FoundryClient;
}

describe.each(TOOLS)('$tool response', ({ method, run }) => {
  it('ends with the note when only a re-read confirmed the deletion', async () => {
    const response = await run(mockClient(method, NOTE));
    expect(response.content[0]?.text.endsWith(`\n\n⚠️ ${NOTE}`)).toBe(true);
  });

  it('has no note when the deletion was acknowledged in time', async () => {
    const response = await run(mockClient(method, undefined));
    expect(response.content[0]?.text).not.toContain('⚠️');
  });
});
