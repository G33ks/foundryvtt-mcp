/**
 * @fileoverview Diagnostics of the Socket.IO acknowledgement wait: a late
 * acknowledgement is logged, and a timeout says how old the server's last
 * ping is, whether the socket is connected and how many requests wait. A
 * world document deletion whose acknowledgement timed out is checked by
 * re-reading the document once.
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

const { DELETE_VERIFIED_NOTE, FoundryClient } = await import('../client.js');
const { logger } = await import('../../utils/logger.js');

const SCENE_ID = 'sceneAAAAAAAAAAA';
const ACTOR_ID = 'actorAAAAAAAAAAA';
const COMBAT_ID = 'combatAAAAAAAAAA';
const JOURNAL_ID = 'journalAAAAAAAAA';
const MACRO_ID = 'macroAAAAAAAAAAA';
const PLAYLIST_ID = 'playlistAAAAAAAA';
const TABLE_ID = 'tableAAAAAAAAAAA';

type Ack = (response: unknown) => void;

function baseWorldData() {
  return {
    userId: 'test-user-id',
    world: { id: 'w', title: 'Test World' },
    system: { id: 's', version: '1.0.0' },
    release: { version: '14.370' },
    actors: [{ _id: ACTOR_ID, name: 'Actor', type: 'npc', items: [], effects: [] }],
    scenes: [{ _id: SCENE_ID, name: 'Scene', tokens: [] }],
    items: [],
    journal: [{ _id: JOURNAL_ID, name: 'Journal', pages: [] }],
    messages: [],
    combats: [{ _id: COMBAT_ID, scene: SCENE_ID, active: true, round: 1, turn: 0, combatants: [] }],
    users: [],
    activeUsers: [],
    settings: [],
    folders: [],
    macros: [{ _id: MACRO_ID, name: 'Macro', type: 'script', command: '' }],
    playlists: [{ _id: PLAYLIST_ID, name: 'Playlist', sounds: [] }],
    tables: [{ _id: TABLE_ID, name: 'Table', formula: '1d2', results: [] }],
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

type Client = InstanceType<typeof FoundryClient>;

const DELETIONS: Array<{
  tool: string;
  type: string;
  id: string;
  collection: 'actors' | 'combats' | 'journal' | 'macros' | 'playlists' | 'scenes' | 'tables';
  remove: (client: Client) => Promise<string | undefined>;
}> = [
  {
    tool: 'delete_scene',
    type: 'Scene',
    id: SCENE_ID,
    collection: 'scenes',
    remove: (c) => c.deleteScene(SCENE_ID),
  },
  {
    tool: 'delete_world_actor',
    type: 'Actor',
    id: ACTOR_ID,
    collection: 'actors',
    remove: (c) => c.deleteWorldActor(ACTOR_ID),
  },
  {
    tool: 'end_combat',
    type: 'Combat',
    id: COMBAT_ID,
    collection: 'combats',
    remove: (c) => c.endCombat(COMBAT_ID),
  },
  {
    tool: 'delete_journal_entry',
    type: 'JournalEntry',
    id: JOURNAL_ID,
    collection: 'journal',
    remove: (c) => c.deleteJournalEntry(JOURNAL_ID),
  },
  {
    tool: 'delete_macro',
    type: 'Macro',
    id: MACRO_ID,
    collection: 'macros',
    remove: (c) => c.deleteMacro(MACRO_ID),
  },
  {
    tool: 'delete_roll_table',
    type: 'RollTable',
    id: TABLE_ID,
    collection: 'tables',
    remove: (c) => c.deleteRollTable(TABLE_ID),
  },
  {
    tool: 'delete_playlist',
    type: 'Playlist',
    id: PLAYLIST_ID,
    collection: 'playlists',
    remove: (c) => c.deletePlaylist(PLAYLIST_ID),
  },
];

const TIMEOUT_MESSAGE =
  "Timeout waiting for 'modifyDocument' response (10000ms) " +
  '[last ping: none since connect; socket: connected; pending requests: 1]';

describe.each(DELETIONS)('$tool after an acknowledgement timeout', (deletion) => {
  const cachedIds = (client: Client) =>
    ((client.getWorldData()?.[deletion.collection] ?? []) as Array<{ _id: string }>).map(
      (d) => d._id,
    );

  /** Starts the deletion and lets its acknowledgement time out. */
  async function timeOutDeletion() {
    const harness = await connectClient();
    vi.useFakeTimers();
    const outcome = deletion.remove(harness.client);
    outcome.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10000);
    return { ...harness, outcome };
  }

  it('is unchanged when acknowledged in time: no re-read, no note', async () => {
    const { client, held } = await connectClient();
    const outcome = deletion.remove(client);
    held[0]?.ack({ result: [deletion.id] });

    await expect(outcome).resolves.toBeUndefined();
    expect(held).toHaveLength(1);
    expect(cachedIds(client)).not.toContain(deletion.id);
    expect(client.isWorldDataStale()).toBe(false);
  });

  it('re-reads the document once and succeeds with a note when it is gone', async () => {
    const { client, held, outcome } = await timeOutDeletion();

    expect(held).toHaveLength(2);
    expect(held[1]?.payload).toEqual({
      type: deletion.type,
      action: 'get',
      operation: { query: { _id: deletion.id }, pack: null },
    });
    // The deletion waits for the re-read: nothing else is sent meanwhile.
    let settled = false;
    void outcome.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false);

    held[1]?.ack({ result: [] });
    await expect(outcome).resolves.toBe(DELETE_VERIFIED_NOTE);
    expect(cachedIds(client)).not.toContain(deletion.id);
    expect(logger.warn).toHaveBeenCalledWith(
      'Deletion acknowledgement timed out, but re-reading shows the document is gone',
      { type: deletion.type, id: deletion.id },
    );
    // Never sent twice.
    const deletes = held.filter(
      ({ payload }) => (payload as { action?: string }).action === 'delete',
    );
    expect(deletes).toHaveLength(1);
  });

  it(`${deletion.type === 'Scene' ? 'marks' : 'does not mark'} the cache stale when a re-read confirms the deletion`, async () => {
    const { client, held, outcome } = await timeOutDeletion();

    held[1]?.ack({ result: [] });
    await expect(outcome).resolves.toBe(DELETE_VERIFIED_NOTE);
    if (deletion.type === 'Scene') {
      // Its combats were deleted with it, without any broadcast received.
      expect(client.worldDataStaleness()?.reason).toBe(
        'a scene deletion was only confirmed by re-reading it; its combats may still be cached',
      );
    } else {
      expect(client.isWorldDataStale()).toBe(false);
    }
  });

  it('keeps the timeout error unchanged when the document is still there', async () => {
    const { client, held, outcome } = await timeOutDeletion();

    held[1]?.ack({ result: [{ _id: deletion.id }] });
    await expect(outcome).rejects.toThrow(new Error(TIMEOUT_MESSAGE));
    expect(cachedIds(client)).toContain(deletion.id);
    expect(held).toHaveLength(2);
  });

  it('keeps the timeout error, with a mention, when the re-read times out', async () => {
    const { client, held, outcome } = await timeOutDeletion();

    await vi.advanceTimersByTimeAsync(10000);
    await expect(outcome).rejects.toThrow(
      `${TIMEOUT_MESSAGE} (re-reading the document to check failed: Timeout waiting for ` +
        "'modifyDocument' response (10000ms) " +
        '[last ping: none since connect; socket: connected; pending requests: 1])',
    );
    expect(cachedIds(client)).toContain(deletion.id);
    expect(held).toHaveLength(2);
  });

  it('keeps the timeout error, with a mention, when the re-read is refused', async () => {
    const { client, held, outcome } = await timeOutDeletion();

    held[1]?.ack({ error: { message: 'You may not do that' } });
    await expect(outcome).rejects.toThrow(
      `${TIMEOUT_MESSAGE} (re-reading the document to check failed: You may not do that)`,
    );
    expect(cachedIds(client)).toContain(deletion.id);
  });
});

describe('deletion without an acknowledgement timeout', () => {
  it('does not re-read a deletion that FoundryVTT refused', async () => {
    const { client, held } = await connectClient();
    const outcome = client.deleteScene(SCENE_ID);
    held[0]?.ack({ error: { message: 'Scene does not exist' } });

    await expect(outcome).rejects.toThrow('FoundryVTT rejected delete Scene: Scene does not exist');
    expect(held).toHaveLength(1);
  });
});
