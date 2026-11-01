/**
 * @fileoverview FoundryClient owns the session (single-account mode): it
 * notices a session FoundryVTT forgot, authenticates again once, hands the
 * new cookie to its listeners, and never sends on an anonymous socket.
 */

import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios');
vi.mock('socket.io-client');
vi.mock('../auth.js', () => {
  class NoActiveWorldError extends Error {
    override name = 'NoActiveWorldError';
  }
  return {
    NoActiveWorldError,
    authenticateFoundry: vi.fn(),
    sessionSocketOptions: (session: string) => ({
      transports: ['websocket'],
      query: { session },
      extraHeaders: { Cookie: `session=${session}` },
    }),
  };
});
vi.mock('../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../config/index.js', () => ({ config: { logLevel: 'info' } }));

const { FoundryClient, REAUTH_BASE_RETRY_MS, REAUTH_MAX_RETRY_MS } = await import('../client.js');
const { authenticateFoundry, NoActiveWorldError } = await import('../auth.js');
const { io } = await import('socket.io-client');
const { logger } = await import('../../utils/logger.js');
const { isRefusal } = await import('../../utils/refusal.js');

const USER_ID = 'zConnectorUser01';

function worldData(accountRole = 3) {
  return {
    userId: USER_ID,
    world: { id: 'w', title: 'Test World' },
    system: { id: 'dnd5e', version: '3.3.1' },
    release: { version: '14.369' },
    actors: [],
    scenes: [],
    items: [],
    journal: [],
    messages: [],
    combats: [],
    users: [
      { _id: USER_ID, name: 'mcp-api', role: accountRole },
      { _id: 'humanGamemaster1', name: 'Gamemaster', role: 4 },
      { _id: 'playerUser000001', name: 'Joueur test', role: 2 },
    ],
    activeUsers: [USER_ID],
    settings: [],
    macros: [],
    playlists: [],
    tables: [],
    folders: [],
  };
}

/**
 * Fake socket. Answers `world` with the snapshot, and the first `session`
 * listener (the handshake) with `handshakeUserId` on the next microtask.
 */
function fakeSocket(snapshot = worldData(), handshakeUserId: string | null = USER_ID) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  let handshakeAnswered = false;
  const add = (event: string, handler: (...args: unknown[]) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    if (event === 'session' && !handshakeAnswered) {
      handshakeAnswered = true;
      queueMicrotask(() => handler({ userId: handshakeUserId, sessionId: 'x' }));
    }
  };
  const socket = {
    connected: true,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      add(event, handler);
      return socket;
    }),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      add(event, handler);
      return socket;
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((h) => h !== handler),
      );
      return socket;
    }),
    emit: vi.fn((event: string, ...args: unknown[]) => {
      const ack = args[args.length - 1];
      if (event === 'world' && typeof ack === 'function') {
        ack(structuredClone(snapshot));
      }
      return socket;
    }),
    disconnect: vi.fn(() => {
      socket.connected = false;
      return socket;
    }),
  };
  const fire = (event: string, ...args: unknown[]) => {
    for (const handler of [...(listeners.get(event) ?? [])]) {
      handler(...args);
    }
  };
  return { socket, fire };
}

type FakeSocket = ReturnType<typeof fakeSocket>;

/** Queues the sockets `io()` hands out, in order. */
function queueSockets(...sockets: FakeSocket[]): void {
  const queue = [...sockets];
  vi.mocked(io).mockImplementation((() => {
    const next = queue.shift();
    if (!next) {
      throw new Error('no fake socket left');
    }
    return next.socket;
  }) as never);
}

