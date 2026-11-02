/**
 * @fileoverview What `init` prints for the user to paste into their MCP clients.
 *
 * No `env` block: every setting lives in the shared configuration file.
 */

import { win32 } from 'node:path';

/** Server name in both clients. */
export const SERVER_NAME = 'foundryvtt';

/** The package's `bin` name, a command only once the package is installed. */
const BIN_NAME = 'foundryvtt-mcp';

/**
 * How to run the connector from a terminal, for the commands `init` prints:
 * the `bin` name when it was started by that name (`invokedAs`, i.e.
 * `process.argv[1]`), otherwise `node "<entry>"`, which works from any
 * folder after a plain clone. `win32.basename` splits on both separators.
 */
export function connectorCommand(entry: string, invokedAs: string | undefined): string {
  if (invokedAs && win32.basename(invokedAs).replace(/\.(c?m?js|cmd|ps1)$/i, '') === BIN_NAME) {
    return BIN_NAME;
  }
  return `node "${entry}"`;
}

/** The `mcpServers` entry for Claude desktop's `claude_desktop_config.json`. */
export function claudeDesktopSnippet(entry: string): string {
  return JSON.stringify(
    { mcpServers: { [SERVER_NAME]: { command: 'node', args: [entry] } } },
    null,
    2,
  );
}

/**
 * `claude mcp add` command registering the connector in Claude Code. The
 * path goes between double quotes, which PowerShell, cmd and POSIX shells
 * all read the same way for a path (no `"` in a path on Windows).
 */
export function claudeCodeCommand(entry: string, scope: 'user' | 'local' = 'user'): string {
  return `claude mcp add ${SERVER_NAME} --scope ${scope} -- node "${entry}"`;
}
