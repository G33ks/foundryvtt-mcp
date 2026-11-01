/**
 * @fileoverview WebSocket relay to the companion Foundry module.
 *
 * FoundryVTT's own Socket.IO API (used by {@link FoundryClient}) only reaches
 * the document/database layer — it has no route to the browser's canvas,
 * PIXI, or `game.packs`. A handful of capabilities (scene screenshots, fog
 * reveal, compendium import) only exist inside a real, rendered browser tab.
 *
 * This class is the server side of that bridge: it hosts a plain WebSocket
 * server that the companion `foundry-module/` package (loaded into Foundry as
 * a module, running in the GM's browser) dials into as a client. Commands are
 * `{ id, type, params }`; responses are `{ id, result }` or `{ id, error }` —
 * the same shape used by alexivenkov/foundry-api-bridge-module's
 * `WebSocketClient.ts` (MIT), which this mirrors from the server side.
 *
 * Exactly one module connection is supported at a time (the GM's client); a
 * new connection replaces the previous one.
 */

import { WebSocket, WebSocketServer } from 'ws';
import { isRecord } from '../utils/guards.js';
import { logger } from '../utils/logger.js';

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/** A `{id, type, params}` command sent to the module, or `{id, result}` / `{id, error}` sent
 *  back, or an unsolicited `{event, payload}` push (e.g. canvas targeting). */
interface BridgeMessage {
  id?: unknown;
  type?: unknown;
  result?: unknown;
  error?: unknown;
  event?: unknown;
  payload?: unknown;
}

function isBridgeMessage(value: unknown): value is BridgeMessage {
  return typeof value === 'object' && value !== null;
}

export class ModuleBridge {
  /** One listener per loopback address. */
  private servers: WebSocketServer[] = [];
  private socket: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private readonly port: number;
  private readonly requestTimeoutMs: number;
  /**
   * Invoked for every unsolicited `{event, payload}` push from the module —
   * canvas activity (targeting, pings) that never crosses FoundryVTT's own
   * `modifyDocument` Socket.IO channel. `null` when nobody is listening.
   */
  onEvent: ((type: string, payload: Record<string, unknown>) => void) | null = null;

  constructor(port: number, requestTimeoutMs = 15000) {
    this.port = port;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /**
   * Starts the relay server and waits for it to be listening.
   *
   * Loopback only: the module dials `ws://localhost:<port>` from a browser
   * on this machine, and the bridge drives a GM session, so it must not be
   * reachable from the network. `localhost` may resolve to either family,
   * hence one listener on 127.0.0.1 and one on ::1 (skipped when IPv6 is
   * unavailable).
   */
  async start(): Promise<void> {
    await this.listenOn('127.0.0.1');
    try {
      await this.listenOn('::1');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRNOTAVAIL' && code !== 'EAFNOSUPPORT') {
        await this.stop();
        throw error;
      }
      logger.debug(`Module bridge: IPv6 loopback unavailable (${code}); IPv4 only`);
    }
    logger.info(`Module bridge listening on ws://localhost:${this.port} (loopback only)`);
  }

  private listenOn(host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host, port: this.port });

      wss.once('listening', () => {
        this.servers.push(wss);
        resolve();
      });
      wss.once('error', (err: Error) => {
        wss.close();
        reject(err);
      });

      wss.on('connection', (ws) => {
        logger.info('Foundry module connected to bridge');
        // A new connection (e.g. the GM reloaded) replaces the previous one.
        this.socket?.terminate();
        this.socket = ws;

        ws.on('message', (data) => this.handleMessage(data.toString()));
        ws.on('close', () => {
          logger.warn('Foundry module disconnected from bridge');
          if (this.socket === ws) {
            this.socket = null;
          }
        });
        ws.on('error', (err) => {
          logger.error('Module bridge socket error', { error: err.message });
        });
      });
    });
  }

  async stop(): Promise<void> {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Module bridge shutting down'));
    }
    this.pending.clear();
    this.socket?.close();
    this.socket = null;
    const servers = this.servers;
    this.servers = [];
    await Promise.all(
      servers.map(
        (wss) =>
          new Promise<void>((resolve, reject) => {
            wss.close((err) => (err ? reject(err) : resolve()));
          }),
      ),
    );
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Sends a command to the connected module and awaits its response.
   *
   * @throws if no module is connected, or the module reports an error, or
   *   the request times out (the module hung, or the command type is unknown
   *   to it).
   */
  send(type: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.isConnected() || !this.socket) {
      throw new Error(
        'No Foundry module connected to the bridge. Install and enable the companion module, and confirm FOUNDRY_MODULE_BRIDGE_ENABLED=true.',
      );
    }
    const id = String(this.nextId++);
    const socket = this.socket;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Module command '${type}' timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id, type, params }));
    });
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn('Module bridge received non-JSON message');
      return;
    }
    if (!isBridgeMessage(parsed)) {
      logger.warn('Module bridge received a message with no request id');
      return;
    }
    if (typeof parsed.id !== 'string') {
      if (typeof parsed.event === 'string') {
        this.onEvent?.(parsed.event, isRecord(parsed.payload) ? parsed.payload : {});
        return;
      }
      logger.warn('Module bridge received a message with no request id');
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) {
      // Late response to a request that already timed out, or an unsolicited message.
      return;
    }
    this.pending.delete(parsed.id);
    clearTimeout(pending.timeout);
    if (parsed.error !== undefined) {
      pending.reject(new Error(typeof parsed.error === 'string' ? parsed.error : 'Module error'));
    } else {
      pending.resolve(parsed.result);
    }
  }
}
