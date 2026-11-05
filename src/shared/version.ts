/**
 * @fileoverview The package name and version, read from `package.json` at runtime.
 *
 * `src/shared/` and `dist/shared/` sit at the same depth, so the same
 * relative path works from sources (tests, tsx) and from the build.
 */

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let cachedPackage: { name: string; version: string } | null = null;

function readPackage(): { name: string; version: string } {
  if (cachedPackage === null) {
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    } catch {
      // the defaults below
    }
    const pkg = raw;
    const isObject = typeof pkg === 'object' && pkg !== null;
    const name = isObject && 'name' in pkg ? pkg.name : undefined;
    const version = isObject && 'version' in pkg ? pkg.version : undefined;
    cachedPackage = {
      name: typeof name === 'string' ? name : 'foundryvtt-mcp',
      version: typeof version === 'string' ? version : '0.0.0-unknown',
    };
  }
  return cachedPackage;
}

export function packageVersion(): string {
  return readPackage().version;
}

/** The npm package name, e.g. for `npm install -g <name>`. */
export function packageName(): string {
  return readPackage().name;
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
