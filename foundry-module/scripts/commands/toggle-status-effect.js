/**
 * Applies or removes a status effect the way the game system does: through
 * `Actor#toggleStatusEffect`, so the effect gets what the system gives its
 * own status effects (a fixed effect id, a sub-type, system data), which an
 * effect written over the socket would not carry.
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
 * @param {{target?: unknown, statusId?: unknown, active?: unknown}} params
 */
export async function toggleStatusEffect(params) {
  const { target, statusId } = params;
  const active = params.active ?? true;
  if (!isActorTarget(target)) {
    throw new Error('target is {actorId} or {sceneId, tokenId, actorId?}');
  }
  if (typeof statusId !== 'string' || !statusId) {
    throw new Error('statusId is required and must be a string');
  }
  if (typeof active !== 'boolean') {
    throw new Error('active must be a boolean');
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
    // Resolves to the created effect here: nothing of its own was there.
    const created = await actor.toggleStatusEffect(statusId, { active: true });
    const effectId = typeof created?.id === 'string' ? created.id : null;
    return { active: true, changed: effectId !== null, effectId, legacy };
  }

  const removed = [];
  if (own.length > 0) {
    await actor.toggleStatusEffect(statusId, { active: false });
    removed.push(...own);
  }
  if (legacy.length > 0) {
    await actor.deleteEmbeddedDocuments('ActiveEffect', legacy);
    removed.push(...legacy);
  }
  return { active: false, changed: removed.length > 0, removed };
}
