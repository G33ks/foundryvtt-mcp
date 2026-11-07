/**
 * @fileoverview Applies FoundryVTT `modifyDocument` broadcasts to the cached world state.
 *
 * `worldData` is loaded once at connect time (ADR-004) and was, until laurigates/foundryvtt-mcp#205, never
 * updated afterwards — so a write followed by a read returned pre-write data, and
 * changes made by other users (a player moving a token, the GM editing in the
 * Foundry UI) were invisible for the life of the connection.
 *
 * FoundryVTT broadcasts every accepted document mutation to connected clients on
 * the `modifyDocument` event. This module turns one such broadcast into an
 * in-place edit of the cached snapshot.
 *
 * **Idempotent by construction.** `create` upserts by `_id` rather than pushing,
 * and `delete` tolerates an id that is already gone. So it does not matter
 * whether FoundryVTT echoes a client's own writes back to it — applying the same
 * broadcast twice lands on the same state as applying it once.
 */

import { z } from 'zod';
import { isRecord } from '../utils/guards.js';
import { logger } from '../utils/logger.js';
import type { WorldActor, WorldCombat, WorldData, WorldScene } from './types.js';

/** A `modifyDocument` broadcast, once validated. */
export interface DocumentBroadcast {
  /** Document name — "Actor", "JournalEntry", "Token", … */
  type: string;
  action: 'create' | 'update' | 'delete';
  /** Created/updated document data, or deleted ids. */
  result: unknown[];
  /** Present for embedded documents: "Actor.<id>", "Scene.<id>", … */
  parentUuid?: string;
  /** Foundry user id that originated the change, when the envelope carries one. */
  userId?: string;
}

/**
 * Document name → the `WorldData` collection holding it.
 *
 * Types absent here (Setting, Adventure, …) are not cached, so broadcasts about
 * them are ignored rather than mishandled.
 */
const TOP_LEVEL_COLLECTIONS: Record<string, keyof WorldData> = {
  Actor: 'actors',
  Item: 'items',
  Scene: 'scenes',
  JournalEntry: 'journal',
  Combat: 'combats',
  ChatMessage: 'messages',
  User: 'users',
  Folder: 'folders',
  Macro: 'macros',
  Playlist: 'playlists',
  RollTable: 'tables',
  Cards: 'cards',
  Setting: 'settings',
};

/** Parent document name → embedded document name → the parent's array field. */
const EMBEDDED_COLLECTIONS: Record<string, Record<string, string>> = {
  Actor: { Item: 'items', ActiveEffect: 'effects' },
  Scene: {
    Token: 'tokens',
    AmbientLight: 'lights',
    AmbientSound: 'sounds',
    Wall: 'walls',
    Drawing: 'drawings',
    Note: 'notes',
    Tile: 'tiles',
    MeasuredTemplate: 'templates',
    Region: 'regions',
  },
  Combat: { Combatant: 'combatants' },
  Item: { ActiveEffect: 'effects' },
  JournalEntry: { JournalEntryPage: 'pages' },
  Playlist: { PlaylistSound: 'sounds' },
  RollTable: { TableResult: 'results' },
};

/**
 * Validates a raw socket payload as a `modifyDocument` broadcast.
 *
 * Returns `null` for anything unrecognized — a payload shape we do not model is
 * dropped rather than guessed at, leaving the cache untouched (and stale) rather
 * than corrupted.
 */
export function parseDocumentBroadcast(payload: unknown): DocumentBroadcast | null {
  if (!isRecord(payload)) {
    return null;
  }

  const { type, action, result, operation } = payload;
  if (typeof type !== 'string' || !type) {
    return null;
  }
  if (action !== 'create' && action !== 'update' && action !== 'delete') {
    return null;
  }
  if (!Array.isArray(result)) {
    return null;
  }
  // A rejected operation is broadcast to nobody, but be explicit about it.
  if (payload.error) {
    return null;
  }

  const broadcast: DocumentBroadcast = { type, action, result };

  const parentUuid = isRecord(operation) ? operation.parentUuid : undefined;
  if (typeof parentUuid === 'string' && parentUuid) {
    broadcast.parentUuid = parentUuid;
  }

  if (typeof payload.userId === 'string' && payload.userId) {
    broadcast.userId = payload.userId;
  }
  return broadcast;
}

