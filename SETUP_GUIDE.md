# FoundryVTT MCP Server Setup Guide

This guide walks you through setting up and configuring the FoundryVTT Model Context Protocol (MCP) Server for use with your AI assistant. It follows the steps of the README's [Quick Start](README.md#-quick-start), with the details.

---

## ⚡ Quick Start

### 1. Prerequisites
- **Node.js 22 or newer** (current LTS recommended; `node --version` shows yours). The server itself needs at least Node.js 20, which is no longer maintained.
- **Git**, to download the server.
- **FoundryVTT v13 or v14** (the versions the server handles explicitly; older versions are not verified) running with an **active world** (not on the world selection/setup screen), which you can open as its Gamemaster. Foundry may run on the same computer or on a server.
- An MCP client: Claude desktop or Claude Code (others such as Oh My Pi, VS Code or Cursor work the same way).
- **A Chromium-based browser installed** on the computer that runs the server, for the automatic headless GM browser session (step 4): Google Chrome, Microsoft Edge, Brave, Vivaldi and Chromium are detected automatically. Another Chromium-based browser, or one installed elsewhere, can be named in the configuration (see step 4).

### 2. Set Up a Dedicated Foundry User
In FoundryVTT, with the world launched and logged in as its Gamemaster:
1. Open **Game Settings** → **User Management**.
2. Click **Create User**.
3. Set the user name (e.g. `mcp-api`) and a long password used nowhere else.
4. Set the role to **Assistant GM**.
5. Save.

This one account is all the server needs: its Socket.IO connection and its invisible browser session (step 4) share the same login. Prefer **Assistant GM** to **Gamemaster**: the invisible session is a real Foundry client, and as a Gamemaster it could become the *active GM* in place of your own Gamemaster login (equal roles go to the smaller user id) and run the game system's automations — `status` and `get_health_status` warn about it. As an Assistant GM the server cannot grant the Gamemaster role or change `core.permissions` (it refuses both with a clear message); do those yourself as a Gamemaster.

### 3. Install Companion Module (FoundryVTT MCP Bridge)
Install it from Foundry's **Setup** screen (FoundryVTT 13 or later). From a running world, **Game Settings** → **Return to Setup** gets there.

1. Open **Add-on Modules** → **Install Module**.
2. Paste the manifest URL into the **Manifest URL** field at the bottom and click **Install**:

   ```
   https://raw.githubusercontent.com/G33ks/foundryvtt-mcp/main/foundry-module/module.json
   ```

3. Launch your world, log in as its Gamemaster, open **Game Settings** → **Manage Modules**, check **FoundryVTT MCP Bridge** and click **Save Module Settings**.

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
With the module installed and `FOUNDRY_MODULE_BRIDGE_ENABLED=true` (`init`, step 5, always writes it; off by default otherwise), the server automatically launches its own invisible background browser tab, opens the game in it with the session of `mcp-api` (the account from step 2 — the server logs in once and both connections share that login), and hosts the companion module there. This gives the AI full GM-tier canvas access (screenshots, dice rolls, pausing, file uploads) while a **human can log into their own visible Foundry client** — as a Player (no fog-of-war spoilers), or as the Gamemaster. Only `mcp-api` appears in Foundry's player list for the server.

The tab stays on the game page: a navigation elsewhere — **Log Out**, or Foundry reloading the client after `mcp-api`'s role changes — is blocked and the tab reloads the game instead, because leaving it would log the shared session out. When Foundry forgets the session (server restart, world shut down and relaunched, sessions last 24 hours), the server logs in again by itself and hands the new session to the tab.

**Advanced: two accounts.** Set `FOUNDRY_HEADLESS_GM_USERNAME` and `FOUNDRY_HEADLESS_GM_PASSWORD` to another GM or Assistant GM account and the tab logs that account in through Foundry's login form instead (`status` then shows `separate account (…)`).

The session is self-healing: a watchdog polls the bridge's own connectivity every 20s (independently of whether the Foundry login itself is still active) and force-reloads the tab if it stays disconnected for ~60s. This recovers the module's WebSocket even when the browser session never actually logs out — the module's own client-side reconnect logic gives up permanently after ~85 minutes of failed attempts, and a full page reload gives it a fresh start rather than requiring a server restart.

This step needs nothing from you beyond a browser being installed: no path to set. The server looks, at their usual install locations, for Google Chrome, then Microsoft Edge, Brave, Vivaldi, a system Chromium, and last Playwright's own Chromium (not bundled: downloaded with `npx playwright install chromium`). It uses the first one found; if that one fails to start, the next. `status` and `get_health_status` show the browser, its path and `(detected)`; with none found, the error lists every location tried. To choose the browser yourself — another Chromium-based browser, or one installed elsewhere — set `FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH` to its executable in the [configuration file](#the-configuration-file) (no fallback then: an error names that path):

```env
FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH='C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe'
```

(In a JSON `env` block instead, double the Windows backslashes.)

