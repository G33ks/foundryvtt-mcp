#!/usr/bin/env node

/**
 * FoundryVTT Model Context Protocol Server
 *
 * This server provides integration between FoundryVTT and AI models through the Model Context Protocol (MCP).
 * It enables AI assistants to interact with FoundryVTT instances for RPG campaign management,
 * character handling, and game automation.
 *
 * @fileoverview Main entry point for the FoundryVTT MCP Server
 * @version 0.1.0
 * @author FoundryVTT MCP Team
 * @see {@link https://github.com/anthropics/mcp} Model Context Protocol
 * @see {@link https://foundryvtt.com/} FoundryVTT Virtual Tabletop
 */

// Must precede every other import: see src/load-env.ts (#206).
import './load-env.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from './config/index.js';
import { DiagnosticsClient } from './diagnostics/client.js';
import { FoundryClient, type FoundryClientConfig } from './foundry/client.js';
import { HeadlessGmSession } from './foundry/headless-gm-session.js';
import { ModuleBridge } from './foundry/module-bridge.js';
import {
  getAllResources,
  getAllTools,
  routeResourceRequest,
  routeToolRequest,
} from './tools/index.js';
import { DiagnosticSystem } from './utils/diagnostics.js';
import { logger } from './utils/logger.js';

/**
 * Main FoundryVTT MCP Server class that handles all communication
 * between AI models and FoundryVTT instances.
 */
class FoundryMCPServer {
  private server: Server;
  private foundryClient: FoundryClient;
  private diagnosticsClient: DiagnosticsClient;
  private diagnosticSystem: DiagnosticSystem;
  private moduleBridge: ModuleBridge | null;
  private headlessGmSession: HeadlessGmSession | null;

  /**
   * Creates a new FoundryMCPServer instance.
   * Initializes the MCP server, FoundryVTT client, and sets up all handlers.
   */
  constructor() {
    this.server = new Server(
      {
        name: config.serverName,
        version: config.serverVersion,
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      },
    );

    // Initialize FoundryVTT client with configuration
    const clientConfig: FoundryClientConfig = {
      baseUrl: config.foundry.url,
      socketPath: config.foundry.socketPath,
      timeout: config.foundry.timeout,
      retryAttempts: config.foundry.retryAttempts,
      retryDelay: config.foundry.retryDelay,
      writeEnabled: config.foundry.writeEnabled,
      eventBufferSize: config.events.bufferSize,
    };
    if (config.foundry.apiKey) {
      clientConfig.apiKey = config.foundry.apiKey;
    }
    if (config.foundry.username) {
      clientConfig.username = config.foundry.username;
    }
    if (config.foundry.password) {
      clientConfig.password = config.foundry.password;
    }
    if (config.foundry.userId) {
      clientConfig.userId = config.foundry.userId;
    }
    if (config.assets.dataPath) {
      clientConfig.dataPath = config.assets.dataPath;
    }
    this.foundryClient = new FoundryClient(clientConfig);

    // Canvas-only tools (scene screenshots, etc.) relay through a companion
    // Foundry module over a plain WebSocket; disabled unless opted in, since
    // most tools need only the Socket.IO document API set up above.
    this.moduleBridge = config.moduleBridge.enabled
      ? new ModuleBridge(config.moduleBridge.port)
      : null;
    if (this.moduleBridge) {
      // The bridge stays ignorant of FoundryClient; it only relays what the
      // module pushed unsolicited (canvas targeting, pings, …).
      this.moduleBridge.onEvent = (type, payload) =>
        this.foundryClient.recordModuleEvent(type, payload);
    }

    // Invisible GM-tier browser session that hosts the companion module —
    // no human has to manually open and log into a second Foundry tab.
    // Only worth building when there's a bridge for it to connect to, and
    // only possible with username/password credentials (an apiKey-only
    // setup has nothing to log a browser in with).
    const headlessUsername = config.headlessGm.username ?? config.foundry.username;
    const headlessPassword = config.headlessGm.password ?? config.foundry.password;
    if (this.moduleBridge && config.headlessGm.enabled && headlessUsername && headlessPassword) {
      this.headlessGmSession = new HeadlessGmSession({
        foundryUrl: config.foundry.url,
        username: headlessUsername,
        password: headlessPassword,
        isBridgeConnected: () => this.moduleBridge?.isConnected() ?? false,
        ...(config.headlessGm.executablePath
          ? { executablePath: config.headlessGm.executablePath }
          : {}),
      });
    } else {
      this.headlessGmSession = null;
      if (this.moduleBridge && config.headlessGm.enabled) {
        logger.warn(
          'Headless GM session disabled — no username/password to log a browser in with (set FOUNDRY_USERNAME/FOUNDRY_PASSWORD or FOUNDRY_HEADLESS_GM_USERNAME/FOUNDRY_HEADLESS_GM_PASSWORD, or open a GM browser tab manually).',
        );
      }
    }

    // Initialize DiagnosticsClient
    this.diagnosticsClient = new DiagnosticsClient(this.foundryClient);

    // Initialize DiagnosticSystem
    this.diagnosticSystem = new DiagnosticSystem(this.foundryClient);

    this.setupHandlers();
  }

