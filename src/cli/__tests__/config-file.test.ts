/**
 * @fileoverview Tests for the configuration file writer of `init`.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupStamp,
  mergeConfig,
  quoteValue,
  UnwritableValueError,
  writeConfig,
} from '../config-file.js';

const TRAPPED_PASSWORDS = [
  'plain',
  'with # hash',
  '#starts-with-hash',
  "it's",
  'back`tick',
  'double"quote',
  "both ' and `",
  "all ' and ` but no dq",
  '  leading and trailing spaces  ',
  'literal \\n sequence',
  'ends with backslash\\',
  'equals=sign; semi;colon',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal password, not a template
  '$HOME ${VAR}',
  'ünïcödé — ✓',
  '',
];

describe('quoteValue', () => {
  it.each(TRAPPED_PASSWORDS)('reads back unchanged with dotenv.parse: %j', (password) => {
    const line = `FOUNDRY_PASSWORD=${quoteValue('FOUNDRY_PASSWORD', password)}\n`;
    expect(dotenv.parse(line).FOUNDRY_PASSWORD).toBe(password);
  });

  it('prefers \', then `, then "', () => {
    expect(quoteValue('K', 'a')).toBe("'a'");
    expect(quoteValue('K', "a'b")).toBe("`a'b`");
    expect(quoteValue('K', "a'b`c")).toBe('"a\'b`c"');
  });

  it('refuses a value no quoting can carry, without echoing it', () => {
    const secret = `a'b\`c"d`;
    expect(() => quoteValue('FOUNDRY_PASSWORD', secret)).toThrow(UnwritableValueError);
    try {
      quoteValue('FOUNDRY_PASSWORD', secret);
    } catch (error) {
      expect(String(error)).toContain('FOUNDRY_PASSWORD');
      expect(String(error)).not.toContain(secret);
    }
  });

  it('refuses a \\n sequence that would need double quotes, and real line breaks', () => {
    expect(() => quoteValue('K', "a'b`c\\n")).toThrow(UnwritableValueError);
    expect(() => quoteValue('K', 'line\nbreak')).toThrow(UnwritableValueError);
    expect(() => quoteValue('K', 'carriage\rreturn')).toThrow(UnwritableValueError);
  });
});

describe('mergeConfig', () => {
  it('rewrites managed keys in place and keeps comments and unknown keys', () => {
    const text = [
      '# my comment',
      "FOUNDRY_URL='http://old'",
      'MY_OWN_KEY=keep me',
      '',
      '  # indented comment',
      "export FOUNDRY_USERNAME='old-user'",
      '',
    ].join('\n');
    const merged = mergeConfig(text, [
      ['FOUNDRY_URL', 'https://new'],
      ['FOUNDRY_USERNAME', 'mcp-api'],
      ['FOUNDRY_WRITE_ENABLED', 'true'],
    ]);
    expect(merged).toBe(
      [
        '# my comment',
        "FOUNDRY_URL='https://new'",
        'MY_OWN_KEY=keep me',
        '',
        '  # indented comment',
        "FOUNDRY_USERNAME='mcp-api'",
        "FOUNDRY_WRITE_ENABLED='true'",
        '',
      ].join('\n'),
    );
    expect(dotenv.parse(merged)).toEqual({
      FOUNDRY_URL: 'https://new',
      MY_OWN_KEY: 'keep me',
      FOUNDRY_USERNAME: 'mcp-api',
      FOUNDRY_WRITE_ENABLED: 'true',
    });
  });

  it('keeps Windows line endings', () => {
    const merged = mergeConfig("# c\r\nFOUNDRY_URL='a'\r\n", [['FOUNDRY_URL', 'b']]);
    expect(merged).toBe("# c\r\nFOUNDRY_URL='b'\r\n");
  });

  it('does not mistake a longer key for a managed one', () => {
    const merged = mergeConfig("FOUNDRY_URL_OLD='x'\n", [['FOUNDRY_URL', 'y']]);
    expect(dotenv.parse(merged)).toEqual({ FOUNDRY_URL_OLD: 'x', FOUNDRY_URL: 'y' });
  });
});

describe('writeConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'init-config-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the folder and the file, with no backup', () => {
    const file = path.join(dir, 'nested', 'config.env');
    const result = writeConfig(file, [['FOUNDRY_PASSWORD', "p'#`w"]]);
    expect(result).toEqual({ backup: null, created: true });
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/^# FoundryVTT MCP/);
    expect(dotenv.parse(text).FOUNDRY_PASSWORD).toBe("p'#`w");
  });

  it.skipIf(process.platform === 'win32')('makes the file readable by its owner only', () => {
    const file = path.join(dir, 'config.env');
    writeConfig(file, [['FOUNDRY_URL', 'x']]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('copies an existing file first, then merges into it', () => {
    const file = path.join(dir, 'config.env');
    const original = "# hand-written\nMY_KEY='mine'\nFOUNDRY_URL='http://old'\n";
    writeFileSync(file, original);
    const now = new Date(2026, 10, 2, 18, 5, 9);
    const result = writeConfig(file, [['FOUNDRY_URL', 'https://new']], { now });

    expect(result.backup).toBe(`${file}.bak-20261102-180509`);
    expect(readFileSync(result.backup as string, 'utf8')).toBe(original);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# hand-written');
    expect(dotenv.parse(text)).toEqual({ MY_KEY: 'mine', FOUNDRY_URL: 'https://new' });
    // No temporary file left behind.
    expect(readdirSync(dir).sort()).toEqual(['config.env', 'config.env.bak-20261102-180509']);
  });

  it('touches nothing when a value cannot be written', () => {
    const file = path.join(dir, 'config.env');
    writeFileSync(file, "FOUNDRY_URL='a'\n");
    expect(() => writeConfig(file, [['FOUNDRY_PASSWORD', `'\`"`]])).toThrow(UnwritableValueError);
    expect(readdirSync(dir)).toEqual(['config.env']);
    expect(readFileSync(file, 'utf8')).toBe("FOUNDRY_URL='a'\n");
    expect(existsSync(path.join(dir, 'nested'))).toBe(false);
  });
});

describe('backupStamp', () => {
  it('pads every field', () => {
    expect(backupStamp(new Date(2026, 0, 3, 4, 5, 6))).toBe('20260103-040506');
  });
});
