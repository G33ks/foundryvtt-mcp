/**
 * @fileoverview What `init` prints for the user to paste into their MCP clients.
 *
 * No `env` block: every setting lives in the shared configuration file.
 * Both clients get absolute paths, of Node and of `dist/index.js`: an MCP
 * client may start servers with a reduced PATH (macOS, nvm) and an
 * undefined working directory.
 */

import { packageName } from '../shared/version.js';

/** Server name in both clients. */
export const SERVER_NAME = 'foundryvtt';

/** The package's `bin` name, on the PATH after `npm install -g`. */
const BIN_NAME = 'foundryvtt-mcp';

/**
 * Where the running `dist/index.js` comes from:
 * - `npx`: npx's cache (`…/_npx/<hash>/node_modules/…`), which npm updates
 *   or cleans at will — no path in it is worth handing to a client;
 * - `global`: an installed package (`…/node_modules/…`);
 * - `clone`: anything else, a clone built in place.
 */
export type InstallKind = 'npx' | 'global' | 'clone';

export function installKind(entry: string): InstallKind {
  // Both separators: the same rules apply to Windows and POSIX paths.
  const segments = entry.split(/[\\/]/);
  if (segments.includes('_npx')) {
    return 'npx';
  }
  return segments.includes('node_modules') ? 'global' : 'clone';
}

/**
 * How to run the connector from a terminal, for the commands `init` prints:
 * the `bin` name for a global install, `npx <package>` from npx's cache,
 * otherwise `node "<entry>"`, which works from any folder after a clone.
 */
export function connectorCommand(entry: string): string {
  switch (installKind(entry)) {
    case 'global':
      return BIN_NAME;
    case 'npx':
      return `npx ${packageName()}`;
    case 'clone':
      return `node "${entry}"`;
  }
}

/** The `mcpServers` entry for Claude desktop's `claude_desktop_config.json`. */
export function claudeDesktopSnippet(node: string, entry: string): string {
  return JSON.stringify(
    { mcpServers: { [SERVER_NAME]: { command: node, args: [entry] } } },
    null,
    2,
  );
}

/**
 * `claude mcp add` command registering the connector in Claude Code. The
 * paths go between double quotes, which PowerShell, cmd and POSIX shells
 * all read the same way for a path (no `"` in a path on Windows).
 */
export function claudeCodeCommand(
  node: string,
  entry: string,
  scope: 'user' | 'local' = 'user',
): string {
  return `claude mcp add ${SERVER_NAME} --scope ${scope} -- "${node}" "${entry}"`;
}
