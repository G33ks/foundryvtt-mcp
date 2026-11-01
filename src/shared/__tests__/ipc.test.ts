import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectionLostError,
  EndpointUnavailableError,
  HandshakeRejectedError,
  IpcConnection,
  RemoteError,
} from '../ipc-client.js';
import { type IpcHandler, IpcServer, type IpcServerOptions } from '../ipc-server.js';
import { type Hello, IpcErrorCode, PROTOCOL_VERSION } from '../protocol.js';

const TOKEN = 'a'.repeat(64);

function testEndpoint(): string {
  const tag = `fvtt-mcp-test-${process.pid}-${randomBytes(4).toString('hex')}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${tag}`
    : path.join(os.tmpdir(), `${tag}.sock`);
}

function hello(overrides: Partial<Hello> = {}): Hello {
  return {
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    role: 'relay',
    version: '1.0.0',
    configHash: 'cfg',
    token: TOKEN,
    ...overrides,
  };
}

const servers: IpcServer[] = [];
const connections: IpcConnection[] = [];

async function startServer(
  overrides: Partial<IpcServerOptions> = {},
): Promise<{ server: IpcServer; endpoint: string }> {
  const endpoint = overrides.endpoint ?? testEndpoint();
  const server = new IpcServer({
    endpoint,
    token: TOKEN,
    version: '1.0.0',
    configHash: 'cfg',
    handler: async (_op, name) => ({ echo: name }),
    toIpcError: (error) => ({
      code: -32603,
      message: error instanceof Error ? error.message : String(error),
    }),
    ...overrides,
  });
  servers.push(server);
  expect(await server.listen()).toBe('listening');
  return { server, endpoint };
}

