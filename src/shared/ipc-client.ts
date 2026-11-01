/**
 * @fileoverview Client side of the relay ↔ shared-process channel.
 */

import net from 'node:net';
import {
  encodeLine,
  type Hello,
  type HelloRejectReason,
  HelloReplySchema,
  type IpcError,
  LineDecoder,
  type Op,
  ResponseSchema,
} from './protocol.js';

/** Nothing listens on the endpoint (no shared process, or it just exited). */
export class EndpointUnavailableError extends Error {
  constructor(
    readonly endpoint: string,
    cause: unknown,
  ) {
    super(`No shared process listening on ${endpoint}`, { cause });
    this.name = 'EndpointUnavailableError';
  }
}

/** The shared process answered the handshake with a refusal. */
export class HandshakeRejectedError extends Error {
  constructor(
    readonly reason: HelloRejectReason,
    message: string,
  ) {
    super(message);
    this.name = 'HandshakeRejectedError';
  }
}

/** The connection closed while a request was pending. */
export class ConnectionLostError extends Error {
  constructor() {
    super('Connection to the shared process was lost');
    this.name = 'ConnectionLostError';
  }
}

/** The shared process answered a request with an error. */
export class RemoteError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: IpcError) {
    super(error.message);
    this.name = 'RemoteError';
    this.code = error.code;
    this.data = error.data;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** How long the shared process may take to answer the handshake. */
const HELLO_TIMEOUT_MS = 5000;

export class IpcConnection {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private readonly closeListeners: Array<() => void> = [];

  /** pid reported by the shared process at the handshake. */
  readonly serverPid: number;

  private constructor(
    private readonly socket: net.Socket,
    serverPid: number,
  ) {
    this.serverPid = serverPid;
  }

  /**
   * Connects and performs the handshake.
   *
   * @throws {EndpointUnavailableError} nothing listens on `endpoint`
   * @throws {HandshakeRejectedError} the shared process refused the hello
   */
  static connect(endpoint: string, hello: Hello): Promise<IpcConnection> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(endpoint);
      const decoder = new LineDecoder();
      let connection: IpcConnection | null = null;
      let settled = false;

      const fail = (error: Error): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          reject(error);
        }
      };
      const timer = setTimeout(
        () => fail(new Error(`Shared process did not answer the handshake on ${endpoint}`)),
        HELLO_TIMEOUT_MS,
      );

      socket.once('connect', () => socket.write(encodeLine(hello)));
      socket.on('error', (error) => {
        if (!settled) {
          fail(new EndpointUnavailableError(endpoint, error));
        }
      });
      socket.on('close', () => {
        if (connection) {
          connection.handleClose();
        } else {
          fail(new ConnectionLostError());
        }
      });
      socket.on('data', (chunk) => {
        let messages: unknown[];
        try {
          messages = decoder.push(chunk);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          connection?.socket.destroy();
          return;
        }
        for (const message of messages) {
          if (connection) {
            connection.handleMessage(message);
            continue;
          }
          const reply = HelloReplySchema.safeParse(message);
          if (!reply.success) {
            fail(new Error('Invalid handshake reply from the shared process'));
            return;
          }
          if (!reply.data.ok) {
            fail(new HandshakeRejectedError(reply.data.reason, reply.data.message));
            return;
          }
          settled = true;
          clearTimeout(timer);
          connection = new IpcConnection(socket, reply.data.pid);
          resolve(connection);
        }
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Registers a callback for when the connection closes. */
  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  /**
   * Sends one request. No client-side timeout: the shared process bounds
   * every operation itself, and a relay must never give up earlier than it.
   *
   * @throws {RemoteError} the shared process answered with an error
   * @throws {ConnectionLostError} the connection closed first
   */
  request(op: Op, name?: string, args?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new ConnectionLostError());
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(
        encodeLine({
          type: 'request',
          id,
          op,
          ...(name !== undefined ? { name } : {}),
          ...(args !== undefined ? { args } : {}),
        }),
      );
    });
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }

  private handleMessage(message: unknown): void {
    const parsed = ResponseSchema.safeParse(message);
    if (!parsed.success) {
      return;
    }
    const response = parsed.data;
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    if ('error' in response) {
      pending.reject(new RemoteError(response.error));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const [, pending] of this.pending) {
      pending.reject(new ConnectionLostError());
    }
    this.pending.clear();
    for (const listener of this.closeListeners) {
      listener();
    }
  }
}
