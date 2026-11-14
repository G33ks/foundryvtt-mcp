/**
 * @fileoverview Tests for scene/tile creation (`createScene`, `createTile`,
 * `deleteTile`, `listTiles`, `findOpenCells`, `listSceneAssets`).
 *
 * Uses a real temp directory under FOUNDRY_DATA_PATH with real minimal PNG
 * fixtures (same encoder as utils/__tests__/image-size.test.ts) so the
 * image-dimension auto-detection path is exercised end to end, not stubbed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios');
vi.mock('socket.io-client');
vi.mock('../auth.js', () => ({
  authenticateFoundry: vi
    .fn()
    .mockResolvedValue({ session: 'test-session', userId: 'test-user-id' }),
  sessionSocketOptions: (session: string) => ({
    transports: ['websocket'],
    query: { session },
    extraHeaders: { Cookie: `session=${session}` },
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

/** Minimal-but-valid PNG: signature + IHDR carrying width/height. */
function buildPng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([signature, ihdr]);
}

const SCENE_ID = 'sceneAAAAAAAAAAA';
const WALL_ID = 'wallAAAAAAAAAAAA';
const TILE_ID = 'tileAAAAAAAAAAAA';

/** One scene, grid size 100, with a single vertical wall crossing x=200. */
function baseWorldData() {
  return {
    userId: 'test-user-id',
    world: { id: 'w', title: 'Test World' },
    system: { id: 'cyberpunk-red-core', version: '0.92.4' },
    release: { version: '12.331' },
    actors: [],
    scenes: [
      {
        _id: SCENE_ID,
        name: 'Test Scene',
        active: true,
        navigation: true,
        width: 1000,
        height: 1000,
        padding: 0.25,
        darkness: 0,
        globalLight: false,
        grid: { type: 1, size: 100, distance: 1, units: 'ft' },
        walls: [{ _id: WALL_ID, c: [200, 0, 200, 1000], door: 0, ds: 0, move: 1 }],
        tiles: [],
        tokens: [],
      },
    ],
    items: [],
    journal: [],
    messages: [],
    combats: [],
    users: [],
    activeUsers: [],
    settings: [],
    macros: [],
    playlists: [],
    tables: [],
    folders: [],
  };
}

/** Mock socket supporting the 'world' handshake ack and 'modifyDocument' acks. */
function buildMockSocket(worldData: Record<string, unknown>) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const modifyResponses: unknown[] = [];
  const socket = {
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
        const response = modifyResponses.shift() ?? { result: [{}] };
        maybeAck(response);
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
  /** Queues the next `modifyDocument` ack response (create/update/delete result). */
  const queueModifyResponse = (result: unknown[]) => {
    modifyResponses.push({ result });
  };
  return { socket, listeners, fire, queueModifyResponse };
}

