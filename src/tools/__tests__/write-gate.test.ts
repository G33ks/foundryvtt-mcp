/**
 * @fileoverview Every tool that changes the world is refused while writes are
 * disabled (`FOUNDRY_WRITE_ENABLED` unset), whatever its transport: nothing
 * reaches FoundryVTT, neither a `modifyDocument` over the socket nor a command
 * to the companion module.
 *
 * The world in the cache holds one document of each kind the tools target,
 * so a call reaches the write check instead of stopping at "not found".
 */

import { describe, expect, it, vi } from 'vitest';
import type { DiagnosticsClient } from '../../diagnostics/client.js';
import type { DiagnosticSystem } from '../../diagnostics/diagnostic-system.js';
import { FoundryClient } from '../../foundry/client.js';
import type { ModuleBridge } from '../../foundry/module-bridge.js';
import { getAllTools } from '../definitions.js';
import { routeToolRequest } from '../router.js';
import { toolDependency } from '../tool-dependencies.js';
import { WRITE_TOOLS } from '../write-tools.js';

const SCENE = 'ssssssssssssssss';
const TOKEN = 'tttttttttttttttt';
const ACTOR = 'aaaaaaaaaaaaaaaa';
const ITEM = 'iiiiiiiiiiiiiiii';
const EFFECT = 'eeeeeeeeeeeeeeee';
const WALL = 'wwwwwwwwwwwwwwww';
const PLACEABLE = 'pppppppppppppppp';
const COMBAT = 'cccccccccccccccc';
const COMBATANT = 'kkkkkkkkkkkkkkkk';
const JOURNAL = 'jjjjjjjjjjjjjjjj';
const PAGE = 'gggggggggggggggg';
const MACRO = 'mmmmmmmmmmmmmmmm';
const PLAYLIST = 'llllllllllllllll';
const TABLE = 'rrrrrrrrrrrrrrrr';
const USER = 'uuuuuuuuuuuuuuuu';

const DISABLED = /Write operations are disabled/;

function seededClient() {
  const client = new FoundryClient({ baseUrl: 'http://localhost:30000', writeEnabled: false });
  const emit = vi.fn();
  const placeable = { _id: PLACEABLE, x: 0, y: 0 };
  const internals = client as unknown as {
    socket: { connected: boolean; emit: typeof emit };
    worldData: Record<string, unknown>;
  };
  internals.socket = { connected: true, emit };
  internals.worldData = {
    userId: USER,
    actors: [
      {
        _id: ACTOR,
        name: 'Hero',
        type: 'character',
        system: {},
        items: [{ _id: ITEM, name: 'Rope', type: 'loot', system: {} }],
        effects: [{ _id: EFFECT, name: 'Blessed', changes: [] }],
      },
    ],
    scenes: [
      {
        _id: SCENE,
        name: 'Hall',
        active: true,
        width: 1000,
        height: 1000,
        grid: { size: 100 },
        tokens: [{ _id: TOKEN, name: 'Hero', actorId: ACTOR, actorLink: true, x: 0, y: 0 }],
        walls: [{ _id: WALL, c: [0, 0, 100, 0], door: 1, ds: 0 }],
        lights: [placeable],
        sounds: [placeable],
        notes: [placeable],
        drawings: [placeable],
        templates: [placeable],
        regions: [placeable],
        tiles: [placeable],
      },
    ],
    items: [],
    journal: [{ _id: JOURNAL, name: 'Notes', pages: [{ _id: PAGE, name: 'Page', type: 'text' }] }],
    messages: [],
    combats: [
      {
        _id: COMBAT,
        scene: SCENE,
        active: true,
        round: 1,
        turn: 0,
        combatants: [{ _id: COMBATANT, tokenId: TOKEN, actorId: ACTOR, sceneId: SCENE }],
      },
    ],
    users: [{ _id: USER, name: 'Assistant', role: 3 }],
    folders: [],
    macros: [{ _id: MACRO, name: 'Macro' }],
    playlists: [{ _id: PLAYLIST, name: 'Music', sounds: [] }],
    tables: [{ _id: TABLE, name: 'Table', results: [] }],
    settings: [],
  };
  return { client, emit };
}

