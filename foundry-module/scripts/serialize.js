/**
 * Turns prepared Foundry data (an Actor's `system`, for instance) into plain
 * JSON values. A pure function with no Foundry globals, so it runs under Node
 * in the server's tests.
 *
 * Prepared data is not what `JSON.stringify` gives: a DataModel's `toJSON()`
 * returns its stored source, without the values the game system computes.
 * So a DataModel, a plain object or any other object is read through its own
 * enumerable properties, which hold every field plus what preparation added.
 * Getters defined on a class prototype are not read; neither are private
 * fields or non-enumerable properties (a DataModel's `parent` and `_source`).
 *
 * Conversions:
 * - finite numbers, strings, booleans and null as they are; NaN and
 *   ±Infinity become null; a bigint becomes its decimal string;
 * - undefined, functions and symbols are left out of objects (null in arrays);
 * - a Document becomes `{"@uuid": "<uuid>"}` wherever it is, the root
 *   included: a field or a path that leads to a Document gives its reference,
 *   never its contents;
 * - a Set becomes an array; a Map an object when every key is a string,
 *   otherwise an array of `[key, value]` pairs; a Date its ISO string;
 * - any other object with a `toJSON()` (e.g. a Roll) is replaced by what that
 *   returns, then serialized;
 * - a property whose getter throws becomes `"[Error: <message>]"`.
 *
 * Limits: an object already being serialized higher up the same path becomes
 * `"[Circular]"`; past {@link MAX_DEPTH} levels an object or array becomes
 * `"[MaxDepth]"`; after {@link MAX_NODES} values the rest is cut and the
 * container being filled gets a last `"[Truncated]"` entry. Both of the last
 * two set `truncated: true` on the result.
 */

export const MAX_DEPTH = 12;
export const MAX_NODES = 20_000;

/** @typedef {{key: string, value: unknown} | {key: string, error: string}} Entry */

/** @param {object} value */
function isDocument(value) {
  return typeof value.documentName === 'string' && typeof value.uuid === 'string';
}

/** @param {object} value */
function isDataModel(value) {
  return '_source' in value && typeof value.constructor?.defineSchema === 'function';
}

/** @param {object} value */
function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/** @param {unknown} error */
function errorMarker(error) {
  return `[Error: ${error instanceof Error ? error.message : String(error)}]`;
}

/**
 * @param {unknown} root
 * @param {{maxDepth?: number, maxNodes?: number}} [options]
 * @returns {{value: unknown, truncated: boolean}}
 */
export function serialize(root, { maxDepth = MAX_DEPTH, maxNodes = MAX_NODES } = {}) {
  let nodes = 0;
  let truncated = false;
  let exhausted = false;
  /** Objects on the current path, to tell a cycle from a shared reference. */
  const ancestors = new Set();

  /**
   * @param {unknown} value
   * @param {number} depth
   * @returns {unknown} the JSON value, or undefined to leave the entry out
   */
  function visit(value, depth) {
    if (nodes >= maxNodes) {
      exhausted = true;
      truncated = true;
      return '[Truncated]';
    }
    nodes++;

    if (value === null) return null;
    switch (typeof value) {
      case 'string':
      case 'boolean':
        return value;
      case 'number':
        return Number.isFinite(value) ? value : null;
      case 'bigint':
        return value.toString();
      case 'undefined':
      case 'function':
      case 'symbol':
        return undefined;
    }

    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (isDocument(value)) {
      return { '@uuid': value.uuid };
    }
    if (ancestors.has(value)) {
      return '[Circular]';
    }
    if (depth >= maxDepth) {
      truncated = true;
      return '[MaxDepth]';
    }

    ancestors.add(value);
    try {
      return container(value, depth);
    } finally {
      ancestors.delete(value);
    }
  }

  /**
   * @param {object} value
   * @param {number} depth
   */
  function container(value, depth) {
    if (Array.isArray(value) || value instanceof Set) {
      return list(value, depth);
    }
    if (value instanceof Map) {
      const entries = [...value.entries()];
      if (entries.every(([key]) => typeof key === 'string')) {
        return object(
          entries.map(([key, entry]) => ({ key, value: entry })),
          depth,
        );
      }
      return list(entries, depth);
    }
    if (!isPlainObject(value) && !isDataModel(value) && typeof value.toJSON === 'function') {
      let json;
      try {
        json = value.toJSON();
      } catch (error) {
        return errorMarker(error);
      }
      // The replacement stands where the object stood, at the same depth.
      return json === value ? object(ownEntries(value), depth) : visit(json, depth);
    }
    return object(ownEntries(value), depth);
  }

  /**
   * Own enumerable string-keyed properties, each read once; a getter that
   * throws gives an entry with its error marker instead of a value.
   *
   * @param {object} value
   * @returns {Entry[]}
   */
  function ownEntries(value) {
    return Object.keys(value).map((key) => {
      try {
        return { key, value: value[key] };
      } catch (error) {
        return { key, error: errorMarker(error) };
      }
    });
  }

  /**
   * @param {Iterable<unknown>} items
   * @param {number} depth
   */
  function list(items, depth) {
    const out = [];
    for (const item of items) {
      const json = visit(item, depth + 1);
      out.push(json === undefined ? null : json);
      if (exhausted) break;
    }
    return out;
  }

  /**
   * @param {Entry[]} entries
   * @param {number} depth
   */
  function object(entries, depth) {
    const out = {};
    for (const entry of entries) {
      const json = 'error' in entry ? entry.error : visit(entry.value, depth + 1);
      if (json !== undefined) out[entry.key] = json;
      if (exhausted) break;
    }
    return out;
  }

  const value = visit(root, 0);
  return { value: value === undefined ? null : value, truncated };
}
