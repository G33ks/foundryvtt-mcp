/**
 * @fileoverview The companion module's `toggle_status_effect` command run
 * under Node against a stand-in `game`, `CONFIG` and `Hooks`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  toggleStatusEffect,
  withDialogsClosed,
} from '../../../foundry-module/scripts/commands/toggle-status-effect.js';

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

/** Registered hooks, as Foundry's Hooks.on / Hooks.off keep them. */
const hooks = new Map<number, { name: string; fn: (app: unknown) => void }>();
let nextHookId = 1;

/** A dialog the game system renders; closing it is what the module must do. */
function renderDialog(title: string) {
  const dialog = { title, close: vi.fn() };
  for (const { name, fn } of [...hooks.values()]) {
    if (name === 'renderDialogV2') {
      fn(dialog);
    }
  }
  return dialog;
}

/**
 * The game system's behaviour, per test: an option it reads at creation (it
 * asks for it in a dialog when absent), and a dialog when removing.
 */
let asksFor: string | null = null;
let asksOnRemove = false;

function fakeActor(seed: FakeEffect[] = []) {
  const effects = new Collection<FakeEffect>();
  for (const effect of seed) {
    effects.set(effect.id, effect);
  }
  return {
    effects,
    deleteEmbeddedDocuments: vi.fn(async (_type: string, ids: string[]) => {
      for (const id of ids) {
        effects.delete(id);
      }
    }),
    /** Removal only: the module no longer creates through it. */
    toggleStatusEffect: vi.fn(async (statusId: string, { active }: { active?: boolean }) => {
      if (asksOnRemove) {
        renderDialog('Confirm removal');
        return undefined;
      }
      const status = STATUSES[statusId];
      const existing = status._id
        ? effects.get(status._id)
          ? [status._id]
          : []
        : [...effects]
            .filter((e) => e.statuses.size === 1 && e.statuses.has(statusId))
            .map((e) => e.id);
      if (existing.length > 0 && active === false) {
        for (const id of existing) {
          effects.delete(id);
        }
        return false;
      }
      return undefined;
    }),
  };
}

type FakeActor = ReturnType<typeof fakeActor>;

