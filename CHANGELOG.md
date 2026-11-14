# Changelog

## Unreleased

### Added

- The log records the HTTP status of FoundryVTT's answer to the login (`POST /join answered`), and the path it redirects to without its query, also when the login is refused (400, 401, 403…). It never records the cookie, the headers, the body or the password. Useful after a FoundryVTT update changes the login.

### Changed

- Tool descriptions no longer name a particular game system: their examples are neutral, and where a tool reads or checks a given path (`search_actors`, `get_actor_details`, `get_combat_state`, the range checks of `update_actor_attributes`), the description names the path and says it applies when the actor stores a value there.

### Fixed

- `get_world_summary` and `get_health_status` show the FoundryVTT version with its build, as in "Core Version: 14.370 (generation 14, build 370)". FoundryVTT sends its release without the version string, so the tools showed only the generation ("14").
- `set_scene_lighting` had no effect: it wrote `darkness`, `globalLight` and `globalLightThreshold` at the top of the Scene document, which FoundryVTT has kept under `environment` since v12 and drops from an update in v14. It now writes `environment.darknessLevel`, `environment.globalLight.enabled` and `environment.globalLight.darkness.max`, for v13 and v14 alike.
- `get_scene_info` showed "Darkness Level: NaN%" and the global light as disabled: it reads them from `environment` now, from the older fields when only those are there, and says "Unknown" when neither is.

### Documentation

- The README is short: what the connector does, the requirements, a five-step quick start, the known limitations. The details moved to `docs/`: installation, configuration (every setting, checked against the code), architecture, security and compatibility.
- `docs/tools.md` lists every tool with its description, parameters, whether it writes and what it needs. `scripts/generate-tools-doc.js` generates it from the tool definitions (`npm run docs:tools`), and CI checks that it is up to date.
- `SETUP_GUIDE.md` and `docs/guides/configuration.md` became short pages pointing to the new ones; `docs/guides/integration.md`, `docs/guides/development.md` and `examples/mcp-client-configs.md` were removed, their content moved to `docs/installation.md` and `CONTRIBUTING.md`.
- The README no longer describes `roll_dice` as local only: it rolls with FoundryVTT's own engine when `FOUNDRY_API_KEY` is set, and locally otherwise.

## 2.2.1 — 2026-11-13

### Security

- `set_target`, `ping_canvas`, `set_pause` and `upload_asset`, carried out by the companion module, were not refused while writes were disabled, although their descriptions said so. They are now refused unless `FOUNDRY_WRITE_ENABLED=true`, before anything is sent to the module or read from disk.
- `upload_asset` read its `sourcePath` from any folder, whatever the file type, and did not validate its destination. `sourcePath` is now read only from the folder named by the new setting `FOUNDRY_UPLOAD_SOURCE_DIR` (a regular file inside it, links resolved, at most 8 MiB, checked before reading); only media files are accepted (.png, .jpg, .jpeg, .webp, .gif, .mp3, .ogg, .wav, .m4a, .webm, .mp4), with the same extension for the source and the destination; `targetDir` must stay inside the Data storage and `filename` be a plain file name.

### Changed

- `upload_asset` refuses `sourcePath` unless `FOUNDRY_UPLOAD_SOURCE_DIR` is set; `contentBase64` works as before. SVG, JSON and PDF files are no longer accepted, and a `mimeType` that does not match the file extension is refused.
- `roll_and_post` and `import_compendium_actor` are refused while writes are disabled, before the module is asked anything: `roll_and_post` posts a chat message, as `send_chat_message` does, and `import_compendium_actor` no longer reads the compendium document when the import would be refused.

### Fixed

- `create_scene` under FoundryVTT v14 created a scene with no Level, which Foundry could not display: v14 keeps the background on the scene's Levels, and the scene-level `background` and `backgroundColor` the tool sent were dropped. Under v14 the tool now creates the default Level the Foundry client creates (`defaultLevel0000`, carrying the background image and colour) and sets it as the scene's initial Level. Under v13 the scene is created as before.

## 2.2.0 — 2026-11-13

Recommended companion module: **0.6.0** (`bridge-v0.6.0`). Module 0.5.2 still works with this server: `get_actor_stats` and `createOptions` are refused at once with a clear message, and `apply_status_effect` without `createOptions` writes the effect over the socket.

### Added

- **One token's actor**: `update_actor_attributes`, `get_actor_details`, `get_actor_inventory`, `list_actor_effects`, `create_actor_item`, `update_actor_item` and `delete_actor_item` take `sceneId` + `tokenId` instead of `actorId` (an `actorId` given as well must be the token's actor). A linked token reads and writes its world actor. An unlinked token reads its own actor — the base actor with the token's changes, its items and effects with those it inherits — and its writes change that token only, not the base actor or its other tokens. From duckpuppy's fork (Patrick Aikens) for the attributes.
- **`get_actor_stats`**: an actor's prepared system data as compact JSON, including the values the game system computes and does not store, which the cached world cannot show. A world actor by `actorId`, or one token by `sceneId` + `tokenId` (an unlinked token's own actor). `paths` narrows the answer to some fields; `maxBytes` (default 32768, at most 65536) bounds it, and a larger answer is refused with the size of each top-level key. Needs the companion module 0.6.0. From duckpuppy's fork (Patrick Aikens), made generic.
- `create_world_actor` takes optional `flags`, keyed by module id, written to the new actor. From duckpuppy's fork (Patrick Aikens).
- **Companion module 0.6.0 announces its version and commands** when it connects. The server sends it no command it does not announce, and sends a module that announces nothing only the commands every 0.5 module serves; a newer command then fails at once with a clear message. `status` and `get_health_status` show the module's version: the announced one, otherwise the version installed in the world, marked `(not announced)`. Module 0.6.0 also works with earlier servers, which ignore the announcement.

### Changed

- `apply_status_effect` goes through the game system's own status effects when the companion module 0.6.0 is connected, so the system recognises the effect as its condition; otherwise it keeps writing an effect carrying the status over the socket. With the bridge enabled it first waits up to 10 s for a module still connecting, as the module's tools do; without `createOptions`, it never fails for want of it. Through the module, a status id the game system does not know is refused with the list of valid ids, and effects carrying the status that an earlier version wrote over the socket are reported when applying and removed with `active=false`. A new `createOptions` argument carries the creation options a game system reads when a status is created (some ask the user for a value otherwise); without it, such a call fails at once and nothing is created. `createOptions` need the module's path and are refused without it. While writes are disabled, the no-op cases are decided from the cache as before. The answer names the path used.
- `start_combat` begins the encounter at round 1, turn 0, as Foundry's Begin Combat does. From duckpuppy's fork (Patrick Aikens).
- `get_combat_state`, `next_turn` and `set_initiative` show a combatant's token or actor name when the combatant has none of its own (FoundryVTT v14 leaves it empty), `get_combat_state` the token id and each token's own HP and AC; the AC is left out when the actor has none. From duckpuppy's fork (Patrick Aikens).
- A status effect from `apply_status_effect` always shows its icon on the token (since v14, a status alone no longer makes an effect temporary, so the icon stayed hidden). From duckpuppy's fork (Patrick Aikens).
- The effect tools refuse a token that is not in the cache, or that carries another actor than `actorId`, before sending anything; on a linked token they write the world actor.

