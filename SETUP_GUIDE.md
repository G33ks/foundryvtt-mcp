# FoundryVTT MCP Server Setup Guide

This guide walks you through setting up and configuring the FoundryVTT Model Context Protocol (MCP) Server for use with your AI assistant.

---

## ⚡ Quick Start

### 1. Prerequisites
- **Node.js 18+** or **Bun** installed.
- **FoundryVTT v11+ / v12+** running with an **active world** (not on the world selection/setup screen).
- An MCP client (Claude Desktop, Claude Code, Oh My Pi, VS Code, Cursor).
- **Google Chrome or Microsoft Edge installed**, for the automatic headless GM browser session (step 4) — most desktops already have one.

### 2. Set Up a Dedicated Foundry User
In FoundryVTT:
1. Open **Configuration** (gear icon) → **User Management**.
2. Click **Create User**.
3. Set **User Name** (e.g. `mcp-api`) and a password (e.g. `mcp`).
4. Set Role to **Gamemaster** or **Assistant GM** (ensure write permissions are granted).
5. Save changes.

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
With the module installed and `FOUNDRY_MODULE_BRIDGE_ENABLED=true` (off by default — set it explicitly), the server automatically launches its own invisible background browser tab, logs into Foundry as `mcp-api` (the same account from step 2), and hosts the companion module there. This gives the AI full GM-tier canvas access (screenshots, dice rolls, pausing, file uploads) while a **human can log into their own visible Foundry client as a normal Player** — no fog-of-war spoilers, no extra setup.

The session is self-healing: a watchdog polls the bridge's own connectivity every 20s (independently of whether the Foundry login itself is still active) and force-reloads the tab if it stays disconnected for ~60s. This recovers the module's WebSocket even when the browser session never actually logs out — the module's own client-side reconnect logic gives up permanently after ~85 minutes of failed attempts, and a full page reload gives it a fresh start rather than requiring a server restart.

This step needs nothing from you beyond Chrome/Edge being installed. To opt out and manage a GM browser tab yourself instead, set `FOUNDRY_HEADLESS_GM_ENABLED=false`.

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
| `FOUNDRY_HEADLESS_GM_ENABLED` | No | `true` | Auto-launches an invisible GM-tier browser session to host the module bridge |
| `FOUNDRY_HEADLESS_GM_USERNAME` | No | `FOUNDRY_USERNAME` | Overrides which account the headless session logs in as |
| `FOUNDRY_HEADLESS_GM_PASSWORD` | No | `FOUNDRY_PASSWORD` | Password for the headless session account, if overridden |
| `FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH` | No | — | Explicit Chrome/Edge/Chromium binary path, skipping auto-detection |
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

---

## 🛠️ Troubleshooting

- **Socket.IO Authentication Failed**: Double-check that the Foundry world is active, the username is exact (case-sensitive), and the password matches.
- **Companion Bridge Not Connecting**: Check `get_health_status` — it reports both bridge connectivity and the headless session's own status line. Ensure the module is enabled in Foundry's module manager, and that `FOUNDRY_MODULE_BRIDGE_PORT` matches the port configured in the module's settings (default: 31415).
- **Headless GM session: "No usable browser found"**: Install Google Chrome or Microsoft Edge, or set `FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH` to a browser binary.
- **Headless GM session: "No user named ... is registered in this world's join list"**: The account named in `FOUNDRY_USERNAME`/`FOUNDRY_HEADLESS_GM_USERNAME` doesn't exist in this world, or the world is on the setup screen rather than active. Verify step 2 above and that Foundry shows the world as loaded.
- **Bridge was connected earlier and stops working, with the headless session still showing "Logged in"**: The module's own WebSocket dropped independently of the Foundry login (rare, but possible). This self-heals automatically within ~60s (the watchdog force-reloads the tab) — if `get_health_status` still shows it disconnected after a couple of minutes, check the server logs for a reload failure and restart the MCP server process as a fallback.
- **A human plays as Player but capture_scene/set_pause/upload_asset still report unavailable**: The companion module only connects for a GM/Assistant-GM `game.user.isGM` session — a Foundry-core restriction (canvas fog of war, `game.togglePause()`, `FilePicker.upload()` are all GM-gated), not something this server can bypass. The headless GM session exists precisely so a human can log in as a **Player** while `mcp-api` (or `FOUNDRY_HEADLESS_GM_USERNAME`) supplies that GM-tier session automatically in the background; check `get_health_status` if it still isn't connecting.
- **Write Operations Rejected**: Verify `FOUNDRY_WRITE_ENABLED=true` is set and the Foundry user has Gamemaster or Assistant GM role.
