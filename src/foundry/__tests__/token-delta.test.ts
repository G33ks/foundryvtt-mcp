/**
 * @fileoverview Tests for per-token actor data on unlinked tokens (FoundryVTT
 * v14 ActorDelta) and for status effects created on a token's actor.
 */

import { describe, expect, it, vi } from 'vitest';
import { FoundryClient } from '../client.js';

const SCENE_ID = 'ssssssssssssssss';
const TOKEN_ID = 'tttttttttttttttt';
const LINKED_TOKEN_ID = 'llllllllllllllll';
const ACTOR_ID = 'aaaaaaaaaaaaaaaa';
const DELTA_ID = 'dddddddddddddddd';

type SocketEmitMock = (event: string, payload: unknown, cb: (response: unknown) => void) => void;

/**
 * A drake base actor at 22/22 HP, one unlinked token whose delta has it at
 * 13 HP, and one linked token. The socket echoes the first update/create back.
 */
const buildClient = (opts: { delta?: Record<string, unknown> } = {}) => {
  const client = new FoundryClient({ baseUrl: 'http://localhost:30000', writeEnabled: true });
  const emit = vi.fn(((_event, payload, cb) => {
    const op = (
      payload as {
        operation?: {
          updates?: Array<Record<string, unknown>>;
          data?: Array<Record<string, unknown>>;
          ids?: string[];
        };
      }
    ).operation;
    const result = op?.updates ?? op?.data ?? op?.ids ?? [];
    cb({ result: [result[0] ?? {}] });
  }) as SocketEmitMock);
  const internals = client as unknown as {
    socket: { connected: boolean; emit: SocketEmitMock };
    worldData: Record<string, unknown>;
  };
  internals.socket = { connected: true, emit };
  internals.worldData = {
    actors: [
      {
        _id: ACTOR_ID,
        name: 'Ambush Drake',
        type: 'npc',
        system: { attributes: { hp: { value: 22, max: 22 }, ac: { value: 13 } } },
        effects: [],
      },
    ],
    scenes: [
      {
        _id: SCENE_ID,
        name: 'Lodge',
        tokens: [
          {
            _id: TOKEN_ID,
            name: 'Ambush Drake',
            actorId: ACTOR_ID,
            actorLink: false,
            delta: opts.delta ?? { _id: TOKEN_ID, system: { attributes: { hp: { value: 13 } } } },
          },
          { _id: LINKED_TOKEN_ID, name: 'Drake (linked)', actorId: ACTOR_ID, actorLink: true },
        ],
      },
    ],
    items: [],
    combats: [],
  };
  return { client, emit };
};

const firstBody = (emit: ReturnType<typeof vi.fn>) =>
  (emit.mock.calls[0] as unknown[])[1] as Record<string, unknown>;

describe('FoundryClient.getTokenActorSystem', () => {
  it("merges an unlinked token's delta over its base actor", () => {
    const { client } = buildClient();
    expect(client.getTokenActorSystem(TOKEN_ID, SCENE_ID)).toEqual({
      attributes: { hp: { value: 13, max: 22 }, ac: { value: 13 } },
    });
  });

  it('does not change the cached base actor', () => {
    const { client } = buildClient();
    client.getTokenActorSystem(TOKEN_ID, SCENE_ID);
    expect(client.getRawActor(ACTOR_ID)?.system).toMatchObject({
      attributes: { hp: { value: 22 } },
    });
  });

  it("returns the world actor's system for a linked token", () => {
    const { client } = buildClient();
    expect(client.getTokenActorSystem(LINKED_TOKEN_ID, SCENE_ID)).toMatchObject({
      attributes: { hp: { value: 22, max: 22 } },
    });
  });

  it('returns undefined for an unknown token', () => {
    const { client } = buildClient();
    expect(client.getTokenActorSystem('xxxxxxxxxxxxxxxx', SCENE_ID)).toBeUndefined();
  });
});

