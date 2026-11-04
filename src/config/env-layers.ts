/**
 * @fileoverview The two layers of configuration that come from the process
 * itself: its environment (the MCP client's `env` block, or the system), and
 * a `.env` file in the working directory (handy for development).
 *
 * `.env` is parsed, never loaded into `process.env`: a relay hands its own
 * environment to the shared process it starts, and that process must tell
 * the client's settings apart from the configuration file (see
 * `config/sources.ts`). Kept free of config/logger imports so `paths.ts`,
 * `status` and `stop` can use it without a valid configuration.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Claude desktop starts MCP servers in `C:\Windows\System32`; a `.env` there
 * is never the user's, so none is looked up.
 */
export function isWindowsSystemDir(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== 'win32') {
    return false;
  }
  // Windows path rules whatever the host, so `platform` decides alone.
  const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  const resolved = path.win32.resolve(cwd).toLowerCase();
  return ['System32', 'SysWOW64'].some(
    (dir) => resolved === path.win32.join(root, dir).toLowerCase(),
  );
}

/** Settings of the `.env` file in `cwd`; empty when there is none (or `cwd` is System32). */
export function readDotenv(
  cwd: string = process.cwd(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { path: string | null; values: Record<string, string> } {
  if (isWindowsSystemDir(cwd, platform, env)) {
    return { path: null, values: {} };
  }
  const file = path.join(cwd, '.env');
  try {
    return { path: file, values: dotenv.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { path: null, values: {} };
  }
}

/**
 * The environment with the `.env` layer under it (an environment variable
 * wins, as `dotenv.config()` did). For settings that locate things before
 * the configuration file is read: `FOUNDRY_MCP_STATE_DIR`, `FOUNDRY_MCP_CONFIG`.
 */
export function processSettings(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return { ...readDotenv(cwd, platform, env).values, ...env };
}
