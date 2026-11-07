import { afterEach, describe, expect, it } from 'vitest';
import type { WorldData } from '../types.js';
import {
  applyDocumentBroadcast,
  applyUserActivity,
  type DocumentBroadcast,
  parseDocumentBatch,
  parseDocumentBroadcast,
  parseUserActivity,
} from '../world-cache.js';

const ACTOR_ID = 'aaaaaaaaaaaaaaaa';
const ITEM_ID = 'bbbbbbbbbbbbbbbb';
const JOURNAL_ID = 'cccccccccccccccc';
const SCENE_ID = 'dddddddddddddddd';
const TOKEN_ID = 'eeeeeeeeeeeeeeee';
const COMBAT_ID = 'ffffffffffffffff';
const PAGE_ID = 'gggggggggggggggg';

/** Minimal WorldData with just the collections the tests touch. */
const buildWorldData = (): WorldData =>
  ({
    userId: 'user0000user0000',
    release: {},
    world: {},
    system: {},
    modules: [],
    demoMode: false,
    actors: [
      {
        _id: ACTOR_ID,
        name: 'Vex',
        type: 'character',
        system: { attributes: { hp: { value: 30, max: 40 } } },
        items: [{ _id: ITEM_ID, name: 'Longsword', type: 'weapon', system: {} }],
      },
    ],
    scenes: [
      { _id: SCENE_ID, name: 'Terris', active: true, tokens: [{ _id: TOKEN_ID, x: 0, y: 0 }] },
    ],
    items: [],
    journal: [],
    messages: [],
    combats: [{ _id: COMBAT_ID, active: true, round: 1, turn: 0, started: true, combatants: [] }],
    users: [],
    activeUsers: [],
    settings: [],
    folders: [],
    macros: [],
    playlists: [],
    tables: [],
    cards: [],
    packs: [],
  }) as unknown as WorldData;

const broadcast = (over: Partial<DocumentBroadcast> = {}): DocumentBroadcast => ({
  type: 'JournalEntry',
  action: 'create',
  result: [{ _id: JOURNAL_ID, name: 'Session 11 Recap' }],
  ...over,
});

describe('parseDocumentBroadcast', () => {
  it('parses a top-level broadcast', () => {
    expect(
      parseDocumentBroadcast({
        type: 'JournalEntry',
        action: 'create',
        result: [{ _id: JOURNAL_ID }],
      }),
    ).toEqual({ type: 'JournalEntry', action: 'create', result: [{ _id: JOURNAL_ID }] });
  });

  it('carries parentUuid through for embedded documents', () => {
    const parsed = parseDocumentBroadcast({
      type: 'Item',
      action: 'create',
      result: [{ _id: ITEM_ID }],
      operation: { parentUuid: `Actor.${ACTOR_ID}` },
    });
    expect(parsed?.parentUuid).toBe(`Actor.${ACTOR_ID}`);
  });

  it('captures userId when the envelope carries one', () => {
    const parsed = parseDocumentBroadcast({
      type: 'ChatMessage',
      action: 'create',
      result: [{ _id: JOURNAL_ID }],
      userId: 'user0001user0001',
    });
    expect(parsed?.userId).toBe('user0001user0001');
  });

  it('parses fine with userId absent', () => {
    const parsed = parseDocumentBroadcast({
      type: 'ChatMessage',
      action: 'create',
      result: [{ _id: JOURNAL_ID }],
    });
    expect(parsed?.userId).toBeUndefined();
  });

  it.each([
    ['not an object', 'nope'],
    ['missing type', { action: 'create', result: [] }],
    ['unknown action', { type: 'Actor', action: 'frobnicate', result: [] }],
    ['non-array result', { type: 'Actor', action: 'create', result: 'x' }],
    ['an error payload', { type: 'Actor', action: 'create', result: [], error: { message: 'no' } }],
  ])('rejects %s', (_label, payload) => {
    expect(parseDocumentBroadcast(payload)).toBeNull();
  });
});