  /**
   * Sets up all MCP request handlers for tools, resources, and functionality.
   * @private
   */
  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      logger.info('Listing available tools');
      return {
        tools: getAllTools(),
      };
    });

    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      logger.info('Listing available resources');
      return {
        resources: getAllResources(),
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      logger.info('Executing tool', { name, args });

      try {
        return (await routeToolRequest(
          name,
          args || {},
          this.foundryClient,
          this.diagnosticsClient,
          this.diagnosticSystem,
          this.moduleBridge,
          this.headlessGmSession,
        )) as CallToolResult;
      } catch (error) {
        logger.error('Tool execution failed:', error);

        if (error instanceof McpError) {
          throw error;
        }

        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    });

    // Handle resource reads
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      logger.info('Reading resource', { uri });

      try {
        return await routeResourceRequest(uri, this.foundryClient, this.diagnosticsClient);
      } catch (error) {
        logger.error('Resource read failed:', error);

        if (error instanceof McpError) {
          throw error;
        }

        throw new McpError(
          ErrorCode.InternalError,
          `Resource read failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    });
  }

  /**
   * Connects to FoundryVTT and starts the MCP server.
   * @returns Promise that resolves when the server is running
   */
  async start(): Promise<void> {
    // Attach the stdio transport FIRST, before any network call. MCP
    // clients spawn this process and write `initialize` on stdin right
    // away; every millisecond spent connecting to FoundryVTT (a Socket.IO
    // round-trip, ~0.4-1s observed) before wiring the transport is a
    // millisecond the client's own handshake timeout burns with nothing
    // reading stdin yet — omp's logs showed exactly this: "Transport
    // closed" ~1s after spawn, matching the old connect-then-transport
    // ordering. `tools/list` needs no FoundryVTT connection (getAllTools()
    // is static); tool calls that do need it fail with FoundryClient's own
    // "not connected" errors until the connection below resolves, rather
    // than the whole process going unresponsive.
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('FoundryVTT MCP Server started successfully');

    try {
      // Connect to FoundryVTT
      await this.foundryClient.connect();
      logger.info('Connected to FoundryVTT successfully');

      // The module bridge is optional, best-effort infrastructure for a
      // handful of canvas-only tools (capture_scene, etc.) — a failure here
      // (e.g. the port is already taken by a still-shutting-down previous
      // instance) must never take down the FoundryVTT Socket.IO connection
      // and the 40+ tools that don't need a module at all.
      if (this.moduleBridge) {
        try {
          await this.moduleBridge.start();
        } catch (error) {
          logger.error(
            'Module bridge failed to start — canvas-only tools (capture_scene) will report unavailable; all other tools are unaffected:',
            error,
          );
          this.moduleBridge = null;
          this.headlessGmSession = null;
        }
      }

      // Same best-effort isolation as the module bridge itself: a browser
      // that fails to launch (no Chrome/Edge installed) must never take
      // down the Socket.IO connection or the module bridge's WS server —
      // canvas-only tools just report unavailable until this resolves.
      // Login happens in the background after this resolves (Foundry may
      // still be booting); see HeadlessGmSession.start().
      if (this.headlessGmSession) {
        try {
          await this.headlessGmSession.start();
        } catch (error) {
          logger.error(
            'Headless GM session failed to launch — open a GM/Assistant-GM browser tab manually for canvas-only tools to work:',
            error,
          );
          this.headlessGmSession = null;
        }
      }
    } catch (error) {
      logger.error('Failed to connect to FoundryVTT:', error);
      throw error;
    }
  }

  /**
   * Gracefully shuts down the server and connections.
   * @returns Promise that resolves when shutdown is complete
   */
  async shutdown(): Promise<void> {
    try {
      await this.foundryClient.disconnect();
      if (this.headlessGmSession) {
        await this.headlessGmSession.stop();
      }
      if (this.moduleBridge) {
        await this.moduleBridge.stop();
      }
      logger.info('FoundryVTT MCP Server shutdown completed');
    } catch (error) {
      logger.error('Error during shutdown:', error);
    }
  }
}

/** Maximum time graceful shutdown may take before the process is force-exited. */
const SHUTDOWN_GRACE_MS = 5000;

/**
 * Main entry point - creates and starts the server
 */
async function main(): Promise<void> {
  const server = new FoundryMCPServer();

  // Pre-connect banner — emitted on stderr so the stdio JSON-RPC channel on
  // stdout stays clean once StdioServerTransport.connect() takes it over.
  // The smoke test (scripts/smoke-test.js) keys on this string to verify the
  // binary loads without crashing at construction time, before any network
  // call to FoundryVTT.
  process.stderr.write('🎲 FoundryVTT MCP Server starting...\n');

  // Handle graceful shutdown. Several triggers can fire for the same exit
  // (e.g. stdin closing, then SIGTERM), so shut down exactly once.
  let shuttingDown = false;
  const shutdownAndExit = async (reason: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`${reason}, shutting down gracefully...`);
    // Never let a hung cleanup step (e.g. the headless browser) keep the
    // process alive: force the exit after a grace period, with a non-zero
    // code so a hung shutdown is distinguishable from a clean one.
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    await server.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdownAndExit('Received SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdownAndExit('Received SIGTERM');
  });

  // MCP stdio clients signal shutdown by closing the server's stdin. On
  // Windows no SIGTERM follows when the client exits, so without this the
  // process lingers (kept alive by the Socket.IO connection, the module
  // bridge's WebSocket server and the headless browser), keeps the bridge
  // port bound and leaves the next instance without a module bridge.
  process.stdin.on('end', () => {
    void shutdownAndExit('stdin closed by the MCP client');
  });
  process.stdin.on('close', () => {
    void shutdownAndExit('stdin closed by the MCP client');
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', { promise, reason });
    process.exit(1);
  });

  try {
    await server.start();
  } catch (error) {
    logger.error('Failed to start FoundryVTT MCP Server:', error);
    process.exit(1);
  }
}

// Run the server if this file is executed directly.
// Use realpath so the comparison works when npm/npx installs the bin as a
// symlink into node_modules/.bin (the literal `file://${argv[1]}` compare
// fails for symlinked invocations and on macOS where /tmp -> /private/tmp).
const isMainModule = (() => {
  const argv1 = process.argv[1];
  if (!argv1) {
    return false;
  }
  try {
    return realpathSync(argv1) === fileURLToPath(import.meta.url);
  } catch {
    return import.meta.url === `file://${argv1}`;
  }
})();

if (isMainModule) {
  main().catch((error) => {
    logger.error('Server startup failed:', error);
    process.exit(1);
  });
}