/**
 * Validates a `modifyDocumentBatch` payload and splits it into broadcasts.
 *
 * FoundryVTT v14 sends `{results: DocumentSocketResponse[]}` on this event
 * instead of `modifyDocument` for a `foundry.documents.modifyBatch()` call,
 * and for any single operation with server-side side effects (activating a
 * scene deactivates the others, deleting a folder deletes its contents, …):
 * side effects first, the operation itself last. Each element has the shape
 * of a `modifyDocument` broadcast; invalid ones are dropped, the rest kept.
 *
 * @returns the broadcasts in order, or `null` when the payload is not a batch
 */
export function parseDocumentBatch(payload: unknown): DocumentBroadcast[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    return null;
  }
  return payload.results.flatMap((element) => parseDocumentBroadcast(element) ?? []);
}

/**
 * Keys that must never be copied out of a broadcast payload.
 *
 * Broadcast data arrives off the network from whatever FoundryVTT relays, so it
 * is untrusted input; writing these would reach `Object.prototype` and poison
 * every object in the process. ADR-010 already mandates hard-failing these in
 * mutation patches — the same rule applies on the way back in.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Copies own, safe keys out of an untrusted object.
 *
 * Applied to created documents before they enter the cache, so a hostile
 * payload cannot smuggle a `__proto__` key in through the create path either.
 */
function sanitize(doc: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype' ||
      FORBIDDEN_KEYS.has(key)
    ) {
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

/**
 * Sets or merges a value at a dot-separated path in `target`, creating nested
 * objects as needed.
 */
function setDotPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let curr = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      !part ||
      part === '__proto__' ||
      part === 'constructor' ||
      part === 'prototype' ||
      FORBIDDEN_KEYS.has(part)
    ) {
      return;
    }
    if (!isRecord(curr[part])) {
      curr[part] = {};
    }
    curr = curr[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (
    !last ||
    last === '__proto__' ||
    last === 'constructor' ||
    last === 'prototype' ||
    FORBIDDEN_KEYS.has(last)
  ) {
    return;
  }
  if (value === null) {
    delete curr[last];
  } else if (isRecord(value) && isRecord(curr[last])) {
    mergePatch(curr[last] as Record<string, unknown>, value);
  } else {
    curr[last] = value;
  }
}

/**
 * Recursively merges `patch` into `target`, matching FoundryVTT's own update
 * semantics: keys merge, `null` deletes, arrays replace wholesale, and
 * dot-notation keys (e.g. `'config.dim'`) expand into nested structures.
 *
 * Prototype-polluting keys are dropped rather than merged (see
 * {@link FORBIDDEN_KEYS}).
 */
export function mergePatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype' ||
      FORBIDDEN_KEYS.has(key)
    ) {
      continue;
    }
    if (key.includes('.')) {
      setDotPath(target, key, value);
      continue;
    }
    if (value === null) {
      delete target[key];
      continue;
    }
    if (isRecord(value) && isRecord(target[key])) {
      mergePatch(target[key] as Record<string, unknown>, value);
      continue;
    }
    target[key] = value;
  }
}

/**
 * Applies one broadcast to a document array in place.
 *
 * @returns true if the collection changed
 */
function applyToCollection(
  collection: Array<Record<string, unknown>>,
  action: DocumentBroadcast['action'],
  result: unknown[],
): boolean {
  let changed = false;

  if (action === 'delete') {
    // `result` is an array of deleted document ids.
    for (const id of result) {
      if (typeof id !== 'string') {
        continue;
      }
      const index = collection.findIndex((doc) => doc._id === id);
      if (index !== -1) {
        collection.splice(index, 1);
        changed = true;
      }
    }
    return changed;
  }

  for (const doc of result) {
    if (!isRecord(doc) || typeof doc._id !== 'string') {
      continue;
    }
    const existing = collection.find((d) => d._id === doc._id);

    if (action === 'create') {
      // Upsert, not push — re-applying a create must not duplicate the document.
      if (existing) {
        mergePatch(existing, doc);
      } else {
        collection.push(sanitize(doc));
      }
      changed = true;
      continue;
    }

    // update: FoundryVTT broadcasts the diff, so merge rather than replace.
    if (existing) {
      mergePatch(existing, doc);
      changed = true;
    }
  }

  return changed;
}

