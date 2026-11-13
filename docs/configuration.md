# Configuration

Every MCP client on a computer shares one configuration file. `foundryvtt-mcp init` writes it for you, checking each answer against your FoundryVTT; this page is for reading it, changing it by hand, and the settings `init` does not ask about.

## The configuration file

| System | Location |
| :--- | :--- |
| Windows | `%LOCALAPPDATA%\foundryvtt-mcp\config.env` |
| macOS, Linux | `$XDG_CONFIG_HOME/foundryvtt-mcp/config.env`, or `~/.config/foundryvtt-mcp/config.env` |

Two settings move it, and can only come from the environment or a `.env` file (the file cannot say where the file is):

- `FOUNDRY_MCP_CONFIG` names another file, and wins over everything.
- `FOUNDRY_MCP_STATE_DIR` names another state directory; the file is then `<that directory>/config.env`. A fully separate setup, with its own pipe or socket, logs and token: use it for tests.

The format is one `KEY=value` per line, with the names of the settings below; `#` starts a comment:

```env
FOUNDRY_URL='https://foundry.example.com'
FOUNDRY_USERNAME='mcp-api'
FOUNDRY_PASSWORD='a long password used nowhere else'
FOUNDRY_WRITE_ENABLED='true'
FOUNDRY_MODULE_BRIDGE_ENABLED='true'
```

- **Quote every value** between `'…'`, or between `` `…` `` if it contains an apostrophe. Unquoted, a `#` cuts the value (the rest becomes a comment) and surrounding spaces are dropped. Nothing is escaped inside quotes.
- **True means `true`**: a yes/no setting is on only when its value is exactly `true` (`TRUE` or `yes` count as off), except `FOUNDRY_MCP_SHARED`, which is on unless it is exactly `false`.
- **Passwords are stored in clear.** Keep the file to your own user: on macOS and Linux the server warns when other users may read it (`chmod 600` the file). Passwords and the API key never appear in the logs or in `status`, which shows `<set>`.

`foundryvtt-mcp init --check` re-runs the checks on the file as it is, without asking or writing anything.

## Where each setting comes from

Each setting is looked up on its own, and the first place that defines it wins:

1. the environment: the MCP client's `env` block, or the system environment;
2. a `.env` file in the working directory (for development);
3. the configuration file;
4. the default.

`foundryvtt-mcp status` shows the file it found and where each setting comes from.

Keep the settings in the file. Claude desktop starts servers with a few Windows variables only and `C:\Windows\System32` as the working directory, so a system variable or a `.env` file has no effect there; Claude Code passes its whole environment, so a `FOUNDRY_*` variable set system-wide does reach it. Avoid `FOUNDRY_*` variables at the system level.

## Settings

