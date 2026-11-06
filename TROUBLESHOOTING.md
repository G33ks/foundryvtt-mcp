# FoundryVTT MCP Troubleshooting Guide

This guide helps you diagnose and resolve common issues with the FoundryVTT MCP server.

The commands use `foundryvtt-mcp`, the command of the installed package (`npm install -g @g33ks/foundryvtt-mcp`). From a clone, type `node dist/index.js` in the clone instead.

## Quick Diagnostics

### `init --check` (start here)
```bash
foundryvtt-mcp init --check
```
Checks the configuration the connector would use, step by step, without asking
anything or writing anything — safe while the shared process runs:

1. the address answers, with a world running (TLS checked like the connector does);
2. the account logs in, with a GM role (Assistant GM recommended);
3. the companion module `foundryvtt-mcp-bridge` is installed and enabled in the world (and its version);
4. a Chromium-based browser starts headless for the invisible GM session.

Each failed step says what to fix. To write or fix the configuration
interactively, run `foundryvtt-mcp init` (see [SETUP_GUIDE.md](SETUP_GUIDE.md)).

### Health Check
```bash
foundryvtt-mcp status            # the shared process: connection, bridge, browser
# In your AI client, run: get_health_status
```

### Check Current Status
The shared process runs in the background, so its startup messages go to `daemon.log`, not to a terminal: `foundryvtt-mcp status` prints its path. Look there for:
- `Connected to FoundryVTT via Socket.IO`
- `Module bridge listening on ws://localhost:31415 (loopback only)`
- `Headless GM session logged in — sharing the connector's session (mcp-api)`
- `Foundry module connected and authenticated (protocol v1)`

## Common Issues

### Installation

#### `foundryvtt-mcp` is not recognized after `npm install -g`
npm's global folder is not on your `PATH`. `npm prefix -g` prints it (on Windows the command sits in that folder, usually `%APPDATA%\npm`; elsewhere in its `bin/` subfolder). Add it to `PATH` and open a new terminal. The MCP clients do not depend on it: their entries name Node.js and the server by absolute path.

#### The wrong package is installed
`npm ls -g --depth=0` lists `foundryvtt-mcp` without `@g33ks/`, or `foundryvtt-mcp --version` does not print a 2.x version (an old one may not answer at all; stop it with Ctrl+C). The unscoped `foundryvtt-mcp` package on npm is the original project's, not this one. Remove it and install this project's package:

```bash
npm uninstall -g foundryvtt-mcp
npm install -g @g33ks/foundryvtt-mcp
```

#### `init` prints no client entry
It ran from npx's cache (`npx @g33ks/foundryvtt-mcp init`), which npm replaces or deletes when it updates or cleans it, so a client entry pointing there would break. Install the package globally, then run `foundryvtt-mcp init`. The configuration it wrote is kept.

#### The client stopped starting the server after a Node.js change
The client entries name the Node.js that ran `init` by its path, which changes with a new Node.js version under nvm (and can with an installer). Run `foundryvtt-mcp init` again with the Node.js you use now, and replace the entries. Claude desktop's log (`mcp-server-foundryvtt.log`) shows the failed start.

### Connection Issues

#### "Connection Refused" or "ECONNREFUSED"
**Symptoms**: Cannot connect to FoundryVTT server
**Solutions**:
1. **Start FoundryVTT**: Ensure FoundryVTT is running and accessible
2. **Check URL**: Verify `FOUNDRY_URL` in your configuration file (`foundryvtt-mcp status` shows it)
   ```env
   FOUNDRY_URL=http://localhost:30000
   ```
3. **Test manually**: Open the URL in your browser to confirm FoundryVTT is accessible
4. **Check port**: Default FoundryVTT port is 30000, but yours might be different
5. **Firewall**: Ensure no firewall is blocking the connection

#### "Host Not Found" or "ENOTFOUND"
**Symptoms**: DNS resolution fails
**Solutions**:
1. **Check hostname**: Verify the hostname in `FOUNDRY_URL` is correct
2. **Use IP address**: Try using `127.0.0.1` instead of `localhost`
3. **Network connectivity**: Ensure your network connection is working

