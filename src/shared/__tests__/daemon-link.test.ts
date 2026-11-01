import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { DaemonLink, type DaemonLinkOptions } from '../daemon-link.js';
import {
  ConnectionLostError,
  EndpointUnavailableError,
  HandshakeRejectedError,
  type IpcConnection,
  RemoteError,
} from '../ipc-client.js';
import { type Hello, IpcErrorCode, PROTOCOL_VERSION } from '../protocol.js';

const HELLO: Hello = {
  type: 'hello',
  protocol: PROTOCOL_VERSION,
  role: 'relay',
  version: '1.0.0',
  configHash: 'cfg',
  token: 't',
};

type Request = (...args: Parameters<IpcConnection['request']>) => Promise<unknown>;

function fakeConnection(request: Request, serverPid = 42): IpcConnection {
  let closed = false;
  return {
    serverPid,
    get isClosed() {
      return closed;
    },
    onClose: () => {},
    request,
    close: () => {
      closed = true;
    },
  } as unknown as IpcConnection;
}

/** A link on a virtual clock: `sleep` advances `now` instead of waiting. */
function makeLink(
  connect: DaemonLinkOptions['connect'],
  overrides: Partial<DaemonLinkOptions> = {},
): { link: DaemonLink; spawnDaemon: ReturnType<typeof vi.fn>; clock: { now: number } } {
  const clock = { now: 0 };
  const spawnDaemon = vi.fn();
  const link = new DaemonLink({
    endpoint: 'pipe',
    hello: () => HELLO,
    spawnDaemon,
    logFile: 'daemon.log',
    connect,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    ...overrides,
  });
  return { link, spawnDaemon, clock };
}

const unavailable = () => new EndpointUnavailableError('pipe', new Error('ENOENT'));

describe('DaemonLink', () => {
  it('connects to a running shared process without spawning one', async () => {
    const connect = vi.fn(async () => fakeConnection(async (_op, name) => `ok:${name}`));
    const { link, spawnDaemon } = makeLink(connect);
    await expect(link.call('tool', 'get_users', {})).resolves.toBe('ok:get_users');
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it('spawns the shared process when nobody listens, then waits for it', async () => {
    let attempts = 0;
    const connect = vi.fn(async () => {
      if (++attempts < 4) {
        throw unavailable();
      }
      return fakeConnection(async () => 'ok');
    });
    const { link, spawnDaemon } = makeLink(connect);
    await expect(link.call('tool', 'x')).resolves.toBe('ok');
    expect(spawnDaemon).toHaveBeenCalledTimes(1);
  });

  it('re-spawns only after the respawn interval while still waiting', async () => {
    const connect = vi.fn(async () => {
      throw unavailable();
    });
    const { link, spawnDaemon, clock } = makeLink(connect, {
      readyTimeoutMs: 12_000,
      respawnIntervalMs: 5000,
    });
    await expect(link.call('tool', 'x')).rejects.toThrow(/did not become available/);
    expect(clock.now).toBeGreaterThanOrEqual(12_000);
    expect(spawnDaemon).toHaveBeenCalledTimes(3); // t=0, ~5 s, ~10 s
  });

  it('shares one connection attempt between concurrent calls', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connect = vi.fn(async () => {
      await gate;
      return fakeConnection(async (_op, name) => name);
    });
    const { link } = makeLink(connect);
    const calls = Promise.all([link.call('tool', 'a'), link.call('tool', 'b')]);
    release();
    await expect(calls).resolves.toEqual(['a', 'b']);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('waits for an outdated process to drain, then starts a new one', async () => {
    const replies: Array<'mismatch' | 'draining' | 'gone' | 'up'> = [
      'mismatch',
      'draining',
      'draining',
      'gone',
      'up',
    ];
    const connect = vi.fn(async () => {
      const next = replies.shift();
      if (next === 'mismatch') {
        throw new HandshakeRejectedError('config', 'different configuration');
      }
      if (next === 'draining') {
        throw new HandshakeRejectedError('draining', 'shutting down');
      }
      if (next === 'gone') {
        throw unavailable();
      }
      return fakeConnection(async () => 'fresh');
    });
    const { link, spawnDaemon } = makeLink(connect);
    await expect(link.call('tool', 'x')).resolves.toBe('fresh');
    expect(spawnDaemon).toHaveBeenCalledTimes(1);
  });

  it('gives an outdated process longer than the ready timeout to drain', async () => {
    const connect = vi.fn(async () => {
      throw new HandshakeRejectedError('draining', 'shutting down');
    });
    const { link, clock } = makeLink(connect, { readyTimeoutMs: 1000, drainTimeoutMs: 60_000 });
    await expect(link.call('tool', 'x')).rejects.toThrow(/did not become available/);
    expect(clock.now).toBeGreaterThanOrEqual(60_000);
  });

  it('fails fast with guidance when the token is refused', async () => {
    const connect = vi.fn(async () => {
      throw new HandshakeRejectedError('unauthorized', 'Invalid token');
    });
    const { link } = makeLink(connect);
    await expect(link.call('tool', 'x')).rejects.toThrow(/refused this relay \(unauthorized/);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('resends a call the draining process refused before starting it', async () => {
    const draining = fakeConnection(async () => {
      throw new RemoteError({ code: IpcErrorCode.Draining, message: 'shutting down' });
    });
    const fresh = fakeConnection(async () => 'done', 43);
    const connect = vi.fn().mockResolvedValueOnce(draining).mockResolvedValueOnce(fresh);
    const { link } = makeLink(connect);
    await expect(link.call('tool', 'x')).resolves.toBe('done');
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('reports a clear error when the process dies mid-call, and does not resend', async () => {
    const request = vi.fn(async () => {
      throw new ConnectionLostError();
    });
    const connect = vi
      .fn()
      .mockResolvedValueOnce(fakeConnection(request))
      .mockResolvedValueOnce(fakeConnection(async () => 'after restart'));
    const { link } = makeLink(connect);

    const error = await link.call('tool', 'create_scene').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).message).toMatch(/exited during this call.*daemon\.log/);
    expect(request).toHaveBeenCalledTimes(1);

    // The next call reconnects (and would restart the process if needed).
    await expect(link.call('tool', 'x')).resolves.toBe('after restart');
  });

  it('passes remote MCP errors through with their code', async () => {
    const connect = vi.fn(async () =>
      fakeConnection(async () => {
        throw new RemoteError({ code: ErrorCode.InvalidParams, message: 'Missing actorId' });
      }),
    );
    const { link } = makeLink(connect);
    const error = await link.call('tool', 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ code: ErrorCode.InvalidParams });
    expect((error as McpError).message).toContain('Missing actorId');
  });
});