describe('applyDocumentBroadcast — top-level documents', () => {
  it('adds a created journal entry to the cache', () => {
    const world = buildWorldData();
    expect(applyDocumentBroadcast(world, broadcast())).toBe(true);
    expect(world.journal).toHaveLength(1);
    expect(world.journal[0].name).toBe('Session 11 Recap');
  });

  it('is idempotent, so an echoed create does not duplicate', () => {
    const world = buildWorldData();
    applyDocumentBroadcast(world, broadcast());
    applyDocumentBroadcast(world, broadcast());
    expect(world.journal).toHaveLength(1);
  });

  it('merges an update rather than replacing the document', () => {
    const world = buildWorldData();
    applyDocumentBroadcast(world, broadcast());
    applyDocumentBroadcast(
      world,
      broadcast({ action: 'update', result: [{ _id: JOURNAL_ID, folder: 'folder0000000000' }] }),
    );
    expect(world.journal[0].name).toBe('Session 11 Recap');
    expect(world.journal[0].folder).toBe('folder0000000000');
  });

  it('removes a deleted document by id', () => {
    const world = buildWorldData();
    applyDocumentBroadcast(world, broadcast());
    expect(
      applyDocumentBroadcast(world, broadcast({ action: 'delete', result: [JOURNAL_ID] })),
    ).toBe(true);
    expect(world.journal).toHaveLength(0);
  });

  it('tolerates deleting an id that is already gone', () => {
    const world = buildWorldData();
    expect(
      applyDocumentBroadcast(world, broadcast({ action: 'delete', result: [JOURNAL_ID] })),
    ).toBe(false);
  });

  it('merges nested update paths without clobbering siblings', () => {
    const world = buildWorldData();
    applyDocumentBroadcast(world, {
      type: 'Actor',
      action: 'update',
      result: [{ _id: ACTOR_ID, system: { attributes: { hp: { value: 12 } } } }],
    });
    const hp = (world.actors[0].system.attributes as { hp: { value: number; max: number } }).hp;
    expect(hp.value).toBe(12);
    expect(hp.max).toBe(40);
  });

  it('ignores an update for a document not in the cache', () => {
    const world = buildWorldData();
    expect(
      applyDocumentBroadcast(world, broadcast({ action: 'update', result: [{ _id: 'zzzz' }] })),
    ).toBe(false);
  });

  it('ignores document types the cache does not model', () => {
    const world = buildWorldData();
    expect(applyDocumentBroadcast(world, broadcast({ type: 'Adventure' }))).toBe(false);
  });

  it('applies Setting document broadcasts to worldData.settings', () => {
    const world = buildWorldData();
    const settingDoc = { _id: 'settingAAAAAAAA', key: 'core.rollMode', value: '"publicroll"' };
    expect(
      applyDocumentBroadcast(
        world,
        broadcast({ type: 'Setting', action: 'create', result: [settingDoc] }),
      ),
    ).toBe(true);
    expect(world.settings).toHaveLength(1);
    expect(world.settings[0]).toMatchObject(settingDoc);
  });
});

// Broadcast payloads are untrusted network input, so a hostile one must not be
// able to reach Object.prototype. JSON.parse is used to build the payloads
// because an object literal's `__proto__` sets the prototype instead of
// creating an own key — which would not reproduce the attack.
describe('applyDocumentBroadcast — prototype pollution', () => {
  afterEach(() => {
    // Fail loudly rather than leaking a poisoned prototype into later tests.
    delete (Object.prototype as Record<string, unknown>).polluted;
  });

  it('does not pollute Object.prototype through a nested update patch', () => {
    const world = buildWorldData();
    applyDocumentBroadcast(world, broadcast());
    applyDocumentBroadcast(world, {
      type: 'JournalEntry',
      action: 'update',
      result: [JSON.parse(`{"_id": "${JOURNAL_ID}", "__proto__": {"polluted": "yes"}}`) as unknown],
    });

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not pollute Object.prototype through a create payload', () => {
    const world = buildWorldData();
    applyDocumentBroadcast(world, {
      type: 'JournalEntry',
      action: 'create',
      result: [
        JSON.parse(`{"_id": "newjournal000000", "__proto__": {"polluted": "yes"}}`) as unknown,
      ],
    });

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(world.journal).toHaveLength(1);
  });

  it('drops constructor and prototype keys while keeping the rest of the patch', () => {
    const world = buildWorldData();
    applyDocumentBroadcast(world, broadcast());
    applyDocumentBroadcast(world, {
      type: 'JournalEntry',
      action: 'update',
      result: [
        JSON.parse(
          `{"_id": "${JOURNAL_ID}", "constructor": "x", "prototype": "y", "name": "Renamed"}`,
        ) as unknown,
      ],
    });

    const entry = world.journal[0] as unknown as Record<string, unknown>;
    expect(entry.name).toBe('Renamed');
    expect(Object.hasOwn(entry, 'prototype')).toBe(false);
    expect(Object.hasOwn(entry, 'constructor')).toBe(false);
  });
});

