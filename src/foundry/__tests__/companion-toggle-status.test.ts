/**
 * @fileoverview The companion module's `toggle_status_effect` command run
 * under Node against a stand-in `game` and `CONFIG`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toggleStatusEffect } from '../../../foundry-module/scripts/commands/toggle-status-effect.js';

const ACTOR = 'actorAAAAAAAAAAA';
const SCENE = 'sceneSSSSSSSSSSS';
const UNLINKED = 'tokenUUUUUUUUUUU';
/** The fixed `_id` of the status that has one. */
const FIXED_ID = 'restingStatus000';
const LEGACY_ID = 'legacyEffect0000';
const MULTI_ID = 'multiStatus00000';

interface FakeEffect {
  id: string;
  statuses: Set<string>;
}

/** Like Foundry's Collection: a Map whose iteration yields its values. */
class Collection<V> {
  private readonly entries = new Map<string, V>();
  get(key: string) {
    return this.entries.get(key);
  }
  set(key: string, value: V) {
    this.entries.set(key, value);
  }
  delete(key: string) {
    this.entries.delete(key);
  }
  keys() {
    return [...this.entries.keys()];
  }
  [Symbol.iterator]() {
    return this.entries.values();
  }
}

const STATUSES: Record<string, { id: string; _id?: string; name: string }> = {
  resting: { id: 'resting', _id: FIXED_ID, name: 'STATUS.Resting' },
  dazed: { id: 'dazed', name: 'STATUS.Dazed' },
};

/** An actor whose toggleStatusEffect behaves as Foundry's does (v14 client/documents/actor.mjs). */
function fakeActor(seed: FakeEffect[] = []) {
  const effects = new Collection<FakeEffect>();
  for (const effect of seed) {
    effects.set(effect.id, effect);
  }
  let created = 0;
  return {
    effects,
    deleteEmbeddedDocuments: vi.fn(async (_type: string, ids: string[]) => {
      for (const id of ids) {
        effects.delete(id);
      }
    }),
    toggleStatusEffect: vi.fn(async (statusId: string, { active }: { active?: boolean }) => {
      const status = STATUSES[statusId];
      const existing = status._id
        ? effects.get(status._id)
          ? [status._id]
          : []
        : [...effects]
            .filter((e) => e.statuses.size === 1 && e.statuses.has(statusId))
            .map((e) => e.id);
      if (existing.length > 0) {
        if (active) {
          return true;
        }
        for (const id of existing) {
          effects.delete(id);
        }
        return false;
      }
      if (active === false) {
        return undefined;
      }
      created++;
      const effect = {
        id: status._id ?? `created${created}`.padEnd(16, '0'),
        statuses: new Set([statusId]),
      };
      effects.set(effect.id, effect);
      return effect;
    }),
  };
}

type FakeActor = ReturnType<typeof fakeActor>;

function stubWorld(worldActor: FakeActor, syntheticActor: FakeActor = fakeActor()) {
  vi.stubGlobal('game', {
    actors: new Map([[ACTOR, worldActor]]),
    scenes: new Map([
      [
        SCENE,
        {
          tokens: new Map([
            [UNLINKED, { actorId: ACTOR, actorLink: false, actor: syntheticActor }],
          ]),
        },
      ],
    ]),
    i18n: { localize: (key: string) => key.replace('STATUS.', '') },
  });
}

