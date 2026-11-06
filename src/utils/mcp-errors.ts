/**
 * @fileoverview MCP errors on their way to a client.
 *
 * `McpError` puts "MCP error <code>: " in front of its message, and the
 * SDK's `Protocol` sends `error.message` as it is in the JSON-RPC error; the
 * client's SDK then builds its own `McpError`, which adds the prefix a second
 * time (G33ks/foundryvtt-mcp#15). The message
 * on the wire must therefore be the bare text.
 */

import { McpError } from '@modelcontextprotocol/sdk/types.js';

/** McpError prefixes its message with "MCP error <code>: "; this is the text without it. */
export function bareMessage(error: McpError): string {
  return error.message.replace(/^MCP error -?\d+: /, '');
}

/**
 * An error as the SDK sends it: `Protocol` reads `code` (a safe integer),
 * `message` and `data` from whatever a handler throws (SDK 1.32.2,
 * dist/esm/shared/protocol.js:426-428), so a plain `Error` with those
 * fields reaches the client unchanged.
 */
export class WireError extends Error {
  override name = 'WireError';

  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/**
 * Runs a request handler; an `McpError` it throws leaves with its bare
 * message, its code and its data, so the client shows one prefix. Any other
 * error is left to the SDK.
 */
export async function withBareErrors<T>(handler: () => Promise<T>): Promise<T> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof McpError) {
      throw new WireError(error.code, bareMessage(error), error.data);
    }
    throw error;
  }
}
