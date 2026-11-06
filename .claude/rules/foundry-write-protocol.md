---
paths:
  - "src/foundry/**"
  - "src/tools/**"
---

# FoundryVTT Transport & Write Protocol

How the MCP server talks to FoundryVTT, and how to perform game-state
mutations. Read this before adding any tool that reads or (especially) writes
FoundryVTT documents.

## Two transports — Socket.IO is primary

| Mode | Trigger | What it does |
|------|---------|--------------|
| **Socket.IO** (primary) | `FOUNDRY_USERNAME` + `FOUNDRY_PASSWORD` | Authenticates a real Foundry client session (4-step `/join` flow in `auth.ts`), connects to `FOUNDRY_URL` (`:30000`), and loads a read-only `worldData` snapshot. Reads are served from that cache. |
| **REST / `apiKey`** (secondary) | `FOUNDRY_API_KEY` set | Hits `/api/*` on the Foundry Local REST API module, a separate project. Optional — it backs the diagnostics tools, `search_compendium` and a few reads (see CLAUDE.md). |

`.env.example` states Socket.IO is the primary method and `FOUNDRY_API_KEY` is
commented out. **Do not assume the REST path is in use** — default
deployments are Socket.IO-only. The REST API module is a separate project, not
shipped here. The companion module this repo does ship ("FoundryVTT MCP
Bridge", `foundry-module/`, released on `bridge-v*` tags by
`bridge-release.yml`) is not the REST transport: it is the WebSocket bridge
enabled by `FOUNDRY_MODULE_BRIDGE_ENABLED`, which carries the canvas-only tools.

## Writes use the core `modifyDocument` Socket.IO protocol

Mutations go over the existing authenticated socket (no bridge), per PRD-003
(`docs/prds/write-operations.md`). The transport lives in `client.ts`:
`assertWriteable()` → `emitWithAck()` → `modifyDocument()`.

- **Gate**: writes require `FOUNDRY_WRITE_ENABLED=true` **and** an active socket
  (`assertWriteable`). The connected user needs GM/owner permission.
- **Request** (standard Socket.IO ack callback): `socket.emit("modifyDocument", request, cb)` where
  `request = { type, action, operation }`:
  - `type`: document name — `"Actor"`, `"Item"`, …
  - `action`: `"create" | "update" | "delete"`
  - `operation`: `data:[…]` (create) / `updates:[{_id, …}]` (update) / `ids:[…]` (delete),
    plus `broadcast:true`, `pack:null`, and — for embedded docs —
    `parentUuid:"Actor.<actorId>"`.
- **Response**: `{ type, action, operation, userId, result: object[]|string[], error? }`.
  Reject on `response.error`; `result` holds created/updated data or deleted ids.
- Actor `system` updates take **dot-notation keys prefixed with `system.`**
  (e.g. `"system.attributes.hp.value"`); Foundry merges recursively.

## The cache follows writes automatically (laurigates/foundryvtt-mcp#205)

`worldData` is no longer a connect-time snapshot. `client.ts` subscribes to the
`modifyDocument` **broadcast** — the same event, arriving unsolicited — and
`world-cache.ts` applies it to the cached collections. So a read after a write
sees the write, and changes made by *other* users (a player moving a token, the
GM editing in the UI) land in the cache too.

FoundryVTT v14 also uses a second channel, **`modifyDocumentBatch`**
(`{results: DocumentSocketResponse[]}`, side effects first, the operation
last). It carries `foundry.documents.modifyBatch()` calls and **every single
operation with server-side side effects** — activating a scene or combat
deactivates the others, deleting a folder deletes or moves its contents,
token moves that update attached regions, level deletions, `core.time`
updates (server `_sideEffects`, v14.369). A change arrives on one channel
only, and neither is echoed to the client that made it. `client.ts` handles
both channels the same way, and `modifyDocument()` accepts the same
`{results}` shape as the **ack** of the connector's own writes (errors can
sit in any element; the operation's own result is the last one).

Consequences for new write tools:

- **Do not hand-patch `worldData` in a mutation method.** The broadcast already
  covers it, and a manual splice would double-apply. Applying is idempotent
  (`create` upserts by `_id`), so a doubled apply is harmless — but it is still
  redundant code that will drift.
- **A new document type needs a map entry**, not new plumbing: add it to
  `TOP_LEVEL_COLLECTIONS` or `EMBEDDED_COLLECTIONS` in `world-cache.ts`.
  Unmapped types are dropped silently (by design — an unmodelled payload leaves
  the cache stale rather than corrupt).
- **Known gap**: broadcasts parented to a *synthetic token actor*
  (`Scene.<sid>.Token.<tid>.Actor.<aid>`, unlinked tokens) are not applied —
  that actor is a per-token delta, not a document in any cached collection.
  Those still need `refresh_world_data`.
- `refreshWorldData()` (re-emits `world`) remains the full-resync escape hatch.

## Verify the protocol against the bundled app source — don't guess

The exact wire shape is FoundryVTT-version-specific and **not reliably
documented on the web** (the wiki is JS-rendered). The authoritative source is
the actual app, which ships its client and common code unminified. This repo
does not carry it: you need a local copy of a FoundryVTT installation of the
target version (the desktop app's `resources/app/` folder, or the root of the
extracted Node.js build), and the paths below are relative to it.

The maintainers' test server keeps such a build in `~/foundryvtt` (Node.js
build of the version under test, read-only use): `client/` and `common/` are
the readable source; `dist/` is the minified server, of little use for
reading. Check `package.json` there for the build number.

Key files: `client/data/client-backend.mjs` (`#buildRequest`/`#dispatchRequest`),
`client/helpers/socket-interface.mjs` (`dispatch` = emit-with-ack), and
`common/abstract/socket.mjs` + `common/abstract/_types.mjs` (response shape and
per-action `operation` fields). When implementing a new write feature
(combat, tokens, scenes — PRD-003 FR-018…FR-024), confirm the shape there
first, then smoke-test one round-trip against a live world.

## What does NOT map to `modifyDocument`

Compendium reads use `CompendiumCollection.getDocuments` / the pack index — a
separate path, not `modifyDocument`, and the connector does not speak it over
Socket.IO. `search_compendium` stays on the REST path (graceful-empty without
`apiKey`); compendium content and compendium sources go through the companion
module instead (`search_compendium_content`, `import_compendium_actor`, and
`create_actor_item` with a compendium source read the document there, then
create it with `modifyDocument`). Design a pack-read path before adding
compendium reads over the socket.
