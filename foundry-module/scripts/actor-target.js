/**
 * Resolves the actor a command addresses: a world actor (`{actorId}`) or one
 * token's actor (`{sceneId, tokenId, actorId?}`). A linked token's actor is
 * its world actor; an unlinked token's is its own synthetic actor (the base
 * actor with the token's delta applied, prepared), available on any scene
 * without a canvas.
 */

/** @param {unknown} value */
function isId(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Whether `target` has one of the two accepted shapes.
 *
 * @param {unknown} target
 */
export function isActorTarget(target) {
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return false;
  if (target.actorId !== undefined && !isId(target.actorId)) return false;
  return target.sceneId === undefined && target.tokenId === undefined
    ? isId(target.actorId)
    : isId(target.sceneId) && isId(target.tokenId);
}

/**
 * The actor a target names, or why there is none: scene missing, token
 * missing, base actor deleted, or another actor than the one given.
 *
 * @param {{actorId?: string, sceneId?: string, tokenId?: string}} target
 * @returns {{actor: Actor, ref: Record<string, unknown>} | {error: string, ref: Record<string, unknown>}}
 */
export function resolveActorTarget(target) {
  const { actorId, sceneId, tokenId } = target;
  if (sceneId === undefined && tokenId === undefined) {
    const ref = { actorId };
    const actor = game.actors.get(actorId);
    return actor ? { actor, ref } : { error: `Actor ${actorId} not found`, ref };
  }
  const ref = { sceneId, tokenId, ...(actorId === undefined ? {} : { actorId }) };
  const scene = game.scenes.get(sceneId);
  if (!scene) return { error: `Scene ${sceneId} not found`, ref };
  const token = scene.tokens.get(tokenId);
  if (!token) return { error: `Token ${tokenId} not found on scene ${sceneId}`, ref };
  if (actorId !== undefined && token.actorId !== actorId) {
    return {
      error: `Token ${tokenId} carries actor ${token.actorId ?? '(none)'}, not ${actorId}`,
      ref,
    };
  }
  const actor = token.actor;
  if (!actor) {
    return {
      error: `Token ${tokenId} has no actor: its base actor ${token.actorId ?? '(none)'} is deleted or missing`,
      ref,
    };
  }
  return { actor, ref: { ...ref, linked: Boolean(token.actorLink) } };
}
