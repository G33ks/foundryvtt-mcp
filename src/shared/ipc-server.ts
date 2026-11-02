/**
 * @fileoverview Server side of the relay ↔ shared-process channel.
 *
 * Listening on the endpoint doubles as the single-instance lock: a second
 * shared process gets `in-use` from {@link IpcServer.listen} and exits.
 *
 * Deliberately free of config/logger imports; the owner passes a `log`
 * callback and decides what each event means.
 */

import { existsSync, rmSync } from 'node:fs';
import net from 'node:net';
import { compareBuilds } from './build-order.js';
import { differingSettings } from './config-hash.js';
import {
  type DaemonStatus,
  encodeLine,
  type Hello,
  type HelloReply,
  HelloSchema,
  type IgnoredSetting,
  type IpcError,
  IpcErrorCode,
  LineDecoder,
  type Op,
  PROTOCOL_VERSION,
  RequestSchema,
} from './protocol.js';
import { tokensMatch } from './token.js';

/** What to do with a relay running another build or configuration. */
export type MismatchDecision = 'restart' | 'accept';

export type IpcHandler = (
  op: Op,
  name: string | undefined,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface IpcServerOptions {
  endpoint: string;
  token: string;
  version: string;
  configHash: string;
  /** Per-setting digests of this process's identity settings (config-hash.ts). */
  configDigests?: Record<string, string>;
  /** The configuration file this process reads, told to relays whose settings are ignored. */
  configFile?: string;
  handler: IpcHandler;
  /** Maps a handler rejection to the error sent back. */
  toIpcError: (error: unknown) => IpcError;
  /**
   * A relay with another build (`version`) or configuration knocked: refuse
   * it so it waits for a restart (`restart`, the default), or serve it as it
   * is (`accept`). The owner restarts itself; this server only answers.
   */
  onMismatch?: (
    reason: 'version' | 'config',
    relayVersion: string,
    relayConfigHash: string,
  ) => MismatchDecision | undefined;
  /** Number of accepted relay connections changed. */
  onRelayCountChange?: (count: number) => void;
  log?: (level: 'info' | 'warn', message: string) => void;
}

/** How long a peer may stay connected without completing the handshake. */
const HELLO_TIMEOUT_MS = 5000;

export class IpcServer {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private relays = 0;
  /** Build of each accepted relay running another build than this process. */
  private readonly outdatedRelays = new Map<net.Socket, string>();
  /** What each accepted relay declared about its settings, for `status`. */
  private readonly relayConfigs = new Map<
    net.Socket,
    NonNullable<DaemonStatus['relayConfigs']>[number]
  >();
  private inFlight = 0;
  private draining = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly options: IpcServerOptions) {}

  /** Accepted relay connections (control connections excluded). */
  get relayCount(): number {
    return this.relays;
  }

  /** Builds of the connected relays that run another build than this process. */
  get outdatedRelayVersions(): string[] {
    return [...this.outdatedRelays.values()];
  }

  /** Each connected relay's declared provenance and the settings of it that are ignored. */
  get relayConfigList(): NonNullable<DaemonStatus['relayConfigs']> {
    return [...this.relayConfigs.values()];
  }

  /** Requests currently being handled. */
  get inFlightCount(): number {
    return this.inFlight;
  }

  /**
   * Binds the endpoint. `in-use` means another process holds it: the caller
   * lost the single-instance race. A Unix socket file left by a crashed
   * process is detected (nobody accepts on it) and replaced.
   */
  async listen(): Promise<'listening' | 'in-use'> {
    const first = await this.tryListen();
    if (first !== 'in-use' || process.platform === 'win32') {
      return first;
    }
    if (await isEndpointAlive(this.options.endpoint)) {
      return 'in-use';
    }
    rmSync(this.options.endpoint, { force: true });
    return this.tryListen();
  }

  private tryListen(): Promise<'listening' | 'in-use'> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.accept(socket));
      const onError = (error: NodeJS.ErrnoException): void => {
        server.close();
        if (error.code === 'EADDRINUSE') {
          resolve('in-use');
        } else {
          reject(error);
        }
      };
      server.once('error', onError);
      server.listen(this.options.endpoint, () => {
        server.off('error', onError);
        server.on('error', (error) => this.log('warn', `IPC server error: ${error.message}`));
        this.server = server;
        resolve('listening');
      });
    });
  }

  /**
   * Stops starting new work: new relays are told the process is draining and
   * new requests on open connections fail with a retryable error. Requests
   * already started run to completion.
   */
  setDraining(): void {
    this.draining = true;
  }

  /** Resolves once no request is in flight. */
  waitForIdle(): Promise<void> {
    if (this.inFlight === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Closes every connection and releases the endpoint. */
  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (process.platform !== 'win32' && existsSync(this.options.endpoint)) {
      rmSync(this.options.endpoint, { force: true });
    }
  }

  private log(level: 'info' | 'warn', message: string): void {
    this.options.log?.(level, message);
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    const decoder = new LineDecoder();
    let role: 'relay' | 'control' | null = null;

    const helloTimer = setTimeout(() => {
      this.log('warn', 'IPC peer did not complete the handshake in time; closing it');
      socket.destroy();
    }, HELLO_TIMEOUT_MS);

    socket.on('data', (chunk) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch (error) {
        this.log('warn', `Dropping IPC peer: ${error instanceof Error ? error.message : error}`);
        socket.destroy();
        return;
      }
      for (const message of messages) {
        if (role === null) {
          clearTimeout(helloTimer);
          role = this.handleHello(socket, message);
          if (role === null) {
            socket.end();
            return;
          }
          if (role === 'relay') {
            this.relays++;
            this.options.onRelayCountChange?.(this.relays);
          }
        } else {
          this.handleRequest(socket, message);
        }
      }
    });

    socket.on('error', () => {
      // A relay killed mid-write surfaces as EPIPE/ECONNRESET; 'close' follows.
    });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      this.sockets.delete(socket);
      this.outdatedRelays.delete(socket);
      this.relayConfigs.delete(socket);
      if (role === 'relay') {
        this.relays--;
        this.options.onRelayCountChange?.(this.relays);
      }
    });
  }

  /** Returns the accepted role, or `null` after sending a rejection. */
  private handleHello(socket: net.Socket, message: unknown): 'relay' | 'control' | null {
    const reject = (reason: Extract<HelloReply, { ok: false }>['reason'], text: string) => {
      write(socket, { type: 'hello', ok: false, reason, message: text } satisfies HelloReply);
      return null;
    };

    const parsed = HelloSchema.safeParse(message);
    if (!parsed.success) {
      return reject('protocol', 'Expected a hello message');
    }
    const hello = parsed.data;
    if (!tokensMatch(this.options.token, hello.token)) {
      this.log('warn', 'Rejected an IPC peer with an invalid token');
      return reject('unauthorized', 'Invalid token');
    }
    if (hello.protocol !== PROTOCOL_VERSION) {
      // Never a restart: the two builds cannot talk, and restarting would
      // not help an old client (it would only loop) — tell the user instead.
      const text = `Protocol ${hello.protocol} not supported (expected ${PROTOCOL_VERSION})`;
      if (hello.role !== 'relay') {
        return reject('protocol', text);
      }
      this.log(
        'warn',
        `Refused relay v${hello.version}: protocol ${hello.protocol}, this process speaks ${PROTOCOL_VERSION}`,
      );
      return reject(
        'protocol',
        compareBuilds(hello.version, this.options.version) === 'newer'
          ? `${text}: the shared process (v${this.options.version}) is older than this client. ` +
              'Run `foundryvtt-mcp stop` (or `node dist/index.js stop`); the next call starts the current build.'
          : `${text}: this MCP client runs an older connector build (v${hello.version}) than the ` +
              `shared process (v${this.options.version}). Restart the client (fully quit Claude desktop, or restart Claude Code).`,
      );
    }
    let outdated = false;
    let ignored: IgnoredSetting[] | null = [];
    if (hello.role === 'relay') {
      if (this.draining) {
        return reject('draining', 'The shared process is shutting down');
      }
      if (hello.version !== this.options.version) {
        if (this.options.onMismatch?.('version', hello.version, hello.configHash) === 'accept') {
          this.log(
            'warn',
            `Serving relay v${hello.version} although this process runs v${this.options.version}: restart that client to load the current tool list`,
          );
          outdated = true;
        } else {
          this.log(
            'info',
            `Relay version ${hello.version} differs from ${this.options.version}; restarting`,
          );
          return reject('version', `Shared process runs version ${this.options.version}`);
        }
      }
      if (hello.configHash !== this.options.configHash) {
        if (this.options.onMismatch?.('config', hello.version, hello.configHash) !== 'accept') {
          this.log('info', 'Relay configuration differs from this process; restarting');
          return reject('config', 'Shared process runs with a different configuration');
        }
        ignored = this.ignoredSettings(hello);
        this.log(
          'warn',
          `Serving relay${hello.pid ? ` ${hello.pid}` : ''} with this process's configuration; its own is ignored (${
            ignored === null
              ? 'a relay too old to say which settings differ'
              : ignored.map((s) => `${s.name} from ${s.source}`).join(', ')
          })`,
        );
      }
    }
    if (outdated) {
      this.outdatedRelays.set(socket, hello.version);
    }
    if (hello.role === 'relay') {
      this.relayConfigs.set(socket, {
        pid: hello.pid ?? null,
        version: hello.version,
        sources: hello.configSources ?? null,
        ignored,
      });
    }
    write(socket, {
      type: 'hello',
      ok: true,
      pid: process.pid,
      version: this.options.version,
      ...(ignored === null || ignored.length > 0
        ? {
            ignoredConfig: ignored ?? [],
            ...(this.options.configFile ? { configFile: this.options.configFile } : {}),
          }
        : {}),
    } satisfies HelloReply);
    return hello.role;
  }

  /** The relay's identity settings that differ from this process's; `null` when it cannot say. */
  private ignoredSettings(hello: Hello): IgnoredSetting[] | null {
    if (!hello.configDigests || !this.options.configDigests) {
      return null;
    }
    return differingSettings(this.options.configDigests, hello.configDigests).map((name) => ({
      name,
      source: hello.configSources?.[name] ?? 'default',
    }));
  }

  private handleRequest(socket: net.Socket, message: unknown): void {
    const parsed = RequestSchema.safeParse(message);
    if (!parsed.success) {
      const id =
        typeof message === 'object' && message !== null && 'id' in message ? message.id : null;
      if (typeof id === 'number') {
        write(socket, {
          type: 'response',
          id,
          error: { code: IpcErrorCode.InvalidRequest, message: 'Malformed request' },
        });
      }
      return;
    }
    const { id, op, name, args } = parsed.data;
    if (this.draining && op !== 'status') {
      write(socket, {
        type: 'response',
        id,
        error: { code: IpcErrorCode.Draining, message: 'The shared process is shutting down' },
      });
      return;
    }

    this.inFlight++;
    // The handler runs to completion even if the relay goes away; the
    // result is then simply dropped (a write is never cut in half).
    this.options
      .handler(op, name, args ?? {})
      .then(
        (result) => write(socket, { type: 'response', id, result: result ?? null }),
        (error: unknown) =>
          write(socket, { type: 'response', id, error: this.options.toIpcError(error) }),
      )
      .finally(() => {
        this.inFlight--;
        if (this.inFlight === 0) {
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          for (const resolve of waiters) {
            resolve();
          }
        }
      });
  }
}

function write(socket: net.Socket, message: unknown): void {
  if (!socket.destroyed && socket.writable) {
    socket.write(encodeLine(message));
  }
}

/** True when something accepts connections on `endpoint`. */
export function isEndpointAlive(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(endpoint);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}
