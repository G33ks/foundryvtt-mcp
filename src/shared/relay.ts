/**
 * @fileoverview Default mode: a lightweight MCP stdio relay.
 *
 * Answers `initialize`, `tools/list` and `resources/list` itself, at once,
 * and forwards `tools/call` / `resources/read` to the shared process,
 * starting it when needed. MCP clients may start and stop relays freely;
 * the FoundryVTT connection lives in the shared process.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolResultSchema, ReadResourceResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { getConfig } from '../config/index.js';
import { createMcpServer, STARTUP_BANNER } from '../mcp-server.js';
import { logger } from '../utils/logger.js';
import { configFingerprint } from './config-hash.js';
import { DaemonLink } from './daemon-link.js';
import { resolveSharedPaths } from './paths.js';
import { type Hello, PROTOCOL_VERSION } from './protocol.js';
import { RotatingLog } from './rotating-log.js';
import { spawnDaemon } from './spawn.js';
import { loadOrCreateToken } from './token.js';
import { packageVersion } from './version.js';

export async function runRelay(entry: string): Promise<void> {
  process.stderr.write(STARTUP_BANNER);

  // Validate the configuration up front, exactly like the all-in-one mode:
  // a broken setup fails here, visibly, not on the first tool call.
  const config = getConfig();
  const paths = resolveSharedPaths();
  // stderr stays the MCP client's log; relay.log keeps a history across clients.
  const log = new RotatingLog(paths.relayLog);
  logger.addSink((line) => log.write(line));
  const version = packageVersion();

  const link = new DaemonLink({
    endpoint: paths.endpoint,
    logFile: paths.daemonLog,
    hello: (): Hello => {
      const token = loadOrCreateToken(paths.tokenFile);
      return {
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        role: 'relay',
        version,
        configHash: configFingerprint(config, token),
        token,
      };
    },
    spawnDaemon: () => spawnDaemon(entry),
    log: (message) => logger.info(`[relay ${process.pid}] ${message}`),
  });

  const server = createMcpServer({
    callTool: async (name, args) => CallToolResultSchema.parse(await link.call('tool', name, args)),
    readResource: async (uri) => ReadResourceResultSchema.parse(await link.call('resource', uri)),
  });

  const exit = (reason: string): void => {
    logger.info(`[relay ${process.pid}] ${reason}; exiting`);
    link.close();
    process.exit(0);
  };
  process.stdin.on('end', () => exit('stdin closed by the MCP client'));
  process.stdin.on('close', () => exit('stdin closed by the MCP client'));
  process.on('SIGINT', () => exit('received SIGINT'));
  process.on('SIGTERM', () => exit('received SIGTERM'));
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception in relay:', error);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection in relay:', { reason: String(reason) });
    process.exit(1);
  });

  await server.connect(new StdioServerTransport());
  logger.info(`[relay ${process.pid}] FoundryVTT MCP relay started (v${version})`);

  // Warm up in the background: when the client starts, the shared process
  // (FoundryVTT connection, module bridge, headless GM session) should be
  // up before the first tool call. Failures are retried by that call.
  link.ensureConnected().then(
    (connection) =>
      logger.info(`[relay ${process.pid}] connected to shared process ${connection.serverPid}`),
    (error: unknown) =>
      logger.warn(
        `[relay ${process.pid}] shared process not available yet: ${
          error instanceof Error ? error.message : error
        }`,
      ),
  );
}
