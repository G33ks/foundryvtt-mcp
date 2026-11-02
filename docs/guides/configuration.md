# Configuration Guide

## The Configuration File

Every MCP client on the machine reads one configuration file:

- **Windows**: `%LOCALAPPDATA%\foundryvtt-mcp\config.env`
- **macOS, Linux**: `$XDG_CONFIG_HOME/foundryvtt-mcp/config.env`, or `~/.config/foundryvtt-mcp/config.env`

`node dist/index.js init` writes it, checking each answer against your FoundryVTT (see the [Setup Guide](../../SETUP_GUIDE.md#5-run-init)); `node dist/index.js init --check` checks it again later. To edit it by hand, put one `KEY='value'` per line, then run `node dist/index.js stop` so that the next tool call starts the shared process with the new settings. `node dist/index.js status` shows the file and where each setting comes from.

An MCP client's `env` block, the system environment and a `.env` in the working directory (for development, see `.env.example`) can also set these names, but the shared process serves every client with one configuration: keep the settings in the file.

### Required

| Variable | Description |
|----------|-------------|
| `FOUNDRY_URL` | FoundryVTT server URL (e.g. `http://localhost:30000`) |
| `FOUNDRY_USERNAME` | FoundryVTT user account (Assistant GM recommended) |
| `FOUNDRY_PASSWORD` | FoundryVTT user password |

### Optional

The settings most setups use (`FOUNDRY_WRITE_ENABLED`, `FOUNDRY_MODULE_BRIDGE_ENABLED`, the headless GM session…) are in the README, [Environment Variables](../../README.md#environment-variables). Less common ones:

| Variable | Default | Description |
|----------|---------|-------------|
| `FOUNDRY_USER_ID` | — | 16-char document `_id` (bypasses username resolution) |
| `FOUNDRY_API_KEY` | — | REST API module key (enables the diagnostics tools, see below) |
| `LOG_LEVEL` | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`) |
| `FOUNDRY_TIMEOUT` | `10000` | Request timeout in ms |
| `FOUNDRY_RETRY_ATTEMPTS` | `3` | Retries of a failed REST request |
| `FOUNDRY_RETRY_DELAY` | `1000` | Base delay between those retries in ms |

## Security

- Give the connector its own FoundryVTT account, with a long password used nowhere else
- The configuration file holds that password in clear: keep it to your user (`chmod 600` on macOS and Linux)
- Limit FoundryVTT user permissions to the minimum required (Assistant GM rather than Gamemaster)
- Monitor logs for suspicious activity

## FoundryVTT Authentication

The MCP server connects to FoundryVTT via Socket.IO using a standard user account, which gives it full game data access. The companion module **FoundryVTT MCP Bridge** adds the tools that need a real Foundry page (canvas capture, native dice rolls, compendium documents, uploads); see the [Setup Guide](../../SETUP_GUIDE.md#3-install-companion-module-foundryvtt-mcp-bridge).

### Setup

1. Ensure FoundryVTT is running with an active world (not on the setup screen)
2. Create a dedicated FoundryVTT user account with the Assistant GM role
3. Run `node dist/index.js init`, which writes the credentials to the configuration file

### Authentication Flow

The server authenticates via a 4-step Socket.IO flow:

1. Fetches the `/join` page to obtain a session cookie
2. Extracts the session cookie from the response
3. Resolves the username to a user ID (or uses `FOUNDRY_USER_ID` if set)
4. Emits `joinGame` with credentials to receive the complete world state

### Required Permissions

Your FoundryVTT user needs:

- View actors, items, scenes, and journals
- Access compendium data
- Use dice rolling API

### Optional: Diagnostics Tools

Installing the **Foundry Local REST API** module adds server monitoring: `get_recent_logs`, `search_logs`, `get_system_health` and `diagnose_errors` need it, and `get_health_status` (which works without it) then adds the server's health:

1. Install the Foundry Local REST API module in FoundryVTT (**Setup** > **Add-on Modules** > **Install Module**). It is a separate project, not distributed by this repository: the upstream `releases/latest` manifest URL formerly given here no longer serves it. This is not the companion module **FoundryVTT MCP Bridge**, whose installation is in the [Setup Guide](../../SETUP_GUIDE.md#3-install-companion-module-foundryvtt-mcp-bridge).
2. Enable the module in your world and copy the generated API key
3. Add it to the configuration file, then run `node dist/index.js stop`:
   ```env
   FOUNDRY_API_KEY='your_api_key_here'
   ```
