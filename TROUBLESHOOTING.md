# FoundryVTT MCP Troubleshooting Guide

This guide helps you diagnose and resolve common issues with the FoundryVTT MCP server.

## Quick Diagnostics

### Setup Wizard (Recommended for New Users)
```bash
npm run setup-wizard
```
The interactive setup wizard will detect your FoundryVTT installation and guide you through configuration.

### Health Check
```bash
# Test connection directly:
npm run test-connection

# Or use the MCP tool for comprehensive diagnostics (requires REST API module):
# In your AI client, run: get_health_status
```

### Check Current Status
The server provides detailed diagnostics on startup. Look for:
- Connection status
- Authentication method and status
- World data loading confirmation
- Feature availability summary

## Common Issues

### Connection Issues

#### "Connection Refused" or "ECONNREFUSED"
**Symptoms**: Cannot connect to FoundryVTT server
**Solutions**:
1. **Start FoundryVTT**: Ensure FoundryVTT is running and accessible
2. **Check URL**: Verify `FOUNDRY_URL` in your `.env` file
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
1. **Increase timeout**: Add to `.env`:
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
3. **Active sessions**: Check if the user already has an active session (some configurations limit concurrent sessions)
4. **Debug logging**: Set `LOG_LEVEL=debug` to see the full authentication flow

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
- **An open editor's autosave** — while a text page is open in a FoundryVTT editor, the server keeps its own copy of the page and saves it every `core.editorAutosaveSecs` (60 s by default), **even if nobody types**. A connector write never reaches that copy, so the next autosave reverts it. Reason: `overwritten-by-editor-autosave` (FoundryVTT does not say who is editing). A page autosaved in the last 10 minutes is flagged in the write response: close the editor before writing, or write after the session.
- **A change that crossed the connector's write** — someone saved the page between the connector's read-back and its write; the connector's write replaced it. Reason: `overwritten-by-connector`; the copy holds *their* version.

Detection compares paragraphs of text, not HTML, so markup rewritten by FoundryVTT or the editor does not count as a loss. Changes made by the connector's own accounts (`FOUNDRY_USERNAME` and the headless GM user) are never reported.

