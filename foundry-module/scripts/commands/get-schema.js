/**
 * Introspects a game system's schema for an Actor or Item type, so a caller
 * can learn what fields `create_world_actor` / `create_actor_item` /
 * `create_full_actor` expect *before* guessing at a `system` payload — for
 * whichever system is installed, not just one.
 *
 * The two schema styles give different answers. A type the system backs with
 * a DataModel (`CONFIG.<Document>.dataModels`) has a `.system` that is a
 * DataModel instance with a `.schema` describing every field: constructing a
 * throwaway, never-saved document and reading `.system.schema` gives the real
 * field types (`source: "datamodel"`). A type declared only by template.json
 * has a plain-object `.system`, with no schema at all: the answer then lists
 * the template's default values from `game.model`, with types inferred from
 * those values and marked `inferred: true` (`source: "template"`).
 *
 * A DataModel field also reports `persisted: false` (computed, never stored:
 * writing it has no effect), and `min`, `max`, `integer` and `positive` when
 * set.
 */

const MAX_DEPTH = 8;

/** Strips the trailing "Field" Foundry appends to every DataField class name. */
function fieldKind(field) {
  return field.constructor.name.replace(/Field$/, '');
}

/**
 * Recursively describes one DataField as a JSON-safe plain object:
 * `{ type, required?, nullable?, choices?, initial?, fields?, element? }`.
 *
 * `initial` is omitted on `SchemaField` nodes (`fields` present) — it would
 * just be the aggregate of every child's own `initial`, which `fields`
 * already conveys, so including both is pure duplication in an already
 * large payload.
 */
function describeField(field, depth) {
  if (depth > MAX_DEPTH) {
    return { type: fieldKind(field), truncated: true };
  }

  const out = { type: fieldKind(field) };
  if (field.required !== undefined) out.required = Boolean(field.required);
  if (field.nullable) out.nullable = true;
  if (field.persisted === false) out.persisted = false;
  if (typeof field.min === 'number') out.min = field.min;
  if (typeof field.max === 'number') out.max = field.max;
  if (field.integer === true) out.integer = true;
  if (field.positive === true) out.positive = true;
  if (field.choices) {
    out.choices = Array.isArray(field.choices) ? field.choices : Object.keys(field.choices);
  }

  if (field.fields) {
    // SchemaField: recurse into named sub-fields, skip the redundant `initial`.
    out.fields = {};
    for (const [key, sub] of Object.entries(field.fields)) {
      out.fields[key] = describeField(sub, depth + 1);
    }
    return out;
  }

  if (field.element) {
    // ArrayField/SetField: describe the element type once, not per-entry.
    out.element = describeField(field.element, depth + 1);
    out.initial = [];
    return out;
  }

  // Leaf field (Number/String/Boolean/HTML/DocumentId/…). `initial` can be a
  // factory function on some field types (e.g. one deriving from other
  // fields) — only literal values are JSON-safe and worth reporting.
  try {
    const init = typeof field.getInitialValue === 'function' ? field.getInitialValue() : field.initial;
    if (init !== undefined && typeof init !== 'function') out.initial = init;
  } catch {
    // Some fields' initial value depends on sibling data not available on a
    // bare probe document — leave `initial` unset rather than fail the walk.
  }

  return out;
}

/** The type of a template default value, as `fieldKind` names DataField types. */
function valueKind(value) {
  if (value === null || value === undefined) return 'Unknown';
  if (Array.isArray(value)) return 'Array';
  switch (typeof value) {
    case 'number':
      return 'Number';
    case 'string':
      return 'String';
    case 'boolean':
      return 'Boolean';
    case 'object':
      return 'Object';
    default:
      return 'Unknown';
  }
}

/**
 * Describes a template.json default value: `{ type, inferred: true,
 * fields? | initial? }`, the type inferred from the value.
 */
function describeValue(value, depth) {
  const out = { type: valueKind(value), inferred: true };
  if (depth > MAX_DEPTH) {
    out.truncated = true;
    return out;
  }
  if (out.type === 'Object') {
    out.fields = {};
    for (const [key, sub] of Object.entries(value)) {
      out.fields[key] = describeValue(sub, depth + 1);
    }
    return out;
  }
  if (value !== undefined) out.initial = value;
  return out;
}

/**
 * @param {{documentType: 'Actor'|'Item', type: string}} params
 * @returns {{documentType: string, type: string, source: 'datamodel'|'template', fields: Record<string, unknown>}}
 */
export function getDocumentSchema({ documentType, type }) {
  if (documentType !== 'Actor' && documentType !== 'Item') {
    throw new Error(`Invalid documentType: ${documentType}. Must be "Actor" or "Item"`);
  }
  if (typeof type !== 'string' || !type) {
    throw new Error('type is required and must be a string');
  }

  const validTypes = game.documentTypes[documentType] ?? [];
  if (!validTypes.includes(type)) {
    throw new Error(
      `Unknown ${documentType} type: "${type}". Valid types for this world: ${validTypes.filter((t) => t !== 'base').join(', ')}`,
    );
  }

  const documentClass = documentType === 'Actor' ? CONFIG.Actor.documentClass : CONFIG.Item.documentClass;
  // Never saved — constructing a Document does not touch the database.
  const probe = new documentClass({ name: '_schema_probe_', type });
  const schema = probe.system?.schema;

  const fields = {};
  if (!schema?.fields) {
    // template.json: no schema, only default values.
    const defaults = game.model?.[documentType]?.[type] ?? probe.system ?? {};
    for (const [key, value] of Object.entries(defaults)) {
      fields[key] = describeValue(value, 0);
    }
    return { documentType, type, source: 'template', fields };
  }

  for (const [key, field] of Object.entries(schema.fields)) {
    fields[key] = describeField(field, 0);
  }

  return { documentType, type, source: 'datamodel', fields };
}