describe('applyDocumentBroadcast — embedded documents', () => {
  it("adds an item to its parent actor's items", () => {
    const world = buildWorldData();
    const applied = applyDocumentBroadcast(world, {
      type: 'Item',
      action: 'create',
      result: [{ _id: 'newitem000000000', name: 'Potion', type: 'consumable' }],
      parentUuid: `Actor.${ACTOR_ID}`,
    });
    expect(applied).toBe(true);
    expect(world.actors[0].items).toHaveLength(2);
  });

  it("removes a deleted item from its parent actor's items", () => {
    const world = buildWorldData();
    applyDocumentBroadcast(world, {
      type: 'Item',
      action: 'delete',
      result: [ITEM_ID],
      parentUuid: `Actor.${ACTOR_ID}`,
    });
    expect(world.actors[0].items).toHaveLength(0);
  });

  it('materializes an absent embedded array on create', () => {
    const world = buildWorldData();
    const applied = applyDocumentBroadcast(world, {
      type: 'ActiveEffect',
      action: 'create',
      result: [{ _id: 'effect0000000000', name: 'Prone', statuses: ['prone'] }],
      parentUuid: `Actor.${ACTOR_ID}`,
    });
    expect(applied).toBe(true);
    expect(world.actors[0].effects).toHaveLength(1);
  });

  it("applies a page update to the parent journal entry's pages", () => {
    const world = buildWorldData();
    world.journal.push({
      _id: JOURNAL_ID,
      name: 'Session 11 Recap',
      pages: [
        { _id: PAGE_ID, name: 'Summary', type: 'text', text: { content: '<p>a</p>', format: 1 } },
      ],
    });
    const applied = applyDocumentBroadcast(world, {
      type: 'JournalEntryPage',
      action: 'update',
      result: [{ _id: PAGE_ID, 'text.content': '<p>b</p>' }],
      parentUuid: `JournalEntry.${JOURNAL_ID}`,
    });
    expect(applied).toBe(true);
    expect(world.journal[0].pages?.[0]).toMatchObject({
      name: 'Summary',
      text: { content: '<p>b</p>', format: 1 },
    });
  });

  it('adds a created page to its parent journal entry', () => {
    const world = buildWorldData();
    world.journal.push({ _id: JOURNAL_ID, name: 'Session 11 Recap', pages: [] });
    applyDocumentBroadcast(world, {
      type: 'JournalEntryPage',
      action: 'create',
      result: [{ _id: PAGE_ID, name: 'Loot', type: 'text' }],
      parentUuid: `JournalEntry.${JOURNAL_ID}`,
    });
    expect(world.journal[0].pages).toHaveLength(1);
  });

  it("applies a token move to the parent scene's tokens", () => {
    const world = buildWorldData();
    applyDocumentBroadcast(world, {
      type: 'Token',
      action: 'update',
      result: [{ _id: TOKEN_ID, x: 500, y: 750 }],
      parentUuid: `Scene.${SCENE_ID}`,
    });
    expect(world.scenes[0].tokens?.[0]).toMatchObject({ x: 500, y: 750 });
  });

  it('adds a combatant to its parent combat', () => {
    const world = buildWorldData();
    applyDocumentBroadcast(world, {
      type: 'Combatant',
      action: 'create',
      result: [{ _id: 'combatant000000a', name: 'Goblin', initiative: 14 }],
      parentUuid: `Combat.${COMBAT_ID}`,
    });
    expect(world.combats[0].combatants).toHaveLength(1);
  });

  it('ignores a broadcast whose parent is not in the cache', () => {
    const world = buildWorldData();
    expect(
      applyDocumentBroadcast(world, {
        type: 'Item',
        action: 'create',
        result: [{ _id: ITEM_ID }],
        parentUuid: 'Actor.doesnotexist00',
      }),
    ).toBe(false);
  });

  it('ignores synthetic token-actor UUIDs, which are not cached documents', () => {
    const world = buildWorldData();
    expect(
      applyDocumentBroadcast(world, {
        type: 'ActiveEffect',
        action: 'create',
        result: [{ _id: 'effect0000000000' }],
        parentUuid: `Scene.${SCENE_ID}.Token.${TOKEN_ID}.Actor.${ACTOR_ID}`,
      }),
    ).toBe(false);
  });
});