describe('FoundryClient scene & tile creation', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'foundry-data-test-'));
    mkdirSync(join(dataDir, 'assets', 'maps', 'v1'), { recursive: true });
    writeFileSync(
      join(dataDir, 'assets', 'maps', 'v1', 'Neon Alley [Alley, Neon].png'),
      buildPng(1000, 1000),
    );
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  async function connectClient(release?: Record<string, unknown>) {
    const { io } = await import('socket.io-client');
    const { authenticateFoundry } = await import('../auth.js');
    // afterEach's resetAllMocks() clears the module-factory resolved value.
    vi.mocked(authenticateFoundry).mockResolvedValue({
      session: 'test-session',
      userId: 'test-user-id',
    });
    const world: Record<string, unknown> = structuredClone(baseWorldData());
    if (release) {
      world.release = release;
    }
    const harness = buildMockSocket(world);
    vi.mocked(io).mockReturnValue(harness.socket as never);

    const client = new FoundryClient({
      baseUrl: 'http://localhost:30000',
      username: 'gm',
      password: 'secret',
      writeEnabled: true,
      dataPath: dataDir,
    });

    const connecting = client.connect();
    await vi.waitFor(() => expect(harness.listeners.get('session')?.length).toBe(1));
    harness.fire('session', { userId: 'test-user-id' });
    await connecting;

    return { client, ...harness };
  }

  describe('scene lighting', () => {
    it('setSceneLighting writes darkness and global light under environment', async () => {
      const { client, socket } = await connectClient();

      await client.setSceneLighting(SCENE_ID, {
        darkness: 0.5,
        globalLight: true,
        globalLightThreshold: 0.75,
      });

      const call = socket.emit.mock.calls.find(([event]) => event === 'modifyDocument');
      if (!call) {
        throw new Error('no modifyDocument request');
      }
      expect(call[1]).toMatchObject({
        type: 'Scene',
        action: 'update',
        operation: {
          updates: [
            {
              _id: SCENE_ID,
              environment: {
                darknessLevel: 0.5,
                globalLight: { enabled: true, darkness: { max: 0.75 } },
              },
            },
          ],
        },
      });
      const update = (call[1] as { operation: { updates: Record<string, unknown>[] } }).operation
        .updates[0];
      expect(update).not.toHaveProperty('darkness');
      expect(update).not.toHaveProperty('globalLight');
      expect(update).not.toHaveProperty('globalLightThreshold');
    });

    it('getCurrentScene reads environment once a v14 scene carries it', async () => {
      const { client, fire } = await connectClient();

      fire('modifyDocument', {
        type: 'Scene',
        action: 'update',
        result: [
          { _id: SCENE_ID, environment: { darknessLevel: 0.5, globalLight: { enabled: true } } },
        ],
      });

      const scene = await client.getCurrentScene(SCENE_ID);
      expect(scene.darkness).toBe(0.5);
      expect(scene.globalLight).toBe(true);
    });

    it('getCurrentScene still reads the older top-level fields', async () => {
      const { client } = await connectClient();

      const scene = await client.getCurrentScene(SCENE_ID);
      expect(scene.darkness).toBe(0);
      expect(scene.globalLight).toBe(false);
    });
  });

  describe('listSceneAssets', () => {
    it('lists images with real dimensions and parsed bracket tags', async () => {
      const { client } = await connectClient();
      const assets = client.listSceneAssets('assets');
      expect(assets).toHaveLength(1);
      expect(assets[0]).toMatchObject({
        path: 'assets/maps/v1/Neon Alley [Alley, Neon].png',
        name: 'Neon Alley',
        tags: ['Alley', 'Neon'],
        width: 1000,
        height: 1000,
      });
    });

    it('filters by query against filename/tags', async () => {
      const { client } = await connectClient();
      expect(client.listSceneAssets('assets', { query: 'neon' })).toHaveLength(1);
      expect(client.listSceneAssets('assets', { query: 'nonexistent' })).toHaveLength(0);
    });
  });

  describe('createScene', () => {
    it('auto-detects width/height from disk when not given', async () => {
      const { client, queueModifyResponse } = await connectClient();
      queueModifyResponse([
        {
          _id: 'sceneBBBBBBBBBBB',
          width: 1000,
          height: 1000,
          grid: { size: 280 },
        },
      ]);

      const scene = (await client.createScene(
        'New Scene',
        'assets/maps/v1/Neon Alley [Alley, Neon].png',
        { gridSize: 280 },
      )) as { width: number; height: number };

      expect(scene.width).toBe(1000);
      expect(scene.height).toBe(1000);
    });

    it('throws a clear error when the image cannot be read and no width/height given', async () => {
      const { client } = await connectClient();
      await expect(client.createScene('New Scene', 'assets/maps/v1/missing.png')).rejects.toThrow(
        /Could not read image dimensions/,
      );
    });

    it('rejects a path that escapes the Data directory', async () => {
      const { client } = await connectClient();
      await expect(client.createScene('New Scene', '../../../etc/passwd')).rejects.toThrow(
        /escapes the Data directory/,
      );
    });

    /** The Scene data `createScene` sent in its `modifyDocument` create request. */
    function sentSceneData(socket: { emit: ReturnType<typeof vi.fn> }) {
      const call = socket.emit.mock.calls.find((c) => c[0] === 'modifyDocument');
      const request = call?.[1] as { type: string; action: string; operation: { data: unknown[] } };
      expect(request).toMatchObject({ type: 'Scene', action: 'create' });
      return request.operation.data[0] as Record<string, unknown>;
    }

    it('puts the background on a default Level under FoundryVTT v14', async () => {
      const { client, socket } = await connectClient({ generation: 14, build: 370 });

      await client.createScene('New Scene', 'assets/maps/v1/Neon Alley [Alley, Neon].png');

      const data = sentSceneData(socket);
      expect(data).toMatchObject({
        name: 'New Scene',
        width: 1000,
        height: 1000,
        initialLevel: 'defaultLevel0000',
        levels: [
          {
            _id: 'defaultLevel0000',
            name: 'Level',
            background: {
              src: 'assets/maps/v1/Neon Alley [Alley, Neon].png',
              color: '#999999',
            },
          },
        ],
        grid: { type: 1, size: 100, distance: 1, units: 'ft' },
      });
      expect(data).not.toHaveProperty('background');
      expect(data).not.toHaveProperty('backgroundColor');
    });

    it('carries an explicit background colour on the v14 Level', async () => {
      const { client, socket } = await connectClient({ generation: 14, build: 370 });

      await client.createScene('New Scene', 'assets/maps/v1/missing.png', {
        width: 3000,
        height: 2000,
        backgroundColor: '#123456',
      });

      const data = sentSceneData(socket);
      expect(data).toMatchObject({ width: 3000, height: 2000 });
      expect(data.levels).toEqual([
        {
          _id: 'defaultLevel0000',
          name: 'Level',
          background: { src: 'assets/maps/v1/missing.png', color: '#123456' },
        },
      ]);
    });

    it('keeps the scene-level background under FoundryVTT v13', async () => {
      const { client, socket } = await connectClient({ generation: 13, version: '13.351' });

      await client.createScene('New Scene', 'assets/maps/v1/Neon Alley [Alley, Neon].png');

      const data = sentSceneData(socket);
      expect(data).toMatchObject({
        background: { src: 'assets/maps/v1/Neon Alley [Alley, Neon].png' },
        backgroundColor: '#999999',
      });
      expect(data).not.toHaveProperty('levels');
      expect(data).not.toHaveProperty('initialLevel');
    });

    it('reads the generation from the release version when it is not given', async () => {
      const { client, socket } = await connectClient({ version: '14.370' });

      await client.createScene('New Scene', 'assets/maps/v1/Neon Alley [Alley, Neon].png');

      expect(sentSceneData(socket)).toHaveProperty('initialLevel', 'defaultLevel0000');
    });
  });

  describe('createTile', () => {
    it('places a tile at explicit x/y with explicit size', async () => {
      const { client, queueModifyResponse } = await connectClient();
      queueModifyResponse([{ _id: TILE_ID, x: 50, y: 50, width: 40, height: 40 }]);

      const tile = (await client.createTile(
        SCENE_ID,
        'assets/maps/v1/Neon Alley [Alley, Neon].png',
        {
          x: 50,
          y: 50,
          width: 40,
          height: 40,
        },
      )) as { _id: string };

      expect(tile._id).toBe(TILE_ID);
    });

    it('centres a tile in a gridCol/gridRow cell', async () => {
      const { client, socket, queueModifyResponse } = await connectClient();
      queueModifyResponse([{ _id: TILE_ID }]);

      // Grid size 100: cell (5,5) spans x 500-600, y 500-600; a 40x40 tile
      // centred in it sits at top-left (530, 530).
      await client.createTile(SCENE_ID, 'assets/maps/v1/Neon Alley [Alley, Neon].png', {
        gridCol: 5,
        gridRow: 5,
        width: 40,
        height: 40,
      });

      const modifyCall = socket.emit.mock.calls.find(([event]) => event === 'modifyDocument');
      const request = modifyCall?.[1] as { operation: { data: Array<{ x: number; y: number }> } };
      expect(request.operation.data[0]).toMatchObject({ x: 530, y: 530 });
    });

    it('refuses placement whose bounding box crosses a wall', async () => {
      const { client } = await connectClient();
      // Wall runs x=200 the full height; a tile centred on x=200 straddles it.
      await expect(
        client.createTile(SCENE_ID, 'assets/maps/v1/Neon Alley [Alley, Neon].png', {
          x: 180,
          y: 400,
          width: 40,
          height: 40,
        }),
      ).rejects.toThrow(/crosses wall/);
    });

    it('allows a wall-crossing placement when allowWallOverlap is set', async () => {
      const { client, queueModifyResponse } = await connectClient();
      queueModifyResponse([{ _id: TILE_ID }]);

      await expect(
        client.createTile(SCENE_ID, 'assets/maps/v1/Neon Alley [Alley, Neon].png', {
          x: 180,
          y: 400,
          width: 40,
          height: 40,
          allowWallOverlap: true,
        }),
      ).resolves.toMatchObject({ _id: TILE_ID });
    });

    it('places cleanly on the side of the wall with no crossing', async () => {
      const { client, queueModifyResponse } = await connectClient();
      queueModifyResponse([{ _id: TILE_ID }]);

      await expect(
        client.createTile(SCENE_ID, 'assets/maps/v1/Neon Alley [Alley, Neon].png', {
          x: 50,
          y: 400,
          width: 40,
          height: 40,
        }),
      ).resolves.toMatchObject({ _id: TILE_ID });
    });

    it('requires either x/y or gridCol/gridRow', async () => {
      const { client } = await connectClient();
      await expect(
        client.createTile(SCENE_ID, 'assets/maps/v1/Neon Alley [Alley, Neon].png', {
          width: 40,
          height: 40,
        }),
      ).rejects.toThrow(/Either x\/y or gridCol\/gridRow/);
    });
  });

  describe('deleteTile / listTiles', () => {
    it('lists tiles from the cached scene', async () => {
      const { client } = await connectClient();
      const worldData = client.getWorldData();
      const scene = worldData?.scenes.find((s) => (s as { _id: string })._id === SCENE_ID) as {
        tiles: unknown[];
      };
      scene.tiles.push({
        _id: TILE_ID,
        texture: { src: 'assets/maps/v1/x.png' },
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        rotation: 0,
        hidden: false,
      });

      const tiles = client.listTiles(SCENE_ID);
      expect(tiles).toEqual([
        {
          id: TILE_ID,
          src: 'assets/maps/v1/x.png',
          x: 10,
          y: 20,
          width: 30,
          height: 40,
          rotation: 0,
          hidden: false,
        },
      ]);
    });

    it('createTile makes the new tile immediately visible to listTiles without refreshWorldData', async () => {
      const { client, queueModifyResponse } = await connectClient();
      expect(client.listTiles(SCENE_ID)).toHaveLength(0);

      queueModifyResponse([
        {
          _id: TILE_ID,
          texture: { src: 'assets/maps/v1/Neon Alley [Alley, Neon].png' },
          x: 50,
          y: 50,
          width: 40,
          height: 40,
          rotation: 0,
          hidden: false,
        },
      ]);

      await client.createTile(SCENE_ID, 'assets/maps/v1/Neon Alley [Alley, Neon].png', {
        x: 50,
        y: 50,
        width: 40,
        height: 40,
      });

      const listed = client.listTiles(SCENE_ID);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(TILE_ID);
      expect(listed[0]?.x).toBe(50);
    });

    it('deletes a tile via modifyDocument and updates cache in place', async () => {
      const { client, queueModifyResponse } = await connectClient();
      const worldData = client.getWorldData();
      const scene = worldData?.scenes.find((s) => (s as { _id: string })._id === SCENE_ID) as {
        tiles: unknown[];
      };
      scene.tiles.push({
        _id: TILE_ID,
        texture: { src: 'assets/maps/v1/x.png' },
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        rotation: 0,
        hidden: false,
      });
      expect(client.listTiles(SCENE_ID)).toHaveLength(1);

      queueModifyResponse([TILE_ID]);
      await client.deleteTile(SCENE_ID, TILE_ID);
      expect(client.listTiles(SCENE_ID)).toHaveLength(0);
    });
  });

  describe('findOpenCells', () => {
    it('excludes cells the wall crosses and includes cells that are clear', async () => {
      const { client } = await connectClient();
      const cells = client.findOpenCells(SCENE_ID, { limit: 200 });

      // Grid size 100, wall at x=200 full height: column 2 (x 200-300) cells
      // straddle the wall on their left edge and must not appear as open.
      const col2Cells = cells.filter((c) => c.col === 2);
      expect(col2Cells).toHaveLength(0);

      // Column 0 (x 0-100) is clear of the wall.
      const col0Cells = cells.filter((c) => c.col === 0);
      expect(col0Cells.length).toBeGreaterThan(0);
    });

    it('excludes a cell already occupied by a tile', async () => {
      const { client } = await connectClient();
      const worldData = client.getWorldData();
      const scene = worldData?.scenes.find((s) => (s as { _id: string })._id === SCENE_ID) as {
        tiles: unknown[];
      };
      scene.tiles.push({ _id: TILE_ID, x: 0, y: 0, width: 100, height: 100 });

      const cells = client.findOpenCells(SCENE_ID, { limit: 200 });
      const occupiedCell = cells.find((c) => c.col === 0 && c.row === 0);
      expect(occupiedCell).toBeUndefined();
    });
  });

  describe('resetFog', () => {
    it('emits resetFog socket event with sceneId', async () => {
      const { client, socket } = await connectClient();
      await client.resetFog(SCENE_ID);
      expect(socket.emit).toHaveBeenCalledWith('resetFog', SCENE_ID);
    });

    it('rejects invalid sceneId', async () => {
      const { client } = await connectClient();
      await expect(client.resetFog('invalid')).rejects.toThrow(/Invalid sceneId format/);
    });
  });
});