/**
 * Resolves the parent document a broadcast targets.
 *
 * Handles the simple `<Type>.<id>` form only. An unlinked token's writes,
 * parented to the token or to its ActorDelta, are applied before this by
 * {@link applyTokenDeltaBroadcast}; the `Scene.<sid>.Token.<tid>.Actor.<aid>`
 * form is not a parent FoundryVTT v14 accepts, so it resolves to nothing.
 */
function resolveParent(
  worldData: WorldData,
  parentUuid: string,
): { parentType: string; parent: Record<string, unknown> } | null {
  const segments = parentUuid.split('.');
  if (segments.length !== 2) {
    return null;
  }

  const parentType = segments[0];
  const parentId = segments[1];
  if (!parentType || !parentId) {
    return null;
  }

  const collectionKey = TOP_LEVEL_COLLECTIONS[parentType];
  if (!collectionKey) {
    return null;
  }

  const collection = worldData[collectionKey];
  if (!Array.isArray(collection)) {
    return null;
  }

  const parent = (collection as Array<WorldActor | WorldScene | WorldCombat>).find(
    (doc) => doc._id === parentId,
  );
  if (!parent) {
    return null;
  }

  return { parentType, parent: parent as unknown as Record<string, unknown> };
}

/**
 * `Scene.<sid>.Token.<tid>`, `….ActorDelta.<did>`, or `….ActorDelta.<did>.Item.<iid>`
 * (an effect on one of the token's items).
 */
const TOKEN_DELTA_PARENT_PATTERN =
  /^Scene\.([a-zA-Z0-9]{16})\.Token\.([a-zA-Z0-9]{16})(?:\.ActorDelta\.([a-zA-Z0-9]{16})(?:\.Item\.([a-zA-Z0-9]{16}))?)?$/;

/** The document with this `_id` in `collection`, when it is an array holding one. */
function findById(collection: unknown, id: string): Record<string, unknown> | undefined {
  if (!Array.isArray(collection)) {
    return undefined;
  }
  return collection.find((doc): doc is Record<string, unknown> => isRecord(doc) && doc._id === id);
}

/**
 * Applies an update to a token delta's items or effects.
 *
 * An entry the delta lacks but the base actor has is adopted first - copied
 * from the base, then changed - as FoundryVTT's server does. An entry already
 * in the delta is never copied again, so re-applying the update is a no-op.
 *
 * @returns true if the collection changed
 */
function updateDeltaCollection(
  collection: Array<Record<string, unknown>>,
  inherited: unknown,
  result: unknown[],
): boolean {
  let changed = false;
  for (const doc of result) {
    if (!isRecord(doc) || typeof doc._id !== 'string') {
      continue;
    }
    let target = findById(collection, doc._id);
    if (!target) {
      const source = findById(inherited, doc._id);
      if (!source) {
        continue;
      }
      target = structuredClone(source);
      collection.push(target);
    }
    mergePatch(target, doc);
    changed = true;
  }
  return changed;
}

/**
 * Applies a delete to a token delta's items or effects: an entry the base
 * actor has becomes a tombstone (`{_id, _tombstone: true}`, FoundryVTT's mark
 * that the token no longer inherits it), one of the token's own is removed.
 *
 * @returns true if the collection changed
 */
function deleteFromDeltaCollection(
  collection: Array<Record<string, unknown>>,
  inherited: unknown,
  result: unknown[],
): boolean {
  let changed = false;
  for (const id of result) {
    if (typeof id !== 'string') {
      continue;
    }
    const index = collection.findIndex((doc) => doc._id === id);
    if (findById(inherited, id)) {
      const tombstone = { _id: id, _tombstone: true };
      if (index === -1) {
        collection.push(tombstone);
      } else {
        collection[index] = tombstone;
      }
      changed = true;
    } else if (index !== -1) {
      collection.splice(index, 1);
      changed = true;
    }
  }
  return changed;
}

/**
 * Applies a create to a token delta's items or effects. A created document
 * whose id the delta holds as a tombstone takes the tombstone's place, as
 * FoundryVTT's `EmbeddedCollectionDelta#_set` replaces a managed entry's
 * source; any other create is the usual upsert.
 *
 * @returns true if the collection changed
 */
