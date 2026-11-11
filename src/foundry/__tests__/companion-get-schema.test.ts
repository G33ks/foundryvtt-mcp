/**
 * @fileoverview The companion module's `get_document_schema` command run
 * under Node: a DataModel-backed type, and a type declared only by
 * template.json.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDocumentSchema } from '../../../foundry-module/scripts/commands/get-schema.js';

/** Stand-ins for DataField classes: the kind comes from the class name. */
class NumberField {
  constructor(public options: Record<string, unknown> = {}) {
    Object.assign(this, options);
  }
  getInitialValue() {
    return this.options.initial;
  }
}
class StringField extends NumberField {}
class SchemaField {
  constructor(public fields: Record<string, unknown>) {}
}

/** A document class whose `system` is what `systemFor(type)` gives. */
function documentClass(systemFor: (type: string) => unknown) {
  return class {
    system: unknown;
    constructor({ type }: { type: string }) {
      this.system = systemFor(type);
    }
  };
}

function stubFoundry(system: (type: string) => unknown, model: unknown = undefined) {
  vi.stubGlobal('game', {
    documentTypes: { Actor: ['base', 'hero', 'legacy'], Item: [] },
    model,
  });
  vi.stubGlobal('CONFIG', { Actor: { documentClass: documentClass(system) }, Item: {} });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('get_document_schema module command', () => {
  it('describes a DataModel schema with persisted, min, max, integer and positive', () => {
    const schema = new SchemaField({
      pool: new SchemaField({
        max: new NumberField({ required: true, initial: 10, min: 0, integer: true }),
        spent: new NumberField({ initial: 0, min: 0, max: 99, positive: false }),
        value: new NumberField({ persisted: false, initial: 0 }),
      }),
      label: new StringField({ initial: '' }),
      speed: new NumberField({ positive: true, initial: 1 }),
    });
    stubFoundry(() => ({ schema }));

    expect(getDocumentSchema({ documentType: 'Actor', type: 'hero' })).toEqual({
      documentType: 'Actor',
      type: 'hero',
      source: 'datamodel',
      fields: {
        pool: {
          type: 'Schema',
          fields: {
            max: { type: 'Number', required: true, min: 0, integer: true, initial: 10 },
            spent: { type: 'Number', min: 0, max: 99, initial: 0 },
            value: { type: 'Number', persisted: false, initial: 0 },
          },
        },
        label: { type: 'String', initial: '' },
        speed: { type: 'Number', positive: true, initial: 1 },
      },
    });
  });

  it('falls back to the template defaults, with inferred types, when there is no schema', () => {
    stubFoundry(() => ({ pool: { max: 10 } }), {
      Actor: {
        legacy: { pool: { max: 10, label: 'Pool', open: true, tags: [] }, notes: null },
      },
    });

    expect(getDocumentSchema({ documentType: 'Actor', type: 'legacy' })).toEqual({
      documentType: 'Actor',
      type: 'legacy',
      source: 'template',
      fields: {
        pool: {
          type: 'Object',
          inferred: true,
          fields: {
            max: { type: 'Number', inferred: true, initial: 10 },
            label: { type: 'String', inferred: true, initial: 'Pool' },
            open: { type: 'Boolean', inferred: true, initial: true },
            tags: { type: 'Array', inferred: true, initial: [] },
          },
        },
        notes: { type: 'Unknown', inferred: true, initial: null },
      },
    });
  });

  it("reads the probe's own values when game.model has no entry for the type", () => {
    stubFoundry(() => ({ level: 1 }), { Actor: {} });

    expect(getDocumentSchema({ documentType: 'Actor', type: 'legacy' }).fields).toEqual({
      level: { type: 'Number', inferred: true, initial: 1 },
    });
  });

  it('still refuses an unknown type', () => {
    stubFoundry(() => ({}));
    expect(() => getDocumentSchema({ documentType: 'Actor', type: 'nope' })).toThrow(
      'Unknown Actor type: "nope". Valid types for this world: hero, legacy',
    );
  });
});