### Fixed

- `create_actor_effect`, `update_actor_effect` and `delete_actor_effect` given `sceneId` + `tokenId` failed under FoundryVTT v14 for every token, linked or not: they sent a `Scene.<s>.Token.<t>.Actor.<a>` parent, which v14 rejects. `apply_status_effect` failed the same way on unlinked tokens. A linked token now writes its world actor, an unlinked token its ActorDelta. From duckpuppy's fork (Patrick Aikens), completed.
- The world cache follows unlinked tokens: changes to a token's own data, items and effects, including the first change to an item or effect it inherits (copied from the base actor, as the server does), the removal of one (kept as removed for that token only) and its creation again with the same id (shown again). `refresh_world_data` is no longer needed for them. From duckpuppy's fork (Patrick Aikens), completed.
- `apply_status_effect` finds a status an unlinked token inherits from its base actor: it is no longer applied a second time, and it can be removed from that token.
- An effect from `create_actor_effect` with `statuses` shows its icon on the token, as one from `apply_status_effect` does: under v14 the icon stayed hidden. Effects without statuses are unchanged.
- `update_actor_item` reports the item's name and type: FoundryVTT answers with the changed fields only, so they used to read `undefined`.
- `get_document_schema` failed on a type declared only by template.json, which has no schema. With the companion module 0.6.0 it lists that type's default values, with types inferred from them and marked as such; for a DataModel type it also reports computed fields (`persisted: false`) and number bounds (`min`, `max`, `integer`, `positive`).
- The descriptions of `delete_actor_item` and `get_actor_details` no longer say that no tool lists the ids of an actor's items: `get_actor_inventory` does.
- A tool given `sceneId` + `tokenId` for a scene that is not in the cache says `Scene not found: <sceneId>`, instead of reporting the token missing from that scene.

### Known limitations

- Without the companion module 0.6.0, `apply_status_effect` still writes an effect that a game system defining its own statuses with fixed effect ids may not recognise as its condition (it is removed later through the module with `active=false`). Through the module, an effect carrying several statuses, this one among them, is never removed by this tool.
- When a status is created or removed through the module, a game-system window that is not a standard dialog (`DialogV2`) is not closed: the call fails only when the server stops waiting for the module, after 15 s.

## 2.1.0 — 2026-11-07

### Added

