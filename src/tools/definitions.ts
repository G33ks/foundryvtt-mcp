/**
 * @fileoverview Tool definitions for FoundryVTT MCP Server
 *
 * This module contains all tool schema definitions organized by category.
 * Tools are separated into logical groups for better maintainability.
 */

/**
 * Shared write-safety clause appended to every mutation tool description.
 *
 * Both halves are enforced in code by `assertWriteable()`
 * (`src/foundry/client.ts`): the `FOUNDRY_WRITE_ENABLED` opt-in (default
 * `false`, see `src/config/index.ts`) and a live authenticated Socket.IO
 * session. Foundry itself enforces the GM/owner permission (ADR-010).
 */
const WRITE_GATE =
  'WRITE: mutates the live world. Requires FOUNDRY_WRITE_ENABLED=true (default false) and an active Socket.IO connection, and is refused otherwise; Foundry additionally enforces GM/owner permission on the document.';

/**
 * Extra clause for destructive tools (data removal that this server cannot undo).
 */
const CONFIRM_FIRST =
  'DESTRUCTIVE and not undoable from this server: confirm the exact target with the user before calling.';

/**
 * Canonical `roll_dice` description.
 *
 * Exported so `RollDiceTool` (`src/tools/handlers/dice.ts`) can reuse the exact
 * same string instead of keeping a second copy that silently drifts: the
 * registry class is what *executes* the tool while `getAllTools()` is what is
 * *listed*, so a divergence would be invisible.
 */
export const ROLL_DICE_DESCRIPTION =
  'Roll dice and return the total with a per-term breakdown. Dice terms and whole numbers joined by + or -, with whitespace allowed anywhere ("1d20+5", "1d20 + 5", "1d20+5+3", "2d6 + 1d4", "3d6"; a count-less "d20" means one die), always work and every term counts towards the total - that is the portable grammar, safe on either transport. Multiplication and Foundry modifier syntax such as "4d6kh3" or "1d20r1" are rejected on both transports, with an error naming the offending character and its position, never dropped from the total in silence. Parentheses are the one difference: with FOUNDRY_API_KEY set the formula goes to FoundryVTT\'s own Roll engine, which evaluates them, while the default Socket.IO transport rolls locally and rejects them by name - and a REST roll that cannot reach the server falls back to that same local roller, so a parenthesised formula can still fail there. Prefer the expanded form when it matters. Use when: the user asks for a check, save, attack, damage, or any random result.';

/**
 * Dice rolling tool definitions
 */
export const diceTools = [
  {
    name: 'roll_dice',
    description: ROLL_DICE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        formula: {
          type: 'string',
          description: 'Dice formula (e.g., "1d20+5", "3d6")',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for the roll',
        },
      },
      required: ['formula'],
    },
  },
];

/**
 * Actor management tool definitions
 */
export const actorTools = [
  {
    name: 'search_actors',
    description:
      "Search actors (player characters, NPCs) by name, optionally filtered by type. Returns a summary line per match: name, type, level and current/max HP. Use when: checking whether an actor exists, or getting a quick roster with HP. Do not use when: you already have the actorId and want that actor's ability scores - use get_actor_details; or you need the actorId itself, which this tool does not print - read the foundry://actors resource, whose JSON lists up to the first 100 actors with their _id (not exhaustive in larger worlds).",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for actor names',
        },
        type: {
          type: 'string',
          description: 'Actor type filter (character, npc, etc.)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
          default: 10,
        },
        cursor: {
          type: 'string',
          description: 'Opaque pagination cursor from a previous response to fetch the next page',
        },
      },
    },
  },
  {
    name: 'get_actor_details',
    description:
      'Get details for one actor by id: type, level, current/max HP, AC and ability scores; no biography or description text is returned (the description line always reads "No description available."). Use when: you have an actorId and need its current HP or ability scores - notably as the read-before-write step for update_actor_attributes. Do not use when: you only have a name - run search_actors first; or you need the ids of items the actor owns, which this tool does not return (no tool in this server lists owned-item ids - ask the user for the itemId).',
    inputSchema: {
      type: 'object',
      properties: {
        actorId: {
          type: 'string',
          description: 'The ID of the actor to retrieve',
        },
      },
      required: ['actorId'],
    },
  },
  {
    name: 'get_actor_inventory',
    description:
      "List an actor's owned items (equipment, spells, features) with full system data per item, unlike get_actor_details which only reports the actor's own top-level stats. Use when: checking what a character or NPC carries or knows before an attack, spell, or trade. Do not use when: you only need the actor's HP/AC/abilities - use get_actor_details.",
    inputSchema: {
      type: 'object',
      properties: {
        actorId: {
          type: 'string',
          description: 'The ID of the actor whose inventory to list',
        },
      },
      required: ['actorId'],
    },
  },
];

/**
 * Actor attribute mutation tool definitions (laurigates/foundryvtt-mcp#143)
 *
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active
 * Socket.IO connection (mutations use the core `modifyDocument` protocol).
 */
export const actorMutationTools = [
  {
    name: 'update_actor_attributes',
    description:
      'Update fields on an actor\'s system data. Patch keys are dot-paths into actor.system (e.g. "attributes.hp.value", "attributes.hp.temp", "currency.gp", "resources.primary.value", "spells.spell1.value", "attributes.exhaustion") and values are absolute target values, never relative deltas. Validates HP <= max + temp, spell slots <= max, and exhaustion within 0-10 (2024) or 0-6 (2014), and returns the post-update value for every patched path. Use when: applying damage or healing, spending a spell slot or resource, or adjusting currency on a known actorId. Do not use when: changing an item the actor owns (use update_actor_item) or only reading current values (use get_actor_details). ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: {
          type: 'string',
          description: 'The ID of the actor to update',
        },
        patch: {
          type: 'object',
          description:
            'Map of dot-path → value, where each dot-path addresses a field under actor.system ' +
            '(e.g. {"attributes.hp.value": 30, "currency.gp": 12}). Values must be number, string, or boolean.',
          additionalProperties: {
            type: ['number', 'string', 'boolean'],
          },
        },
      },
      required: ['actorId', 'patch'],
    },
  },
  {
    name: 'create_world_actor',
    description:
      'Create a new top-level Actor document (a permanent NPC or character sheet in the sidebar), optionally seeded with system data and filed under a folder. Use when: a new NPC or creature needs to exist as a persistent document, not just described in text. Do not use when: a quick throwaway description is enough - use generate_npc; or when adding an item to an actor that already exists - use create_actor_item. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Actor display name',
        },
        type: {
          type: 'string',
          description: 'Game-system actor type (e.g. "character", "npc")',
        },
        system: {
          type: 'object',
          description: 'Optional system-specific data merged into actor.system',
        },
        folder: {
          type: 'string',
          description: 'Optional Folder document id to file the actor under',
        },
      },
      required: ['name', 'type'],
    },
  },
  {
    name: 'create_full_actor',
    description:
      "Create a new top-level Actor document AND seed it with starting items (skills, gear, weapons, cyberware, …) in one call, instead of create_world_actor followed by one create_actor_item per item. Pairs with get_document_schema: call that once per Actor/Item type to learn the real field names for `system`, then build the whole character here in a single call. The actor is always created first - a failure there aborts the whole call. Item creation is best-effort per item, not atomic: a bad item (e.g. a typo'd type) is reported in the response's item-failures list rather than losing the actor or the items that did succeed. Use when: standing up a fully-statted PC or NPC (correct ability scores/attributes plus starting equipment/skills) in one round trip. Do not use when: the actor already exists - use create_actor_item to add items to it; or a bare/generic actor is enough - use create_world_actor. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Actor display name',
        },
        type: {
          type: 'string',
          description: 'Game-system actor type (e.g. "character", "npc")',
        },
        system: {
          type: 'object',
          description:
            'Optional system-specific data merged into actor.system - use get_document_schema("Actor", type) to learn the real field names first',
        },
        folder: {
          type: 'string',
          description: 'Optional Folder document id to file the actor under',
        },
        items: {
          type: 'array',
          description:
            'Optional starting items (skills, weapons, gear, cyberware, …) to create on the actor immediately after it exists',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Item display name',
              },
              type: {
                type: 'string',
                description:
                  'Game-system item type (e.g. "weapon", "skill") - use get_document_schema("Item", type) to learn the real field names first',
              },
              system: {
                type: 'object',
                description: 'Optional system-specific data merged into item.system',
              },
            },
            required: ['name', 'type'],
          },
        },
      },
      required: ['name', 'type'],
    },
  },
  {
    name: 'delete_world_actor',
    description:
      'Permanently delete a top-level Actor document. Use when: the user explicitly asks to remove an NPC or character sheet, and has given you the actorId. Do not use when: only removing a token placed on a scene - use delete_token; the actor document is untouched by that. ' +
      CONFIRM_FIRST +
      ' ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: {
          type: 'string',
          description: 'The ID of the actor to delete',
        },
      },
      required: ['actorId'],
    },
  },
];

/**
 * Item management tool definitions
 */
export const itemTools = [
  {
    name: 'search_items',
    description:
      'Search item documents in the world by name, optionally filtered by type. Returns name, type and rarity per match (rarity shows "Common" when the system records none); price is not available and always prints "Unknown price", and the rarity filter is ignored unless the REST API module is configured (FOUNDRY_API_KEY). Item ids are not printed - read the foundry://items resource, whose JSON lists up to the first 100 items with their _id (not exhaustive in larger worlds). Use when: checking whether an item exists in the world. Do not use when: searching compendium packs (use search_compendium) or listing what one actor carries (this searches world items, not owned items).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for item names',
        },
        type: {
          type: 'string',
          description: 'Item type filter (weapon, armor, consumable, etc.)',
        },
        rarity: {
          type: 'string',
          description:
            'Item rarity filter (common, uncommon, rare, etc.). Applied only in REST API mode (FOUNDRY_API_KEY); ignored on the default Socket.IO path.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
          default: 10,
        },
        cursor: {
          type: 'string',
          description: 'Opaque pagination cursor from a previous response to fetch the next page',
        },
      },
    },
  },
];

/**
 * Compendium search tool definitions (laurigates/foundryvtt-mcp#144)
 */
export const compendiumTools = [
  {
    name: 'search_compendium',
    description:
      'Search FoundryVTT compendium packs by name and metadata; searches all enabled packs unless compendiumId scopes it to one pack. Use when: looking up spells, monsters, or equipment that are not yet present in the world. Do not use when: the document already exists in the world - use search_items or search_world. Requires the REST API module (FOUNDRY_API_KEY); without it the search returns no results instead of failing.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for compendium entry names',
        },
        filters: {
          type: 'object',
          description: 'Optional metadata filters to narrow the search',
          properties: {
            compendiumId: {
              type: 'string',
              description: 'Scope the search to a single compendium pack',
            },
            packType: {
              type: 'string',
              description: 'Pack document type (Item, Actor, JournalEntry, Macro)',
            },
            itemType: {
              type: 'string',
              description: 'Item type filter (spell, weapon, feat, etc.)',
            },
            spellLevel: {
              type: 'number',
              description: 'Spell level filter',
            },
            source: {
              type: 'string',
              description: 'Source/rules filter (e.g. a sourcebook abbreviation)',
            },
          },
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results per page',
          default: 20,
        },
        cursor: {
          type: 'string',
          description:
            'Opaque pagination cursor from a prior result\'s "Next page" cursor; omit for the first page',
        },
      },
      required: ['query'],
    },
  },
];

/**
 * Actor item mutation tool definitions (WRITE — require FOUNDRY_WRITE_ENABLED
 * and an active Socket.IO connection; mutations use `modifyDocument`)
 *
 * The canonical mutation target is the D&D 5e v4+ activity schema. Item
 * `system` patches honour JSON-merge-patch semantics on nested paths.
 */