function newClient() {
  return new FoundryClient({
    baseUrl: 'http://localhost:30000',
    username: 'mcp-api',
    password: 'secret',
    writeEnabled: true,
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('FoundryClient session ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(axios.create).mockReturnValue({
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands the session cookie to its listeners after connecting', async () => {
    vi.mocked(authenticateFoundry).mockResolvedValue({ session: 'cookie-1', userId: USER_ID });
    queueSockets(fakeSocket());
    const client = newClient();
    const seen: string[] = [];
    client.onSessionChanged((session) => seen.push(session));

    await client.connect();

    expect(client.currentSession()).toBe('cookie-1');
    expect(seen).toEqual(['cookie-1']);
    expect(client.connectionStatus()).toEqual({ state: 'connected', error: null });
    await client.disconnect();
  });

  it('reauthenticates when a reconnected socket comes back anonymous', async () => {
    vi.mocked(authenticateFoundry)
      .mockResolvedValueOnce({ session: 'cookie-1', userId: USER_ID })
      .mockResolvedValueOnce({ session: 'cookie-2', userId: USER_ID });
    const first = fakeSocket();
    const second = fakeSocket();
    queueSockets(first, second);
    const client = newClient();
    const seen: string[] = [];
    client.onSessionChanged((session) => seen.push(session));
    await client.connect();

    // A FoundryVTT restart: the transport drops, comes back, and the server
    // no longer knows the session.
    first.socket.connected = false;
    first.fire('disconnect', 'transport close');
    first.socket.connected = true;
    first.fire('connect');
    expect(client.isConnected()).toBe(false);
    first.fire('session', null);
    expect(client.connectionStatus().state).toBe('reauthenticating');

    await vi.waitFor(() => expect(client.isConnected()).toBe(true));
    expect(authenticateFoundry).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(['cookie-1', 'cookie-2']);
    expect(client.currentSession()).toBe('cookie-2');
    expect(first.socket.disconnect).toHaveBeenCalled();
    expect(client.isWorldDataStale()).toBe(false);
    await client.disconnect();
  });

  it('does not read a transport reconnection as connected before FoundryVTT names a user', async () => {
    vi.mocked(authenticateFoundry).mockResolvedValue({ session: 'cookie-1', userId: USER_ID });
    const first = fakeSocket();
    queueSockets(first);
    const client = newClient();
    await client.connect();

    first.socket.connected = false;
    first.fire('disconnect', 'ping timeout');
    first.socket.connected = true;
    first.fire('connect');

    expect(client.isConnected()).toBe(false);
    first.fire('session', { userId: USER_ID, sessionId: 'x' });
    expect(client.isConnected()).toBe(true);
    // The session was still valid: no new authentication.
    expect(authenticateFoundry).toHaveBeenCalledTimes(1);
    await client.disconnect();
  });

  it('reauthenticates when the world shuts down', async () => {
    vi.mocked(authenticateFoundry)
      .mockResolvedValueOnce({ session: 'cookie-1', userId: USER_ID })
      .mockResolvedValueOnce({ session: 'cookie-2', userId: USER_ID });
    const first = fakeSocket();
    queueSockets(first, fakeSocket());
    const client = newClient();
    await client.connect();

    first.fire('shutdown', { world: 'w' });

    await vi.waitFor(() => expect(client.currentSession()).toBe('cookie-2'));
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
  });

  it('runs one authentication for concurrent reauthentication requests', async () => {
    let release: (value: { session: string; userId: string }) => void = () => undefined;
    vi.mocked(authenticateFoundry)
      .mockResolvedValueOnce({ session: 'cookie-1', userId: USER_ID })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
    queueSockets(fakeSocket(), fakeSocket());
    const client = newClient();
    await client.connect();

    const requests = [
      client.reauthenticate('page refused'),
      client.reauthenticate('page refused again'),
      client.reauthenticate('shutdown'),
    ];
    release({ session: 'cookie-2', userId: USER_ID });
    await Promise.all(requests);

    expect(authenticateFoundry).toHaveBeenCalledTimes(2);
    expect(client.currentSession()).toBe('cookie-2');
    await client.disconnect();
  });

  it('retries in the background with a capped, doubling delay and logs once per state', async () => {
    vi.mocked(authenticateFoundry).mockResolvedValueOnce({ session: 'cookie-1', userId: USER_ID });
    queueSockets(fakeSocket(), fakeSocket());
    const client = newClient();
    await client.connect();

    vi.useFakeTimers();
    vi.mocked(authenticateFoundry).mockRejectedValue(new NoActiveWorldError('No active world'));
    vi.mocked(logger.warn).mockClear();

    await client.reauthenticate('the world was shut down').catch(() => undefined);
    expect(client.connectionStatus().state).toBe('waiting-for-world');
    expect(client.isConnected()).toBe(false);
    expect(authenticateFoundry).toHaveBeenCalledTimes(2);

    // 5s, 10s, 20s, 40s, 80s, then capped at 120s.
    const delays = [5000, 10000, 20000, 40000, 80000, REAUTH_MAX_RETRY_MS, REAUTH_MAX_RETRY_MS];
    expect(delays[0]).toBe(REAUTH_BASE_RETRY_MS);
    let calls = 2;
    for (const delay of delays) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(authenticateFoundry).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      calls++;
      expect(authenticateFoundry).toHaveBeenCalledTimes(calls);
    }

    // Losing the session and then waiting for the world: two lines, not one per attempt.
    const lines = vi.mocked(logger.warn).mock.calls.map(([message]) => String(message));
    expect(lines.filter((l) => l.startsWith('FoundryVTT connection:'))).toEqual([
      'FoundryVTT connection: reauthenticating — the world was shut down',
      'FoundryVTT connection: waiting-for-world — No active world',
    ]);

    // The world is back: the next attempt reconnects without any call.
    vi.mocked(authenticateFoundry).mockResolvedValue({ session: 'cookie-3', userId: USER_ID });
    await vi.advanceTimersByTimeAsync(REAUTH_MAX_RETRY_MS);
    expect(client.currentSession()).toBe('cookie-3');
    expect(client.connectionStatus().state).toBe('connected');
    await client.disconnect();
  });

  it('starts reconnecting in the background after a failed first connection', async () => {
    vi.useFakeTimers();
    queueSockets(fakeSocket());
    const client = newClient();
    vi.mocked(authenticateFoundry).mockRejectedValueOnce(new NoActiveWorldError('No active world'));
    await expect(client.connect()).rejects.toThrow('No active world');

    client.startReconnecting(new NoActiveWorldError('No active world'));
    expect(client.connectionStatus()).toEqual({
      state: 'waiting-for-world',
      error: 'No active world',
    });
    expect(client.isReconnecting()).toBe(true);

    vi.mocked(authenticateFoundry).mockResolvedValue({ session: 'cookie-1', userId: USER_ID });
    await vi.advanceTimersByTimeAsync(REAUTH_BASE_RETRY_MS);
    expect(client.isConnected()).toBe(true);
    expect(client.isReconnecting()).toBe(false);
    await client.disconnect();
  });

  it('stops retrying after disconnect()', async () => {
    vi.useFakeTimers();
    const client = newClient();
    client.startReconnecting(new NoActiveWorldError('No active world'));
    await client.disconnect();

    await vi.advanceTimersByTimeAsync(REAUTH_MAX_RETRY_MS * 2);
    expect(authenticateFoundry).not.toHaveBeenCalled();
  });

  it('never sends a write on an anonymous socket', async () => {
    vi.mocked(authenticateFoundry)
      .mockResolvedValueOnce({ session: 'cookie-1', userId: USER_ID })
      .mockReturnValueOnce(new Promise(() => undefined));
    const first = fakeSocket();
    queueSockets(first);
    const client = newClient();
    await client.connect();

    first.fire('session', null);
    first.socket.emit.mockClear();

    const write = client.sendChatMessage('hello');
    await expect(write).rejects.toThrow(/Reconnecting to FoundryVTT/);
    await write.catch((error: unknown) => expect(isRefusal(error)).toBe(true));
    expect(first.socket.emit).not.toHaveBeenCalledWith(
      'modifyDocument',
      expect.anything(),
      expect.anything(),
    );
  });

  it('waits for a reconnection, or says it ran out of time', async () => {
    let release: (value: { session: string; userId: string }) => void = () => undefined;
    vi.mocked(authenticateFoundry)
      .mockResolvedValueOnce({ session: 'cookie-1', userId: USER_ID })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
    const first = fakeSocket();
    queueSockets(first, fakeSocket());
    const client = newClient();
    await client.connect();

    first.fire('session', null);
    expect(client.isReconnecting()).toBe(true);
    expect(await client.waitUntilConnected(20)).toBe(false);

    const waiting = client.waitUntilConnected(5000);
    release({ session: 'cookie-2', userId: USER_ID });
    expect(await waiting).toBe(true);
    await client.disconnect();
  });

  it('never logs the session cookie', async () => {
    vi.mocked(authenticateFoundry)
      .mockResolvedValueOnce({ session: 'secret-cookie-1', userId: USER_ID })
      .mockResolvedValueOnce({ session: 'secret-cookie-2', userId: USER_ID });
    const first = fakeSocket();
    queueSockets(first, fakeSocket());
    const client = newClient();
    await client.connect();
    first.fire('session', null);
    await vi.waitFor(() => expect(client.currentSession()).toBe('secret-cookie-2'));
    await flush();

    const logged = JSON.stringify(
      [logger.debug, logger.info, logger.warn, logger.error].flatMap(
        (fn) => vi.mocked(fn).mock.calls,
      ),
    );
    expect(logged).not.toContain('secret-cookie');
    await client.disconnect();
  });
});

