---
paths:
  - "src/index.ts"
  - "src/config/sources.ts"
  - "src/config/env-layers.ts"
  - "src/config/**"
  - "src/utils/logger.ts"
  - "scripts/**"
---

# `dotenv.config()` in an Entrypoint's Body Is Already Too Late

ESM evaluates a module's **imports before its own body**. So an entrypoint
that imports its dependencies and *then* calls `dotenv.config()` has already
run every one of those modules against a `process.env` that never saw `.env`.
Any module reading configuration at **module scope** locks in the pre-dotenv
values, and nothing about the code looks wrong — the import is right there,
the dependency is installed, the call is present.

## The cost (real: issue #206, fixed in #210)

`src/index.ts` called `dotenv.config({ quiet: true })` in its body.
`src/utils/logger.ts` builds its logger at module scope:

```ts
export const logger = new Logger(config.logLevel);   // ← resolves the WHOLE config
```

`config` is a lazy Proxy, so it is only *meant* to resolve on first access —
but that access is this line, during import evaluation. Configuration was
therefore validated before `.env` was read, and startup died with
`Configuration validation failed` while the help text told the user to check
the `.env` file it had just ignored. `scripts/test-connection.ts` (since removed) carried the
identical defect.

The reporter diagnosed it as a missing `dotenv` dependency. It was not:
`dotenv` has been imported since the initial commit and is in every published
tarball. **The symptom of "env file not loaded" is identical whether the
loader is absent or merely late** — which is why the wrong cause is the
natural guess.

## The rule (since the configuration file, chantier 5 phase 2)

- **Nothing loads `.env` into `process.env` any more.** `src/config/sources.ts`
  resolves every setting on demand, per setting: environment, then `.env` in
  the working directory (parsed by `src/config/env-layers.ts`), then the
  configuration file, then the default — and keeps where each came from.
  `src/load-env.ts` is gone. With no injection there is no import order to
  get wrong: a module that resolves configuration at any time sees `.env`.

- **Read settings through the resolver**, never `process.env.FOUNDRY_*`
  directly: `config`/`getConfig()` for validated values, `resolveSettings()`
  (or `processSettings()` for `FOUNDRY_MCP_STATE_DIR`/`FOUNDRY_MCP_CONFIG`)
  for raw ones. A direct read misses `.env` and the file — the same symptom
  as #206. Known exceptions left for later: `scripts/diagnose-api.ts`,
  `scripts/run-e2e-tests.ts`.

- **Never inject.** The relay hands its own environment to the shared process
  it starts; injected `.env` or file values would arrive there as
  "environment" and defeat the "file is authoritative" rule (`daemon.ts`).

- **Be wary of module-scope config reads.** `logger.ts` resolves its level on
  first use and falls back to `info` while there is no usable configuration;
  it must never throw or exit.

## Verify it, and verify it the only way that works

A unit test cannot cover this: the defect is in module evaluation order **in a
real process**, and any test that imports the modules has already perturbed
that order. The gate is `bun run smoke:dotenv` (`scripts/smoke-dotenv.js`,
wired into `test.yml`), which spawns the built server from a scratch directory
whose only configuration is a `.env` file, with every `FOUNDRY_*` variable
stripped from the inherited environment and `FOUNDRY_MCP_CONFIG` pointing at a
missing file (the user's own configuration file must not answer for it). The
server now starts without any configuration, so the test waits for the
FoundryVTT client to be built, not for the banner.

**Strip the inherited variables, or the test passes for free** — an inherited
`FOUNDRY_URL` makes the server start whether or not the file was ever read,
which is exactly the false green this test exists to prevent. The test was
control-tested against the pre-fix entrypoint and fails there with the
reported error.

## When this bites elsewhere

Any ESM project (TypeScript or plain `"type": "module"`) whose entrypoint
loads env in its body. CommonJS hides it — `require()` is synchronous and
in-order, so the same code works — which is why the pattern survives being
copied out of older projects. The tell is a config error naming a variable
that is plainly present in `.env`.
