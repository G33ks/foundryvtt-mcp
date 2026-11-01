import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RotatingLog } from '../rotating-log.js';

let dir = '';
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('RotatingLog', () => {
  it('appends lines and rotates by size, keeping a bounded number of files', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'fvtt-mcp-log-'));
    const file = path.join(dir, 'daemon.log');
    const log = new RotatingLog(file, 26, 2);

    for (let i = 0; i < 8; i++) {
      log.write(`line-${i}-xxxxx`); // 13 bytes with the newline: one rotation every 2 lines
    }

    expect(readFileSync(file, 'utf8')).toBe('line-6-xxxxx\nline-7-xxxxx\n');
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('line-4-xxxxx\nline-5-xxxxx\n');
    expect(readFileSync(`${file}.2`, 'utf8')).toBe('line-2-xxxxx\nline-3-xxxxx\n');
    expect(existsSync(`${file}.3`)).toBe(false);
  });

  it('never throws, even when the directory does not exist', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'fvtt-mcp-log-'));
    const log = new RotatingLog(path.join(dir, 'missing', 'x.log'));
    expect(() => log.write('hello')).not.toThrow();
  });
});
