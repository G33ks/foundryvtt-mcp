/**
 * @fileoverview `foundryvtt-mcp daemon`: the shared process.
 *
 * Owns the single FoundryVTT connection, module bridge and headless GM
 * session ({@link FoundryCore}) and serves tool calls forwarded by relays.
 * It outlives the relays MCP clients start and stop, and exits on `stop`,
 * or after a relay with another version/configuration knocks. When the
 * FoundryVTT connection cannot be established (FoundryVTT not started yet,
 * wrong URL…) it stays up and retries on the next call.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { getConfig } from '../config/index.js';
import type { CoreStatus, FoundryCore } from '../core.js';
import { logger } from '../utils/logger.js';
import { configFingerprint } from './config-hash.js';
import { IpcServer } from './ipc-server.js';
import { resolveSharedPaths, type SharedPaths } from './paths.js';
import type { DaemonStatus, IpcError } from './protocol.js';
import { removeStateFile, writeStateFile } from './state-file.js';
import { loadOrCreateToken } from './token.js';
import { packageVersion } from './version.js';

/** The part of {@link FoundryCore} the shared process drives. */
export type SharedCore = Pick<
  FoundryCore,
  'start' | 'shutdown' | 'callTool' | 'readResource' | 'status'
>;

export interface SharedProcessOptions {
  paths: SharedPaths;
  version: string;
  token: string;
  configHash: string;
  /** Builds the core once the single-instance lock is held. */
  createCore: () => Promise<SharedCore>;
  exit: (code: number) => void;
  /** Longest a tool call waits for the FoundryVTT connection attempt at startup. */
  startupWaitMs?: number;
  /** Longest a shutdown waits for in-flight calls before tearing down anyway. */
  drainMaxMs?: number;
  /** Longest the FoundryVTT/bridge/browser teardown may take. */
  shutdownGraceMs?: number;
}

/** McpError prefixes its message with "MCP error <code>: "; send the bare text. */
function bareMessage(error: McpError): string {
  return error.message.replace(/^MCP error -?\d+: /, '');
}

