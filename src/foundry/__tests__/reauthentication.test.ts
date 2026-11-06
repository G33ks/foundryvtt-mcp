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

const {
  describeConnectError,
  FoundryClient,
  RECONNECT_ERROR_LOG_INTERVAL_MS,
  REAUTH_BASE_RETRY_MS,
  REAUTH_MAX_RETRY_MS,
  WORLD_REPLAY_MAX_CHANGES,
} = await import('../client.js');
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
 * `reload` changes how the later `world` requests (reloads) are answered:
 * with another snapshot, or not at all until `answerReload()`; `holdFirst`
 * holds the first load the same way. `afterHandshake` runs right after the
 * handshake's `session` event, in the same turn, as for events that came in
 * the same packet.
 */
function fakeSocket(
  snapshot = worldData(),
  handshakeUserId: string | null = USER_ID,
  reload: {
    snapshot?: unknown;
    hold?: boolean;
    holdFirst?: boolean;
    afterHandshake?: (fire: (event: string, ...args: unknown[]) => void) => void;
  } = {},
) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const heldReloads: Array<(data: unknown) => void> = [];
  let worldRequests = 0;
  let handshakeAnswered = false;
  const add = (event: string, handler: (...args: unknown[]) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    if (event === 'session' && !handshakeAnswered) {
      handshakeAnswered = true;
      queueMicrotask(() => {
        handler({ userId: handshakeUserId, sessionId: 'x' });
        reload.afterHandshake?.(fire);
      });
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
        worldRequests += 1;
        if (worldRequests === 1 && !reload.holdFirst) {
          ack(structuredClone(snapshot));
        } else if (reload.hold || worldRequests === 1) {
          heldReloads.push(ack as (data: unknown) => void);
        } else {
          ack(structuredClone(reload.snapshot ?? snapshot));
        }
      }
      return socket;
    }),
    disconnect: vi.fn(() => {
      socket.connected = false;
      return socket;
    }),
  };
  /** Answers every held reload with `data`. */
  const answerReload = (data: unknown) => {
    for (const ack of heldReloads.splice(0)) {
      ack(structuredClone(data));
    }
  };
  const worldRequestCount = () => worldRequests;
  const fire = (event: string, ...args: unknown[]) => {
    for (const handler of [...(listeners.get(event) ?? [])]) {
      handler(...args);
    }
  };
  return { socket, fire, answerReload, worldRequestCount };
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

/** A snapshot with one actor, `name`. */
function worldWithActor(name: string) {
  return {
    ...worldData(),
    actors: [{ _id: `${name.padEnd(12, '0')}Act1`.slice(0, 16), name, type: 'npc' }],
  };
}

/** The transport drops and comes back; FoundryVTT still knows the session. */
function plainReconnection(fake: FakeSocket): void {
  fake.socket.connected = false;
  fake.fire('disconnect', 'ping timeout');
  fake.socket.connected = true;
  fake.fire('connect');
  fake.fire('session', { userId: USER_ID, sessionId: 'x' });
}

const warnings = (text: string) =>
  vi.mocked(logger.warn).mock.calls.filter(([message]) => String(message).includes(text));

