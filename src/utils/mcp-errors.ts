/**
 * @fileoverview MCP errors on their way to a client.
 *
 * `McpError` puts "MCP error <code>: " in front of its message, and the
 * SDK's `Protocol` sends `error.message` as it is in the JSON-RPC error; the
 * client's SDK then builds its own `McpError`, which adds the prefix a second
 * time (G33ks/foundryvtt-mcp#15). The message
 * on the wire must therefore be the bare text.
 *
 * A failed tool call is not a JSON-RPC error but a result with
 * `isError: true`, so the model reads why it failed (MCP specification,
 * "Error Handling" of tools). No client adds a prefix to a result: the text
 * carries the one prefix itself. An unknown tool and a failed resource read
 * (`resources/read` has no `isError`) stay JSON-RPC errors.
 */

import { type CallToolResult, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

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
 * A failed tool call as the client gets it: an `isError` result whose text
 * is "MCP error <code>: <message>", with the McpError's code, or
 * InternalError for any other error. An unknown tool is thrown again as a
 * {@link WireError}, to stay a JSON-RPC error.
 */
export function toolErrorResult(error: unknown): CallToolResult {
  if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) {
    throw new WireError(error.code, bareMessage(error), error.data);
  }
  const code = error instanceof McpError ? error.code : ErrorCode.InternalError;
  const message =
    error instanceof McpError
      ? bareMessage(error)
      : error instanceof Error
        ? error.message
        : String(error);
  return { isError: true, content: [{ type: 'text', text: `MCP error ${code}: ${message}` }] };
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