function createInDeltaCollection(
  collection: Array<Record<string, unknown>>,
  result: unknown[],
): boolean {
  for (const doc of result) {
    if (!isRecord(doc) || typeof doc._id !== 'string') {
      continue;
    }
    const index = collection.findIndex(
      (entry) => entry._id === doc._id && entry._tombstone === true,
    );
    if (index !== -1) {
      collection[index] = sanitize(doc);
    }
  }
  return applyToCollection(collection, 'create', result);
}

/**
 * Applies a write to an unlinked token's synthetic actor.
 *
 * FoundryVTT stores an unlinked token's own HP, items and effects in the
 * token's `delta` (an ActorDelta), and its client sends those writes as
 * `ActorDelta` updates parented to the token, as embedded Item/ActiveEffect
 * operations parented to `<token>.ActorDelta.<id>`, or as ActiveEffect
 * operations on one of its items (`….ActorDelta.<id>.Item.<iid>`). All land in
 * `token.delta`, which only holds what differs from the base actor: an
 * inherited entry is adopted on its first change, tombstoned on delete, and a
 * tombstone gives way to a document created again with its id (see
 * {@link updateDeltaCollection}, {@link deleteFromDeltaCollection},
 * {@link createInDeltaCollection}).
 * The delta itself is created only once something is applied to it.
 *
 * @returns true/false when the broadcast targets a token delta (changed or
 *   not), or null when it doesn't, so the caller falls through to the
 *   ordinary parent resolution.
 */
function applyTokenDeltaBroadcast(
  worldData: WorldData,
  broadcast: DocumentBroadcast,
): boolean | null {
  const { type, action, result, parentUuid } = broadcast;
  const match = parentUuid ? TOKEN_DELTA_PARENT_PATTERN.exec(parentUuid) : null;
  if (!match) {
    return null;
  }
  const [, sceneId, tokenId, deltaId, itemId] = match;
  const scene = worldData.scenes?.find((sc) => sc._id === sceneId);
  const token = scene?.tokens?.find((t) => (t as { _id?: string })._id === tokenId);
  if (!token) {
    return false;
  }
  const baseActorId = typeof token.actorId === 'string' ? token.actorId : undefined;
  const base = baseActorId
    ? (worldData.actors?.find((actor) => actor._id === baseActorId) as unknown as
        | Record<string, unknown>
        | undefined)
    : undefined;
  const existingDelta = isRecord(token.delta) ? token.delta : undefined;
  const ensureDelta = (): Record<string, unknown> => {
    if (!isRecord(token.delta)) {
      token.delta = { _id: deltaId ?? tokenId };
    }
    return token.delta as Record<string, unknown>;
  };

  if (!deltaId) {
    if (type !== 'ActorDelta' || action !== 'update') {
      return false;
    }
    const docs = result.filter(isRecord);
    if (docs.length === 0) {
      return false;
    }
    const delta = ensureDelta();
    for (const doc of docs) {
      mergePatch(delta, doc);
    }
    return true;
  }

  if (itemId) {
    if (type !== 'ActiveEffect') {
      return false;
    }
    const own = findById(existingDelta?.items, itemId);
    const baseItem = findById(base?.items, itemId);
    const item = own ?? (baseItem ? structuredClone(baseItem) : undefined);
    if (!item || item._tombstone === true) {
      logger.debug(
        `Ignored ${action} ActiveEffect broadcast: item ${itemId} is not on token ${tokenId} or its base actor`,
      );
      return false;
    }
    if (!Array.isArray(item.effects)) {
      if (action !== 'create') {
        return false;
      }
      item.effects = [];
    }
    const changed = applyToCollection(
      item.effects as Array<Record<string, unknown>>,
      action,
      result,
    );
    if (changed && !own) {
      const delta = ensureDelta();
      if (!Array.isArray(delta.items)) {
        delta.items = [];
      }
      (delta.items as Array<Record<string, unknown>>).push(item);
    }
    return changed;
  }

  const field = EMBEDDED_COLLECTIONS.Actor?.[type];
  if (!field) {
    return false;
  }
  const existing = Array.isArray(existingDelta?.[field])
    ? (existingDelta[field] as Array<Record<string, unknown>>)
    : undefined;
  const collection = existing ?? [];
  const inherited = base?.[field];
  const changed =
    action === 'create'
      ? createInDeltaCollection(collection, result)
      : action === 'update'
        ? updateDeltaCollection(collection, inherited, result)
        : deleteFromDeltaCollection(collection, inherited, result);
  if (changed && !existing) {
    ensureDelta()[field] = collection;
  }
  return changed;
}

