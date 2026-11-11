/**
 * Reads actors' prepared `system` data from this client: what the sheet
 * works from, including the values the game system computes at preparation
 * and never stores. The server's world snapshot only holds stored data.
 *
 * A target is a world actor (`{actorId}`) or one token's actor (`{sceneId,
 * tokenId, actorId?}`), resolved as actor-target.js describes. Each target
 * gets a result or an `error`.
 *
 * `paths` (dot paths into `system`, an optional `system.` prefix removed)
 * narrow each result to `values` keyed by path, plus the `missing` ones; a
 * path under another requested path is dropped, the ancestor covers it.
 * Without `paths` the whole `system` is returned.
 *
 * `maxBytes` bounds the compact JSON of the whole answer. Over it, the answer
 * carries no data: `{tooLarge: true, bytes, maxBytes, results}`, where each
 * result lists its top-level keys (or paths) with their size, largest first.
 */

import { isActorTarget, resolveActorTarget } from '../actor-target.js';
import { serialize } from '../serialize.js';

const MAX_TARGETS = 50;
const MAX_PATHS = 50;
const MAX_PATH_LENGTH = 200;
const DEFAULT_MAX_BYTES = 32_768;
const MAX_MAX_BYTES = 1_048_576;
const PATH_PATTERN = /^[\w$-]+(\.[\w$-]+)*$/;

/** @param {unknown} value */
function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}


/**
 * Validates `paths`: strips `system.`, bounds them, and keeps only the
 * outermost of overlapping ones.
 *
 * @param {unknown} paths
 * @returns {string[] | null} null when no paths were requested
 */
export function normalizePaths(paths) {
  if (paths === undefined || paths === null) return null;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PATHS) {
    throw new Error(`paths must be an array of 1 to ${MAX_PATHS} dot paths into system`);
  }
  const cleaned = paths.map((path) => {
    if (typeof path !== 'string') throw new Error('paths must be strings');
    const relative = path.startsWith('system.') ? path.slice('system.'.length) : path;
    if (relative.length > MAX_PATH_LENGTH || !PATH_PATTERN.test(relative)) {
      throw new Error(
        `Invalid path ${JSON.stringify(path)}: a dot path into system of at most ${MAX_PATH_LENGTH} characters`,
      );
    }
    return relative;
  });
  const unique = [...new Set(cleaned)];
  return unique.filter(
    (path) => !unique.some((other) => other !== path && path.startsWith(`${other}.`)),
  );
}

/**
 * Reads a dot path through own properties, array indices and Map keys.
 *
 * @param {unknown} root
 * @param {string} path
 * @returns {{found: true, value: unknown} | {found: false}}
 */
function readPath(root, path) {
  let current = root;
  for (const part of path.split('.')) {
    if (current instanceof Map) {
      if (!current.has(part)) return { found: false };
      current = current.get(part);
    } else if (
      typeof current === 'object' &&
      current !== null &&
      Object.prototype.hasOwnProperty.call(current, part)
    ) {
      current = current[part];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}


/** @param {Record<string, unknown>} result */
function topLevelSizes(result) {
  const data = result.values ?? result.system;
  if (!isRecord(data)) return [];
  return Object.entries(data)
    .map(([key, value]) => ({ key, bytes: byteLength(value) }))
    .sort((a, b) => b.bytes - a.bytes);
}

/**
 * @param {{targets?: unknown, paths?: unknown, maxBytes?: unknown}} params
 */
export async function getActorStats(params) {
  const { targets } = params;
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAX_TARGETS) {
    throw new Error(`targets must be an array of 1 to ${MAX_TARGETS} targets`);
  }
  if (!targets.every(isActorTarget)) {
    throw new Error('Each target is {actorId} or {sceneId, tokenId, actorId?}');
  }
  const paths = normalizePaths(params.paths);
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MAX_BYTES) {
    throw new Error(`maxBytes must be an integer from 1 to ${MAX_MAX_BYTES}`);
  }

  let truncated = false;
  const results = targets.map((target) => {
    const resolved = resolveActorTarget(target);
    if ('error' in resolved) return { ...resolved.ref, error: resolved.error };
    const { actor, ref } = resolved;
    const result = { ...ref, actorId: actor.id, name: actor.name, type: actor.type };
    if (paths === null) {
      const serialized = serialize(actor.system);
      truncated ||= serialized.truncated;
      return { ...result, system: serialized.value };
    }
    const values = {};
    const missing = [];
    for (const path of paths) {
      const read = readPath(actor.system, path);
      if (!read.found) {
        missing.push(path);
        continue;
      }
      const serialized = serialize(read.value);
      truncated ||= serialized.truncated;
      values[path] = serialized.value;
    }
    return { ...result, values, missing };
  });

  const answer = { results, truncated };
  const bytes = byteLength(answer);
  if (bytes > maxBytes) {
    return {
      tooLarge: true,
      bytes,
      maxBytes,
      results: results.map((result) => {
        const { system: _system, values: _values, missing: _missing, ...ref } = result;
        return { ...ref, topLevel: topLevelSizes(result) };
      }),
    };
  }
  return { ...answer, bytes };
}