export const itemMutationTools = [
  {
    name: 'create_actor_item',
    description:
      'Create an item on an actor from an inline item document (type, name, system) or by referencing a compendium pack entry (compendium sources require the companion Foundry module). Use when: adding a new weapon, spell, feature, or piece of equipment to a known actorId. Do not use when: editing an item the actor already owns - use update_actor_item. Replacing an item is not atomic: create the replacement first and delete the old one second. Canonical target: D&D 5e v4+ activity schema. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: {
          type: 'string',
          description: 'The ID of the actor to add the item to',
        },
        source: {
          type: 'object',
          description:
            'Item source. Either { type: "inline", item: { type, name, system } } or { type: "compendium", compendiumId, itemId } (requires companion module).',
          properties: {
            type: {
              type: 'string',
              enum: ['compendium', 'inline'],
              description:
                'Source kind: "inline" (provides inline item data) or "compendium" (fetches from pack via companion module).',
            },
            compendiumId: {
              type: 'string',
              description: 'Compendium pack id (compendium source)',
            },
            itemId: {
              type: 'string',
              description: 'Item id within the compendium pack (compendium source)',
            },
            item: {
              type: 'object',
              description: 'Inline item document with type, name, and system (inline source)',
            },
          },
          required: ['type'],
        },
      },
      required: ['actorId', 'source'],
    },
  },
  {
    name: 'update_actor_item',
    description:
      "Apply a JSON merge patch to an item's system data on an actor: nested paths such as activities.{id}.consumption.targets are supported, values are absolute (arrays replace, null deletes). Use when: changing fields on an item the actor already owns, given actorId + itemId. Do not use when: adding a new item (create_actor_item) or removing one (delete_actor_item). Canonical target: D&D 5e v4+ activity schema. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: {
          type: 'string',
          description: 'The ID of the actor that owns the item',
        },
        itemId: {
          type: 'string',
          description: 'The ID of the item to update',
        },
        patch: {
          type: 'object',
          description:
            'JSON merge patch applied to item.system; nested paths supported (e.g. activities.{id}.consumption.targets)',
        },
      },
      required: ['actorId', 'itemId', 'patch'],
    },
  },
  {
    name: 'delete_actor_item',
    description:
      "Permanently remove an item owned by an actor. Use when: the user explicitly asks to delete or discard a specific owned item, and has given you the itemId - no tool in this server lists owned-item ids, so never guess one. Do not use when: only the item's data needs to change - use update_actor_item. In a replacement or migration flow, run create_actor_item first and this second: the two calls are not atomic, and failing after the delete loses the item. Echo the actorId and itemId back to the user and get their confirmation before calling. " +
      CONFIRM_FIRST +
      ' ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: {
          type: 'string',
          description: 'The ID of the actor that owns the item',
        },
        itemId: {
          type: 'string',
          description: 'The ID of the item to delete',
        },
      },
      required: ['actorId', 'itemId'],
    },
  },
];

/**
 * Scene management tool definitions
 */
export const sceneTools = [
  {
    name: 'get_scene_info',
    description:
      "Get details of the active scene, or of a specific scene by id: name, scene id, active/navigation flags, pixel dimensions, padding, grid (type, size in pixels, distance, units), and lighting (global light, darkness); no description text is returned unless a module has set a description flag on the scene (the description line otherwise reads 'No description available.'). Use when: you need the sceneId, grid size, or the scene's pixel extents. Do not use when: looking a scene up by name (use search_world), or you need token/tile coordinates - this tool returns neither; use list_tiles or the foundry://scenes resource.",
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'Optional scene ID. If not provided, returns current scene',
        },
      },
    },
  },
];

/**
 * Scene mutation tool definitions
 *
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active
 * Socket.IO connection (mutations use the core `modifyDocument` protocol).
 */
export const sceneMutationTools = [
  {
    name: 'create_scene',
    description:
      "Create a new Scene document from a background image already present under FoundryVTT's Data directory (see list_scene_assets to browse available map art). Width/height default to the image's real pixel dimensions read from disk (requires FOUNDRY_DATA_PATH) — the single biggest source of a misaligned grid when set by hand; pass width/height explicitly to override. Use when: a new location needs a scene before the party arrives there, or a fresh battlemap needs to exist as a document. Do not use when: the scene already exists - use switch_scene to activate it, or set_scene_lighting to change its lighting. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Scene display name',
        },
        backgroundSrc: {
          type: 'string',
          description:
            'Data-relative path to the background image (e.g. "assets/cyberpunk/maps/v1/x.jpg"), as returned by list_scene_assets',
        },
        width: {
          type: 'number',
          description: "Optional explicit pixel width; defaults to the image's real width",
        },
        height: {
          type: 'number',
          description: "Optional explicit pixel height; defaults to the image's real height",
        },
        gridSize: {
          type: 'number',
          description: 'Grid cell size in pixels (default 100)',
        },
        gridType: {
          type: 'number',
          description: 'Foundry grid type constant (default 1 = square)',
        },
        gridDistance: {
          type: 'number',
          description: 'Real-world distance one grid cell represents (default 1)',
        },
        gridUnits: {
          type: 'string',
          description: 'Unit label for gridDistance (e.g. "ft", "m") (default "ft")',
        },
        padding: {
          type: 'number',
          description: 'Fractional canvas padding around the background image (default 0.25)',
        },
        backgroundColor: {
          type: 'string',
          description: 'Hex color shown outside the background image (default "#999999")',
        },
        activate: {
          type: 'boolean',
          description: 'Optional; true to immediately activate the new scene for all players',
        },
      },
      required: ['name', 'backgroundSrc'],
    },
  },
  {
    name: 'switch_scene',
    description:
      "Activate a scene, switching every connected player's canvas to it. FoundryVTT enforces a single active scene server-side, so activating one automatically deactivates whichever scene was active before - no separate deactivation call is needed. Use when: the party moves to a new map (new area, travel, a battle starting on a prepared map). Do not use when: you only need to read scene info - use get_scene_info. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'The ID of the scene to activate',
        },
      },
      required: ['sceneId'],
    },
  },
  {
    name: 'delete_scene',
    description:
      'Permanently delete a Scene document. Use when: the user explicitly asks to remove a map that is no longer needed. Do not use when: you only want to stop showing it to players - use switch_scene to activate a different one instead; deleting the active scene leaves no scene active. ' +
      CONFIRM_FIRST +
      ' ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'The ID of the scene to delete',
        },
      },
      required: ['sceneId'],
    },
  },
  {
    name: 'set_scene_lighting',
    description:
      "Set a scene's ambient darkness level (0-1) and/or global illumination fields (globalLight, globalLightThreshold). Plain Scene document fields - no canvas access required. Use when: transitioning to night, dimming a room, or lighting a torch-lit area. Do not use when: you only need to read current lighting - use get_scene_info. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'The ID of the scene to update',
        },
        darkness: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Ambient darkness level, 0 (fully lit) to 1 (pitch black)',
        },
        globalLight: {
          type: 'boolean',
          description: 'Whether the whole scene is globally illuminated',
        },
        globalLightThreshold: {
          type: 'number',
          description: 'Darkness level above which global light is suppressed',
        },
      },
      required: ['sceneId'],
    },
  },
  {
    name: 'reset_fog',
    description:
      'Reset fog of war exploration progress for a scene, defaulting to the active scene when sceneId is omitted. ' +
      CONFIRM_FIRST +
      ' ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID; defaults to the active scene',
        },
      },
    },
  },
  {
    name: 'set_scene_weather',
    description:
      'Set or clear weather effects on a scene (e.g. "rain", "snow", "leaves", "rainStorm", "fog", or empty string "" to clear). Default values come from Foundry core; additional effects may be available if weather modules are installed. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        weather: {
          type: 'string',
          description:
            'Weather effect key (e.g. "rain", "snow", "leaves", "rainStorm", "fog"), or "" to clear',
        },
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID; defaults to the active scene',
        },
      },
      required: ['weather'],
    },
  },
];

/**
 * Wall (structural) tool definitions
 *
 * `list_walls` is a pure read over cached worldData. `create_wall`,
 * `delete_wall`, and `set_door_state` are WRITE operations — require
 * FOUNDRY_WRITE_ENABLED=true and an active Socket.IO connection (mutations
 * use the core `modifyDocument` protocol). `ds` (door state) is a plain
 * field on the `Wall` embedded document, so none of this needs canvas access.
 */
export const wallMutationTools = [
  {
    name: 'list_walls',
    description:
      "List the Walls on a scene (id, endpoints, and the move/sight/door/ds fields), defaulting to the active scene when sceneId is omitted. Read from cached worldData - no canvas access needed. Use when: finding a wallId for delete_wall/set_door_state, or checking a scene's current wall layout before adding more. Do not use when: you need tile or token positions instead - this only lists Wall documents.",
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID; defaults to the active scene',
        },
      },
    },
  },
  {
    name: 'create_wall',
    description:
      'Create a new Wall segment on a scene - the structural building block for rooms, corridors, and doors. Unlike create_tile (which centres in a cell), a wall connects two grid *vertices* (intersections): fromCol/fromRow -> toCol/toRow, e.g. fromCol:3,fromRow:5 -> toCol:4,toRow:5 is the one-cell-long top edge of cell (3,5); a longer run spans multiple cells in one call. Alternatively pass explicit pixel x1/y1/x2/y2. type selects one of FoundryVTT\'s own named wall presets (the ones its wall-tool palette offers): "wall" (default, solid - blocks movement and sight), "door" (openable via set_door_state, starts closed), "secretDoor" (looks like a wall until discovered, starts closed), "terrain" (blocks movement; sight/light only block on the second crossing - hedges, foliage: you can see the hedge but not what is directly behind it), "invisible" (blocks movement but not sight - furniture, low obstacles, hidden traps), "ethereal" (the inverse of invisible: blocks sight but not movement - magical curtains, spectral barriers). Use when: building out a scene\'s room layout, or adding a door/terrain/invisible/ethereal wall to an existing wall line. Do not use when: you want to toggle an existing door open/closed/locked - use set_door_state; or decorate with a prop - use create_tile. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'The ID of the scene to place the wall on',
        },
        x1: {
          type: 'number',
          description: 'Start pixel x coordinate. Alternative to fromCol/fromRow.',
        },
        y1: {
          type: 'number',
          description: 'Start pixel y coordinate. Alternative to fromCol/fromRow.',
        },
        x2: {
          type: 'number',
          description: 'End pixel x coordinate. Alternative to toCol/toRow.',
        },
        y2: {
          type: 'number',
          description: 'End pixel y coordinate. Alternative to toCol/toRow.',
        },
        fromCol: {
          type: 'number',
          description: 'Start grid vertex column. Alternative to x1/y1.',
        },
        fromRow: {
          type: 'number',
          description: 'Start grid vertex row. Alternative to x1/y1.',
        },
        toCol: {
          type: 'number',
          description: 'End grid vertex column. Alternative to x2/y2.',
        },
        toRow: {
          type: 'number',
          description: 'End grid vertex row. Alternative to x2/y2.',
        },
        type: {
          type: 'string',
          enum: ['wall', 'door', 'secretDoor', 'terrain', 'invisible', 'ethereal'],
          description:
            'Wall nature (default "wall"): wall = solid; door = openable, starts closed; secretDoor = hidden until discovered, starts closed; terrain = blocks movement, sight blocks only on the second crossing; invisible = blocks movement, not sight; ethereal = blocks sight, not movement',
        },
      },
      required: ['sceneId'],
    },
  },
  {
    name: 'delete_wall',
    description:
      'Remove a Wall from a scene. Use when: undoing a placement mistake, or opening up a room by removing a wall segment entirely (as opposed to opening a door - use set_door_state to keep the wall and just toggle it). Do not use when: you want to remove a tile or token instead - this only affects Wall documents. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'The ID of the scene the wall is on',
        },
        wallId: {
          type: 'string',
          description: 'The ID of the wall to remove',
        },
      },
      required: ['sceneId', 'wallId'],
    },
  },
  {
    name: 'set_door_state',
    description:
      "Open, close, or lock a door (a Wall document with door !== 0). Use when: a party opens or shuts a door, or a door should be locked/unlocked. Do not use when: you don't have the wallId - use list_walls, or ask the user, or read the foundry://scenes resource. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        wallId: {
          type: 'string',
          description: 'The ID of the door (Wall document) to change',
        },
        state: {
          type: 'number',
          enum: [0, 1, 2],
          description: '0 = closed, 1 = open, 2 = locked',
        },
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID to scope the wall lookup',
        },
      },
      required: ['wallId', 'state'],
    },
  },
];

/**
 * Tile read tool definitions
 *
 * All three are pure reads over cached worldData or the local filesystem
 * (list_scene_assets, requires FOUNDRY_DATA_PATH) — no FOUNDRY_WRITE_ENABLED
 * needed. Together they let a scene be decorated without a `capture_scene`
 * screenshot: browse available art, find where it's safe to place, check
 * what's already down.
 */
