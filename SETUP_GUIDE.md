# FoundryVTT MCP Server Setup Guide

This guide walks you through setting up and configuring the FoundryVTT Model Context Protocol (MCP) Server for use with your AI assistant.

---

## ⚡ Quick Start

### 1. Prerequisites
- **Node.js 18+** or **Bun** installed.
- **FoundryVTT v13 or v14** (the versions the server handles explicitly; older versions are not verified) running with an **active world** (not on the world selection/setup screen).
- An MCP client (Claude Desktop, Claude Code, Oh My Pi, VS Code, Cursor).
- **A Chromium-based browser installed**, for the automatic headless GM browser session (step 4): Google Chrome or Microsoft Edge are detected automatically; any other Chromium browser (Brave, Vivaldi…) works through `FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH`.

### 2. Set Up a Dedicated Foundry User
In FoundryVTT:
1. Open **Configuration** (gear icon) → **User Management**.
2. Click **Create User**.
3. Set **User Name** (e.g. `mcp-api`) and a password (e.g. `mcp`).
4. Set Role to **Assistant GM**.
5. Save changes.

This one account is all the server needs: its Socket.IO connection and its invisible browser session (step 4) share the same login. Prefer **Assistant GM** to **Gamemaster**: the invisible session is a real Foundry client, and as a Gamemaster it could become the *active GM* in place of your own Gamemaster login (equal roles go to the smaller user id) and run the game system's automations — `status` and `get_health_status` warn about it. As an Assistant GM the server cannot grant the Gamemaster role or change `core.permissions` (it refuses both with a clear message); do those yourself as a Gamemaster.

### 3. Install Companion Module (FoundryVTT MCP Bridge)
Copy the `foundry-module` folder from this repository into your FoundryVTT `Data/modules/` directory:

```bash
# Windows
cp -r foundry-module "%LOCALAPPDATA%/FoundryVTT/Data/modules/foundryvtt-mcp-bridge"

# macOS
cp -r foundry-module "~/Library/Application Support/FoundryVTT/Data/modules/foundryvtt-mcp-bridge"

# Linux
cp -r foundry-module "~/.local/share/FoundryVTT/Data/modules/foundryvtt-mcp-bridge"
```

In FoundryVTT, go to **Manage Modules** and check **FoundryVTT MCP Bridge**.

### 4. Automatic Headless GM Session (no manual browser tab needed)
With the module installed and `FOUNDRY_MODULE_BRIDGE_ENABLED=true` (off by default — set it explicitly), the server automatically launches its own invisible background browser tab, opens the game in it with the session of `mcp-api` (the account from step 2 — the server logs in once and both connections share that login), and hosts the companion module there. This gives the AI full GM-tier canvas access (screenshots, dice rolls, pausing, file uploads) while a **human can log into their own visible Foundry client** — as a Player (no fog-of-war spoilers), or as the Gamemaster. Only `mcp-api` appears in Foundry's player list for the server.

The tab stays on the game page: a navigation elsewhere — **Log Out**, or Foundry reloading the client after `mcp-api`'s role changes — is blocked and the tab reloads the game instead, because leaving it would log the shared session out. When Foundry forgets the session (server restart, world shut down and relaunched, sessions last 24 hours), the server logs in again by itself and hands the new session to the tab.

**Advanced: two accounts.** Set `FOUNDRY_HEADLESS_GM_USERNAME` and `FOUNDRY_HEADLESS_GM_PASSWORD` to another GM or Assistant GM account and the tab logs that account in through Foundry's login form instead (`status` then shows `separate account (…)`).

The session is self-healing: a watchdog polls the bridge's own connectivity every 20s (independently of whether the Foundry login itself is still active) and force-reloads the tab if it stays disconnected for ~60s. This recovers the module's WebSocket even when the browser session never actually logs out — the module's own client-side reconnect logic gives up permanently after ~85 minutes of failed attempts, and a full page reload gives it a fresh start rather than requiring a server restart.

This step needs nothing from you beyond a browser being available. The server tries Google Chrome, then Microsoft Edge, then Playwright's own Chromium — the latter is not bundled and must be downloaded once with `npx playwright install chromium`. To use another Chromium-based browser (Brave, Vivaldi…), set `FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH` to its executable; in a JSON client configuration, double the Windows backslashes:

```json
"FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH": "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
```

The headless browser is launched with Chromium's local network access checks disabled, so the module can reach the bridge on `ws://localhost` even when Foundry is served from a public address (see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#module-bridge-never-connects--websocket--failed)).

