/**
 * WebSocket client that dials into the foundryvtt-mcp server's module bridge.
 *
 * Ported from alexivenkov/foundry-api-bridge-module (MIT), WebSocketClient.ts,
 * adapted to plain browser JS and this module's `{id,type,params}` /
 * `{id,result}` / `{id,error}` wire shape (server: src/foundry/module-bridge.ts).
 *
 * Every connection starts with a mutual handshake (protocol v1): the server
 * sends `auth_challenge`, the module answers with the proof computed by
 * `credentials.prove()` (the headless GM session's `window.foundryMcpBridge`),
 * and the server's `auth_ok` must carry the proof `prove()` predicted. Until
 * then no command is executed and no event is sent; any deviation closes the
 * socket and falls back to the usual reconnect cycle.
 */

const WS_OPEN = 1;
const DEFAULT_RECONNECT_INTERVAL_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 10;

export const PROTOCOL_VERSION = 1;
/** Close code sent when the server fails the handshake. */
const CLOSE_UNAUTHORIZED = 4401;

/**
 * @typedef {object} BridgeCredentials
 * @property {(serverNonce: string) => Promise<{nonce: string, clientProof: string, serverProof: string}>} prove
 */

export class BridgeTransport {
  /**
   * @param {string} url
   * @param {(type: string, params: Record<string, unknown>) => Promise<unknown>} onCommand
   * @param {BridgeCredentials} credentials
   */
  constructor(url, onCommand, credentials) {
    this.url = url;
    this.onCommand = onCommand;
    this.credentials = credentials;
    /** @type {WebSocket | null} */
    this.socket = null;
    /** @type {'challenge' | 'proving' | 'confirming' | 'authenticated'} */
    this.authState = 'challenge';
    /** @type {string | null} */
    this.expectedServerProof = null;
    this.reconnectAttempts = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.reconnectTimer = null;
    this.manualClose = false;
  }

  get authenticated() {
    return this.authState === 'authenticated' && this.socket?.readyState === WS_OPEN;
  }

  connect() {
    if (this.socket?.readyState === WS_OPEN) return;
    this.manualClose = false;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    this.authState = 'challenge';
    this.expectedServerProof = null;

    socket.onopen = () => {
      console.log(`FoundryVTT MCP Bridge | connected to ${this.url}, authenticating`);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      console.log('FoundryVTT MCP Bridge | disconnected');
      this.authState = 'challenge';
      this.expectedServerProof = null;
      if (!this.manualClose) this.scheduleReconnect();
    };
    socket.onerror = (event) => {
      console.error('FoundryVTT MCP Bridge | socket error', event);
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.handleMessage(socket, event);
    };
  }

  disconnect() {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  /**
   * @param {WebSocket} socket
   * @param {MessageEvent} event
   */
  async handleMessage(socket, event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      if (this.authState !== 'authenticated') {
        this.failAuth(socket, 'non-JSON message during the handshake');
        return;
      }
      console.error('FoundryVTT MCP Bridge | received non-JSON message');
      return;
    }
    if (this.authState !== 'authenticated') {
      await this.handleHandshake(socket, msg);
      return;
    }
    if (!msg || typeof msg.id !== 'string' || typeof msg.type !== 'string') {
      console.error('FoundryVTT MCP Bridge | received malformed command', msg);
      return;
    }
    try {
      const result = await this.onCommand(msg.type, msg.params ?? {});
      this.send({ id: msg.id, result });
    } catch (error) {
      this.send({ id: msg.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * @param {WebSocket} socket
   * @param {any} msg
   */
  async handleHandshake(socket, msg) {
    if (this.authState === 'challenge' && msg?.type === 'auth_challenge') {
      if (msg.protocol !== PROTOCOL_VERSION) {
        this.failAuth(socket, `unsupported bridge protocol ${JSON.stringify(msg.protocol)}`);
        return;
      }
      this.authState = 'proving';
      let proof;
      try {
        proof = await this.credentials.prove(msg.nonce);
      } catch (error) {
        this.failAuth(socket, `could not answer the challenge: ${error?.message ?? error}`);
        return;
      }
      if (this.socket !== socket || this.authState !== 'proving') return;
      this.expectedServerProof = proof.serverProof;
      this.authState = 'confirming';
      socket.send(
        JSON.stringify({
          type: 'auth_response',
          protocol: PROTOCOL_VERSION,
          nonce: proof.nonce,
          proof: proof.clientProof,
        }),
      );
      return;
    }
    if (this.authState === 'confirming' && msg?.type === 'auth_ok') {
      if (typeof msg.proof !== 'string' || msg.proof !== this.expectedServerProof) {
        this.failAuth(socket, 'the server failed to prove its identity');
        return;
      }
      this.authState = 'authenticated';
      this.expectedServerProof = null;
      this.reconnectAttempts = 0;
      console.log('FoundryVTT MCP Bridge | authenticated');
      return;
    }
    this.failAuth(socket, `unexpected ${JSON.stringify(msg?.type)} message during the handshake`);
  }

  /**
   * Drops a connection whose handshake went wrong; `onclose` then schedules
   * the usual reconnect.
   *
   * @param {WebSocket} socket
   * @param {string} reason
   */
  failAuth(socket, reason) {
    console.warn(`FoundryVTT MCP Bridge | handshake failed: ${reason}`);
    this.authState = 'challenge';
    this.expectedServerProof = null;
    socket.close(CLOSE_UNAUTHORIZED, 'unauthorized');
  }

  /** @param {{id: string, result?: unknown, error?: string}} response */
  send(response) {
    if (!this.authenticated) {
      console.warn('FoundryVTT MCP Bridge | cannot respond, bridge not connected');
      return;
    }
    this.socket.send(JSON.stringify(response));
  }

  /**
   * Pushes an unsolicited `{event, payload}` message — canvas activity
   * (targeting, pings) the bridge has no outstanding request for. Silently
   * no-ops until authenticated: a Foundry hook firing during a dropped
   * connection must never throw back into Foundry's own event dispatch.
   *
   * @param {string} event
   * @param {Record<string, unknown>} payload
   */
  sendEvent(event, payload) {
    if (!this.authenticated) return;
    this.socket.send(JSON.stringify({ event, payload }));
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn('FoundryVTT MCP Bridge | max reconnect attempts reached');
      return;
    }
    this.reconnectAttempts++;
    const delay = DEFAULT_RECONNECT_INTERVAL_MS * 2 ** (this.reconnectAttempts - 1);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