export const tileTools = [
  {
    name: 'list_scene_assets',
    description:
      'List image assets (map backgrounds, prop/token art) under a folder of the FoundryVTT Data directory, with real pixel dimensions and any `[Tag, Tag]`-bracketed keyword tags parsed out of the filename (the naming convention several battlemap packs use). Requires FOUNDRY_DATA_PATH — this server must run on the same host as FoundryVTT. Use when: choosing a background for create_scene, or browsing available decoration art for create_tile before placing anything. Do not use when: FOUNDRY_DATA_PATH is not set - this always returns empty in that case.',
    inputSchema: {
      type: 'object',
      properties: {
        subdir: {
          type: 'string',
          description: 'Data-relative folder to scan (default "assets")',
        },
        query: {
          type: 'string',
          description: 'Optional case-insensitive substring filter on filename or parsed tags',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default 200)',
        },
        kind: {
          type: 'string',
          enum: ['image', 'audio'],
          description: 'Asset category to scan for: "image" (default) or "audio"',
          default: 'image',
        },
      },
    },
  },
  {
    name: 'list_tiles',
    description:
      'List the Tiles placed on a scene (id, image src, position, size, rotation, hidden), defaulting to the active scene when sceneId is omitted. Read from cached worldData - no capture_scene screenshot needed to see current decoration state. Use when: checking what is already placed before adding more, or getting a tileId for delete_tile. Do not use when: you need token positions instead of tile positions - tiles and tokens are separate document types; this only lists tiles.',
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID; defaults to the active scene',
        },
      },
    },
  },
  {
    name: 'find_open_cells',
    description:
      "Scan a scene's grid for cells with no wall crossing them and no existing tile/token already centred there - a placement candidate list for create_tile/spawn_token that needs no screenshot to compute. Restricted to the background image's own extent; the scene's padding margin is never returned as floor. Use when: deciding where to place a new tile or token without visual inspection. Do not use when: you already have a specific target position in mind - this is for open-ended 'somewhere sensible' placement, not for verifying one exact spot.",
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'The ID of the scene to scan',
        },
        limit: {
          type: 'number',
          description: 'Maximum open cells to return (default 50)',
        },
      },
      required: ['sceneId'],
    },
  },
];

/**
 * Tile mutation tool definitions
 *
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active
 * Socket.IO connection (mutations use the core `modifyDocument` protocol).
 */
export const tileMutationTools = [
  {
    name: 'create_tile',
    description:
      "Place a decorative Tile on a scene from an image already present under FoundryVTT's Data directory (see list_scene_assets). Width/height default to the image's real pixel dimensions when not given. Position is either explicit pixel x/y (top-left corner) or a gridCol/gridRow cell (the tile is centred in that cell - see find_open_cells for candidates). By default refuses to place a tile whose bounding box crosses a scene wall; pass allowWallOverlap: true to place anyway (e.g. a wall-mounted prop). Use when: decorating a scene with scenery (crates, dumpsters, vehicles, graffiti) that is not a creature or NPC. Do not use when: the object is a creature/NPC that should have HP and act in combat - use create_world_actor + spawn_token instead. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'The ID of the scene to place the tile on',
        },
        src: {
          type: 'string',
          description: 'Data-relative path to the tile image, as returned by list_scene_assets',
        },
        x: {
          type: 'number',
          description: 'Target top-left x pixel coordinate. Alternative to gridCol/gridRow.',
        },
        y: {
          type: 'number',
          description: 'Target top-left y pixel coordinate. Alternative to gridCol/gridRow.',
        },
        gridCol: {
          type: 'number',
          description: 'Grid column to centre the tile in. Alternative to x/y.',
        },
        gridRow: {
          type: 'number',
          description: 'Grid row to centre the tile in. Alternative to x/y.',
        },
        width: {
          type: 'number',
          description: "Optional explicit pixel width; defaults to the image's real width",
        },
        height: {
          type: 'number',
          description: "Optional explicit pixel height; defaults to the image's real height",
        },
        rotation: {
          type: 'number',
          description: 'Optional rotation in degrees (default 0)',
        },
        elevation: {
          type: 'number',
          description: 'Optional elevation (default 0)',
        },
        hidden: {
          type: 'boolean',
          description: 'Optional; true to place the tile hidden from players',
        },
        allowWallOverlap: {
          type: 'boolean',
          description:
            'Optional; true to allow placement even if the bounding box crosses a wall (default false - refuses)',
        },
      },
      required: ['sceneId', 'src'],
    },
  },
  {
    name: 'delete_tile',
    description:
      'Remove a Tile from a scene. Use when: undoing a placement mistake, or clearing decoration that no longer fits the scene. Do not use when: you want to remove a token or actor instead - this only affects Tile documents; use delete_token or delete_world_actor. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'The ID of the scene the tile is on',
        },
        tileId: {
          type: 'string',
          description: 'The ID of the tile to remove',
        },
      },
      required: ['sceneId', 'tileId'],
    },
  },
];
/**
 * Placeable read tools (lights, sounds, notes, drawings, templates).
 * Pure reads over cached worldData — no write gate.
 */
export const placeableTools = [
  {
    name: 'list_lights',
    description:
      'List the AmbientLight sources placed on a scene (id, position, dim/bright radius, color, rotation, animation, hidden), defaulting to the active scene when sceneId is omitted. Read from cached worldData - no canvas access needed. Use when: inspecting scene lighting or finding a lightId for update_light/delete_light.',
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID; defaults to the active scene',
        },
      },
    },
  },
  {
    name: 'list_sounds',
    description:
      'List the AmbientSound sources placed on a scene (id, position, radius, audio path, volume, repeat, hidden), defaulting to the active scene when sceneId is omitted. Read from cached worldData - no canvas access needed. Use when: inspecting ambient audio or finding a soundId for delete_sound.',
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID; defaults to the active scene',
        },
      },
    },
  },
  {
    name: 'list_notes',
    description:
      'List the Map Notes (journal pins) placed on a scene (id, position, label text, linked journal entry and page, global visibility), defaulting to the active scene when sceneId is omitted. Read from cached worldData - no canvas access needed. Use when: finding pins on the map or getting a noteId for delete_note.',
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID; defaults to the active scene',
        },
      },
    },
  },
  {
    name: 'list_drawings',
    description:
      'List the Drawings placed on a scene (id, shape type, position, dimensions/radius, text label, colors, hidden, locked), defaulting to the active scene when sceneId is omitted. Read from cached worldData - no canvas access needed. Use when: inspecting canvas shapes or finding a drawingId for delete_drawing.',
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID; defaults to the active scene',
        },
      },
    },
  },
  {
    name: 'list_templates',
    description:
      'List the Measured Templates (AOE spell/effect shapes) placed on a scene (id, template type, position, distance, direction, angle, width, colors, hidden), defaulting to the active scene when sceneId is omitted. Read from cached worldData - no canvas access needed. Use when: inspecting active spell areas or finding a templateId for delete_template.',
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID; defaults to the active scene',
        },
      },
    },
  },
];

/**
 * Placeable mutation tools (lights, sounds, notes, drawings, templates).
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active Socket.IO connection.
 */