#### "Timeout" Errors
**Symptoms**: Connection attempts time out
**Solutions**:
1. **Increase timeout**: Add to your configuration file:
   ```env
   FOUNDRY_TIMEOUT=20000
   ```
2. **Check FoundryVTT performance**: Ensure FoundryVTT isn't overloaded
3. **Network latency**: Consider network speed if using remote FoundryVTT

### Authentication Issues

#### "Session cookie not obtained"
**Symptoms**: Cannot fetch the `/join` page or extract session cookie
**Solutions**:
1. **Check URL**: Verify `FOUNDRY_URL` points to a running FoundryVTT instance
2. **Active world**: Ensure a world is active (not on the setup screen) — the `/join` page only exists when a world is loaded
3. **Test manually**: Open `http://localhost:30000/join` in your browser
4. **Proxy issues**: If behind a reverse proxy, ensure the `/join` path is forwarded correctly

#### "User ID resolution failed"
**Symptoms**: Username cannot be resolved to a user ID
**Solutions**:
1. **Verify username**: Username must match a FoundryVTT user exactly (case-sensitive)
2. **Active world**: The user must exist in the active world
3. **Set user ID directly**: Set `FOUNDRY_USER_ID` to the 16-character document `_id` of your user:
   ```env
   FOUNDRY_USER_ID=abc123def456ghij
   ```
   Find the `_id` in FoundryVTT's user data or by inspecting the `/join` page response.
4. **User status**: Verify the user account is active and not banned

#### "Authentication failed" or "joinGame rejected"
**Symptoms**: Socket.IO authentication fails after user ID resolution
**Solutions**:
1. **Verify password**: Check the password is correct
2. **User permissions**: Ensure user has required permissions in FoundryVTT
3. **Debug logging**: Set `LOG_LEVEL=debug` to see the full authentication flow

### World Data Issues

#### "World data not received"
**Symptoms**: Connection succeeds but no game data is available
**Solutions**:
1. **Active world**: Ensure a world is active in FoundryVTT (not on the setup screen)
2. **Authentication completed**: Verify the full 4-step auth flow completed — check logs for `joinGame` success
3. **User permissions**: The user must have permission to view world data
4. **Restart**: Try restarting both FoundryVTT and the MCP server

#### "Empty search results"
**Symptoms**: Search commands return no results
**Solutions**:
1. **Data exists**: Verify actors/items/journals exist in your FoundryVTT world
2. **Permissions**: Ensure the MCP user has permission to view the data
3. **World data loaded**: Check server startup logs for worldData loading confirmation
4. **Refresh data**: Use the `refresh_world_data` tool to reload from FoundryVTT
5. **User context**: Try searching directly in FoundryVTT to confirm data visibility

#### Scene Information Not Available
**Symptoms**: Scene commands return limited data
**Solutions**:
1. **Active scene**: Ensure a scene is activated in FoundryVTT
2. **Permissions**: Verify user can access scene information
3. **Refresh**: Use `refresh_world_data` to reload the cached state

### Feature-Specific Issues

#### Dice Rolling Not Working
**Symptoms**: Dice roll commands fail
**Solutions**:
1. **Check formula**: Ensure dice notation is valid (e.g., "1d20+5", "3d6")
2. **FoundryVTT version**: The server handles FoundryVTT v13 and v14 explicitly; older versions are not verified

#### A journal edit was overwritten
**Symptoms**: A journal tool response starts with `⚠️ Journal overwrite detected`, `get_health_status` lists an overwrite under **Journal Integrity**, or the GMs received a whispered chat message about it. Text the connector wrote to a page is gone, or a change made in FoundryVTT was replaced by the connector's write.

**What is prevented**: every page write (`update_journal_page`, `add_journal_page`) first reads the entry back from the server, never from the cache. An append is added to the page as currently stored, and a replace is refused (nothing is written) unless its `expectedVersion` still matches the stored page — read it again with `get_journal` `raw: true` and rewrite it.

