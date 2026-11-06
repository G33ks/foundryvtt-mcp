/**
 * @fileoverview The list of journal overwrites kept in the state directory
 * (journal-conflicts.json): round trip through a restart, pruning at 24 h,
 * damaged files, write failures, and no page content in the file.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { logger } = await import('../../utils/logger.js');
const { JournalConflictFile } = await import('../journal-conflicts.js');
const { CONFLICT_RETENTION_MS, JournalWatch } = await import('../journal-integrity.js');
type JournalConflict = import('../journal-integrity.js').JournalConflict;

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function conflict(at: number, pageName = 'Page A'): JournalConflict {
  return {
    at,
    journalId: 'BpkELtkMcoZJ0QJF',
    pageId: 'Dyg1dKjr13KobKIu',
    journalName: 'ZZ · Test connecteur',
    pageName,
    reason: 'overwritten-by-editor-autosave',
    savedBy: null,
    historyPath: 'C:\\state\\journal-history\\BpkELtkMcoZJ0QJF\\Dyg1dKjr13KobKIu\\x.html',
  };
}

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'fvtt-mcp-conflicts-'));
  file = path.join(dir, 'journal-conflicts.json');
  vi.mocked(logger.warn).mockClear();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const stored = () =>
  JSON.parse(readFileSync(file, 'utf8')) as { version: number; conflicts: unknown[] };

describe('journal-conflicts.json', () => {
  it('keeps the overwrites across a restart', () => {
    const before = new JournalWatch(() => NOW, new JournalConflictFile(file));
    before.recordConflict(conflict(NOW - HOUR));

    const after = new JournalWatch(() => NOW, new JournalConflictFile(file));

    expect(after.recentConflicts()).toEqual([conflict(NOW - HOUR)]);
    expect(stored()).toMatchObject({
      version: 1,
      conflicts: [{ at: '2026-11-06T11:00:00.000Z', pageName: 'Page A' }],
    });
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('drops the overwrites older than 24 hours at load, and from the file', () => {
    new JournalConflictFile(file).save([
      conflict(NOW - CONFLICT_RETENTION_MS - HOUR, 'Old'),
      conflict(NOW - HOUR, 'Recent'),
    ]);

    const watch = new JournalWatch(() => NOW, new JournalConflictFile(file));

    expect(watch.recentConflicts().map((c) => c.pageName)).toEqual(['Recent']);
    expect(stored().conflicts).toHaveLength(1);
  });

  it('prunes the file when an overwrite expires while running', () => {
    let now = NOW;
    const watch = new JournalWatch(() => now, new JournalConflictFile(file));
    watch.recordConflict(conflict(NOW - HOUR));

    now = NOW + CONFLICT_RETENTION_MS;
    expect(watch.recentConflicts()).toEqual([]);
    expect(stored().conflicts).toEqual([]);
  });

  it('starts empty, with one warning, from a file that is not valid', () => {
    writeFileSync(file, '{ not json');

    const watch = new JournalWatch(() => NOW, new JournalConflictFile(file));

    expect(watch.recentConflicts()).toEqual([]);
    expect(vi.mocked(logger.warn).mock.calls.map(([m]) => m)).toEqual([
      'The list of journal overwrites is not valid; starting with an empty one',
    ]);
  });

  it('skips an invalid entry and keeps the others', () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        conflicts: [
          { at: 'yesterday?', pageId: 3 },
          { ...conflict(NOW - HOUR), at: '2026-11-06T11:00:00.000Z' },
        ],
      }),
    );

    const watch = new JournalWatch(() => NOW, new JournalConflictFile(file));

    expect(watch.recentConflicts()).toEqual([conflict(NOW - HOUR)]);
    expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toBe(
      'Skipped 1 invalid entry of the list of journal overwrites',
    );
  });

  it('starts empty and silent without a file', () => {
    expect(new JournalWatch(() => NOW, new JournalConflictFile(file)).recentConflicts()).toEqual(
      [],
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the list in memory, with one warning, when the file cannot be written', () => {
    const failing = new JournalConflictFile(file, {
      writeFileSync: () => {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      },
      renameSync: vi.fn(),
    });
    const watch = new JournalWatch(() => NOW, failing);

    watch.recordConflict(conflict(NOW - HOUR));

    expect(watch.recentConflicts()).toEqual([conflict(NOW - HOUR)]);
    expect(existsSync(file)).toBe(false);
    expect(vi.mocked(logger.warn).mock.calls.map(([m]) => m)).toEqual([
      'Could not save the list of journal overwrites; it is kept in memory',
    ]);
  });

  it('tries the rename once more when Windows reports the file busy', () => {
    const rename = vi
      .fn()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      })
      .mockImplementation((from: string, to: string) => {
        writeFileSync(to, readFileSync(from));
        rmSync(from);
      });
    const store = new JournalConflictFile(file, { writeFileSync, renameSync: rename });

    expect(store.save([conflict(NOW - HOUR)])).toBe(true);
    expect(rename).toHaveBeenCalledTimes(2);
    expect(stored().conflicts).toHaveLength(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('writes ids, names, who saved and the copy path — no other field, no page content', () => {
    const withContent = { ...conflict(NOW - HOUR), content: '<p>secret page text</p>' };
    new JournalConflictFile(file).save([withContent as JournalConflict]);

    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('secret page text');
    expect(Object.keys(stored().conflicts[0] as object).sort()).toEqual([
      'at',
      'historyPath',
      'journalId',
      'journalName',
      'pageId',
      'pageName',
      'reason',
      'savedBy',
    ]);
  });
});