export const placeableMutationTools = [
  {
    name: 'create_light',
    description:
      'Create a new AmbientLight source on a scene at either pixel x/y or a gridCol/gridRow cell (the light is centered in that cell). Supports dim/bright radii, color hex tint (#rrggbb), angle, rotation, and animation presets (e.g. torch, pulse, chroma). ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID; defaults to the active scene',
        },
        x: { type: 'number', description: 'Pixel x coordinate (center)' },
        y: { type: 'number', description: 'Pixel y coordinate (center)' },
        gridCol: { type: 'number', description: 'Grid column (centers in cell)' },
        gridRow: { type: 'number', description: 'Grid row (centers in cell)' },
        dim: {
          type: 'number',
          description: 'Dim light radius in grid units (default 0)',
          default: 0,
        },
        bright: {
          type: 'number',
          description: 'Bright light radius in grid units (default 0)',
          default: 0,
        },
        color: {
          type: 'string',
          description: 'Light color as a 6-digit hex string (e.g. "#ff8800")',
        },
        angle: {
          type: 'number',
          description: 'Light emission angle in degrees (default 360)',
          default: 360,
        },
        rotation: {
          type: 'number',
          description: 'Light rotation in degrees (default 0)',
          default: 0,
        },
        animationType: {
          type: 'string',
          description: 'Optional animation type (e.g. "torch", "pulse", "chroma", "wave")',
        },
        animationSpeed: {
          type: 'number',
          description: 'Animation speed 0-10 (default 5)',
          default: 5,
        },
        animationIntensity: {
          type: 'number',
          description: 'Animation intensity 1-10 (default 5)',
          default: 5,
        },
        walls: {
          type: 'boolean',
          description: 'Whether light is constrained by walls (default true)',
          default: true,
        },
        vision: {
          type: 'boolean',
          description: 'Whether this light provides vision to tokens (default false)',
          default: false,
        },
        hidden: {
          type: 'boolean',
          description: 'Whether the light source is hidden (default false)',
          default: false,
        },
      },
    },
  },
  {
    name: 'update_light',
    description:
      'Update an existing AmbientLight source on a scene (radii, color, position, angle, animation, walls/vision/hidden). ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        lightId: { type: 'string', description: 'The ID of the ambient light to update' },
        sceneId: { type: 'string', description: 'Optional Scene ID; defaults to the active scene' },
        x: { type: 'number', description: 'New pixel x coordinate' },
        y: { type: 'number', description: 'New pixel y coordinate' },
        dim: { type: 'number', description: 'Dim light radius in grid units' },
        bright: { type: 'number', description: 'Bright light radius in grid units' },
        color: {
          type: 'string',
          description: 'Light color as a 6-digit hex string (e.g. "#ff8800")',
        },
        angle: { type: 'number', description: 'Light emission angle in degrees' },
        rotation: { type: 'number', description: 'Light rotation in degrees' },
        walls: { type: 'boolean', description: 'Whether light is constrained by walls' },
        vision: { type: 'boolean', description: 'Whether this light provides vision' },
        hidden: { type: 'boolean', description: 'Whether the light source is hidden' },
      },
      required: ['lightId'],
    },
  },
  {
    name: 'delete_light',
    description: `Permanently remove an AmbientLight from a scene. ${CONFIRM_FIRST} ${WRITE_GATE}`,
    inputSchema: {
      type: 'object',
      properties: {
        lightId: { type: 'string', description: 'The ID of the ambient light to delete' },
        sceneId: { type: 'string', description: 'Optional Scene ID; defaults to the active scene' },
      },
      required: ['lightId'],
    },
  },
  {
    name: 'create_sound',
    description:
      'Create an AmbientSound source on a scene from an audio file path (browse available audio via list_scene_assets with kind="audio"). Placement is either pixel x/y or a gridCol/gridRow cell. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Audio file path (e.g. "assets/audio/rain.mp3")' },
        sceneId: { type: 'string', description: 'Optional Scene ID; defaults to the active scene' },
        x: { type: 'number', description: 'Pixel x coordinate (center)' },
        y: { type: 'number', description: 'Pixel y coordinate (center)' },
        gridCol: { type: 'number', description: 'Grid column (centers in cell)' },
        gridRow: { type: 'number', description: 'Grid row (centers in cell)' },
        radius: {
          type: 'number',
          description: 'Audible radius in grid units (default 0)',
          default: 0,
        },
        volume: {
          type: 'number',
          description: 'Playback volume 0.0 to 1.0 (default 0.5)',
          default: 0.5,
        },
        repeat: {
          type: 'boolean',
          description: 'Whether the audio loops continuously (default false)',
          default: false,
        },
        walls: {
          type: 'boolean',
          description: 'Whether sound is blocked by walls (default true)',
          default: true,
        },
        easing: {
          type: 'boolean',
          description: 'Whether volume fades towards the boundary (default true)',
          default: true,
        },
        hidden: {
          type: 'boolean',
          description: 'Whether the sound is hidden/disabled (default false)',
          default: false,
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'delete_sound',
    description: `Permanently remove an AmbientSound from a scene. ${CONFIRM_FIRST} ${WRITE_GATE}`,
    inputSchema: {
      type: 'object',
      properties: {
        soundId: { type: 'string', description: 'The ID of the ambient sound to delete' },
        sceneId: { type: 'string', description: 'Optional Scene ID; defaults to the active scene' },
      },
      required: ['soundId'],
    },
  },
  {
    name: 'create_note',
    description:
      'Place a Map Note (journal pin) on a scene at pixel x/y or a gridCol/gridRow cell. Must link to an entryId (journal entry), provide text (standalone label), or both. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string', description: 'Optional Scene ID; defaults to the active scene' },
        entryId: {
          type: 'string',
          description: 'Optional JournalEntry document ID to link to this pin',
        },
        pageId: {
          type: 'string',
          description: 'Optional JournalEntryPage ID within the linked entry',
        },
        text: { type: 'string', description: 'Optional label text displayed below or on the pin' },
        x: { type: 'number', description: 'Pixel x coordinate (center)' },
        y: { type: 'number', description: 'Pixel y coordinate (center)' },
        gridCol: { type: 'number', description: 'Grid column (centers in cell)' },
        gridRow: { type: 'number', description: 'Grid row (centers in cell)' },
        iconSize: {
          type: 'number',
          description: 'Pin icon size in pixels (minimum 32, default 40)',
          default: 40,
        },
        fontSize: {
          type: 'number',
          description: 'Label font size in pixels (8-128, default 32)',
          default: 32,
        },
        textAnchor: {
          type: 'number',
          description:
            'Text anchor point: 0 (center), 1 (bottom/default), 2 (top), 3 (left), 4 (right)',
          default: 1,
        },
        global: {
          type: 'boolean',
          description: 'Whether the note is visible regardless of fog/vision (default false)',
          default: false,
        },
      },
    },
  },
  {
    name: 'delete_note',
    description:
      'Permanently remove a Map Note pin from a scene (does not delete the linked journal entry). ' +
      CONFIRM_FIRST +
      ' ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'The ID of the map note to delete' },
        sceneId: { type: 'string', description: 'Optional Scene ID; defaults to the active scene' },
      },
      required: ['noteId'],
    },
  },
  {
    name: 'create_drawing',
    description:
      'Create a Drawing shape on a scene (rectangle "r", circle "c", ellipse "e", or polygon "p") with optional text, fill, and stroke styling. Position x, y is the top-left corner of the shape. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Pixel x coordinate (top-left)' },
        y: { type: 'number', description: 'Pixel y coordinate (top-left)' },
        shape: {
          type: 'string',
          enum: ['r', 'c', 'e', 'p'],
          description:
            'Shape type: "r" (rectangle, default), "c" (circle), "e" (ellipse), "p" (polygon)',
          default: 'r',
        },
        sceneId: { type: 'string', description: 'Optional Scene ID; defaults to the active scene' },
        width: { type: 'number', description: 'Width in pixels (required for "r" and "e")' },
        height: { type: 'number', description: 'Height in pixels (required for "r" and "e")' },
        radius: { type: 'number', description: 'Radius in pixels (required for "c")' },
        points: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Array of coordinates [x1, y1, x2, y2, ...] with at least 3 points (required for "p")',
        },
        rotation: { type: 'number', description: 'Rotation in degrees (default 0)', default: 0 },
        strokeColor: {
          type: 'string',
          description: 'Stroke color as a 6-digit hex string (e.g. "#ffffff")',
        },
        strokeWidth: {
          type: 'number',
          description: 'Stroke line width in pixels (default 8)',
          default: 8,
        },
        fillType: {
          type: 'number',
          enum: [0, 1, 2],
          description: 'Fill type: 0 (none), 1 (solid), 2 (pattern)',
        },
        fillColor: {
          type: 'string',
          description: 'Fill color as a 6-digit hex string (e.g. "#336699")',
        },
        fillAlpha: {
          type: 'number',
          description: 'Fill opacity 0.0 to 1.0 (default 0.5)',
          default: 0.5,
        },
        text: { type: 'string', description: 'Optional text label displayed inside the drawing' },
        fontSize: {
          type: 'number',
          description: 'Font size in pixels (8-256, default 48)',
          default: 48,
        },
        hidden: {
          type: 'boolean',
          description: 'Whether the drawing is hidden from players (default false)',
          default: false,
        },
        locked: {
          type: 'boolean',
          description: 'Whether the drawing is locked from interaction (default false)',
          default: false,
        },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'delete_drawing',
    description: `Permanently remove a Drawing from a scene. ${CONFIRM_FIRST} ${WRITE_GATE}`,
    inputSchema: {
      type: 'object',
      properties: {
        drawingId: { type: 'string', description: 'The ID of the drawing to delete' },
        sceneId: { type: 'string', description: 'Optional Scene ID; defaults to the active scene' },
      },
      required: ['drawingId'],
    },
  },
  {
    name: 'create_template',
    description:
      'Place a Measured Template (spell/area-of-effect shape: "circle", "cone", "rect", "ray") on a scene at pixel x/y or a gridCol/gridRow cell. Distance is specified in scene grid units (e.g. metres or feet). ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        distance: {
          type: 'number',
          description: 'Effect distance/radius in grid units (e.g. 6m or 30ft)',
        },
        t: {
          type: 'string',
          enum: ['circle', 'cone', 'rect', 'ray'],
          description: 'Template type (default "circle")',
          default: 'circle',
        },
        sceneId: { type: 'string', description: 'Optional Scene ID; defaults to the active scene' },
        x: { type: 'number', description: 'Pixel x coordinate (origin point)' },
        y: { type: 'number', description: 'Pixel y coordinate (origin point)' },
        gridCol: { type: 'number', description: 'Grid column (centers origin in cell)' },
        gridRow: { type: 'number', description: 'Grid row (centers origin in cell)' },
        direction: {
          type: 'number',
          description:
            'Direction angle in degrees (0 = right, 90 = down; required for cone/ray/rect)',
          default: 0,
        },
        angle: {
          type: 'number',
          description: 'Cone spread angle in degrees (required for cone, e.g. 45 or 53.13)',
          default: 0,
        },
        width: {
          type: 'number',
          description: 'Ray line width in grid units (required for ray)',
          default: 0,
        },
        borderColor: { type: 'string', description: 'Border color as a 6-digit hex string' },
        fillColor: { type: 'string', description: 'Fill color as a 6-digit hex string' },
        hidden: {
          type: 'boolean',
          description: 'Whether the template is hidden from players (default false)',
          default: false,
        },
      },
      required: ['distance'],
    },
  },
  {
    name: 'delete_template',
    description:
      'Permanently remove a Measured Template area-of-effect shape from a scene. ' +
      CONFIRM_FIRST +
      ' ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        templateId: { type: 'string', description: 'The ID of the measured template to delete' },
        sceneId: { type: 'string', description: 'Optional Scene ID; defaults to the active scene' },
      },
      required: ['templateId'],
    },
  },
];
/**
 * Content generation tool definitions
 */
export const generationTools = [
  {
    name: 'generate_npc',
    description:
      'Generate a random NPC (name, race, class, HP, ability scores, background) as text. Use when: the user needs a throwaway NPC on the spot. Do not use when: the NPC must exist in FoundryVTT - this creates no documents, and the result still has to be entered into the world by hand.',
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          type: 'number',
          description: 'Character level (1-20)',
          minimum: 1,
          maximum: 20,
          default: 1,
        },
        race: {
          type: 'string',
          description: 'Character race (optional)',
        },
        class: {
          type: 'string',
          description: 'Character class (optional)',
        },
      },
    },
  },
  {
    name: 'generate_loot',
    description:
      "Generate random treasure for an encounter as text. Only the currency amounts vary: they scale with the challenge rating, while the item list is fixed (a Healing Potion and a Silver Ring) and the treasureType argument is accepted but not used. Use when: the user wants a quick coin total for an encounter. Do not use when: the loot should end up in an actor's inventory - this creates no documents; use create_actor_item for that.",
    inputSchema: {
      type: 'object',
      properties: {
        challengeRating: {
          type: 'number',
          description: 'Challenge rating for loot generation',
          minimum: 0,
          maximum: 30,
        },
        treasureType: {
          type: 'string',
          description:
            'Type of treasure (hoard, individual, etc.). Accepted but not used - the generated result is the same whichever value is passed.',
        },
      },
    },
  },
  {
    name: 'lookup_rule',
    description:
      'Search rules and mechanics across world journals and compendium journal packs. Compendium search requires the companion Foundry module.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Rule, keyword, or mechanic to look up',
        },
      },
      required: ['query'],
    },
  },
];

/**
 * Diagnostics and logging tool definitions
 */
export const diagnosticsTools = [
  {
    name: 'get_recent_logs',
    description:
      'Get recent FoundryVTT server log entries, optionally filtered by level or since a timestamp. Use when: investigating an error or recent server behaviour. Do not use when: you have a specific term to look for - use search_logs. Requires the REST API module (FOUNDRY_API_KEY); fails without it.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of log entries to retrieve',
          default: 20,
          minimum: 1,
          maximum: 100,
        },
        level: {
          type: 'string',
          description: 'Log level filter (debug, info, warn, error)',
          enum: ['debug', 'info', 'warn', 'error'],
        },
        since: {
          type: 'string',
          description: 'Get logs since this timestamp (ISO format)',
        },
      },
    },
  },
  {
    name: 'search_logs',
    description:
      'Search the FoundryVTT server logs for a query string and list the matching entries. Use when: hunting a specific error message, stack trace, or module name. Do not use when: you just want the latest entries - use get_recent_logs. The reported match count is the server\'s total for the query, while limit caps how many of those entries are rendered (default 50, hard cap 1000). Level filtering accepts info, warn and error; "debug" is not a level this log store records, so it is reported back as unsupported and no level filter is applied. Requires the REST API module (FOUNDRY_API_KEY); fails without it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for log contents',
        },
        level: {
          type: 'string',
          description:
            'Log level filter; "debug" is not recorded by this log store and is not applied',
          enum: ['debug', 'info', 'warn', 'error'],
        },
        limit: {
          type: 'number',
          description: 'Maximum number of matched entries to render (capped at 1000)',
          default: 50,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_system_health',
    description:
      "Get the FoundryVTT server's health report: the overall status (healthy, warning, or critical), FoundryVTT and game-system versions, world id and uptime, active/total user counts with the number of GMs, active/installed module counts, connected clients, heap and RSS memory, and the log buffer size with recent error/warning counts and error rate. CPU and disk are not reported - the diagnostics response models no such fields - and the uptime and memory lines are omitted when the server does not supply them. Use when: you want the server's own view of its health. Do not use when: you also want connection and world status - use get_health_status. Requires the REST API module (FOUNDRY_API_KEY); fails without it.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'diagnose_errors',
    description:
      'Retrieve error diagnosis and health analysis from the FoundryVTT server logs via the REST API module (FOUNDRY_API_KEY). Reports error categories, health score, actionable suggestions, and recent errors.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description:
            'Optional error category to filter summary and logs (e.g. "socket", "database")',
        },
        timeframe: {
          type: 'number',
          description: 'Timeframe in seconds to analyze (default 3600)',
          default: 3600,
        },
      },
    },
  },
  {
    name: 'get_health_status',
    description:
      "Get a combined health report: MCP-to-FoundryVTT connection state, world title/system/core version, and the server's health status with its active/total user counts, uptime, heap memory and recent error/warning counts. The world section is prefixed with a stale marker when the cached snapshot stopped following live document changes - typically a dropped connection, whose missed updates are never replayed - and refresh_world_data resyncs it. The connection line is a live read of the socket on the default Socket.IO transport, so it follows a link that drops or comes back in both directions; with FOUNDRY_API_KEY set there is no socket and it reports the outcome of the last REST request instead, not a live probe, so a server that went away between requests still reads as connected until the next request fails. Uptime and memory are omitted when the server does not report them; CPU, disk and playtime are not reported at all. Also lists the journal page overwrites detected in the last 24 hours (a connector write lost to a stale save or an open editor's autosave), with the path of each local copy. Degrades gracefully - sections that need the REST API module (FOUNDRY_API_KEY) report as unavailable rather than failing. Use when: first checking which world is loaded and whether the server reports itself healthy.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Combat tool definitions
 */
export const combatTools = [
  {
    name: 'get_combat_state',
    description:
      "Get the active combat encounter: initiative order with each combatant's name, initiative, HP and AC, plus the current round and which combatant is up. Use when: reporting whose turn it is, or checking whether a combat is already running before start_combat. Do not use when: you need a combatantId for set_initiative - this prints names and ordinals, not ids; read the foundry://combat resource, whose JSON includes each combatant's _id and lists combatants in this same initiative order, so the Nth entry printed here is that resource's combatants[N-1] and combat.turn indexes it directly.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Combat control mutation tool definitions (FR-018)
 *
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active Socket.IO
 * connection (mutations use the core `modifyDocument` protocol). All operate on
 * the *active* combat; the connected user needs GM/owner permission.
 */
export const combatMutationTools = [
  {
    name: 'next_turn',
    description:
      'Advance the active combat to the next turn, wrapping to the next round after the last combatant. When skipDefeated is true, defeated combatants are skipped. Use when: the current combatant has finished their turn. Do not use when: only reporting the turn order - use get_combat_state. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        skipDefeated: {
          type: 'boolean',
          description:
            "Skip combatants flagged as defeated when advancing. Defaults to the combat's skipDefeated setting, or false.",
        },
      },
    },
  },
  {
    name: 'end_combat',
    description:
      'End the active combat encounter by deleting its Combat document, discarding the initiative order and round count. Use when: the fight is over and the user asks to end the encounter. ' +
      CONFIRM_FIRST +
      ' ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'set_initiative',
    description:
      "Set a combatant's initiative in the active combat (or in combatId when given), reordering the turn order. When that reorder moves the combatant who is currently acting to a different position, the encounter's turn index is rewritten to follow them - whoever was up stays up, and the result says so - rather than leaving the marker on whoever slid into the old slot. That follow-up applies only to the active combat: a combatId naming some other encounter still records the initiative, but its turn order is not readable here and is left alone. Use when: an initiative roll needs to be recorded or corrected for a known combatantId. Do not use when: simply moving on to the next combatant - use next_turn. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        combatantId: {
          type: 'string',
          description: 'The ID of the combatant whose initiative to set',
        },
        initiative: {
          type: 'number',
          description: 'The initiative value to assign',
        },
        combatId: {
          type: 'string',
          description: 'Optional Combat document ID; defaults to the active combat',
        },
      },
      required: ['combatantId', 'initiative'],
    },
  },
  {
    name: 'start_combat',
    description:
      'Start a new combat encounter, seeding combatants from tokens: pass explicit tokenIds, or omit them to seed every token on the scene. Defaults to the active scene when sceneId is omitted. Use when: a fight begins and no combat is running. Do not use when: a combat is already active - check get_combat_state first, since this always creates an additional encounter. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        tokenIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of Token document IDs to add as combatants. Defaults to all tokens on the scene.',
        },
        sceneId: {
          type: 'string',
          description: 'Optional Scene document ID; defaults to the active scene.',
        },
      },
    },
  },
];