**What is only detected** (for 6 hours after each write, in memory):
- **A stale save** — someone saved an older copy of the page over the connector's text. The history reason is `overwritten-by-<user name>`.
- **An open editor's autosave** — while a text page is open in a FoundryVTT editor, the server keeps its own copy of the page and saves it every `core.editorAutosaveSecs` (60 s by default). A connector write never reaches that copy. The certain risk is an editor **in which text has been typed**: it does not reload, and its next autosave reverts the connector's write (seen 37 s after the write in testing). An editor opened without typing reloaded the page on the connector's write in testing, and the write survived its autosaves; it is still watched, since the server's copy is only refreshed when the editing session restarts. Reason: `overwritten-by-editor-autosave` (FoundryVTT does not say who is editing). A page autosaved in the last 10 minutes is flagged in the write response; FoundryVTT does not report an editor closing, so the flag can remain for a few minutes after it was closed. Either way: close the editor before writing, or write after the session.
- **A change that crossed the connector's write** — someone saved the page between the connector's read-back and its write; the connector's write replaced it. Reason: `overwritten-by-connector`; the copy holds *their* version.

Detection compares paragraphs of text, not HTML, so markup rewritten by FoundryVTT or the editor does not count as a loss. Changes made by the connector's own accounts (`FOUNDRY_USERNAME` and the headless GM user) are never reported.

