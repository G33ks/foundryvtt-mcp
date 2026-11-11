/**
 * @fileoverview The companion module's `transport.js` (plain browser JS, no
 * build) run under Node, against the real {@link ModuleBridge} and against
 * fake servers that misbehave.
 *
 * The global `WebSocket` is the `ws` client: same event-handler API as the
 * browser's, and unlike Node's built-in one it can send the `Origin` header
 * the bridge checks.
 */

import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import { BridgeTransport } from '../../../foundry-module/scripts/transport.js';
import { ModuleBridge } from '../module-bridge.js';

const ORIGIN = 'http://localhost:30000';

class OriginWebSocket extends WsClient {
  constructor(url: string) {
    super(url, { origin: ORIGIN });
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not reached');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A server that plays the bridge's part in whatever way the test scripts. */
async function fakeServer(
  onClient: (client: {
    send: (message: unknown) => void;
    next: () => Promise<Record<string, unknown>>;
    received: Record<string, unknown>[];
    closed: Promise<number>;
  }) => Promise<void>,
) {
  const port = await freePort();
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  wss.on('connection', (ws) => {
    const received: Record<string, unknown>[] = [];
    const waiters: Array<(message: Record<string, unknown>) => void> = [];
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      received.push(message);
      waiters.shift()?.(message);
    });
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    void onClient({
      send: (message) => ws.send(JSON.stringify(message)),
      next: () => new Promise((resolve) => waiters.push(resolve)),
      received,
      closed,
    });
  });
  await new Promise((resolve) => wss.once('listening', resolve));
  servers.push(wss);
  return `ws://127.0.0.1:${port}`;
}

const NONCE = Buffer.alloc(32, 7).toString('base64');
const transports: BridgeTransport[] = [];
const servers: WebSocketServer[] = [];
const bridges: ModuleBridge[] = [];

