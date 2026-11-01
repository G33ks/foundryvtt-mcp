/**
 * @fileoverview The state file the shared process writes once it holds the
 * endpoint: `{ pid, version, startedAt, endpoint, logFile }`.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

export const DaemonStateSchema = z.object({
  pid: z.number().int(),
  version: z.string(),
  startedAt: z.string(),
  endpoint: z.string(),
  logFile: z.string(),
});
export type DaemonState = z.infer<typeof DaemonStateSchema>;

export function writeStateFile(file: string, state: DaemonState): void {
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** The state left by a running (or crashed) shared process, or `null`. */
export function readStateFile(file: string): DaemonState | null {
  try {
    const parsed = DaemonStateSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Removes the state file if it still describes process `pid`. */
export function removeStateFile(file: string, pid: number): void {
  if (readStateFile(file)?.pid === pid) {
    rmSync(file, { force: true });
  }
}
