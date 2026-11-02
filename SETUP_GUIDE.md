# FoundryVTT MCP Server Setup Guide

This guide walks you through setting up and configuring the FoundryVTT Model Context Protocol (MCP) Server for use with your AI assistant.

---

## ⚡ Quick Start

### 1. Prerequisites
- **Node.js 18+** or **Bun** installed.
- **FoundryVTT v13 or v14** (the versions the server handles explicitly; older versions are not verified) running with an **active world** (not on the world selection/setup screen).
- An MCP client (Claude Desktop, Claude Code, Oh My Pi, VS Code, Cursor).
- **A Chromium-based browser installed**, for the automatic headless GM browser session (step 4): Google Chrome, Microsoft Edge, Brave, Vivaldi and Chromium are detected automatically; any other Chromium browser works through `FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH`.

### 2. Set Up a Dedicated Foundry User
In FoundryVTT:
1. Open **Configuration** (gear icon) → **User Management**.
2. Click **Create User**.
3. Set **User Name** (e.g. `mcp-api`) and a long password used nowhere else.
4. Set Role to **Assistant GM**.
5. Save changes.

This one account is all the server needs: its Socket.IO connection and its invisible browser session (step 4) share the same login. Prefer **Assistant GM** to **Gamemaster**: the invisible session is a real Foundry client, and as a Gamemaster it could become the *active GM* in place of your own Gamemaster login (equal roles go to the smaller user id) and run the game system's automations — `status` and `get_health_status` warn about it. As an Assistant GM the server cannot grant the Gamemaster role or change `core.permissions` (it refuses both with a clear message); do those yourself as a Gamemaster.

### 3. Install Companion Module (FoundryVTT MCP Bridge)
Install it from Foundry's **Setup** screen (FoundryVTT 13 or later):

1. Open **Add-on Modules** → **Install Module**.
2. Paste the manifest URL into the **Manifest URL** field at the bottom and click **Install**:

   ```
   https://raw.githubusercontent.com/G33ks/foundryvtt-mcp/main/foundry-module/module.json
   ```

3. Launch your world, open **Manage Modules** and check **FoundryVTT MCP Bridge**.

This URL always describes the latest release. Each release also attaches its own `module.json` on GitHub (tags `bridge-vX.Y.Z`), for installing one exact version.

**Updating**: in the Setup screen, **Add-on Modules** → **Check for Updates** (or the update button on the module) compares the installed version with the manifest URL and installs the newer release. Reload the world afterwards. A final release never replaces its own pre-release (for instance `0.5.1` over `0.5.1-rc.1`): Foundry ranks `0.5.1-rc.1` above `0.5.1`, so the check reports the module as current. Install the final release with **Install Module** and the manifest URL above instead; the world keeps the module enabled.

#### Manual installation (advanced)

Copying the folder by hand still works, but Foundry can then neither check for updates nor reinstall the module (the copy has no manifest URL until a release replaces it). Copy the `foundry-module` folder from this repository into your FoundryVTT `Data/modules/` directory, under the module id:

```bash
# Windows
cp -r foundry-module "%LOCALAPPDATA%/FoundryVTT/Data/modules/foundryvtt-mcp-bridge"

# macOS
cp -r foundry-module "~/Library/Application Support/FoundryVTT/Data/modules/foundryvtt-mcp-bridge"

# Linux
cp -r foundry-module "~/.local/share/FoundryVTT/Data/modules/foundryvtt-mcp-bridge"
```

To switch from a manual copy to a release, move the copied folder out of `Data/modules` (with the world shut down) and install by manifest URL as above: the module keeps the same id, so the world keeps it enabled.

### 4. Automatic Headless GM Session (no manual browser tab needed)
With the module installed and `FOUNDRY_MODULE_BRIDGE_ENABLED=true` (off by default — set it explicitly), the server automatically launches its own invisible background browser tab, opens the game in it with the session of `mcp-api` (the account from step 2 — the server logs in once and both connections share that login), and hosts the companion module there. This gives the AI full GM-tier canvas access (screenshots, dice rolls, pausing, file uploads) while a **human can log into their own visible Foundry client** — as a Player (no fog-of-war spoilers), or as the Gamemaster. Only `mcp-api` appears in Foundry's player list for the server.

The tab stays on the game page: a navigation elsewhere — **Log Out**, or Foundry reloading the client after `mcp-api`'s role changes — is blocked and the tab reloads the game instead, because leaving it would log the shared session out. When Foundry forgets the session (server restart, world shut down and relaunched, sessions last 24 hours), the server logs in again by itself and hands the new session to the tab.

