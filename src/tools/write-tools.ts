/**
 * @fileoverview Which tools change game state.
 *
 * Their calls are serialised through one queue (see {@link FoundryCore}):
 * clients (and, in shared mode, several clients) may fire tool calls in
 * parallel, and a read-modify-write such as a journal page append must not
 * interleave with another write. Reads keep running in parallel.
 *
 * Every `*MutationTools` definition group is covered by a unit test; tools
 * that mutate from a mixed group are listed by hand below.
 */

export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  // actorMutationTools
  'update_actor_attributes',
  'create_world_actor',
  'create_full_actor',
  'delete_world_actor',
  // itemMutationTools
  'create_actor_item',
  'update_actor_item',
  'delete_actor_item',
  // sceneMutationTools
  'create_scene',
  'switch_scene',
  'delete_scene',
  'set_scene_lighting',
  'reset_fog',
  'set_scene_weather',
  // wallMutationTools (list_walls is a read)
  'create_wall',
  'delete_wall',
  'set_door_state',
  // tileMutationTools
  'create_tile',
  'delete_tile',
  // placeableMutationTools
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
  // combatMutationTools
  'next_turn',
  'end_combat',
  'set_initiative',
  'start_combat',
  // tokenMutationTools
  'move_token',
  'apply_status_effect',
  'spawn_token',
  'delete_token',
  'move_token_pathfind',
  'move_tokens',
  'update_token_vision',
  // chatMutationTools
  'send_chat_message',
  // journalMutationTools
  'create_journal_entry',
  'update_journal_page',
  'add_journal_page',
  'update_journal_entry',
  'delete_journal_entry',
  // worldDocumentMutationTools
  'create_folder',
  'create_macro',
  'delete_macro',
  'create_playlist',
  'set_playlist_state',
  'delete_playlist',
  'set_document_ownership',
  // mixed groups
  'create_actor_effect',
  'update_actor_effect',
  'delete_actor_effect',
  'create_region',
  'delete_region',
  'create_roll_table',
  'delete_roll_table',
  'set_world_setting',
  'set_user_role',
  'roll_and_post',
  'import_compendium_actor',
  'set_target',
  'ping_canvas',
  'set_pause',
  'upload_asset',
]);

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}
