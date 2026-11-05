# Project: foundryvtt-mcp

Model Context Protocol (MCP) server bridging AI assistants with FoundryVTT tabletop gaming software.

## Tech Stack

- **Language**: TypeScript (ES modules, `.js` imports for MCP SDK compatibility)
- **Runtime**: Node.js (npm as package manager)
- **Test**: Vitest (unit + integration), Playwright (E2E)
- **Lint/Format**: Biome (linting + formatting)
- **Validation**: Zod schemas

## Essential Commands

```bash
npm run build          # Compile TypeScript
npm run dev            # Development mode with hot reload
npm test               # Unit tests (Vitest)
npm run test:integration # Integration tests (needs :30001 container + .env.integration — prefer `npm run test:integration:docker`)
npm run test:e2e       # E2E tests (Playwright, headless)
npm run lint           # Lint code (Biome)
npm run lint:fix       # Auto-fix lint issues
npm run format         # Format code (Biome)
node dist/index.js init         # Write the shared configuration file, checking each answer
node dist/index.js init --check # Check the configuration against FoundryVTT
node dist/index.js status       # Shared process state and where each setting comes from
node dist/index.js stop         # Stop the shared process (next call starts a fresh one)
```

## Architecture

### Data Flow

1. AI assistant calls MCP tool → relay (`src/shared/relay.ts`, default mode) forwards it
   over a named pipe / Unix socket to the shared process (`src/shared/daemon.ts`);
   with `FOUNDRY_MCP_SHARED=false` the stdio process handles it itself (`src/server.ts`)
2. `FoundryCore.callTool` (`src/core.ts`) → write tools wait in a FIFO queue → `src/tools/router.ts`
3. Router dispatches to handler → `src/tools/handlers/`
4. Handler queries cached worldData → `src/foundry/client.ts`
5. Response returned as MCP result

`src/index.ts` only dispatches on the first argument (`daemon`, `status`, `stop`,
none = MCP stdio server) and imports each role lazily: the relay and the control
commands must not load Socket.IO or Playwright.

### Key Modules

| Module | Path | Purpose |
|--------|------|---------|
| Core | `src/core.ts` | FoundryVTT client + module bridge + headless GM session, tool routing, write queue |
| Shared mode | `src/shared/` | Relay, shared process, IPC protocol, autostart, `status`/`stop` |
| Write tools | `src/tools/write-tools.ts` | Tools serialised by the write queue — add every new mutation tool |
| Client | `src/foundry/client.ts` | Socket.IO connection, world state cache |
| Journal integrity | `src/foundry/journal-integrity.ts`, `journal-history.ts` | Page version tokens, overwrite watch (`modifyDocument` + `pm.autosave`), local copies in the state dir |
| Auth | `src/foundry/auth.ts` | 4-step Socket.IO authentication |
| Config | `src/config/index.ts` | Zod-validated environment config |
| Tools | `src/tools/definitions.ts` | MCP tool schemas |
| Router | `src/tools/router.ts` | Request→handler dispatch |
| Types | `src/foundry/types.ts` | FoundryVTT entity interfaces |

### Authentication & transport selection

The two transports in `client.ts` are **additive** (see `connect()` and
`isConnected()`):

- **Socket.IO** (primary): runs whenever `FOUNDRY_USERNAME` (or
  `FOUNDRY_USER_ID`) and `FOUNDRY_PASSWORD` are set — authenticates, loads full
  `worldData` and carries every write.
- **REST API module** (`FOUNDRY_API_KEY` set): `connect()` also checks the
  module's `/api/status`. It backs the diagnostics tools and
  `search_compendium`, and a few reads prefer it over the cache when a key is
  set (`searchActors`, `getActor`, `searchItems`, `getCurrentScene`,
  `getWorldInfo`, `rollDice`). A REST failure is non-fatal while Socket.IO
  credentials are present; with an API key alone, REST is the only transport.
- `isConnected()` prefers the socket's state once a socket exists, and falls
  back to the REST link only without one.
- `USE_REST_MODULE` is **not read** anywhere — a no-op if it shows up in an
  old `.env`.

## Environment Variables

Every setting resolves per name: environment, then `.env` in the working
directory, then the shared configuration file, then the default
(`src/config/sources.ts`). Never read `process.env.FOUNDRY_*` directly.

| Variable | Required | Description |
|----------|----------|-------------|
| `FOUNDRY_URL` | Yes | FoundryVTT server URL |
| `FOUNDRY_USERNAME` | Yes | FoundryVTT user |
| `FOUNDRY_PASSWORD` | Yes | FoundryVTT password |
| `FOUNDRY_USER_ID` | No | Bypass username→ID resolution |
| `FOUNDRY_API_KEY` | No | REST API module key (read-only, alongside Socket.IO: diagnostics, `search_compendium`, some reads) |
| `FOUNDRY_WRITE_ENABLED` | No | Enable game-state mutations — `true` required for the write tools (default `false`) |
| `LOG_LEVEL` | No | `debug` for verbose output |
| `FOUNDRY_TIMEOUT` | No | Request timeout (ms, default 10000) |
| `FOUNDRY_MCP_SHARED` | No | `false` = all-in-one process instead of relay + shared process (default `true`) |
| `FOUNDRY_MCP_IDLE_TIMEOUT_MINUTES` | No | Shared process exits after this long with no relay connected (default 5, `0` = never) |
| `FOUNDRY_MCP_STATE_DIR` | No | Isolated state dir (token, `daemon.json`, logs, `config.env`) with its own pipe — use it in tests |
| `FOUNDRY_MCP_CONFIG` | No | Configuration file to read instead of `<state dir>/config.env` (Windows) or `~/.config/foundryvtt-mcp/config.env` |

## Rules

See `.claude/rules/` for detailed guidelines:
- `development.md` — TDD workflow, commit conventions, build commands
- `testing.md` — Test tiers (unit, integration, E2E) and requirements
- `foundry-write-protocol.md` — transport (Socket.IO vs REST) and the `modifyDocument` write protocol
- `scripts-typecheck-gap.md` — `scripts/` is outside the typecheck surface: run a script after editing it
- `esm-entrypoint-env-loading.md` — ESM runs imports before the entrypoint's body, so configuration read at module scope must not depend on loading `.env` there

## Reference

- [FoundryVTT API](https://foundryvtt.com/api/)
- [Playwright Docs](https://playwright.dev/docs/intro)
- [MCP SDK](https://modelcontextprotocol.io/docs)