describe('FoundryClient account role', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(axios.create).mockReturnValue({
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    } as never);
  });

  async function connectedAs(role: number) {
    vi.mocked(authenticateFoundry).mockResolvedValue({ session: 'cookie-1', userId: USER_ID });
    const harness = fakeSocket(worldData(role));
    queueSockets(harness);
    const client = newClient();
    await client.connect();
    harness.socket.emit.mockClear();
    return { client, ...harness };
  }

  it('refuses to grant Gamemaster from an Assistant GM account, without asking the server', async () => {
    const { client, socket } = await connectedAs(3);

    const attempt = client.setUserRole('playerUser000001', 'gamemaster');

    await expect(attempt).rejects.toThrow(
      'The connector\'s account "mcp-api" is Assistant GM: FoundryVTT only lets a user grant roles up to its own, so it cannot grant Gamemaster.',
    );
    await attempt.catch((error: unknown) => expect(isRefusal(error)).toBe(true));
    expect(socket.emit).not.toHaveBeenCalled();
    await client.disconnect();
  });

  it('still grants roles up to its own', async () => {
    const { client, socket } = await connectedAs(3);
    socket.emit.mockImplementation((event: string, _payload: unknown, ack?: unknown) => {
      if (event === 'modifyDocument' && typeof ack === 'function') {
        ack({ result: [{ _id: 'playerUser000001', role: 3 }] });
      }
      return socket;
    });

    await client.setUserRole('playerUser000001', 'assistant');

    expect(socket.emit).toHaveBeenCalledWith(
      'modifyDocument',
      expect.objectContaining({ type: 'User', action: 'update' }),
      expect.any(Function),
    );
    await client.disconnect();
  });

  it('refuses core.permissions from an account that is not a Gamemaster', async () => {
    const { client, socket } = await connectedAs(3);

    const attempt = client.setWorldSetting('core.permissions', {});

    await expect(attempt).rejects.toThrow(/only a Gamemaster may change core\.permissions/);
    await attempt.catch((error: unknown) => expect(isRefusal(error)).toBe(true));
    expect(socket.emit).not.toHaveBeenCalled();
    await client.disconnect();
  });

  it('reports the account name and role', async () => {
    const { client } = await connectedAs(3);
    expect(client.accountInfo()).toEqual({ userId: USER_ID, name: 'mcp-api', role: 3 });
    await client.disconnect();
  });

  it('elects the active GM like FoundryVTT: highest role, then the smaller id', async () => {
    const { client, fire } = await connectedAs(4);
    // Only mcp-api (role 4) is active.
    expect(client.activeGameMaster()?.name).toBe('mcp-api');

    // A human Gamemaster with a smaller id joins: equal roles, smaller id wins.
    fire('userActivity', 'humanGamemaster1', { active: true });
    expect(client.activeGameMaster()?.name).toBe('Gamemaster');
    await client.disconnect();
  });

  it('never elects an Assistant GM over a Gamemaster', async () => {
    const { client, fire } = await connectedAs(3);
    fire('userActivity', 'humanGamemaster1', { active: true });
    expect(client.activeGameMaster()?.name).toBe('Gamemaster');
    fire('userActivity', 'humanGamemaster1', { active: false });
    expect(client.activeGameMaster()?.name).toBe('mcp-api');
    fire('userActivity', 'playerUser000001', { active: true });
    expect(client.activeGameMaster()?.name).toBe('mcp-api');
    await client.disconnect();
  });
});
