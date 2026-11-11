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
 * new *authenticated* connection replaces the previous one.
 *
 * Authentication (protocol v1). The loopback listener is reachable by every
 * local process and every page open in a local browser, so a connection is
 * only trusted once it has proven it is the module running in the headless
 * GM session ({@link HeadlessGmSession}), and the module only obeys once the
 * server has proven it is this process:
 *
 * 1. Upgrade: the `Origin` header must be `FOUNDRY_URL`'s origin (HTTP 403
 *    otherwise), so a page from any other site cannot even open the socket.
 * 2. Server → module `{type: "auth_challenge", protocol: 1, nonce: Ns}`.
 * 3. Module → server `{type: "auth_response", protocol: 1, nonce: Nc, proof: Pc}`.
 * 4. Server → module `{type: "auth_ok", proof: Ps}`.
 *
 * Both proofs are HMAC-SHA256 over the two nonces, keyed by a random secret
 * generated per instance that never leaves this class: the module obtains
 * `Nc`, `Pc` and the expected `Ps` from {@link ModuleBridge.prove}, which the
 * headless session exposes to its page through a Playwright binding. Until
 * step 3 checks out, a connection cannot replace the current module, receives
 * no command, and nothing it sends is processed.
 *
 * Since module 0.6.0, `auth_response` also carries `module: {version,
 * commands}`: the module's version and the commands it serves. The proofs do
 * not cover it; it only decides which commands the server tries to send (see
 * {@link ModuleBridge.send}). An older module omits it, and is then sent only
 * {@link LEGACY_COMMANDS}.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { isRecord } from '../utils/guards.js';
import { logger } from '../utils/logger.js';

/** Version of the authentication handshake spoken by this server. */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** Close codes sent to a connection that fails authentication. */
export const BRIDGE_CLOSE_CODES = {
  /** Wrong proof, unknown protocol version, or any other message before authenticating. */
  unauthorized: 4401,
  /** No `auth_response` within the authentication window. */
  authTimeout: 4408,
  /** A message larger than {@link MAX_PREAUTH_MESSAGE_BYTES} before authenticating. */
  messageTooBig: 1009,
} as const;

const NONCE_BYTES = 32;
/** Length of the base64 encoding of {@link NONCE_BYTES} bytes. */
const NONCE_BASE64_LENGTH = 44;
const AUTH_TIMEOUT_MS = 5000;
const MAX_PREAUTH_MESSAGE_BYTES = 4096;
const PROOF_LABEL = 'foundryvtt-mcp-bridge/v1';

/** The commands every module before 0.6.0 serves: all a module that announces none is sent. */
export const LEGACY_COMMANDS: readonly string[] = [
  'capture_scene',
  'get_document_schema',
  'search_compendium_content',
  'get_compendium_document',
  'roll_and_post',
  'set_target',
  'get_targets',
  'ping_canvas',
  'set_pause',
  'upload_asset',
];

/** The module version that first serves each command newer than {@link LEGACY_COMMANDS}. */
export const COMMAND_SINCE: Readonly<Record<string, string>> = {
  get_actor_stats: '0.6.0',
  toggle_status_effect: '0.6.0',
};

/**
 * Bounds of the `module` announcement in `auth_response`: at worst (100
 * names of 32 characters, a 64-character version) the message stays under
 * {@link MAX_PREAUTH_MESSAGE_BYTES}, so a full announcement cannot fail the handshake.
 */
const MAX_ANNOUNCED_VERSION_LENGTH = 64;
const MAX_ANNOUNCED_COMMANDS = 100;
const MAX_COMMAND_NAME_LENGTH = 32;
const COMMAND_NAME_PATTERN = /^[a-z_]+$/;

/** Refusal warnings logged per window; the rest are counted and summarised. */
const REFUSAL_LOG_LIMIT = 10;
const REFUSAL_LOG_WINDOW_MS = 60_000;

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

