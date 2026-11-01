import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configFingerprint } from '../config-hash.js';
import { defaultStateDir, endpointFor } from '../paths.js';
import { LineDecoder, MAX_LINE_BYTES } from '../protocol.js';
import { loadOrCreateToken, readExistingToken, tokensMatch } from '../token.js';
import { packageVersion } from '../version.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fvtt-mcp-shared-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('LineDecoder', () => {
  it('splits messages across chunk boundaries', () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"a":1}\n{"b"')).toEqual([{ a: 1 }]);
    expect(decoder.push(':2}\n\n')).toEqual([{ b: 2 }]);
  });

  it('throws on invalid JSON and on an over-long line', () => {
    expect(() => new LineDecoder().push('not json\n')).toThrow();
    expect(() => new LineDecoder(4).push('{"long":')).toThrow(/exceeds/);
    expect(MAX_LINE_BYTES).toBeGreaterThan(50 * 1024 * 1024);
  });
});

describe('token', () => {
  it('creates a 64-hex token once and returns the same value afterwards', () => {
    const file = path.join(tempDir(), 'token');
    const token = loadOrCreateToken(file);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(loadOrCreateToken(file)).toBe(token);
    expect(readExistingToken(file)).toBe(token);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('replaces a malformed token file', () => {
    const file = path.join(tempDir(), 'token');
    writeFileSync(file, 'garbage');
    expect(readExistingToken(file)).toBeNull();
    const token = loadOrCreateToken(file);
    expect(readFileSync(file, 'utf8')).toBe(token);
  });

  it('compares tokens', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('abc', 'abcd')).toBe(false);
  });
});

describe('configFingerprint', () => {
  it('ignores key order and undefined values, and depends on the token', () => {
    const a = configFingerprint({ x: 1, y: { b: 2, a: 1 }, z: undefined }, 'k');
    const b = configFingerprint({ y: { a: 1, b: 2 }, x: 1 }, 'k');
    expect(a).toBe(b);
    expect(configFingerprint({ x: 2, y: { a: 1, b: 2 } }, 'k')).not.toBe(a);
    expect(configFingerprint({ x: 1, y: { a: 1, b: 2 } }, 'other')).not.toBe(a);
  });

  it('does not contain the secret in clear', () => {
    expect(configFingerprint({ password: 'hunter2' }, 'k')).not.toContain('hunter2');
  });
});

describe('paths', () => {
  it('uses LOCALAPPDATA on Windows and XDG_STATE_HOME elsewhere', () => {
    expect(defaultStateDir('win32', { LOCALAPPDATA: 'C:\\L' })).toBe(
      path.join('C:\\L', 'foundryvtt-mcp'),
    );
    expect(defaultStateDir('linux', { XDG_STATE_HOME: '/s' })).toBe(
      path.join('/s', 'foundryvtt-mcp'),
    );
    expect(defaultStateDir('linux', {})).toBe(
      path.join(os.homedir(), '.local', 'state', 'foundryvtt-mcp'),
    );
  });

  it('names a per-user pipe on Windows', () => {
    expect(endpointFor('ignored', 'win32', 'alice')).toBe('\\\\.\\pipe\\foundryvtt-mcp-alice');
  });

  it('falls back to a short socket path when the state dir is too deep', () => {
    expect(endpointFor('/s', 'linux', 'alice')).toBe(path.join('/s', 'daemon.sock'));
    const deep = `/${'d'.repeat(120)}`;
    expect(endpointFor(deep, 'linux', 'alice')).toBe(
      path.join(os.tmpdir(), 'foundryvtt-mcp-alice', 'daemon.sock'),
    );
  });
});

describe('packageVersion', () => {
  it('reads the version from package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
    expect(packageVersion()).toBe(pkg.version);
  });
});
