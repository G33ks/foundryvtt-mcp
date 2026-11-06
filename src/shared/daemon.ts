/**
 * @fileoverview `foundryvtt-mcp daemon`: the shared process.
 *
 * Owns the single FoundryVTT connection, module bridge and headless GM
 * session ({@link FoundryCore}) and serves tool calls forwarded by relays.
 * It outlives the relays MCP clients start and stop, and exits on `stop`,
 * after a relay from a newer build knocks, after one whose settings match a
 * changed configuration file knocks (see {@link mismatchDecision}), or once
 * no relay has been connected for the idle timeout. When the
 * FoundryVTT connection cannot be established (FoundryVTT not started yet,
 * wrong URL…) it stays up and retries on the next call.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { type Config, configFromSettings, getConfig } from '../config/index.js';
import { displayValue, KNOWN_SETTINGS, resolveSettings } from '../config/sources.js';
import type { CoreStatus, FoundryCore } from '../core.js';
import { logger } from '../utils/logger.js';
import { bareMessage } from '../utils/mcp-errors.js';
import { isRefusal } from '../utils/refusal.js';
import { compareBuilds } from './build-order.js';
import { configDigests, configFingerprint } from './config-hash.js';
import { IpcServer, type MismatchDecision } from './ipc-server.js';
import { resolveSharedPaths, type SharedPaths } from './paths.js';
import type { DaemonStatus, IpcError } from './protocol.js';
import { RotatingLog } from './rotating-log.js';
import { removeStateFile, writeStateFile } from './state-file.js';
import { loadOrCreateToken } from './token.js';
import { buildVersion } from './version.js';

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
  /** Per-setting digests of the identity settings (never logged nor shown). */
  configDigests?: Record<string, string>;
  /** Fingerprint of the configuration file alone, as on disk now; `null` if unreadable or invalid. */
  fileConfigHash?: () => string | null;
  /** This process's own settings for `status`, secrets already masked. */
  configStatus?: DaemonStatus['config'];
  /** Builds the core once the single-instance lock is held. */
  createCore: () => Promise<SharedCore>;
  exit: (code: number) => void;
  /** Exit after this long with no relay connected; 0 = never. */
  idleTimeoutMs?: number;
  /** Longest a tool call waits for the FoundryVTT connection attempt at startup. */
  startupWaitMs?: number;
  /** Longest a shutdown waits for in-flight calls before tearing down anyway. */
  drainMaxMs?: number;
  /** Longest the FoundryVTT/bridge/browser teardown may take. */
  shutdownGraceMs?: number;
}

/** Sends the bare text of an McpError: the relay rebuilds the McpError. */
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

/**
 * Whether a relay running another build or configuration restarts this
 * process ("the file is authoritative"):
 *
 * - a strictly newer build restarts it (see build-order.ts); an older or
 *   unorderable one is served as it is;
 * - another configuration restarts it only when the relay's settings are
 *   those of the configuration file as it is on disk now: the file changed,
 *   or this process was started by a client whose `env` block overrides it;
 * - any other difference (a client's `env` block) is served with this
 *   process's settings, and the relay is told which of its own are ignored;
 * - with the file unreadable or invalid, nothing restarts.
 *
 * @param fileHash - fingerprint of the file alone, `null` when unreadable or invalid
 */
