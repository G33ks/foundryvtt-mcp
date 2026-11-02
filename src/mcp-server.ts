/**
 * @fileoverview The MCP stdio server facade shared by the all-in-one mode
 * and the relay.
 *
 * `tools/list` and `resources/list` are static and answered locally; only
 * `tools/call` and `resources/read` go to the backend. Imports stay light on
 * purpose: the relay must answer `initialize` without loading Socket.IO or
 * Playwright.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import { tryGetConfig } from './config/index.js';
import { getAllTools } from './tools/definitions.js';
import { getAllResources } from './tools/resources.js';
import { logger } from './utils/logger.js';

export interface McpBackend {
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  readResource(uri: string): Promise<ReadResourceResult>;
}

export function createMcpServer(backend: McpBackend): Server {
  // Answers `initialize` even with no usable configuration yet: tool calls
  // then say what is missing (see the relay and the all-in-one server).
  const loaded = tryGetConfig();
  const server = new Server(
    {
      name: 'config' in loaded ? loaded.config.serverName : 'foundryvtt-mcp',
      version: 'config' in loaded ? loaded.config.serverVersion : '0.1.0',
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    },
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.info('Listing available tools');
    return {
      tools: getAllTools(),
    };
  });

  // List available resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    logger.info('Listing available resources');
    return {
      resources: getAllResources(),
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return backend.callTool(name, args || {});
  });

  // Handle resource reads
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return backend.readResource(request.params.uri);
  });

  return server;
}

/**
 * Pre-connect banner — emitted on stderr so the stdio JSON-RPC channel on
 * stdout stays clean once StdioServerTransport.connect() takes it over.
 * The smoke test (scripts/smoke-test.js) keys on this string to verify the
 * binary loads without crashing at construction time, before any network
 * call to FoundryVTT.
 */
export const STARTUP_BANNER = '🎲 FoundryVTT MCP Server starting...\n';