**Advanced: two accounts.** Set `FOUNDRY_HEADLESS_GM_USERNAME` and `FOUNDRY_HEADLESS_GM_PASSWORD` to another GM or Assistant GM account and the tab logs that account in through Foundry's login form instead (`status` then shows `separate account (…)`).

The session is self-healing: a watchdog polls the bridge's own connectivity every 20s (independently of whether the Foundry login itself is still active) and force-reloads the tab if it stays disconnected for ~60s. This recovers the module's WebSocket even when the browser session never actually logs out — the module's own client-side reconnect logic gives up permanently after ~85 minutes of failed attempts, and a full page reload gives it a fresh start rather than requiring a server restart.

This step needs nothing from you beyond a browser being available. The server looks, at their usual install locations, for Google Chrome, then Microsoft Edge, Brave, Vivaldi, a system Chromium, and last Playwright's own Chromium (not bundled: downloaded with `npx playwright install chromium`). It uses the first one found; if that one fails to start, the next. `status` and `get_health_status` show the browser, its path and `(detected)`; with none found, the error lists every location tried. To choose the browser yourself — another Chromium-based browser, or one installed elsewhere — set `FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH` to its executable in the [configuration file](#configuration) (no fallback then: an error names that path):

```env
FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH='C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe'
```

(In a JSON `env` block instead, double the Windows backslashes.)

The headless browser is launched with Chromium's local network access checks disabled, so the module can reach the bridge on `ws://localhost` even when Foundry is served from a public address (see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#module-bridge-never-connects--websocket--failed)).