/**
 * Token read tools (query-only; mirrors list_walls/list_tiles). No
 * FOUNDRY_WRITE_ENABLED gate - these only read the cached worldData.
 */
export const tokenTools = [
  {
    name: 'list_tokens',
    description:
      "List the Tokens placed on a scene (id, display name, linked actorId, x/y pixel position, width/height in grid cells, elevation, rotation, hidden, disposition), defaulting to the active scene when sceneId is omitted. Read from cached worldData - no canvas access needed. Use when: you need to know what's on the map and where before moving, targeting, or applying an effect to a token, or to resolve a token's id from its name instead of asking the user. Do not use when: you need wall or tile layout instead - use list_walls/list_tiles.",
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID; defaults to the active scene',
        },
      },
    },
  },
];

/**
 * Token manipulation mutation tool definitions (FR-019)
 *
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active Socket.IO
 * connection (mutations use the core `modifyDocument` protocol). The connected
 * user needs GM/owner permission.
 */
export const tokenMutationTools = [
  {
    name: 'move_token',
    description:
      'Move a token to new x/y pixel coordinates on its scene; the token is located across scenes by id, optionally scoped with sceneId. Coordinates are absolute pixels, not grid squares and not offsets. Use when: repositioning a token to a position the user has given you, or one computed from list_tokens (current positions) and get_scene_info (grid size). Do not use when: repositioning several tokens at once - use move_tokens; or the destination may be blocked by a wall/door - use move_token_pathfind, which routes around them instead of teleporting through. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: {
          type: 'string',
          description: 'The ID of the token to move',
        },
        x: {
          type: 'number',
          description: 'Target x pixel coordinate on the scene',
        },
        y: {
          type: 'number',
          description: 'Target y pixel coordinate on the scene',
        },
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID to scope the token lookup',
        },
      },
      required: ['tokenId', 'x', 'y'],
    },
  },
  {
    name: 'apply_status_effect',
    description:
      'Apply or remove a status condition (e.g. "prone", "stunned") on a token\'s actor. Set active=false to remove. Matches by status id, so re-applying or clearing-when-absent is a no-op. Use when: a condition is gained or lost. Do not use when: changing numeric state such as HP or exhaustion - use update_actor_attributes. ' +
      WRITE_GATE +
      ' Exception: the no-op cases (applying an already-present status, or clearing an absent one) report success without attempting a write, so they also return normally while writes are disabled.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: {
          type: 'string',
          description: 'The ID of the token whose actor to affect',
        },
        statusId: {
          type: 'string',
          description: "The status condition id (e.g. 'prone', 'stunned', 'blinded')",
        },
        active: {
          type: 'boolean',
          description: 'true to apply the effect (default), false to remove it',
          default: true,
        },
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID to scope the token lookup',
        },
      },
      required: ['tokenId', 'statusId'],
    },
  },
  {
    name: 'spawn_token',
    description:
      "Place a new token for an existing actor onto a scene at given x/y pixel coordinates, defaulting to the active scene when sceneId is omitted. Base display fields (texture, size, vision) are seeded from the actor's prototypeToken. Use when: a monster, NPC, or reinforcement needs to appear on the map. Do not use when: repositioning a token that is already on the scene - use move_token. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: {
          type: 'string',
          description: 'The ID of the actor the new token represents',
        },
        x: {
          type: 'number',
          description: 'Target x pixel coordinate on the scene',
        },
        y: {
          type: 'number',
          description: 'Target y pixel coordinate on the scene',
        },
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID; defaults to the active scene',
        },
        name: {
          type: 'string',
          description: "Optional display name override; defaults to the actor's name",
        },
        hidden: {
          type: 'boolean',
          description: 'Optional; true to place the token hidden from players',
        },
      },
      required: ['actorId', 'x', 'y'],
    },
  },
  {
    name: 'delete_token',
    description:
      "Remove a token from a scene without deleting the underlying actor. Use when: a monster is defeated and removed from the battle, or a token was placed by mistake. Do not use when: the actor document itself should be deleted - use delete_world_actor; this only removes the token's placement on the map. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: {
          type: 'string',
          description: 'The ID of the token to remove',
        },
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID to scope the token lookup',
        },
      },
      required: ['tokenId'],
    },
  },
  {
    name: 'move_token_pathfind',
    description:
      "Move a token to x/y coordinates, routing around impassable walls when the direct line is blocked (A* pathfinding over the scene's Wall geometry), and — unless openDoors is false — opening any closed doors the route needs to cross. Slower and more expensive than move_token (issues one document update per waypoint, with a short pause per door opened), and its wall detection covers ordinary geometric walls only, not anything canvas-only would also enforce (terrain height, drawing-based obstacles). Use when: a token should walk realistically around obstacles instead of teleporting through them, especially when doors are involved. Do not use when: the destination is in the open with nothing between - use move_token, which is one write instead of many. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: {
          type: 'string',
          description: 'The ID of the token to move',
        },
        x: {
          type: 'number',
          description: 'Target x pixel coordinate on the scene',
        },
        y: {
          type: 'number',
          description: 'Target y pixel coordinate on the scene',
        },
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID to scope the token lookup',
        },
        openDoors: {
          type: 'boolean',
          description: 'Whether to open closed doors blocking the route (default true)',
          default: true,
        },
      },
      required: ['tokenId', 'x', 'y'],
    },
  },
  {
    name: 'move_tokens',
    description:
      "Move several tokens in a single call - direct by default (like move_token), or wall-aware pathfinding per move when pathfind=true (like move_token_pathfind). Best-effort: one bad move (unknown tokenId, no route found, a rejected write) is reported in a failure list rather than losing moves that already succeeded. Use when: repositioning a whole party or group of NPCs at once - e.g. moving everyone into a room, or resetting an encounter's starting positions - instead of one move_token/move_token_pathfind call per token. Do not use when: moving a single token - move_token/move_token_pathfind is simpler. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        moves: {
          type: 'array',
          description: 'One or more token moves to perform in this call',
          items: {
            type: 'object',
            properties: {
              tokenId: {
                type: 'string',
                description: 'The ID of the token to move',
              },
              x: {
                type: 'number',
                description: 'Target x pixel coordinate on the scene',
              },
              y: {
                type: 'number',
                description: 'Target y pixel coordinate on the scene',
              },
              sceneId: {
                type: 'string',
                description: 'Optional Scene ID to scope the token lookup',
              },
              pathfind: {
                type: 'boolean',
                description:
                  'Route around walls/doors instead of a straight line, like move_token_pathfind (default false)',
                default: false,
              },
              openDoors: {
                type: 'boolean',
                description:
                  'When pathfind is true, whether to open closed doors blocking the route (default true)',
                default: true,
              },
            },
            required: ['tokenId', 'x', 'y'],
          },
          minItems: 1,
        },
      },
      required: ['moves'],
    },
  },
  {
    name: 'update_token_vision',
    description:
      "Update an existing placed token's vision and/or light emission properties (sight range, angle, vision mode, light dim/bright radii, color tint, angle, animation). " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: {
          type: 'string',
          description: 'The ID of the token to update',
        },
        sceneId: {
          type: 'string',
          description: 'Optional Scene ID to scope the token lookup',
        },
        sightEnabled: {
          type: 'boolean',
          description:
            'Whether vision is enabled for this token (automatically set true if sightRange > 0)',
        },
        sightRange: {
          type: 'number',
          description: 'Token vision range in grid units',
        },
        sightAngle: {
          type: 'number',
          description: 'Vision cone angle in degrees (default 360)',
        },
        visionMode: {
          type: 'string',
          description: 'Vision mode id (e.g. "basic", "darkvision")',
        },
        lightDim: {
          type: 'number',
          description: 'Dim light emission radius in grid units',
        },
        lightBright: {
          type: 'number',
          description: 'Bright light emission radius in grid units',
        },
        lightColor: {
          type: 'string',
          description: 'Light emission color as a 6-digit hex string (e.g. "#ff8800")',
        },
        lightAngle: {
          type: 'number',
          description: 'Light emission angle in degrees (default 360)',
        },
        lightAnimationType: {
          type: 'string',
          description: 'Light animation type (e.g. "torch", "pulse", "chroma")',
        },
      },
      required: ['tokenId'],
    },
  },
];

/**
 * Chat message tool definitions
 */
export const chatTools = [
  {
    name: 'get_chat_messages',
    description:
      'Get the most recent chat messages from the game log. Use when: you need recent in-game context - what players said, or roll results that already happened.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of messages to retrieve (default 20)',
          default: 20,
          minimum: 1,
          maximum: 100,
        },
      },
    },
  },
];

/**
 * Chat message mutation tool definitions
 *
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active
 * Socket.IO connection (mutations use the core `modifyDocument` protocol).
 */
export const chatMutationTools = [
  {
    name: 'send_chat_message',
    description:
      'Post a message to the FoundryVTT chat log, optionally under a custom speaker name, whispered to specific users, and/or styled as out-of-character, in-character, or an emote (default: a plain system-style message). Use when: narrating a scene, speaking as an NPC, or sending a player a private clue. Do not use when: you only need to read recent chat - use get_chat_messages. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Message body (HTML or plain text)',
        },
        speaker: {
          type: 'string',
          description: 'Optional display name shown as the speaker (e.g. an NPC name)',
        },
        whisperTo: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of User document ids to whisper the message to privately',
        },
        style: {
          type: 'string',
          enum: ['ooc', 'ic', 'emote'],
          description:
            "Message style. Omit for a plain message; 'ooc' out-of-character, 'ic' in-character, 'emote' an emote/action line.",
        },
      },
      required: ['content'],
    },
  },
];

/**
 * User tool definitions
 */
export const userTools = [
  {
    name: 'get_users',
    description:
      "List the world's users with their roles and online status. Online status is live while the Socket.IO connection is up: FoundryVTT's userActivity broadcasts are applied to the cached presence list as users connect and disconnect. It stops tracking if that connection drops and the missed changes are not replayed - get_health_status shows the snapshot as stale, and refresh_world_data resyncs it. Use when: you need to know which user holds the GM role, or who is connected right now.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'set_user_role',
    description:
      'Change a user\'s permission role ("none", "player", "trusted", "assistant", "gamemaster"). Refuses self-demotion of the connected MCP user below assistant (3) to prevent accidental GM lockout. ' +
      CONFIRM_FIRST +
      ' ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: '16-char alphanumeric User document id' },
        role: {
          type: 'string',
          enum: ['none', 'player', 'trusted', 'assistant', 'gamemaster'],
          description: 'New role level for the user',
        },
      },
      required: ['userId', 'role'],
    },
  },
];

