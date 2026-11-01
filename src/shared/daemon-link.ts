/**
 * @fileoverview A relay's link to the shared process: connects (starting the
 * process when nobody listens), waits while it boots or while an outdated
 * one drains, and turns IPC failures into MCP errors.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  ConnectionLostError,
  EndpointUnavailableError,
  HandshakeRejectedError,
  IpcConnection,
  RemoteError,
} from './ipc-client.js';
import { type Hello, IpcErrorCode, type Op } from './protocol.js';

export interface DaemonLinkOptions {
  endpoint: string;
  /** Built for every attempt: the token file may only appear after a spawn. */
  hello: () => Hello;
  /** Starts a shared process in the background (detached). */
  spawnDaemon: () => void;
  /** Shared-process log, quoted in error messages. */
  logFile: string;
  /** How long to wait for a shared process to accept the relay. */
  readyTimeoutMs?: number;
  /** How long an outdated shared process may take to drain and exit. */
  drainTimeoutMs?: number;
  /** Minimum delay between two spawns while waiting. */
  respawnIntervalMs?: number;
  connect?: (endpoint: string, hello: Hello) => Promise<IpcConnection>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

/** Calls rejected by a draining process never started, so they may be resent. */
const MAX_DRAINING_RETRIES = 3;

export class DaemonLink {
  private connection: IpcConnection | null = null;
  private connecting: Promise<IpcConnection> | null = null;
  private readonly readyTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly respawnIntervalMs: number;
  private readonly connect: (endpoint: string, hello: Hello) => Promise<IpcConnection>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: DaemonLinkOptions) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
    // The shared process waits up to 120 s for in-flight calls, then 5 s for teardown.
    this.drainTimeoutMs = options.drainTimeoutMs ?? 150_000;
    this.respawnIntervalMs = options.respawnIntervalMs ?? 5000;
    this.connect = options.connect ?? ((endpoint, hello) => IpcConnection.connect(endpoint, hello));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  /**
   * Forwards one operation and returns its result.
   *
   * @throws {McpError} the remote error, or a link failure explained for the user
   */
  async call(op: Op, name?: string, args?: Record<string, unknown>): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const connection = await this.ensureConnected();
      try {
        return await connection.request(op, name, args);
      } catch (error) {
        if (error instanceof RemoteError) {
          if (error.code === IpcErrorCode.Draining && attempt < MAX_DRAINING_RETRIES) {
            this.drop(connection);
            continue;
          }
          throw new McpError(error.code, error.message, error.data);
        }
        if (error instanceof ConnectionLostError) {
          // Never resend: the call may have been half-way through a write.
          this.drop(connection);
          throw new McpError(
            ErrorCode.InternalError,
            `The shared FoundryVTT MCP process exited during this call; its outcome is unknown. It will be restarted on the next call. Log: ${this.options.logFile}`,
          );
        }
        throw error;
      }
    }
  }

  /** Returns a live connection, establishing one (single-flight) if needed. */
  ensureConnected(): Promise<IpcConnection> {
    if (this.connection && !this.connection.isClosed) {
      return Promise.resolve(this.connection);
    }
    if (!this.connecting) {
      this.connecting = this.establish().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  close(): void {
    this.connection?.close();
    this.connection = null;
  }

  private drop(connection: IpcConnection): void {
    connection.close();
    if (this.connection === connection) {
      this.connection = null;
    }
  }

  private async establish(): Promise<IpcConnection> {
    const started = this.now();
    let deadline = started + this.readyTimeoutMs;
    let drainWaitGranted = false;
    let lastSpawn = Number.NEGATIVE_INFINITY;
    let delay = 50;

    for (;;) {
      try {
        const connection = await this.connect(this.options.endpoint, this.options.hello());
        connection.onClose(() => {
          if (this.connection === connection) {
            this.connection = null;
          }
        });
        this.connection = connection;
        return connection;
      } catch (error) {
        if (error instanceof EndpointUnavailableError) {
          if (this.now() - lastSpawn >= this.respawnIntervalMs) {
            this.options.log?.('No shared process is listening; starting one');
            this.options.spawnDaemon();
            lastSpawn = this.now();
          }
        } else if (error instanceof HandshakeRejectedError) {
          if (error.reason === 'unauthorized' || error.reason === 'protocol') {
            throw new McpError(
              ErrorCode.InternalError,
              `The shared FoundryVTT MCP process refused this relay (${error.reason}: ${error.message}). Stop it (foundryvtt-mcp stop, or end the process listed in its state file) and retry. Log: ${this.options.logFile}`,
            );
          }
          // Outdated or shutting down: wait for it to exit, then start a fresh one.
          if (!drainWaitGranted) {
            this.options.log?.(`Shared process is restarting (${error.reason}); waiting`);
            deadline = Math.max(deadline, this.now() + this.drainTimeoutMs);
            drainWaitGranted = true;
          }
          lastSpawn = Number.NEGATIVE_INFINITY;
        } else {
          this.options.log?.(
            `Connecting to the shared process failed: ${error instanceof Error ? error.message : error}`,
          );
        }
      }

      if (this.now() >= deadline) {
        throw new McpError(
          ErrorCode.InternalError,
          `The shared FoundryVTT MCP process did not become available within ${Math.round(
            (this.now() - started) / 1000,
          )} s. Log: ${this.options.logFile}`,
        );
      }
      await this.sleep(delay);
      delay = Math.min(delay * 2, 500);
    }
  }
}