/**
 * Applies a validated broadcast to the cached world state, in place.
 *
 * @returns true if the cache changed; false when the broadcast targets something
 *   not cached (an unmodelled document type, an unknown parent, a token that is
 *   not in the cache), in which case the cache is left untouched.
 */
export function applyDocumentBroadcast(
  worldData: WorldData,
  broadcast: DocumentBroadcast,
): boolean {
  const { type, action, result, parentUuid } = broadcast;
  if (result.length === 0) {
    return false;
  }

  if (parentUuid) {
    const deltaApplied = applyTokenDeltaBroadcast(worldData, broadcast);
    if (deltaApplied !== null) {
      return deltaApplied;
    }

    const resolved = resolveParent(worldData, parentUuid);
    if (!resolved) {
      return false;
    }

    const field = EMBEDDED_COLLECTIONS[resolved.parentType]?.[type];
    if (!field) {
      return false;
    }

    // The field is optional on several world types (an actor with no effects
    // omits `effects` entirely), so materialize it before a create.
    if (!Array.isArray(resolved.parent[field])) {
      if (action !== 'create') {
        return false;
      }
      resolved.parent[field] = [];
    }

    return applyToCollection(
      resolved.parent[field] as Array<Record<string, unknown>>,
      action,
      result,
    );
  }

  const collectionKey = TOP_LEVEL_COLLECTIONS[type];
  if (!collectionKey) {
    return false;
  }

  const collection = worldData[collectionKey];
  if (!Array.isArray(collection)) {
    return false;
  }

  return applyToCollection(collection as Array<Record<string, unknown>>, action, result);
}

// ============================================================================
// User presence (`userActivity`) — laurigates/foundryvtt-mcp#218
// ============================================================================

/** A validated `userActivity` broadcast: who, and whether they are present. */
export interface UserActivity {
  userId: string;
  active: boolean;
}

/**
 * FoundryVTT's `userActivity` payload, as far as presence is concerned.
 *
 * The event carries a grab-bag of ephemeral state (cursor position, ruler,
 * targets, active scene). Only `active` matters here; everything else is
 * accepted and ignored. The flag is absent on ordinary activity pings — Foundry
 * itself treats "no flag" as "present", so the parser defaults to `true`.
 */
const UserActivityDataSchema = z.object({ active: z.boolean().optional() });

/**
 * Validates a raw `userActivity` socket payload (laurigates/foundryvtt-mcp#218).
 *
 * This is untrusted network data, so it is schema-checked rather than cast.
 * Returns `null` for anything unrecognized, leaving presence as it was.
 */
export function parseUserActivity(userId: unknown, activityData: unknown): UserActivity | null {
  if (typeof userId !== 'string' || !userId) {
    return null;
  }
  if (activityData === undefined || activityData === null) {
    return { userId, active: true };
  }

  const parsed = UserActivityDataSchema.safeParse(activityData);
  if (!parsed.success) {
    return null;
  }
  return { userId, active: parsed.data.active ?? true };
}

/**
 * Applies a presence change to `worldData.activeUsers`, in place.
 *
 * `activeUsers` is a top-level `WorldData` field rather than a document
 * collection, which is exactly why `modifyDocument` broadcasts never reached it
 * and presence stayed frozen at the connect-time snapshot (laurigates/foundryvtt-mcp#218).
 *
 * @returns true if the active-user list changed
 */
export function applyUserActivity(worldData: WorldData, activity: UserActivity): boolean {
  if (!Array.isArray(worldData.activeUsers)) {
    worldData.activeUsers = [];
  }

  const index = worldData.activeUsers.indexOf(activity.userId);

  if (activity.active) {
    if (index !== -1) {
      return false;
    }
    worldData.activeUsers.push(activity.userId);
    return true;
  }

  if (index === -1) {
    return false;
  }
  worldData.activeUsers.splice(index, 1);
  return true;
}
