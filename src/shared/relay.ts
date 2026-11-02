/**
 * @fileoverview Default mode: a lightweight MCP stdio relay.
 *
 * Answers `initialize`, `tools/list` and `resources/list` itself, at once,
 * and forwards `tools/call` / `resources/read` to the shared process,
 * starting it when needed. MCP clients may start and stop relays freely;
 * the FoundryVTT connection lives in the shared process.
 *
 * A relay starts and answers even with no usable configuration: each tool
 * call then says what is missing, and re-reads the configuration, so writing
 * the configuration file is enough — no client restart.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  type CallToolResult,
  CallToolResultSchema,
  ErrorCode,
  McpError,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, STARTUP_BANNER } from '../mcp-server.js';
import { logger } from '../utils/logger.js';
import { OutdatedRelayNotice } from './build-order.js';
import { IgnoredConfigNotice } from './config-notice.js';
import { DaemonLink } from './daemon-link.js';
import { resolveSharedPaths } from './paths.js';
import { type Hello, PROTOCOL_VERSION } from './protocol.js';
import { RelayConfig } from './relay-config.js';
import { RotatingLog } from './rotating-log.js';
import { spawnDaemon } from './spawn.js';
import { loadOrCreateToken } from './token.js';
import { buildVersion } from './version.js';

export async function runRelay(entry: string): Promise<void> {
  process.stderr.write(STARTUP_BANNER);

  const paths = resolveSharedPaths();
  // stderr stays the MCP client's log; relay.log keeps a history across clients.
  const log = new RotatingLog(paths.relayLog);
  logger.addSink((line) => log.write(line));
  const version = buildVersion();
  // A relay older than the shared process is served (see build-order.ts),
  // with its startup tool list: its first tool result says so.
  const notice = new OutdatedRelayNotice(version);
  // Served with the shared process's settings instead of its own: said once too.
  const configNotice = new IgnoredConfigNotice();

  // Re-read before each handshake, and before each call while unusable.
  const relayConfig = new RelayConfig((message) =>
    logger.warn(`[relay ${process.pid}] ${message}`),
  );

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
        token,
        pid: process.pid,
        ...relayConfig.helloFields(token),
      };
    },
    spawnDaemon: () => spawnDaemon(entry),
    onConnected: (connection) => {
      if (notice.connected(connection.serverVersion)) {
        logger.warn(
          `[relay ${process.pid}] this relay (v${version}) is older than the shared process (v${connection.serverVersion}); restart the MCP client to load the current tool list`,
        );
      }
      configNotice.connected(connection.ignoredConfig);
    },
    log: (message) => logger.info(`[relay ${process.pid}] ${message}`),
  });

  const server = createMcpServer({
    callTool: async (name, args): Promise<CallToolResult> => {
      const config = relayConfig.usable();
      if (config instanceof Error) {
        return { isError: true, content: [{ type: 'text', text: config.message }] };
      }
      const result = CallToolResultSchema.parse(await link.call('tool', name, args));
      const texts = [notice.take(), configNotice.take()].filter((t): t is string => t !== null);
      // Some clients join text blocks without a separator: start on its own paragraph.
      return texts.length > 0
        ? {
            ...result,
            content: [
              ...result.content,
              ...texts.map((text) => ({ type: 'text' as const, text: `\n\n${text}` })),
            ],
          }
        : result;
    },
    readResource: async (uri) => {
      const config = relayConfig.usable();
      if (config instanceof Error) {
        throw new McpError(ErrorCode.InvalidRequest, config.message);
      }
      return ReadResourceResultSchema.parse(await link.call('resource', uri));
    },
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
  // up before the first tool call. Failures are retried by that call. With
  // no usable configuration there is nothing to start: calls will say so.
  if (relayConfig.usable() instanceof Error) {
    return;
  }
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