**Where the copies are**: in the state directory (see [Shared Process](#where-are-the-logs)), under `journal-history\<journalId>\<pageId>\`. Each copy is a `<time>-<reason>.html` file — the page body exactly as stored — with a `.json` next to it: entry and page names, reason, version token, `overwrittenBy` (who replaced that version, or is about to: a user name, the connector account for its own writes, or `editor-autosave (unknown user)`), `versionBy` (whose version an overwrite copy holds), `connectorAccount` and the date. A copy is written before every page write (`before-replace`, `before-append`) and for every detected overwrite; a page write is refused if its copy cannot be written. Each page keeps its 20 most recent copies, none older than 30 days. `get_health_status` prints the folder; `daemon.log` records ids, version tokens and copy paths, never page text.

**Restoring by hand**:
1. Find the copy: the path is in the warning, the whisper and `get_health_status`, or sort the page's folder by name (the newest is last).
2. Check it: open the `.html` file in a text editor (or a browser) and compare it with the page in FoundryVTT. Make sure nobody has the page open in an editor.
3. Put it back: in FoundryVTT, open the page, switch the editor to its HTML source view, replace the content with the copy's content and save. Or ask the assistant to read the copy and rewrite the page with `get_journal` `raw: true` followed by `update_journal_page` (replace, with the version just read). That rewrite itself saves a `before-replace` copy of what it replaces.

#### Companion module missing or too old
**Symptoms**: the bridge tools (`capture_scene`, `search_compendium_content`, …) report that no authenticated module is connected; **FoundryVTT MCP Bridge** is absent from **Manage Modules**; or `daemon.log` shows `likely an outdated foundryvtt-mcp-bridge module (< 0.5.0), redeploy it`.

**Solutions**:
1. **Module absent**: install it from the Setup screen, **Add-on Modules** → **Install Module**, with the manifest URL `https://raw.githubusercontent.com/G33ks/foundryvtt-mcp/main/foundry-module/module.json` (see [SETUP_GUIDE.md](SETUP_GUIDE.md#2-install-companion-module-foundryvtt-mcp-bridge)), then enable it in the world's **Manage Modules** and reload.
2. **Module too old**: **Add-on Modules** → **Check for Updates** in the Setup screen, then reload the world. A copy installed by hand has no manifest URL, so Foundry cannot update it: move its folder out of `Data/modules/foundryvtt-mcp-bridge` with the world shut down, then install by manifest URL as in 1. The world keeps the module enabled, since the id is the same.
3. **Check for Updates says the module is current, but a final release is out**: a final release never replaces its own pre-release through the update check. Foundry ranks `0.5.1-rc.1` above `0.5.1`, so a world running a pre-release sees the final as older. Use **Install Module** with the manifest URL above: it installs the final release over the pre-release.
4. **Installed version**: the Setup screen's **Add-on Modules** list shows it. `status` and `get_health_status` only show that an authenticated module (protocol v1) is connected, not its version.

#### Module Bridge Never Connects / "WebSocket ... failed"
**Symptoms**: `get_health_status` keeps reporting the module bridge as disconnected (canvas tools such as `capture_scene` say no module is connected), even though the server logs `Module bridge listening on ws://localhost:31415` and the GM session is logged in. The browser console of the GM tab shows `WebSocket connection to 'ws://localhost:31415/' failed`, with no further detail.

**Cause**: The companion module runs inside the Foundry page, served from `FOUNDRY_URL`, and dials the bridge on `localhost`. When Foundry is reached through a public address, recent Chromium-based browsers treat this as a public site reaching into the local machine and block it: Chromium's Local Network Access (formerly Private Network Access) asks for a permission first, and Brave adds its own "localhost access" permission. Until that permission is granted the connection is refused silently.

**Solutions**:
1. **Automatic headless GM session**: Nothing to do — the server launches its headless browser with these checks disabled (a throwaway browser with a fresh profile that only loads `FOUNDRY_URL`). If it still fails, look for errors in the server logs (`daemon.log` in shared-process mode), in particular `Module bridge refused a connection: …` (see [below](#module-bridge-refused-a-connection-)).
2. **GM tab opened by hand**: no longer supported. Since module 0.5.0 the module only connects from the headless GM session, which provides the `window.foundryMcpBridge` function it authenticates with; `FOUNDRY_HEADLESS_GM_ENABLED=false` therefore disables the bridge in practice. In an ordinary GM tab, the browser console line `FoundryVTT MCP Bridge | no foundryvtt-mcp credentials in this browser, bridge disabled` is normal — that tab is not meant to connect.
3. **Check the bridge itself**: If the server log has no `Module bridge listening` line, the port may already be in use or `FOUNDRY_MODULE_BRIDGE_ENABLED` is `false`. In shared-process mode that log is `daemon.log` (see [Shared Process](#shared-process)); `foundryvtt-mcp status` shows whether the bridge listens and whether the module is connected. The port is typically held by another process running in all-in-one mode (`FOUNDRY_MCP_SHARED=false`), or by a shared process from a second state directory.
4. **Bridge reached from another machine**: The bridge listens on loopback only (`127.0.0.1`, `::1`). The module must run in a browser on the same machine as the MCP server — which the headless GM session always does.

#### "Module bridge refused a connection: …"
**Symptoms**: The server log (`daemon.log` in shared-process mode) shows `Module bridge refused a connection: <reason>`, and the module bridge stays disconnected — or stays connected, if the refused client was not the module.

**Cause**: The bridge port is reachable by every local process and every page open in a local browser, so the bridge only accepts the companion module (0.5.0 or later) running in the headless GM session, after a mutual authentication (see the README, [Module Bridge Security](README.md#module-bridge-security)). Any other client is refused, and the refused connection never affects the connected module. At most 10 refusals are logged per minute; the rest are summarised as `N more refused connection(s) not logged in the last minute`.

**Reasons**:
- **`unexpected Origin`** (with the `origin` received): the WebSocket did not come from a page served at `FOUNDRY_URL`'s origin. If it is the module, the address the headless browser loaded does not match the origin of `FOUNDRY_URL` exactly — scheme (`http`/`https`), host (IP address vs domain name, `localhost` vs `127.0.0.1`) and port must all be identical; fix `FOUNDRY_URL`. Otherwise it is a foreign page or program (origin `(none)` for a non-browser client), and the refusal is expected.
- **`client did not authenticate within 5000 ms; likely an outdated foundryvtt-mcp-bridge module (< 0.5.0), redeploy it`**: the client opened the socket from the right origin but never authenticated. Usually the installed module is older than 0.5.0 — update or reinstall it (see [Companion module missing or too old](#companion-module-missing-or-too-old)) and reload the world. Otherwise, a foreign client.
- **`wrong authentication proof`**: the client answered with a proof that does not match this server's secret — a foreign client. The module in the headless session always computes the right proof, since the secret lives in the same process.
- **`unsupported bridge protocol … (expected 1)`**: a module speaking another version of the handshake. Install the module from the same checkout as the server.
- **`non-JSON message before authentication`**, **`message other than auth_response before authentication`**, **`malformed auth_response`**, **`message over 4096 bytes before authentication`**: the client sent something other than the module's handshake — a foreign client, or a module copy that does not match the server. Redeploy the module from the same checkout if the bridge stays disconnected.

**Check it**: `foundryvtt-mcp status` shows the `Module bridge:` line (`protocol v1, authenticated module connected: yes/no`) and the `Bridge origin:` line, the only origin accepted — compare it with the address Foundry is served from. With the module connected, `npm run check:bridge-security` makes four forged connections and confirms each one is refused while the module stays connected.

### Shared Process

By default MCP clients start lightweight relays, and one background **shared process** holds the FoundryVTT connection, the module bridge and the headless GM session (see the README, *Shared Process Mode*).

#### Where are the logs?
In the state directory — `%LOCALAPPDATA%\foundryvtt-mcp\` on Windows, `$XDG_STATE_HOME/foundryvtt-mcp/` or `~/.local/state/foundryvtt-mcp/` elsewhere:

| File | Contents |
|------|----------|
| `daemon.log` (+ `.1` … `.3`) | The shared process: FoundryVTT connection, bridge, GM session, every tool call. It runs detached, so this file is its only output. |
| `relay.log` (+ `.1` … `.3`) | Every relay: start, connection to the shared process, exit. Relays also keep logging to stderr, i.e. to the MCP client's own log. |
| `daemon.json` | pid, version, start time, pipe and log path of the running shared process. |
| `token` | Secret the relays present to the shared process. Do not share it. |

`foundryvtt-mcp status` prints the paths actually in use. Set `LOG_LEVEL=debug` in the configuration file for more detail, then `foundryvtt-mcp stop` (it applies to the shared process started next).

#### Inspecting and stopping the shared process
```bash
foundryvtt-mcp status   # running?, pid, uptime, FoundryVTT / bridge / GM session, relays, write queue
foundryvtt-mcp stop     # lets running calls finish, then exits (waits up to ~2.5 min)
```
`status` exits with code 3 when nothing runs. If `stop` cannot reach the process (for example after the `token` file was deleted), end the pid listed in `daemon.json` — Task Manager, `Stop-Process -Id <pid>` (PowerShell) or `kill <pid>`. The next tool call starts a fresh one.

#### Checking the pipe
- **Windows** (PowerShell): `Get-ChildItem \\.\pipe\ | Where-Object Name -like 'foundryvtt-mcp*'` lists `foundryvtt-mcp-<user>` while the shared process runs. A name with an extra `-xxxxxxxx` suffix belongs to a non-default `FOUNDRY_MCP_STATE_DIR` (the stress script uses one).
- **Linux/macOS**: `ls -l ~/.local/state/foundryvtt-mcp/daemon.sock` (a socket left by a crash is detected and replaced automatically; very deep state directories fall back to `$TMPDIR/foundryvtt-mcp-<user>/daemon.sock`).

#### "The shared process could not connect to FoundryVTT: …"
FoundryVTT is not reachable yet, or the URL/credentials are wrong. The shared process stays up and retries on the next call: start FoundryVTT and call the tool again. The message carries the underlying error; `daemon.log` has the details.

#### "Reconnecting to FoundryVTT… (waiting-for-world: No active world …)" / "No active world on FoundryVTT"
FoundryVTT is running but no world is launched: it shows the Setup screen, typically after the Foundry server restarted (a backup can restart it) or after **Return to Setup**. Launch the world; nothing else is needed. The connector retries by itself in the background — every 5 s at first, then doubling up to once every 2 min — and reconnects within that delay once the world is up, without any tool call. Each change of state is logged once in `daemon.log` (`FoundryVTT connection: waiting-for-world — …`), not once per attempt.

While it reconnects:
- `foundryvtt-mcp status` shows `FoundryVTT: not connected (waiting-for-world — …)` (or `reauthenticating`, `retrying`), a `World cache: stale since <time> — <reason>` line once a loaded world stopped following live changes, and the headless GM session `reauthenticating`, `waiting-for-session` (no session yet) or `loading-game` (session in hand, `/game` loading); `get_health_status` says the same.
- A tool call that reads the cached world or goes through the socket (every document write, `foundry://` resources too) waits up to 15 s for the connection, then is refused with `Reconnecting to FoundryVTT… (<state>: <reason>)`. Nothing is ever sent to FoundryVTT on a connection it no longer recognises; a write keeps its place in the write queue while it waits. Tools that never touch the socket — those of the companion module, the REST API module, local ones such as `generate_npc` — go ahead at once.
- A plain network drop logs the first failed reconnection attempt, then one line a minute (or when the error changes), and `FoundryVTT connection restored after <n> s and <n> failed reconnection attempt(s)` once it is back.

#### "The companion module is not connected: …"
A tool that goes through the companion module (`capture_scene`, `get_targets`, `roll_and_post`, …) waits up to 10 s while the headless GM page is starting, loading `/game`, reconnecting or was just logged in — the module connects about half a second after the game is ready. It is refused at once, with the reason, when the module cannot come: the bridge is disabled (`FOUNDRY_MODULE_BRIDGE_ENABLED`) or failed to start (often its port is taken), the browser could not be launched, no headless session is configured, the session keeps failing (it retries on its own), or the page has been logged in for more than 15 s without a module (the watchdog reloads it; check that the companion module is enabled in the world).

After a FoundryVTT server restart, Foundry has forgotten every login; the connector notices it at the socket's reconnection (Foundry answers it with no user) and logs in again once. A plain network drop needs no new login: the socket reconnects with the same session.

#### Headless GM session: "blocked a navigation away from /game — reloading /game"
Expected. The invisible session shares the connector's login, and leaving the game page for `/join` would log that shared login out of the world. So any navigation away from `/game` — the **Log Out** button, or Foundry reloading the client after `mcp-api`'s role or password changed — is blocked, and the page reloads the game instead. It is not a disconnection: the connector keeps its session and does not log in again. If the reloaded page finds its session gone (Foundry redirects it to `/join`), it asks the connector for a new one.

#### Warning: "The connector's account … is a Gamemaster …"
In the default single-account mode the invisible session is a real Foundry client running as the connector's account. As a Gamemaster it can become Foundry's *active GM* instead of a human Gamemaster (equal roles go to the smaller user id) and run the game system's automations there. Make the account an **Assistant GM** (Configuration → User Management) while the connector is stopped, then start it again.

#### "The shared FoundryVTT MCP process did not become available within 30 s"
The relay started a shared process that never answered. Look at the end of `daemon.log`: a configuration error, a crash at startup, or an antivirus blocking `node.exe`. Running `foundryvtt-mcp daemon` by hand in a terminal with the same environment shows startup errors directly.

#### "The shared FoundryVTT MCP process exited during this call; its outcome is unknown"
The shared process died (or was killed) while it ran the call. The call is **not** resent automatically: for a write, check in FoundryVTT whether it happened before retrying. The next call starts a new shared process.

#### "refused this relay (unauthorized …)"
The `token` file changed while a shared process was running (deleted or edited by hand). End the shared process (see above); the next call starts one with the current token.

#### Where is my configuration?
`foundryvtt-mcp status` answers, with or without a running shared process. Its last section, **This terminal**, shows the configuration file it looked for (and whether it exists) and every setting with where it comes from: `env` (an environment variable — a client's `env` block, or the system), `.env` (a `.env` in the working directory), `file` (the configuration file). With a shared process running, `status` also shows the settings that process runs with, and what each connected client declared. Passwords and API keys show as `<set>`.

The file is `%LOCALAPPDATA%\foundryvtt-mcp\config.env` on Windows and `$XDG_CONFIG_HOME/foundryvtt-mcp/config.env` (or `~/.config/foundryvtt-mcp/config.env`) elsewhere; `FOUNDRY_MCP_CONFIG` names another one, and `FOUNDRY_MCP_STATE_DIR` moves it into that directory. See the README, *Configuration File*.

#### "FoundryVTT MCP is not configured: …"
No `FOUNDRY_URL` anywhere, or a setting that does not validate (the message names it and where it comes from). The server keeps running and lists its tools; every call answers with this message and reads the configuration again. Write the file at the path the message gives — at least `FOUNDRY_URL`, `FOUNDRY_USERNAME` and `FOUNDRY_PASSWORD`, each value between `'…'` — and call the tool again: no client restart needed.

#### "This MCP client's own settings are ignored: …"
The shared process serves every MCP client with **one** configuration, and this client passes settings of its own — usually an `env` block left in its configuration (or, for Claude Code, a `FOUNDRY_*` variable in the system environment, which it passes on; Claude desktop does not). They are not applied; the note names them and where they come from, and `foundryvtt-mcp status` lists every client with its ignored settings. Remove the `env` block (or the variable) and restart that client, or, if its values are the ones you want, put them in the configuration file and run `foundryvtt-mcp stop`.

Only the connection settings count (URL, account and passwords, API key, socket path, writes, module bridge, headless GM session, data path). A client with another `LOG_LEVEL`, timeout or idle delay is served without a note: the shared process's values apply.

#### The shared process restarted after I edited the configuration file
Expected, once: a client whose settings match the file *as it is now* while the running process was started with other ones (the file changed, or a client's `env` block started it) restarts it with the file's settings. Running calls finish first. It never restarts in a loop: any other difference is served, with the note above. An unreadable or invalid file restarts nothing.

#### The shared process stops on its own / `mcp-api` leaves Foundry's player list
It stops `FOUNDRY_MCP_IDLE_TIMEOUT_MINUTES` (5 by default) after the **last** MCP client closed (Claude desktop counts as closed only once quit from the notification area too), and leaves FoundryVTT then. Reopening a client within that delay keeps the same process; later, the first call starts a new one (a few seconds). `0` keeps it up for good. To stop it at once: `foundryvtt-mcp stop`.

#### The shared process keeps restarting / FoundryVTT reconnects often
`daemon.log` shows `a relay from a newer build … connected`: an MCP client runs a newer build than the shared process — a newer version, or for the same version a later install or rebuild. After updating, close every MCP client, run `foundryvtt-mcp stop`, and start them again, so that all relays run the same build. Clients pointing at two different installs (a clone and the package, or two Node.js prefixes) keep replacing each other's shared process: give every client the entries `foundryvtt-mcp init` prints for one install. (A different configuration no longer restarts it more than once — see above.)

#### Configuration in `.env` ignored with Claude Desktop
Claude Desktop starts MCP servers in `C:\Windows\System32`, where no `.env` file is looked up. Use the configuration file instead (see *Where is my configuration?*): every client reads it. A `.env` is only read from the working directory of the process (handy for development in the repository).

#### Diagnostics Tools Not Working
**Symptoms**: Health monitoring and log tools fail
**Solutions**:
1. **REST API module required**: `get_system_health`, `get_recent_logs`, `search_logs` and `diagnose_errors` need the optional Foundry Local REST API module; `get_health_status` answers without it and only adds the server's health when it is there
2. **Install module**: it is a separate project, not distributed by this repository — see [the configuration guide](docs/guides/configuration.md#optional-diagnostics-tools)
3. **Enable module**: Activate it in your world's module settings
4. **Set API key**: Add `FOUNDRY_API_KEY` to your configuration file, then run `foundryvtt-mcp stop`

## Environment Configuration

### Configuration File Template
`foundryvtt-mcp init` writes the configuration file (`%LOCALAPPDATA%\foundryvtt-mcp\config.env` on Windows, `~/.config/foundryvtt-mcp/config.env` elsewhere). Written by hand, it looks like this:
```env
# Required
FOUNDRY_URL='http://localhost:30000'
FOUNDRY_USERNAME='mcp-api'
FOUNDRY_PASSWORD='your password'

# What init also writes
FOUNDRY_MODULE_BRIDGE_ENABLED='true'
# FOUNDRY_WRITE_ENABLED='true'

# Optional: Diagnostics (requires REST API module)
# FOUNDRY_API_KEY='your_api_key_here'

# Optional: more detail in daemon.log
# LOG_LEVEL='debug'
```
Less common settings (`FOUNDRY_USER_ID`, `FOUNDRY_TIMEOUT`, `FOUNDRY_RETRY_ATTEMPTS`…) are in the [configuration guide](docs/guides/configuration.md). After editing the file, run `foundryvtt-mcp stop`.

### Configuration Validation
Check your configuration against the live FoundryVTT:
```bash
foundryvtt-mcp init --check
```

## Advanced Diagnostics

### Enable Debug Logging
Add to the configuration file, then run `foundryvtt-mcp stop` (the next call starts the shared process with it):
```env
LOG_LEVEL='debug'
```
`daemon.log` then has detailed logs, including the full Socket.IO authentication flow.

### Manual Connection Testing
Test individual components:

1. **Basic connectivity**:
   ```bash
   curl http://localhost:30000
   ```

2. **Join page accessibility** (confirms active world):
   ```bash
   curl -s http://localhost:30000/join | head -20
   ```

3. **REST API status** (if module installed):
   ```bash
   curl http://localhost:30000/api/status
   ```

4. **Authenticated REST endpoint** (if module installed):
   ```bash
   curl -H "x-api-key: YOUR_API_KEY" http://localhost:30000/api/world
   ```

### Test Individual Features
Use the MCP tools to test specific functionality:
- `roll_dice` - Test dice rolling
- `search_actors` - Test actor search
- `get_combat_state` - Test combat tracking
- `get_users` - Test user awareness
- `search_world` - Test world-wide search
- `get_health_status` - Comprehensive diagnostics: connection, account, module bridge, headless GM session, configuration (the REST API module adds the server's health)

## Platform-Specific Issues

### macOS
- **Firewall**: Check macOS firewall settings
- **Permission**: Ensure FoundryVTT has network permissions

### Linux
- **Port availability**: Ensure port 30000 isn't blocked
- **User permissions**: Check file system permissions

### Windows
- **Windows Defender**: Check firewall exceptions
- **WSL users**: Verify network bridge configuration

## Getting Help

### Documentation
- **Setup Guide**: [SETUP_GUIDE.md](SETUP_GUIDE.md)
- **README**: [README.md](README.md)
- **FoundryVTT Docs**: [https://foundryvtt.com/api/](https://foundryvtt.com/api/)

### Reporting Issues
If you continue to experience problems:

1. **Run diagnostics**:
   ```bash
   foundryvtt-mcp init --check
   ```

2. **Gather information**:
   - The output of `foundryvtt-mcp --version` (from a clone: `git rev-parse --short HEAD`)
   - The output of `foundryvtt-mcp status` (passwords show as `<set>`; check for anything else private)
   - `daemon.log` (with `LOG_LEVEL=debug`)
   - FoundryVTT version and active modules
   - Error messages and stack traces

3. **Report the issue**: [GitHub Issues](https://github.com/G33ks/foundryvtt-mcp/issues)

### Community Support
- **Discord**: Join the FoundryVTT community
- **Reddit**: r/FoundryVTT
- **Forums**: FoundryVTT community forums

## Quick Reference

### Common Commands
```bash
# Setup and configuration
foundryvtt-mcp init           # Interactive setup (writes the configuration file)
foundryvtt-mcp init --check   # Check the configuration, writes nothing
foundryvtt-mcp status         # The shared process and where each setting comes from
foundryvtt-mcp stop           # Stop the shared process (the next call starts a new one)
foundryvtt-mcp --version      # The installed version

# Development (in a clone, see CONTRIBUTING.md)
npm run build                 # Build the project
npm run dev                   # Development mode
npm test                      # Run tests
npm run lint                  # Code linting
```

### Health Check Checklist
- [ ] FoundryVTT is running with an active world
- [ ] The configuration file has `FOUNDRY_URL`, `FOUNDRY_USERNAME`, `FOUNDRY_PASSWORD` (`foundryvtt-mcp status`, section *This terminal*)
- [ ] Username matches a FoundryVTT user exactly (case-sensitive)
- [ ] No firewall blocking connections
- [ ] `foundryvtt-mcp init --check` ends with `All checks passed.`
- [ ] `get_health_status` shows the connection and the module bridge connected
- [ ] Basic tools (dice rolling) work
- [ ] Search tools return expected results

### Essential URLs
Verify these work in your browser:
- FoundryVTT main: `http://localhost:30000`
- Join page (confirms active world): `http://localhost:30000/join`

Remember: most issues are configuration-related. `foundryvtt-mcp init --check` and `get_health_status` point at most of them.
