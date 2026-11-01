/**
 * Shared utilities for tool handlers
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { logger } from '../../utils/logger.js';

/**
 * Puts the pending journal overwrite warnings (see journal-integrity.ts) at
 * the top of a journal tool's response; each is shown once.
 */
export function withJournalWarnings<T extends { content: Array<{ type: string; text: string }> }>(
  foundryClient: FoundryClient,
  response: T,
): T {
  const warnings = foundryClient.drainJournalWarnings();
  const first = response.content[0];
  if (warnings.length === 0 || !first) {
    return response;
  }
  return {
    ...response,
    content: [
      { ...first, text: `${warnings.join('\n')}\n\n${first.text}` },
      ...response.content.slice(1),
    ],
  };
}

/**
 * Wraps an async handler function with standard error logging and McpError conversion.
 *
 * @param toolName - Label used in error log messages (e.g. 'search actors')
 * @param fn - Async function containing the handler logic
 */
export async function withToolError<T>(toolName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    logger.error(`Failed to ${toolName}:`, error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to ${toolName}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}
