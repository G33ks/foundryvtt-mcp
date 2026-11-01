/**
 * Loads `.env` into `process.env` as an import side effect.
 *
 * Import this **first**, before any module that reads configuration. ESM
 * evaluates a module's dependencies before its own body, so calling
 * `dotenv.config()` in an entrypoint's body runs *after* every imported module
 * has already been evaluated. `utils/logger.ts` builds its logger at module
 * scope from `config.logLevel`, which resolves the whole config eagerly — so
 * the entrypoint-body form validated configuration before `.env` was read, and
 * a `.env` in the working directory had no effect at all (#206).
 *
 * The file is looked up in the working directory only. Claude desktop starts
 * MCP servers in `C:\Windows\System32`; no `.env` is looked up there —
 * configuration must come from the client's `env` block instead.
 */

import path from 'node:path';
import dotenv from 'dotenv';

function isWindowsSystemDir(cwd: string): boolean {
  if (process.platform !== 'win32') {
    return false;
  }
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const resolved = path.resolve(cwd).toLowerCase();
  return ['System32', 'SysWOW64'].some((dir) => resolved === path.join(root, dir).toLowerCase());
}

if (!isWindowsSystemDir(process.cwd())) {
  dotenv.config({ quiet: true });
}