async function connect(endpoint: string, overrides: Partial<Hello> = {}): Promise<IpcConnection> {
  const connection = await IpcConnection.connect(endpoint, hello(overrides));
  connections.push(connection);
  return connection;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(async () => {
  for (const connection of connections.splice(0)) {
    connection.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

describe('IPC handshake', () => {
  it('accepts a relay with the right token, version and config', async () => {
    const { endpoint } = await startServer();
    const connection = await connect(endpoint);
    expect(connection.serverPid).toBe(process.pid);
    await expect(connection.request('tool', 'get_users', {})).resolves.toEqual({
      echo: 'get_users',
    });
  });

  it('rejects an invalid token without calling the handler', async () => {
    const handler = vi.fn<IpcHandler>();
    const { endpoint } = await startServer({ handler });
    const error = await connect(endpoint, { token: 'b'.repeat(64) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HandshakeRejectedError);
    expect((error as HandshakeRejectedError).reason).toBe('unauthorized');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects another protocol version', async () => {
    const { endpoint } = await startServer();
    await expect(connect(endpoint, { protocol: PROTOCOL_VERSION + 1 })).rejects.toMatchObject({
      reason: 'protocol',
    });
  });

  it.each([
    ['version', { version: '2.0.0' }],
    ['config', { configHash: 'other' }],
  ] as const)('reports a %s mismatch and refuses the relay', async (reason, overrides) => {
    const onMismatch = vi.fn();
    const { endpoint } = await startServer({ onMismatch });
    await expect(connect(endpoint, overrides)).rejects.toMatchObject({ reason });
    expect(onMismatch).toHaveBeenCalledWith(reason);
  });

  it('lets control connections in regardless of version and config', async () => {
    const onMismatch = vi.fn();
    const { endpoint } = await startServer({ onMismatch });
    const connection = await connect(endpoint, {
      role: 'control',
      version: '9.9.9',
      configHash: '',
    });
    await expect(connection.request('status')).resolves.toEqual({});
    expect(onMismatch).not.toHaveBeenCalled();
  });

  it('fails with EndpointUnavailableError when nothing listens', async () => {
    await expect(IpcConnection.connect(testEndpoint(), hello())).rejects.toBeInstanceOf(
      EndpointUnavailableError,
    );
  });
});

describe('IPC requests', () => {
  it('handles several requests in flight on one connection, answering out of order', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<string>>>();
    const handler: IpcHandler = (_op, name) => {
      const gate = deferred<string>();
      gates.set(name ?? '', gate);
      return gate.promise;
    };
    const { server, endpoint } = await startServer({ handler });
    const connection = await connect(endpoint);

    const first = connection.request('tool', 'first');
    const second = connection.request('tool', 'second');
    const third = connection.request('resource', 'third');
    await vi.waitFor(() => expect(gates.size).toBe(3));
    expect(server.inFlightCount).toBe(3);

    gates.get('third')?.resolve('3');
    gates.get('first')?.resolve('1');
    gates.get('second')?.resolve('2');
    await expect(Promise.all([first, second, third])).resolves.toEqual(['1', '2', '3']);
  });

  it('returns handler failures as RemoteError with the mapped code', async () => {
    const { endpoint } = await startServer({
      handler: async () => {
        throw new Error('boom');
      },
      toIpcError: (error) => ({ code: -32602, message: (error as Error).message }),
    });
    const connection = await connect(endpoint);
    const error = await connection.request('tool', 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemoteError);
    expect(error).toMatchObject({ code: -32602, message: 'boom' });
  });

  it('counts relay connections, but not control connections', async () => {
    const counts: number[] = [];
    const { server, endpoint } = await startServer({
      onRelayCountChange: (count) => counts.push(count),
    });
    const a = await connect(endpoint);
    await connect(endpoint);
    await connect(endpoint, { role: 'control' });
    expect(server.relayCount).toBe(2);
    a.close();
    await vi.waitFor(() => expect(server.relayCount).toBe(1));
    expect(counts).toEqual([1, 2, 1]);
  });

  it('finishes a started request after its relay disconnects', async () => {
    const gate = deferred<string>();
    const finished = vi.fn();
    const { server, endpoint } = await startServer({
      handler: () =>
        gate.promise.then((value) => {
          finished(value);
          return value;
        }),
    });
    const connection = await connect(endpoint);
    const pending = connection.request('tool', 'write');
    await vi.waitFor(() => expect(server.inFlightCount).toBe(1));

    connection.close();
    await expect(pending).rejects.toBeInstanceOf(ConnectionLostError);
    gate.resolve('done');
    await server.waitForIdle();
    expect(finished).toHaveBeenCalledWith('done');
  });

  it('while draining: refuses new relays and new requests, still answers status', async () => {
    const { server, endpoint } = await startServer();
    const connection = await connect(endpoint);
    server.setDraining();

    await expect(connection.request('tool', 'x')).rejects.toMatchObject({
      code: IpcErrorCode.Draining,
    });
    await expect(connection.request('status')).resolves.toEqual({});
    await expect(connect(endpoint)).rejects.toMatchObject({ reason: 'draining' });
    await expect(connect(endpoint, { role: 'control' })).resolves.toBeInstanceOf(IpcConnection);
  });

  it('rejects pending requests when the server goes away', async () => {
    const { server, endpoint } = await startServer({ handler: () => new Promise(() => {}) });
    const connection = await connect(endpoint);
    const pending = connection.request('tool', 'hang');
    await vi.waitFor(() => expect(server.inFlightCount).toBe(1));
    await server.close();
    await expect(pending).rejects.toBeInstanceOf(ConnectionLostError);
  });
});

describe('IPC single-instance lock', () => {
  it('a second server on the same endpoint gets in-use', async () => {
    const { endpoint } = await startServer();
    const second = new IpcServer({
      endpoint,
      token: TOKEN,
      version: '1.0.0',
      configHash: 'cfg',
      handler: async () => null,
      toIpcError: () => ({ code: 0, message: '' }),
    });
    expect(await second.listen()).toBe('in-use');
  });
});
