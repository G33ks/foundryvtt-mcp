/**
 * @fileoverview Writes the configuration file for `init`.
 *
 * Each value is written so that `dotenv.parse` reads it back unchanged:
 * between '…', else between `…` (it contains an apostrophe), else between
 * "…" — never with a `\n` or `\r` sequence inside, which dotenv expands in
 * double quotes. A value no quoting can carry is refused.
 *
 * An existing file keeps its comments and every key `init` does not manage:
 * managed keys are rewritten in place (new ones go at the end), after a
 * timestamped copy of the file.
 */

import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { readConfigFile } from '../config/sources.js';

/** Thrown for a value that cannot be written; never carries the value itself. */
export class UnwritableValueError extends Error {
  override name = 'UnwritableValueError';
}

/** The value quoted for a dotenv file. */
export function quoteValue(name: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new UnwritableValueError(`${name} contains a line break, which cannot be written.`);
  }
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  if (!value.includes('`')) {
    return `\`${value}\``;
  }
  if (!value.includes('"') && !/\\[nr]/.test(value)) {
    return `"${value}"`;
  }
  throw new UnwritableValueError(
    `${name} contains ', \` and " (or a \\n sequence), which no quoting can carry: choose another value.`,
  );
}

/** `KEY=…` line for `name`, possibly after `export`. */
function keyPattern(name: string): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?${name.replace(/[.]/g, '\\.')}\\s*=`);
}

/**
 * `text` with each of `updates` set: existing lines rewritten in place,
 * new keys appended. Comments, blank lines and other keys are kept.
 */
export function mergeConfig(text: string, updates: Array<[string, string]>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length > 0 ? text.split(/\r?\n/) : [];
  // A trailing newline leaves one empty last element: appended keys go before it.
  const trailing = lines.length > 0 && lines[lines.length - 1] === '' ? lines.pop() : undefined;
  for (const [name, value] of updates) {
    const line = `${name}=${quoteValue(name, value)}`;
    const pattern = keyPattern(name);
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i] ?? '')) {
        lines[i] = line;
        found = true;
      }
    }
    if (!found) {
      lines.push(line);
    }
  }
  if (trailing !== undefined || lines.length > 0) {
    lines.push('');
  }
  return lines.join(eol);
}

/** Header of a file `init` creates. */
export const NEW_FILE_HEADER = [
  '# FoundryVTT MCP — shared by every MCP client (written by `foundryvtt-mcp init`).',
  '# One KEY=value per line; see SETUP_GUIDE.md (Configuration) for every setting.',
  '',
].join('\n');

/** e.g. `20261102-183512`, local time. */
export function backupStamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

export interface WriteResult {
  /** The copy made of the previous file; `null` when there was none. */
  backup: string | null;
  created: boolean;
}

export interface WriteOptions {
  platform?: NodeJS.Platform;
  now?: Date;
}

/**
 * Writes `updates` to the configuration file at `file`, then reads it back
 * with the resolver's own parser to check every value.
 *
 * @throws UnwritableValueError before touching anything, for a value no quoting can carry
 * @throws Error when the file read back differs
 */
export function writeConfig(
  file: string,
  updates: Array<[string, string]>,
  options: WriteOptions = {},
): WriteResult {
  const platform = options.platform ?? process.platform;
  let previous: string | null = null;
  try {
    previous = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  // Quoting errors surface here, before any copy or write.
  const content = mergeConfig(previous ?? NEW_FILE_HEADER, updates);

  mkdirSync(path.dirname(file), { recursive: true });
  let backup: string | null = null;
  if (previous !== null) {
    backup = `${file}.bak-${backupStamp(options.now ?? new Date())}`;
    copyFileSync(file, backup);
  }
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
  if (platform !== 'win32') {
    chmodSync(temp, 0o600);
  }
  renameSync(temp, file);

  const { state, values } = readConfigFile(file, platform);
  const wrong = updates.filter(([name, value]) => values[name] !== value).map(([name]) => name);
  if (state.error || wrong.length > 0) {
    throw new Error(
      `${file} was written but does not read back as expected (${state.error ?? wrong.join(', ')})` +
        (backup ? `; the previous file is in ${backup}` : ''),
    );
  }
  return { backup, created: previous === null };
}
