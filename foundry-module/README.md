# FoundryVTT MCP Bridge (Companion Module)

This is the companion FoundryVTT module for the [FoundryVTT MCP Server](https://github.com/G33ks/foundryvtt-mcp).

While the MCP server handles game-state reads and document mutations over Socket.IO, some features require access to the live browser runtime, PIXI canvas, or Foundry's internal JavaScript APIs:

- 📸 **Live Canvas Viewport Screenshots (`capture-scene`)**: `canvas.app.renderer.extract` captures the GM view with burned-in grid coordinates (`[col, row]`) for spatial AI reasoning.
- 🎲 **Interactive Chat Roll Cards (`roll-and-post`)**: evaluates `new Roll(formula).evaluate()` and posts authentic, clickable 3D-dice roll cards.
- 🎯 **Token Targeting & Canvas Pings (`set-target`, `get-targets`, `ping-canvas`)**: sets token targeting reticles, inspects connected users' target selections, and broadcasts animated camera pings to all players on the active scene.
- ⏸️ **Game Clock Controls (`set-pause`)**: pauses or resumes the game clock directly in the GM browser session.
- 📤 **Native FilePicker Asset Uploads (`upload-asset`)**: uploads images, maps, and audio directly via Foundry's internal `FilePicker.upload()` API.
- 📦 **Compendium Deep Search & Document Extraction (`search-compendium-content`, `get-compendium-document`)**: searches pack indices with regex text matching and extracts raw compendium documents for world imports.
- 📑 **DataModel Schema Introspection (`get-schema`)**: dynamically introspects `CONFIG.Actor.dataModels` and `CONFIG.Item.dataModels` for exact system field schemas and choices, computed (`persisted: false`) fields and number bounds; a type declared only by template.json gets its default values from `game.model`, with inferred types.
- 📊 **Prepared Actor Data (`get-actor-stats`, 0.6.0)**: reads an actor's prepared `system` — including the values the game system computes and never stores — for a world actor, a linked token, or an unlinked token's own synthetic actor, with optional dot paths and a size limit.
- 🩹 **System Status Effects (`toggle-status-effect`, 0.6.0)**: applies a status as `Actor#toggleStatusEffect` does, with the caller's creation options added (a game system may read one where it would otherwise ask the user), and removes it through `Actor#toggleStatusEffect`, so the game system recognises it as its own condition. Nobody can answer a dialog in the headless GM page: one rendered meanwhile is closed at once, and a status that could not be created because of it is reported with the dialog's title.

This module only activates its bridge connection for a **GM or Assistant-GM** user (`game.user.isGM`) — Foundry itself restricts canvas fog-of-war, `game.togglePause()`, and `FilePicker.upload()` to that permission tier. **You do not need to manually keep a GM browser tab open for this**: the MCP server automatically drives its own invisible background browser session logged in as your GM/Assistant-GM account, so a human can play as a normal Player in their own visible Foundry client while this module stays connected through that background session. That session is also the only place the module connects from: a GM tab opened by hand stays disconnected (see Security below), so keep the server's `FOUNDRY_HEADLESS_GM_ENABLED` at its default `true`.

---

## 📦 Installation in FoundryVTT

Requires FoundryVTT 13 or later (verified on 14).

1. In the **Setup** screen, open **Add-on Modules** → **Install Module**.
2. Paste the manifest URL into the **Manifest URL** field and click **Install**:

   ```
   https://raw.githubusercontent.com/G33ks/foundryvtt-mcp/main/foundry-module/module.json
   ```

3. Launch your FoundryVTT world.
4. Open **Game Settings** → **Manage Modules** and enable **FoundryVTT MCP Bridge**.

This manifest URL always describes the latest release; each release on GitHub (tag `bridge-vX.Y.Z`) also attaches its own `module.json` for installing that exact version.

### Updating

In the **Setup** screen, **Add-on Modules** → **Check for Updates** compares the installed version with the manifest URL and installs the newer release. Reload the world afterwards.

**A final release never replaces its own pre-release through Check for Updates.** Foundry compares versions part by part and ranks `0.5.1-rc.1` above `0.5.1`, so a world running `0.5.1-rc.1` reports the module as current when `0.5.1` is out. Use **Install Module** with the manifest URL above instead: installing by URL replaces the installed version whatever it is, and the world keeps the module enabled.

### Manual installation (advanced)

Copying this directory into FoundryVTT's `Data/modules/` folder, under the module id, still works — but Foundry can then neither check for updates nor reinstall the module, since the repository copy only gains a usable manifest through a release:

```bash
# Windows
cp -r foundry-module "%LOCALAPPDATA%/FoundryVTT/Data/modules/foundryvtt-mcp-bridge"

# macOS
cp -r foundry-module "~/Library/Application Support/FoundryVTT/Data/modules/foundryvtt-mcp-bridge"

# Linux
cp -r foundry-module "~/.local/share/FoundryVTT/Data/modules/foundryvtt-mcp-bridge"
```

To move from a manual copy to a release, move the copied folder out of `Data/modules` with the world shut down, then install by manifest URL.

---

## ⚙️ Module Settings

In FoundryVTT under **Configure Settings** → **Module Settings** → **FoundryVTT MCP Bridge**:

- **Bridge Port** (default: `31415`): fallback only. The MCP server's headless GM session tells the module which port it listens on (`FOUNDRY_MODULE_BRIDGE_PORT`); this setting is used only if it does not.

---

## 🔒 Security & Architecture

- The companion bridge communicates **strictly over local WebSocket (`ws://localhost:<port>`)**; the server listens on loopback only.
- The module connects only when the user is a GM / Assistant GM **and** the page exposes `window.foundryMcpBridge`, which only the foundryvtt-mcp headless GM session provides (a Playwright binding backed by the MCP server). Anywhere else — a GM tab opened by hand, any player's browser — it logs `no foundryvtt-mcp credentials in this browser, bridge disabled` once and never connects.
- **Mutual authentication (protocol v1, module 0.5.0+)**: the server only accepts the WebSocket from a page whose `Origin` is the Foundry URL, then sends a random challenge. The module answers with an HMAC-SHA256 proof computed by `window.foundryMcpBridge.prove()`, and executes no command and sends no event until the server's `auth_ok` carries the proof `prove()` predicted. The HMAC secret is random per server run and never leaves the server process: the page only ever sees nonces and proofs. On any mismatch the module closes the socket and retries with its usual reconnect backoff.
- Modules older than 0.5.0 are refused by current servers (they never answer the challenge; the server logs `likely an outdated foundryvtt-mcp-bridge module (< 0.5.0), redeploy it`). There is no compatibility mode.
- **Version and commands (0.6.0+)**: the module's `auth_response` also carries `module: {version, commands}` — its version and the commands it serves. The server sends no command the module does not announce; the field is not covered by the proofs and only decides what the server tries to send. Servers before 2.2.0 ignore it; a server from 2.2.0 sends a module that announces nothing only the commands every 0.5 module serves.
- Commands are scoped to safe, pre-defined handlers (`capture-scene`, `roll-and-post`, `search-compendium-content`, `get-compendium-document`, `get-schema`, `set-target`, `get-targets`, `get-actor-stats`, `toggle-status-effect`, `ping-canvas`, `set-pause`, `upload-asset`). No arbitrary `eval` is permitted.

---

## 🚀 Releasing (maintainers)

The module is released on its own tags, `bridge-vX.Y.Z`, independent of the server's `foundryvtt-mcp-vX.Y.Z` releases:

1. Bump `version` in `module.json` and set `download` to `https://github.com/G33ks/foundryvtt-mcp/releases/download/bridge-vX.Y.Z/foundryvtt-mcp-bridge.zip`. Keep `manifest` on the stable URL above; never point anything at `releases/latest`.
2. Optionally test a pre-release first: tag `bridge-vX.Y.Z-rc.N` and install it with the `module.json` attached to its release.
3. Merge to `main`, then tag `bridge-vX.Y.Z` on `main` and push the tag.

`.github/workflows/bridge-release.yml` then runs `scripts/package-bridge.js`. It checks that the tag's base version (without `-rc.N`) equals `module.json`'s version, and for a final tag that the committed `download` points at that tag. It writes the release `module.json` (exact tag version, that tag's `download`), builds `foundryvtt-mcp-bridge.zip` (`module.json` at the root, `scripts/`, `README.md`, `LICENSE`) and creates the GitHub release, as a pre-release when the tag contains `-`.

If the workflow cannot run, build the same attachments locally and create the release with `gh` (or attach both files by hand in GitHub's release form):

```bash
npm run bridge:package -- --tag bridge-vX.Y.Z-rc.N
gh release create bridge-vX.Y.Z-rc.N build/bridge-release/module.json build/bridge-release/foundryvtt-mcp-bridge.zip --repo G33ks/foundryvtt-mcp --verify-tag --latest=false --prerelease --title "FoundryVTT MCP Bridge X.Y.Z-rc.N"
```

Drop `--prerelease` for a final tag.
