# Contributing

Thank you for helping. This guide covers setting up the project, the checks a pull request must pass, and how to test against a real FoundryVTT without putting a game at risk.

- **Questions** ("how do I…", "is this expected…"): [GitHub Discussions](https://github.com/G33ks/foundryvtt-mcp/discussions), category Q&A.
- **Bugs and feature requests**: [issues](https://github.com/G33ks/foundryvtt-mcp/issues/new/choose), with the forms provided.
- **Vulnerabilities**: never in a public issue — see [SECURITY.md](SECURITY.md).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- **Node.js 22 or newer**, with **npm** (the project uses `package-lock.json`; do not commit another lockfile).
- **git**.
- **[gitleaks](https://github.com/gitleaks/gitleaks#installing)**, recommended: the pre-commit hook uses it to scan staged changes for secrets. Without it the hook warns and carries on; CI scans the whole history either way.

## Setup

```bash
git clone https://github.com/G33ks/foundryvtt-mcp.git
cd foundryvtt-mcp
npm ci          # exactly the locked versions; also installs the git hooks
npm run build   # compiles to dist/
```

With npm 12, `npm ci` ends with a warning that the install script of `esbuild` (a dependency of `tsx` and `vitest`) was blocked because `allowScripts` does not cover it. That is expected and harmless: the script only checks the platform binary that npm already installed as an optional dependency, and, outside Windows, replaces the `esbuild` command's JavaScript launcher with a link to that binary. `tsx`, `vitest` and the build work the same without it. The project does not approve it in `package.json` (`npm install-scripts approve` writes an `allowScripts` entry pinned to one version by default, which every esbuild update would leave behind). CI's npm (bundled with Node 22 and 24) does not block install scripts.

The user guides name the installed command, `foundryvtt-mcp`; from the clone, run `node dist/index.js` instead (`node dist/index.js init`, `status`, `stop`, `--version`). `node dist/index.js init` prints client entries that start the clone's `dist/index.js`. Give every MCP client entries for one install only: relays of a clone and of an installed package would replace each other's shared process.

## Project layout

```
src/
├── index.ts           # entry point: picks the role (relay, daemon, init, status, stop)
├── core.ts            # FoundryCore: client, module bridge, GM session, write queue, tool calls
├── mcp-server.ts      # the MCP server (tools/list, tools/call, resources)
├── server.ts          # the all-in-one mode (FOUNDRY_MCP_SHARED=false)
├── cli/               # init and init --check
├── config/            # settings: sources (environment, .env, file, defaults) and validation
├── shared/            # relay, shared process, IPC, status and stop
├── foundry/           # Socket.IO client and world cache, login, module bridge, GM session, journal integrity
├── tools/             # tool definitions, router, handlers, write tools, dependencies
├── diagnostics/       # REST API module client
└── utils/             # logger, errors, guards, small helpers
foundry-module/        # the companion module (plain browser JavaScript)
scripts/               # smoke tests, docs generation, release helpers
docs/                  # user documentation, design records
```

[docs/architecture.md](docs/architecture.md) explains how these parts work together.

## Development commands

```bash
npm run build          # compile to dist/
npm run dev            # run from the sources, reloading on change
npm test               # unit tests (Vitest); npm run test:watch, npm run test:coverage
npm run lint           # Biome: lint and formatting; npm run lint:fix to fix
npx tsc --noEmit       # type check
npm run docs:tools     # regenerate docs/tools.md from the tool definitions (after a build)
```

`npm run lint && npx tsc --noEmit && npm test` runs the lint, type check and unit tests in one go.

## Checks before a pull request

```bash
npm test             # unit tests (Vitest)
npm run lint         # Biome: lint and formatting
npx tsc --noEmit     # type check
npm run build
npm run smoke        # the built server starts
npm run smoke:dotenv # configuration from a .env file is read in time
npm run smoke:pack   # the published package installs and starts
npm run docs:tools -- --check   # docs/tools.md matches the tool definitions
```

The three smoke tests are isolated: they strip `FOUNDRY_*` variables, ignore your configuration file, use a temporary state directory (and so their own pipe or socket), and switch the module bridge and the invisible GM session off. They can run while your own connector is running.

CI runs the same steps on Linux, Windows and macOS with Node 22 and 24, plus a production dependency audit, CodeQL and a secret scan. A pull request is merged only when CI passes.

## Architecture in brief

- **Relay**: what an MCP client starts (`node dist/index.js`). It answers the client at once and forwards tool calls over a named pipe (Windows) or a Unix socket.
- **Shared process** (`node dist/index.js daemon`): started by the first relay, shared by all of them. It holds the one FoundryVTT connection (Socket.IO, every read and write), the world cache, and the queue that runs write tools one at a time.
- **Module bridge**: a WebSocket on loopback (port 31415 by default) between the shared process and the companion module. Each side proves its identity to the other before any command.
- **Invisible GM session**: a headless browser the shared process drives with `playwright-core`, logged in to the world, where the companion module runs. It serves what only a real Foundry page can do (canvas capture, native rolls, compendium documents, uploads).

The diagram and details are in [docs/architecture.md](docs/architecture.md).

## Adding a tool

1. **Definition**: add the tool's name, description and JSON schema to the right group in `src/tools/definitions.ts` (a new group must also be listed in `getAllTools()`).
2. **Routing**: add its `case` to `routeToolRequest` in `src/tools/router.ts`.
3. **Handler**: implement it in `src/tools/handlers/`, validating arguments with Zod and reading through `FoundryClient` (`src/foundry/client.ts`).
4. **Tests**: unit tests for the handler (and the client method, if you add one) next to the code, in `__tests__/`.
5. **A tool that changes the world**: add its name to `WRITE_TOOLS` in `src/tools/write-tools.ts`, so its calls wait in the write queue, and have its `FoundryClient` method call `assertWriteable()`, so it is refused unless `FOUNDRY_WRITE_ENABLED=true` (a tool the companion module carries out calls `assertWritesEnabled()` in `src/tools/handlers/module-bridge.ts` instead, before sending anything). Give it arguments in `src/tools/__tests__/write-gate.test.ts`, which checks that every write tool is refused while writes are disabled. Writes go through Foundry's `modifyDocument` protocol: read `.claude/rules/foundry-write-protocol.md` first.
6. **Dependencies**: classify the tool in `src/tools/tool-dependencies.ts` (socket, companion module, REST API module or local).
7. **Documentation**: a new group of tools needs its section in `scripts/generate-tools-doc.js`; then `npm run build && npm run docs:tools` regenerates `docs/tools.md`, which CI checks.

## Testing against a real FoundryVTT

Unit tests mock FoundryVTT; some changes also need a live world. Keep it safe:

- **Use a disposable world** and a dedicated **Assistant GM** account for the connector, not your own GM account.
- **Never test on a world you play in without a backup.** Write tools change documents for real.
- **Use a temporary state directory**: set `FOUNDRY_MCP_STATE_DIR` to an empty folder. The test connector then has its own token, logs, pipe or socket, and configuration file.
- **Stop your usual connector first**: `node dist/index.js stop` (or `foundryvtt-mcp stop` for the installed package). The bridge port (31415) does not depend on the state directory, so two connectors would compete for it.
- **Never run two connectors at once**, for the same reason.
- `npm run check:bridge-security` checks the bridge's authentication against a running connector whose companion module is connected. It needs a live connector, so it does not run in CI: run it yourself after touching the bridge or the module.
- `npm run test:integration:docker` runs the integration suite against a FoundryVTT container. It needs a FoundryVTT licence key in `.env.integration` (see `.env.integration.example`).

## The companion module

The companion module lives in [`foundry-module/`](foundry-module/) (plain browser JavaScript, no build step). `src/foundry/__tests__/companion-transport.test.ts` runs its transport under Node against the real bridge.

## Releases (maintainers)

The server is published on npm as [`@g33ks/foundryvtt-mcp`](https://www.npmjs.com/package/@g33ks/foundryvtt-mcp), from tags set by hand:

1. On a branch: set the version in `package.json` and `package-lock.json` (`npm version <x.y.z> --no-git-tag-version`), and turn `## Unreleased` in `CHANGELOG.md` into `## x.y.z — <date>`.
2. Merge it into `main`, then tag that commit `vx.y.z` and push the tag.
3. The `Release` workflow (`.github/workflows/release.yml`) checks that the tag matches `package.json` and is on `main`, runs the whole suite and the smoke tests, packs the tarball (kept as the `release` artifact with its SHA-256), publishes it to npm by trusted publishing when the repository variable `NPM_TRUSTED_PUBLISHING` is `true`, and creates the GitHub release with the CHANGELOG section as notes, marked Latest.

The companion module has its own tags, `bridge-vx.y.z`, and its own workflow (`bridge-release.yml`).

To try a change in Foundry, copy the folder into a test world's `Data/modules/foundryvtt-mcp-bridge` (see [Manual installation](foundry-module/README.md#manual-installation-advanced)), reload the world, then check the bridge with `status` and `npm run check:bridge-security`.

Releases are published by the maintainer only, by pushing a `bridge-vX.Y.Z` tag ([Releasing](foundry-module/README.md#-releasing-maintainers)). In a pull request, change the module's code but leave `version` and `download` in `module.json` as they are.

## Conventions

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`, with a scope when it helps (`fix(auth):`).
- **One pull request per subject**, kept small, with its tests.
- **CI must pass.**
- **Say what you tested and what you did not**: FoundryVTT version, game system, operating system. "Not tested on Linux" is useful information, not a weakness.

## History

This project is a fork of [laurigates/foundryvtt-mcp](https://github.com/laurigates/foundryvtt-mcp). Issue and pull request numbers from before the fork (`#143`, `#217`…) refer to that repository's tracker; in comments and docs they are written `laurigates/foundryvtt-mcp#NNN`. Entries in `CHANGELOG.md` keep their original form.