export function mismatchDecision(
  reason: 'version' | 'config',
  relayVersion: string,
  ownVersion: string,
  config: { relayHash?: string; ownHash?: string; fileHash?: string | null } = {},
): MismatchDecision {
  if (reason === 'version') {
    return compareBuilds(relayVersion, ownVersion) === 'newer' ? 'restart' : 'accept';
  }
  const { relayHash, ownHash, fileHash } = config;
  if (!fileHash || relayHash === undefined) {
    return 'accept';
  }
  return relayHash === fileHash && fileHash !== ownHash ? 'restart' : 'accept';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SharedProcess {
  private readonly ipc: IpcServer;
  private readonly startedAt = new Date();
  private core: SharedCore | null = null;
  private startup: Promise<void> | null = null;
  private startupError: unknown = null;
  private shuttingDown: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: SharedProcessOptions) {
    this.ipc = new IpcServer({
      endpoint: options.paths.endpoint,
      token: options.token,
      version: options.version,
      configHash: options.configHash,
      ...(options.configDigests ? { configDigests: options.configDigests } : {}),
      ...(options.configStatus ? { configFile: options.configStatus.file.path } : {}),
      toIpcError,
      log: (level, message) => logger[level](message),
      onRelayCountChange: (count) => this.updateIdleTimer(count),
      onMismatch: (reason, relayVersion, relayHash) => {
        const decision = mismatchDecision(reason, relayVersion, options.version, {
          relayHash,
          ownHash: options.configHash,
          // Re-read now: the file may have changed since this process started.
          fileHash: reason === 'config' ? (options.fileConfigHash?.() ?? null) : null,
        });
        if (decision === 'restart') {
          void this.drainAndExit(
            reason === 'version'
              ? `a relay from a newer build (v${relayVersion}) connected`
              : "a relay with the configuration file's settings connected (the file changed, or this process was started with a client's own settings)",
          );
        }
        return decision;
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
    this.updateIdleTimer(0);
    return 'listening';
  }

  /**
   * Arms the idle timer while no relay is connected, disarms it otherwise.
   * Hours without a call do not count as idle as long as a relay is there.
   */
  private updateIdleTimer(relays: number): void {
    const idleTimeoutMs = this.options.idleTimeoutMs ?? 0;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (relays === 0 && idleTimeoutMs > 0 && !this.shuttingDown) {
      this.idleTimer = setTimeout(
        () =>
          void this.drainAndExit(
            `no relay connected for ${Number((idleTimeoutMs / 60_000).toFixed(2))} min`,
          ),
        idleTimeoutMs,
      );
    }
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
      if (isRefusal(error)) {
        // Expected (no world launched yet): the core already logged one line.
        logger.info('Shared process waits for FoundryVTT; the next call retries');
      } else {
        logger.error(
          'Shared process could not connect to FoundryVTT; the next call retries',
          error,
        );
      }
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
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
      }
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

  /** Connected relays, and the builds of those older than this process. */
  relays(): { connected: number; outdated: string[] } {
    return { connected: this.ipc.relayCount, outdated: this.ipc.outdatedRelayVersions };
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
      outdatedRelays: this.ipc.outdatedRelayVersions,
      // Excludes this status request itself.
      inFlight: this.ipc.inFlightCount - 1,
      ...(this.options.configStatus ? { config: this.options.configStatus } : {}),
      relayConfigs: this.ipc.relayConfigList,
      startupError: this.startupError ? errorText(this.startupError) : null,
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
        `The shared process could not connect to FoundryVTT: ${errorText(this.startupError).replace(
          /\.$/,
          '',
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
  // Started detached with stdio ignored: the log file is the only output.
  const log = new RotatingLog(paths.daemonLog);
  logger.addSink((line) => log.write(line));
  logger.info(
    `Shared process ${process.pid} starting (node ${process.version}, cwd ${process.cwd()})`,
  );

  const token = loadOrCreateToken(paths.tokenFile);
  let config: Config;
  try {
    config = getConfig();
  } catch (error) {
    // A relay only starts this process with a usable configuration; the
    // environment or the file changed in between. Nothing to serve.
    logger.error(`Shared process cannot start: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  const settings = resolveSettings();
  if (settings.file.warning) {
    logger.warn(settings.file.warning);
  }
  const shared: SharedProcess = new SharedProcess({
    paths,
    version: buildVersion(),
    token,
    configHash: configFingerprint(config, token),
    configDigests: configDigests(config, token),
    fileConfigHash: () => {
      const fileOnly = resolveSettings({ fileOnly: true });
      if (!fileOnly.file.found || fileOnly.file.error) {
        return null;
      }
      try {
        return configFingerprint(configFromSettings(fileOnly), token);
      } catch {
        return null;
      }
    },
    configStatus: {
      file: settings.file,
      settings: KNOWN_SETTINGS.filter((name) => settings.values[name] !== undefined).map(
        (name) => ({
          name,
          value: displayValue(name, settings.values[name]),
          source: settings.sources[name],
        }),
      ),
    },
    idleTimeoutMs: config.shared.idleTimeoutMinutes * 60_000,
    // Loaded lazily: Socket.IO, Playwright & co. are not needed to lose the race.
    createCore: async () =>
      new (await import('../core.js')).FoundryCore({ relays: () => shared.relays() }),
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