/** What the headless session hands the module through `window.foundryMcpBridge.prove`. */
export interface BridgeProof {
  /** Client nonce `Nc`, base64. */
  nonce: string;
  /** `Pc`, to send in `auth_response`. */
  clientProof: string;
  /** `Ps`, the proof `auth_ok` must carry. */
  serverProof: string;
}

/** Returned by `window.foundryMcpBridge.getInfo()`. */
export interface BridgeInfo {
  protocol: number;
  port: number;
}

export interface ModuleBridgeOptions {
  /** The only accepted `Origin`: the origin of `FOUNDRY_URL`, where the module's page is served. */
  expectedOrigin: string;
  requestTimeoutMs?: number;
  /** How long a connection may stay unauthenticated. */
  authTimeoutMs?: number;
  /** The module version installed in the world, for messages only; `null` when unknown. */
  installedModuleVersion?: () => string | null;
}

/** What the connected module announced in `auth_response`; `null` for what it did not. */
export interface ModuleAnnouncement {
  version: string | null;
  commands: string[] | null;
}

const NO_ANNOUNCEMENT: ModuleAnnouncement = { version: null, commands: null };

/**
 * Reads the optional `module` field of an authenticated `auth_response`.
 * A part that is absent or malformed is left `null`; a malformed one is
 * logged, and never fails the authentication.
 */
export function parseModuleAnnouncement(value: unknown): ModuleAnnouncement {
  if (value === undefined) {
    return NO_ANNOUNCEMENT;
  }
  if (!isRecord(value)) {
    logger.warn('Module bridge: ignoring a malformed module announcement');
    return NO_ANNOUNCEMENT;
  }
  let version: string | null = null;
  if (value.version !== undefined) {
    if (
      typeof value.version === 'string' &&
      value.version.length > 0 &&
      value.version.length <= MAX_ANNOUNCED_VERSION_LENGTH
    ) {
      version = value.version;
    } else {
      logger.warn('Module bridge: ignoring a malformed module version');
    }
  }
  let commands: string[] | null = null;
  if (value.commands !== undefined) {
    const list: unknown = value.commands;
    if (
      Array.isArray(list) &&
      list.length <= MAX_ANNOUNCED_COMMANDS &&
      list.every(
        (name) =>
          typeof name === 'string' &&
          name.length <= MAX_COMMAND_NAME_LENGTH &&
          COMMAND_NAME_PATTERN.test(name),
      )
    ) {
      commands = list.map(String);
    } else {
      logger.warn('Module bridge: ignoring a malformed module command list');
    }
  }
  return { version, commands };
}

function isBridgeMessage(value: unknown): value is BridgeMessage {
  return typeof value === 'object' && value !== null;
}

/** A canonical base64 encoding of exactly {@link NONCE_BYTES} bytes. */
function isNonce(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== NONCE_BASE64_LENGTH) {
    return false;
  }
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === NONCE_BYTES && bytes.toString('base64') === value;
}

function rawDataBytes(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.length, 0);
  }
  return data instanceof ArrayBuffer ? data.byteLength : data.length;
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString();
  }
  return data instanceof ArrayBuffer ? Buffer.from(data).toString() : data.toString();
}

/**
 * Logs connection refusals without letting a local process flood the log by
 * reconnecting in a loop: at most {@link REFUSAL_LOG_LIMIT} per window, then
 * one line with the count of the ones left out.
 */
class RefusalLog {
  private windowStart = 0;
  private logged = 0;
  private suppressed = 0;

  warn(message: string, meta: Record<string, unknown>): void {
    const now = Date.now();
    if (now - this.windowStart >= REFUSAL_LOG_WINDOW_MS) {
      if (this.suppressed > 0) {
        logger.warn(
          `Module bridge: ${this.suppressed} more refused connection(s) not logged in the last minute`,
        );
      }
      this.windowStart = now;
      this.logged = 0;
      this.suppressed = 0;
    }
    if (this.logged < REFUSAL_LOG_LIMIT) {
      this.logged++;
      logger.warn(message, meta);
    } else {
      this.suppressed++;
    }
  }
}