**Where the copies are**: in the state directory (see [Shared Process](#where-are-the-logs)), under `journal-history\<journalId>\<pageId>\`. Each copy is a `<time>-<reason>.html` file — the page body exactly as stored — with a `.json` next to it: entry and page names, reason, version token, `overwrittenBy` (who replaced that version, or is about to: a user name, the connector account for its own writes, or `editor-autosave (unknown user)`), `versionBy` (whose version an overwrite copy holds), `connectorAccount` and the date. A copy is written before every page write (`before-replace`, `before-append`) and for every detected overwrite; a page write is refused if its copy cannot be written. Each page keeps its 20 most recent copies, none older than 30 days. `get_health_status` prints the folder; `daemon.log` records ids, version tokens and copy paths, never page text.

**Restoring by hand**:
1. Find the copy: the path is in the warning, the whisper and `get_health_status`, or sort the page's folder by name (the newest is last).
2. Check it: open the `.html` file in a text editor (or a browser) and compare it with the page in FoundryVTT. Make sure nobody has the page open in an editor.
3. Put it back: in FoundryVTT, open the page, switch the editor to its HTML source view, replace the content with the copy's content and save. Or ask the assistant to read the copy and rewrite the page with `get_journal` `raw: true` followed by `update_journal_page` (replace, with the version just read). That rewrite itself saves a `before-replace` copy of what it replaces.

#### Module Bridge Never Connects / "WebSocket ... failed"
**Symptoms**: `get_health_status` keeps reporting the module bridge as disconnected (canvas tools such as `capture_scene` say no module is connected), even though the server logs `Module bridge listening on ws://localhost:31415` and the GM session is logged in. The browser console of the GM tab shows `WebSocket connection to 'ws://localhost:31415/' failed`, with no further detail.

**Cause**: The companion module runs inside the Foundry page, served from `FOUNDRY_URL`, and dials the bridge on `localhost`. When Foundry is reached through a public address, recent Chromium-based browsers treat this as a public site reaching into the local machine and block it: Chromium's Local Network Access (formerly Private Network Access) asks for a permission first, and Brave adds its own "localhost access" permission. Until that permission is granted the connection is refused silently.

**Solutions**:
1. **Automatic headless GM session**: Nothing to do — the server launches its headless browser with these checks disabled (a throwaway browser with a fresh profile that only loads `FOUNDRY_URL`). If it still fails, look for errors in the server logs (`daemon.log` in shared-process mode), in particular `Module bridge refused a connection: …` (see [below](#module-bridge-refused-a-connection-)).
2. **GM tab opened by hand**: no longer supported. Since module 0.5.0 the module only connects from the headless GM session, which provides the `window.foundryMcpBridge` function it authenticates with; `FOUNDRY_HEADLESS_GM_ENABLED=false` therefore disables the bridge in practice. In an ordinary GM tab, the browser console line `FoundryVTT MCP Bridge | no foundryvtt-mcp credentials in this browser, bridge disabled` is normal — that tab is not meant to connect.
3. **Check the bridge itself**: If the server log has no `Module bridge listening` line, the port may already be in use or `FOUNDRY_MODULE_BRIDGE_ENABLED` is `false`. In shared-process mode that log is `daemon.log` (see [Shared Process](#shared-process)); `node dist/index.js status` shows whether the bridge listens and whether the module is connected. The port is typically held by another process running in all-in-one mode (`FOUNDRY_MCP_SHARED=false`), or by a shared process from a second state directory.
4. **Bridge reached from another machine**: The bridge listens on loopback only (`127.0.0.1`, `::1`). The module must run in a browser on the same machine as the MCP server — which the headless GM session always does.

#### "Module bridge refused a connection: …"
**Symptoms**: The server log (`daemon.log` in shared-process mode) shows `Module bridge refused a connection: <reason>`, and the module bridge stays disconnected — or stays connected, if the refused client was not the module.

**Cause**: The bridge port is reachable by every local process and every page open in a local browser, so the bridge only accepts the companion module (0.5.0 or later) running in the headless GM session, after a mutual authentication (see the README, [Module Bridge Security](README.md#module-bridge-security)). Any other client is refused, and the refused connection never affects the connected module. At most 10 refusals are logged per minute; the rest are summarised as `N more refused connection(s) not logged in the last minute`.

**Reasons**:
- **`unexpected Origin`** (with the `origin` received): the WebSocket did not come from a page served at `FOUNDRY_URL`'s origin. If it is the module, the address the headless browser loaded does not match the origin of `FOUNDRY_URL` exactly — scheme (`http`/`https`), host (IP address vs domain name, `localhost` vs `127.0.0.1`) and port must all be identical; fix `FOUNDRY_URL`. Otherwise it is a foreign page or program (origin `(none)` for a non-browser client), and the refusal is expected.
- **`client did not authenticate within 5000 ms; likely an outdated foundryvtt-mcp-bridge module (< 0.5.0), redeploy it`**: the client opened the socket from the right origin but never authenticated. Usually the installed module is older than 0.5.0 — copy `foundry-module` into `Data/modules/foundryvtt-mcp-bridge` again (see [SETUP_GUIDE.md](SETUP_GUIDE.md#3-install-companion-module-foundryvtt-mcp-bridge)) and reload the world. Otherwise, a foreign client.
- **`wrong authentication proof`**: the client answered with a proof that does not match this server's secret — a foreign client. The module in the headless session always computes the right proof, since the secret lives in the same process.
- **`unsupported bridge protocol … (expected 1)`**: a module speaking another version of the handshake. Install the module from the same checkout as the server.
- **`non-JSON message before authentication`**, **`message other than auth_response before authentication`**, **`malformed auth_response`**, **`message over 4096 bytes before authentication`**: the client sent something other than the module's handshake — a foreign client, or a module copy that does not match the server. Redeploy the module from the same checkout if the bridge stays disconnected.

**Check it**: `node dist/index.js status` shows the `Module bridge:` line (`protocol v1, authenticated module connected: yes/no`) and the `Bridge origin:` line, the only origin accepted — compare it with the address Foundry is served from. With the module connected, `npm run check:bridge-security` makes four forged connections and confirms each one is refused while the module stays connected.

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

`node dist/index.js status` prints the paths actually in use. Set `LOG_LEVEL=debug` in the client's `env` block for more detail (it applies to the shared process started next).

#### Inspecting and stopping the shared process
```bash
node dist/index.js status   # running?, pid, uptime, FoundryVTT / bridge / GM session, relays, write queue
node dist/index.js stop     # lets running calls finish, then exits (waits up to ~2.5 min)
```
`status` exits with code 3 when nothing runs. If `stop` cannot reach the process (for example after the `token` file was deleted), end the pid listed in `daemon.json` — Task Manager, `Stop-Process -Id <pid>` (PowerShell) or `kill <pid>`. The next tool call starts a fresh one.

#### Checking the pipe
- **Windows** (PowerShell): `Get-ChildItem \\.\pipe\ | Where-Object Name -like 'foundryvtt-mcp*'` lists `foundryvtt-mcp-<user>` while the shared process runs. A name with an extra `-xxxxxxxx` suffix belongs to a non-default `FOUNDRY_MCP_STATE_DIR` (the stress script uses one).
- **Linux/macOS**: `ls -l ~/.local/state/foundryvtt-mcp/daemon.sock` (a socket left by a crash is detected and replaced automatically; very deep state directories fall back to `$TMPDIR/foundryvtt-mcp-<user>/daemon.sock`).

#### "The shared process could not connect to FoundryVTT: …"
FoundryVTT is not reachable yet, or the URL/credentials are wrong. The shared process stays up and retries on the next call: start FoundryVTT and call the tool again. The message carries the underlying error; `daemon.log` has the details.

- **`getJoinData returned no users`**: FoundryVTT is running but no world is launched — it shows the Setup screen, typically after the Foundry server restarted (or a backup restarted it). Launch the world from the Setup screen, then call a tool again. The module bridge and the headless GM session only start once this connection succeeds, so meanwhile `node dist/index.js status` shows the headless GM session as `Logging in…`.

#### "The shared FoundryVTT MCP process did not become available within 30 s"
The relay started a shared process that never answered. Look at the end of `daemon.log`: a configuration error, a crash at startup, or an antivirus blocking `node.exe`. Running `node dist/index.js daemon` by hand in a terminal with the same environment shows startup errors directly.

#### "The shared FoundryVTT MCP process exited during this call; its outcome is unknown"
The shared process died (or was killed) while it ran the call. The call is **not** resent automatically: for a write, check in FoundryVTT whether it happened before retrying. The next call starts a new shared process.

#### "refused this relay (unauthorized …)"
The `token` file changed while a shared process was running (deleted or edited by hand). End the shared process (see above); the next call starts one with the current token.

#### The shared process keeps restarting / FoundryVTT reconnects often
`daemon.log` shows `a relay with a different config connected` (or `version`): two MCP clients pass different settings (another `env` block, another `LOG_LEVEL`, an extra variable…) or run different versions of the server, and each one restarts the shared process with its own. Give every client the same `env` block and the same build, or set `FOUNDRY_MCP_SHARED=false` for one of them. After updating or rebuilding the server, restart your MCP clients so that all relays run the new build.

#### Configuration in `.env` ignored with Claude Desktop
Claude Desktop starts MCP servers in `C:\Windows\System32`, where no `.env` file is looked up. Put the configuration in the `env` block of `claude_desktop_config.json`. A `.env` file is only read from the working directory of the process (handy for Claude Code or a terminal started in the repository).

#### Diagnostics Tools Not Working
**Symptoms**: Health monitoring and log tools fail
**Solutions**:
1. **REST API module required**: These 5 tools require the optional Foundry Local REST API module
2. **Install module**: Download from FoundryVTT's module browser
3. **Enable module**: Activate it in your world's module settings
4. **Set API key**: Add `FOUNDRY_API_KEY` to your `.env` file
5. **Update module**: Ensure you have the latest version (v0.8.1+)

## Environment Configuration

### .env File Template
```env
# Required
FOUNDRY_URL=http://localhost:30000
FOUNDRY_USERNAME=your_username
FOUNDRY_PASSWORD=your_password

# Optional: Direct user ID bypass
# FOUNDRY_USER_ID=abc123def456ghij

# Optional: Diagnostics (requires REST API module)
# FOUNDRY_API_KEY=your_api_key_here

# Optional Settings
FOUNDRY_TIMEOUT=10000
FOUNDRY_RETRY_ATTEMPTS=3
FOUNDRY_RETRY_DELAY=1000
LOG_LEVEL=info
```

### Configuration Validation
Run the setup wizard to validate your configuration:
```bash
npm run setup-wizard
```

## Advanced Diagnostics

### Enable Debug Logging
Add to your `.env` file:
```env
LOG_LEVEL=debug
```
This provides detailed logs including the full Socket.IO authentication flow.

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
- `get_health_status` - Comprehensive diagnostics (requires REST API module)

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
   npm run test-connection
   ```

2. **Gather information**:
   - Your `.env` configuration (redact sensitive values)
   - MCP server logs (with `LOG_LEVEL=debug`)
   - FoundryVTT version and active modules
   - Error messages and stack traces

3. **Report the issue**: [GitHub Issues](https://github.com/laurigates/foundryvtt-mcp/issues)

### Community Support
- **Discord**: Join the FoundryVTT community
- **Reddit**: r/FoundryVTT
- **Forums**: FoundryVTT community forums

## Quick Reference

### Common Commands
```bash
# Setup and configuration
npm run setup-wizard          # Interactive setup
npm run test-connection       # Test connectivity
npm run build                 # Build the project
npm start                     # Start the MCP server

# Development
npm run dev                   # Development mode
npm test                      # Run tests
npm run lint                  # Code linting
```

### Health Check Checklist
- [ ] FoundryVTT is running with an active world
- [ ] `.env` file exists with `FOUNDRY_URL`, `FOUNDRY_USERNAME`, `FOUNDRY_PASSWORD`
- [ ] Username matches a FoundryVTT user exactly (case-sensitive)
- [ ] No firewall blocking connections
- [ ] MCP server starts without errors
- [ ] World data loads on connect (check startup logs)
- [ ] Basic tools (dice rolling) work
- [ ] Search tools return expected results

### Essential URLs
Verify these work in your browser:
- FoundryVTT main: `http://localhost:30000`
- Join page (confirms active world): `http://localhost:30000/join`

Remember: Most issues are configuration-related. The setup wizard and health diagnostics can resolve most common problems!
