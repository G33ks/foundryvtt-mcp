/**
 * @fileoverview The companion module's `create_combat` command run under
 * Node against a stand-in `game`, `CONFIG` and `Hooks`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCombat,
  MAX_COMBATANTS,
} from '../../../foundry-module/scripts/commands/create-combat.js';
import { CommandRefusal } from '../../../foundry-module/scripts/refusal.js';

const SCENE = 'sceneSSSSSSSSSSS';
const LINKED = 'tokenLLLLLLLLLLL';
const UNLINKED = 'tokenUUUUUUUUUUU';
const NO_ACTOR = 'tokenNNNNNNNNNNN';
const HERO = 'actorHHHHHHHHHHH';
const BEAST = 'actorBBBBBBBBBBB';
const COMBAT = 'combatCCCCCCCCCC';

/** Registered hooks, as Foundry's Hooks.on / Hooks.off keep them. */
const hooks = new Map<number, { name: string; fn: (app: unknown) => void }>();
let nextHookId = 1;

function renderDialog(title: string) {
  const dialog = { title, close: vi.fn() };
  for (const { name, fn } of [...hooks.values()]) {
    if (name === 'renderDialogV2') {
      fn(dialog);
    }
  }
}

/** What the stand-in Foundry does at each step, per test. */
let behaviour: {
  canCreate: boolean;
  combatCreated: 'yes' | 'prevented' | 'dialog';
  combatants: 'all' | 'some' | 'throw';
  start: 'ok' | 'throw';
};

/** The calls, in order, as the stand-in records them. */
let calls: string[];

function fakeCombat() {
  const combat = {
    id: COMBAT,
    round: 0,
    turn: null as number | null,
    createEmbeddedDocuments: vi.fn(async (_type: string, data: Array<{ tokenId: string }>) => {
      calls.push('createCombatants');
      if (behaviour.combatants === 'throw') {
        throw new Error('validation failed');
      }
      const created = behaviour.combatants === 'some' ? data.slice(1) : data;
      return created.map((d, i) => ({ id: `combatant${i}`.padEnd(16, '0'), tokenId: d.tokenId }));
    }),
    startCombat: vi.fn(async () => {
      calls.push('startCombat');
      if (behaviour.start === 'throw') {
        throw new Error('hook failed');
      }
      combat.round = 1;
      combat.turn = 0;
      return combat;
    }),
  };
  return combat;
}

let combat: ReturnType<typeof fakeCombat>;
const create = vi.fn(async (_data: Record<string, unknown>) => {
  calls.push('createCombat');
  if (behaviour.combatCreated === 'dialog') {
    renderDialog('Choose an option');
    return undefined;
  }
  return behaviour.combatCreated === 'yes' ? combat : undefined;
});
const canUserCreate = vi.fn(() => behaviour.canCreate);

