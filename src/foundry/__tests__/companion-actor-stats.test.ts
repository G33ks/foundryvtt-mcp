/**
 * @fileoverview The companion module's `get_actor_stats` command run under
 * Node against a stand-in `game`: world actors, linked and unlinked tokens.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getActorStats,
  normalizePaths,
} from '../../../foundry-module/scripts/commands/get-actor-stats.js';

const ACTOR = 'actorAAAAAAAAAAA';
const SCENE = 'sceneSSSSSSSSSSS';
const LINKED = 'tokenLLLLLLLLLLL';
const UNLINKED = 'tokenUUUUUUUUUUU';
const ORPHAN = 'tokenOOOOOOOOOOO';

/** Prepared data: `pool.value` is derived from the stored `max` and `spent`. */
function preparedSystem(spent: number) {
  return {
    pool: { max: 10, spent, value: 10 - spent },
    level: 3,
    tags: new Set(['a']),
  };
}

function fakeActor(id: string, system: Record<string, unknown>) {
  return { id, name: 'Wanderer', type: 'traveler', system };
}

const worldActor = fakeActor(ACTOR, preparedSystem(2));
/** The unlinked token's synthetic actor: base actor plus its delta (spent 7). */
const syntheticActor = fakeActor(ACTOR, preparedSystem(7));

