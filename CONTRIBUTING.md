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

[docs/guides/development.md](docs/guides/development.md) describes the project layout and the development commands in more detail.

## Checks before a pull request

```bash
npm test             # unit tests (Vitest)
npm run lint         # Biome: lint and formatting
npx tsc --noEmit     # type check
npm run build
npm run smoke        # the built server starts
npm run smoke:dotenv # configuration from a .env file is read in time
npm run smoke:pack   # the published package installs and starts
```

The three smoke tests are isolated: they strip `FOUNDRY_*` variables, ignore your configuration file, use a temporary state directory (and so their own pipe or socket), and switch the module bridge and the invisible GM session off. They can run while your own connector is running.

CI runs the same steps on Linux, Windows and macOS with Node 22 and 24, plus a production dependency audit, CodeQL and a secret scan. A pull request is merged only when CI passes.

## Architecture in brief

- **Relay**: what an MCP client starts (`node dist/index.js`). It answers the client at once and forwards tool calls over a named pipe (Windows) or a Unix socket.
- **Shared process** (`node dist/index.js daemon`): started by the first relay, shared by all of them. It holds the one FoundryVTT connection (Socket.IO, every read and write), the world cache, and the queue that runs write tools one at a time.
- **Module bridge**: a WebSocket on loopback (port 31415 by default) between the shared process and the companion module. Each side proves its identity to the other before any command.
- **Invisible GM session**: a headless browser the shared process drives with `playwright-core`, logged in to the world, where the companion module runs. It serves what only a real Foundry page can do (canvas capture, native rolls, compendium documents, uploads).

The diagram and details are in the README, [How it works](README.md#-how-it-works).

## Adding a tool

1. **Definition**: add the tool's name, description and JSON schema to the right group in `src/tools/definitions.ts` (a new group must also be listed in `getAllTools()`).
2. **Routing**: add its `case` to `routeToolRequest` in `src/tools/router.ts`.
3. **Handler**: implement it in `src/tools/handlers/`, validating arguments with Zod and reading through `FoundryClient` (`src/foundry/client.ts`).
4. **Tests**: unit tests for the handler (and the client method, if you add one) next to the code, in `__tests__/`.
5. **A tool that changes the world**: add its name to `WRITE_TOOLS` in `src/tools/write-tools.ts`, so its calls wait in the write queue, and have its `FoundryClient` method call `assertWriteable()`, so it is refused unless `FOUNDRY_WRITE_ENABLED=true`. Writes go through Foundry's `modifyDocument` protocol: read `.claude/rules/foundry-write-protocol.md` first.

## Testing against a real FoundryVTT

Unit tests mock FoundryVTT; some changes also need a live world. Keep it safe:

- **Use a disposable world** and a dedicated **Assistant GM** account for the connector, not your own GM account.
- **Never test on a world you play in without a backup.** Write tools change documents for real.
- **Use a temporary state directory**: set `FOUNDRY_MCP_STATE_DIR` to an empty folder. The test connector then has its own token, logs, pipe or socket, and configuration file.
- **Stop your usual connector first**: `node dist/index.js stop`. The bridge port (31415) does not depend on the state directory, so two connectors would compete for it.
- **Never run two connectors at once**, for the same reason.
- `npm run check:bridge-security` checks the bridge's authentication against a running connector whose companion module is connected. It needs a live connector, so it does not run in CI: run it yourself after touching the bridge or the module.
- `npm run test:integration:docker` runs the integration suite against a FoundryVTT container. It needs a FoundryVTT licence key in `.env.integration` (see `.env.integration.example`).

## The companion module

The companion module lives in [`foundry-module/`](foundry-module/) (plain browser JavaScript, no build step). `src/foundry/__tests__/companion-transport.test.ts` runs its transport under Node against the real bridge.

To try a change in Foundry, copy the folder into a test world's `Data/modules/foundryvtt-mcp-bridge` (see [Manual installation](foundry-module/README.md#manual-installation-advanced)), reload the world, then check the bridge with `status` and `npm run check:bridge-security`.

Releases are published by the maintainer only, by pushing a `bridge-vX.Y.Z` tag ([Releasing](foundry-module/README.md#-releasing-maintainers)). In a pull request, change the module's code but leave `version` and `download` in `module.json` as they are.

## Conventions

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`, with a scope when it helps (`fix(auth):`).
- **One pull request per subject**, kept small, with its tests.
- **CI must pass.**
- **Say what you tested and what you did not**: FoundryVTT version, game system, operating system. "Not tested on Linux" is useful information, not a weakness.

## History

This project is a fork of [laurigates/foundryvtt-mcp](https://github.com/laurigates/foundryvtt-mcp). Issue and pull request numbers from before the fork (`#143`, `#217`…) refer to that repository's tracker; in comments and docs they are written `laurigates/foundryvtt-mcp#NNN`. Entries in `CHANGELOG.md` keep their original form.