- **Companion module lines in the log**: the GM page's console lines from the companion module (bridge connection, handshake, errors) and the uncaught errors thrown from its code reach the connector's log, at `info` or `warn`. Only the module's own scripts and its own message text are copied; no page, document or command content.
- **Failed reconnections in the log**: during a network cut, the first failed reconnection attempt of the socket is logged, then one line a minute or whenever the error changes, and the "connection restored" line says how long the cut lasted and how many attempts failed. Session cookies are masked in these lines.
- **`status` shows a stale world cache**: a `World cache: stale since <time> — <reason>` line while the cached world does not follow live changes.
- **Journal overwrites kept across restarts**: the overwrites detected in the last 24 hours are also kept in `journal-conflicts.json` in the state directory (ids, names, reason, who saved and the copy's path, no page text), so `get_health_status` still lists them after the shared process restarts. A copy whose file is gone is marked `(copy missing)`.

### Changed

- Only the calls that read the cached world or go through the socket wait for a reconnection; tools of the companion module, of the REST API module and local ones (`generate_npc`, `list_scene_assets`, …) go ahead at once. `foundry://` resources that read the cache now wait like tools.
- A tool that goes through the companion module waits up to 10 s for it while the headless GM page is starting, loading `/game`, reconnecting or was just logged in, and is refused at once, with the reason, when the module cannot come. Writes of the companion module still wait in the same queue as the other writes.
- The headless GM session reads `loading-game` ("Opening /game with the connector's session"), not `waiting-for-session`, while it loads the game with the session in hand.
- A refusal reaches the client with its own message, without a "Failed to <tool>: " prefix in front, and the `Tool call refused` / `Resource read refused` log lines give it without the `MCP error <code>: ` prefix.
- The README's "How it works" diagram is an image (`docs/assets/how-it-works.png`, with its Mermaid source next to it): the npm page does not render Mermaid.
- `init` and the README note that, in PowerShell, `claude mcp add … -- …` needs `'--'` when `claude` is the `claude.ps1` of an npm install.
- `scripts/diagnose-api.ts` reads its settings through the same resolver as the server (environment, `.env`, configuration file), and runs when called directly on Windows too.
- Dependencies: `dotenv` 18; `@types/node` follows the oldest supported Node.js (22). Dependabot no longer proposes TypeScript majors.

### Removed

- `scripts/run-e2e-tests.ts`: nothing ran it, and `npm run test:e2e` does the same.

### Fixed

- `refresh_world_data` works: it read an event FoundryVTT never sends and always timed out. A world load now waits up to 60 s, for large worlds. From duckpuppy's fork (Patrick Aikens).
- After a network cut, when FoundryVTT still knows the session, the world cache is reloaded on its own instead of staying stale until `refresh_world_data`. Changes received during the reload are kept.
- FoundryVTT v14 login sends `Sec-Fetch-Site: same-origin` with `Origin`, which some v14 setups require. From duckpuppy's fork (Patrick Aikens).
- The GM page opens at 1920×1080: the 1280×720 default is below FoundryVTT's minimum window size. From duckpuppy's fork (Patrick Aikens).
- A change broadcast while the world loads at connection time is no longer lost: it is kept and replayed onto the loaded world, as for a reload.
- When the module bridge failed to start, tools that need it say so instead of "the module bridge is disabled".
- `status` no longer reads a first connection in progress as failed: FoundryVTT shows `connecting…`, and the module bridge and the headless GM session `not started yet (connecting to FoundryVTT)` (they read "FoundryVTT connection failed", or "disabled" before the connection was set up).
- Errors reach MCP clients with one `MCP error <code>: ` prefix instead of two, for every code, through a relay and all-in-one (#15).
- `get_recent_logs`, `search_logs` and `diagnose_errors` without `FOUNDRY_API_KEY` are refused at once, with no request to FoundryVTT. A failed request to the REST API module logs one short warning (the stack at `debug`) instead of three errors with stacks.
- `get_chat_messages` and `watch_events` read a message's author from `author` (FoundryVTT v12 and later), then `user`: a message without a speaker alias no longer shows "Unknown" (#13).
- Dependabot can update `ws` again: the `ws` override follows the direct dependency (`$ws`) instead of conflicting with it (`EOVERRIDE`).
- `npm run smoke:pack` no longer spawns npm and the installed bin through a shell on Windows (Node's DEP0190 warning).

## 2.0.0 — 2026-11-05

First release under the new name; earlier entries are from the original project.

Changes since 1.5.2, in this fork and in the forks it continues (RN0000, duckpuppy).

### Added

- **npm package `@g33ks/foundryvtt-mcp`**: install with `npm install -g @g33ks/foundryvtt-mcp`; the command stays `foundryvtt-mcp`. The unscoped `foundryvtt-mcp` package on npm is the original project's. Releases come from `vX.Y.Z` tags through a release workflow (tests, smoke tests, tarball with its SHA-256, GitHub release).
- **`--version`** (also `-v` and `version`) prints the package version without reading the configuration or connecting.
- **Tools**: the catalogue grows to 114 tools — canvas placeables (walls, lights, sounds, templates, drawings, notes, tiles, regions), scenes and weather, playlists, macros, roll tables, folders, ownership, world settings, active effects, targeting, an event stream (`watch_events`), compendium content and imports, asset upload, and journal page editing.
- **Companion module and invisible GM session**: a Foundry module (`foundry-module/`) serves what only a real Foundry page can do (canvas capture, native rolls, compendium documents, uploads, pause, pings, targets), hosted by a headless browser the connector starts on the connector's own account. Installed Chromium-based browsers are detected by their usual paths.
- **Shared process**: MCP clients start lightweight relays that share one background process holding the FoundryVTT connection, the bridge and the GM session, over a named pipe or Unix socket with a per-user token. It stops after an idle delay, is replaced after a rebuild, and is controlled with `status` and `stop`. Write tools run one at a time through a queue.
- **Authenticated bridge**: the module bridge listens on loopback only, checks the `Origin`, and the server and the module prove their identity to each other (HMAC challenge and response) before any command.
- **Journal integrity**: page version tokens, writes checked against the server copy, a watch for overwrites, local copies of page bodies in the state directory, and overwrite notices whispered to the GMs and listed in the health status.
- **Diagnostics**: `status` and `get_health_status` report the bridge, the module's authentication, the GM session, the browser, the account and the configuration with the source of each setting.
- **Single account and reconnection**: the GM page shares the connector's Foundry session; the connector owns that session and logs in again when Foundry forgets it.
- **Configuration file and `init`**: one `config.env` shared by every MCP client, authoritative across them; `init` writes it after checking each answer against Foundry, and `init --check` checks it later.
- **Module releases by manifest URL**: `bridge-vX.Y.Z` tags publish the module on GitHub; Foundry installs and updates it from a stable manifest URL.
- **Community files**: contributing guide, security policy, code of conduct, issue and pull request templates.

### Changed

- **npm** replaces Bun as the package manager; Node.js 22 or newer is required.
- **CI** runs build, tests, lint and three smoke tests on Linux, Windows and macOS with Node 22 and 24, plus a production dependency audit, CodeQL and a full-history secret scan; Dependabot is configured for weekly updates.
- The repository, homepage, issue links and maintainer metadata point at G33ks/foundryvtt-mcp.
- The pre-commit hook warns instead of failing when gitleaks is not installed.
- **`init` commands**: the Claude desktop and Claude Code entries name Node.js and the server by absolute path (run `init` again after changing Node.js); terminal commands are `foundryvtt-mcp …` for an installed package and `node "<path>/dist/index.js" …` for a clone. Run from npx's cache, `init` prints no client entry and says to install the package globally.
- The package ships only the compiled JavaScript, README and LICENSE: no source maps, declaration files or `main` entry.

### Fixed

- FoundryVTT v14: login (`POST /join`) and the GM page's join form.
- `initialize` announces the package version instead of `0.1.0`; the `MCP_SERVER_VERSION` setting is gone (a configuration file that still sets it loads as before).
- Connector builds are ordered by version first, then by build stamp: an older version installed later (npx cache, second prefix) no longer replaces a shared process running a newer one.
- The connector exits when the MCP client closes its input, and a forced shutdown exits non-zero.
- The headless GM session reports its real browser launch error, retries `/game` after a network error, and is no longer read as logged in while loading or on "No Active Game".
- `status` reports the bridge and the GM session as they are, and no longer reports an old bridge's module as authenticated.
- The world cache follows `modifyDocumentBatch` broadcasts and side-effect acknowledgements.
- The build and the smoke tests run on Windows; the smoke tests no longer read the user's configuration or touch the usual shared process.
- Windows system directories are recognised by Windows path rules on every host.

### Removed

- Bun, `just` and `make`; release-please and the inherited workflows; TypeDoc and the generated API docs.
- The setup wizard and `test-connection` script, replaced by `init`.
- The previous maintainer's personal tooling and the Cyberpunk RED co-GM skill.

### Security

- CodeQL prototype-pollution and HTML sanitisation alerts resolved.
- The module bridge is restricted to loopback and authenticated (see Added).
- Journal page and chat message text is kept out of the tool log.
- Dependencies updated: `npm audit` reports no known vulnerability.

The entries below, from 1.5.2 down, come from the original project, [laurigates/foundryvtt-mcp](https://github.com/laurigates/foundryvtt-mcp), and its release tooling; their links point there.

## [1.5.2](https://github.com/laurigates/foundryvtt-mcp/compare/foundryvtt-mcp-v1.5.1...foundryvtt-mcp-v1.5.2) (2026-08-23)


### Bug Fixes

* **client:** follow the socket back up on reconnect instead of latching off ([8d7c029](https://github.com/laurigates/foundryvtt-mcp/commit/8d7c02969cc1183f5b7e52e3b9f6309eada004f1))
* **client:** report connection liveness from the socket, not a latched flag ([f22c464](https://github.com/laurigates/foundryvtt-mcp/commit/f22c464a60b62a0f091f5f8e8734b17695662df6)), closes [#217](https://github.com/laurigates/foundryvtt-mcp/issues/217)
* **client:** stop latching REST liveness on the connect probe ([e0e258f](https://github.com/laurigates/foundryvtt-mcp/commit/e0e258fe3d33448261d03370392853704710ae83))
* **combat:** derive started-ness instead of a field Foundry never sends ([e44dba4](https://github.com/laurigates/foundryvtt-mcp/commit/e44dba4fd44c91f5abf735f033d181f75d98e1a4))
* **combat:** index Combat#turn against the initiative-sorted turn order ([c55c205](https://github.com/laurigates/foundryvtt-mcp/commit/c55c2053466e73d863b52e7076320bab22ffb347)), closes [#214](https://github.com/laurigates/foundryvtt-mcp/issues/214)
* **combat:** re-anchor Combat#turn after set_initiative ([b1f2a8a](https://github.com/laurigates/foundryvtt-mcp/commit/b1f2a8aacfadc10310a1fff81188c83211c04a77)), closes [#214](https://github.com/laurigates/foundryvtt-mcp/issues/214)
* **diagnostics:** render search_logs results and wire level/limit ([a769e86](https://github.com/laurigates/foundryvtt-mcp/commit/a769e86414dc17fe0350684ae826f435dcaec0dd)), closes [#215](https://github.com/laurigates/foundryvtt-mcp/issues/215)
* **diagnostics:** report health from the fields the schema defines ([9895df6](https://github.com/laurigates/foundryvtt-mcp/commit/9895df64804bf80f1dfa5b97ef4dac0e0a8df32d)), closes [#216](https://github.com/laurigates/foundryvtt-mcp/issues/216)
* **diagnostics:** show when the world section is a stale snapshot ([5acae4d](https://github.com/laurigates/foundryvtt-mcp/commit/5acae4d32dfbd9d76abffedf4fd932e6b7cac206))
* **dice:** parse whole dice formulas instead of dropping what the regex missed ([f34ed0d](https://github.com/laurigates/foundryvtt-mcp/commit/f34ed0dd9383eeb523aeee2bd88da580b4afe6de)), closes [#219](https://github.com/laurigates/foundryvtt-mcp/issues/219)
* **dice:** validate per transport so REST keeps Foundry's grammar ([5c2565a](https://github.com/laurigates/foundryvtt-mcp/commit/5c2565a528eb238a11cc605fdc56bbcddca789f7))
* **dice:** validate the REST roll response instead of reading it off any ([e5754f8](https://github.com/laurigates/foundryvtt-mcp/commit/e5754f84c50bfa3fbccd0235be04d06020269f0b))
* **resources:** emit foundry://combat combatants in turn order ([48fb30b](https://github.com/laurigates/foundryvtt-mcp/commit/48fb30bfa939a10f8698595a96cea292badb6edd))
* **users:** track live presence from the userActivity socket event ([269d476](https://github.com/laurigates/foundryvtt-mcp/commit/269d476a0174234231049b859d122559a2cb1cc5)), closes [#218](https://github.com/laurigates/foundryvtt-mcp/issues/218)

## [1.5.1](https://github.com/laurigates/foundryvtt-mcp/compare/foundryvtt-mcp-v1.5.0...foundryvtt-mcp-v1.5.1) (2026-08-18)


### Bug Fixes

* **auth:** send the Foundry session as a Cookie header, and load .env before config ([#210](https://github.com/laurigates/foundryvtt-mcp/issues/210)) ([b3fd356](https://github.com/laurigates/foundryvtt-mcp/commit/b3fd356bd66578bc1d8d228264f1770dd323dbb4))

## [1.5.0](https://github.com/laurigates/foundryvtt-mcp/compare/foundryvtt-mcp-v1.4.1...foundryvtt-mcp-v1.5.0) (2026-08-11)


### Features

* **foundry:** keep worldData live and add journal visibility ([#208](https://github.com/laurigates/foundryvtt-mcp/issues/208)) ([e4e2548](https://github.com/laurigates/foundryvtt-mcp/commit/e4e2548764c751b5f29269ff2c97f5d00dc99cfe))
* **tools:** add create_journal_entry write tool ([317f708](https://github.com/laurigates/foundryvtt-mcp/commit/317f708045c5cef70b006148cf571b326d046e9e))


### Bug Fixes

* **ci:** clear dependency-audit advisories and stop failing CI on absent secrets ([#209](https://github.com/laurigates/foundryvtt-mcp/issues/209)) ([682fbdc](https://github.com/laurigates/foundryvtt-mcp/commit/682fbdcc06647a7946c05f50bda1f0711e57b72c))
* **tools:** set explicit page sort on create_journal_entry ([0ca9253](https://github.com/laurigates/foundryvtt-mcp/commit/0ca9253fb1f9a8d1582699ad71f84cb8a34a944c))

## [1.4.1](https://github.com/laurigates/foundryvtt-mcp/compare/foundryvtt-mcp-v1.4.0...foundryvtt-mcp-v1.4.1) (2026-07-17)


### Bug Fixes

* **scripts:** report REST 404s as missing endpoints, not degraded state ([#196](https://github.com/laurigates/foundryvtt-mcp/issues/196)) ([db2735e](https://github.com/laurigates/foundryvtt-mcp/commit/db2735e522a75006fc7f4ccd86019d91f75bcef6))

## [1.4.0](https://github.com/laurigates/foundryvtt-mcp/compare/foundryvtt-mcp-v1.3.0...foundryvtt-mcp-v1.4.0) (2026-07-01)


### Features

* **combat:** add start_combat and skip defeated combatants in next_turn ([#191](https://github.com/laurigates/foundryvtt-mcp/issues/191)) ([9c43807](https://github.com/laurigates/foundryvtt-mcp/commit/9c43807ce5fb182bbc6a38cd97631b496bbee633))


### Bug Fixes

* **mcp:** correct transport drift and repair test-connection script ([#193](https://github.com/laurigates/foundryvtt-mcp/issues/193)) ([df0b89e](https://github.com/laurigates/foundryvtt-mcp/commit/df0b89ec1f0d2e4a2bac71cc290c0db173a1ff56))

## [1.3.0](https://github.com/laurigates/foundryvtt-mcp/compare/foundryvtt-mcp-v1.2.1...foundryvtt-mcp-v1.3.0) (2026-06-21)


### Features

* **tools:** token manipulation write tools (move_token, apply_status_effect) ([#187](https://github.com/laurigates/foundryvtt-mcp/issues/187)) ([38c7e66](https://github.com/laurigates/foundryvtt-mcp/commit/38c7e66082e713b395a92b4010149dd77a7810c7))

## [1.2.1](https://github.com/laurigates/foundryvtt-mcp/compare/foundryvtt-mcp-v1.2.0...foundryvtt-mcp-v1.2.1) (2026-06-21)


### Bug Fixes

* **deps:** resolve bun audit vulnerabilities via transitive overrides ([#179](https://github.com/laurigates/foundryvtt-mcp/issues/179)) ([82dced1](https://github.com/laurigates/foundryvtt-mcp/commit/82dced106c1f00923b326b66e5f2249037647c7a))

## [1.2.0](https://github.com/laurigates/foundryvtt-mcp/compare/foundryvtt-mcp-v1.1.0...foundryvtt-mcp-v1.2.0) (2026-06-20)


### Features

* **tools:** combat control write tools (next_turn, end_combat, set_initiative) ([#175](https://github.com/laurigates/foundryvtt-mcp/issues/175)) ([eb8a531](https://github.com/laurigates/foundryvtt-mcp/commit/eb8a5317a907582a2eb95b2d5b25fcd8314f1718))

## [1.1.0](https://github.com/laurigates/foundryvtt-mcp/compare/foundryvtt-mcp-v1.0.1...foundryvtt-mcp-v1.1.0) (2026-06-02)


### Features

* **diagnostics:** implement get_recent_logs filters; mark diagnose_errors as stub ([#151](https://github.com/laurigates/foundryvtt-mcp/issues/151)) ([09e8b05](https://github.com/laurigates/foundryvtt-mcp/commit/09e8b05f9c19d95ff5e8632882d3df9047987b88))
* **tools:** actor item CRUD, attribute mutation & compendium search ([#142](https://github.com/laurigates/foundryvtt-mcp/issues/142), [#143](https://github.com/laurigates/foundryvtt-mcp/issues/143), [#144](https://github.com/laurigates/foundryvtt-mcp/issues/144)) ([#158](https://github.com/laurigates/foundryvtt-mcp/issues/158)) ([f28d9bd](https://github.com/laurigates/foundryvtt-mcp/commit/f28d9bd6462380cf09a39c3d5b2c14cbcb75b56d))


### Bug Fixes

* **auth:** match bracketed IPv6 [::1] loopback in plaintext-HTTP guard ([#167](https://github.com/laurigates/foundryvtt-mcp/issues/167)) ([273447c](https://github.com/laurigates/foundryvtt-mcp/commit/273447c1a655099ed5253cd6bbccb1d4a5c568b2))
* **chat:** clamp get_chat_messages limit at 100 ([#149](https://github.com/laurigates/foundryvtt-mcp/issues/149)) ([5e125cd](https://github.com/laurigates/foundryvtt-mcp/commit/5e125cde9296ed0792c762dc78633f21daf93f22))
* **ci:** fail fast on missing FoundryVTT secrets and always upload logs ([#147](https://github.com/laurigates/foundryvtt-mcp/issues/147)) ([8cd0f57](https://github.com/laurigates/foundryvtt-mcp/commit/8cd0f575f38497904be815a3a7bb955bfcfaf191))
* **ci:** replace audit-ci with bun audit in security workflow ([59e6809](https://github.com/laurigates/foundryvtt-mcp/commit/59e68094c6d68ffda5cf8b86e07c46375a59a285))
* **client:** clean up world listener on refreshWorldData timeout ([#150](https://github.com/laurigates/foundryvtt-mcp/issues/150)) ([1af305c](https://github.com/laurigates/foundryvtt-mcp/commit/1af305cdcaa6ff49e4bda080d73f18f77b76eccd))

## [1.0.1](https://github.com/laurigates/foundryvtt-mcp/compare/foundryvtt-mcp-v1.0.0...foundryvtt-mcp-v1.0.1) (2026-03-13)


### Bug Fixes

* use brace-wrapped env var syntax in MCP config ([#119](https://github.com/laurigates/foundryvtt-mcp/issues/119)) ([6708348](https://github.com/laurigates/foundryvtt-mcp/commit/6708348c017c3cc314ad3bafd0de057aea170042))

## [1.0.0](https://github.com/laurigates/foundryvtt-mcp/compare/foundryvtt-mcp-v0.11.0...foundryvtt-mcp-v1.0.0) (2026-03-07)


### ⚠ BREAKING CHANGES

* The foundry-local-rest-api module has been moved to its own repository to improve focus and enable independent versioning.

### Features

* Add Foundry Local REST API module ([7f8383a](https://github.com/laurigates/foundryvtt-mcp/commit/7f8383a9b54b3c374d960aad7f97b0b5ecff7d6d))
* add FoundryVTT v13 compatibility and API key configuration UI ([#20](https://github.com/laurigates/foundryvtt-mcp/issues/20)) ([c61559f](https://github.com/laurigates/foundryvtt-mcp/commit/c61559f758a14f4e1bb0d756b88758c10f120760))
* add serena-mcp configuration and Claude plugin setup ([#88](https://github.com/laurigates/foundryvtt-mcp/issues/88)) ([14bbdad](https://github.com/laurigates/foundryvtt-mcp/commit/14bbdade589afc4ff47348482797516960dd890f))
* Bump module version to 0.7.0 ([#27](https://github.com/laurigates/foundryvtt-mcp/issues/27)) ([cf1a38b](https://github.com/laurigates/foundryvtt-mcp/commit/cf1a38bde8b582833afcedae52dcce37929b2eb1))
* **ci:** migrate to npm trusted publishing (OIDC) ([#113](https://github.com/laurigates/foundryvtt-mcp/issues/113)) ([cf64b93](https://github.com/laurigates/foundryvtt-mcp/commit/cf64b93a3f407e58b5e57fff95293126051e53a5))
* **core:** refactor MCP server architecture with proper Socket.IO authentication ([#89](https://github.com/laurigates/foundryvtt-mcp/issues/89)) ([2e7640d](https://github.com/laurigates/foundryvtt-mcp/commit/2e7640d0f5e0b6e826a9804dca3bee0607d419de)), closes [#82](https://github.com/laurigates/foundryvtt-mcp/issues/82)
* extract foundry-local-rest-api module to standalone repository ([#84](https://github.com/laurigates/foundryvtt-mcp/issues/84)) ([4aae7d9](https://github.com/laurigates/foundryvtt-mcp/commit/4aae7d9e9ec73f3e8b886d020d9e42355c404313))
* **foundry-local-rest-api:** add local REST API module for FoundryVTT ([ad8b506](https://github.com/laurigates/foundryvtt-mcp/commit/ad8b5060ca231ffefa389cad1e6c8f68f4a4e069))
* improve UX with setup wizard, diagnostics, and enhanced error handling ([#34](https://github.com/laurigates/foundryvtt-mcp/issues/34)) ([92ba522](https://github.com/laurigates/foundryvtt-mcp/commit/92ba5225abd1b7519d8401596112171e8324b3d2))
* **justfile:** add npm-token and publish-dry-run recipes ([#111](https://github.com/laurigates/foundryvtt-mcp/issues/111)) ([39a41f7](https://github.com/laurigates/foundryvtt-mcp/commit/39a41f7c481695cf363eb0952ed013bb339c5c5c))
* modernize tool system with schema validation, caching, and enhanced WebSocket events ([#79](https://github.com/laurigates/foundryvtt-mcp/issues/79)) ([dbbfc9f](https://github.com/laurigates/foundryvtt-mcp/commit/dbbfc9f0670f8dbbfd14c53b9a63f1edb712caac))
* rename package to foundryvtt-mcp and add bin entry ([#114](https://github.com/laurigates/foundryvtt-mcp/issues/114)) ([fdc5b60](https://github.com/laurigates/foundryvtt-mcp/commit/fdc5b60000f0ca6602995f6eb3497b91065b6437))
* **test:** add integration test suite with real FoundryVTT container ([#92](https://github.com/laurigates/foundryvtt-mcp/issues/92)) ([b5c168e](https://github.com/laurigates/foundryvtt-mcp/commit/b5c168e7893f32a531a5f3bb8f9a78b02b1871ab))
* **test:** comprehensive E2E testing framework and development tooling + type safety improvements ([#74](https://github.com/laurigates/foundryvtt-mcp/issues/74)) ([0a4c856](https://github.com/laurigates/foundryvtt-mcp/commit/0a4c856b76c6fcec5e2dad3675c684df0ed7f353))


### Bug Fixes

* **author:** update author email ([#12](https://github.com/laurigates/foundryvtt-mcp/issues/12)) ([06e3895](https://github.com/laurigates/foundryvtt-mcp/commit/06e38952cce20a6517725f4a6dc7bbdf9c044661))
* **config:** replace hardcoded port 30000 with proper URL handling for reverse proxy setups ([#67](https://github.com/laurigates/foundryvtt-mcp/issues/67)) ([f6e219a](https://github.com/laurigates/foundryvtt-mcp/commit/f6e219a0dc0d2effe31f52462e67593f16da140e))
* improve config layout ([#40](https://github.com/laurigates/foundryvtt-mcp/issues/40)) ([f6496e2](https://github.com/laurigates/foundryvtt-mcp/commit/f6496e295345eed2b1203a630a482797f1f6d16d))
* resolve integration test timeouts by adding missing apiKey configuration ([#53](https://github.com/laurigates/foundryvtt-mcp/issues/53)) ([0a46713](https://github.com/laurigates/foundryvtt-mcp/commit/0a46713d72311c0542a19336f2b90186d394ee08))
* resolve integration test timeouts by adding missing apiKey configuration ([#60](https://github.com/laurigates/foundryvtt-mcp/issues/60)) ([d59dba7](https://github.com/laurigates/foundryvtt-mcp/commit/d59dba72a161ee8fcf500797c144469e7061a866))
* resolve integration test timeouts by adding missing apiKey configuration ([#62](https://github.com/laurigates/foundryvtt-mcp/issues/62)) ([a720211](https://github.com/laurigates/foundryvtt-mcp/commit/a720211a5538e9c295c73fe9568a739141b596e2))
* resolve issue [#43](https://github.com/laurigates/foundryvtt-mcp/issues/43) - FoundryClient connection lifecycle ([#46](https://github.com/laurigates/foundryvtt-mcp/issues/46)) ([9c315d6](https://github.com/laurigates/foundryvtt-mcp/commit/9c315d6a1ff1b38de7b537a900ef3bdff197d4b9))
* resolve issue [#43](https://github.com/laurigates/foundryvtt-mcp/issues/43) - FoundryClient connection lifecycle ([#55](https://github.com/laurigates/foundryvtt-mcp/issues/55)) ([b10b5eb](https://github.com/laurigates/foundryvtt-mcp/commit/b10b5eb510316e42efc56f8be9d6837982b584a4))
* resolve issue [#44](https://github.com/laurigates/foundryvtt-mcp/issues/44) - WebSocket functionality not working properly ([#48](https://github.com/laurigates/foundryvtt-mcp/issues/48)) ([ae93be9](https://github.com/laurigates/foundryvtt-mcp/commit/ae93be918ce0f281f942bad292dda45eac37c8a7))
* resolve issue [#44](https://github.com/laurigates/foundryvtt-mcp/issues/44) - WebSocket functionality not working properly ([#56](https://github.com/laurigates/foundryvtt-mcp/issues/56)) ([629e1df](https://github.com/laurigates/foundryvtt-mcp/commit/629e1df67a5ebf9e237662383d6a92afdd1903c2))
* resolve issue [#45](https://github.com/laurigates/foundryvtt-mcp/issues/45) - API retry mechanism not working ([#50](https://github.com/laurigates/foundryvtt-mcp/issues/50)) ([a22e478](https://github.com/laurigates/foundryvtt-mcp/commit/a22e4780df11031e3536f99ea127195b3c0a992e))
* resolve issue [#45](https://github.com/laurigates/foundryvtt-mcp/issues/45) - API retry mechanism not working ([#58](https://github.com/laurigates/foundryvtt-mcp/issues/58)) ([3050ad0](https://github.com/laurigates/foundryvtt-mcp/commit/3050ad086d599aacb9aa275797da494ee83592a1))
* resolve test failures and improve error handling ([#63](https://github.com/laurigates/foundryvtt-mcp/issues/63)) ([ca8d01f](https://github.com/laurigates/foundryvtt-mcp/commit/ca8d01f8039ce3493c08b96b27f8df9e7aa53e31))
* resolve test failures and security vulnerabilities ([#71](https://github.com/laurigates/foundryvtt-mcp/issues/71)) ([6a4f79e](https://github.com/laurigates/foundryvtt-mcp/commit/6a4f79e1be5a33cebb074be71db0d275cd4c49e3))
* Update module metadata and URLs ([#9](https://github.com/laurigates/foundryvtt-mcp/issues/9)) ([06aeed4](https://github.com/laurigates/foundryvtt-mcp/commit/06aeed46e584ba4c68762934110ea22a6566c5fb))
* update README to document comprehensive diagnostics functionality ([#18](https://github.com/laurigates/foundryvtt-mcp/issues/18)) ([66a48ec](https://github.com/laurigates/foundryvtt-mcp/commit/66a48ecfcfce00f8a80698b47fa45c8f36f6b27f))
* update release-please workflow permissions and configuration ([#4](https://github.com/laurigates/foundryvtt-mcp/issues/4)) ([e7528db](https://github.com/laurigates/foundryvtt-mcp/commit/e7528db011e4de1d02020769abf65fb711f8ac12))
* update release-please workflow permissions and configuration ([#5](https://github.com/laurigates/foundryvtt-mcp/issues/5)) ([7e2ea4f](https://github.com/laurigates/foundryvtt-mcp/commit/7e2ea4f9d8bf6a6d3a1dce866e3f487110b00a53))
* update workflow tag patterns for single package ([#32](https://github.com/laurigates/foundryvtt-mcp/issues/32)) ([7158369](https://github.com/laurigates/foundryvtt-mcp/commit/7158369b7a4de1e4cc94380a7773a81b69617f09))
* workflow trigger tags ([#36](https://github.com/laurigates/foundryvtt-mcp/issues/36)) ([f60c84d](https://github.com/laurigates/foundryvtt-mcp/commit/f60c84d69bf042149124124e08808fb9504f5efb))

## [0.11.0](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.10.0...foundry-mcp-server-v0.11.0) (2025-08-03)


### Features

* modernize tool system with schema validation, caching, and enhanced WebSocket events ([#79](https://github.com/laurigates/foundryvtt-mcp/issues/79)) ([dbbfc9f](https://github.com/laurigates/foundryvtt-mcp/commit/dbbfc9f0670f8dbbfd14c53b9a63f1edb712caac))

## [0.10.0](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.9.11...foundry-mcp-server-v0.10.0) (2025-07-12)


### Features

* **test:** comprehensive E2E testing framework and development tooling + type safety improvements ([#74](https://github.com/laurigates/foundryvtt-mcp/issues/74)) ([0a4c856](https://github.com/laurigates/foundryvtt-mcp/commit/0a4c856b76c6fcec5e2dad3675c684df0ed7f353))

## [0.9.11](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.9.10...foundry-mcp-server-v0.9.11) (2025-07-10)


### Bug Fixes

* resolve test failures and security vulnerabilities ([#71](https://github.com/laurigates/foundryvtt-mcp/issues/71)) ([6a4f79e](https://github.com/laurigates/foundryvtt-mcp/commit/6a4f79e1be5a33cebb074be71db0d275cd4c49e3))

## [0.9.10](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.9.9...foundry-mcp-server-v0.9.10) (2025-07-09)


### Bug Fixes

* **config:** replace hardcoded port 30000 with proper URL handling for reverse proxy setups ([#67](https://github.com/laurigates/foundryvtt-mcp/issues/67)) ([f6e219a](https://github.com/laurigates/foundryvtt-mcp/commit/f6e219a0dc0d2effe31f52462e67593f16da140e))

## [0.9.9](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.9.8...foundry-mcp-server-v0.9.9) (2025-07-07)


### Bug Fixes

* resolve integration test timeouts by adding missing apiKey configuration ([#62](https://github.com/laurigates/foundryvtt-mcp/issues/62)) ([a720211](https://github.com/laurigates/foundryvtt-mcp/commit/a720211a5538e9c295c73fe9568a739141b596e2))
* resolve test failures and improve error handling ([#63](https://github.com/laurigates/foundryvtt-mcp/issues/63)) ([ca8d01f](https://github.com/laurigates/foundryvtt-mcp/commit/ca8d01f8039ce3493c08b96b27f8df9e7aa53e31))

## [0.9.8](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.9.7...foundry-mcp-server-v0.9.8) (2025-07-06)


### Bug Fixes

* resolve integration test timeouts by adding missing apiKey configuration ([#60](https://github.com/laurigates/foundryvtt-mcp/issues/60)) ([d59dba7](https://github.com/laurigates/foundryvtt-mcp/commit/d59dba72a161ee8fcf500797c144469e7061a866))

## [0.9.7](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.9.6...foundry-mcp-server-v0.9.7) (2025-07-05)


### Bug Fixes

* resolve issue [#45](https://github.com/laurigates/foundryvtt-mcp/issues/45) - API retry mechanism not working ([#58](https://github.com/laurigates/foundryvtt-mcp/issues/58)) ([3050ad0](https://github.com/laurigates/foundryvtt-mcp/commit/3050ad086d599aacb9aa275797da494ee83592a1))

## [0.9.6](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.9.5...foundry-mcp-server-v0.9.6) (2025-07-05)


### Bug Fixes

* resolve integration test timeouts by adding missing apiKey configuration ([#53](https://github.com/laurigates/foundryvtt-mcp/issues/53)) ([0a46713](https://github.com/laurigates/foundryvtt-mcp/commit/0a46713d72311c0542a19336f2b90186d394ee08))
* resolve issue [#43](https://github.com/laurigates/foundryvtt-mcp/issues/43) - FoundryClient connection lifecycle ([#55](https://github.com/laurigates/foundryvtt-mcp/issues/55)) ([b10b5eb](https://github.com/laurigates/foundryvtt-mcp/commit/b10b5eb510316e42efc56f8be9d6837982b584a4))
* resolve issue [#44](https://github.com/laurigates/foundryvtt-mcp/issues/44) - WebSocket functionality not working properly ([#56](https://github.com/laurigates/foundryvtt-mcp/issues/56)) ([629e1df](https://github.com/laurigates/foundryvtt-mcp/commit/629e1df67a5ebf9e237662383d6a92afdd1903c2))

## [0.9.5](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.9.4...foundry-mcp-server-v0.9.5) (2025-07-05)


### Bug Fixes

* resolve issue [#45](https://github.com/laurigates/foundryvtt-mcp/issues/45) - API retry mechanism not working ([#50](https://github.com/laurigates/foundryvtt-mcp/issues/50)) ([a22e478](https://github.com/laurigates/foundryvtt-mcp/commit/a22e4780df11031e3536f99ea127195b3c0a992e))

## [0.9.4](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.9.3...foundry-mcp-server-v0.9.4) (2025-07-05)


### Bug Fixes

* resolve issue [#44](https://github.com/laurigates/foundryvtt-mcp/issues/44) - WebSocket functionality not working properly ([#48](https://github.com/laurigates/foundryvtt-mcp/issues/48)) ([ae93be9](https://github.com/laurigates/foundryvtt-mcp/commit/ae93be918ce0f281f942bad292dda45eac37c8a7))

## [0.9.3](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.9.2...foundry-mcp-server-v0.9.3) (2025-07-05)


### Bug Fixes

* resolve issue [#43](https://github.com/laurigates/foundryvtt-mcp/issues/43) - FoundryClient connection lifecycle ([#46](https://github.com/laurigates/foundryvtt-mcp/issues/46)) ([9c315d6](https://github.com/laurigates/foundryvtt-mcp/commit/9c315d6a1ff1b38de7b537a900ef3bdff197d4b9))

## [0.9.2](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.9.1...foundry-mcp-server-v0.9.2) (2025-06-24)


### Bug Fixes

* improve config layout ([#40](https://github.com/laurigates/foundryvtt-mcp/issues/40)) ([f6496e2](https://github.com/laurigates/foundryvtt-mcp/commit/f6496e295345eed2b1203a630a482797f1f6d16d))

## [0.9.1](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.9.0...foundry-mcp-server-v0.9.1) (2025-06-24)


### Bug Fixes

* workflow trigger tags ([#36](https://github.com/laurigates/foundryvtt-mcp/issues/36)) ([f60c84d](https://github.com/laurigates/foundryvtt-mcp/commit/f60c84d69bf042149124124e08808fb9504f5efb))

## [0.9.0](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.8.1...foundry-mcp-server-v0.9.0) (2025-06-24)


### Features

* Add Foundry Local REST API module ([7f8383a](https://github.com/laurigates/foundryvtt-mcp/commit/7f8383a9b54b3c374d960aad7f97b0b5ecff7d6d))
* add FoundryVTT v13 compatibility and API key configuration UI ([#20](https://github.com/laurigates/foundryvtt-mcp/issues/20)) ([c61559f](https://github.com/laurigates/foundryvtt-mcp/commit/c61559f758a14f4e1bb0d756b88758c10f120760))
* Bump module version to 0.7.0 ([#27](https://github.com/laurigates/foundryvtt-mcp/issues/27)) ([cf1a38b](https://github.com/laurigates/foundryvtt-mcp/commit/cf1a38bde8b582833afcedae52dcce37929b2eb1))
* **foundry-local-rest-api:** add local REST API module for FoundryVTT ([ad8b506](https://github.com/laurigates/foundryvtt-mcp/commit/ad8b5060ca231ffefa389cad1e6c8f68f4a4e069))
* improve UX with setup wizard, diagnostics, and enhanced error handling ([#34](https://github.com/laurigates/foundryvtt-mcp/issues/34)) ([92ba522](https://github.com/laurigates/foundryvtt-mcp/commit/92ba5225abd1b7519d8401596112171e8324b3d2))


### Bug Fixes

* **author:** update author email ([#12](https://github.com/laurigates/foundryvtt-mcp/issues/12)) ([06e3895](https://github.com/laurigates/foundryvtt-mcp/commit/06e38952cce20a6517725f4a6dc7bbdf9c044661))
* Update module metadata and URLs ([#9](https://github.com/laurigates/foundryvtt-mcp/issues/9)) ([06aeed4](https://github.com/laurigates/foundryvtt-mcp/commit/06aeed46e584ba4c68762934110ea22a6566c5fb))
* update README to document comprehensive diagnostics functionality ([#18](https://github.com/laurigates/foundryvtt-mcp/issues/18)) ([66a48ec](https://github.com/laurigates/foundryvtt-mcp/commit/66a48ecfcfce00f8a80698b47fa45c8f36f6b27f))
* update release-please workflow permissions and configuration ([#4](https://github.com/laurigates/foundryvtt-mcp/issues/4)) ([e7528db](https://github.com/laurigates/foundryvtt-mcp/commit/e7528db011e4de1d02020769abf65fb711f8ac12))
* update release-please workflow permissions and configuration ([#5](https://github.com/laurigates/foundryvtt-mcp/issues/5)) ([7e2ea4f](https://github.com/laurigates/foundryvtt-mcp/commit/7e2ea4f9d8bf6a6d3a1dce866e3f487110b00a53))
* update workflow tag patterns for single package ([#32](https://github.com/laurigates/foundryvtt-mcp/issues/32)) ([7158369](https://github.com/laurigates/foundryvtt-mcp/commit/7158369b7a4de1e4cc94380a7773a81b69617f09))

## [0.7.0](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.6.0...foundry-mcp-server-v0.7.0) (2025-06-23)


### Features

* Add Foundry Local REST API module ([7f8383a](https://github.com/laurigates/foundryvtt-mcp/commit/7f8383a9b54b3c374d960aad7f97b0b5ecff7d6d))
* add FoundryVTT v13 compatibility and API key configuration UI ([#20](https://github.com/laurigates/foundryvtt-mcp/issues/20)) ([c61559f](https://github.com/laurigates/foundryvtt-mcp/commit/c61559f758a14f4e1bb0d756b88758c10f120760))
* **foundry-local-rest-api:** add local REST API module for FoundryVTT ([ad8b506](https://github.com/laurigates/foundryvtt-mcp/commit/ad8b5060ca231ffefa389cad1e6c8f68f4a4e069))


### Bug Fixes

* **author:** update author email ([#12](https://github.com/laurigates/foundryvtt-mcp/issues/12)) ([06e3895](https://github.com/laurigates/foundryvtt-mcp/commit/06e38952cce20a6517725f4a6dc7bbdf9c044661))
* Update module metadata and URLs ([#9](https://github.com/laurigates/foundryvtt-mcp/issues/9)) ([06aeed4](https://github.com/laurigates/foundryvtt-mcp/commit/06aeed46e584ba4c68762934110ea22a6566c5fb))
* update README to document comprehensive diagnostics functionality ([#18](https://github.com/laurigates/foundryvtt-mcp/issues/18)) ([66a48ec](https://github.com/laurigates/foundryvtt-mcp/commit/66a48ecfcfce00f8a80698b47fa45c8f36f6b27f))
* update release-please workflow permissions and configuration ([#4](https://github.com/laurigates/foundryvtt-mcp/issues/4)) ([e7528db](https://github.com/laurigates/foundryvtt-mcp/commit/e7528db011e4de1d02020769abf65fb711f8ac12))
* update release-please workflow permissions and configuration ([#5](https://github.com/laurigates/foundryvtt-mcp/issues/5)) ([7e2ea4f](https://github.com/laurigates/foundryvtt-mcp/commit/7e2ea4f9d8bf6a6d3a1dce866e3f487110b00a53))

## [0.5.1](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.5.0...foundry-mcp-server-v0.5.1) (2025-06-23)


### Miscellaneous

* release main ([#23](https://github.com/laurigates/foundryvtt-mcp/issues/23)) ([bcf3d60](https://github.com/laurigates/foundryvtt-mcp/commit/bcf3d60622534eba1b7fccd7fdeb99888412acb1))

## [0.5.0](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.4.4...foundry-mcp-server-v0.5.0) (2025-06-23)


### Features

* add FoundryVTT v13 compatibility and API key configuration UI ([#20](https://github.com/laurigates/foundryvtt-mcp/issues/20)) ([c61559f](https://github.com/laurigates/foundryvtt-mcp/commit/c61559f758a14f4e1bb0d756b88758c10f120760))

## [0.4.4](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.4.3...foundry-mcp-server-v0.4.4) (2025-06-23)


### Bug Fixes

* update README to document comprehensive diagnostics functionality ([#18](https://github.com/laurigates/foundryvtt-mcp/issues/18)) ([66a48ec](https://github.com/laurigates/foundryvtt-mcp/commit/66a48ecfcfce00f8a80698b47fa45c8f36f6b27f))

## [0.4.3](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.4.2...foundry-mcp-server-v0.4.3) (2025-06-23)


### Miscellaneous

* release main ([#14](https://github.com/laurigates/foundryvtt-mcp/issues/14)) ([4feba6d](https://github.com/laurigates/foundryvtt-mcp/commit/4feba6da1c3bba91c7ef6ea0b3d52a5a043e78bc))

## [0.4.2](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.4.1...foundry-mcp-server-v0.4.2) (2025-06-23)


### Bug Fixes

* **author:** update author email ([#12](https://github.com/laurigates/foundryvtt-mcp/issues/12)) ([06e3895](https://github.com/laurigates/foundryvtt-mcp/commit/06e38952cce20a6517725f4a6dc7bbdf9c044661))

## [0.4.1](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.4.0...foundry-mcp-server-v0.4.1) (2025-06-23)


### Bug Fixes

* Update module metadata and URLs ([#9](https://github.com/laurigates/foundryvtt-mcp/issues/9)) ([06aeed4](https://github.com/laurigates/foundryvtt-mcp/commit/06aeed46e584ba4c68762934110ea22a6566c5fb))

## [0.4.0](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.3.0...foundry-mcp-server-v0.4.0) (2025-06-21)


### Features

* Add Foundry Local REST API module ([7f8383a](https://github.com/laurigates/foundryvtt-mcp/commit/7f8383a9b54b3c374d960aad7f97b0b5ecff7d6d))
* **foundry-local-rest-api:** add local REST API module for FoundryVTT ([ad8b506](https://github.com/laurigates/foundryvtt-mcp/commit/ad8b5060ca231ffefa389cad1e6c8f68f4a4e069))


### Bug Fixes

* update release-please workflow permissions and configuration ([#4](https://github.com/laurigates/foundryvtt-mcp/issues/4)) ([e7528db](https://github.com/laurigates/foundryvtt-mcp/commit/e7528db011e4de1d02020769abf65fb711f8ac12))
* update release-please workflow permissions and configuration ([#5](https://github.com/laurigates/foundryvtt-mcp/issues/5)) ([7e2ea4f](https://github.com/laurigates/foundryvtt-mcp/commit/7e2ea4f9d8bf6a6d3a1dce866e3f487110b00a53))


### Miscellaneous

* release main ([cbac663](https://github.com/laurigates/foundryvtt-mcp/commit/cbac663ae79aeeb9bd98ada23823ea04cf41ebb6))
* release main ([0a6b436](https://github.com/laurigates/foundryvtt-mcp/commit/0a6b436ddd4af83c4dd0c3cb2802f1bb4d8a0047))
* release main ([#2](https://github.com/laurigates/foundryvtt-mcp/issues/2)) ([4b9110d](https://github.com/laurigates/foundryvtt-mcp/commit/4b9110df6c978942affa1f20f68f7a9fdd548e32))

## [0.3.0](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.2.0...foundry-mcp-server-v0.3.0) (2025-06-16)


### Features

* Add Foundry Local REST API module ([7f8383a](https://github.com/laurigates/foundryvtt-mcp/commit/7f8383a9b54b3c374d960aad7f97b0b5ecff7d6d))
* **foundry-local-rest-api:** add local REST API module for FoundryVTT ([ad8b506](https://github.com/laurigates/foundryvtt-mcp/commit/ad8b5060ca231ffefa389cad1e6c8f68f4a4e069))


### Miscellaneous

* release main ([cbac663](https://github.com/laurigates/foundryvtt-mcp/commit/cbac663ae79aeeb9bd98ada23823ea04cf41ebb6))
* release main ([0a6b436](https://github.com/laurigates/foundryvtt-mcp/commit/0a6b436ddd4af83c4dd0c3cb2802f1bb4d8a0047))

## [0.2.0](https://github.com/laurigates/foundryvtt-mcp/compare/foundry-mcp-server-v0.1.0...foundry-mcp-server-v0.2.0) (2025-06-16)


### Features

* Add Foundry Local REST API module ([7f8383a](https://github.com/laurigates/foundryvtt-mcp/commit/7f8383a9b54b3c374d960aad7f97b0b5ecff7d6d))
* **foundry-local-rest-api:** add local REST API module for FoundryVTT ([ad8b506](https://github.com/laurigates/foundryvtt-mcp/commit/ad8b5060ca231ffefa389cad1e6c8f68f4a4e069))
