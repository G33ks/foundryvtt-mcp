# Development Guide

## Project Structure

```
src/
├── config/              # Zod-validated configuration
├── foundry/
│   ├── auth.ts          # Socket.IO 4-step authentication
│   ├── client.ts        # FoundryVTT client with worldData cache
│   └── types.ts         # TypeScript interfaces + WorldData
├── tools/
│   ├── definitions.ts   # Tool schemas by category
│   ├── router.ts        # Tool request routing
│   ├── resources.ts     # MCP resource definitions
│   └── handlers/        # Per-tool handler implementations
├── diagnostics/         # Optional REST API diagnostics
├── utils/               # Logger, cache utilities
└── index.ts             # MCP server entry point
```

## Adding New Tools

See [Adding a tool](../../CONTRIBUTING.md#adding-a-tool) in CONTRIBUTING.md: definition, routing, handler, tests, and the write queue for a tool that changes the world.

## Testing

```bash
# Unit tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage

# Lint code
npm run lint

# E2E tests (requires running FoundryVTT)
npm run test:e2e
```

### Smoke tests

Three smoke tests verify the server boots end-to-end without a live FoundryVTT.
They run in CI on every PR and catch failure modes that the mocked Vitest
suite cannot. They are isolated from your own configuration and connector
(see [CONTRIBUTING.md](../../CONTRIBUTING.md#checks-before-a-pull-request)):

```bash
npm run smoke         # Spawn dist/index.js, verify the startup banner on stderr
npm run smoke:dotenv  # Configuration from a .env file is read before it is needed
npm run smoke:pack    # npm pack -> check contents -> install into a fresh consumer -> bin --version -> verify banner
```

`smoke` covers construction-time and import-time regressions (SDK shape
changes, ESM resolution). `smoke:pack` additionally validates that the
`package.json` `files` glob ships every runtime path the entrypoint needs —
the kind of regression that only surfaces for users who install the published
package (`@g33ks/foundryvtt-mcp`), not for anyone running the source tree
(`node dist/index.js` from a clone). It also fails on a source map, a
declaration file, or a compiled file left in `dist/` without its source.

## Building

```bash
# Development build
npm run build

# Clean build
npm run clean && npm run build

# Development mode with hot reload
npm run dev
```
