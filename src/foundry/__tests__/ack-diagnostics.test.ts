/**
 * @fileoverview Diagnostics of the Socket.IO acknowledgement wait: a late
 * acknowledgement is logged, and a timeout says how old the server's last
 * ping is, whether the socket is connected and how many requests wait.
 */

import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios');
vi.mock('socket.io-client');
vi.mock('../auth.js', () => ({
  authenticateFoundry: vi
    .fn()
    .mockResolvedValue({ session: 'test-session', userId: 'test-user-id' }),
  sessionSocketOptions: (session: string) => ({
    auth: { session },
    autoConnect: true,
  }),
}));
vi.mock('../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('../../config/index.js', () => ({
  config: { logLevel: 'info' },
}));

const { FoundryClient } = await import('../client.js');
const { logger } = await import('../../utils/logger.js');

const SCENE_ID = 'sceneAAAAAAAAAAA';

type Ack = (response: unknown) => void;

function baseWorldData() {
  return {
    userId: 'test-user-id',
    world: { id: 'w', title: 'Test World' },
    system: { id: 's', version: '1.0.0' },
    release: { version: '14.370' },
    actors: [],
    scenes: [{ _id: SCENE_ID, name: 'Scene', tokens: [] }],
    items: [],
    journal: [],
    messages: [],
    combats: [],
    users: [],
    activeUsers: [],
    settings: [],
    folders: [],
    macros: [],
    playlists: [],
    tables: [],
    cards: [],
  };
}

/**
 * A socket whose `modifyDocument` acknowledgements are held until the test
 * releases them, with a manager that emits the server's pings.
 */
function buildMockSocket(worldData: Record<string, unknown>) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const managerListeners = new Map<string, Array<() => void>>();
  const held: Array<{ payload: unknown; ack: Ack }> = [];
  const add = <F>(map: Map<string, F[]>, event: string, handler: F) => {
    map.set(event, [...(map.get(event) ?? []), handler]);
  };
  const remove = <F>(map: Map<string, F[]>, event: string, handler: F) => {
    map.set(
      event,
      (map.get(event) ?? []).filter((h) => h !== handler),
    );
  };
  const socket: {
    connected: boolean;
    io: { on: Mock; off: Mock };
    on: Mock;
    once: Mock;
    off: Mock;
    emit: Mock;
    disconnect: Mock;
  } = {
    connected: true,
    io: {
      on: vi.fn((event: string, handler: () => void) => add(managerListeners, event, handler)),
      off: vi.fn((event: string, handler: () => void) => remove(managerListeners, event, handler)),
    },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      add(listeners, event, handler);
      return socket;
    }),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      add(listeners, event, handler);
      return socket;
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      remove(listeners, event, handler);
      return socket;
    }),
    emit: vi.fn((event: string, payloadOrAck?: unknown, maybeAck?: Ack) => {
      if (event === 'world' && typeof payloadOrAck === 'function') {
        (payloadOrAck as Ack)(worldData);
      } else if (event === 'modifyDocument' && typeof maybeAck === 'function') {
        held.push({ payload: payloadOrAck, ack: maybeAck });
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
  const ping = () => {
    for (const handler of [...(managerListeners.get('ping') ?? [])]) {
      handler();
    }
  };
  return { socket, fire, ping, held, managerListeners };
}

async function connectClient() {
  const { io } = await import('socket.io-client');
  const { authenticateFoundry } = await import('../auth.js');
  vi.mocked(authenticateFoundry).mockResolvedValue({
    session: 'test-session',
    userId: 'test-user-id',
  });
  const harness = buildMockSocket(structuredClone(baseWorldData()));
  vi.mocked(io).mockReturnValue(harness.socket as never);

  const client = new FoundryClient({
    baseUrl: 'http://localhost:30000',
    username: 'gm',
    password: 'secret',
    writeEnabled: true,
    timeout: 10000,
  });

  const connecting = client.connect();
  await vi.waitFor(() =>
    expect(harness.socket.on).toHaveBeenCalledWith('session', expect.anything()),
  );
  harness.fire('session', { userId: 'test-user-id' });
  await connecting;

  return { client, ...harness };
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('Socket.IO acknowledgement diagnostics', () => {
  it('leaves a request acknowledged in time unchanged, without any warning', async () => {
    const { client, held } = await connectClient();
    vi.useFakeTimers();

    const update = client.setSceneLighting(SCENE_ID, { darkness: 0.5 });
    expect(held).toHaveLength(1);
    held[0]?.ack({ result: [{ _id: SCENE_ID, environment: { darknessLevel: 0.5 } }] });

    await expect(update).resolves.toBeDefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs an acknowledgement that arrives after the timeout, with its delay', async () => {
    const { client, held } = await connectClient();
    vi.useFakeTimers();

    const update = client.setSceneLighting(SCENE_ID, { darkness: 0.5 });
    const failure = expect(update).rejects.toThrow(/Timeout waiting for 'modifyDocument'/);
    await vi.advanceTimersByTimeAsync(10000);
    await failure;

    await vi.advanceTimersByTimeAsync(2500);
    held[0]?.ack({ result: [{ _id: SCENE_ID, environment: { darknessLevel: 0.5 } }] });

    expect(logger.warn).toHaveBeenCalledWith("Late acknowledgement for 'modifyDocument' ignored", {
      action: 'update',
      type: 'Scene',
      id: SCENE_ID,
      delayMs: 12500,
      timeoutMs: 10000,
    });
    // Only logged: the cache is not touched by a late acknowledgement.
    expect(client.getScenes().find((s) => s._id === SCENE_ID)).not.toHaveProperty('environment');
  });

  it('gives the age of the last ping, the socket state and the waiting requests on timeout', async () => {
    const { client, ping } = await connectClient();
    vi.useFakeTimers();
    ping();
    await vi.advanceTimersByTimeAsync(4000);

    const update = client.setSceneLighting(SCENE_ID, { darkness: 0.5 });
    const failure = expect(update).rejects.toThrow(
      "Timeout waiting for 'modifyDocument' response (10000ms) " +
        '[last ping: 14000 ms ago; socket: connected; pending requests: 1]',
    );
    await vi.advanceTimersByTimeAsync(10000);
    await failure;
  });

  it('says when no ping arrived since the socket connected', async () => {
    const { client, socket } = await connectClient();
    vi.useFakeTimers();

    const update = client.setSceneLighting(SCENE_ID, { darkness: 0.5 });
    socket.connected = false;
    const failure = expect(update).rejects.toThrow(
      '[last ping: none since connect; socket: disconnected; pending requests: 1]',
    );
    await vi.advanceTimersByTimeAsync(10000);
    await failure;
  });

  it('counts every request still waiting for its acknowledgement', async () => {
    const { client, held } = await connectClient();
    vi.useFakeTimers();

    const first = client.setSceneLighting(SCENE_ID, { darkness: 0.5 });
    const firstFailure = expect(first).rejects.toThrow('pending requests: 2]');
    await vi.advanceTimersByTimeAsync(1000);
    const second = client.setSceneLighting(SCENE_ID, { darkness: 0.2 });
    const secondFailure = expect(second).rejects.toThrow('pending requests: 1]');
    expect(held).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10000);
    await firstFailure;
    await secondFailure;
  });

  it('stops listening for pings when the client disconnects', async () => {
    const { client, managerListeners } = await connectClient();
    expect(managerListeners.get('ping')).toHaveLength(1);
    await client.disconnect();
    expect(managerListeners.get('ping')).toHaveLength(0);
  });
});