describe('applyDocumentBroadcast — unlinked token deltas', () => {
  const tokenUuid = `Scene.${SCENE_ID}.Token.${TOKEN_ID}`;
  const token = (world: WorldData) => world.scenes[0].tokens?.[0] as Record<string, unknown>;

  it("merges an ActorDelta update into the token's delta, not the base actor", () => {
    const world = buildWorldData();
    const applied = applyDocumentBroadcast(world, {
      type: 'ActorDelta',
      action: 'update',
      result: [{ _id: TOKEN_ID, 'system.attributes.hp.value': 13 }],
      parentUuid: tokenUuid,
    });
    expect(applied).toBe(true);
    expect(token(world).delta).toMatchObject({ system: { attributes: { hp: { value: 13 } } } });
    expect(world.actors[0].system).toMatchObject({ attributes: { hp: { value: 30 } } });
  });

  it("adds and removes an effect on the token's delta", () => {
    const world = buildWorldData();
    const parentUuid = `${tokenUuid}.ActorDelta.${TOKEN_ID}`;
    applyDocumentBroadcast(world, {
      type: 'ActiveEffect',
      action: 'create',
      result: [{ _id: 'effect0000000001', name: 'Prone', statuses: ['prone'] }],
      parentUuid,
    });
    expect((token(world).delta as { effects: unknown[] }).effects).toHaveLength(1);
    applyDocumentBroadcast(world, {
      type: 'ActiveEffect',
      action: 'delete',
      result: ['effect0000000001'],
      parentUuid,
    });
    expect((token(world).delta as { effects: unknown[] }).effects).toHaveLength(0);
    expect(world.actors[0].effects).toBeUndefined();
  });

  it('returns false for a token that is not in the cache', () => {
    const world = buildWorldData();
    expect(
      applyDocumentBroadcast(world, {
        type: 'ActorDelta',
        action: 'update',
        result: [{ _id: 'xxxxxxxxxxxxxxxx' }],
        parentUuid: `Scene.${SCENE_ID}.Token.xxxxxxxxxxxxxxxx`,
      }),
    ).toBe(false);
  });
});