describe('FoundryClient.updateTokenActorAttribute', () => {
  it("sends an unlinked token's change as an ActorDelta update parented to the token", async () => {
    const { client, emit } = buildClient({
      delta: { _id: DELTA_ID, system: { attributes: { hp: { value: 13 } } } },
    });
    await client.updateTokenActorAttribute(SCENE_ID, TOKEN_ID, { 'attributes.hp.value': 9 });
    expect(firstBody(emit)).toMatchObject({
      type: 'ActorDelta',
      action: 'update',
      operation: {
        updates: [{ _id: DELTA_ID, 'system.attributes.hp.value': 9 }],
        parentUuid: `Scene.${SCENE_ID}.Token.${TOKEN_ID}`,
        syntheticActorUpdate: true,
      },
    });
  });

  it('reads its own ActorDelta update back at once, without a refresh', async () => {
    const { client } = buildClient();
    const result = await client.updateTokenActorAttribute(SCENE_ID, TOKEN_ID, {
      'attributes.hp.value': 9,
    });
    expect(result.updatedAttributes).toEqual({ 'attributes.hp.value': 9 });
    expect(client.getTokenActorSystem(TOKEN_ID, SCENE_ID)).toMatchObject({
      attributes: { hp: { value: 9, max: 22 } },
    });
    expect(client.getRawActor(ACTOR_ID)?.system).toMatchObject({
      attributes: { hp: { value: 22 } },
    });
  });

  it("falls back to the token's id when the delta has no id", async () => {
    const { client, emit } = buildClient({ delta: {} });
    await client.updateTokenActorAttribute(SCENE_ID, TOKEN_ID, { 'attributes.hp.value': 9 });
    expect(firstBody(emit)).toMatchObject({
      operation: { updates: [{ _id: TOKEN_ID }] },
    });
  });

  it("checks HP against the token's own max", async () => {
    const { client, emit } = buildClient();
    await expect(
      client.updateTokenActorAttribute(SCENE_ID, TOKEN_ID, { 'attributes.hp.value': 23 }),
    ).rejects.toThrow(/exceeds max/);
    expect(emit).not.toHaveBeenCalled();
  });

  it('updates the world actor for a linked token', async () => {
    const { client, emit } = buildClient();
    await client.updateTokenActorAttribute(SCENE_ID, LINKED_TOKEN_ID, {
      'attributes.hp.value': 20,
    });
    expect(firstBody(emit)).toMatchObject({
      type: 'Actor',
      action: 'update',
      operation: { updates: [{ _id: ACTOR_ID }] },
    });
  });

  it('rejects a token that is not in the cache', async () => {
    const { client } = buildClient();
    await expect(
      client.updateTokenActorAttribute(SCENE_ID, 'xxxxxxxxxxxxxxxx', { 'attributes.hp.value': 1 }),
    ).rejects.toThrow(/Token not found/);
  });
});

describe('FoundryClient.createActorStatusEffect', () => {
  const tokenActorUuid = `Scene.${SCENE_ID}.Token.${TOKEN_ID}.Actor.${ACTOR_ID}`;

  it('always shows the icon and sends no id of its own', async () => {
    const { client, emit } = buildClient();
    await client.createActorStatusEffect(tokenActorUuid, 'prone');
    const body = firstBody(emit);
    const data = (body.operation as { data: Array<Record<string, unknown>> }).data;
    expect(data[0]).toEqual({ name: 'prone', statuses: ['prone'], showIcon: 2 });
    expect(body.operation).not.toHaveProperty('keepId');
  });

  it("parents the effect to the delta's own id when it has one", async () => {
    const { client, emit } = buildClient({ delta: { _id: DELTA_ID } });
    await client.createActorStatusEffect(tokenActorUuid, 'prone');
    expect(firstBody(emit)).toMatchObject({
      operation: { parentUuid: `Scene.${SCENE_ID}.Token.${TOKEN_ID}.ActorDelta.${DELTA_ID}` },
    });
  });
});