describe('FoundryClient world reload after a plain reconnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(axios.create).mockReturnValue({
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    } as never);
    vi.mocked(authenticateFoundry).mockResolvedValue({ session: 'cookie-1', userId: USER_ID });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function connected(reload: { snapshot?: unknown; hold?: boolean } = {}) {
    const fake = fakeSocket(worldData(), USER_ID, reload);
    queueSockets(fake);
    const client = newClient();
    await client.connect();
    return { client, fake };
  }

  const actorNames = (client: InstanceType<typeof FoundryClient>) =>
    client
      .getWorldData()
      ?.actors.map((actor) => actor.name)
      .sort();

  it('reloads the world in the background once FoundryVTT names the user again', async () => {
    const { client, fake } = await connected({ snapshot: worldWithActor('Fresh') });

    plainReconnection(fake);

    await vi.waitFor(() => expect(client.isWorldDataStale()).toBe(false));
    expect(actorNames(client)).toEqual(['Fresh']);
    expect(fake.worldRequestCount()).toBe(2);
    expect(authenticateFoundry).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('World data refreshed', expect.any(Object));
    await client.disconnect();
  });

  it('does not reload a cache that is not stale', async () => {
    const { client, fake } = await connected({ snapshot: worldWithActor('Fresh') });

    fake.fire('session', { userId: USER_ID, sessionId: 'x' });
    await flush();

    expect(fake.worldRequestCount()).toBe(1);
    await client.disconnect();
  });

  it('leaves the cache stale, with one warning, when the reload times out', async () => {
    const { client, fake } = await connected({ hold: true });
    vi.useFakeTimers();

    plainReconnection(fake);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(client.isWorldDataStale()).toBe(true);
    expect(warnings('Could not reload the world data')).toHaveLength(1);
    // An answer after the timeout changes nothing.
    fake.answerReload(worldWithActor('Late'));
    expect(actorNames(client)).toEqual([]);
    await client.disconnect();
  });

  it('says since when and why the cache is stale, keeping the time across reasons', async () => {
    const { client, fake } = await connected({ hold: true });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T13:00:00.000Z'));
    expect(client.worldDataStaleness()).toBeNull();

    fake.socket.connected = false;
    fake.fire('disconnect', 'transport close');
    expect(client.worldDataStaleness()).toEqual({
      since: '2026-11-06T13:00:00.000Z',
      reason: 'the socket dropped',
    });

    vi.setSystemTime(new Date('2026-11-06T13:00:30.000Z'));
    fake.socket.connected = true;
    fake.fire('connect');
    fake.fire('session', { userId: USER_ID, sessionId: 'x' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.worldDataStaleness()).toEqual({
      since: '2026-11-06T13:00:00.000Z',
      reason: 'the reload after the reconnection failed: Refresh timeout',
    });

    // The next reload brings the cache back to life.
    const refresh = client.refreshWorldData();
    fake.answerReload(worldWithActor('Fresh'));
    await refresh;
    expect(client.worldDataStaleness()).toBeNull();
    await client.disconnect();
  });

  it('does not reload while a reauthentication runs', async () => {
    vi.mocked(authenticateFoundry)
      .mockResolvedValueOnce({ session: 'cookie-1', userId: USER_ID })
      .mockReturnValueOnce(new Promise(() => undefined));
    const { client, fake } = await connected();

    fake.socket.connected = false;
    fake.fire('disconnect', 'transport close');
    fake.fire('shutdown');
    fake.socket.connected = true;
    fake.fire('connect');
    fake.fire('session', { userId: USER_ID, sessionId: 'x' });
    await flush();

    expect(fake.worldRequestCount()).toBe(1);
    await client.disconnect();
  });

  it('shares one reload between the reconnection and refreshWorldData callers', async () => {
    const { client, fake } = await connected({ hold: true });

    plainReconnection(fake);
    const fromTool = client.refreshWorldData();
    const fromJournalFallback = client.refreshWorldData();
    fake.answerReload(worldWithActor('Fresh'));
    await Promise.all([fromTool, fromJournalFallback]);

    expect(fake.worldRequestCount()).toBe(2);
    expect(actorNames(client)).toEqual(['Fresh']);
    await client.disconnect();
  });

  it('replays the changes received during the reload onto the new snapshot', async () => {
    const { client, fake } = await connected({ hold: true });

    plainReconnection(fake);
    fake.fire('modifyDocument', {
      type: 'Actor',
      action: 'create',
      result: [{ _id: 'lateActor0000001', name: 'Late', type: 'npc' }],
    });
    // Visible at once in the cache being replaced…
    expect(actorNames(client)).toEqual(['Late']);
    // …and still there in a snapshot built before it.
    fake.answerReload(worldWithActor('Fresh'));

    await vi.waitFor(() => expect(client.isWorldDataStale()).toBe(false));
    expect(actorNames(client)).toEqual(['Fresh', 'Late']);
    await client.disconnect();
  });

  it(`gives up the replay beyond ${WORLD_REPLAY_MAX_CHANGES} changes and keeps the cache stale`, async () => {
    const { client, fake } = await connected({ hold: true });

    plainReconnection(fake);
    for (let i = 0; i <= WORLD_REPLAY_MAX_CHANGES; i++) {
      fake.fire('modifyDocument', {
        type: 'Actor',
        action: 'update',
        result: [{ _id: 'missingActor0001', name: `n${i}` }],
      });
    }
    fake.answerReload(worldWithActor('Fresh'));

    await vi.waitFor(() => expect(actorNames(client)).toEqual(['Fresh']));
    expect(client.isWorldDataStale()).toBe(true);
    expect(warnings('too many to replay')).toHaveLength(1);
    await client.disconnect();
  });

  it('ignores the reload answer of a socket that a reauthentication replaced', async () => {
    vi.mocked(authenticateFoundry)
      .mockResolvedValueOnce({ session: 'cookie-1', userId: USER_ID })
      .mockResolvedValueOnce({ session: 'cookie-2', userId: USER_ID });
    const first = fakeSocket(worldData(), USER_ID, { hold: true });
    const second = fakeSocket(worldWithActor('Second'));
    queueSockets(first, second);
    const client = newClient();
    await client.connect();

    plainReconnection(first);
    const refresh = client.refreshWorldData();
    first.fire('shutdown');
    await expect(refresh).rejects.toThrow();
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));
    first.answerReload(worldWithActor('Stale'));

    expect(actorNames(client)).toEqual(['Second']);
    expect(client.isWorldDataStale()).toBe(false);
    await client.disconnect();
  });

  it('keeps the cache stale when the socket drops during the reload', async () => {
    const { client, fake } = await connected({ hold: true });

    plainReconnection(fake);
    const refresh = client.refreshWorldData();
    fake.socket.connected = false;
    fake.fire('disconnect', 'ping timeout');

    await expect(refresh).rejects.toThrow();
    fake.answerReload(worldWithActor('Fresh'));
    expect(actorNames(client)).toEqual([]);
    expect(client.isWorldDataStale()).toBe(true);
    await client.disconnect();
  });

  it('cancels a running reload, and its timer, on disconnect()', async () => {
    const { client, fake } = await connected({ hold: true });
    vi.useFakeTimers();

    plainReconnection(fake);
    const refresh = client.refreshWorldData();
    refresh.catch(() => undefined);
    await client.disconnect();

    await expect(refresh).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('FoundryClient first world load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(axios.create).mockReturnValue({
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    } as never);
    vi.mocked(authenticateFoundry).mockResolvedValue({ session: 'cookie-1', userId: USER_ID });
  });

  /** Connects with the first `world` answer held until `answerReload()`. */
  async function loading() {
    const fake = fakeSocket(worldData(), USER_ID, { holdFirst: true });
    queueSockets(fake);
    const client = newClient();
    const connecting = client.connect();
    await vi.waitFor(() => expect(fake.worldRequestCount()).toBe(1));
    return { client, fake, connecting };
  }

  const actorNames = (client: InstanceType<typeof FoundryClient>) =>
    client
      .getWorldData()
      ?.actors.map((actor) => actor.name)
      .sort();

  it('replays a broadcast that arrives before the world answer onto the snapshot', async () => {
    const { client, fake, connecting } = await loading();

    fake.fire('modifyDocument', {
      type: 'Actor',
      action: 'create',
      result: [{ _id: 'earlyActor000001', name: 'Early', type: 'npc' }],
    });
    fake.fire('userActivity', 'humanGamemaster1', { active: true });
    expect(client.getWorldData()).toBeNull();
    // A snapshot FoundryVTT built before the broadcast.
    fake.answerReload(worldWithActor('Fresh'));
    await connecting;

    expect(actorNames(client)).toEqual(['Early', 'Fresh']);
    expect(client.getWorldData()?.activeUsers).toContain('humanGamemaster1');
    expect(client.isWorldDataStale()).toBe(false);
    expect(client.connectionStatus().state).toBe('connected');
    await client.disconnect();
  });

  const earlyActor = (fire: (event: string, ...args: unknown[]) => void) =>
    fire('modifyDocument', {
      type: 'Actor',
      action: 'create',
      result: [{ _id: 'earlyActor000001', name: 'Early', type: 'npc' }],
    });

  it('keeps a broadcast that arrives right after the session event, before the world is asked for', async () => {
    const fake = fakeSocket(worldData(), USER_ID, {
      afterHandshake: (fire) => {
        earlyActor(fire);
        expect(fake.worldRequestCount()).toBe(0);
      },
    });
    queueSockets(fake);
    const client = newClient();

    await client.connect();

    expect(actorNames(client)).toEqual(['Early']);
    expect(client.isWorldDataStale()).toBe(false);
    await client.disconnect();
  });

  it('keeps it too after a reauthentication, not only in the cache being replaced', async () => {
    const first = fakeSocket();
    const second = fakeSocket(worldWithActor('Second'), USER_ID, {
      afterHandshake: (fire) => {
        earlyActor(fire);
        expect(second.worldRequestCount()).toBe(0);
      },
    });
    queueSockets(first, second);
    const client = newClient();
    await client.connect();

    first.fire('shutdown');
    await vi.waitFor(() => expect(client.connectionStatus().state).toBe('connected'));
    await vi.waitFor(() => expect(second.worldRequestCount()).toBe(1));

    expect(actorNames(client)).toEqual(['Early', 'Second']);
    await client.disconnect();
  });

  it(`leaves the cache stale past ${WORLD_REPLAY_MAX_CHANGES} changes during the first load`, async () => {
    const { client, fake, connecting } = await loading();

    for (let i = 0; i <= WORLD_REPLAY_MAX_CHANGES; i++) {
      fake.fire('modifyDocument', {
        type: 'Actor',
        action: 'update',
        result: [{ _id: 'missingActor0001', name: `n${i}` }],
      });
    }
    fake.answerReload(worldWithActor('Fresh'));
    await connecting;

    expect(actorNames(client)).toEqual(['Fresh']);
    expect(client.isWorldDataStale()).toBe(true);
    await client.disconnect();
  });

  it('asks nothing for an autosave during a reauthentication load, then re-reads the entry', async () => {
    const first = fakeSocket();
    const second = fakeSocket(worldData(), USER_ID, { holdFirst: true });
    queueSockets(first, second);
    const client = newClient();
    await client.connect();
    const journalId = 'journalEntry0001';

    first.fire('shutdown');
    await vi.waitFor(() => expect(second.worldRequestCount()).toBe(1));
    second.fire(
      'pm.autosave',
      `JournalEntry.${journalId}.JournalEntryPage.journalPage00001#text.content`,
      '<p>x</p>',
    );
    const requests = () =>
      second.socket.emit.mock.calls
        .filter(([event]) => event === 'modifyDocument')
        .map(([, request]) => request);
    expect(requests()).toEqual([]);

    second.answerReload(worldData());
    await vi.waitFor(() => expect(client.connectionStatus().state).toBe('connected'));

    expect(requests()).toEqual([expect.objectContaining({ type: 'JournalEntry', action: 'get' })]);
    await client.disconnect();
  });

  it('removes its data listeners when the handshake fails', async () => {
    const fake = fakeSocket(worldData(), null);
    queueSockets(fake);
    const client = newClient();

    await expect(client.connect()).rejects.toThrow('session event returned no userId');
    // The replay opened with the socket is closed too.
    expect((client as unknown as { worldReplay: unknown }).worldReplay).toBeNull();

    const removed = fake.socket.off.mock.calls.map(([event]) => event);
    expect(removed).toEqual(
      expect.arrayContaining([
        'modifyDocument',
        'modifyDocumentBatch',
        'userActivity',
        'pm.autosave',
      ]),
    );
    fake.fire('modifyDocument', {
      type: 'Actor',
      action: 'create',
      result: [{ _id: 'lateActor0000001', name: 'Late', type: 'npc' }],
    });
    expect(client.getWorldData()).toBeNull();
    await client.disconnect();
  });
});