describe('applyDocumentBroadcast — what an unlinked token inherits from its base actor', () => {
  const BASE_EFFECT_ID = 'baseEffect000001';
  const ITEM_EFFECT_ID = 'itemEffect000001';
  const OWN_ITEM_ID = 'ownItem000000001';
  const deltaUuid = `Scene.${SCENE_ID}.Token.${TOKEN_ID}.ActorDelta.${TOKEN_ID}`;

  /** The base actor has an item (with an effect of its own) and an effect; the token none yet. */
  const buildInheritingWorld = (delta?: Record<string, unknown>): WorldData => {
    const world = buildWorldData();
    const actor = world.actors[0] as unknown as Record<string, unknown>;
    actor.items = [
      {
        _id: ITEM_ID,
        name: 'Longsword',
        type: 'weapon',
        system: { quantity: 1 },
        effects: [{ _id: ITEM_EFFECT_ID, name: 'Keen', disabled: false }],
      },
    ];
    actor.effects = [{ _id: BASE_EFFECT_ID, name: 'Blessed', disabled: false }];
    world.scenes[0].tokens = [
      {
        _id: TOKEN_ID,
        actorId: ACTOR_ID,
        actorLink: false,
        ...(delta ? { delta } : {}),
      },
    ] as never;
    return world;
  };
  const token = (world: WorldData) => world.scenes[0].tokens?.[0] as Record<string, unknown>;
  const delta = (world: WorldData) =>
    token(world).delta as
      | { items?: Array<Record<string, unknown>>; effects?: Array<Record<string, unknown>> }
      | undefined;
  const baseActor = (world: WorldData) => world.actors[0] as unknown as Record<string, unknown>;

  it('adopts an inherited item on its first update, then merges the change', () => {
    const world = buildInheritingWorld();
    const applied = applyDocumentBroadcast(world, {
      type: 'Item',
      action: 'update',
      result: [{ _id: ITEM_ID, 'system.quantity': 3 }],
      parentUuid: deltaUuid,
    });
    expect(applied).toBe(true);
    expect(delta(world)?.items).toEqual([
      {
        _id: ITEM_ID,
        name: 'Longsword',
        type: 'weapon',
        system: { quantity: 3 },
        effects: [{ _id: ITEM_EFFECT_ID, name: 'Keen', disabled: false }],
      },
    ]);
    // A copy: the base actor, shared by every other token, is untouched.
    expect((baseActor(world).items as Array<{ system: unknown }>)[0]?.system).toEqual({
      quantity: 1,
    });
  });

  it('adopts an inherited effect on its first update', () => {
    const world = buildInheritingWorld();
    applyDocumentBroadcast(world, {
      type: 'ActiveEffect',
      action: 'update',
      result: [{ _id: BASE_EFFECT_ID, disabled: true }],
      parentUuid: deltaUuid,
    });
    expect(delta(world)?.effects).toEqual([
      { _id: BASE_EFFECT_ID, name: 'Blessed', disabled: true },
    ]);
    expect((baseActor(world).effects as Array<{ disabled: boolean }>)[0]?.disabled).toBe(false);
  });

  it('lands on the same state when the same update arrives twice', () => {
    const world = buildInheritingWorld();
    const update: DocumentBroadcast = {
      type: 'Item',
      action: 'update',
      result: [{ _id: ITEM_ID, 'system.quantity': 3 }],
      parentUuid: deltaUuid,
    };
    applyDocumentBroadcast(world, update);
    const once = structuredClone(token(world));
    applyDocumentBroadcast(world, update);
    expect(token(world)).toEqual(once);
  });

  it('ignores an update of an id neither the delta nor the base actor has, without creating a delta', () => {
    const world = buildInheritingWorld();
    expect(
      applyDocumentBroadcast(world, {
        type: 'Item',
        action: 'update',
        result: [{ _id: 'unknownItem00001', name: 'x' }],
        parentUuid: deltaUuid,
      }),
    ).toBe(false);
    expect(token(world).delta).toBeUndefined();
  });

  it('leaves a tombstone when an inherited item is deleted, the same after a second delete', () => {
    const world = buildInheritingWorld();
    const remove: DocumentBroadcast = {
      type: 'Item',
      action: 'delete',
      result: [ITEM_ID],
      parentUuid: deltaUuid,
    };
    expect(applyDocumentBroadcast(world, remove)).toBe(true);
    expect(delta(world)?.items).toEqual([{ _id: ITEM_ID, _tombstone: true }]);
    applyDocumentBroadcast(world, remove);
    expect(delta(world)?.items).toEqual([{ _id: ITEM_ID, _tombstone: true }]);
    expect(baseActor(world).items).toHaveLength(1);
  });

  it('replaces an adopted copy with a tombstone when that item is deleted', () => {
    const world = buildInheritingWorld({
      _id: TOKEN_ID,
      items: [{ _id: ITEM_ID, name: 'Longsword', system: { quantity: 3 } }],
    });
    applyDocumentBroadcast(world, {
      type: 'Item',
      action: 'delete',
      result: [ITEM_ID],
      parentUuid: deltaUuid,
    });
    expect(delta(world)?.items).toEqual([{ _id: ITEM_ID, _tombstone: true }]);
  });

  it('puts a document created again in place of its tombstone, the same after a second create', () => {
    const world = buildInheritingWorld({
      _id: TOKEN_ID,
      items: [{ _id: ITEM_ID, _tombstone: true }],
    });
    const recreate: DocumentBroadcast = {
      type: 'Item',
      action: 'create',
      result: [{ _id: ITEM_ID, name: 'Longsword', type: 'weapon', system: { quantity: 2 } }],
      parentUuid: deltaUuid,
    };
    expect(applyDocumentBroadcast(world, recreate)).toBe(true);
    const expected = [{ _id: ITEM_ID, name: 'Longsword', type: 'weapon', system: { quantity: 2 } }];
    expect(delta(world)?.items).toEqual(expected);
    applyDocumentBroadcast(world, recreate);
    expect(delta(world)?.items).toEqual(expected);
  });

  it("removes an item of the token's own when it is deleted", () => {
    const world = buildInheritingWorld({
      _id: TOKEN_ID,
      items: [{ _id: OWN_ITEM_ID, name: 'Torch' }],
    });
    expect(
      applyDocumentBroadcast(world, {
        type: 'Item',
        action: 'delete',
        result: [OWN_ITEM_ID],
        parentUuid: deltaUuid,
      }),
    ).toBe(true);
    expect(delta(world)?.items).toEqual([]);
  });

  it("applies an effect on an item of the token's own to that item", () => {
    const world = buildInheritingWorld({
      _id: TOKEN_ID,
      items: [{ _id: OWN_ITEM_ID, name: 'Torch' }],
    });
    applyDocumentBroadcast(world, {
      type: 'ActiveEffect',
      action: 'create',
      result: [{ _id: 'torchEffect00001', name: 'Lit' }],
      parentUuid: `${deltaUuid}.Item.${OWN_ITEM_ID}`,
    });
    expect(delta(world)?.items?.[0]?.effects).toEqual([{ _id: 'torchEffect00001', name: 'Lit' }]);
  });

  it("adopts an inherited item to apply a change to one of the item's effects", () => {
    const world = buildInheritingWorld();
    const update: DocumentBroadcast = {
      type: 'ActiveEffect',
      action: 'update',
      result: [{ _id: ITEM_EFFECT_ID, disabled: true }],
      parentUuid: `${deltaUuid}.Item.${ITEM_ID}`,
    };
    expect(applyDocumentBroadcast(world, update)).toBe(true);
    const adopted = delta(world)?.items?.[0];
    expect(adopted).toMatchObject({ _id: ITEM_ID, name: 'Longsword' });
    expect(adopted?.effects).toEqual([{ _id: ITEM_EFFECT_ID, name: 'Keen', disabled: true }]);
    applyDocumentBroadcast(world, update);
    expect(delta(world)?.items).toHaveLength(1);
    const baseItem = (
      baseActor(world).items as Array<{ effects: Array<{ disabled: boolean }> }>
    )[0];
    expect(baseItem?.effects[0]?.disabled).toBe(false);
  });

  it('ignores an effect on an item found nowhere, without creating a delta', () => {
    const world = buildInheritingWorld();
    expect(
      applyDocumentBroadcast(world, {
        type: 'ActiveEffect',
        action: 'create',
        result: [{ _id: 'strayEffect00001', name: 'x' }],
        parentUuid: `${deltaUuid}.Item.unknownItem00001`,
      }),
    ).toBe(false);
    expect(token(world).delta).toBeUndefined();
  });

  it('ignores a type that is not an ActorDelta update on the token itself, without creating a delta', () => {
    const world = buildInheritingWorld();
    expect(
      applyDocumentBroadcast(world, {
        type: 'Item',
        action: 'update',
        result: [{ _id: ITEM_ID }],
        parentUuid: `Scene.${SCENE_ID}.Token.${TOKEN_ID}`,
      }),
    ).toBe(false);
    expect(token(world).delta).toBeUndefined();
  });

  it('creates the delta, with the id from the parent UUID, when the first change lands', () => {
    const world = buildInheritingWorld();
    applyDocumentBroadcast(world, {
      type: 'ActiveEffect',
      action: 'create',
      result: [{ _id: 'newEffect0000001', name: 'Hasted' }],
      parentUuid: `Scene.${SCENE_ID}.Token.${TOKEN_ID}.ActorDelta.deltaId000000001`,
    });
    expect(token(world).delta).toEqual({
      _id: 'deltaId000000001',
      effects: [{ _id: 'newEffect0000001', name: 'Hasted' }],
    });
  });

  it('lands on the same state when the same ActorDelta update arrives twice', () => {
    const world = buildInheritingWorld();
    const update: DocumentBroadcast = {
      type: 'ActorDelta',
      action: 'update',
      result: [{ _id: TOKEN_ID, 'system.attributes.hp.value': 12 }],
      parentUuid: `Scene.${SCENE_ID}.Token.${TOKEN_ID}`,
    };
    applyDocumentBroadcast(world, update);
    const once = structuredClone(token(world));
    applyDocumentBroadcast(world, update);
    expect(token(world)).toEqual(once);
    expect(token(world).delta).toEqual({
      _id: TOKEN_ID,
      system: { attributes: { hp: { value: 12 } } },
    });
  });
});

