/**
 * @fileoverview The shared secret relays present to the shared process.
 *
 * The IPC endpoint is reachable by any local process of the same user (and,
 * for a misconfigured pipe ACL, possibly others); the token keeps a stray
 * client from driving FoundryVTT through it. Owner-only file mode on POSIX;
 * on Windows the file inherits the per-user ACL of `%LOCALAPPDATA%`.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** Reads the token, or `null` when none has been created yet (or it is malformed). */
export function readExistingToken(file: string): string | null {
  try {
    const token = readFileSync(file, 'utf8').trim();
    return TOKEN_PATTERN.test(token) ? token : null;
  } catch {
    return null;
  }
}

/**
 * Returns the token, creating it on first use. The token is written to a
 * private temp file and hard-linked into place: the link either appears
 * complete or fails with EEXIST, so concurrent relays/daemons never read a
 * half-written file and all agree on a single value.
 */
export function loadOrCreateToken(file: string): string {
  const existing = readExistingToken(file);
  if (existing) {
    return existing;
  }
  const token = randomBytes(32).toString('hex');
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, token, { encoding: 'utf8', mode: 0o600 });
  try {
    linkSync(temp, file);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    const raced = readExistingToken(file);
    if (raced) {
      return raced;
    }
    // A malformed file left by hand: replace it.
    renameSync(temp, file);
    return token;
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Constant-time token comparison. */
export function tokensMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
