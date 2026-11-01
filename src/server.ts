/**
 * @fileoverview All-in-one mode (`FOUNDRY_MCP_SHARED=false`): this stdio
 * process owns its own FoundryVTT connection, module bridge and headless GM
 * session, and exits when its MCP client closes stdin.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FoundryCore } from './core.js';
import { createMcpServer, STARTUP_BANNER } from './mcp-server.js';
import { logger } from './utils/logger.js';

/**
 * Main FoundryVTT MCP Server class that handles all communication
 * between AI models and FoundryVTT instances.
 */
class FoundryMCPServer {
  private readonly core = new FoundryCore();
  private readonly server = createMcpServer(this.core);

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

    await this.core.start();
  }

  /**
   * Gracefully shuts down the server and connections.
   * @returns Promise that resolves when shutdown is complete
   */
  async shutdown(): Promise<void> {
    await this.core.shutdown();
  }
}

/** Maximum time graceful shutdown may take before the process is force-exited. */
const SHUTDOWN_GRACE_MS = 5000;

/**
 * Creates and starts the all-in-one server.
 */
export async function runAllInOne(): Promise<void> {
  const server = new FoundryMCPServer();

  process.stderr.write(STARTUP_BANNER);

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
