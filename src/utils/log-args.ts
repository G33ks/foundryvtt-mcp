/**
 * @fileoverview Tool arguments as they may appear in a log line.
 *
 * `daemon.log` records every tool call. Journal pages, chat messages, macro
 * code and the like are the user's campaign text and have no business in a
 * log, so content-bearing arguments are replaced by their length. Ids, names
 * and other short parameters stay as they are, since they are what makes a
 * log line useful.
 */

/** Argument names whose string values are always content. */
const CONTENT_KEYS: ReadonlySet<string> = new Set([
  'content',
  'text',
  'html',
  'description',
  'flavor',
  'command',
]);

/** Any other string longer than this is treated as content too (pasted text, base64, …). */
const MAX_PLAIN_STRING = 200;

function placeholder(value: string): string {
  return `<${value.length} chars>`;
}

function redact(value: unknown, key: string | null): unknown {
  if (typeof value === 'string') {
    if ((key !== null && CONTENT_KEYS.has(key)) || value.length > MAX_PLAIN_STRING) {
      return placeholder(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    // Array items inherit the array's key: `content: ["…"]` is still content.
    return value.map((item) => redact(item, key));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k)]),
    );
  }
  return value;
}

/**
 * A copy of `args` safe to log: content-bearing strings (at any depth, e.g.
 * `pages[].content`) become `"<312 chars>"`. Never mutates `args`.
 */
export function redactToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  return redact(args, null) as Record<string, unknown>;
}