Keep `FOUNDRY_HEADLESS_GM_ENABLED` at its default `true`: since module 0.5.0, the companion module only connects from this session — it authenticates the server through a function only the headless session provides (see the README, [Module Bridge Security](README.md#module-bridge-security)). A GM tab opened by hand is no longer supported, so `FOUNDRY_HEADLESS_GM_ENABLED=false` disables the bridge in practice, and the server logs a warning at startup.

---

## ⚙️ Environment Variables

Copy `.env.example` to `.env` in the server root and configure:

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `FOUNDRY_URL` | **Yes** | `http://localhost:30000` | FoundryVTT server URL |
| `FOUNDRY_USERNAME` | **Yes** | — | Dedicated user account name |
| `FOUNDRY_PASSWORD` | **Yes** | — | Dedicated user password |
| `FOUNDRY_WRITE_ENABLED` | No | `false` | Enables game-state mutations (walls, lights, tokens, items) |
| `FOUNDRY_MODULE_BRIDGE_ENABLED` | No | `false` | Enables WebSocket bridge for canvas screenshots & chat rolls |
| `FOUNDRY_MODULE_BRIDGE_PORT` | No | `31415` | WebSocket port for the companion bridge |
| `FOUNDRY_HEADLESS_GM_ENABLED` | No | `true` | Auto-launches an invisible GM-tier browser session to host the module bridge. Required for the bridge: with `false` the companion module never connects (manually opened GM tabs are not supported) and a warning is logged at startup |
| `FOUNDRY_HEADLESS_GM_USERNAME` | No | — | Advanced two-account mode: another account the headless session logs in as through `/join`. Unset (or equal to `FOUNDRY_USERNAME`), the session shares the connector's own session |
| `FOUNDRY_HEADLESS_GM_PASSWORD` | No | `FOUNDRY_PASSWORD` | Password of that other account (two-account mode only) |
| `FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH` | No | — | Path to any Chromium-based browser binary (Chrome, Edge, Brave, Vivaldi…), skipping auto-detection |
| `FOUNDRY_DATA_PATH` | No | — | Local filesystem path to Foundry `Data/` directory |
| `FOUNDRY_API_KEY` | No | — | Optional REST API module key for server diagnostics |
| `FOUNDRY_EVENT_BUFFER_SIZE` | No | `500` | In-memory event log ring buffer capacity |
| `FOUNDRY_EVENT_WAIT_MS` | No | `25000` | Default long-polling timeout for `watch_events` |
| `LOG_LEVEL` | No | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`) |

---

## 🔌 MCP Client Configurations

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "foundryvtt": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_REPO>/dist/index.js"],
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

### Oh My Pi (`~/.omp/agent/mcp.json`)

```json
{
  "mcpServers": {
    "foundryvtt": {
      "type": "stdio",
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_REPO>/dist/index.js"],
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

## 🧪 Verifying the Installation

1. **Build and test locally:**
   ```bash
   npm install
   npm run build
   npm test
   ```
2. **Start the server:**
   ```bash
   npm start
   ```
3. Check the startup logs:
   - `Connected to FoundryVTT via Socket.IO`
   - `Module bridge listening on ws://localhost:31415`
   - `Headless GM session logged in as mcp-api` (the automatic background session picking up the bridge, no manual browser step needed)
   - `Foundry module connected and authenticated (protocol v1)` (the module in that session passed the bridge's authentication)

---

## 🛠️ Troubleshooting

- **Socket.IO Authentication Failed**: Double-check that the Foundry world is active, the username is exact (case-sensitive), and the password matches.
- **Companion Bridge Not Connecting**: Check `get_health_status` — it reports both bridge connectivity and the headless session's own status line. Ensure the module is enabled in Foundry's module manager and that the installed copy is version **0.5.0 or later** (an older module never authenticates — copy `foundry-module` again, step 3). The server tells the module which port to use, so the module's own **Bridge Port** setting is only a fallback and needs no change. In shared-process mode, read `daemon.log` for `Module bridge refused a connection: …` lines (see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#module-bridge-refused-a-connection-)).
- **Headless GM session: "No usable browser found"**: Install Google Chrome or Microsoft Edge, set `FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH` to any Chromium-based browser binary (Brave, Vivaldi…), or download Playwright's Chromium with `npx playwright install chromium`.
- **Bridge never connects, browser console shows `WebSocket connection to 'ws://localhost:31415/' failed`**: The browser is blocking the Foundry page (a public origin) from reaching `localhost` — Chromium's local network access protection, plus Brave's own localhost-access permission. The headless session disables these checks itself; if it still fails, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#module-bridge-never-connects--websocket--failed).
- **Headless GM session: "No user named ... is registered in this world's join list"**: (Two-account mode only.) The account named in `FOUNDRY_HEADLESS_GM_USERNAME` doesn't exist in this world, or the world is on the setup screen rather than active. Verify step 2 above and that Foundry shows the world as loaded.
- **Bridge was connected earlier and stops working, with the headless session still showing "Logged in"**: The module's own WebSocket dropped independently of the Foundry login (rare, but possible). This self-heals automatically within ~60s (the watchdog force-reloads the tab) — if `get_health_status` still shows it disconnected after a couple of minutes, check the server logs for a reload failure and restart the MCP server process as a fallback.
- **A human plays as Player but capture_scene/set_pause/upload_asset still report unavailable**: The companion module only connects for a GM/Assistant-GM `game.user.isGM` session — a Foundry-core restriction (canvas fog of war, `game.togglePause()`, `FilePicker.upload()` are all GM-gated), not something this server can bypass. The headless GM session exists precisely so a human can log in as a **Player** while `mcp-api` (an Assistant GM) supplies that GM-tier session automatically in the background; check `get_health_status` if it still isn't connecting.
- **Write Operations Rejected**: Verify `FOUNDRY_WRITE_ENABLED=true` is set and the Foundry user has Gamemaster or Assistant GM role.