describe('FoundryClient reconnection log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(axios.create).mockReturnValue({
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    } as never);
    vi.mocked(authenticateFoundry).mockResolvedValue({ session: 'cookie-1', userId: USER_ID });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function droppedSocket() {
    const fake = fakeSocket();
    queueSockets(fake);
    const client = newClient();
    await client.connect();
    vi.useFakeTimers();
    fake.socket.connected = false;
    fake.fire('disconnect', 'transport close');
    return { client, fake };
  }

  const reconnectWarnings = () => warnings('FoundryVTT socket reconnection failed');

  it('logs the first failed attempt, then one a minute or when the error changes', async () => {
    const { client, fake } = await droppedSocket();

    fake.fire('connect_error', new Error('websocket error'));
    vi.advanceTimersByTime(10_000);
    fake.fire('connect_error', new Error('websocket error'));
    expect(reconnectWarnings().map(([message]) => message)).toEqual([
      'FoundryVTT socket reconnection failed (attempt 1): websocket error',
    ]);

    fake.fire('connect_error', new Error('timeout'));
    vi.advanceTimersByTime(RECONNECT_ERROR_LOG_INTERVAL_MS);
    fake.fire('connect_error', new Error('timeout'));
    expect(reconnectWarnings().map(([message]) => message)).toEqual([
      'FoundryVTT socket reconnection failed (attempt 1): websocket error',
      'FoundryVTT socket reconnection failed (attempt 3): timeout',
      'FoundryVTT socket reconnection failed (attempt 4): timeout',
    ]);
    await client.disconnect();
  });

  it('says how long the outage lasted and how many attempts failed once it is back', async () => {
    const { client, fake } = await droppedSocket();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(15_000);
      fake.fire('connect_error', new Error('websocket error'));
    }

    fake.socket.connected = true;
    fake.fire('connect');
    fake.fire('session', { userId: USER_ID, sessionId: 'x' });

    const infos = vi.mocked(logger.info).mock.calls.map(([message]) => String(message));
    expect(infos).toContain(
      'FoundryVTT connection restored after 75 s and 5 failed reconnection attempt(s)',
    );
    await client.disconnect();
  });

  it('never writes the session cookie from a transport error', async () => {
    const { client, fake } = await droppedSocket();
    const error = Object.assign(new Error('websocket error'), {
      description: {
        message:
          'Unexpected server response: 502 for wss://foundry.example/socket.io/?session=secret-cookie&EIO=4',
      },
      context: { url: 'wss://foundry.example/socket.io/?session=secret-cookie' },
    });

    fake.fire('connect_error', error);

    const logged = JSON.stringify([
      vi.mocked(logger.warn).mock.calls,
      vi.mocked(logger.info).mock.calls,
      vi.mocked(logger.debug).mock.calls,
    ]);
    expect(logged).not.toContain('secret-cookie');
    expect(reconnectWarnings()[0]?.[0]).toBe(
      'FoundryVTT socket reconnection failed (attempt 1): websocket error (Unexpected server response: 502 for wss://foundry.example/socket.io/?session=<redacted>&EIO=4)',
    );
    await client.disconnect();
  });
});

describe('describeConnectError', () => {
  it('adds the transport error, masks session cookies, and cuts long texts', () => {
    expect(describeConnectError(new Error('xhr poll error'))).toBe('xhr poll error');
    expect(
      describeConnectError(Object.assign(new Error('websocket error'), { description: 'boom' })),
    ).toBe('websocket error (boom)');
    expect(describeConnectError(new Error('bad Cookie: session=abc123; x=1'))).toBe(
      'bad Cookie: session=<redacted>; x=1',
    );
    expect(describeConnectError(new Error('x'.repeat(500)))).toHaveLength(300);
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