describe('FoundryClient.getTokenActorEffects / getTokenActorItems', () => {
  const base = {
    effects: [
      { _id: 'baseEffect000001', name: 'Blessed' },
      { _id: 'baseEffect000002', name: 'Shielded' },
    ],
    items: [
      { _id: 'baseItem00000001', name: 'Rope', type: 'loot', system: { quantity: 1 } },
      { _id: 'baseItem00000002', name: 'Torch', type: 'loot', system: { quantity: 2 } },
    ],
  };
  const delta = {
    _id: DELTA_ID,
    effects: [
      { _id: 'baseEffect000001', name: 'Blessed', disabled: true },
      { _id: 'baseEffect000002', _tombstone: true },
      { _id: 'ownEffect0000001', name: 'Hasted' },
    ],
    items: [
      { _id: 'baseItem00000002', _tombstone: true },
      { _id: 'ownItem000000001', name: 'Key', type: 'loot', system: {} },
    ],
  };
  const withBase = (opts: { delta?: Record<string, unknown> } = {}) => {
    const built = buildClient(opts);
    const actor = built.client.getRawActor(ACTOR_ID) as unknown as Record<string, unknown>;
    Object.assign(actor, structuredClone(base));
    return built;
  };

  it("puts the delta's entries in place of the base's, adds its own and leaves tombstones out", () => {
    const { client } = withBase({ delta: structuredClone(delta) });
    expect(client.getTokenActorEffects(TOKEN_ID, SCENE_ID)).toEqual([
      { _id: 'baseEffect000001', name: 'Blessed', disabled: true },
      { _id: 'ownEffect0000001', name: 'Hasted' },
    ]);
    expect(client.getTokenActorItems(TOKEN_ID, SCENE_ID)?.map((item) => item._id)).toEqual([
      'baseItem00000001',
      'ownItem000000001',
    ]);
  });

  it('leaves the cached base actor and delta as they were', () => {
    const { client } = withBase({ delta: structuredClone(delta) });
    client.getTokenActorEffects(TOKEN_ID, SCENE_ID);
    client.getTokenActorItems(TOKEN_ID, SCENE_ID);
    expect(client.getRawActor(ACTOR_ID)?.effects).toEqual(base.effects);
    expect(client.getRawActor(ACTOR_ID)?.items).toEqual(base.items);
    expect(client.findToken(TOKEN_ID, SCENE_ID)?.token.delta).toEqual(delta);
  });

  it("returns the base actor's entries for an unlinked token without a delta of its own", () => {
    const { client } = withBase({ delta: {} });
    expect(client.getTokenActorEffects(TOKEN_ID, SCENE_ID)).toEqual(base.effects);
  });

  it("returns the world actor's entries for a linked token", () => {
    const { client } = withBase();
    expect(client.getTokenActorItems(LINKED_TOKEN_ID, SCENE_ID)).toEqual(base.items);
  });

  it('returns undefined for a token that is not in the cache', () => {
    const { client } = withBase();
    expect(client.getTokenActorEffects('xxxxxxxxxxxxxxxx', SCENE_ID)).toBeUndefined();
  });
});

describe('FoundryClient.resolveTokenActor', () => {
  it('says whether the token shares its world actor', () => {
    const { client } = buildClient();
    expect(client.resolveTokenActor(TOKEN_ID, SCENE_ID, ACTOR_ID)).toMatchObject({
      actorId: ACTOR_ID,
      linked: false,
    });
    expect(client.resolveTokenActor(LINKED_TOKEN_ID, SCENE_ID)).toMatchObject({ linked: true });
  });

  it('refuses another actor, or a token that is not in the cache', () => {
    const { client } = buildClient();
    expect(() => client.resolveTokenActor(TOKEN_ID, SCENE_ID, 'otherActor000001')).toThrow(
      `Token ${TOKEN_ID} carries actor ${ACTOR_ID}, not otherActor000001`,
    );
    expect(() => client.resolveTokenActor('xxxxxxxxxxxxxxxx', SCENE_ID)).toThrow(
      `Token not found: xxxxxxxxxxxxxxxx in scene ${SCENE_ID}`,
    );
  });

  it('names a scene that is not in the cache', () => {
    const { client } = buildClient();
    expect(() => client.resolveTokenActor(TOKEN_ID, 'noSceneXXXXXXXXX')).toThrow(
      'Scene not found: noSceneXXXXXXXXX',
    );
    expect(() => client.resolveTokenActor('xxxxxxxxxxxxxxxx')).toThrow(
      'Token not found: xxxxxxxxxxxxxxxx',
    );
  });
});

describe('FoundryClient.getTokenActor', () => {
  it("maps an unlinked token's own actor: its HP, the base actor's id", () => {
    const { client } = buildClient();
    expect(client.getTokenActor(TOKEN_ID, SCENE_ID)).toMatchObject({
      _id: ACTOR_ID,
      name: 'Ambush Drake',
      hp: { value: 13, max: 22 },
    });
  });

  it('takes the name from the delta when it has one', () => {
    const { client } = buildClient({ delta: { _id: TOKEN_ID, name: 'Drake leader' } });
    expect(client.getTokenActor(TOKEN_ID, SCENE_ID).name).toBe('Drake leader');
  });

  it('maps the world actor for a linked token', () => {
    const { client } = buildClient();
    expect(client.getTokenActor(LINKED_TOKEN_ID, SCENE_ID)).toMatchObject({
      hp: { value: 22, max: 22 },
    });
  });
});

