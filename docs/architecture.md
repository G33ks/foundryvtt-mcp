# Architecture

How the connector is built, for those who want to know what runs where. Installing and using it needs none of this.

![On your computer, each AI client starts a relay over MCP stdio; the relays hand their requests through a named pipe or Unix socket to one shared process. That process reads and writes the FoundryVTT world over Socket.IO, optionally queries the REST API module over HTTP, and launches an invisible GM browser that loads the game page; the companion module in that page talks to the shared process over an authenticated loopback WebSocket bridge.](assets/how-it-works.png)

<sub>Diagram source: [assets/how-it-works.mmd](assets/how-it-works.mmd) (Mermaid).</sub>

## Relays and the shared process

An MCP client starts the connector as a program it talks to over standard input and output. Some clients start several at once, and several clients may run together, so each of these programs is only a light **relay**: it answers the client's `initialize` and `tools/list` at once, and forwards tool calls and resource reads to one **shared process** (`foundryvtt-mcp daemon`). The shared process holds what must exist once: the FoundryVTT connection, the world cache, the module bridge and the invisible GM session.

- **Start**: the first relay that finds no shared process starts one in the background, detached so that it outlives the client, and waits for it, up to about 30 seconds. Relays started together end up sharing a single process. A relay connects as soon as it starts, so the connection to FoundryVTT is ready before the first call.
- **Access**: relays reach it through a named pipe (`\\.\pipe\foundryvtt-mcp-<user>` on Windows) or a Unix socket in the state directory, and must present the per-user token stored there.
- **Lifetime**: it stays up while at least one relay is connected, however long without calls. It exits `FOUNDRY_MCP_IDLE_TIMEOUT_MINUTES` (5 by default) after the last relay leaves, on `foundryvtt-mcp stop`, when a relay of a newer build connects, or when the configuration file changed as described in [Configuration](configuration.md#changing-a-setting). It then lets running calls finish first.
- **FoundryVTT not reachable**: the shared process stays up, returns the error to the call, and tries again on the next one, so FoundryVTT and the AI client can start in any order.
- **All-in-one mode**: with `FOUNDRY_MCP_SHARED=false`, each client's program does everything itself, with no relay and no shared process.

`foundryvtt-mcp status` shows the shared process (id, version, uptime, relays, calls running, FoundryVTT connection, module bridge, GM session, settings and their sources), and `foundryvtt-mcp stop` stops it. Both only read the state directory: they need no configuration.

### The state directory

`%LOCALAPPDATA%\foundryvtt-mcp\` on Windows, `$XDG_STATE_HOME/foundryvtt-mcp/` (or `~/.local/state/foundryvtt-mcp/`) elsewhere, or the folder named by `FOUNDRY_MCP_STATE_DIR`. It holds:

- `token`, the access token relays present;
- `daemon.json`, the shared process's state;
- `daemon.log` and `relay.log`, rotated at 5 MB, three files kept;
- `journal-history/` and `journal-conflicts.json` (see [Journal pages](#journal-pages));
- on Windows, and in a `FOUNDRY_MCP_STATE_DIR`, the configuration file `config.env`.

On macOS and Linux, a state directory whose path is too long for a Unix socket gets its socket in a private folder under the system's temporary directory instead.

## The connection to FoundryVTT

The shared process logs in as `FOUNDRY_USERNAME` the way a player's browser does, then opens a Socket.IO connection. That connection carries every read of the world and every write.

- **World cache**: on connecting, the connector loads the whole world and keeps it in memory. FoundryVTT broadcasts every change to its clients (`modifyDocument`, and `modifyDocumentBatch` for changes with side effects), whoever made it: the connector applies each one, so reads are instant and current. `refresh_world_data` reloads everything.
- **Reconnection**: when FoundryVTT forgets the session (server restart, world shut down), the connector logs in again by itself, retrying every 5 seconds at first and at most every 2 minutes. A tool that needs the connection waits up to 15 seconds for it, then is refused with the reason.
- **Writes**: a tool that changes the world is refused unless `FOUNDRY_WRITE_ENABLED=true`. Writes run one at a time, in the order they arrive; reads run in parallel. FoundryVTT itself checks the account's permission on each document.

### Journal pages

A journal page is written from its current text on the server, never from the cache. Adding to a page appends to that text; replacing a page needs the version token that `get_journal` with `raw: true` prints, and is refused if the page changed since. Before each write the connector keeps a local copy of the previous text (20 per page, 30 days, in `journal-history/`), and it watches the page afterwards: an open FoundryVTT editor that saves an older text over it is detected, reported in the next tool result and in the health check, whispered to the GMs, and listed for 24 hours in `journal-conflicts.json`. [TROUBLESHOOTING.md](../TROUBLESHOOTING.md#a-journal-edit-was-overwritten) explains how to restore a page.

## The invisible GM session

Some things only a real FoundryVTT page can do: capturing the canvas, rolling dice with FoundryVTT's own engine, reading compendium documents, uploading files, pausing the game. For those, the shared process runs a Chromium-based browser in the background, through `playwright-core`, and opens the game in it.

- It shares the connector's own login: one account, one session. FoundryVTT keeps several connections per session, so neither replaces the other.
- It stays on the game page: a navigation elsewhere, such as **Log Out**, is blocked and the page reloads the game, since leaving would log the shared session out.
- A watchdog checks every 20 seconds that the companion module is connected, and reloads the page after about a minute without it.
- `FOUNDRY_HEADLESS_GM_USERNAME` naming another account gives the page a login of its own instead.

## The companion module and the bridge

The companion module (`foundryvtt-mcp-bridge`) runs only in that invisible session and connects to the shared process over a WebSocket on the loopback interface (`127.0.0.1` and `::1`, port `FOUNDRY_MODULE_BRIDGE_PORT`). The two sides prove their identity to each other before any command, as [Security](security.md#the-module-bridge) describes.

From version 0.6.0 the module announces its version and the commands it serves when it connects; the connector sends it no command it did not announce. An older module is sent only the commands every 0.5 version serves, and a newer command is refused at once with a clear message. A tool that needs the module waits up to 10 seconds for one still connecting. Without the module, those tools say they are unavailable and everything else keeps working.

## The optional REST API module

With `FOUNDRY_API_KEY` set, the connector also talks over HTTP to the Foundry Local REST API module, a separate project: see [Configuration](configuration.md#the-optional-rest-api-module).

## Errors

A tool call that fails returns a result marked `isError: true`, so the AI reads why: invalid or missing arguments, FoundryVTT not reachable or reconnecting, no active world, a request that took too long, a refusal (writes disabled, an outdated journal page version, a command the module does not serve), or an error from FoundryVTT or the module. Its text starts with one `MCP error <code>: ` prefix carrying a JSON-RPC code, most often `-32602` (invalid parameters), `-32600` (refused) or `-32603` (failed); the code is a hint, not an exact classification of the cause. The same call gives the same text through a relay and all-in-one.

These remain JSON-RPC errors, which the MCP client shows with its own `MCP error <code>: ` prefix: an unknown tool, a malformed request, and a failed resource read (`resources/read` has no `isError` in MCP). A tool called while the configuration is missing or invalid returns an `isError` result whose text is the configuration message alone, without a prefix.

## Design records

The decisions behind this design are kept in [docs/adrs](adrs/README.md) and [docs/blueprint](blueprint/README.md).
