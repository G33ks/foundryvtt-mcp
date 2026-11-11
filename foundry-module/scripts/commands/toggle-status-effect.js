/**
 * Applies or removes a status effect the way the game system does, so the
 * effect gets what the system gives its own status effects (a fixed effect
 * id, a sub-type, system data), which an effect written over the socket would
 * not carry. Applying creates the effect as `Actor#toggleStatusEffect` does
 * (`ActiveEffect.fromStatusEffect`, then `create` with `keepId`), adding the
 * caller's `createOptions` to the creation options: a game system may read
 * one, where it would otherwise ask the user. Removing goes through
 * `Actor#toggleStatusEffect`.
 *
 * Nobody can answer a dialog in this page: one rendered while creating or
 * removing is closed at once. When nothing was created because of it, the
 * command fails with the dialog's title, so the caller can pass the value in
 * `createOptions`.
 *
 * The target is a world actor or one token's actor (see actor-target.js): on
 * an unlinked token, the synthetic actor's effects go to that token's delta.
 *
 * This command decides whether the call changes anything. The status' own
 * effect is the one toggleStatusEffect finds: the effect with the status'
 * fixed `_id` when it has one, otherwise the effects carrying this status
 * only. When the status has a fixed `_id`, effects carrying this status only
 * under another id are `legacy`: written earlier over the socket, which the
 * system does not recognise. They are reported when applying and removed with
 * `active: false`. An effect carrying several statuses is never touched.
 *
 * Answers `{active: true, changed, effectId, legacy}` or
 * `{active: false, changed, removed}`.
 */

import { isActorTarget, resolveActorTarget } from '../actor-target.js';

/**
 * The configured status effects as `[id, status]` pairs. `CONFIG.statusEffects`
 * is an array, also indexed by id on recent cores; a system may replace it
 * with an object keyed by id.
 */
function configuredStatuses() {
  const statuses = CONFIG.statusEffects ?? [];
  return Array.isArray(statuses)
    ? statuses.map((status) => [status.id, status])
    : Object.entries(statuses);
}

/** @param {unknown} name */
function localized(name) {
  return typeof name === 'string' ? (game.i18n?.localize(name) ?? name) : '';
}

/**
 * Ids of the effects carrying `statusId` and no other status.
 *
 * @param {Actor} actor
 * @param {string} statusId
 */
function singleStatusEffectIds(actor, statusId) {
  const ids = [];
  for (const effect of actor.effects) {
    if (effect.statuses?.size === 1 && effect.statuses.has(statusId)) ids.push(effect.id);
  }
  return ids;
}


/**
 * Runs `operation` while closing at once every dialog rendered meanwhile: this
 * page has nobody to answer one, and a dialog left open would hold the call.
 * The hook is removed whatever happens.
 *
 * @template T
 * @param {() => Promise<T>} operation
 * @returns {Promise<{result: T, dialogs: string[]}>} the dialogs' titles, in order
 */
export async function withDialogsClosed(operation) {
  const dialogs = [];
  const hookId = Hooks.on('renderDialogV2', (dialog) => {
    dialogs.push(String(dialog.title ?? dialog.options?.window?.title ?? ''));
    dialog.close({ animate: false });
  });
  try {
    return { result: await operation(), dialogs };
  } finally {
    Hooks.off('renderDialogV2', hookId);
  }
}

/**
 * @param {{target?: unknown, statusId?: unknown, active?: unknown, createOptions?: unknown}} params
 */
export async function toggleStatusEffect(params) {
  const { target, statusId } = params;
  const active = params.active ?? true;
  const createOptions = params.createOptions ?? {};
  if (!isActorTarget(target)) {
    throw new Error('target is {actorId} or {sceneId, tokenId, actorId?}');
  }
  if (typeof statusId !== 'string' || !statusId) {
    throw new Error('statusId is required and must be a string');
  }
  if (typeof active !== 'boolean') {
    throw new Error('active must be a boolean');
  }
  if (
    typeof createOptions !== 'object' ||
    createOptions === null ||
    Array.isArray(createOptions)
  ) {
    throw new Error('createOptions must be an object');
  }

  const statuses = configuredStatuses();
  const status = statuses.find(([id]) => id === statusId)?.[1];
  if (!status) {
    const valid = statuses.map(([id, s]) => `${id} (${localized(s.name)})`).join(', ');
    throw new Error(`Unknown status effect "${statusId}". Valid ids: ${valid || '(none)'}`);
  }

  const resolved = resolveActorTarget(target);
  if ('error' in resolved) throw new Error(resolved.error);
  const { actor } = resolved;

  const single = singleStatusEffectIds(actor, statusId);
  let own;
  let legacy = [];
  if (status._id) {
    own = actor.effects.get(status._id) ? [status._id] : [];
    legacy = single.filter((id) => id !== status._id);
  } else {
    own = single;
  }

  if (active) {
    if (own.length > 0) {
      return { active: true, changed: false, effectId: own[0], legacy };
    }
    // Created as Actor#toggleStatusEffect does, with the caller's creation
    // options added: the core passes none, and a game system may read one.
    const ActiveEffect = CONFIG.ActiveEffect.documentClass;
    const { result: created, dialogs } = await withDialogsClosed(async () => {
      const effect = await ActiveEffect.fromStatusEffect(statusId, { parent: actor });
      return ActiveEffect.create(effect.toObject(), {
        ...createOptions,
        parent: actor,
        keepId: true,
      });
    });
    const effectId = typeof created?.id === 'string' ? created.id : null;
    if (effectId === null && dialogs.length > 0) {
      throw new Error(
        `The game system asked for input when creating status '${statusId}' (dialog '${dialogs[0]}'); nothing was created. Pass the value it expects in createOptions.`,
      );
    }
    return { active: true, changed: effectId !== null, effectId, legacy };
  }

  const before = new Set([...own, ...legacy]);
  const { dialogs } = await withDialogsClosed(async () => {
    if (own.length > 0) await actor.toggleStatusEffect(statusId, { active: false });
    if (legacy.length > 0) await actor.deleteEmbeddedDocuments('ActiveEffect', legacy);
  });
  const removed = [...before].filter((id) => !actor.effects.get(id));
  if (removed.length < before.size && dialogs.length > 0) {
    throw new Error(
      `The game system asked for input when removing status '${statusId}' (dialog '${dialogs[0]}'); ` +
        `removed: ${removed.join(', ') || 'nothing'}.`,
    );
  }
  return { active: false, changed: removed.length > 0, removed };
}
