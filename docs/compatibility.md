# Compatibility

What the connector has been tried with, and what it needs. "Tried" means a real installation used with it; "supported" means the code handles it but no one has reported trying it.

## FoundryVTT

| Version | State |
| :--- | :--- |
| v14, builds 369 and 370 | Tried: installation, `init --check`, Socket.IO, the invisible session, the companion module, reads and writes. |
| v13 | Supported by the code (the login and the documents it writes handle both generations), not tried. |
| v12 and earlier | Not supported. The companion module requires v13 or later. |

## The companion module

| Module | With connector 2.2 |
| :--- | :--- |
| 0.6.0 | Recommended. |
| 0.5.x | Works, without the commands added in 0.6.0: `get_actor_stats` and the `createOptions` of `apply_status_effect` are refused at once with a clear message. |
| before 0.5.0 | Not accepted: it cannot answer the bridge's authentication, so the connection is closed and logged as an older module. |

`status` and the health check show the module's version.

## Hosting

- **Tried**: FoundryVTT on a remote Linux server, reached over HTTPS, with the connector on a Windows computer.
- **Supported, not tried**: FoundryVTT on the same computer as the connector, or on a local network, over HTTP or HTTPS.
- **What the connector needs**: to reach `FOUNDRY_URL` like a player's browser does (its login page and its Socket.IO connection), with a certificate the connector trusts (a private certificate authority can be added with Node.js's `NODE_EXTRA_CA_CERTS`). The invisible browser runs on the connector's computer and opens the same address. Services that put FoundryVTT behind a login page of their own have not been tried.
- `FOUNDRY_DATA_PATH` only makes sense when the connector runs on the computer that holds FoundryVTT's `Data` folder.

## MCP clients

- **Tried**: Claude desktop and Claude Code, on Windows.
- **Supported, not tried**: any MCP client that starts servers over standard input and output; see [Installation](installation.md#4-add-the-connector-to-your-mcp-client) for an entry by hand.

## Node.js and operating systems

- **Node.js 22 or newer** (`engines` in `package.json`). The automated tests run on Node.js 22 and 24, on Linux, Windows and macOS; daily use is on Windows with a current Node.js release.
- **Windows**: tried. **macOS and Linux**: the automated tests and the startup and packaging checks pass there; real use has not been reported.
- **Browsers** for the invisible session: Google Chrome, Microsoft Edge, Brave, Vivaldi, Chromium, or Playwright's own Chromium, detected in that order; Brave tried. Any other Chromium-based browser can be named with `FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH`.

## Game systems

The connector does not depend on a game system: it reads and writes FoundryVTT documents as the world's system defines them. What does depend on the system:

- **Field names.** An actor's data and an item's data are the system's own. `get_document_schema` shows them, with the fields the system computes and does not store; `update_actor_attributes` should only write stored fields, since a computed one is saved but has no effect.
- **Prepared values.** Values a system computes (totals, modifiers) are not in the stored data: `get_actor_stats`, through the companion module, returns the actor as the system prepared it.
- **Summaries.** `search_actors`, `get_actor_details` and `get_combat_state` show a level, hit points and armour class only when the actor stores them at the common paths their descriptions name; with other systems they show fewer fields. `get_actor_stats` and `get_document_schema` cover any system.
- **Status conditions.** With the companion module, `apply_status_effect` goes through the system's own status effects; some systems ask for a value when a status is created, given in `createOptions`.
- **Compendiums and rules.** `lookup_rule` and `search_compendium_content` search the journals and compendiums the world has; a system without rules in a compendium has none to find.
- **Generators.** `generate_npc` and `generate_loot` use built-in lists that do not depend on the world's system.
