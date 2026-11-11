import { randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { logger } from '../../utils/logger.js';
import {
  BRIDGE_CLOSE_CODES,
  BRIDGE_PROTOCOL_VERSION,
  LEGACY_COMMANDS,
  ModuleBridge,
  parseModuleAnnouncement,
} from '../module-bridge.js';

const ORIGIN = 'http://localhost:30000';

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

/** Resolves `true` when a WebSocket opens on `url`, `false` when it is refused. */
function canConnect(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: 2000, origin: ORIGIN });
    ws.once('open', () => {
      ws.close();
      resolve(true);
    });
    ws.once('error', () => resolve(false));
  });
}

/** The HTTP status the upgrade was answered with, or 101 when it succeeded. */
function upgradeStatus(url: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin === undefined ? {} : { origin });
    ws.once('open', () => {
      ws.terminate();
      resolve(101);
    });
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once('error', (error) => {
      if (!error.message.includes('Unexpected server response')) {
        reject(error);
      }
    });
  });
}

function hasIpv6Loopback(): boolean {
  return Object.values(os.networkInterfaces()).some((addresses) =>
    addresses?.some((a) => a.family === 'IPv6' && a.address === '::1'),
  );
}

function lanAddress(): string | undefined {
  for (const addresses of Object.values(os.networkInterfaces())) {
    const lan = addresses?.find((a) => a.family === 'IPv4' && !a.internal);
    if (lan) {
      return lan.address;
    }
  }
  return undefined;
}

/** A module-side test client: queued JSON messages and the close it received. */
interface TestClient {
  ws: WebSocket;
  next(): Promise<Record<string, unknown>>;
  received: Record<string, unknown>[];
  closed: Promise<{ code: number; reason: string }>;
  send(message: unknown): void;
}

function openClient(port: number, origin = ORIGIN): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
    const received: Record<string, unknown>[] = [];
    const queue: Record<string, unknown>[] = [];
    const waiters: Array<(message: Record<string, unknown>) => void> = [];
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      received.push(message);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        queue.push(message);
      }
    });
    const closed = new Promise<{ code: number; reason: string }>((resolveClose) => {
      ws.once('close', (code, reason) => resolveClose({ code, reason: reason.toString() }));
    });
    ws.once('error', reject);
    ws.once('open', () =>
      resolve({
        ws,
        received,
        closed,
        next: () => {
          const queued = queue.shift();
          return queued
            ? Promise.resolve(queued)
            : new Promise((resolveNext) => waiters.push(resolveNext));
        },
        send: (message) => ws.send(typeof message === 'string' ? message : JSON.stringify(message)),
      }),
    );
  });
}

/**
 * Runs the module side of the handshake, the way the headless page binding
 * does; `extra` adds fields to `auth_response` (e.g. the `module` announcement).
 */
async function authenticate(
  bridge: ModuleBridge,
  client: TestClient,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const challenge = await client.next();
  const { nonce, clientProof, serverProof } = bridge.prove(challenge.nonce);
  client.send({
    type: 'auth_response',
    protocol: BRIDGE_PROTOCOL_VERSION,
    nonce,
    proof: clientProof,
    ...extra,
  });
  const ok = await client.next();
  expect(ok).toEqual({ type: 'auth_ok', proof: serverProof });
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

const bridges: ModuleBridge[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.ws.terminate();
  }
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
});

async function startBridge(
  port: number,
  options: { authTimeoutMs?: number; installedModuleVersion?: () => string | null } = {},
): Promise<ModuleBridge> {
  const bridge = new ModuleBridge(port, { expectedOrigin: ORIGIN, ...options });
  bridges.push(bridge);
  await bridge.start();
  return bridge;
}

async function client(port: number): Promise<TestClient> {
  const c = await openClient(port);
  clients.push(c);
  return c;
}

