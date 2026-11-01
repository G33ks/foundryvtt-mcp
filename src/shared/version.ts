/**
 * @fileoverview The package version, read from `package.json` at runtime.
 *
 * `src/shared/` and `dist/shared/` sit at the same depth, so the same
 * relative path works from sources (tests, tsx) and from the build.
 */

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

export function packageVersion(): string {
  if (cached === null) {
    try {
      const pkg: unknown = JSON.parse(
        readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
      );
      const version =
        typeof pkg === 'object' && pkg !== null && 'version' in pkg ? pkg.version : undefined;
      cached = typeof version === 'string' ? version : '0.0.0-unknown';
    } catch {
      cached = '0.0.0-unknown';
    }
  }
  return cached;
}

let cachedBuild: string | null = null;

/**
 * The package version plus a build stamp (this compiled file's mtime, which
 * every `npm run build` rewrites). Compared at the relay handshake, so a
 * rebuild without a version bump still replaces a shared process running
 * the previous code.
 */
export function buildVersion(): string {
  if (cachedBuild === null) {
    let stamp = 'unknown';
    try {
      stamp = Math.trunc(statSync(fileURLToPath(import.meta.url)).mtimeMs).toString(36);
    } catch {
      // keep "unknown": relays and shared process then compare package versions only
    }
    cachedBuild = `${packageVersion()}+${stamp}`;
  }
  return cachedBuild;
}
