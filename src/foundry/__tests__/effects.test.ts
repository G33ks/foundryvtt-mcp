/**
 * @fileoverview Tests for generalized ActiveEffect client methods.
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

const ACTOR_ID = 'actorAAAAAAAAAAA';

function baseWorldData() {
  return {
    userId: 'test-user-id',
    world: { id: 'w', title: 'Test World' },
    system: { id: 'cyberpunk-red-core', version: '0.92.4' },
    release: { version: '12.331' },
    actors: [{ _id: ACTOR_ID, name: 'Vex', type: 'character', system: {}, effects: [] }],
    scenes: [],
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

interface MockSocket {
  connected: boolean;
  on: Mock;
  once: Mock;
  off: Mock;
  emit: Mock;
  disconnect: Mock;
}

function buildMockSocket(worldData: Record<string, unknown>) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const socket: MockSocket = {
    connected: true,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(handler);
      listeners.set(event, existing);
      return socket;
    }),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(handler);
      listeners.set(event, existing);
      return socket;
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const remaining = (listeners.get(event) ?? []).filter((h) => h !== handler);
      listeners.set(event, remaining);
      return socket;
    }),
    emit: vi.fn((event: string, payloadOrAck?: unknown, maybeAck?: (payload: unknown) => void) => {
      if (event === 'world' && typeof payloadOrAck === 'function') {
        (payloadOrAck as (p: unknown) => void)(worldData);
      } else if (event === 'modifyDocument' && typeof maybeAck === 'function') {
        const op = (
          payloadOrAck as {
            operation?: {
              data?: Array<Record<string, unknown>>;
              updates?: Array<Record<string, unknown>>;
              ids?: string[];
            };
          }
        ).operation;
        if (op?.ids) {
          maybeAck({ result: op.ids });
        } else {
          const doc = op?.data?.[0] ?? op?.updates?.[0] ?? {};
          maybeAck({ result: [{ _id: 'effectAAAAAAAAAA', ...doc }] });
        }
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
  return { socket, listeners, fire };
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
  });

  const connecting = client.connect();
  await vi.waitFor(() => expect(harness.listeners.get('session')?.length).toBe(1));
  harness.fire('session', { userId: 'test-user-id' });
  await connecting;

  return { client, ...harness };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('FoundryClient — generalized ActiveEffects', () => {
  it('maps changes[].mode names to the correct numeric CONST.ACTIVE_EFFECT_MODES', async () => {
    const { client, socket } = await connectClient();
    await client.createActorEffect(`Actor.${ACTOR_ID}`, {
      name: 'Strength Buff',
      changes: [
        { key: 'system.stats.str', mode: 'add', value: '2' },
        { key: 'system.stats.dex', mode: 'override', value: '5' },
        { key: 'system.stats.body', mode: 'custom', value: '1' },
      ],
    });

    const modifyCall = socket.emit.mock.calls.find(([event]) => event === 'modifyDocument');
    const req = modifyCall?.[1] as { operation: { data: Array<Record<string, unknown>> } };
    const changes = req.operation.data[0]?.changes as Array<{ key: string; mode: number }>;
    expect(changes).toEqual([
      { key: 'system.stats.str', mode: 2, value: '2' },
      { key: 'system.stats.dex', mode: 5, value: '5' },
      { key: 'system.stats.body', mode: 0, value: '1' },
    ]);
  });

  it('rejects an unrecognized change mode name', async () => {
    const { client } = await connectClient();
    await expect(
      client.createActorEffect(`Actor.${ACTOR_ID}`, {
        name: 'Bad Effect',
        changes: [{ key: 'x', mode: 'bogus' as never, value: '1' }],
      }),
    ).rejects.toThrow(/Invalid effect change mode/);
  });

  it('sends the correct parentUuid for a world-linked actor', async () => {
    const { client, socket } = await connectClient();
    await client.createActorEffect(`Actor.${ACTOR_ID}`, { name: 'Blessed' });
    const modifyCall = socket.emit.mock.calls.find(([event]) => event === 'modifyDocument');
    const req = modifyCall?.[1] as { operation: { parentUuid: string } };
    expect(req.operation.parentUuid).toBe(`Actor.${ACTOR_ID}`);
  });

  it("sends an unlinked token actor's effect to the token's ActorDelta", async () => {
    const { client, socket } = await connectClient();
    const uuid = `Scene.sceneAAAAAAAAAAA.Token.tokenAAAAAAAAAAA.Actor.${ACTOR_ID}`;
    await client.createActorEffect(uuid, { name: 'Blessed' });
    const modifyCall = socket.emit.mock.calls.find(([event]) => event === 'modifyDocument');
    const req = modifyCall?.[1] as { operation: { parentUuid: string } };
    // The delta id defaults to the token id (FoundryVTT's ActorDeltaField)
    expect(req.operation.parentUuid).toBe(
      'Scene.sceneAAAAAAAAAAA.Token.tokenAAAAAAAAAAA.ActorDelta.tokenAAAAAAAAAAA',
    );
  });

  it('rejects a malformed actor UUID', async () => {
    const { client } = await connectClient();
    await expect(client.createActorEffect('not-a-valid-uuid', { name: 'Blessed' })).rejects.toThrow(
      /Invalid actor UUID format/,
    );
  });

  it('lists effects cached on a world-linked actor', async () => {
    const { client } = await connectClient();
    const effects = client.listActorEffects(ACTOR_ID);
    expect(effects).toEqual([]);
  });

  it('updateActorEffect replaces only supplied fields', async () => {
    const { client, socket } = await connectClient();
    await client.updateActorEffect(`Actor.${ACTOR_ID}`, 'effectAAAAAAAAAA', {
      disabled: true,
      changes: [{ key: 'system.stats.str', mode: 'multiply', value: '2' }],
    });
    const modifyCall = socket.emit.mock.calls.find(([event]) => event === 'modifyDocument');
    const req = modifyCall?.[1] as { operation: { updates: Array<Record<string, unknown>> } };
    expect(req.operation.updates[0]).toMatchObject({
      _id: 'effectAAAAAAAAAA',
      disabled: true,
      changes: [{ key: 'system.stats.str', mode: 1, value: '2' }],
    });
    expect(req.operation.updates[0]?.name).toBeUndefined();
  });
});
