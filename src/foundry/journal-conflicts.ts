/**
 * @fileoverview The list of detected journal overwrites, kept on disk so that
 * `get_health_status` still lists them after the shared process restarts.
 *
 * `<state dir>/journal-conflicts.json`:
 * `{ "version": 1, "conflicts": [{ at, journalId, pageId, journalName,
 * pageName, reason, savedBy, historyPath }] }`, `at` as an ISO date. Ids,
 * names, who saved and the path of the local copy: never page content (that
 * stays in the copies under `journal-history/`). Written whole on every
 * change, to a `.tmp` file renamed over the list, so a crash leaves the old
 * list or the new one, never half of one.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import type { JournalConflict } from './journal-integrity.js';

const FILE_VERSION = 1;

const StoredConflictSchema = z.object({
  at: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  journalId: z.string(),
  pageId: z.string(),
  journalName: z.string(),
  pageName: z.string(),
  reason: z.string(),
  savedBy: z.string().nullable(),
  historyPath: z.string().nullable(),
});

const FileSchema = z.object({ version: z.literal(FILE_VERSION), conflicts: z.array(z.unknown()) });

/** File operations, replaceable in tests. */
export interface ConflictFileOps {
  writeFileSync: (file: string, data: string, options: { encoding: 'utf8'; mode: number }) => void;
  renameSync: (from: string, to: string) => void;
}

const NODE_OPS: ConflictFileOps = { writeFileSync, renameSync };

/** Windows: an antivirus or indexer briefly holding the file. */
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY']);

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class JournalConflictFile {
  constructor(
    readonly file: string,
    private readonly ops: ConflictFileOps = NODE_OPS,
  ) {}

  /**
   * The conflicts kept in the file. A missing file is an empty list; an
   * unreadable or invalid one is an empty list and one warning; an invalid
   * entry is skipped. Pruning is the caller's.
   */
  load(): JournalConflict[] {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        logger.warn('Could not read the list of journal overwrites; starting with an empty one', {
          file: this.file,
          error: errorText(error),
        });
      }
      return [];
    }
    let parsed: z.infer<typeof FileSchema>;
    try {
      parsed = FileSchema.parse(JSON.parse(raw));
    } catch {
      logger.warn('The list of journal overwrites is not valid; starting with an empty one', {
        file: this.file,
      });
      return [];
    }
    const conflicts: JournalConflict[] = [];
    let skipped = 0;
    for (const entry of parsed.conflicts) {
      const stored = StoredConflictSchema.safeParse(entry);
      if (!stored.success) {
        skipped++;
        continue;
      }
      conflicts.push({ ...stored.data, at: Date.parse(stored.data.at) });
    }
    if (skipped > 0) {
      logger.warn(
        `Skipped ${skipped} invalid entr${skipped === 1 ? 'y' : 'ies'} of the list of journal overwrites`,
        {
          file: this.file,
        },
      );
    }
    return conflicts;
  }

  /**
   * Writes the whole list: a `.tmp` file, then a rename over the list, tried
   * twice when Windows reports the file busy. A failure is one warning; the
   * list in memory is unaffected.
   *
   * @returns whether the list was written
   */
  save(conflicts: readonly JournalConflict[]): boolean {
    const content = `${JSON.stringify(
      {
        version: FILE_VERSION,
        conflicts: conflicts.map((conflict) => ({
          at: new Date(conflict.at).toISOString(),
          journalId: conflict.journalId,
          pageId: conflict.pageId,
          journalName: conflict.journalName,
          pageName: conflict.pageName,
          reason: conflict.reason,
          savedBy: conflict.savedBy,
          historyPath: conflict.historyPath,
        })),
      },
      null,
      2,
    )}\n`;
    const tmp = `${this.file}.tmp`;
    for (let attempt = 1; ; attempt++) {
      try {
        mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        this.ops.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
        this.ops.renameSync(tmp, this.file);
        return true;
      } catch (error) {
        if (attempt === 1 && TRANSIENT_CODES.has(errorCode(error) ?? '')) {
          continue;
        }
        try {
          rmSync(tmp, { force: true });
        } catch {
          // Left behind; the next save overwrites it.
        }
        logger.warn('Could not save the list of journal overwrites; it is kept in memory', {
          file: this.file,
          error: errorText(error),
        });
        return false;
      }
    }
  }
}
