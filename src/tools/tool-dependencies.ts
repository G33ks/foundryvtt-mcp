/**
 * @fileoverview What each tool and resource needs from FoundryVTT.
 *
 * Decides which calls wait for a connection being restored (see
 * {@link FoundryCore}): only those that read the Socket.IO cache or go
 * through the socket wait for it — a cache nobody keeps live must not answer
 * during an outage. The others never touch the socket and must not wait for it.
 *
 * - `socket`: the cached world or a Socket.IO request (every document write).
 * - `socket+bridge`: the socket and the companion module (see {@link needsBridge}).
 * - `bridge`: the companion module only.
 * - `rest`: the REST API module (`FOUNDRY_API_KEY`) only.
 * - `rest-or-local`: the REST API module when a key is set, a local computation otherwise.
 * - `local`: no FoundryVTT at all (a computation, or files under `FOUNDRY_DATA_PATH`).
 * - `health`: reports the connections themselves, so waits for none.
 *
 * A unit test checks that every tool and resource is classified.
 */

import { isRecord } from '../utils/guards.js';

export type ToolDependency =
  | 'socket'
  | 'socket+bridge'
  | 'bridge'
  | 'rest'
  | 'rest-or-local'
  | 'local'
  | 'health';

const SOCKET_TOOLS = [
  // Reads from the cached world (search_actors, get_actor_details,
  // search_items, get_scene_info and get_world_summary ask the REST API
  // module first when a key is set, then fall back to the cache).
  'search_actors',
  'get_actor_details',
  'get_actor_inventory',
  'search_items',
  'get_scene_info',
  'list_tiles',
  'list_walls',
  'list_tokens',
  'list_lights',
  'list_sounds',
  'list_notes',
  'list_drawings',
  'list_templates',
  'list_regions',
  'find_open_cells',
  'list_actor_effects',
  'get_combat_state',
  'get_chat_messages',
  'get_users',
  'search_journals',
  'search_world',
  'get_world_summary',
  'list_roll_tables',
  'roll_table',
  'list_folders',
  'list_macros',
  'list_playlists',
  'get_world_setting',
  // The event log is fed by socket broadcasts: during an outage it would
  // answer "nothing new", which is not true.
  'watch_events',
  // The cache, plus compendium packs through the module when it is there.
  'lookup_rule',
  // Requests to the server over the socket.
  'get_journal',
  'refresh_world_data',
  // Writes (Socket.IO modifyDocument).
  'update_actor_attributes',
  'create_world_actor',
  'create_full_actor',
  'delete_world_actor',
  'update_actor_item',
  'delete_actor_item',
  'create_scene',
  'switch_scene',
  'delete_scene',
  'set_scene_lighting',
  'reset_fog',
  'set_scene_weather',
  'create_wall',
  'delete_wall',
  'set_door_state',
  'create_tile',
  'delete_tile',
  'create_light',
  'update_light',
  'delete_light',
  'create_sound',
  'delete_sound',
  'create_note',
  'delete_note',
  'create_drawing',
  'delete_drawing',
  'create_template',
  'delete_template',
  'create_region',
  'delete_region',
  'next_turn',
  'end_combat',
  'set_initiative',
  'start_combat',
  'move_token',
  'apply_status_effect',
  'spawn_token',
  'delete_token',
  'move_token_pathfind',
  'move_tokens',
  'update_token_vision',
  'send_chat_message',
  'create_journal_entry',
  'update_journal_page',
  'add_journal_page',
  'update_journal_entry',
  'delete_journal_entry',
  'create_folder',
  'create_macro',
  'delete_macro',
  'create_playlist',
  'set_playlist_state',
  'delete_playlist',
  'set_document_ownership',
  'create_actor_effect',
  'update_actor_effect',
  'delete_actor_effect',
  'create_roll_table',
  'delete_roll_table',
  'set_world_setting',
  'set_user_role',
] as const;

const TOOL_DEPENDENCIES: ReadonlyMap<string, ToolDependency> = new Map<string, ToolDependency>([
  ...SOCKET_TOOLS.map((name): [string, ToolDependency] => [name, 'socket']),
  // Reads a compendium document through the module, then writes over the socket.
  ['import_compendium_actor', 'socket+bridge'],
  // The module only for a compendium source; see needsBridge.
  ['create_actor_item', 'socket+bridge'],
  ['capture_scene', 'bridge'],
  ['get_document_schema', 'bridge'],
  ['search_compendium_content', 'bridge'],
  ['get_targets', 'bridge'],
  ['roll_and_post', 'bridge'],
  ['set_target', 'bridge'],
  ['ping_canvas', 'bridge'],
  ['set_pause', 'bridge'],
  ['upload_asset', 'bridge'],
  ['search_compendium', 'rest'],
  ['get_recent_logs', 'rest'],
  ['search_logs', 'rest'],
  ['get_system_health', 'rest'],
  ['diagnose_errors', 'rest'],
  ['roll_dice', 'rest-or-local'],
  ['generate_npc', 'local'],
  ['generate_loot', 'local'],
  ['list_scene_assets', 'local'],
  ['get_health_status', 'health'],
]);

/** Every `foundry://` resource reads the cache, except the REST diagnostics. */
const RESOURCE_DEPENDENCIES: ReadonlyMap<string, ToolDependency> = new Map<string, ToolDependency>([
  ['foundry://actors', 'socket'],
  ['foundry://items', 'socket'],
  ['foundry://scenes', 'socket'],
  ['foundry://scenes/current', 'socket'],
  ['foundry://journals', 'socket'],
  ['foundry://users', 'socket'],
  ['foundry://combat', 'socket'],
  ['foundry://world/settings', 'socket'],
  ['foundry://system/diagnostics', 'rest'],
]);

/** The tool's dependency; `undefined` for a name nobody classified. */
export function toolDependency(name: string): ToolDependency | undefined {
  return TOOL_DEPENDENCIES.get(name);
}

/** The resource's dependency; `undefined` for a URI nobody classified. */
export function resourceDependency(uri: string): ToolDependency | undefined {
  return RESOURCE_DEPENDENCIES.get(uri);
}

/**
 * True when the dependency involves the socket. An unclassified name counts
 * as one: waiting is the safe default for something that may read the cache.
 */
export function waitsForSocket(dependency: ToolDependency | undefined): boolean {
  return dependency === undefined || dependency === 'socket' || dependency === 'socket+bridge';
}

/**
 * True when this call goes through the companion module: every `bridge`
 * tool, `import_compendium_actor`, and `create_actor_item` from a
 * compendium source (an inline item needs only the socket).
 */
export function needsBridge(name: string, args: Record<string, unknown>): boolean {
  const dependency = toolDependency(name);
  if (dependency === 'bridge') {
    return true;
  }
  if (dependency !== 'socket+bridge') {
    return false;
  }
  if (name === 'create_actor_item') {
    return isRecord(args.source) && args.source.type === 'compendium';
  }
  return true;
}