beforeEach(() => {
  const tokens = new Map<string, unknown>([
    [LINKED, { actorId: ACTOR, actorLink: true, actor: worldActor }],
    [UNLINKED, { actorId: ACTOR, actorLink: false, actor: syntheticActor }],
    [ORPHAN, { actorId: 'goneGGGGGGGGGGGG', actorLink: false, actor: null }],
  ]);
  vi.stubGlobal('game', {
    actors: new Map([[ACTOR, worldActor]]),
    scenes: new Map([[SCENE, { tokens }]]),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('get_actor_stats module command', () => {
  it("returns a world actor's prepared system", async () => {
    const answer = await getActorStats({ targets: [{ actorId: ACTOR }], maxBytes: 32768 });
    expect(answer).toMatchObject({
      truncated: false,
      results: [
        {
          actorId: ACTOR,
          name: 'Wanderer',
          type: 'traveler',
          system: { pool: { max: 10, spent: 2, value: 8 }, level: 3, tags: ['a'] },
        },
      ],
    });
    expect(answer.bytes).toBeGreaterThan(0);
  });

  it("returns a linked token's world actor", async () => {
    const answer = await getActorStats({
      targets: [{ sceneId: SCENE, tokenId: LINKED, actorId: ACTOR }],
      maxBytes: 32768,
    });
    expect(answer.results[0]).toMatchObject({
      sceneId: SCENE,
      tokenId: LINKED,
      actorId: ACTOR,
      linked: true,
      system: { pool: { value: 8 } },
    });
  });

  it("returns an unlinked token's own prepared actor", async () => {
    const answer = await getActorStats({
      targets: [{ sceneId: SCENE, tokenId: UNLINKED }],
      maxBytes: 32768,
    });
    expect(answer.results[0]).toMatchObject({
      tokenId: UNLINKED,
      actorId: ACTOR,
      linked: false,
      system: { pool: { spent: 7, value: 3 } },
    });
  });

  it('reports each kind of missing target on its own', async () => {
    const answer = await getActorStats({
      targets: [
        { actorId: 'missingMMMMMMMMM' },
        { sceneId: 'noSceneXXXXXXXXX', tokenId: LINKED },
        { sceneId: SCENE, tokenId: 'noTokenXXXXXXXXX' },
        { sceneId: SCENE, tokenId: ORPHAN },
        { sceneId: SCENE, tokenId: UNLINKED, actorId: 'otherOOOOOOOOOOO' },
      ],
      maxBytes: 32768,
    });
    expect(answer.results.map((r: { error?: string }) => r.error)).toEqual([
      'Actor missingMMMMMMMMM not found',
      'Scene noSceneXXXXXXXXX not found',
      `Token noTokenXXXXXXXXX not found on scene ${SCENE}`,
      `Token ${ORPHAN} has no actor: its base actor goneGGGGGGGGGGGG is deleted or missing`,
      `Token ${UNLINKED} carries actor ${ACTOR}, not otherOOOOOOOOOOO`,
    ]);
  });

  it('refuses malformed targets', async () => {
    await expect(getActorStats({ targets: [], maxBytes: 100 })).rejects.toThrow(/targets/);
    await expect(getActorStats({ targets: [{ sceneId: SCENE }], maxBytes: 100 })).rejects.toThrow(
      /Each target/,
    );
    await expect(getActorStats({ targets: [{}], maxBytes: 100 })).rejects.toThrow(/Each target/);
    await expect(getActorStats({ targets: [{ actorId: ACTOR }], maxBytes: 0 })).rejects.toThrow(
      /maxBytes/,
    );
  });

  it('narrows the answer to paths, flat, with the missing ones', async () => {
    const answer = await getActorStats({
      targets: [{ sceneId: SCENE, tokenId: UNLINKED }],
      paths: ['system.pool.value', 'level', 'pool.nothing', 'tags'],
      maxBytes: 32768,
    });
    expect(answer.results[0]).toMatchObject({
      values: { 'pool.value': 3, level: 3, tags: ['a'] },
      missing: ['pool.nothing'],
    });
    expect(answer.results[0]).not.toHaveProperty('system');
  });

  it('gives the uuid of a Document a path leads to, never its contents', async () => {
    const mount = {
      documentName: 'Actor',
      uuid: 'Actor.mountMMMMMMMMMMM',
      name: 'Pony',
      system: {},
    };
    vi.stubGlobal('game', {
      actors: new Map([[ACTOR, fakeActor(ACTOR, { ...preparedSystem(2), mount })]]),
      scenes: new Map(),
    });
    const answer = await getActorStats({
      targets: [{ actorId: ACTOR }],
      paths: ['mount', 'level'],
      maxBytes: 32768,
    });
    expect(answer.results[0]).toMatchObject({
      values: { mount: { '@uuid': 'Actor.mountMMMMMMMMMMM' }, level: 3 },
      missing: [],
    });
  });

  it('answers with sizes and no data over maxBytes', async () => {
    const answer = await getActorStats({
      targets: [{ actorId: ACTOR }, { actorId: 'missingMMMMMMMMM' }],
      maxBytes: 50,
    });
    expect(answer.tooLarge).toBe(true);
    expect(answer.maxBytes).toBe(50);
    expect(answer.bytes).toBeGreaterThan(50);
    expect(answer.results[0]).toEqual({
      actorId: ACTOR,
      name: 'Wanderer',
      type: 'traveler',
      topLevel: [
        { key: 'pool', bytes: 30 },
        { key: 'tags', bytes: 5 },
        { key: 'level', bytes: 1 },
      ],
    });
    expect(answer.results[1]).toMatchObject({ error: 'Actor missingMMMMMMMMM not found' });
    expect(JSON.stringify(answer)).not.toContain('spent');
  });
});

describe('normalizePaths', () => {
  it('strips system., removes duplicates and paths under a requested ancestor', () => {
    expect(normalizePaths(['system.a.b', 'a', 'c.d', 'c.d', 'cd'])).toEqual(['a', 'c.d', 'cd']);
  });

  it('accepts no paths at all', () => {
    expect(normalizePaths(undefined)).toBeNull();
  });

  it('bounds the paths', () => {
    expect(() => normalizePaths([])).toThrow(/1 to 50/);
    expect(() => normalizePaths(Array.from({ length: 51 }, (_, i) => `p${i}`))).toThrow(/1 to 50/);
    expect(() => normalizePaths(['x'.repeat(201)])).toThrow(/Invalid path/);
    expect(() => normalizePaths(['a..b'])).toThrow(/Invalid path/);
    expect(() => normalizePaths([3])).toThrow(/strings/);
    expect(normalizePaths(['x'.repeat(200)])).toEqual(['x'.repeat(200)]);
  });
});
