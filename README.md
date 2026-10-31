# FoundryVTT MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue.svg)](https://www.typescriptlang.org/)
[![Vitest](https://img.shields.io/badge/Tests-733%20passing-brightgreen.svg)](https://vitest.dev/)
[![Tools](https://img.shields.io/badge/MCP%20Tools-111-purple.svg)](https://modelcontextprotocol.io/)

A comprehensive, production-grade [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for **Foundry Virtual Tabletop (FoundryVTT)**.

This server empowers AI assistants (Claude Desktop, Claude Code, Oh My Pi, VS Code, Cursor, etc.) to act as fully capable, autonomous **Co-GMs and GM assistants** inside FoundryVTT. It provides complete read and write access across game mechanics, actors, items, tokens, combat encounters, canvas placeables (walls, lights, sounds, templates, drawings, notes, tiles), playlists, macros, roll tables, compendiums, world settings, and live canvas rendering.

---

## 🌟 Key Highlights & Capabilities (111 Tools)

- 👁️ **Real-Time Event Stream & Activity Log (`watch_events`)**: Zero-polling event awareness via Socket.IO `modifyDocument` and companion bridge pushes. An AI DM agent can long-poll on a cursor-addressed stream (`cursor`, `waitMs`, `excludeSelf`, `types`, `sceneId`) to react instantly when players chat, move tokens, advance combat, toggle doors, or select targets.
- 🎲 **Game Mechanics & Interactive Chat**: Roll dice with standard or complex drop/keep notation (`4d6kh3`, `1d20r1`). Roll and post interactive, clickable chat cards directly to the Foundry chat log via the companion bridge (`roll_and_post`).
- 🗺️ **Full Canvas & Spatial Control**: Create, inspect, update, and remove all canvas placeable types:
  - **Scene Regions (v12+)**: `create_region`, `delete_region`, `list_regions` with geometric shapes (`rectangle`, `circle`, `ellipse`, `polygon`) and automated trigger behaviors.
  - **Walls & Doors**: standard, doors (open/close/lock), secret doors, windows, ethereal walls, and custom coordinates (`create_wall`, `list_walls`, `set_door_state`).
  - **Ambient Lights**: coordinate or grid-cell placement, dim/bright radii, animation effects, color thresholds (`create_light`, `update_light`, `delete_light`, `list_lights`).
  - **Ambient Sounds**: audio tracks, radii, volume, repeat modes (`create_sound`, `delete_sound`, `list_sounds`).
  - **Measured Templates**: cone, circle, ray, and rect spell area-of-effect markers with directional rotation and colors (`create_template`, `delete_template`, `list_templates`).
  - **Drawings**: freehand and geometrical shapes, stroke/fill styling, and text annotations (`create_drawing`, `delete_drawing`, `list_drawings`).
  - **Map Notes & Pins**: landmark markers linked to journal entries or standalone labels (`create_note`, `delete_note`, `list_notes`).
  - **Tiles & Props**: place decorative tiles and backgrounds (`create_tile`, `delete_tile`, `list_tiles`).
  - **Canvas Viewport Capture**: screenshot the GM canvas viewport with a burned-in coordinate grid overlay (`[col,row]`) via `capture_scene`.
  - **Targeting & Animated Pings**: focus player attention with animated camera pings (`ping_canvas`) and view/set token targeting reticles (`set_target`, `get_targets`).
- 🧙 **Token & Actor Control**:
  - **A\* Pathfinding Movement**: tokens navigate around walls and automatically open closed doors along their path (`move_token_pathfind`).
  - **Token Vision & Lighting**: configure sight ranges, vision modes, dim/bright emitted light, and vision detection angles (`update_token_vision`).
  - **Generalized ActiveEffects**: create, update, delete, and inspect mechanical buffs/debuffs with attribute changes (`key`, `mode`, `value`, `priority`) and durations (`rounds`, `seconds`, `turns`) on top-level or synthetic unlinked token actors (`create_actor_effect`, `update_actor_effect`, `delete_actor_effect`, `list_actor_effects`).
  - **Status Conditions**: apply/remove system-agnostic status conditions (`apply_status_effect`).
  - **Compendium Actor & Item Import**: import entire NPC/monster documents from compendium packs with automatic per-item error recovery (`import_compendium_actor`), or import specific items into actor inventories (`create_actor_item`).
  - **System Attribute Mutations**: patch actor system data (HP, temporary HP, currency, resources, spell slots) using JSON merge patches (`update_actor_attributes`).
- ⚔️ **Combat Encounter Management**: Create encounters, seed combatants from tokens, manage initiative orders, advance turns/rounds, track active combatants, pause/unpause the game clock (`set_pause`), and end encounters.
- 📜 **World Documents & Organization**:
  - **Folders**: manage hierarchical folder structures for actors, items, journals, and scenes (`create_folder`, `list_folders`).
  - **Macros**: inspect, create, and delete script/chat macros (`create_macro`, `list_macros`, `delete_macro`).
  - **Playlists & Audio**: create multi-track playlists, control playback (play, pause, stop), and adjust track states (`create_playlist`, `set_playlist_state`, `list_playlists`).
  - **Roll Tables**: create tables with automatic sequential range distribution (`1dN`), and draw live results (`create_roll_table`, `roll_table`, `list_roll_tables`).
  - **Document Ownership & User Roles**: configure granular document permissions (`set_document_ownership`) and user roles with self-demotion lockout guards (`set_user_role`).
  - **World Settings**: safely inspect and update module and system settings with built-in protection against core engine corruption (`get_world_setting`, `set_world_setting`).
  - **Asset Uploads**: upload images, tokens, and audio directly into Foundry's `Data/` storage via native FilePicker or local filesystem (`upload_asset`).
- 🌫️ **Scene, Weather & Exploration Management**: Switch active scenes, adjust darkness levels, toggle global illumination, set environmental weather effects (`set_scene_weather`), and reset Fog of War exploration (`reset_fog`).
- 🔍 **Rules & Compendium Search**: Search world documents, compendium packs, and rule text with contextual snippets (`search_compendium_content`, `lookup_rule`).
---

## 🏗️ Architecture

The server employs a hybrid architecture to deliver real-time responsiveness and deep game-engine integration:

```
┌─────────────────────────────────────────────────────────────┐
│                    AI Assistant / MCP Client                │
│             (Claude Desktop, Oh My Pi, VS Code)             │
└──────────────────────────────┬──────────────────────────────┘
                               │ MCP (stdio)
┌──────────────────────────────▼──────────────────────────────┐
│                    FoundryVTT MCP Server                    │
├──────────────────────────┬───────────────────┬──────────────┤
│  In-Memory World Cache   │  A* Pathfinding   │  Headless GM  │
│  (Live Socket.IO Sync)   │  Dice Notation    │  Browser Sess.│
└──────────────┬───────────┴─────────┬─────────┴──────┬───────┘
               │ Socket.IO (30000)   │ WS (31415)      │ auto-login
               │ (modifyDocument)    │ (Bridge)        │ (Chrome/Edge)
┌──────────────▼──────────────────────────────▼────────▼───────┐
│                    FoundryVTT Game Engine                    │
│  ┌────────────────────────┐    ┌─────────────────────────┐   │
│  │   Active World & Data  │    │  Companion Module        │  │
│  │   (Actors, Scenes, …)  │    │  (foundryvtt-mcp-bridge) │  │
│  └────────────────────────┘    └─────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

1. **Socket.IO Primary Connection**: Connects to FoundryVTT as an authenticated user (`mcp-api`). Automatically synchronizes and caches the world state, enabling instant lookups and high-frequency document mutations via the `modifyDocument` protocol.
2. **Companion Module Bridge (`foundryvtt-mcp-bridge`)**: A lightweight Foundry module running in a browser that executes canvas-bound operations (PIXI canvas screenshot with grid overlay, native `Roll` chat card rendering, document schema introspection, and compendium item extraction). It only activates for a GM/Assistant-GM user — Foundry itself restricts pausing the game and uploading files to that tier, and a Player's canvas is fog-of-war-limited.
3. **Automatic Headless GM Session**: The server drives its own invisible, background browser tab (via `playwright-core`, reusing whatever Chrome/Edge is already installed — no download required) that logs in as the same `mcp-api` account and hosts the module above. This means a human can play the game as a normal Player in their own visible client while the AI has full GM-tier canvas access through this separate, invisible session — no manual second browser tab required. A watchdog polls the bridge's own connectivity independently of the Foundry login state and force-reloads the tab to recover a dropped module WebSocket (the module's own reconnect logic gives up permanently after ~85 minutes) — self-healing without a server restart. Falls back gracefully (canvas-only tools report unavailable) if no browser is found; a manually-opened GM tab still works as before if preferred (set `FOUNDRY_HEADLESS_GM_ENABLED=false`).
4. **Optional REST API Module**: Provides server diagnostics, log retrieval, and health reporting when the local REST module is installed.

---

## 🚀 Quick Start

### 1. Prerequisites

- **Node.js 18+** or **Bun**
- **FoundryVTT v11+ / v12+** running an active world
- A dedicated Foundry user account with **Gamemaster** or **Assistant GM** role
- **Google Chrome or Microsoft Edge installed** (for the automatic headless GM browser session — see below; most desktops already have one)

### 2. Configure Dedicated Foundry User

In FoundryVTT:
1. Open **Configuration** → **User Management**
2. Click **Create User**
3. Set Username: `mcp-api`, Password: `mcp` (or your choice)
4. Role: **Gamemaster** (or **Assistant GM** with write permissions enabled)

> **Playing as a human while the AI GMs?** No extra setup needed. Log into your own Foundry client as a normal **Player**; the server automatically logs `mcp-api` into its own invisible background browser session for GM-tier canvas access (screenshots, dice rolls, pausing, uploads). See [`FOUNDRY_HEADLESS_GM_ENABLED`](#environment-variables) below to disable this and use a manually-opened GM browser tab instead.

### 3. Install the Companion Module (Recommended)

Copy the `foundry-module` folder from this repo to your FoundryVTT `Data/modules/` directory:

```bash
# Windows
cp -r foundry-module "%LOCALAPPDATA%/FoundryVTT/Data/modules/foundryvtt-mcp-bridge"

# macOS
cp -r foundry-module "~/Library/Application Support/FoundryVTT/Data/modules/foundryvtt-mcp-bridge"

# Linux
cp -r foundry-module "~/.local/share/FoundryVTT/Data/modules/foundryvtt-mcp-bridge"
```

In FoundryVTT, go to **Manage Modules** and enable **FoundryVTT MCP Bridge**.

---

## ⚙️ Configuration & Client Setup

### Environment Variables

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `FOUNDRY_URL` | **Yes** | `http://localhost:30000` | FoundryVTT server URL |
| `FOUNDRY_USERNAME` | **Yes** | — | FoundryVTT user account name |
| `FOUNDRY_PASSWORD` | **Yes** | — | FoundryVTT user account password |
| `FOUNDRY_WRITE_ENABLED` | No | `false` | Enables game-state mutations (walls, actors, tokens, etc.) |
| `FOUNDRY_MODULE_BRIDGE_ENABLED` | No | `false` | Enables WebSocket bridge for canvas screenshots & chat rolls |
| `FOUNDRY_MODULE_BRIDGE_PORT` | No | `31415` | WebSocket port for the companion module bridge |
| `FOUNDRY_HEADLESS_GM_ENABLED` | No | `true` | Auto-launches an invisible GM-tier browser session to host the module bridge — no manual second browser tab needed |
| `FOUNDRY_HEADLESS_GM_USERNAME` | No | `FOUNDRY_USERNAME` | Overrides which account the headless session logs in as |
| `FOUNDRY_HEADLESS_GM_PASSWORD` | No | `FOUNDRY_PASSWORD` | Password for the headless session account, if overridden |
| `FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH` | No | — | Explicit Chrome/Edge/Chromium binary path, skipping auto-detection |
| `FOUNDRY_DATA_PATH` | No | — | Local path to Foundry `Data/` for asset dimension discovery |
| `FOUNDRY_API_KEY` | No | — | Optional REST API key for server diagnostics tools |
| `FOUNDRY_EVENT_BUFFER_SIZE` | No | `500` | In-memory event log ring buffer capacity |
| `FOUNDRY_EVENT_WAIT_MS` | No | `25000` | Default long-polling timeout for `watch_events` |
| `LOG_LEVEL` | No | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`) |

### Claude Desktop Configuration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "foundryvtt": {
      "command": "node",
      "args": ["<PATH_TO_REPO>/dist/index.js"],
      "env": {
        "FOUNDRY_URL": "http://localhost:30000",
        "FOUNDRY_USERNAME": "mcp-api",
        "FOUNDRY_PASSWORD": "mcp",
        "FOUNDRY_WRITE_ENABLED": "true",
        "FOUNDRY_MODULE_BRIDGE_ENABLED": "true",
        "FOUNDRY_MODULE_BRIDGE_PORT": "31415"
      }
    }
  }
}
```

### Oh My Pi Configuration

Add to `~/.omp/agent/mcp.json` (or `~/.omp/mcp.json`):

```json
{
  "mcpServers": {
    "foundryvtt": {
      "type": "stdio",
      "command": "node",
      "args": ["<PATH_TO_REPO>/dist/index.js"],
      "env": {
        "FOUNDRY_URL": "http://localhost:30000",
        "FOUNDRY_USERNAME": "mcp-api",
        "FOUNDRY_PASSWORD": "mcp",
        "FOUNDRY_WRITE_ENABLED": "true",
        "FOUNDRY_MODULE_BRIDGE_ENABLED": "true",
        "FOUNDRY_MODULE_BRIDGE_PORT": "31415"
      },
      "timeout": 60000
    }
  }
}
```

---

## 🛠️ Tool Catalog (111 Tools)

### 1. Real-Time Event Awareness
- `watch_events` — long-poll a cursor-addressed activity log (`cursor`, `waitMs`, `limit`, `kinds`, `types`, `actions`, `sceneId`, `excludeSelf`) capturing document broadcasts and canvas activity without polling.

### 2. Canvas & Spatial Placeables
- `create_region` / `delete_region` / `list_regions` — manage Scene Regions (v12+) with geometric shapes (`rectangle`, `circle`, `ellipse`, `polygon`) and automated behaviors.
- `create_wall` / `delete_wall` / `list_walls` / `set_door_state` — complete wall and door geometry management.
- `create_light` / `update_light` / `delete_light` / `list_lights` — ambient lighting control (radii, colors, animations).
- `create_sound` / `delete_sound` / `list_sounds` — ambient audio placement on canvas scenes.
- `create_template` / `delete_template` / `list_templates` — spell and effect area-of-effect templates.
- `create_drawing` / `delete_drawing` / `list_drawings` — map shapes, zones, and text annotations.
- `create_note` / `delete_note` / `list_notes` — map pins and landmark markers.
- `create_tile` / `delete_tile` / `list_tiles` — decorative tiles and map props.
- `capture_scene` — screenshot the active scene canvas with a grid coordinate overlay burned in.
- `ping_canvas` — emit an animated canvas ping at specific pixel coordinates.
- `find_open_cells` — scan scenes for unblocked grid cells suitable for token/prop placement.
- `list_scene_assets` — discover map backgrounds, token art, and audio files with parsed tags and dimensions.
- `upload_asset` — upload image/audio files into Foundry's `Data/` directory via FilePicker or local filesystem.

### 3. Tokens & Movement
- `spawn_token` — place actor tokens on scenes with custom size, elevation, and coordinates.
- `delete_token` — remove tokens from scenes without deleting the underlying actor.
- `list_tokens` — list placed tokens on active or specific scenes.
- `move_token` — teleport a token to exact pixel coordinates.
- `move_token_pathfind` — move tokens using A* obstacle avoidance around walls with automatic door opening.
- `move_tokens` — batch move multiple tokens simultaneously.
- `set_target` / `get_targets` — set and inspect token targeting reticles across connected users.
- `update_token_vision` — configure vision ranges, vision modes, dim/bright emitted lights, and angles.
- `apply_status_effect` — toggle simple status conditions (`prone`, `stunned`, `blinded`, `invisible`, etc.).

### 4. Actors & Inventory
- `create_world_actor` / `create_full_actor` / `delete_world_actor` — create and delete actor documents.
- `import_compendium_actor` — import entire NPCs/monsters from compendium packs with embedded items and automatic error recovery.
- `search_actors` — query actors by name and type with cursor pagination support.
- `get_actor_details` — retrieve actor system data, statistics, attributes, and health.
- `update_actor_attributes` — patch nested system data using dot paths (`attributes.hp.value`, `currency.gp`).
- `get_actor_inventory` — list owned items with full system properties.
- `create_actor_item` — create inline items OR import directly from compendium packs (`source: { type: 'compendium', compendiumId, itemId }`).
- `update_actor_item` — apply JSON merge patches to owned items.
- `delete_actor_item` — delete specific items from actor inventories.
- `create_actor_effect` / `update_actor_effect` / `delete_actor_effect` / `list_actor_effects` — general-purpose ActiveEffects with mechanical changes (`key`, `mode`, `value`, `priority`) and durations on top-level or synthetic unlinked token actors.

### 5. Combat Encounters
- `start_combat` — create encounters and seed combatants from scene tokens.
- `get_combat_state` — retrieve combatant turn order, HP, AC, and round number.
- `set_initiative` — set combatant initiative values and re-order turns.
- `next_turn` — advance the turn tracker (handles round increments and skips defeated combatants).
- `set_pause` — pause or unpause the game clock.
- `end_combat` — terminate active encounters.

### 6. World Documents & Organization
- `list_folders` / `create_folder` — organize actors, items, journals, and scenes in nested folders.
- `list_macros` / `create_macro` / `delete_macro` — manage script and chat macro documents.
- `list_playlists` / `create_playlist` / `set_playlist_state` / `delete_playlist` — audio playlist and sound controls.
- `create_roll_table` / `delete_roll_table` / `roll_table` / `list_roll_tables` — table creation and result rolling.
- `get_world_setting` / `set_world_setting` — inspect and modify system/module settings with core protection.
- `set_document_ownership` — configure granular document permissions (`none`, `limited`, `observer`, `owner`).
- `get_users` / `set_user_role` — list connected users and change permission roles with self-demotion lockout guards.
- `create_journal_entry` / `get_journal` / `search_journals` / `delete_journal_entry` — manage session notes and lore. `get_journal` lists each page's id; pass `raw: true` for the full, unmodified page HTML.
- `update_journal_page` / `add_journal_page` / `update_journal_entry` — edit existing journals: replace or append to a page's content (or rename it), add a page after the last one, and rename, refile, or change the visibility of an entry.

### 7. Scene, Weather & Exploration
- `create_scene` / `delete_scene` / `get_scene_info` / `switch_scene` — scene creation and player activation.
- `set_scene_weather` — set or clear weather effects (`rain`, `snow`, `fog`, `""`).
- `set_scene_lighting` — ambient darkness levels and global illumination settings.
- `reset_fog` — reset Fog of War exploration on active scenes.

### 8. Game Mechanics & Bridge Tools
- `roll_dice` — local mathematical dice formula evaluation.
- `roll_and_post` — evaluates formulas via Foundry's native engine and posts interactive chat cards.
- `lookup_rule` — search world journals and system compendium packs for rules with snippet previews.
- `get_document_schema` — introspect game system DataModel schemas for actor and item types.
- `search_compendium_content` — deep search inside compendium pack documents and journal pages.
- `send_chat_message` / `get_chat_messages` — post and read messages from the Foundry chat log.
- `generate_npc` / `generate_loot` — instant procedural generators.

### 9. Diagnostics & Logging
- `get_health_status` / `get_system_health` — connection and server health metrics.
- `get_recent_logs` / `search_logs` — inspect server logs and error stack traces.
- `diagnose_errors` — analyze recent errors into prioritized resolution suggestions.
- `refresh_world_data` — force a re-fetch of the cached world state snapshot.

## 🧪 Development & Testing

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run build

# Run complete unit test suite (733 tests)
npm test

# Run linter and formatting checks
npm run lint

# Start server in development watch mode
npm run dev
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
