import net from 'node:net';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ModuleBridge } from '../module-bridge.js';

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
    const ws = new WebSocket(url, { handshakeTimeout: 2000 });
    ws.once('open', () => {
      ws.close();
      resolve(true);
    });
    ws.once('error', () => resolve(false));
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

const bridges: ModuleBridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
});

async function startBridge(port: number): Promise<ModuleBridge> {
  const bridge = new ModuleBridge(port);
  bridges.push(bridge);
  await bridge.start();
  return bridge;
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
    await expect(new ModuleBridge(port).start()).rejects.toMatchObject({ code: 'EADDRINUSE' });

    await first.stop();
    await expect(startBridge(port)).resolves.toBeInstanceOf(ModuleBridge);
  });
});
