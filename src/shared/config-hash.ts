/**
 * @fileoverview Fingerprint of the effective configuration, compared at the
 * relay handshake so a relay never talks to a shared process started with
 * different settings.
 *
 * The configuration includes the FoundryVTT password. A plain hash of it
 * could be brute-forced offline if it ever leaked, so the fingerprint is an
 * HMAC keyed by the per-user IPC token. Even so it is never logged.
 */

import { createHmac } from 'node:crypto';

/** JSON with object keys sorted at every level, so key order never changes the hash. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function configFingerprint(config: unknown, token: string): string {
  return createHmac('sha256', token).update(canonicalJson(config)).digest('hex');
}