/**
 * Issue laurigates/foundryvtt-mcp#218 — `activeUsers` is a top-level `WorldData` field, not a document
 * collection, so `modifyDocument` never touches it. FoundryVTT signals presence
 * on the separate `userActivity` event instead.
 */
describe('parseDocumentBatch', () => {
  // Shape of FoundryVTT v14's `modifyDocumentBatch` (server-backend.mjs):
  // `{results: DocumentSocketResponse[]}`, side effects first, each with its
  // own type/action/operation/userId.
  it('splits a batch into its broadcasts, in order', () => {
    const batch = parseDocumentBatch({
      results: [
        {
          type: 'Scene',
          action: 'update',
          operation: {},
          result: [{ _id: SCENE_ID, active: false }],
          sideEffect: true,
          userId: 'gm00000000000000',
        },
        {
          type: 'JournalEntryPage',
          action: 'update',
          operation: { parentUuid: `JournalEntry.${JOURNAL_ID}` },
          result: [{ _id: PAGE_ID, text: { content: '<p>x</p>' } }],
          userId: 'gm00000000000000',
        },
      ],
    });
    expect(batch).toEqual([
      {
        type: 'Scene',
        action: 'update',
        result: [{ _id: SCENE_ID, active: false }],
        userId: 'gm00000000000000',
      },
      {
        type: 'JournalEntryPage',
        action: 'update',
        result: [{ _id: PAGE_ID, text: { content: '<p>x</p>' } }],
        parentUuid: `JournalEntry.${JOURNAL_ID}`,
        userId: 'gm00000000000000',
      },
    ]);
  });

  it('drops invalid elements and keeps the others', () => {
    const batch = parseDocumentBatch({
      results: [
        null,
        { type: 'Actor', action: 'explode', result: [] },
        { type: 'Actor', action: 'delete', result: [ACTOR_ID], error: { message: 'no' } },
        { type: 'Actor', action: 'delete', result: [ACTOR_ID] },
      ],
    });
    expect(batch).toEqual([{ type: 'Actor', action: 'delete', result: [ACTOR_ID] }]);
  });

  it.each([null, 'x', {}, { results: 'nope' }])('returns null for %j', (payload) => {
    expect(parseDocumentBatch(payload)).toBeNull();
  });
});