let created = 0;
/** ActiveEffect.create, as the stand-in records it. */
const create = vi.fn(
  async (data: { _id?: string; statuses: string[] }, options: Record<string, unknown>) => {
    if (asksFor && !(asksFor in options)) {
      // The game system asks; closed without an answer, it cancels the creation.
      renderDialog('Enter a value: Example status');
      return undefined;
    }
    created++;
    const effect = {
      id: data._id ?? `created${created}`.padEnd(16, '0'),
      statuses: new Set(data.statuses),
    };
    (options.parent as FakeActor).effects.set(effect.id, effect);
    return effect;
  },
);

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
  asksFor = null;
  asksOnRemove = false;
  created = 0;
  create.mockClear();
  hooks.clear();
  vi.stubGlobal('Hooks', {
    on: (name: string, fn: (app: unknown) => void) => {
      const id = nextHookId++;
      hooks.set(id, { name, fn });
      return id;
    },
    off: (_name: string, id: number) => hooks.delete(id),
  });
  vi.stubGlobal('CONFIG', {
    statusEffects: STATUSES,
    ActiveEffect: {
      documentClass: {
        fromStatusEffect: async (statusId: string) => {
          const status = STATUSES[statusId];
          const data = {
            ...(status._id ? { _id: status._id } : {}),
            name: status.name,
            statuses: [statusId],
          };
          return { toObject: () => data };
        },
        create,
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const toggle = (statusId: string, active: boolean, target: object = { actorId: ACTOR }) =>
  toggleStatusEffect({ target, statusId, active });

describe('toggle_status_effect module command', () => {
  it('creates a status as the core does, with keepId, then finds it there', async () => {
    const actor = fakeActor();
    stubWorld(actor);

    await expect(toggle('resting', true)).resolves.toEqual({
      active: true,
      changed: true,
      effectId: FIXED_ID,
      legacy: [],
    });
    expect(create).toHaveBeenCalledWith(
      { _id: FIXED_ID, name: 'STATUS.Resting', statuses: ['resting'] },
      { parent: actor, keepId: true },
    );
    await expect(toggle('resting', true)).resolves.toEqual({
      active: true,
      changed: false,
      effectId: FIXED_ID,
      legacy: [],
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(actor.toggleStatusEffect).not.toHaveBeenCalled();
  });

  it('passes createOptions to the creation, under the core options', async () => {
    const actor = fakeActor();
    stubWorld(actor);
    asksFor = 'level';

    await expect(
      toggleStatusEffect({
        target: { actorId: ACTOR },
        statusId: 'resting',
        active: true,
        createOptions: { level: 4, keepId: false },
      }),
    ).resolves.toMatchObject({ changed: true, effectId: FIXED_ID });
    expect(create).toHaveBeenCalledWith(expect.anything(), {
      level: 4,
      keepId: true,
      parent: actor,
    });
    expect(hooks.size).toBe(0);
  });

  it('closes a dialog the system opens, and fails at once with nothing created', async () => {
    const actor = fakeActor();
    stubWorld(actor);
    asksFor = 'level';

    await expect(toggle('resting', true)).rejects.toThrow(
      "The game system asked for input when creating status 'resting' (dialog 'Enter a value: Example status'); nothing was created. Pass the value it expects in createOptions.",
    );
    expect(actor.effects.keys()).toEqual([]);
    expect(hooks.size).toBe(0);
  });

  it('closes the dialog it catches', async () => {
    const actor = fakeActor();
    stubWorld(actor);
    let dialog: ReturnType<typeof renderDialog> | undefined;
    const { dialogs } = await withDialogsClosed(async () => {
      dialog = renderDialog('Pick one');
    });
    expect(dialogs).toEqual(['Pick one']);
    expect(dialog?.close).toHaveBeenCalledWith({ animate: false });
    expect(hooks.size).toBe(0);
  });

  it('removes its hook when the operation throws', async () => {
    await expect(
      withDialogsClosed(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(hooks.size).toBe(0);
  });

  it('reports a dialog opened while removing, and what stayed', async () => {
    const actor = fakeActor([{ id: FIXED_ID, statuses: new Set(['resting']) }]);
    stubWorld(actor);
    asksOnRemove = true;

    await expect(toggle('resting', false)).rejects.toThrow(
      "The game system asked for input when removing status 'resting' (dialog 'Confirm removal'); removed: nothing.",
    );
    expect(actor.effects.keys()).toEqual([FIXED_ID]);
    expect(hooks.size).toBe(0);
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

    await expect(toggle('resting', true, token)).resolves.toMatchObject({ effectId: FIXED_ID });
    expect(create).toHaveBeenCalledWith(expect.anything(), {
      parent: syntheticActor,
      keepId: true,
    });
    await expect(toggle('resting', false, token)).resolves.toEqual({
      active: false,
      changed: true,
      removed: [FIXED_ID, LEGACY_ID],
    });
    expect(syntheticActor.deleteEmbeddedDocuments).toHaveBeenCalledWith('ActiveEffect', [
      LEGACY_ID,
    ]);
    expect(worldActor.effects.keys()).toEqual([]);
    expect(worldActor.toggleStatusEffect).not.toHaveBeenCalled();
  });

  it('lists the valid ids with their names for an unknown status', async () => {
    const actor = fakeActor();
    stubWorld(actor);
    await expect(toggle('nope', true)).rejects.toThrow(
      'Unknown status effect "nope". Valid ids: resting (Resting), dazed (Dazed)',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('reads an array of status effects too', async () => {
    stubWorld(fakeActor());
    vi.stubGlobal('CONFIG', {
      statusEffects: [STATUSES.dazed],
      ActiveEffect: {
        documentClass: {
          fromStatusEffect: async () => ({ toObject: () => ({ statuses: ['dazed'] }) }),
          create,
        },
      },
    });
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
    await expect(
      toggleStatusEffect({ target: { actorId: ACTOR }, statusId: 'dazed', createOptions: [1] }),
    ).rejects.toThrow(/createOptions/);
  });
});