/** A bridge with one authenticated module connected; `extra` as for {@link authenticate}. */
async function bridgeWithModule(
  options: { authTimeoutMs?: number; installedModuleVersion?: () => string | null } = {},
  extra: Record<string, unknown> = {},
) {
  const port = await freePort();
  const bridge = await startBridge(port, options);
  const module = await client(port);
  await authenticate(bridge, module, extra);
  await waitFor(() => bridge.isConnected());
  return { port, bridge, module };
}

describe('ModuleBridge listening addresses', () => {
  it('accepts the module on localhost and 127.0.0.1', async () => {
    const port = await freePort();
    await startBridge(port);
    expect(await canConnect(`ws://127.0.0.1:${port}`)).toBe(true);
    expect(await canConnect(`ws://localhost:${port}`)).toBe(true);
  });

  it.runIf(hasIpv6Loopback())('accepts the module on ::1', async () => {
    const port = await freePort();
    await startBridge(port);
    expect(await canConnect(`ws://[::1]:${port}`)).toBe(true);
  });

  it.runIf(lanAddress() !== undefined)('is not reachable on a network interface', async () => {
    const port = await freePort();
    await startBridge(port);
    expect(await canConnect(`ws://${lanAddress()}:${port}`)).toBe(false);
  });

  it('reports a port already in use, and frees its port on stop', async () => {
    const port = await freePort();
    const first = await startBridge(port);
    await expect(new ModuleBridge(port, { expectedOrigin: ORIGIN }).start()).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });

    await first.stop();
    await expect(startBridge(port)).resolves.toBeInstanceOf(ModuleBridge);
  });
});

describe('ModuleBridge origin check', () => {
  it('refuses the upgrade without an Origin header', async () => {
    const port = await freePort();
    const bridge = await startBridge(port);
    expect(await upgradeStatus(`ws://127.0.0.1:${port}`)).toBe(403);
    expect(bridge.isConnected()).toBe(false);
  });

  it('refuses the upgrade from another origin', async () => {
    const port = await freePort();
    await startBridge(port);
    expect(await upgradeStatus(`ws://127.0.0.1:${port}`, 'http://evil.example')).toBe(403);
    expect(await upgradeStatus(`ws://127.0.0.1:${port}`, 'http://localhost:30001')).toBe(403);
  });

  it('accepts the upgrade from the Foundry origin', async () => {
    const port = await freePort();
    await startBridge(port);
    expect(await upgradeStatus(`ws://127.0.0.1:${port}`, ORIGIN)).toBe(101);
  });
});