The headless browser is launched with Chromium's local network access checks disabled, so the module can reach the bridge on `ws://localhost` even when Foundry is served from a public address (see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#module-bridge-never-connects--websocket--failed)).

Keep `FOUNDRY_HEADLESS_GM_ENABLED` at its default `true`: since module 0.5.0, the companion module only connects from this session — it authenticates the server through a function only the headless session provides (see the README, [Module Bridge Security](README.md#module-bridge-security)). A GM tab opened by hand is no longer supported, so `FOUNDRY_HEADLESS_GM_ENABLED=false` disables the bridge in practice, and the server logs a warning at startup.

### 5. Run `init`

Download and build the server in a terminal (PowerShell, Windows Terminal, cmd, Terminal on macOS, any shell on Linux), in the folder where you want it:

```bash
git clone https://github.com/G33ks/foundryvtt-mcp.git
cd foundryvtt-mcp
npm ci            # installs exactly the locked dependency versions
npm run build
```

Then, in the same folder:

```bash
node dist/index.js init        # or `foundryvtt-mcp init` when installed as a package
```

`init` writes the [configuration file](#the-configuration-file), checking each answer against your FoundryVTT as it goes:

1. It shows where the file is. If it exists, its values are the defaults — passwords show as `<set>`, and Enter keeps them.
2. **Address**: it checks that the server answers with a world running (a clear message, and Enter to try again, when it is unreachable, its certificate is refused, or no world is launched).
3. **Account**: the user from step 2 and its password (typing stays hidden). A Player or Trusted Player is refused (the module and the headless session need a GM role); a Gamemaster gets the warning above. A wrong password asks again.
4. **Module**: it checks that `foundryvtt-mcp-bridge` is installed and enabled in the world, or says how to.
5. **Browser**: it shows the browser found and starts it headless once.
6. **Writes**: whether the assistant may change the game (`FOUNDRY_WRITE_ENABLED`; no by default).
7. It writes only what differs from the defaults (and always `FOUNDRY_MODULE_BRIDGE_ENABLED=true`). An existing file is copied first (`config.env.bak-<date>-<time>`) and changed in place, keeping your comments and other settings; the file is then read back to check it.
8. It prints the entry for Claude desktop (**Settings → Developer → Edit Config**) and the `claude mcp add` commands for Claude Code (`--scope user` for all your projects, `--scope local` for the current one) — see [step 6](#6-add-the-server-to-claude).
9. If the shared process is running with older connection settings, it offers to stop it.

`init` needs an interactive terminal: with redirected input it refuses. It never asks about the two-account mode (an advanced option, set by hand in the file).

`node dist/index.js init --check` runs the same checks on the existing configuration, asking and writing nothing — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#init---check-start-here).

### 6. Add the server to Claude

- **Claude desktop**: **Settings** → **Developer** → **Edit Config** opens `claude_desktop_config.json`. Add the `foundryvtt` entry `init` printed inside `"mcpServers"`, next to any entries already there, and save. Then quit Claude desktop completely — closing its window is not enough: quit it from the notification area (Windows) or the menu bar (macOS) — and start it again.
- **Claude Code**: run the `claude mcp add foundryvtt …` command `init` printed, then start a new Claude Code session. `claude mcp list` shows the entry.

The entry holds only the command: no `env` block, since the settings are in the [configuration file](#the-configuration-file). Other clients: see [MCP Client Configurations](#-mcp-client-configurations).

### 7. Check that it works

1. `node dist/index.js init --check` in the terminal, from the `foundryvtt-mcp` folder: it should end with `All checks passed.`
2. In Claude, ask for the connector's health status (*"Show the FoundryVTT connector's health status"*). Claude calls `get_health_status`; the first call can take a few seconds while the shared process connects. Expect:
   - **FoundryVTT Connection**: ✅ Connected, with the account from step 2 (Assistant GM);
   - **Module Bridge**: ✅ Connected — authenticated module (protocol v1);
   - **Headless GM Session**: ✅ Logged in — sharing the connector's session, and the **Browser** line with the browser found (`detected`);
   - **Configuration**: the configuration file, and the settings coming `from file`.
3. `node dist/index.js status` shows the same from the terminal, with the shared process's pid and logs.

When a line is ❌, the message says why; [TROUBLESHOOTING.md](TROUBLESHOOTING.md) covers each case.

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
claude mcp add foundryvtt --scope user -- node "<ABSOLUTE_PATH_TO_REPO>/dist/index.js"
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

## 🛠️ Troubleshooting

Start with `node dist/index.js init --check`: it checks the address, the account and its role, the companion module and the browser, and says what to fix. Then:

- `node dist/index.js status` shows the shared process, its FoundryVTT connection, the module bridge, the headless GM session and where each setting comes from.
- `get_health_status`, in your AI client, shows the same from the connector's side.
- The shared process logs to `daemon.log` in the state directory (`status` prints the path).

[TROUBLESHOOTING.md](TROUBLESHOOTING.md) covers each error message: connection and login, the companion module (missing, too old, never connecting, refused connections), the headless GM session and its browser, the shared process, and the configuration.
