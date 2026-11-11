/**
 * @fileoverview The companion module's `serialize.js` (plain browser JS, no
 * Foundry globals) run under Node, with stand-ins for Foundry's DataModels,
 * Documents and Rolls.
 */

import { describe, expect, it } from 'vitest';
import { MAX_DEPTH, MAX_NODES, serialize } from '../../../foundry-module/scripts/serialize.js';

/** Stands in for a Foundry DataModel: fields and prepared values as own properties. */
class FakeModel {
  static defineSchema() {
    return {};
  }

  declare _source: Record<string, unknown>;
  declare parent: unknown;
  [key: string]: unknown;

  constructor(source: Record<string, unknown>, parent: unknown = null) {
    Object.defineProperty(this, '_source', { value: source });
    Object.defineProperty(this, 'parent', { value: parent });
    Object.assign(this, structuredClone(source));
  }

  toJSON() {
    return this._source;
  }

  get classGetter() {
    return 'never read';
  }
}

/** Stands in for a Foundry Document. */
class FakeDocument {
  documentName = 'Item';
  constructor(
    public id: string,
    public system: unknown = {},
  ) {}

  get uuid() {
    return `Actor.a.Item.${this.id}`;
  }
}

/** Stands in for a Roll: a class instance whose `toJSON()` describes it. */
class FakeRoll {
  constructor(
    public formula: string,
    private total: number,
  ) {}

  toJSON() {
    return { class: 'Roll', formula: this.formula, total: this.total };
  }
}

describe('serialize', () => {
  it('keeps plain JSON values', () => {
    const value = { a: 1, b: 'x', c: true, d: null, e: [1, 'two', false], f: { g: { h: 2 } } };
    expect(serialize(value)).toEqual({ value, truncated: false });
  });

  it('turns non-finite numbers into null and bigints into strings', () => {
    expect(serialize({ a: Number.NaN, b: Infinity, c: -Infinity, d: 10n ** 20n }).value).toEqual({
      a: null,
      b: null,
      c: null,
      d: '100000000000000000000',
    });
  });

  it('leaves out undefined, functions and symbols, and writes null for them in arrays', () => {
    const value = { a: undefined, b: () => 1, c: Symbol('s'), [Symbol('k')]: 1, d: 1 };
    expect(serialize(value).value).toEqual({ d: 1 });
    expect(serialize([undefined, () => 1, Symbol('s'), 2]).value).toEqual([null, null, null, 2]);
  });

  it('reads a DataModel through its own properties, never its toJSON source', () => {
    const model = new FakeModel({ hp: { value: 3, max: 10 } }, { name: 'parent actor' });
    model.hp = { value: 3, max: 12, pct: 25 };
    model.derived = 'computed';

    expect(serialize(model).value).toEqual({
      hp: { value: 3, max: 12, pct: 25 },
      derived: 'computed',
    });
  });

  it('does not read getters defined on a class prototype', () => {
    const value = serialize(new FakeModel({ a: 1 })).value as Record<string, unknown>;
    expect(value).not.toHaveProperty('classGetter');
  });

  it('replaces a Document by its uuid at every depth, the root included', () => {
    const item = new FakeDocument('i1', { weight: 2 });
    expect(serialize({ owned: item, list: [item] }).value).toEqual({
      owned: { '@uuid': 'Actor.a.Item.i1' },
      list: [{ '@uuid': 'Actor.a.Item.i1' }],
    });
    expect(serialize(item)).toEqual({ value: { '@uuid': 'Actor.a.Item.i1' }, truncated: false });
  });

  it('turns a Set into an array and a Map into an object or into pairs', () => {
    expect(serialize({ tags: new Set(['a', 'b']) }).value).toEqual({ tags: ['a', 'b'] });
    expect(
      serialize(
        new Map([
          ['x', 1],
          ['y', new Set([2])],
        ]),
      ).value,
    ).toEqual({ x: 1, y: [2] });
    expect(
      serialize(
        new Map<unknown, unknown>([
          [1, 'one'],
          ['two', 2],
        ]),
      ).value,
    ).toEqual([
      [1, 'one'],
      ['two', 2],
    ]);
  });

  it('turns a Map of Documents into uuids keyed by id', () => {
    const items = new Map([['i1', new FakeDocument('i1')]]);
    expect(serialize({ items }).value).toEqual({ items: { i1: { '@uuid': 'Actor.a.Item.i1' } } });
  });

  it('writes a Date as an ISO string, and an invalid Date as null', () => {
    expect(
      serialize({ at: new Date('2026-11-11T10:00:00Z'), bad: new Date('nope') }).value,
    ).toEqual({ at: '2026-11-11T10:00:00.000Z', bad: null });
  });

  it("uses another object's toJSON, such as a Roll's", () => {
    expect(serialize({ roll: new FakeRoll('1d6+2', 5) }).value).toEqual({
      roll: { class: 'Roll', formula: '1d6+2', total: 5 },
    });
  });

  it('reports a getter that throws, and a toJSON that throws', () => {
    const value: Record<string, unknown> = { ok: 1 };
    Object.defineProperty(value, 'broken', {
      enumerable: true,
      get() {
        throw new Error('no parent');
      },
    });
    const throwing = {
      toJSON() {
        throw new Error('bad roll');
      },
    };
    Object.setPrototypeOf(throwing, { kind: 'custom' });
    expect(serialize({ value, throwing }).value).toEqual({
      value: { ok: 1, broken: '[Error: no parent]' },
      throwing: '[Error: bad roll]',
    });
  });

  it('marks a cycle, but repeats a reference shared without one', () => {
    const shared = { n: 1 };
    const cyclic: Record<string, unknown> = { name: 'loop', shared, again: shared };
    cyclic.self = cyclic;
    cyclic.nested = { back: cyclic };
    expect(serialize(cyclic)).toEqual({
      value: {
        name: 'loop',
        shared: { n: 1 },
        again: { n: 1 },
        self: '[Circular]',
        nested: { back: '[Circular]' },
      },
      truncated: false,
    });
  });

  it('stops at the maximum depth and says so', () => {
    expect(MAX_DEPTH).toBe(12);
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 15; i++) {
      deep = { next: deep };
    }
    const result = serialize(deep);
    expect(result.truncated).toBe(true);
    let node = result.value as Record<string, unknown>;
    let levels = 0;
    while (typeof node.next === 'object') {
      node = node.next as Record<string, unknown>;
      levels++;
    }
    expect(levels).toBe(MAX_DEPTH - 1);
    expect(node.next).toBe('[MaxDepth]');
    expect(serialize(deep, { maxDepth: 20 }).truncated).toBe(false);
  });

  it('stops after the maximum number of values and says so', () => {
    expect(MAX_NODES).toBe(20_000);
    const big = { list: Array.from({ length: 30_000 }, (_, i) => i), after: 'never reached' };
    const result = serialize(big);
    expect(result.truncated).toBe(true);
    const value = result.value as { list: unknown[]; after?: unknown };
    expect(value.list).toHaveLength(MAX_NODES - 1);
    expect(value.list.at(-1)).toBe('[Truncated]');
    expect(value).not.toHaveProperty('after');

    const small = serialize({ a: [1, 2, 3], b: 4 }, { maxNodes: 4 });
    expect(small).toEqual({ value: { a: [1, 2, '[Truncated]'] }, truncated: true });
  });
});