beforeEach(() => {
  behaviour = { canCreate: true, combatCreated: 'yes', combatants: 'all', start: 'ok' };
  calls = [];
  combat = fakeCombat();
  create.mockClear();
  canUserCreate.mockClear();
  hooks.clear();
  vi.stubGlobal('Hooks', {
    on: (name: string, fn: (app: unknown) => void) => {
      const id = nextHookId++;
      hooks.set(id, { name, fn });
      return id;
    },
    off: (_name: string, id: number) => hooks.delete(id),
  });
  vi.stubGlobal('CONFIG', { Combat: { documentClass: { create, canUserCreate } } });
  vi.stubGlobal('game', {
    user: { name: 'mcp-api' },
    scenes: new Map([
      [
        SCENE,
        {
          tokens: new Map([
            [LINKED, { actorId: HERO, actorLink: true }],
            [UNLINKED, { actorId: BEAST, actorLink: false }],
            [NO_ACTOR, { actorId: null, actorLink: false }],
          ]),
        },
      ],
    ]),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const both = [{ tokenId: LINKED, actorId: HERO }, { tokenId: UNLINKED }];

describe('create_combat module command', () => {
  it('creates the combat on the scene without a type, then its combatants, then begins it', async () => {
    await expect(createCombat({ sceneId: SCENE, combatants: both })).resolves.toEqual({
      combatId: COMBAT,
      sceneId: SCENE,
      combatantIds: ['combatant0000000', 'combatant1000000'],
      round: 1,
      turn: 0,
    });
    expect(calls).toEqual(['createCombat', 'createCombatants', 'startCombat']);
    // Exactly these keys: the scene always, never a type.
    expect(create).toHaveBeenCalledWith({ scene: SCENE, active: true });
    expect(combat.createEmbeddedDocuments).toHaveBeenCalledWith('Combatant', [
      { tokenId: LINKED, sceneId: SCENE, actorId: HERO },
      { tokenId: UNLINKED, sceneId: SCENE, actorId: BEAST },
    ]);
    expect(hooks.size).toBe(0);
  });

  it('seeds a token without an actor with its token and scene only', async () => {
    await createCombat({ sceneId: SCENE, combatants: [{ tokenId: NO_ACTOR }] });
    expect(combat.createEmbeddedDocuments).toHaveBeenCalledWith('Combatant', [
      { tokenId: NO_ACTOR, sceneId: SCENE },
    ]);
  });

  it('begins an empty combat without creating combatants', async () => {
    await expect(createCombat({ sceneId: SCENE })).resolves.toMatchObject({
      combatantIds: [],
      round: 1,
      turn: 0,
    });
    expect(calls).toEqual(['createCombat', 'startCombat']);
  });

  it('passes active: false through', async () => {
    await createCombat({ sceneId: SCENE, active: false });
    expect(create).toHaveBeenCalledWith({ scene: SCENE, active: false });
  });

  it.each([
    [
      'a missing scene',
      { sceneId: 'missingSSSSSSSSS' },
      'not-found',
      'Scene missingSSSSSSSSS not found',
    ],
    [
      'a missing token',
      { sceneId: SCENE, combatants: [{ tokenId: 'missingTTTTTTTTT' }] },
      'not-found',
      `Token missingTTTTTTTTT not found on scene ${SCENE}`,
    ],
    [
      'a token carrying another actor',
      { sceneId: SCENE, combatants: [{ tokenId: LINKED, actorId: BEAST }] },
      'not-found',
      `Token ${LINKED} carries actor ${HERO}, not ${BEAST}`,
    ],
    [
      'too many combatants',
      {
        sceneId: SCENE,
        combatants: Array.from({ length: MAX_COMBATANTS + 1 }, () => ({ tokenId: LINKED })),
      },
      'too-many-combatants',
      `at most ${MAX_COMBATANTS} combatants`,
    ],
  ])('refuses %s before creating anything', async (_label, params, code, message) => {
    const refusal = createCombat(params);
    await expect(refusal).rejects.toThrow(message);
    await expect(refusal).rejects.toMatchObject({ code });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a user who may not create combats', async () => {
    behaviour.canCreate = false;
    const refusal = createCombat({ sceneId: SCENE });
    await expect(refusal).rejects.toMatchObject({ code: 'permission' });
    expect(canUserCreate).toHaveBeenCalledWith({ name: 'mcp-api' });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses when a dialog stopped the creation, and closes it', async () => {
    behaviour.combatCreated = 'dialog';
    const refusal = createCombat({ sceneId: SCENE, combatants: both });
    await expect(refusal).rejects.toThrow(
      "The game system asked for input when creating the combat (dialog 'Choose an option'); nothing was created.",
    );
    await expect(refusal).rejects.toMatchObject({ code: 'input-required' });
    expect(hooks.size).toBe(0);
  });

  it('fails, without a refusal, when a hook prevented the creation', async () => {
    behaviour.combatCreated = 'prevented';
    const failure = createCombat({ sceneId: SCENE });
    await expect(failure).rejects.toThrow('FoundryVTT created no combat');
    await expect(failure).rejects.not.toBeInstanceOf(CommandRefusal);
  });

  it('leaves the combat and says so when its combatants cannot be created', async () => {
    behaviour.combatants = 'throw';
    await expect(createCombat({ sceneId: SCENE, combatants: both })).resolves.toEqual({
      combatId: COMBAT,
      sceneId: SCENE,
      combatantIds: [],
      round: 0,
      turn: null,
      incomplete: 'its combatants could not be created (validation failed), and it was not begun',
    });
    expect(calls).toEqual(['createCombat', 'createCombatants']);
  });

  it('reports combatants created only in part, and does not begin the combat', async () => {
    behaviour.combatants = 'some';
    await expect(createCombat({ sceneId: SCENE, combatants: both })).resolves.toMatchObject({
      combatId: COMBAT,
      combatantIds: ['combatant0000000'],
      incomplete: 'only 1 of its 2 combatants were created, and it was not begun',
    });
    expect(combat.startCombat).not.toHaveBeenCalled();
  });

  it('reports a combat that could not be begun', async () => {
    behaviour.start = 'throw';
    await expect(createCombat({ sceneId: SCENE, combatants: both })).resolves.toMatchObject({
      combatId: COMBAT,
      combatantIds: ['combatant0000000', 'combatant1000000'],
      incomplete: 'it could not be begun (hook failed)',
    });
  });

  it('fails, without a refusal, on malformed parameters', async () => {
    for (const params of [
      {},
      { sceneId: SCENE, combatants: 'all' },
      { sceneId: SCENE, combatants: [{ actorId: HERO }] },
      { sceneId: SCENE, combatants: [{ tokenId: LINKED, actorId: 7 }] },
      { sceneId: SCENE, active: 'yes' },
    ]) {
      const failure = createCombat(params);
      await expect(failure).rejects.toThrow();
      await expect(failure).rejects.not.toBeInstanceOf(CommandRefusal);
    }
    expect(create).not.toHaveBeenCalled();
  });
});