/** Arguments that pass each tool's own validation, so the write check decides. */
const ARGS: Record<string, Record<string, unknown>> = {
  update_actor_attributes: { actorId: ACTOR, patch: { 'details.notes': 'x' } },
  create_world_actor: { name: 'New', type: 'character' },
  create_full_actor: { name: 'New', type: 'character' },
  delete_world_actor: { actorId: ACTOR },
  create_actor_item: {
    actorId: ACTOR,
    source: { type: 'inline', item: { name: 'Rope', type: 'loot', system: {} } },
  },
  update_actor_item: { actorId: ACTOR, itemId: ITEM, patch: { 'system.quantity': 2 } },
  delete_actor_item: { actorId: ACTOR, itemId: ITEM },
  create_actor_effect: { actorId: ACTOR, name: 'Blessed' },
  update_actor_effect: { actorId: ACTOR, effectId: EFFECT, name: 'Cursed' },
  delete_actor_effect: { actorId: ACTOR, effectId: EFFECT },
  apply_status_effect: { tokenId: TOKEN, sceneId: SCENE, statusId: 'prone', active: true },
  create_scene: { name: 'New scene', backgroundSrc: 'maps/a.png', width: 1000, height: 1000 },
  switch_scene: { sceneId: SCENE },
  delete_scene: { sceneId: SCENE },
  set_scene_lighting: { sceneId: SCENE, darkness: 0.5 },
  set_scene_weather: { sceneId: SCENE, weather: 'rain' },
  reset_fog: { sceneId: SCENE },
  create_wall: { sceneId: SCENE, c: [0, 0, 100, 100] },
  delete_wall: { sceneId: SCENE, wallId: WALL },
  set_door_state: { sceneId: SCENE, wallId: WALL, state: 1 },
  create_tile: { sceneId: SCENE, src: 'tiles/a.png', x: 0, y: 0, width: 100, height: 100 },
  delete_tile: { sceneId: SCENE, tileId: PLACEABLE },
  create_light: { sceneId: SCENE, x: 0, y: 0 },
  update_light: { sceneId: SCENE, lightId: PLACEABLE, dim: 10 },
  delete_light: { sceneId: SCENE, lightId: PLACEABLE },
  create_sound: { sceneId: SCENE, path: 'sounds/a.ogg', x: 0, y: 0, radius: 10 },
  delete_sound: { sceneId: SCENE, soundId: PLACEABLE },
  create_note: { sceneId: SCENE, x: 0, y: 0, text: 'Note' },
  delete_note: { sceneId: SCENE, noteId: PLACEABLE },
  create_drawing: { sceneId: SCENE, shape: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
  delete_drawing: { sceneId: SCENE, drawingId: PLACEABLE },
  create_template: { sceneId: SCENE, t: 'circle', x: 0, y: 0, distance: 10 },
  delete_template: { sceneId: SCENE, templateId: PLACEABLE },
  create_region: {
    sceneId: SCENE,
    name: 'Zone',
    shapes: [{ type: 'rectangle', x: 0, y: 0, width: 100, height: 100 }],
  },
  delete_region: { sceneId: SCENE, regionId: PLACEABLE },
  start_combat: { sceneId: SCENE },
  next_turn: { combatId: COMBAT },
  set_initiative: { combatId: COMBAT, combatantId: COMBATANT, initiative: 10 },
  end_combat: { combatId: COMBAT },
  spawn_token: { sceneId: SCENE, actorId: ACTOR, x: 0, y: 0 },
  delete_token: { sceneId: SCENE, tokenId: TOKEN },
  move_token: { sceneId: SCENE, tokenId: TOKEN, x: 100, y: 100 },
  move_token_pathfind: { sceneId: SCENE, tokenId: TOKEN, x: 100, y: 100 },
  move_tokens: { sceneId: SCENE, moves: [{ tokenId: TOKEN, x: 100, y: 100 }] },
  update_token_vision: { sceneId: SCENE, tokenId: TOKEN, sightRange: 10 },
  send_chat_message: { content: 'Hello' },
  create_journal_entry: { name: 'Lore', pages: [{ name: 'Page', content: 'Text' }] },
  update_journal_page: { journalId: JOURNAL, pageId: PAGE, mode: 'append', content: 'More' },
  add_journal_page: { journalId: JOURNAL, name: 'Page 2', content: 'Text' },
  update_journal_entry: { journalId: JOURNAL, name: 'Renamed' },
  delete_journal_entry: { journalId: JOURNAL },
  create_folder: { name: 'Folder', type: 'Actor' },
  create_macro: { name: 'Macro', type: 'chat', command: 'Hello' },
  delete_macro: { macroId: MACRO },
  create_playlist: { name: 'Music' },
  set_playlist_state: { playlistId: PLAYLIST, playing: true },
  delete_playlist: { playlistId: PLAYLIST },
  set_document_ownership: {
    documentType: 'Actor',
    documentId: ACTOR,
    entries: [{ target: USER, level: 'observer' }],
  },
  create_roll_table: { name: 'Table', results: ['A', 'B'] },
  delete_roll_table: { tableId: TABLE },
  set_world_setting: { key: 'mymodule.setting', value: 1 },
  set_user_role: { userId: USER, role: 'player' },
  import_compendium_actor: { compendiumId: 'world.actors', actorId: ACTOR },
  roll_and_post: { formula: '1d20' },
  set_target: { tokenIds: [TOKEN] },
  ping_canvas: { x: 0, y: 0 },
  set_pause: { paused: true },
  upload_asset: { targetDir: 'maps', filename: 'map.png', contentBase64: 'AAAA' },
};

/** Tools classified as writing: the write queue, and every write over the socket. */
const writingTools = [...WRITE_TOOLS].sort();

describe('write gate', () => {
  it('has arguments for every tool classified as writing', () => {
    const names = new Set(getAllTools().map((tool) => tool.name));
    for (const name of writingTools) {
      expect(names.has(name), name).toBe(true);
      expect(ARGS[name], name).toBeDefined();
      expect(toolDependency(name), name).toBeDefined();
    }
  });

  it.each(writingTools)('refuses %s while writes are disabled, sending nothing', async (name) => {
    const { client, emit } = seededClient();
    const send = vi.fn(async () => ({}));
    const bridge = {
      send,
      supports: () => true,
      isConnected: () => true,
    } as unknown as ModuleBridge;

    await expect(
      routeToolRequest(
        name,
        ARGS[name] ?? {},
        client,
        {} as DiagnosticsClient,
        {} as DiagnosticSystem,
        bridge,
      ),
    ).rejects.toThrow(DISABLED);
    expect(send).not.toHaveBeenCalled();
    const writes = emit.mock.calls.filter(
      ([event]) => event === 'modifyDocument' || event === 'modifyDocumentBatch',
    );
    expect(writes).toEqual([]);
  });
});
