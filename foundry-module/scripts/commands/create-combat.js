/**
 * Creates a combat and its combatants the way a FoundryVTT client does, so
 * the game system prepares them. A system may define a combat's and a
 * combatant's own data in code only the browsers load: a combat created over
 * the socket lacks it, and the browsers then reject the combat.
 *
 * Three operations, as the combat tracker does: create the combat on the
 * given scene (always passed: a system may otherwise pick the scene this page
 * shows), create its combatants from tokens of that scene, then begin it
 * (`Combat#startCombat`: round 1, turn 0). No `type` is ever passed: the
 * document class picks it. Dialogs rendered meanwhile are closed at once.
 *
 * Refusals: a scene or token that does not exist, or a token carrying
 * another actor than the one given (`not-found`), more than
 * {@link MAX_COMBATANTS} combatants (`too-many-combatants`), a user who may
 * not create combats (`permission`), a dialog that stopped the creation of
 * the combat (`input-required`). Malformed parameters are errors.
 *
 * Answers `{combatId, sceneId, combatantIds, round, turn}`. Once the combat
 * exists, a failure of the next steps does not delete it: the answer then
 * also carries `incomplete`, which says what did not happen.
 */

import { CommandRefusal } from '../refusal.js';
import { withDialogsClosed } from './toggle-status-effect.js';

export const MAX_COMBATANTS = 100;

/** @param {unknown} value */
function isId(value) {
  return typeof value === 'string' && value.length > 0;
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {{sceneId?: unknown, combatants?: unknown, active?: unknown}} params
 */
export async function createCombat(params) {
  const { sceneId } = params;
  const combatants = params.combatants ?? [];
  const active = params.active ?? true;
  if (!isId(sceneId)) {
    throw new Error('sceneId is required and must be a string');
  }
  if (!Array.isArray(combatants)) {
    throw new Error('combatants must be an array');
  }
  if (typeof active !== 'boolean') {
    throw new Error('active must be a boolean');
  }
  for (const combatant of combatants) {
    if (
      typeof combatant !== 'object' ||
      combatant === null ||
      !isId(combatant.tokenId) ||
      (combatant.actorId !== undefined && !isId(combatant.actorId))
    ) {
      throw new Error('Each combatant is {tokenId, actorId?}');
    }
  }
  if (combatants.length > MAX_COMBATANTS) {
    throw new CommandRefusal(
      'too-many-combatants',
      `A combat takes at most ${MAX_COMBATANTS} combatants here; ${combatants.length} were given.`,
    );
  }

  const scene = game.scenes.get(sceneId);
  if (!scene) {
    throw new CommandRefusal('not-found', `Scene ${sceneId} not found`);
  }
  const seeds = [];
  for (const { tokenId, actorId } of combatants) {
    const token = scene.tokens.get(tokenId);
    if (!token) {
      throw new CommandRefusal('not-found', `Token ${tokenId} not found on scene ${sceneId}`);
    }
    if (actorId !== undefined && token.actorId !== actorId) {
      throw new CommandRefusal(
        'not-found',
        `Token ${tokenId} carries actor ${token.actorId ?? '(none)'}, not ${actorId}`,
      );
    }
    seeds.push({ tokenId, sceneId, ...(token.actorId ? { actorId: token.actorId } : {}) });
  }

  const Combat = CONFIG.Combat.documentClass;
  if (!Combat.canUserCreate(game.user)) {
    throw new CommandRefusal(
      'permission',
      `FoundryVTT user ${game.user?.name ?? '(unknown)'} may not create combats`,
    );
  }

  const { result: combat, dialogs } = await withDialogsClosed(() =>
    Combat.create({ scene: sceneId, active }),
  );
  if (!combat) {
    if (dialogs.length > 0) {
      throw new CommandRefusal(
        'input-required',
        `The game system asked for input when creating the combat (dialog '${dialogs[0]}'); nothing was created.`,
      );
    }
    throw new Error('FoundryVTT created no combat: a hook or the game system prevented it');
  }

  /** @type {string[]} */
  let combatantIds = [];
  const answer = () => ({
    combatId: combat.id,
    sceneId,
    combatantIds,
    round: combat.round,
    turn: combat.turn,
  });

  if (seeds.length > 0) {
    try {
      const { result: created, dialogs: combatantDialogs } = await withDialogsClosed(() =>
        combat.createEmbeddedDocuments('Combatant', seeds),
      );
      combatantIds = (created ?? []).map((c) => c.id);
      if (combatantIds.length < seeds.length) {
        const dialog = combatantDialogs.length > 0 ? ` (dialog '${combatantDialogs[0]}')` : '';
        return {
          ...answer(),
          incomplete: `only ${combatantIds.length} of its ${seeds.length} combatants were created${dialog}, and it was not begun`,
        };
      }
    } catch (error) {
      return {
        ...answer(),
        incomplete: `its combatants could not be created (${messageOf(error)}), and it was not begun`,
      };
    }
  }

  try {
    await withDialogsClosed(() => combat.startCombat());
  } catch (error) {
    return { ...answer(), incomplete: `it could not be begun (${messageOf(error)})` };
  }
  return answer();
}