/**
 * Journal tool definitions
 */
export const journalTools = [
  {
    name: 'search_journals',
    description:
      'Search journal entries by name and page content. Use when: looking for notes, lore, or handouts by keyword. Do not use when: you already have the journalId - use get_journal.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for journal names and content',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results',
          default: 10,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_journal',
    description:
      'Get one journal entry by id with the id and text of each page. By default page bodies are HTML-stripped and each is truncated to its first 500 characters, marked with a trailing "...", so long pages come back partial, and they come from the cached snapshot (flagged when it is stale). Pass raw: true to read the entry from the server instead, with the full, unmodified HTML and the version token of each page (version: <token>) - the expectedVersion update_journal_page requires to replace the content of that page. Use when: you have a journalId and need the text of its pages, or a pageId and the exact current HTML before editing a page with update_journal_page. Do not use when: you only have a title or keyword - run search_journals first.',
    inputSchema: {
      type: 'object',
      properties: {
        journalId: {
          type: 'string',
          description: 'The ID of the journal entry to retrieve',
        },
        raw: {
          type: 'boolean',
          description:
            "Read the entry from the server and return each page's full, unmodified HTML (text.content) and version token instead of the stripped 500-character preview. Use before rewriting a page so no markup or text is lost, and pass the page's version to update_journal_page as expectedVersion.",
          default: false,
        },
      },
      required: ['journalId'],
    },
  },
];

/**
 * Journal mutation tool definitions (WRITE)
 */
export const journalMutationTools = [
  {
    name: 'create_journal_entry',
    description:
      'Create a new journal entry with one or more text pages, optionally filed under a folder. Defaults to GM-only visibility - pass visibility to let players read it. Use when: recording session notes, lore, or a handout in the world. Returns the id and version token of each created page. Do not use when: adding text to an existing entry - this always creates a new one. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Title of the journal entry',
        },
        pages: {
          type: 'array',
          description: 'One or more pages to create on the entry',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Page title',
              },
              content: {
                type: 'string',
                description: 'Page body as HTML or plain text',
              },
            },
            required: ['name', 'content'],
          },
          minItems: 1,
        },
        folder: {
          type: 'string',
          description: 'Optional Folder document id to file the entry under',
        },
        visibility: {
          type: 'string',
          enum: ['gm-only', 'observer', 'owner'],
          description:
            "Who can see the entry. 'gm-only' (default) hides it from players; 'observer' lets every player read it; 'owner' lets every player read and edit it.",
        },
      },
      required: ['name', 'pages'],
    },
  },
  {
    name: 'update_journal_page',
    description:
      'Edit one page of an existing journal entry. mode "replace" (default) sets a new name and/or replaces the whole page content; mode "append" adds HTML to the end of the page as currently stored on the server. Replacing content requires expectedVersion: read the page with get_journal raw: true, rewrite from that HTML, and pass the version printed for the page - the write is refused, with nothing written, if the page changed since. Every write saves the previous content to a local copy first, and returns the new version token so another edit can follow without re-reading. The response warns when the page looks open in a FoundryVTT editor, whose autosave can overwrite the write (FoundryVTT does not report an editor closing, so the warning can outlast it by a few minutes). Use when: correcting, rewriting, or extending session notes, lore, or a handout page. Do not use when: adding a separate new page - use add_journal_page; renaming or moving the entry itself - use update_journal_entry. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        journalId: {
          type: 'string',
          description: 'The ID of the journal entry that holds the page',
        },
        pageId: {
          type: 'string',
          description: 'The ID of the page to edit (shown by get_journal)',
        },
        mode: {
          type: 'string',
          enum: ['replace', 'append'],
          description:
            "'replace' (default) overwrites the page content with content (expectedVersion required) and/or renames it; 'append' adds content after the existing content as read from the server (name not allowed).",
          default: 'replace',
        },
        name: {
          type: 'string',
          description: 'New page title (replace mode only)',
        },
        content: {
          type: 'string',
          description:
            'Page body as HTML or plain text. In replace mode it replaces the entire page content; in append mode it is added at the end.',
        },
        expectedVersion: {
          type: 'string',
          description:
            'Version token of the page as last read (get_journal raw: true, or the version returned by the previous write). Required to replace content; optional in append mode. The write is refused if the page has changed since.',
        },
      },
      required: ['journalId', 'pageId'],
    },
  },
  {
    name: 'add_journal_page',
    description:
      'Add a new text page to an existing journal entry, placed after its last page as read from the server. Returns the new page id and version token. Use when: a journal needs another section (a new session, an NPC, a location). Do not use when: the entry does not exist yet - use create_journal_entry; changing an existing page - use update_journal_page. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        journalId: {
          type: 'string',
          description: 'The ID of the journal entry to add the page to',
        },
        name: {
          type: 'string',
          description: 'Page title',
        },
        content: {
          type: 'string',
          description: 'Page body as HTML or plain text',
        },
      },
      required: ['journalId', 'name', 'content'],
    },
  },
  {
    name: 'update_journal_entry',
    description:
      'Rename a journal entry, move it into another folder, or change who can see it. Only the fields supplied change. Use when: retitling notes, filing them under a folder, or revealing a handout to players. Do not use when: changing page text - use update_journal_page; granting a specific user access - use set_document_ownership. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        journalId: {
          type: 'string',
          description: 'The ID of the journal entry to update',
        },
        name: {
          type: 'string',
          description: 'New title of the journal entry',
        },
        folder: {
          type: 'string',
          description: 'Folder document id to move the entry into',
        },
        visibility: {
          type: 'string',
          enum: ['gm-only', 'observer', 'owner'],
          description:
            "Who can see the entry. 'gm-only' hides it from players; 'observer' lets every player read it; 'owner' lets every player read and edit it. Per-user ownership is kept.",
        },
      },
      required: ['journalId'],
    },
  },
  {
    name: 'delete_journal_entry',
    description:
      'Permanently delete a journal entry. Use when: the user explicitly asks to remove outdated notes or a handout. Do not use when: only the content, title, folder or visibility needs to change - use update_journal_page, add_journal_page or update_journal_entry instead. ' +
      CONFIRM_FIRST +
      ' ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        journalId: {
          type: 'string',
          description: 'The ID of the journal entry to delete',
        },
      },
      required: ['journalId'],
    },
  },
];

/**
 * World-level tool definitions
 */
export const worldTools = [
  {
    name: 'search_world',
    description:
      'Search across all collections (actors, items, scenes, journals) by name, grouped by collection. Use when: you do not know which collection holds what you are looking for. Do not use when: you already know the collection - use search_actors, search_items, or search_journals. Of those, only search_journals prints document ids; for actor and item ids read the foundry://actors and foundry://items resources, each of which lists up to the first 100 documents (not exhaustive in larger worlds).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to match against entity names',
        },
        limit: {
          type: 'number',
          description: 'Maximum results per collection (default 5)',
          default: 5,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_world_summary',
    description:
      'Get world metadata (title, game system, core version) and per-collection document counts. Use when: orienting yourself in an unfamiliar world, or confirming the game system before system-specific edits.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'refresh_world_data',
    description:
      'Force a re-fetch of the cached world data from the FoundryVTT server. Reads are normally served from a cache that follows live document changes for as long as the connection holds, so this is rarely needed. Use when: the connection dropped and came back - the cache stopped following changes while it was down and nothing replays them, so it stays a point-in-time copy until this runs, and get_health_status flags it as stale until then; or a read still looks stale after an out-of-band change - notably edits to unlinked (synthetic) token actors, which the live update feed does not cover. Refreshes the cache only; it does not modify the world.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * World document read tools (folders, macros, playlists).
 */
export const worldDocumentTools = [
  {
    name: 'list_folders',
    description:
      'List sidebar folders in the world (id, name, document type, parent folder id, color), optionally filtered by document type (Actor, Item, Scene, JournalEntry, Playlist, RollTable, Cards, Macro, Compendium).',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Optional document type filter (e.g. "Actor", "JournalEntry", "Item")',
        },
      },
    },
  },
  {
    name: 'list_macros',
    description:
      'List Macro documents in the world (id, name, type script/chat, scope, folder, command preview). Use when: discovering available macros or finding a macroId for delete_macro.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_playlists',
    description:
      'List Audio Playlists in the world (id, name, playing state, mode sequential/shuffle/simultaneous, channel, sound track list). Use when: checking background music/ambience state or getting ids for set_playlist_state.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * World document mutation tools (folders, macros, playlists).
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active Socket.IO connection.
 */
export const worldDocumentMutationTools = [
  {
    name: 'create_folder',
    description:
      'Create a new sidebar Folder document to organize actors, items, scenes, journals, playlists, tables, or macros. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Folder display name' },
        type: {
          type: 'string',
          description:
            'Document type this folder contains: "Actor", "Item", "Scene", "JournalEntry", "Playlist", "RollTable", "Cards", "Macro", or "Compendium"',
        },
        parent: {
          type: 'string',
          description: 'Optional parent Folder ID for nested folder hierarchies',
        },
        color: {
          type: 'string',
          description: 'Optional folder color as a 6-digit hex string (e.g. "#ff0000")',
        },
        sorting: {
          type: 'string',
          enum: ['a', 'm'],
          description: 'Sorting mode: "a" (alphabetical, default) or "m" (manual)',
          default: 'a',
        },
      },
      required: ['name', 'type'],
    },
  },
  {
    name: 'create_macro',
    description:
      'Create a new Macro document (script or chat). Authors and manages the document only — this server has no tool that executes a macro (deliberate security boundary: no arbitrary JS execution in GM browser). ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Macro display name' },
        type: {
          type: 'string',
          enum: ['script', 'chat'],
          description: 'Macro type: "script" (JavaScript) or "chat" (chat command)',
        },
        command: { type: 'string', description: 'Macro command content/script body' },
        folder: { type: 'string', description: 'Optional Folder ID to file the macro under' },
        img: { type: 'string', description: 'Optional icon image path' },
        scope: {
          type: 'string',
          enum: ['global', 'actors', 'actor'],
          description: 'Macro execution scope (default "global")',
          default: 'global',
        },
      },
      required: ['name', 'type', 'command'],
    },
  },
  {
    name: 'delete_macro',
    description: `Permanently delete a Macro document from the world. ${CONFIRM_FIRST} ${WRITE_GATE}`,
    inputSchema: {
      type: 'object',
      properties: {
        macroId: { type: 'string', description: 'The ID of the macro to delete' },
      },
      required: ['macroId'],
    },
  },
  {
    name: 'create_playlist',
    description: `Create a new audio Playlist document with optional starting sound tracks. ${WRITE_GATE}`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Playlist display name' },
        description: { type: 'string', description: 'Optional playlist description' },
        mode: {
          type: 'number',
          enum: [-1, 0, 1, 2],
          description:
            'Playback mode: -1 (soundboard/disabled), 0 (sequential/default), 1 (shuffle), 2 (simultaneous)',
          default: 0,
        },
        channel: {
          type: 'string',
          enum: ['music', 'environment', 'interface'],
          description: 'Audio channel (default "music")',
          default: 'music',
        },
        fade: { type: 'number', description: 'Fade duration in milliseconds' },
        folder: { type: 'string', description: 'Optional Folder ID to file the playlist under' },
        sounds: {
          type: 'array',
          description: 'Optional sound tracks to create on this playlist',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Track display name' },
              path: {
                type: 'string',
                description: 'Audio file path (e.g. "assets/audio/bgm.mp3")',
              },
              volume: {
                type: 'number',
                description: 'Track volume 0.0 to 1.0 (default 0.5)',
                default: 0.5,
              },
              repeat: {
                type: 'boolean',
                description: 'Whether the track loops (default false)',
                default: false,
              },
            },
            required: ['name', 'path'],
          },
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'set_playlist_state',
    description:
      'Start or stop playback of an entire playlist or a specific sound track within it. Drives Foundry playback state; client autoplay policies may affect audio output. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        playlistId: { type: 'string', description: 'The ID of the playlist to control' },
        playing: { type: 'boolean', description: 'true to start playback, false to stop' },
        soundId: {
          type: 'string',
          description:
            'Optional PlaylistSound ID to control a specific track instead of the entire playlist',
        },
      },
      required: ['playlistId', 'playing'],
    },
  },
  {
    name: 'delete_playlist',
    description:
      'Permanently delete an audio Playlist document and its contained sounds. ' +
      CONFIRM_FIRST +
      ' ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        playlistId: { type: 'string', description: 'The ID of the playlist to delete' },
      },
      required: ['playlistId'],
    },
  },
  {
    name: 'set_document_ownership',
    description:
      'Configure granular ownership permissions for a document. entries maps user IDs (or "default" for all players) to permission levels: "none" (0), "limited" (1), "observer" (2), "owner" (3). Document types supported: Actor, Item, Scene, JournalEntry, RollTable, Macro. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        documentType: {
          type: 'string',
          enum: ['Actor', 'Item', 'Scene', 'JournalEntry', 'RollTable', 'Macro'],
          description: 'Document collection the target lives in',
        },
        documentId: { type: 'string', description: '16-char alphanumeric document id' },
        entries: {
          type: 'array',
          description: 'List of target and ownership level mappings',
          items: {
            type: 'object',
            properties: {
              target: {
                type: 'string',
                description: '16-char User ID, or "default" for all players',
              },
              level: {
                type: 'string',
                enum: ['none', 'limited', 'observer', 'owner'],
                description: 'Permission level to grant',
              },
            },
            required: ['target', 'level'],
          },
          minItems: 1,
        },
      },
      required: ['documentType', 'documentId', 'entries'],
    },
  },
];

