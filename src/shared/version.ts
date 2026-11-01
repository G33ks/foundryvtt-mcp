/**
 * @fileoverview The package version, read from `package.json` at runtime.
 *
 * `src/shared/` and `dist/shared/` sit at the same depth, so the same
 * relative path works from sources (tests, tsx) and from the build.
 */

import { readFileSync } from 'node:fs';

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