/**
 * FoundryVTT v14 answers a write that has server-side side effects with
 * `{results: [...sideEffects, response]}` instead of a bare response
 * (server-backend.mjs) — activating a scene deactivates the others.
 */
describe('FoundryClient writes answered with side effects', () => {
  const OTHER_SCENE = 'othr0000scene000';

  async function connectClient() {
    const { io } = await import('socket.io-client');
    const { authenticateFoundry } = await import('../auth.js');
    vi.mocked(authenticateFoundry).mockResolvedValue({
      session: 'test-session',
      userId: 'test-user-id',
    });
    const world = structuredClone(baseWorldData()) as Record<string, unknown> & {
      scenes: Array<Record<string, unknown>>;
    };
    world.scenes.push({ _id: OTHER_SCENE, name: 'Other', active: false });
    const harness = buildMockSocket(world);
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

  it('returns the operation result and applies the side effects to the cache', async () => {
    const { client, socket } = await connectClient();
    socket.emit.mockImplementationOnce(((
      _event: string,
      _payload: unknown,
      ack: (r: unknown) => void,
    ) => {
      ack({
        results: [
          {
            type: 'Scene',
            action: 'update',
            operation: {},
            result: [{ _id: SCENE_ID, active: false }],
            sideEffect: true,
            userId: 'test-user-id',
          },
          {
            type: 'Scene',
            action: 'update',
            operation: {},
            result: [{ _id: OTHER_SCENE, active: true }],
            userId: 'test-user-id',
          },
        ],
      });
      return socket;
    }) as never);

    await expect(client.switchScene(OTHER_SCENE)).resolves.toEqual({
      _id: OTHER_SCENE,
      active: true,
    });
    const scenes = (client as unknown as { worldData: { scenes: Array<Record<string, unknown>> } })
      .worldData.scenes;
    expect(scenes.find((s) => s._id === SCENE_ID)?.active).toBe(false);
    expect(scenes.find((s) => s._id === OTHER_SCENE)?.active).toBe(true);
  });

  it('rejects when any element of the answer carries an error', async () => {
    const { client, socket } = await connectClient();
    socket.emit.mockImplementationOnce(((
      _event: string,
      _payload: unknown,
      ack: (r: unknown) => void,
    ) => {
      ack({
        results: [
          {
            type: 'Scene',
            action: 'update',
            operation: {},
            result: [],
            error: { message: 'Nope' },
          },
        ],
      });
      return socket;
    }) as never);

    await expect(client.switchScene(OTHER_SCENE)).rejects.toThrow(/rejected update Scene: Nope/);
  });

  it('listens to modifyDocumentBatch and stops listening on disconnect', async () => {
    const { client, listeners, fire } = await connectClient();
    expect(listeners.get('modifyDocumentBatch')?.length).toBe(1);
    fire('modifyDocumentBatch', {
      results: [
        {
          type: 'Scene',
          action: 'delete',
          operation: {},
          result: [OTHER_SCENE],
          userId: 'someone000000000',
        },
      ],
    });
    const scenes = (client as unknown as { worldData: { scenes: Array<Record<string, unknown>> } })
      .worldData.scenes;
    expect(scenes.map((s) => s._id)).not.toContain(OTHER_SCENE);
    await client.disconnect();
    expect(listeners.get('modifyDocumentBatch')?.length ?? 0).toBe(0);
  });
});
