# Security

What the connector can do in your world, what it keeps on your computer, and how to keep both under control. To report a vulnerability, see [SECURITY.md](../SECURITY.md): never in a public issue.

## What the connector can do

The connector acts in FoundryVTT as the account you give it, with that account's permissions, at the request of your AI client. Its reach is set by three things:

- **The account's role.** Use an account of its own, with the **Assistant GM** role and a long password used nowhere else. An Assistant GM can edit most of the world but cannot grant the Gamemaster role or change the world's permission settings; the connector refuses both and tells the AI to leave them to you. A Gamemaster account works, but its invisible session could then become the world's active GM in your place; `status` and the health check warn about it.
- **`FOUNDRY_WRITE_ENABLED`.** Off by default. While it is off, every tool that changes the world is refused before anything reaches FoundryVTT or the companion module: documents, chat messages and rolls, targets, pings, the pause, file uploads. `init` asks whether to turn it on.
- **Your MCP client.** It decides which tools the AI may call, and most clients ask before each call or let you allow or deny tools one by one. The descriptions of destructive tools ask the AI to confirm the target with you first; the connector cannot enforce that.

Some changes are refused whatever the settings: the `core.*` world settings, which control the FoundryVTT client itself, and lowering the connector's own role below Assistant GM. FoundryVTT itself checks the account's permission on each document.

An AI decides which tools to call from what it reads, and text in the world (chat messages, journal pages, compendium content) can try to steer it. Keep writes off when you do not need them, and keep your client's confirmations on for tools that change the world.

## Files on your computer

- **The configuration file** holds the FoundryVTT password, and the REST API key if you use one, in clear. Keep it to your own user: on macOS and Linux the server warns when other users may read it (`chmod 600` it). Passwords and keys never appear in the logs or in `status`.
- **The state directory** ([Architecture](architecture.md#the-state-directory)) holds the access token relays present to the shared process, the logs, and local copies of the journal pages the connector changed (their text, for 30 days). The logs record each tool call with its short arguments; the content of journal pages, chat messages and macros, and any long text, is replaced by its length.
- **Local files the connector reads**: with `FOUNDRY_DATA_PATH`, files under that folder only (asset lists and image sizes). With `FOUNDRY_UPLOAD_SOURCE_DIR`, `upload_asset` may read a file from that folder only, after resolving links, and only a media file (images, audio, video) of at most 8 MiB; unset, it reads no local file. Its destination stays a folder inside FoundryVTT's `Data` storage, with a plain file name and the same media type.

## The module bridge

The bridge drives a GM session, and its port is reachable by every program on the computer and by every page open in a local browser. So the connector and the companion module authenticate each other, with nothing to configure:

- **Loopback only**: the bridge listens on `127.0.0.1` and `::1`.
- **Origin**: the WebSocket upgrade is refused unless it comes from a page of `FOUNDRY_URL`.
- **Mutual proof**: the connector sends a random challenge; the module answers with an HMAC-SHA256 proof, and the connector answers with its own, which the module checks before obeying. Both are keyed by a random secret the shared process creates at startup and keeps in memory only: never written to disk, logged or returned by a tool. The invisible session gives its page a function that computes the proofs, so the secret never enters the page or the WebSocket.
- **Until authenticated**, a connection receives no command, nothing it sends is processed, and it cannot displace the connected module. It is closed on a wrong proof, an unknown protocol, a message over 4 KiB, or no answer within 5 seconds; refusals are logged.
- **No GM tab of your own**: a FoundryVTT tab you open yourself has no such function, so the module stays silent there and logs `no foundryvtt-mcp credentials in this browser, bridge disabled` in the browser console.

From a clone of the repository, `npm run check:bridge-security` tries four forged connections against a running connector and confirms each is refused while the module stays connected.

## The invisible GM session

The browser the session runs starts with a fresh, empty profile each time and only ever loads `FOUNDRY_URL`. It is launched with Chromium's local network access checks turned off, so that the module, served from FoundryVTT's address, can reach the bridge on `localhost`; your own browser keeps its protections.

## Recommendations

- An **Assistant GM** account of its own for the connector, with a long password used nowhere else.
- **Writes off** unless you need them; your MCP client's confirmations on.
- A **backup of your world** before letting an AI change it, and a test world to try things first.
- The configuration file **readable by you only**.
- **Close a journal page in FoundryVTT before the AI writes to it**: an open editor's autosave can overwrite the AI's change. The connector detects it and keeps a copy, but cannot prevent it.
- **One connector per computer**: two would compete for the bridge's port.
