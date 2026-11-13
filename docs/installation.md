# Installation

The README's quick start, step by step, with the details and the alternatives. When a step fails, [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) explains each message.

## Requirements

- **Node.js 22 or newer**, with npm: `node --version` shows yours. Download it from [nodejs.org](https://nodejs.org/).
- **FoundryVTT** with a world you can open as its Gamemaster, on this computer or on a server. See [Compatibility](compatibility.md) for the versions tried.
- **A Chromium-based browser** on the computer that runs the connector: Google Chrome, Microsoft Edge, Brave, Vivaldi or Chromium. The connector finds it by itself and runs it in the background; you never see it.
- **An MCP client**, such as Claude desktop or Claude Code.

## 1. The companion module and the connector's account

### Install the module

On FoundryVTT's **Setup** screen (the one listing your worlds; from a running world, **Game Settings** → **Return to Setup**). FoundryVTT may first ask for its administrator password, the one set when FoundryVTT was installed, not a user's password.

1. Open **Add-on Modules** → **Install Module**.
2. Paste this URL into the **Manifest URL** field at the bottom, then click **Install**:

   ```
   https://raw.githubusercontent.com/G33ks/foundryvtt-mcp/main/foundry-module/module.json
   ```

This URL always describes the latest release of the module. Each release also attaches its own `module.json` on GitHub (tags `bridge-vX.Y.Z`), to install one exact version.

**Updating the module**: on the Setup screen, **Add-on Modules** → **Check for Updates** (or the module's own update button), then reload the world. FoundryVTT ranks a pre-release such as `0.5.1-rc.1` above `0.5.1`, so a final release never replaces its own pre-release that way: install it with **Install Module** and the URL above instead; the world keeps the module enabled.

**Manual copy (advanced)**: copying the repository's `foundry-module` folder to FoundryVTT's `Data/modules/foundryvtt-mcp-bridge` works too, but FoundryVTT can then neither check for updates nor reinstall the module. To move to a release later, take the copied folder out of `Data/modules` with the world shut down, then install by URL: the module keeps its id, so the world keeps it enabled.

### Create the connector's account and enable the module

Launch your world and log in as its Gamemaster.

1. **Create the account**: **Game Settings** → **User Management** → **Create Additional User**. Name it `mcp-api` (or any name), give it a **long password used nowhere else**, set its role to **Assistant GM**, and save.
2. **Enable the module**: **Game Settings** → **Manage Modules**, check **FoundryVTT MCP Bridge**, then **Save Module Settings**. The world reloads for everyone connected; log in again if FoundryVTT asks.

This one account is all the connector needs: its Socket.IO connection and its invisible browser session share the same login. **Prefer Assistant GM to Gamemaster**: the invisible session is a real FoundryVTT client, and as a Gamemaster it could become the world's *active GM* in place of your own Gamemaster login; `status` and the health check warn about it. As an Assistant GM, the connector cannot grant the Gamemaster role or change the world's permission settings; it refuses both with a clear message, and you do them yourself.

You keep playing as usual, in your own browser, as the Gamemaster or as a player: only the connector's account appears in the player list for it.

## 2. Install the connector

In a terminal (PowerShell or Windows Terminal on Windows, Terminal on macOS, any shell on Linux):

```bash
npm install -g @g33ks/foundryvtt-mcp
foundryvtt-mcp --version
```

- In Windows PowerShell, if `npm` is refused with *running scripts is disabled on this system*, type `npm.cmd` instead of `npm`.
- npm may print warnings (a blocked install script, funding messages); they do not stop the install.
- **The package is `@g33ks/foundryvtt-mcp`.** The unscoped `foundryvtt-mcp` package on npm belongs to the original project.
- **Install it globally**, not through `npx`: npx keeps packages in a cache that npm replaces or deletes, so `init` would print no client entry from there.

## 3. Run `init`

```bash
foundryvtt-mcp init
```

`init` writes the [configuration file](configuration.md), checking each answer against your FoundryVTT as it goes:

1. It shows where the file is. If it exists, its values are the defaults: passwords show as `<set>`, and Enter keeps them.
2. **Address**: the URL you open FoundryVTT with, such as `http://localhost:30000` or `https://foundry.example.com`. It checks that a world is running there, and says so when the server is unreachable, its certificate is refused, or no world is launched.
3. **Account**: the account from step 1 and its password (typing stays hidden). A Player or Trusted Player is refused; a Gamemaster gets a warning.
4. **Module**: it checks that the companion module is installed and enabled in the world, or says how to.
5. **Browser**: it shows the browser found and starts it once, invisibly.
6. **Writes**: whether the AI may change the world (`FOUNDRY_WRITE_ENABLED`, no by default).
7. It writes only what differs from the defaults, plus `FOUNDRY_MODULE_BRIDGE_ENABLED=true`. An existing file is copied first (`config.env.bak-<date>-<time>`) and changed in place, keeping your comments and other settings; the file is then read back to check it.
8. It prints the entries for your MCP client (next step).
9. If the shared process is running with other connection settings, it offers to stop it.

`init` needs an interactive terminal. It never asks about the advanced settings; see [Configuration](configuration.md) for those.

## 4. Add the connector to your MCP client

The entries `init` prints start Node.js on the installed connector, both by their absolute path: MCP clients may start servers with a reduced `PATH`. No `env` block is needed, since the settings are in the configuration file.

- **Claude desktop**: **Settings** → **Developer** → **Edit Config** opens `claude_desktop_config.json`. Add the `foundryvtt` entry `init` printed inside `"mcpServers"`, next to any entries already there, and save. Then **quit Claude desktop completely**, from the notification area (Windows) or the menu bar (macOS): closing its window is not enough. Start it again.
- **Claude Code**: run the `claude mcp add foundryvtt …` command `init` printed (`--scope user` for all your projects, `--scope local` for the current one), then start a new session. `claude mcp list` shows the entry. In Windows PowerShell, if `Get-Command claude` shows a `claude.ps1` (installed with npm), PowerShell swallows the `--` of that command: type `'--'` instead.

**By hand, or for another MCP client** that starts servers over stdio, an entry needs two paths:

- `<NODE>`: what `node -p process.execPath` prints, such as `C:\Program Files\nodejs\node.exe` or `/usr/local/bin/node`;
- `<ENTRY>`: what `npm root -g` prints, followed by `/@g33ks/foundryvtt-mcp/dist/index.js`.

```json
{
  "mcpServers": {
    "foundryvtt": {
      "command": "<NODE>",
      "args": ["<ENTRY>"]
    }
  }
}
```

In JSON, double each Windows backslash, or write forward slashes. Some clients also want `"type": "stdio"`. **After changing or updating Node.js** (a new installer, nvm), `<NODE>` changes: run `foundryvtt-mcp init` again and replace the entries.

## 5. Check that it works

1. In the terminal: `foundryvtt-mcp init --check`. It ends with `All checks passed.`; a `✖` line says what to fix.
2. In your MCP client, ask: *"Show the FoundryVTT connector's health status."* The client calls `get_health_status` (allow it when asked). The first call can take a few seconds while the connector connects. Expect:
   - **FoundryVTT Connection**: connected, with the account from step 1;
   - **Module Bridge**: connected, with an authenticated module and its version;
   - **Headless GM Session**: logged in, sharing the connector's session, with the browser found;
   - **Configuration**: the configuration file the settings come from.
3. `foundryvtt-mcp status` shows the same from the terminal, with the shared process's id and the path of its logs.

## Updating the connector

1. Close your MCP clients (quit Claude desktop completely).
2. In a terminal:

   ```bash
   npm install -g @g33ks/foundryvtt-mcp@latest
   foundryvtt-mcp stop
   ```

   `stop` ends the shared process, which may still run the previous version. `foundryvtt-mcp --version` shows the installed one.
3. Start your clients again. Their entries stay valid, since the installed connector keeps its path; only a Node.js change requires new ones.

Without `stop`, the first client started after the update replaces the shared process anyway, and a client left open says, in its next tool result, to restart it. The companion module updates separately, from FoundryVTT's Setup screen (see step 1).

## Uninstalling

1. `foundryvtt-mcp stop`, then remove the `foundryvtt` entry from your MCP clients.
2. `npm uninstall -g @g33ks/foundryvtt-mcp`.
3. Delete the configuration file and the state directory (logs, token, copies of journal pages): on Windows `%LOCALAPPDATA%\foundryvtt-mcp\`; on macOS and Linux `~/.config/foundryvtt-mcp/` and `~/.local/state/foundryvtt-mcp/` (or under `$XDG_CONFIG_HOME` and `$XDG_STATE_HOME`).
4. In FoundryVTT: disable and uninstall the companion module, and delete the connector's account.

## Working from a clone

To work on the code, see [CONTRIBUTING.md](../CONTRIBUTING.md). From a clone, use `node dist/index.js` instead of `foundryvtt-mcp` in every command of this page; `init` then prints entries that start the clone's `dist/index.js`. Give your MCP clients entries for one install only.