export class ModuleBridge {
  /** One listener per loopback address. */
  private servers: WebSocketServer[] = [];
  /** The authenticated module connection; unauthenticated ones are never stored here. */
  private socket: WebSocket | null = null;
  private connectedSince: Date | null = null;
  /** What the current module announced; reset when it disconnects. */
  private announcement: ModuleAnnouncement = NO_ANNOUNCEMENT;
  private pending = new Map<string, PendingRequest>();
  /** Callers of {@link waitUntilConnected}, woken by the next authentication. */
  private readonly connectionWaiters = new Set<(connected: boolean) => void>();
  private nextId = 1;
  private readonly port: number;
  private readonly expectedOrigin: string;
  private readonly requestTimeoutMs: number;
  private readonly authTimeoutMs: number;
  private readonly installedModuleVersion: () => string | null;
  /** HMAC key of the handshake. In memory only: never logged, persisted or returned. */
  private readonly secret = randomBytes(32);
  private readonly refusals = new RefusalLog();
  /**
   * Invoked for every unsolicited `{event, payload}` push from the module —
   * canvas activity (targeting, pings) that never crosses FoundryVTT's own
   * `modifyDocument` Socket.IO channel. `null` when nobody is listening.
   */
  onEvent: ((type: string, payload: Record<string, unknown>) => void) | null = null;