/**
 * Roll table tool definitions
 *
 * Neither tool mutates the world; `roll_table` draws locally against cached
 * table data and does not require FOUNDRY_WRITE_ENABLED.
 */
export const rollTableTools = [
  {
    name: 'list_roll_tables',
    description:
      "List the world's roll tables by name, result count, and id. Use when: you need a tableId for roll_table, or want to see what random tables are available. Do not use when: you already have the tableId - go straight to roll_table.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'roll_table',
    description:
      "Draw a result from a roll table by id, rolling the table's own formula (or a uniform range when it has none) and returning the matched entry. This is a local, read-only draw: unlike FoundryVTT's own table draw, it does not mark the result as drawn or honor a no-duplicates setting, so repeat draws can repeat a result. Use when: rolling on a random encounter, loot, or event table. Do not use when: you don't have a tableId - run list_roll_tables first.",
    inputSchema: {
      type: 'object',
      properties: {
        tableId: {
          type: 'string',
          description: 'The ID of the roll table to draw from',
        },
      },
      required: ['tableId'],
    },
  },
  {
    name: 'create_roll_table',
    description:
      'Create a new RollTable document with text results. Automatically assigns sequential ranges and a matching 1dN formula when ranges are omitted. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Roll table display name' },
        results: {
          type: 'array',
          description: 'List of text result entries for this table',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Result text description' },
              weight: { type: 'number', description: 'Relative weight (default 1)', default: 1 },
              range: {
                type: 'array',
                items: { type: 'number' },
                description:
                  'Optional roll range [low, high] (e.g. [1, 2]). Auto-assigned if omitted on all results.',
              },
            },
            required: ['text'],
          },
          minItems: 1,
        },
        description: { type: 'string', description: 'Optional table description' },
        formula: {
          type: 'string',
          description: 'Optional custom dice formula (e.g. "1d100" or "2d6")',
        },
        replacement: {
          type: 'boolean',
          description: 'Whether drawn results are replaced (default true)',
          default: true,
        },
        displayRoll: {
          type: 'boolean',
          description: 'Whether the roll total is displayed in chat (default true)',
          default: true,
        },
        folder: { type: 'string', description: 'Optional Folder ID to file the table under' },
      },
      required: ['name', 'results'],
    },
  },
  {
    name: 'delete_roll_table',
    description: `Permanently delete a RollTable document from the world. ${CONFIRM_FIRST} ${WRITE_GATE}`,
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'The ID of the roll table to delete' },
      },
      required: ['tableId'],
    },
  },
];

/**
 * World settings tool definitions
 */
export const settingsTools = [
  {
    name: 'get_world_setting',
    description:
      'Read a world setting by its namespaced key (e.g. "cyberpunk-red-core.customSetting" or "simple-calendar.year"). If the setting has never been modified from its system/module default, exists will be false. Use when: inspecting world configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The namespaced setting key in the format {scope}.{field}',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'set_world_setting',
    description:
      'Update or create a world setting value for a system or module namespace (e.g. "cyberpunk-red-core.settingName"). Refuses writes to the "core.*" namespace (core settings control the Foundry client itself and can break the world; change those in the UI). ' +
      CONFIRM_FIRST +
      ' ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The namespaced setting key in the format {scope}.{field} (non-core only)',
        },
        value: {
          description:
            'The value to store (JSON-serializable: string, number, boolean, object, or array)',
        },
      },
      required: ['key', 'value'],
    },
  },
];

/**
 * Module-bridge tool definitions
 *
 * Relayed through the companion Foundry module (a real, rendered browser
 * tab) rather than FoundryVTT's own Socket.IO document API - the only path
 * to canvas/PIXI-only capabilities. Requires FOUNDRY_MODULE_BRIDGE_ENABLED=true
 * and the module installed, enabled, and connected; fails clearly otherwise.
 */
export const moduleBridgeTools = [
  {
    name: 'capture_scene',
    description:
      "Screenshot the active scene as seen on the GM's canvas, with a grid coordinate overlay (column,row per cell) burned in for spatial reasoning. Requires the companion Foundry module to be installed, enabled, and connected - fails with a clear error otherwise. Use when: you need to see the current map layout, token positions, or lighting to reason about it. Do not use when: you just need scene metadata (dimensions, darkness) - use get_scene_info, which needs no module.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_document_schema',
    description:
      "Introspect the connected game system's real DataModel schema for an Actor or Item type - the exact field names, types, string-enum choices, and default values that type accepts, read live from the running system (works for any installed system - Cyberpunk RED, D&D 5e, PF2e, etc - not a hardcoded list). Returns a nested JSON tree: each field has `type` (Number/String/Boolean/Schema/Array/…), `required`, `choices` for constrained strings, and `initial` for its default value; `fields` holds nested sub-fields, `element` describes an array's entries. Requires the companion Foundry module to be installed, enabled, and connected - fails with a clear error otherwise. Use when: building a `system` payload for create_world_actor/create_actor_item/create_full_actor and you do not already know that type's exact field names - call this once per type, then reuse the answer. Do not use when: you already know the schema from a prior call in this session - re-querying wastes a round trip; the schema does not change during a session.",
    inputSchema: {
      type: 'object',
      properties: {
        documentType: {
          type: 'string',
          enum: ['Actor', 'Item'],
          description: 'Which document collection the type belongs to',
        },
        type: {
          type: 'string',
          description:
            'The Actor or Item type to introspect (e.g. "character", "npc", "weapon", "spell") - system-specific; list valid types by trying an obviously-wrong one, or check get_world_summary/the system documentation',
        },
      },
      required: ['documentType', 'type'],
    },
  },
  {
    name: 'search_compendium_content',
    description:
      'Search compendium packs by name and journal entry text content using the browser-rendered Foundry session. Returns pack IDs, document IDs, names, and text snippet matches. Requires the companion Foundry module to be installed, enabled, and connected. Use when: looking up rules or items in compendiums.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text query to search for across pack names and journal contents',
        },
        packType: {
          type: 'string',
          description:
            'Optional document type to restrict search to (default "JournalEntry", e.g. "Item", "Actor")',
          default: 'JournalEntry',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default 20)',
          default: 20,
        },
      },
    },
  },
  {
    name: 'roll_and_post',
    description:
      'Evaluate a dice formula using Foundry\'s native Roll engine and post it directly to chat as a rendered, clickable roll card. Supports full Foundry dice syntax (e.g. "4d6kh3", "1d20r1", exploding dice) that the local parser rejects. Requires the companion Foundry module.',
    inputSchema: {
      type: 'object',
      properties: {
        formula: {
          type: 'string',
          description: 'Dice formula to evaluate and post (e.g. "4d6kh3" or "2d6 + 5")',
        },
        flavor: {
          type: 'string',
          description: 'Optional flavor/context text displayed above the roll card',
        },
        speakerAlias: {
          type: 'string',
          description: 'Optional custom speaker alias displayed on the chat message',
        },
        whisperTo: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of User IDs to whisper the roll to privately',
        },
        rollMode: {
          type: 'string',
          enum: ['publicroll', 'gmroll', 'blindroll', 'selfroll'],
          description: 'Roll visibility mode (default "publicroll")',
          default: 'publicroll',
        },
      },
      required: ['formula'],
    },
  },
  {
    name: 'import_compendium_actor',
    description:
      'Import a compendium Actor (with its embedded items and effects) as a new top-level world Actor - the gap spawn_token cannot close alone, since it requires an actor that already exists in the world. Best-effort on embedded items: if the game system rejects embedded documents on create, the actor is recreated without them and each item is seeded individually, reporting per-item failures rather than losing the whole import. Requires the companion Foundry module. Use when: adding a monster or NPC from a compendium to the world before spawning its token. Do not use when: the actor already exists in the world - use spawn_token directly.' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        compendiumId: {
          type: 'string',
          description: 'Compendium pack id the actor lives in (e.g. "dnd5e.monsters")',
        },
        actorId: {
          type: 'string',
          description: "The compendium document's own id, as returned by search_compendium_content",
        },
        folderId: {
          type: 'string',
          description: 'Optional 16-char Folder document id to file the new world actor under',
        },
        name: {
          type: 'string',
          description: 'Optional rename for the world actor (default: the compendium name)',
        },
      },
      required: ['compendiumId', 'actorId'],
    },
  },
  {
    name: 'set_target',
    description:
      "Set or clear this GM user's target selection on the active canvas (renders the targeting reticle in connected player browsers). tokenIds are token document IDs on the currently viewed scene. Requires the companion Foundry module. Use when: directing player attention, declaring spell targets, or marking focus fire. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        tokenIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of Token IDs on the active canvas to target (or un-target)',
        },
        targeted: {
          type: 'boolean',
          description: 'True to target, false to clear target on the given tokens (default: true)',
          default: true,
        },
        replace: {
          type: 'boolean',
          description:
            'True to release all existing targets before setting new ones (default: false)',
          default: false,
        },
      },
      required: ['tokenIds'],
    },
  },
  {
    name: 'get_targets',
    description:
      'List the current target selections of all connected users on the active canvas. Returns each user with the tokens they currently have targeted. Requires the companion Foundry module. Use when: checking who players are aiming at or focusing on.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ping_canvas',
    description:
      "Emit an animated canvas ping at specific pixel coordinates on the active scene's view, drawing every connected player's camera and attention to that exact location. Requires the companion Foundry module. Use when: pointing out a trap, landmark, or hidden detail on the map. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Pixel x coordinate to ping' },
        y: { type: 'number', description: 'Pixel y coordinate to ping' },
        sceneId: {
          type: 'string',
          description: 'Optional scene id (fails if the GM canvas is viewing a different scene)',
        },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'set_pause',
    description:
      'Pause or unpause the game clock. When paused, token movement and real-time combat timers freeze for players. Requires the companion Foundry module. Use when: stepping away, narrating a long cutscene, or resolving a complex rules question. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        paused: {
          type: 'boolean',
          description: 'True to pause, false to unpause (omit to toggle)',
        },
      },
    },
  },
  {
    name: 'upload_asset',
    description:
      "Upload a file (image, audio, etc.) into FoundryVTT's Data storage via the GM browser's FilePicker, returning the Foundry-relative path to feed directly into create_scene (backgroundSrc), create_tile (src), or create_sound (path). Provide exactly one of contentBase64 (base64-encoded file content) or sourcePath (an absolute path readable by this MCP server, which base64-encodes it server-side). Rejects payloads over 8 MiB. Requires the companion Foundry module. Use when: adding new map art, tokens, or audio the world does not already have. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        targetDir: {
          type: 'string',
          description: 'Data-relative destination folder (e.g. "assets/uploads")',
        },
        filename: {
          type: 'string',
          description: 'Destination filename, including extension',
        },
        contentBase64: {
          type: 'string',
          description: 'Base64-encoded file content. Mutually exclusive with sourcePath.',
        },
        sourcePath: {
          type: 'string',
          description:
            'Absolute filesystem path readable by this MCP server. Mutually exclusive with contentBase64.',
        },
        mimeType: {
          type: 'string',
          description:
            'Optional MIME type override; inferred from the filename extension if omitted',
        },
      },
      required: ['targetDir', 'filename'],
      oneOf: [{ required: ['contentBase64'] }, { required: ['sourcePath'] }],
    },
  },
];