describe('parseUserActivity', () => {
  const USER_ID = 'user0000user0001';

  it('parses a logout broadcast', () => {
    expect(parseUserActivity(USER_ID, { active: false })).toEqual({
      userId: USER_ID,
      active: false,
    });
  });

  it('parses a login broadcast', () => {
    expect(parseUserActivity(USER_ID, { active: true })).toEqual({
      userId: USER_ID,
      active: true,
    });
  });

  it('treats an activity ping with no `active` flag as present, like Foundry does', () => {
    expect(parseUserActivity(USER_ID, { cursor: { x: 10, y: 20 } })).toEqual({
      userId: USER_ID,
      active: true,
    });
    expect(parseUserActivity(USER_ID, undefined)).toEqual({ userId: USER_ID, active: true });
  });

  it.each([
    ['a non-string user id', 42, { active: true }],
    ['an empty user id', '', { active: true }],
    ['a non-object activity payload', 'user0000user0001', 'nope'],
    ['a non-boolean active flag', 'user0000user0001', { active: 'yes' }],
  ])('rejects %s', (_label, userId, activityData) => {
    expect(parseUserActivity(userId, activityData)).toBeNull();
  });
});

describe('applyUserActivity', () => {
  const USER_ID = 'user0000user0001';
  const OTHER_ID = 'user0000user0002';

  it('adds a user that just logged in', () => {
    const worldData = buildWorldData();
    worldData.activeUsers = [OTHER_ID];

    expect(applyUserActivity(worldData, { userId: USER_ID, active: true })).toBe(true);
    expect(worldData.activeUsers).toEqual([OTHER_ID, USER_ID]);
  });

  it('removes a user that just logged out', () => {
    const worldData = buildWorldData();
    worldData.activeUsers = [OTHER_ID, USER_ID];

    expect(applyUserActivity(worldData, { userId: USER_ID, active: false })).toBe(true);
    expect(worldData.activeUsers).toEqual([OTHER_ID]);
  });

  it('is idempotent — an activity ping from an already-active user changes nothing', () => {
    const worldData = buildWorldData();
    worldData.activeUsers = [USER_ID];

    expect(applyUserActivity(worldData, { userId: USER_ID, active: true })).toBe(false);
    expect(worldData.activeUsers).toEqual([USER_ID]);
  });

  it('is idempotent for a logout of a user that is already absent', () => {
    const worldData = buildWorldData();
    worldData.activeUsers = [OTHER_ID];

    expect(applyUserActivity(worldData, { userId: USER_ID, active: false })).toBe(false);
    expect(worldData.activeUsers).toEqual([OTHER_ID]);
  });
});
