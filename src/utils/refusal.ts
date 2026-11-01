/**
 * @fileoverview Expected refusals: a tool call turned down by design (a
 * missing or outdated journal page version, …), as opposed to a failure.
 *
 * The caller still gets an error, but the log gets one warn line without a
 * stack instead of the error lines a failure produces.
 */

import { type ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/** Thrown below the handlers (e.g. by `FoundryClient`) for an expected refusal. */
export class RefusedError extends Error {
  override name = 'RefusedError';
}

/** `McpError.data` marking an expected refusal. */
const REFUSAL_DATA = { refusal: true } as const;

/** An `McpError` for an expected refusal. */
export function refusalError(code: ErrorCode, message: string): McpError {
  return new McpError(code, message, REFUSAL_DATA);
}

/** True for a {@link RefusedError} or an `McpError` built by {@link refusalError}. */
export function isRefusal(error: unknown): boolean {
  if (error instanceof RefusedError) {
    return true;
  }
  if (!(error instanceof McpError)) {
    return false;
  }
  const data: unknown = error.data;
  return typeof data === 'object' && data !== null && 'refusal' in data && data.refusal === true;
}