describe('ModuleBridge handshake', () => {
  it('authenticates a module that answers the challenge, then relays commands', async () => {
    const port = await freePort();
    const bridge = await startBridge(port);
    const module = await client(port);

    const challenge = await module.next();
    expect(challenge).toMatchObject({ type: 'auth_challenge', protocol: 1 });
    expect(Buffer.from(String(challenge.nonce), 'base64')).toHaveLength(32);
    expect(bridge.isConnected()).toBe(false);

    const { nonce, clientProof, serverProof } = bridge.prove(challenge.nonce);
    module.send({ type: 'auth_response', protocol: 1, nonce, proof: clientProof });
    expect(await module.next()).toEqual({ type: 'auth_ok', proof: serverProof });
    await waitFor(() => bridge.isConnected());
    expect(bridge.moduleConnectedSince()).toBeInstanceOf(Date);

    const reply = bridge.send('get_targets', { a: 1 });
    const command = await module.next();
    expect(command).toMatchObject({ type: 'get_targets', params: { a: 1 } });
    module.send({ id: command.id, result: ['t1'] });
    await expect(reply).resolves.toEqual(['t1']);
  });

  it('closes with 4401 on a wrong proof', async () => {
    const port = await freePort();
    const bridge = await startBridge(port);
    const module = await client(port);
    const challenge = await module.next();
    const { nonce } = bridge.prove(challenge.nonce);
    module.send({
      type: 'auth_response',
      protocol: 1,
      nonce,
      proof: randomBytes(32).toString('base64'),
    });
    expect((await module.closed).code).toBe(BRIDGE_CLOSE_CODES.unauthorized);
    expect(bridge.isConnected()).toBe(false);
  });

  it('closes with 4401 on a proof made by another bridge instance', async () => {
    const port = await freePort();
    await startBridge(port);
    const other = new ModuleBridge(await freePort(), { expectedOrigin: ORIGIN });
    const module = await client(port);
    const challenge = await module.next();
    const { nonce, clientProof } = other.prove(challenge.nonce);
    module.send({ type: 'auth_response', protocol: 1, nonce, proof: clientProof });
    expect((await module.closed).code).toBe(4401);
  });

  it('closes with 4401 when an earlier response is replayed', async () => {
    const { port, bridge } = await bridgeWithModule();
    const first = await client(port);
    const firstChallenge = await first.next();
    const proof = bridge.prove(firstChallenge.nonce);

    const replay = await client(port);
    await replay.next();
    replay.send({
      type: 'auth_response',
      protocol: 1,
      nonce: proof.nonce,
      proof: proof.clientProof,
    });
    expect((await replay.closed).code).toBe(4401);
  });

  it('closes with 4401 on an unknown protocol version', async () => {
    const port = await freePort();
    const bridge = await startBridge(port);
    const module = await client(port);
    const challenge = await module.next();
    const { nonce, clientProof } = bridge.prove(challenge.nonce);
    module.send({ type: 'auth_response', protocol: 2, nonce, proof: clientProof });
    expect((await module.closed).code).toBe(4401);
  });

  it('closes with 4408 when the client never answers', async () => {
    const port = await freePort();
    const bridge = await startBridge(port, { authTimeoutMs: 150 });
    const module = await client(port);
    expect((await module.closed).code).toBe(BRIDGE_CLOSE_CODES.authTimeout);
    expect(module.received.map((m) => m.type)).toEqual(['auth_challenge']);
    expect(bridge.isConnected()).toBe(false);
  });

  it('closes with 1009 on an oversized message before authentication', async () => {
    const port = await freePort();
    await startBridge(port);
    const module = await client(port);
    await module.next();
    module.send({ type: 'auth_response', padding: 'x'.repeat(5000) });
    expect((await module.closed).code).toBe(BRIDGE_CLOSE_CODES.messageTooBig);
  });

  it('ignores a response or an event sent before authentication', async () => {
    const port = await freePort();
    const bridge = await startBridge(port);
    const onEvent = vi.fn();
    bridge.onEvent = onEvent;

    const withEvent = await client(port);
    await withEvent.next();
    withEvent.send({ event: 'target_token', payload: { tokenId: 't' } });
    expect((await withEvent.closed).code).toBe(4401);

    const withResponse = await client(port);
    await withResponse.next();
    withResponse.send({ id: '1', result: 'forged' });
    expect((await withResponse.closed).code).toBe(4401);

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('sends no command to an unauthenticated connection', async () => {
    const port = await freePort();
    const bridge = await startBridge(port);
    const pending = await client(port);
    await pending.next();
    expect(() => bridge.send('capture_scene')).toThrow(/No authenticated Foundry module/);
    expect(pending.received.map((m) => m.type)).toEqual(['auth_challenge']);
  });

  it('keeps the authenticated module when an unauthenticated connection comes and goes', async () => {
    const { port, bridge, module } = await bridgeWithModule({ authTimeoutMs: 150 });
    const since = bridge.moduleConnectedSince();

    const intruder = await client(port);
    await intruder.next();
    intruder.send({ id: '1', result: 'forged' });
    await intruder.closed;
    const silent = await client(port);
    await silent.closed;
    expect(await upgradeStatus(`ws://127.0.0.1:${port}`)).toBe(403);

    expect(bridge.isConnected()).toBe(true);
    expect(bridge.moduleConnectedSince()).toBe(since);
    const reply = bridge.send('get_targets');
    const command = await module.next();
    module.send({ id: command.id, result: 'from module' });
    await expect(reply).resolves.toBe('from module');
  });

  it('replaces the module with a newly authenticated connection', async () => {
    const { port, bridge, module: first } = await bridgeWithModule();
    const onEvent = vi.fn();
    bridge.onEvent = onEvent;

    const second = await client(port);
    await authenticate(bridge, second);
    await first.closed;
    await waitFor(() => bridge.isConnected());

    const reply = bridge.send('get_targets');
    const command = await second.next();
    second.send({ id: command.id, result: 'second' });
    await expect(reply).resolves.toBe('second');
  });
});

describe('ModuleBridge module announcement', () => {
  it('stores the version and commands a module announces, until it disconnects', async () => {
    const { bridge, module } = await bridgeWithModule(
      {},
      { module: { version: '0.6.0', commands: ['get_targets', 'new_command'] } },
    );
    expect(bridge.moduleAnnouncement()).toEqual({
      version: '0.6.0',
      commands: ['get_targets', 'new_command'],
    });
    expect(bridge.describeModuleVersion()).toBe('0.6.0');
    expect(bridge.supports('new_command')).toBe(true);
    expect(bridge.supports('capture_scene')).toBe(false);

    module.ws.close();
    await waitFor(() => !bridge.isConnected());
    expect(bridge.moduleAnnouncement()).toEqual({ version: null, commands: null });
  });

  it('accepts a module that announces nothing, and sends it only the legacy commands', async () => {
    const { bridge, module } = await bridgeWithModule({ installedModuleVersion: () => '0.5.2' });
    expect(bridge.moduleAnnouncement()).toEqual({ version: null, commands: null });
    expect(bridge.describeModuleVersion()).toBe('0.5.2 (not announced)');
    for (const command of LEGACY_COMMANDS) {
      expect(bridge.supports(command)).toBe(true);
    }
    expect(LEGACY_COMMANDS).toHaveLength(10);

    expect(() => bridge.send('get_actor_stats', {})).toThrow(
      "the connected companion module (0.5.2) does not provide 'get_actor_stats', which needs 0.6.0 or later",
    );
    const reply = bridge.send('get_targets');
    const command = await module.next();
    expect(command).toMatchObject({ type: 'get_targets' });
    module.send({ id: command.id, result: [] });
    await expect(reply).resolves.toEqual([]);
  });

  it('refuses a command the module did not announce, before sending anything', async () => {
    const { bridge, module } = await bridgeWithModule(
      {},
      { module: { version: '0.7.0-rc.1', commands: ['get_targets'] } },
    );
    expect(() => bridge.send('capture_scene')).toThrow(
      "the connected companion module (0.7.0-rc.1) does not provide 'capture_scene'",
    );
    expect(() => bridge.send('toggle_status_effect')).toThrow(
      "the connected companion module (0.7.0-rc.1) does not provide 'toggle_status_effect', which needs 0.6.0 or later",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(module.received.filter((m) => m.type === 'capture_scene')).toEqual([]);
  });

  it('names an unknown version when neither the module nor the world has one', async () => {
    const { bridge } = await bridgeWithModule();
    expect(bridge.describeModuleVersion()).toBe('unknown (not announced)');
    expect(() => bridge.send('get_actor_stats')).toThrow(
      /the connected companion module \(unknown\)/,
    );
  });

  it('still authenticates a module whose announcement is malformed, and ignores it', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const { bridge } = await bridgeWithModule({}, { module: { version: 7, commands: 'all' } });
    expect(bridge.isConnected()).toBe(true);
    expect(bridge.moduleAnnouncement()).toEqual({ version: null, commands: null });
    expect(bridge.supports('capture_scene')).toBe(true);
    expect(warn).toHaveBeenCalledWith('Module bridge: ignoring a malformed module version');
    expect(warn).toHaveBeenCalledWith('Module bridge: ignoring a malformed module command list');
    warn.mockRestore();
  });
});

describe('parseModuleAnnouncement', () => {
  it('reads nothing from an absent field, without a warning', () => {
    const warn = vi.spyOn(logger, 'warn');
    expect(parseModuleAnnouncement(undefined)).toEqual({ version: null, commands: null });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('ignores a field that is not an object', () => {
    expect(parseModuleAnnouncement('0.6.0')).toEqual({ version: null, commands: null });
    expect(parseModuleAnnouncement(null)).toEqual({ version: null, commands: null });
  });

  it('keeps each well-formed part on its own', () => {
    expect(parseModuleAnnouncement({ version: '0.6.0' })).toEqual({
      version: '0.6.0',
      commands: null,
    });
    expect(parseModuleAnnouncement({ version: '', commands: ['a_b'] })).toEqual({
      version: null,
      commands: ['a_b'],
    });
  });

  it('bounds the version and the command list', () => {
    expect(parseModuleAnnouncement({ version: 'v'.repeat(64) }).version).toBe('v'.repeat(64));
    expect(parseModuleAnnouncement({ version: 'v'.repeat(65) }).version).toBeNull();
    const hundred = Array.from({ length: 100 }, () => 'c'.repeat(32));
    expect(parseModuleAnnouncement({ commands: hundred }).commands).toHaveLength(100);
    expect(parseModuleAnnouncement({ commands: [...hundred, 'c'] }).commands).toBeNull();
    expect(parseModuleAnnouncement({ commands: ['c'.repeat(33)] }).commands).toBeNull();
    expect(parseModuleAnnouncement({ commands: ['Bad-Name'] }).commands).toBeNull();
    expect(parseModuleAnnouncement({ commands: [1] }).commands).toBeNull();
  });
});

describe('ModuleBridge.prove', () => {
  const bridge = new ModuleBridge(0, { expectedOrigin: ORIGIN });

  it('returns a fresh client nonce and both proofs', () => {
    const serverNonce = randomBytes(32).toString('base64');
    const a = bridge.prove(serverNonce);
    const b = bridge.prove(serverNonce);
    expect(Buffer.from(a.nonce, 'base64')).toHaveLength(32);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.clientProof).not.toBe(a.serverProof);
  });

  it.each([
    ['a non-string', 42],
    ['undefined', undefined],
    ['an empty string', ''],
    ['31 bytes', randomBytes(31).toString('base64')],
    ['33 bytes', randomBytes(33).toString('base64')],
    ['non-base64 text', '!'.repeat(44)],
    ['a non-canonical encoding', `${randomBytes(32).toString('base64').slice(0, 42)}B=`],
  ])('rejects %s', (_label, input) => {
    expect(() => bridge.prove(input)).toThrow('Invalid server nonce');
  });

  it('reports its protocol and port', () => {
    expect(new ModuleBridge(31415, { expectedOrigin: ORIGIN }).info()).toEqual({
      protocol: 1,
      port: 31415,
    });
  });
});

describe('ModuleBridge.waitUntilConnected', () => {
  it('answers at once when a module is connected', async () => {
    const { bridge } = await bridgeWithModule();
    await expect(bridge.waitUntilConnected(10)).resolves.toBe(true);
  });

  it('wakes up when a module authenticates', async () => {
    const port = await freePort();
    const bridge = await startBridge(port);
    const waiting = bridge.waitUntilConnected(5000);

    await authenticate(bridge, await client(port));

    await expect(waiting).resolves.toBe(true);
  });

  it('gives up after the timeout, and when the bridge stops', async () => {
    const port = await freePort();
    const bridge = await startBridge(port);
    await expect(bridge.waitUntilConnected(20)).resolves.toBe(false);

    const waiting = bridge.waitUntilConnected(5000);
    await bridge.stop();
    await expect(waiting).resolves.toBe(false);
  });
});