/**
 * General-purpose ActiveEffect tool definitions
 *
 * `apply_status_effect` (tokenMutationTools) stays the simpler, idempotent
 * status-toggle contract; these exist for mechanical buffs/debuffs with real
 * `changes`/`duration`.
 */
export const effectTools = [
  {
    name: 'create_actor_effect',
    description:
      "Create a general-purpose ActiveEffect on an actor with mechanical changes (attribute modifiers) and/or a duration - not just a status toggle (use apply_status_effect for that). Give actorId alone for a world-linked actor, or actorId plus the sceneId+tokenId pair together for an unlinked token's synthetic actor. changes[].mode is a named FoundryVTT ACTIVE_EFFECT_MODES combine rule (add/multiply/override/upgrade/downgrade/custom), not a raw number. Use when: applying a spell buff, a debuff, or an equipment bonus with a real mechanical effect. Do not use when: toggling a simple named condition (prone, stunned) - use apply_status_effect. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: { type: 'string', description: "The actor's own document id" },
        sceneId: {
          type: 'string',
          description: 'Scene id, required together with tokenId for an unlinked token actor',
        },
        tokenId: {
          type: 'string',
          description: 'Token id, required together with sceneId for an unlinked token actor',
        },
        name: { type: 'string', description: 'Effect display name' },
        img: { type: 'string', description: 'Optional icon image path' },
        description: { type: 'string', description: 'Optional effect description text' },
        disabled: {
          type: 'boolean',
          description: 'Create the effect already disabled (default false)',
        },
        statuses: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional status condition ids this effect also represents',
        },
        duration: {
          type: 'object',
          description: 'Optional effect duration',
          properties: {
            rounds: { type: 'number' },
            turns: { type: 'number' },
            seconds: { type: 'number' },
            startRound: { type: 'number' },
            startTurn: { type: 'number' },
          },
        },
        changes: {
          type: 'array',
          description: 'Mechanical changes this effect applies',
          items: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description:
                  'Dot-path into the actor being modified (e.g. "system.attributes.hp.max")',
              },
              mode: {
                type: 'string',
                enum: ['custom', 'multiply', 'add', 'downgrade', 'upgrade', 'override'],
                description: 'How this change combines with the base value',
              },
              value: { type: 'string', description: 'Change value (always a string on the wire)' },
              priority: {
                type: 'number',
                description: 'Optional application order (default: mode order)',
              },
            },
            required: ['key', 'mode', 'value'],
          },
        },
      },
      required: ['actorId', 'name'],
    },
  },
  {
    name: 'update_actor_effect',
    description:
      "Update fields on an existing ActiveEffect - every field replaces the corresponding one on the existing document, omitted fields are left as they are. Same actorId/sceneId+tokenId resolution as create_actor_effect. Use when: a buff's remaining duration changes, or its magnitude scales. Do not use when: the effect should end - use delete_actor_effect. " +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: { type: 'string', description: "The actor's own document id" },
        sceneId: {
          type: 'string',
          description: 'Scene id, required together with tokenId for an unlinked token actor',
        },
        tokenId: {
          type: 'string',
          description: 'Token id, required together with sceneId for an unlinked token actor',
        },
        effectId: { type: 'string', description: 'The ActiveEffect document id to update' },
        name: { type: 'string', description: 'New effect display name' },
        img: { type: 'string', description: 'New icon image path' },
        description: { type: 'string', description: 'New effect description text' },
        disabled: { type: 'boolean', description: 'Enable/disable the effect' },
        statuses: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replacement status condition ids',
        },
        duration: {
          type: 'object',
          description: 'Replacement effect duration',
          properties: {
            rounds: { type: 'number' },
            turns: { type: 'number' },
            seconds: { type: 'number' },
            startRound: { type: 'number' },
            startTurn: { type: 'number' },
          },
        },
        changes: {
          type: 'array',
          description: 'Replacement mechanical changes',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              mode: {
                type: 'string',
                enum: ['custom', 'multiply', 'add', 'downgrade', 'upgrade', 'override'],
              },
              value: { type: 'string' },
              priority: { type: 'number' },
            },
            required: ['key', 'mode', 'value'],
          },
        },
      },
      required: ['actorId', 'effectId'],
    },
  },
  {
    name: 'delete_actor_effect',
    description:
      'Delete an ActiveEffect from an actor. Same actorId/sceneId+tokenId resolution as create_actor_effect. ' +
      CONFIRM_FIRST +
      ' ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: { type: 'string', description: "The actor's own document id" },
        sceneId: {
          type: 'string',
          description: 'Scene id, required together with tokenId for an unlinked token actor',
        },
        tokenId: {
          type: 'string',
          description: 'Token id, required together with sceneId for an unlinked token actor',
        },
        effectId: { type: 'string', description: 'The ActiveEffect document id to delete' },
      },
      required: ['actorId', 'effectId'],
    },
  },
  {
    name: 'list_actor_effects',
    description:
      "List the ActiveEffects on a world-linked actor, read from the cached world snapshot (no socket round trip). Only reaches a top-level Actor document - an unlinked token's synthetic per-token actor is not independently listable this way. Use when: checking what buffs/debuffs are currently active on an actor before applying another.",
    inputSchema: {
      type: 'object',
      properties: {
        actorId: { type: 'string', description: "The actor's own document id" },
      },
      required: ['actorId'],
    },
  },
];

/**
 * Scene Region tool definitions (FoundryVTT v12+)
 */
export const regionTools = [
  {
    name: 'list_regions',
    description:
      'List the Scene Regions placed on a scene (FoundryVTT v12+). Regions are polygon/circle/rectangle areas that trigger behaviors when tokens enter, move through, or leave them. Use when: inspecting traps, teleport pads, atmospheric zones, or scripted triggers on a map.',
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'Optional scene id; defaults to the currently active scene',
        },
      },
    },
  },
  {
    name: 'create_region',
    description:
      'Create a new Scene Region with shapes and/or automated behaviors (FoundryVTT v12+). Shapes use pixel coordinates (use get_scene_info/find_open_cells to convert from grid cells). Documented behaviors include teleportToken ({ destination: <region UUID> }), displayScrollingText ({ text, color, visibility }), adjustDarknessLevel ({ mode, modifier }), and pauseGame ({ once }); custom system/module behavior types pass through untouched. ' +
      WRITE_GATE,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Region display name' },
        sceneId: {
          type: 'string',
          description: 'Optional scene id; defaults to the currently active scene',
        },
        color: {
          type: 'string',
          description: 'Optional 6-digit hex color for canvas rendering (e.g. "#ff8800")',
        },
        visibility: {
          type: 'number',
          description: '0 = hidden from players, 1 = visible to players (default: 0)',
        },
        elevation: {
          type: 'object',
          description: 'Optional 3D vertical bounds (null for unbounded)',
          properties: {
            bottom: { type: 'number' },
            top: { type: 'number' },
          },
        },
        shapes: {
          type: 'array',
          description: 'Pixel-coordinate geometric shapes defining the region boundary',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['rectangle', 'circle', 'polygon'] },
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              radius: { type: 'number' },
              points: {
                type: 'array',
                items: { type: 'number' },
                description: 'For polygon: array of alternating x,y coordinates (at least 6)',
              },
            },
            required: ['type'],
          },
        },
        behaviors: {
          type: 'array',
          description: 'Automated behaviors triggered when tokens interact with the region',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                description:
                  'Behavior type string, e.g. "teleportToken", "displayScrollingText", "adjustDarknessLevel", "pauseGame"',
              },
              system: { type: 'object', description: 'Behavior configuration data' },
              disabled: { type: 'boolean', description: 'Create the behavior disabled' },
            },
            required: ['type'],
          },
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'delete_region',
    description: `Delete a Scene Region from a scene (FoundryVTT v12+). ${CONFIRM_FIRST} ${WRITE_GATE}`,
    inputSchema: {
      type: 'object',
      properties: {
        regionId: { type: 'string', description: 'The Region document id to delete' },
        sceneId: {
          type: 'string',
          description: 'Optional scene id; defaults to the currently active scene',
        },
      },
      required: ['regionId'],
    },
  },
];

/**
 * World-event tool definitions
 *
 * Backed by an in-memory, cursor-addressed log of every `modifyDocument` /
 * `userActivity` broadcast this server has observed (plus canvas events
 * pushed by the companion module). Read-only.
 */
export const eventTools = [
  {
    name: 'watch_events',
    description:
      "Wait for and return world activity since a cursor - chat messages, token/actor/combat updates, door state changes, user connect/disconnect, and canvas targeting - instead of re-polling get_chat_messages/get_combat_state in a loop. Blocks for up to waitMs (default 25000, max 120000) if nothing has happened yet, returning as soon as something does; pass 0 to check without waiting. Your MCP client's own request timeout must exceed waitMs or the call will appear to fail while still running server-side. Always pass the returned nextCursor back as `cursor` on your next call - it is required to avoid missing or re-reading events, and a nonzero `dropped` count means events were evicted from the buffer before your cursor (increase FOUNDRY_EVENT_BUFFER_SIZE, or catch up with refresh_world_data/get_scene_info). Changing kinds/types/actions/sceneId mid-stream cannot recover events a previous filter already skipped past. Use when: waiting for a player to act, or checking what happened while you were doing something else. Do not use when: you need the full current state of something - use the matching get_*/search_* tool instead.",
    inputSchema: {
      type: 'object',
      properties: {
        cursor: {
          type: 'string',
          description:
            '"now" (default) to start from this moment, "oldest" for the full retained buffer, or a nextCursor value from a previous call',
          default: 'now',
        },
        waitMs: {
          type: 'number',
          description:
            'Milliseconds to block waiting for a new event before returning empty (default 25000, max 120000, 0 = return immediately)',
          default: 25000,
          minimum: 0,
          maximum: 120000,
        },
        limit: {
          type: 'number',
          description: 'Maximum events to return in one call (default 50, max 200)',
          default: 50,
          minimum: 1,
          maximum: 200,
        },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['document', 'presence', 'target'] },
          description: 'Restrict to these event kinds (default: all)',
        },
        types: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Restrict to these document names, e.g. ["ChatMessage","Token","Combat"] (default: all)',
        },
        actions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict to these actions, e.g. ["create","update"] (default: all)',
        },
        sceneId: {
          type: 'string',
          description: 'Restrict to events on this scene (default: all scenes)',
        },
        excludeSelf: {
          type: 'boolean',
          description:
            "Drop events this server's own writes caused, when FoundryVTT echoes them back (default true)",
          default: true,
        },
      },
    },
  },
];

/**
 * Get all tool definitions combined
 */
export function getAllTools() {
  return [
    ...diceTools,
    ...actorTools,
    ...actorMutationTools,
    ...itemTools,
    ...compendiumTools,
    ...itemMutationTools,
    ...sceneTools,
    ...sceneMutationTools,
    ...wallMutationTools,
    ...tileTools,
    ...tileMutationTools,
    ...combatTools,
    ...placeableTools,
    ...placeableMutationTools,
    ...combatMutationTools,
    ...tokenTools,
    ...tokenMutationTools,
    ...chatTools,
    ...chatMutationTools,
    ...userTools,
    ...journalTools,
    ...journalMutationTools,
    ...worldTools,
    ...worldDocumentTools,
    ...worldDocumentMutationTools,
    ...rollTableTools,
    ...moduleBridgeTools,
    ...eventTools,
    ...effectTools,
    ...regionTools,
    ...generationTools,
    ...settingsTools,
    ...diagnosticsTools,
  ];
}

/**
 * Get modernized tool definitions from registry (when available)
 */
export async function getModernizedTools() {
  try {
    const { toolRegistry } = await import('./registry.js');
    const modernTools = toolRegistry.getToolDefinitions();

    // Filter out tools that have been modernized to avoid duplicates
    const modernToolNames = new Set(modernTools.map((tool) => tool.name));
    const legacyTools = getAllTools().filter((tool) => !modernToolNames.has(tool.name));

    return [...modernTools, ...legacyTools];
  } catch (_error) {
    // Fallback to legacy definitions if registry is not available
    return getAllTools();
  }
}