  constructor(port: number, options: ModuleBridgeOptions) {
    this.port = port;
    this.expectedOrigin = options.expectedOrigin;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15000;
    this.authTimeoutMs = options.authTimeoutMs ?? AUTH_TIMEOUT_MS;
    this.installedModuleVersion = options.installedModuleVersion ?? (() => null);
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
      const wss = new WebSocketServer({
        host,
        port: this.port,
        verifyClient: (info, done) => {
          if (info.origin === this.expectedOrigin) {
            done(true);
            return;
          }
          this.refusals.warn('Module bridge refused a connection: unexpected Origin', {
            origin: info.origin ?? '(none)',
            remoteAddress: info.req.socket.remoteAddress,
          });
          done(false, 403, 'Forbidden');
        },
      });

      wss.once('listening', () => {
        this.servers.push(wss);
        resolve();
      });
      wss.once('error', (err: Error) => {
        wss.close();
        reject(err);
      });

      wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    });
  }

  /**
   * Challenges a fresh connection. It only becomes the module connection —
   * replacing the previous one — once its `auth_response` checks out.
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const remoteAddress = req.socket.remoteAddress;
    const serverNonce = randomBytes(NONCE_BYTES).toString('base64');
    let authenticated = false;
    let refused = false;

    const refuse = (code: number, reason: string, detail: string): void => {
      refused = true;
      clearTimeout(authTimer);
      this.refusals.warn(`Module bridge refused a connection: ${detail}`, { remoteAddress });
      ws.close(code, reason);
    };

    const authTimer = setTimeout(
      () =>
        refuse(
          BRIDGE_CLOSE_CODES.authTimeout,
          'authentication timeout',
          `client did not authenticate within ${this.authTimeoutMs} ms; likely an outdated ` +
            'foundryvtt-mcp-bridge module (< 0.5.0), redeploy it',
        ),
      this.authTimeoutMs,
    );

    ws.on('message', (data) => {
      if (authenticated) {
        // A replaced module may still be sending until its socket closes.
        if (this.socket === ws) {
          this.handleMessage(rawDataText(data));
        }
        return;
      }
      if (refused) {
        return;
      }
      if (rawDataBytes(data) > MAX_PREAUTH_MESSAGE_BYTES) {
        refuse(
          BRIDGE_CLOSE_CODES.messageTooBig,
          'message too big',
          `message over ${MAX_PREAUTH_MESSAGE_BYTES} bytes before authentication`,
        );
        return;
      }
      const verdict = this.checkAuthResponse(rawDataText(data), serverNonce);
      if (!verdict.ok) {
        refuse(BRIDGE_CLOSE_CODES.unauthorized, 'unauthorized', verdict.reason);
        return;
      }
      authenticated = true;
      clearTimeout(authTimer);
      ws.send(JSON.stringify({ type: 'auth_ok', proof: verdict.serverProof }));
      this.adopt(ws, remoteAddress, parseModuleAnnouncement(verdict.module));
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (this.socket === ws) {
        logger.warn('Foundry module disconnected from bridge');
        this.socket = null;
        this.connectedSince = null;
        this.announcement = NO_ANNOUNCEMENT;
      }
    });
    ws.on('error', (err) => {
      logger.error('Module bridge socket error', { error: err.message });
    });

    ws.send(
      JSON.stringify({
        type: 'auth_challenge',
        protocol: BRIDGE_PROTOCOL_VERSION,
        nonce: serverNonce,
      }),
    );
  }

  /** Makes an authenticated connection the module connection. */
  private adopt(
    ws: WebSocket,
    remoteAddress: string | undefined,
    announcement: ModuleAnnouncement,
  ): void {
    const previous = this.socket;
    this.socket = ws;
    this.connectedSince = new Date();
    this.announcement = announcement;
    if (previous) {
      // e.g. the headless page reloaded before its old socket closed.
      previous.terminate();
      logger.info('Foundry module re-authenticated; previous module connection replaced', {
        remoteAddress,
      });
    } else {
      logger.info(
        `Foundry module connected and authenticated (protocol v${BRIDGE_PROTOCOL_VERSION})`,
        { remoteAddress, moduleVersion: announcement.version ?? '(not announced)' },
      );
    }
    this.wakeConnectionWaiters(true);
  }

  private wakeConnectionWaiters(connected: boolean): void {
    for (const wake of [...this.connectionWaiters]) {
      wake(connected);
    }
  }

  /**
   * Waits until an authenticated module is connected.
   *
   * @returns true once connected, false when `timeoutMs` ran out first or the bridge stopped
   */
  waitUntilConnected(timeoutMs: number): Promise<boolean> {
    if (this.isConnected()) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const wake = (connected: boolean) => {
        clearTimeout(timer);
        this.connectionWaiters.delete(wake);
        resolve(connected);
      };
      const timer = setTimeout(() => wake(false), timeoutMs);
      this.connectionWaiters.add(wake);
    });
  }

  private checkAuthResponse(
    raw: string,
    serverNonce: string,
  ): { ok: true; serverProof: string; module: unknown } | { ok: false; reason: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'non-JSON message before authentication' };
    }
    if (!isRecord(parsed) || parsed.type !== 'auth_response') {
      return { ok: false, reason: 'message other than auth_response before authentication' };
    }
    if (parsed.protocol !== BRIDGE_PROTOCOL_VERSION) {
      return {
        ok: false,
        reason: `unsupported bridge protocol ${JSON.stringify(parsed.protocol)} (expected ${BRIDGE_PROTOCOL_VERSION})`,
      };
    }
    if (!isNonce(parsed.nonce) || typeof parsed.proof !== 'string') {
      return { ok: false, reason: 'malformed auth_response' };
    }
    const expected = this.hmac('client', serverNonce, parsed.nonce);
    const received = Buffer.from(parsed.proof, 'base64');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return { ok: false, reason: 'wrong authentication proof' };
    }
    return {
      ok: true,
      serverProof: this.hmac('server', serverNonce, parsed.nonce).toString('base64'),
      module: parsed.module,
    };
  }

  private hmac(role: 'client' | 'server', serverNonce: string, clientNonce: string): Buffer {
    return createHmac('sha256', this.secret)
      .update(`${PROOF_LABEL}|${role}|${serverNonce}|${clientNonce}`)
      .digest();
  }

  /**
   * Answers a server challenge on the module's behalf: picks the client
   * nonce and computes both proofs. Called from the headless session's page
   * binding, so `serverNonce` is untrusted input.
   *
   * @throws if `serverNonce` is not the base64 of {@link NONCE_BYTES} bytes
   */
  prove(serverNonce: unknown): BridgeProof {
    if (!isNonce(serverNonce)) {
      throw new Error('Invalid server nonce');
    }
    const nonce = randomBytes(NONCE_BYTES).toString('base64');
    return {
      nonce,
      clientProof: this.hmac('client', serverNonce, nonce).toString('base64'),
      serverProof: this.hmac('server', serverNonce, nonce).toString('base64'),
    };
  }

  /** What the module needs to dial in: the protocol and this bridge's port. */
  info(): BridgeInfo {
    return { protocol: BRIDGE_PROTOCOL_VERSION, port: this.port };
  }

  async stop(): Promise<void> {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Module bridge shutting down'));
    }
    this.pending.clear();
    this.wakeConnectionWaiters(false);
    this.socket?.close();
    this.socket = null;
    this.connectedSince = null;
    this.announcement = NO_ANNOUNCEMENT;
    const servers = this.servers;
    this.servers = [];
    await Promise.all(
      servers.map(
        (wss) =>
          new Promise<void>((resolve, reject) => {
            // Unauthenticated connections are not tracked here; close them too.
            for (const client of wss.clients) {
              client.terminate();
            }
            wss.close((err) => (err ? reject(err) : resolve()));
          }),
      ),
    );
  }

  /** True once {@link start} has bound the port, until {@link stop}. */
  isListening(): boolean {
    return this.servers.length > 0;
  }

  /** True while an authenticated module is connected. */
  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** When the current authenticated module connection was established, or `null`. */
  moduleConnectedSince(): Date | null {
    return this.isConnected() ? this.connectedSince : null;
  }

  /** What the connected module announced; all `null` while none is connected. */
  moduleAnnouncement(): ModuleAnnouncement {
    return this.isConnected() ? this.announcement : NO_ANNOUNCEMENT;
  }

  /** The module version installed in the world, as the connector's cache has it. */
  moduleInstalledVersion(): string | null {
    return this.installedModuleVersion();
  }

  /**
   * The connected module's version for display: the announced one, otherwise
   * `<installed or unknown> (not announced)`.
   */
  describeModuleVersion(): string {
    return (
      this.moduleAnnouncement().version ??
      `${this.installedModuleVersion() ?? 'unknown'} (not announced)`
    );
  }

  /**
   * Whether the connected module serves `type`: one of the commands it
   * announced, or of {@link LEGACY_COMMANDS} when it announced none.
   */
  supports(type: string): boolean {
    return (this.moduleAnnouncement().commands ?? LEGACY_COMMANDS).includes(type);
  }

  /**
   * Sends a command to the connected module and awaits its response.
   *
   * @throws if no module is connected or the module does not serve `type`
   *   (see {@link supports}) — both before anything is sent — or if the
   *   module reports an error, or the request times out (the module hung).
   */
  send(type: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.isConnected() || !this.socket) {
      throw new Error(
        'No authenticated Foundry module connected to the bridge. Install and enable the companion module (0.5.0 or later), confirm FOUNDRY_MODULE_BRIDGE_ENABLED=true, and check that the headless GM session is logged in.',
      );
    }
    if (!this.supports(type)) {
      const version = this.announcement.version ?? this.installedModuleVersion() ?? 'unknown';
      const since = COMMAND_SINCE[type];
      const needed = since ? `the companion module ${since} or later` : 'a newer companion module';
      throw new Error(
        `this command needs ${needed}; the connected module (${version}) does not provide it`,
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