| Setting | Default | What it does |
| :--- | :--- | :--- |
| `FOUNDRY_URL` | none: required | The address you open FoundryVTT with in your browser, with `http://` or `https://`. |
| `FOUNDRY_USERNAME` | none: required | The FoundryVTT user the connector logs in as. An **Assistant GM** account of its own is recommended (see [Security](security.md)). |
| `FOUNDRY_PASSWORD` | none: required | That user's password. |
| `FOUNDRY_WRITE_ENABLED` | `false` | `true` lets the tools change the world. While it is off, every tool that changes the world is refused. |
| `FOUNDRY_MODULE_BRIDGE_ENABLED` | `false` | `true` turns on the companion module's tools (canvas capture, native rolls, compendium documents, uploads…) and the invisible GM session that hosts the module. `init` always writes `true`. |
| `FOUNDRY_MODULE_BRIDGE_PORT` | `31415` | The loopback port the companion module connects to. |
| `FOUNDRY_HEADLESS_GM_ENABLED` | `true` | The invisible GM session, started only when the module bridge is on. The module connects only from this session: `false` turns the module's tools off in practice, and a warning is logged at startup. |
| `FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH` | detected | The Chromium-based browser the invisible session runs; see [Choosing the browser](#choosing-the-browser). |
| `FOUNDRY_HEADLESS_GM_USERNAME` | none | Advanced: another account for the invisible session, which then logs in through FoundryVTT's login page. Unset, or equal to `FOUNDRY_USERNAME`, the session shares the connector's own login. |
| `FOUNDRY_HEADLESS_GM_PASSWORD` | `FOUNDRY_PASSWORD` | That other account's password. |
| `FOUNDRY_API_KEY` | none | Key of the optional REST API module; see [The optional REST API module](#the-optional-rest-api-module). |
| `FOUNDRY_DATA_PATH` | none | FoundryVTT's `Data` folder, when the connector runs on the same computer as FoundryVTT. It lets `list_scene_assets` browse the art and audio there, and `create_scene` and `create_tile` read an image's size from disk. |
| `FOUNDRY_UPLOAD_SOURCE_DIR` | none | The one folder `upload_asset` may read a local file from (its `sourcePath` argument). Unset, `upload_asset` takes file content sent by the AI client only. |
| `FOUNDRY_EVENT_BUFFER_SIZE` | `500` | How many events `watch_events` keeps in memory. |
| `FOUNDRY_EVENT_WAIT_MS` | `25000` | How long `watch_events` waits for a new event by default, in milliseconds. |
| `FOUNDRY_MCP_IDLE_TIMEOUT_MINUTES` | `5` | How long the shared process stays up once no MCP client is connected; it then leaves FoundryVTT and exits. `0` = never. |
| `FOUNDRY_MCP_SHARED` | `true` | `false` makes every client start its own complete server (own connection, module bridge and browser) instead of sharing one. Two of them cannot use the module bridge at once, since they would compete for its port. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `FOUNDRY_MCP_STATE_DIR` | see [Architecture](architecture.md#the-state-directory) | Another state directory (environment or `.env` only). |
| `FOUNDRY_MCP_CONFIG` | see above | Another configuration file (environment or `.env` only). |

### Advanced settings

Rarely needed; leave them out unless you know why you need one.

| Setting | Default | What it does |
| :--- | :--- | :--- |
| `FOUNDRY_USER_ID` | none | The user's 16-character document id, used instead of looking the name up. Also accepted in place of `FOUNDRY_USERNAME`. |
| `FOUNDRY_SOCKET_PATH` | `/socket.io/` | The Socket.IO path on the FoundryVTT server, for a reverse proxy that moves it. |
| `FOUNDRY_TIMEOUT` | `10000` | Time limit, in milliseconds, for one request to FoundryVTT, over Socket.IO or to the REST API module. |
| `FOUNDRY_RETRY_ATTEMPTS` | `3` | Retries of a failed request to the REST API module (`0` counts as the default). |
| `FOUNDRY_RETRY_DELAY` | `1000` | Base delay between those retries, in milliseconds. |
| `MCP_SERVER_NAME` | `foundryvtt-mcp` | The name the server gives MCP clients. |
| `NODE_ENV` | `development` | `development`, `production` or `test`. With `production`, a `localhost` `FOUNDRY_URL` logs a warning. |

## Changing a setting

After editing the file, run `foundryvtt-mcp stop`: the next tool call starts the shared process again with the new settings. A client whose relay was still waiting for a configuration needs nothing; its next call reads the file.

The shared process serves every client with one configuration, and **the file is authoritative**:

- Some settings define the connection: `FOUNDRY_URL`, `FOUNDRY_USERNAME`, `FOUNDRY_PASSWORD`, `FOUNDRY_USER_ID`, `FOUNDRY_API_KEY`, `FOUNDRY_SOCKET_PATH`, `FOUNDRY_WRITE_ENABLED`, the `FOUNDRY_MODULE_BRIDGE_*` and `FOUNDRY_HEADLESS_GM_*` settings, `FOUNDRY_DATA_PATH` and `FOUNDRY_UPLOAD_SOURCE_DIR`. When a client starts with these settings as the file now has them, and the running shared process was started with others, the shared process lets running calls finish and starts again, once, with the file's settings.
- A client that still passes different values in its own `env` block is served with the running configuration, never restarted: its first tool result names the settings it passed that are ignored, and `status` lists them.
- The other settings (`LOG_LEVEL`, timeouts, the idle delay, the event log) never cause a restart: the shared process keeps its own.

## Choosing the browser

The invisible GM session runs a Chromium-based browser in the background; you never see it. Without `FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH`, the server looks at the usual install locations for Google Chrome, then Microsoft Edge, Brave, Vivaldi, a system Chromium, and last Playwright's own Chromium (only present after `npx playwright install chromium`), and uses the first one that starts. `status` and the health check show which one, marked `detected`.

To choose another Chromium-based browser, or one installed elsewhere, name its program; it is then used with no fallback (`configured`):

```env
FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH='C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe'
```

In a JSON `env` block instead, double each Windows backslash, or write forward slashes.

## The optional REST API module

`FOUNDRY_API_KEY` connects the server, alongside Socket.IO, to the **Foundry Local REST API** module, a separate project not distributed here (and not the companion module). It is needed by `get_recent_logs`, `search_logs`, `get_system_health`, `diagnose_errors` and `search_compendium`; with a key set, a few reads ask it first, and `roll_dice` rolls with FoundryVTT's own engine. Socket.IO stays the main connection and carries every write. Without the key, the diagnostics tools are unavailable and `search_compendium` returns no results; `search_compendium_content`, through the companion module, searches compendiums without it.
