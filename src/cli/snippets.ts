/**
 * @fileoverview What `init` prints for the user to paste into their MCP clients.
 *
 * No `env` block: every setting lives in the shared configuration file.
 */

/** Server name in both clients. */
export const SERVER_NAME = 'foundryvtt';

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