export function toIpcError(error: unknown): IpcError {
  if (error instanceof McpError) {
    return {
      code: error.code,
      message: bareMessage(error),
      ...(error.data !== undefined ? { data: error.data } : {}),
    };
  }
  return {
    code: ErrorCode.InternalError,
    message: error instanceof Error ? error.message : String(error),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SharedProcess {
  private readonly ipc: IpcServer;
  private readonly startedAt = new Date();
  private core: SharedCore | null = null;
  private startup: Promise<void> | null = null;
  private startupError: unknown = null;
  private shuttingDown: Promise<void> | null = null;

  constructor(private readonly options: SharedProcessOptions) {
    this.ipc = new IpcServer({
      endpoint: options.paths.endpoint,
      token: options.token,
      version: options.version,
      configHash: options.configHash,
      toIpcError,
      log: (level, message) => logger[level](message),
      onMismatch: (reason) => {
        void this.drainAndExit(`a relay with a different ${reason} connected`);
      },
      handler: async (op, name, args) => {
        switch (op) {
          case 'tool':
            return (await this.ready()).callTool(name ?? '', args);
          case 'resource':
            return (await this.ready()).readResource(name ?? '');
          case 'status':
            return this.status();
          case 'stop':
            setImmediate(() => void this.drainAndExit('stop requested'));
            return { stopping: true, pid: process.pid };
        }
      },
    });
  }

  /**
   * Takes the single-instance lock, then builds and starts the core. A
   * process that loses the race returns `in-use` without touching FoundryVTT.
   */
  async start(): Promise<'listening' | 'in-use'> {
    const { paths, version } = this.options;
    if ((await this.ipc.listen()) === 'in-use') {
      return 'in-use';
    }
    writeStateFile(paths.stateFile, {
      pid: process.pid,
      version,
      startedAt: this.startedAt.toISOString(),
      endpoint: paths.endpoint,
      logFile: paths.daemonLog,
    });
    logger.info(`Shared process ${process.pid} (v${version}) listening on ${paths.endpoint}`);

    this.startup = this.bootCore();
    return 'listening';
  }

  /** Builds and starts a core, replacing one whose start failed. */
  private bootCore(): Promise<void> {
    return (async () => {
      if (this.core) {
        await this.core.shutdown();
      }
      this.core = await this.options.createCore();
      await this.core.start();
    })().catch((error: unknown) => {
      this.startupError = error;
      logger.error('Shared process could not connect to FoundryVTT; the next call retries', error);
    });
  }

  /**
   * Stops accepting work, lets started calls finish (a write is never cut
   * in half), tears the core down, releases the endpoint and exits.
   */
  drainAndExit(reason: string, code = 0): Promise<void> {
    this.shuttingDown ??= (async () => {
      const { drainMaxMs = 120_000, shutdownGraceMs = 5000, paths, exit } = this.options;
      logger.info(`Shared process shutting down: ${reason}`);
      this.ipc.setDraining();
      await Promise.race([this.ipc.waitForIdle(), sleep(drainMaxMs)]);
      const force = setTimeout(() => exit(1), shutdownGraceMs);
      force.unref();
      await this.core?.shutdown();
      await this.ipc.close();
      clearTimeout(force);
      removeStateFile(paths.stateFile, process.pid);
      exit(code);
    })();
    return this.shuttingDown;
  }

  private status(): DaemonStatus {
    const coreStatus: Partial<CoreStatus> = this.core?.status() ?? {};
    return {
      pid: process.pid,
      version: this.options.version,
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
      endpoint: this.options.paths.endpoint,
      logFile: this.options.paths.daemonLog,
      relays: this.ipc.relayCount,
      // Excludes this status request itself.
      inFlight: this.ipc.inFlightCount - 1,
      startupError: this.startupError ? describe(this.startupError) : null,
      ...coreStatus,
    };
  }

  /** Waits (bounded) for the FoundryVTT connection attempt, then hands out the core. */
  private async ready(): Promise<SharedCore> {
    if (this.startupError !== null && !this.shuttingDown) {
      // The last attempt failed: this call retries (concurrent calls share the attempt).
      this.startupError = null;
      this.startup = this.bootCore();
    }
    if (this.startup) {
      await Promise.race([this.startup, sleep(this.options.startupWaitMs ?? 30_000)]);
    }
    if (this.startupError) {
      throw new McpError(
        ErrorCode.InternalError,
        `The shared process could not connect to FoundryVTT: ${describe(
          this.startupError,
        )}. The next call retries. Log: ${this.options.paths.daemonLog}`,
      );
    }
    if (!this.core) {
      throw new McpError(
        ErrorCode.InternalError,
        `The shared process is still starting. Log: ${this.options.paths.daemonLog}`,
      );
    }
    return this.core;
  }
}

/** Entry point of `foundryvtt-mcp daemon`. */
export async function runDaemon(paths: SharedPaths = resolveSharedPaths()): Promise<void> {
  const token = loadOrCreateToken(paths.tokenFile);
  const shared = new SharedProcess({
    paths,
    version: packageVersion(),
    token,
    configHash: configFingerprint(getConfig(), token),
    // Loaded lazily: Socket.IO, Playwright & co. are not needed to lose the race.
    createCore: async () => new (await import('../core.js')).FoundryCore(),
    exit: (code) => process.exit(code),
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) {
    process.on(signal, () => void shared.drainAndExit(`received ${signal}`));
  }
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception in the shared process:', error);
    removeStateFile(paths.stateFile, process.pid);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection in the shared process:', { reason: String(reason) });
    removeStateFile(paths.stateFile, process.pid);
    process.exit(1);
  });

  if ((await shared.start()) === 'in-use') {
    logger.info('Another shared process already listens on the endpoint; exiting');
    process.exit(0);
  }
}