describe('FoundryClient item writes for one token', () => {
  const INHERITED_ITEM_ID = 'baseItem00000001';
  const unlinked = { sceneId: SCENE_ID, tokenId: TOKEN_ID };
  const withItem = (opts: { delta?: Record<string, unknown> } = {}) => {
    const built = buildClient(opts);
    const actor = built.client.getRawActor(ACTOR_ID) as unknown as Record<string, unknown>;
    actor.items = [{ _id: INHERITED_ITEM_ID, name: 'Rope', type: 'loot', system: { quantity: 1 } }];
    return built;
  };

  it("sends an unlinked token's item writes under its ActorDelta", async () => {
    const { client, emit } = withItem({ delta: { _id: DELTA_ID } });
    const deltaUuid = `Scene.${SCENE_ID}.Token.${TOKEN_ID}.ActorDelta.${DELTA_ID}`;
    await client.createActorItem(
      ACTOR_ID,
      { type: 'inline', item: { name: 'Key', type: 'loot' } },
      unlinked,
    );
    await client.updateActorItem(ACTOR_ID, INHERITED_ITEM_ID, { quantity: 3 }, unlinked);
    await client.deleteActorItem(ACTOR_ID, INHERITED_ITEM_ID, unlinked);
    const parents = emit.mock.calls.map(
      (call) => (call[1] as { operation: { parentUuid: string } }).operation.parentUuid,
    );
    expect(parents).toEqual([deltaUuid, deltaUuid, deltaUuid]);
  });

  it("sends a linked token's item writes to its world actor", async () => {
    const { client, emit } = withItem();
    await client.deleteActorItem(ACTOR_ID, INHERITED_ITEM_ID, {
      sceneId: SCENE_ID,
      tokenId: LINKED_TOKEN_ID,
    });
    expect(firstBody(emit)).toMatchObject({ operation: { parentUuid: `Actor.${ACTOR_ID}` } });
  });

  it('refuses a token that carries another actor, sending nothing', async () => {
    const { client, emit } = withItem();
    await expect(
      client.updateActorItem('otherActor000001', INHERITED_ITEM_ID, { quantity: 3 }, unlinked),
    ).rejects.toThrow(/carries actor/);
    expect(emit).not.toHaveBeenCalled();
  });

  it('shows its own update of an inherited item at once, on that token only', async () => {
    const { client } = withItem();
    await client.updateActorItem(ACTOR_ID, INHERITED_ITEM_ID, { quantity: 3 }, unlinked);
    expect(client.getTokenActorItems(TOKEN_ID, SCENE_ID)).toEqual([
      { _id: INHERITED_ITEM_ID, name: 'Rope', type: 'loot', system: { quantity: 3 } },
    ]);
    expect(client.getRawActor(ACTOR_ID)?.items?.[0]?.system).toEqual({ quantity: 1 });
    expect(client.getTokenActorItems(LINKED_TOKEN_ID, SCENE_ID)?.[0]?.system).toEqual({
      quantity: 1,
    });
  });

  it('hides an inherited item it deleted at once, on that token only', async () => {
    const { client } = withItem();
    await client.deleteActorItem(ACTOR_ID, INHERITED_ITEM_ID, unlinked);
    expect(client.getTokenActorItems(TOKEN_ID, SCENE_ID)).toEqual([]);
    expect(client.getRawActor(ACTOR_ID)?.items).toHaveLength(1);
  });

  it("returns the updated item's name and type from the cache, which the server's answer lacks", async () => {
    const { client } = withItem();
    // The answer echoes only the update: {_id, system}.
    await expect(
      client.updateActorItem(ACTOR_ID, INHERITED_ITEM_ID, { quantity: 3 }, unlinked),
    ).resolves.toEqual({
      _id: INHERITED_ITEM_ID,
      system: { quantity: 3 },
      name: 'Rope',
      type: 'loot',
    });
    await expect(
      client.updateActorItem(ACTOR_ID, INHERITED_ITEM_ID, { quantity: 4 }),
    ).resolves.toMatchObject({ name: 'Rope', type: 'loot' });
  });
});
