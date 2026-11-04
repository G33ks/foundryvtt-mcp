/**
 * Isolation shared by the smoke tests: a spawned server must not pick up the
 * user's configuration, nor disturb the shared process they normally run.
 *
 * - every FOUNDRY_* and LOG_LEVEL variable is stripped from the inherited
 *   environment, and FOUNDRY_MCP_CONFIG points at a missing file, so neither
 *   the system environment nor the user's config.env supplies a setting;
 * - FOUNDRY_MCP_STATE_DIR points at the scratch directory, which also gives
 *   the server its own pipe name / socket path (see src/shared/paths.ts);
 * - the module bridge (a fixed local port) and the invisible GM browser
 *   session are switched off explicitly.
 *
 * Run the server with `cwd` set to the scratch directory as well: a `.env`
 * in the working directory is a configuration layer of its own.
 */

import { join } from 'node:path';

/**
 * @param {string} workDir scratch directory owned by the calling test
 * @param {Record<string, string>} settings the test's own settings
 * @returns {NodeJS.ProcessEnv}
 */
export function isolatedEnv(workDir, settings = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('FOUNDRY_') && key !== 'LOG_LEVEL',
    ),
  );
  return {
    ...env,
    FOUNDRY_MCP_CONFIG: join(workDir, 'no-config.env'),
    FOUNDRY_MCP_STATE_DIR: join(workDir, 'state'),
    FOUNDRY_MODULE_BRIDGE_ENABLED: 'false',
    FOUNDRY_HEADLESS_GM_ENABLED: 'false',
    // All-in-one mode: the default relay would start a background shared
    // process that outlives the test.
    FOUNDRY_MCP_SHARED: 'false',
    ...settings,
  };
}