beforeEach(() => {
  vi.stubGlobal('CONFIG', { statusEffects: STATUSES });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const toggle = (statusId: string, active: boolean, target: object = { actorId: ACTOR }) =>
  toggleStatusEffect({ target, statusId, active });

describe('toggle_status_effect module command', () => {
  it('applies a status with a fixed _id, then finds it there', async () => {
    const actor = fakeActor();
    stubWorld(actor);

    await expect(toggle('resting', true)).resolves.toEqual({
      active: true,
      changed: true,
      effectId: FIXED_ID,
      legacy: [],
    });
    await expect(toggle('resting', true)).resolves.toEqual({
      active: true,
      changed: false,
      effectId: FIXED_ID,
      legacy: [],
    });
    expect(actor.toggleStatusEffect).toHaveBeenCalledTimes(1);
  });

  it('applies and removes a status without a fixed _id', async () => {
    const actor = fakeActor();
    stubWorld(actor);

    await expect(toggle('dazed', true)).resolves.toEqual({
      active: true,
      changed: true,
      effectId: 'created100000000',
      legacy: [],
    });
    await expect(toggle('dazed', true)).resolves.toMatchObject({ changed: false });
    await expect(toggle('dazed', false)).resolves.toEqual({
      active: false,
      changed: true,
      removed: ['created100000000'],
    });
    await expect(toggle('dazed', false)).resolves.toEqual({
      active: false,
      changed: false,
      removed: [],
    });
    expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it('reports an earlier-version effect when applying, without removing it', async () => {
    const actor = fakeActor([{ id: LEGACY_ID, statuses: new Set(['resting']) }]);
    stubWorld(actor);

    await expect(toggle('resting', true)).resolves.toEqual({
      active: true,
      changed: true,
      effectId: FIXED_ID,
      legacy: [LEGACY_ID],
    });
    await expect(toggle('resting', true)).resolves.toEqual({
      active: true,
      changed: false,
      effectId: FIXED_ID,
      legacy: [LEGACY_ID],
    });
    expect(actor.effects.keys()).toContain(LEGACY_ID);
    expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it('removes earlier-version effects with active=false, with or without its own', async () => {
    const actor = fakeActor([
      { id: LEGACY_ID, statuses: new Set(['resting']) },
      { id: FIXED_ID, statuses: new Set(['resting']) },
    ]);
    stubWorld(actor);

    await expect(toggle('resting', false)).resolves.toEqual({
      active: false,
      changed: true,
      removed: [FIXED_ID, LEGACY_ID],
    });
    expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledWith('ActiveEffect', [LEGACY_ID]);
    expect(actor.effects.keys()).toEqual([]);

    const legacyOnly = fakeActor([{ id: LEGACY_ID, statuses: new Set(['resting']) }]);
    stubWorld(legacyOnly);
    await expect(toggle('resting', false)).resolves.toEqual({
      active: false,
      changed: true,
      removed: [LEGACY_ID],
    });
    expect(legacyOnly.toggleStatusEffect).not.toHaveBeenCalled();
  });

  it('never touches an effect carrying several statuses', async () => {
    const actor = fakeActor([{ id: MULTI_ID, statuses: new Set(['resting', 'dazed']) }]);
    stubWorld(actor);

    await expect(toggle('resting', true)).resolves.toMatchObject({ legacy: [] });
    await expect(toggle('resting', false)).resolves.toEqual({
      active: false,
      changed: true,
      removed: [FIXED_ID],
    });
    await expect(toggle('dazed', false)).resolves.toEqual({
      active: false,
      changed: false,
      removed: [],
    });
    expect(actor.effects.keys()).toEqual([MULTI_ID]);
  });

  it("works on an unlinked token's own actor, not the world actor", async () => {
    const worldActor = fakeActor();
    const syntheticActor = fakeActor([{ id: LEGACY_ID, statuses: new Set(['resting']) }]);
    stubWorld(worldActor, syntheticActor);
    const token = { sceneId: SCENE, tokenId: UNLINKED, actorId: ACTOR };

    await expect(toggle('resting', false, token)).resolves.toEqual({
      active: false,
      changed: true,
      removed: [LEGACY_ID],
    });
    expect(syntheticActor.deleteEmbeddedDocuments).toHaveBeenCalledWith('ActiveEffect', [
      LEGACY_ID,
    ]);
    expect(worldActor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
    expect(worldActor.toggleStatusEffect).not.toHaveBeenCalled();
  });

  it('lists the valid ids with their names for an unknown status', async () => {
    const actor = fakeActor();
    stubWorld(actor);
    await expect(toggle('nope', true)).rejects.toThrow(
      'Unknown status effect "nope". Valid ids: resting (Resting), dazed (Dazed)',
    );
    expect(actor.toggleStatusEffect).not.toHaveBeenCalled();
  });

  it('reads an array of status effects too', async () => {
    stubWorld(fakeActor());
    vi.stubGlobal('CONFIG', { statusEffects: [STATUSES.dazed] });
    await expect(toggle('dazed', true)).resolves.toMatchObject({ changed: true });
  });

  it('refuses a target it cannot resolve, and malformed parameters', async () => {
    stubWorld(fakeActor());
    await expect(
      toggleStatusEffect({
        target: { sceneId: SCENE, tokenId: 'missingTTTTTTTTT' },
        statusId: 'dazed',
      }),
    ).rejects.toThrow(`Token missingTTTTTTTTT not found on scene ${SCENE}`);
    await expect(toggleStatusEffect({ target: {}, statusId: 'dazed' })).rejects.toThrow(/target/);
    await expect(toggleStatusEffect({ target: { actorId: ACTOR } })).rejects.toThrow(/statusId/);
    await expect(
      toggleStatusEffect({ target: { actorId: ACTOR }, statusId: 'dazed', active: 'yes' }),
    ).rejects.toThrow(/active/);
  });
});