Keep `FOUNDRY_HEADLESS_GM_ENABLED` at its default `true`: since module 0.5.0, the companion module only connects from this session — it authenticates the server through a function only the headless session provides (see the README, [Module Bridge Security](README.md#module-bridge-security)). A GM tab opened by hand is no longer supported, so `FOUNDRY_HEADLESS_GM_ENABLED=false` disables the bridge in practice, and the server logs a warning at startup.

### 5. Run `init`

Build the server (`npm install` then `npm run build`), then, in PowerShell, Windows Terminal, cmd or any terminal window:

```bash
node dist/index.js init        # or `foundryvtt-mcp init` when installed as a package
```

`init` writes the [configuration file](#configuration), checking each answer against your FoundryVTT as it goes:

1. It shows where the file is. If it exists, its values are the defaults — passwords show as `<set>`, and Enter keeps them.
2. **Address**: it checks that the server answers with a world running (a clear message, and Enter to try again, when it is unreachable, its certificate is refused, or no world is launched).
3. **Account**: the user from step 2 and its password (typing stays hidden). A Player or Trusted Player is refused (the module and the headless session need a GM role); a Gamemaster gets the warning above. A wrong password asks again.
4. **Module**: it checks that `foundryvtt-mcp-bridge` is installed and enabled in the world, or says how to.
5. **Browser**: it shows the browser found and starts it headless once.
6. **Writes**: whether the assistant may change the game (`FOUNDRY_WRITE_ENABLED`; no by default).
7. It writes only what differs from the defaults (and always `FOUNDRY_MODULE_BRIDGE_ENABLED=true`). An existing file is copied first (`config.env.bak-<date>-<time>`) and changed in place, keeping your comments and other settings; the file is then read back to check it.
8. It prints the entry for Claude desktop (**Settings → Developer → Edit Config**) and the `claude mcp add` command for Claude Code.
9. If the shared process is running with older connection settings, it offers to stop it.

`init` needs an interactive terminal: with redirected input it refuses. It never asks about the two-account mode (an advanced option, set by hand in the file).

`node dist/index.js init --check` runs the same checks on the existing configuration, asking and writing nothing — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#init---check-start-here).

---

## ⚙️ Configuration

### The configuration file

All MCP clients share one file, so no client needs its own copy of the settings:

- **Windows**: `%LOCALAPPDATA%\foundryvtt-mcp\config.env`
- **macOS, Linux**: `$XDG_CONFIG_HOME/foundryvtt-mcp/config.env`, or `~/.config/foundryvtt-mcp/config.env`

[`init`](#5-run-init) writes it for you. To write it by hand, one `KEY=value` per line:

```env
# FoundryVTT MCP — shared by every MCP client
FOUNDRY_URL=http://localhost:30000
FOUNDRY_USERNAME=mcp-api
FOUNDRY_PASSWORD='mcp'
FOUNDRY_WRITE_ENABLED=true
FOUNDRY_MODULE_BRIDGE_ENABLED=true
```

- Put each value between `'…'`; if the value contains an apostrophe, between `` `…` ``. Without quotes, a `#` starts a comment and cuts the value — a common trap with passwords.
- The file holds your password in clear: keep it to your user (`chmod 600` on macOS and Linux; the server warns otherwise).
- After changing it, run `node dist/index.js stop`; the next tool call uses the new settings. If no configuration existed yet, nothing to do: the next call reads the file.
- `node dist/index.js status` shows the file it found and where each setting comes from (passwords as `<set>`).
- `FOUNDRY_MCP_CONFIG` points to another file. With `FOUNDRY_MCP_STATE_DIR` set, the file is `<that directory>/config.env`.

The same settings can still come from a client's `env` block or the system environment (they win over the file, setting by setting) and, for development, from a `.env` in the working directory (between the two). But the shared process serves every client with **one** configuration: a client whose `env` block disagrees with the running process is served with the running configuration, and its first tool result names the settings that are ignored. Keep the settings in the file.

### Settings

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `FOUNDRY_URL` | **Yes** | — | FoundryVTT server URL |
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
| `FOUNDRY_MCP_IDLE_TIMEOUT_MINUTES` | No | `5` | The shared process stops (and leaves FoundryVTT) this long after the last client closes; `0` = never |
| `LOG_LEVEL` | No | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`) |

---

## 🔌 MCP Client Configurations

With the settings in the configuration file, a client entry is only the command.

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "foundryvtt": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_REPO>/dist/index.js"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add foundryvtt -- node <ABSOLUTE_PATH_TO_REPO>/dist/index.js
```

### Oh My Pi (`~/.omp/agent/mcp.json`)

```json
{
  "mcpServers": {
    "foundryvtt": {
      "type": "stdio",
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_REPO>/dist/index.js"],
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
- **Companion Bridge Not Connecting**: Check `get_health_status` — it reports both bridge connectivity and the headless session's own status line. Ensure the module is enabled in Foundry's module manager and that the installed copy is version **0.5.0 or later** (an older module never authenticates — update or reinstall it, step 3). The server tells the module which port to use, so the module's own **Bridge Port** setting is only a fallback and needs no change. In shared-process mode, read `daemon.log` for `Module bridge refused a connection: …` lines (see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#module-bridge-refused-a-connection-)).
- **Headless GM session: "No browser found"**: the message lists every location tried. Install Google Chrome, Microsoft Edge or Brave, or set `FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH` to a Chromium-based browser installed elsewhere. `node dist/index.js init --check` tries the browser without starting the connector.
- **Bridge never connects, browser console shows `WebSocket connection to 'ws://localhost:31415/' failed`**: The browser is blocking the Foundry page (a public origin) from reaching `localhost` — Chromium's local network access protection, plus Brave's own localhost-access permission. The headless session disables these checks itself; if it still fails, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#module-bridge-never-connects--websocket--failed).
- **Headless GM session: "No user named ... is registered in this world's join list"**: (Two-account mode only.) The account named in `FOUNDRY_HEADLESS_GM_USERNAME` doesn't exist in this world, or the world is on the setup screen rather than active. Verify step 2 above and that Foundry shows the world as loaded.
- **Bridge was connected earlier and stops working, with the headless session still showing "Logged in"**: The module's own WebSocket dropped independently of the Foundry login (rare, but possible). This self-heals automatically within ~60s (the watchdog force-reloads the tab) — if `get_health_status` still shows it disconnected after a couple of minutes, check the server logs for a reload failure and restart the MCP server process as a fallback.
- **A human plays as Player but capture_scene/set_pause/upload_asset still report unavailable**: The companion module only connects for a GM/Assistant-GM `game.user.isGM` session — a Foundry-core restriction (canvas fog of war, `game.togglePause()`, `FilePicker.upload()` are all GM-gated), not something this server can bypass. The headless GM session exists precisely so a human can log in as a **Player** while `mcp-api` (an Assistant GM) supplies that GM-tier session automatically in the background; check `get_health_status` if it still isn't connecting.
- **Write Operations Rejected**: Verify `FOUNDRY_WRITE_ENABLED=true` is set and the Foundry user has Gamemaster or Assistant GM role.