beforeEach(() => {
  vi.stubGlobal('WebSocket', OriginWebSocket);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const transport of transports.splice(0)) {
    transport.disconnect();
  }
  for (const wss of servers.splice(0)) {
    for (const client of wss.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wss.close(resolve));
  }
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function transportFor(
  url: string,
  prove: (serverNonce: string) => Promise<unknown>,
  onCommand = vi.fn(async () => 'done'),
  announcement: { version: string; commands: string[] } | null = null,
) {
  const transport = new BridgeTransport(url, onCommand, { prove }, announcement);
  transports.push(transport);
  transport.connect();
  return { transport, onCommand };
}

describe('companion transport against the real bridge', () => {
  it('authenticates, then runs commands and pushes events', async () => {
    const port = await freePort();
    const bridge = new ModuleBridge(port, { expectedOrigin: ORIGIN });
    bridges.push(bridge);
    await bridge.start();
    const onEvent = vi.fn();
    bridge.onEvent = onEvent;

    const { transport, onCommand } = transportFor(`ws://localhost:${port}`, async (nonce) =>
      bridge.prove(nonce),
    );
    await waitFor(() => bridge.isConnected() && transport.authenticated);

    await expect(bridge.send('get_targets', { x: 1 })).resolves.toBe('done');
    expect(onCommand).toHaveBeenCalledWith('get_targets', { x: 1 });

    transport.sendEvent('target_token', { tokenId: 't1' });
    await waitFor(() => onEvent.mock.calls.length > 0);
    expect(onEvent).toHaveBeenCalledWith('target_token', { tokenId: 't1' });
  });
});

describe('companion transport module announcement', () => {
  it('announces its version and commands to the real bridge', async () => {
    const port = await freePort();
    const bridge = new ModuleBridge(port, { expectedOrigin: ORIGIN });
    bridges.push(bridge);
    await bridge.start();

    const { transport } = transportFor(
      `ws://localhost:${port}`,
      async (nonce) => bridge.prove(nonce),
      undefined,
      { version: '0.6.0', commands: ['get_targets', 'set_pause'] },
    );
    await waitFor(() => bridge.isConnected() && transport.authenticated);

    expect(bridge.moduleAnnouncement()).toEqual({
      version: '0.6.0',
      commands: ['get_targets', 'set_pause'],
    });
    expect(() => bridge.send('capture_scene')).toThrow(
      "the connected companion module (0.6.0) does not provide 'capture_scene'",
    );
  });

  it('sends `module` in auth_response, and nothing without an announcement', async () => {
    const responses: Record<string, unknown>[] = [];
    const url = await fakeServer(async (c) => {
      c.send({ type: 'auth_challenge', protocol: 1, nonce: NONCE });
      responses.push(await c.next());
    });
    const prove = async () => ({ nonce: NONCE, clientProof: 'p', serverProof: 's' });
    transportFor(url, prove, undefined, { version: '0.6.0', commands: ['get_targets'] });
    transportFor(url, prove);
    await waitFor(() => responses.length === 2);

    const announced = responses.find((r) => 'module' in r);
    expect(announced?.module).toEqual({ version: '0.6.0', commands: ['get_targets'] });
    expect(responses.filter((r) => !('module' in r))).toHaveLength(1);
  });

  it('keeps a full announcement under the bridge limit before authentication', async () => {
    const port = await freePort();
    const bridge = new ModuleBridge(port, { expectedOrigin: ORIGIN });
    bridges.push(bridge);
    await bridge.start();
    let sent = 0;
    const announcement = {
      version: 'v'.repeat(64),
      commands: Array.from({ length: 100 }, () => 'c'.repeat(32)),
    };
    const { transport } = transportFor(
      `ws://localhost:${port}`,
      async (nonce) => {
        const proof = bridge.prove(nonce);
        sent = Buffer.byteLength(
          JSON.stringify({
            type: 'auth_response',
            protocol: 1,
            nonce: proof.nonce,
            proof: proof.clientProof,
            module: announcement,
          }),
        );
        return proof;
      },
      undefined,
      announcement,
    );
    await waitFor(() => bridge.isConnected() && transport.authenticated);

    expect(sent).toBeLessThan(4096);
    expect(bridge.moduleAnnouncement().commands).toHaveLength(100);
  });
});

describe('companion transport against a fake server', () => {
  it('refuses an auth_ok with the wrong proof and runs no command after it', async () => {
    let closed: Promise<number> | undefined;
    const url = await fakeServer(async (client) => {
      closed = client.closed;
      client.send({ type: 'auth_challenge', protocol: 1, nonce: NONCE });
      await client.next();
      client.send({ type: 'auth_ok', proof: 'forged' });
      client.send({ id: '1', type: 'set_pause', params: { paused: true } });
    });
    const prove = vi.fn(async () => ({ nonce: 'Nc', clientProof: 'Pc', serverProof: 'Ps' }));
    const { transport, onCommand } = transportFor(url, prove);

    await waitFor(() => closed !== undefined);
    expect(await closed).toBe(4401);
    expect(prove).toHaveBeenCalledWith(NONCE);
    expect(onCommand).not.toHaveBeenCalled();
    expect(transport.authenticated).toBe(false);
    // Back to the usual reconnect cycle. The client's onclose, which arms the
    // timer, can run after the server has already seen the close.
    await waitFor(() => transport.reconnectTimer !== null);
  });

  it('runs no command sent before auth_ok', async () => {
    let closed: Promise<number> | undefined;
    let received: Record<string, unknown>[] = [];
    const url = await fakeServer(async (client) => {
      closed = client.closed;
      received = client.received;
      client.send({ type: 'auth_challenge', protocol: 1, nonce: NONCE });
      await client.next();
      client.send({ id: '1', type: 'upload_asset', params: {} });
    });
    const { onCommand } = transportFor(url, async () => ({
      nonce: 'Nc',
      clientProof: 'Pc',
      serverProof: 'Ps',
    }));

    await waitFor(() => closed !== undefined);
    expect(await closed).toBe(4401);
    expect(onCommand).not.toHaveBeenCalled();
    expect(received.map((m) => m.type)).toEqual(['auth_response']);
  });

  it('runs no command sent instead of a challenge', async () => {
    let closed: Promise<number> | undefined;
    const url = await fakeServer(async (client) => {
      closed = client.closed;
      client.send({ id: '1', type: 'set_pause', params: {} });
    });
    const prove = vi.fn();
    const { onCommand } = transportFor(url, prove);

    await waitFor(() => closed !== undefined);
    expect(await closed).toBe(4401);
    expect(prove).not.toHaveBeenCalled();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('closes on an unknown protocol version without calling prove', async () => {
    let closed: Promise<number> | undefined;
    const url = await fakeServer(async (client) => {
      closed = client.closed;
      client.send({ type: 'auth_challenge', protocol: 2, nonce: NONCE });
    });
    const prove = vi.fn();
    transportFor(url, prove);

    await waitFor(() => closed !== undefined);
    expect(await closed).toBe(4401);
    expect(prove).not.toHaveBeenCalled();
  });

  it('closes when prove rejects', async () => {
    let closed: Promise<number> | undefined;
    let received: Record<string, unknown>[] = [];
    const url = await fakeServer(async (client) => {
      closed = client.closed;
      received = client.received;
      client.send({ type: 'auth_challenge', protocol: 1, nonce: 'not a nonce' });
    });
    transportFor(url, async () => {
      throw new Error('Invalid server nonce');
    });

    await waitFor(() => closed !== undefined);
    expect(await closed).toBe(4401);
    expect(received).toEqual([]);
  });

  it('sends no event before it is authenticated', async () => {
    let received: Record<string, unknown>[] = [];
    let challenged = false;
    const url = await fakeServer(async (client) => {
      received = client.received;
      client.send({ type: 'auth_challenge', protocol: 1, nonce: NONCE });
      challenged = true;
    });
    const { transport } = transportFor(url, async () => ({
      nonce: 'Nc',
      clientProof: 'Pc',
      serverProof: 'Ps',
    }));
    await waitFor(() => challenged && received.length === 1);

    transport.sendEvent('target_token', { tokenId: 't1' });
    transport.send({ id: '1', result: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.map((m) => m.type)).toEqual(['auth_response']);
  });
});
