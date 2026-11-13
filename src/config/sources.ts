/**
 * @fileoverview Where every setting comes from.
 *
 * One configuration file shared by every MCP client (`config.env`, dotenv
 * syntax, the same names as the environment variables), under the client's
 * own environment and an optional development `.env`. Per setting, the first
 * layer that defines it wins:
 *
 *   1. the environment (the MCP client's `env` block, or the system)
 *   2. `.env` in the working directory
 *   3. the configuration file
 *   4. the built-in default
 *
 * The provenance of each setting is kept, for `status` and for the shared
 * process's "the file is authoritative" rule (see `shared/daemon.ts`).
 * Kept free of config/logger imports: `status` and `stop` resolve settings
 * without a valid configuration.
 */

import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { defaultStateDir } from '../shared/paths.js';
import { processSettings, readDotenv } from './env-layers.js';

export type SettingSource = 'env' | '.env' | 'file' | 'default';

/** Every setting the server reads, by environment variable name. */
export const KNOWN_SETTINGS = [
  'FOUNDRY_URL',
  'FOUNDRY_USERNAME',
  'FOUNDRY_PASSWORD',
  'FOUNDRY_USER_ID',
  'FOUNDRY_API_KEY',
  'FOUNDRY_SOCKET_PATH',
  'FOUNDRY_WRITE_ENABLED',
  'FOUNDRY_TIMEOUT',
  'FOUNDRY_RETRY_ATTEMPTS',
  'FOUNDRY_RETRY_DELAY',
  'FOUNDRY_MODULE_BRIDGE_ENABLED',
  'FOUNDRY_MODULE_BRIDGE_PORT',
  'FOUNDRY_HEADLESS_GM_ENABLED',
  'FOUNDRY_HEADLESS_GM_USERNAME',
  'FOUNDRY_HEADLESS_GM_PASSWORD',
  'FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH',
  'FOUNDRY_DATA_PATH',
  'FOUNDRY_UPLOAD_SOURCE_DIR',
  'FOUNDRY_EVENT_BUFFER_SIZE',
  'FOUNDRY_EVENT_WAIT_MS',
  'FOUNDRY_MCP_SHARED',
  'FOUNDRY_MCP_IDLE_TIMEOUT_MINUTES',
  'CACHE_ENABLED',
  'CACHE_TTL_SECONDS',
  'CACHE_MAX_SIZE',
  'LOG_LEVEL',
  'NODE_ENV',
  'MCP_SERVER_NAME',
] as const;
export type SettingName = (typeof KNOWN_SETTINGS)[number];

/**
 * Settings that locate the configuration itself: from the environment or
 * `.env` only — the file cannot say where the file is.
 */
export const BOOTSTRAP_SETTINGS = ['FOUNDRY_MCP_CONFIG', 'FOUNDRY_MCP_STATE_DIR'] as const;

/** Never shown: `status` and logs print `<set>` instead. */
export function isSecretSetting(name: string): boolean {
  return /PASSWORD|API_KEY|TOKEN|SECRET/.test(name);
}

/** The value as `status` may print it. */
export function displayValue(name: string, value: string | undefined): string {
  if (value === undefined) {
    return '';
  }
  return isSecretSetting(name) ? '<set>' : value;
}

export interface ConfigFileState {
  /** Where the file is expected (found or not). */
  path: string;
  found: boolean;
  /** Why it could not be read or parsed; `null` when it was, or is absent. */
  error: string | null;
  /** Readable by others than its owner (macOS/Linux); `null` otherwise. */
  warning: string | null;
}

export interface ResolvedSettings {
  /** Effective value of each known setting that some layer defines. */
  values: Partial<Record<SettingName, string>>;
  /** Layer each known setting comes from (`default` when none defines it). */
  sources: Record<SettingName, SettingSource>;
  file: ConfigFileState;
  /** The `.env` that was read, if any. */
  dotenvPath: string | null;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  platform?: NodeJS.Platform;
  /** Leave the environment and `.env` out: the file alone, as on disk now. */
  fileOnly?: boolean;
}

/**
 * Path of the configuration file: `FOUNDRY_MCP_CONFIG`, else
 * `<FOUNDRY_MCP_STATE_DIR>/config.env`, else `%LOCALAPPDATA%\foundryvtt-mcp\config.env`
 * (Windows) or `$XDG_CONFIG_HOME/foundryvtt-mcp/config.env`
 * (`~/.config/foundryvtt-mcp/config.env` without it).
 */
export function configFilePath(
  env: NodeJS.ProcessEnv = processSettings(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.FOUNDRY_MCP_CONFIG) {
    return path.resolve(env.FOUNDRY_MCP_CONFIG);
  }
  if (env.FOUNDRY_MCP_STATE_DIR || platform === 'win32') {
    return path.join(defaultStateDir(platform, env), 'config.env');
  }
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'foundryvtt-mcp', 'config.env');
}

/** Reads and parses the configuration file; a missing file is not an error. */
export function readConfigFile(
  file: string,
  platform: NodeJS.Platform = process.platform,
): { state: ConfigFileState; values: Record<string, string> } {
  const state: ConfigFileState = { path: file, found: false, error: null, warning: null };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      state.error = `cannot read the configuration file: ${(error as Error).message}`;
    }
    return { state, values: {} };
  }
  state.found = true;
  if (platform !== 'win32') {
    try {
      if ((statSync(file).mode & 0o077) !== 0) {
        state.warning = `${file} can be read by other users and holds passwords: run \`chmod 600 ${file}\``;
      }
    } catch {
      // Unreadable metadata: no warning rather than a false one.
    }
  }
  try {
    return { state, values: dotenv.parse(text) };
  } catch (error) {
    state.error = `cannot parse the configuration file: ${(error as Error).message}`;
    return { state, values: {} };
  }
}

/** Every known setting with its effective value and where it comes from. */
export function resolveSettings(options: ResolveOptions = {}): ResolvedSettings {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const dotenvFile = readDotenv(cwd, platform, env);
  const located = { ...dotenvFile.values, ...env };
  const { state: file, values: fromFile } = readConfigFile(
    configFilePath(located, platform),
    platform,
  );

  const layers: Array<[SettingSource, Record<string, string | undefined>]> = options.fileOnly
    ? [['file', fromFile]]
    : [
        ['env', env],
        ['.env', dotenvFile.values],
        ['file', fromFile],
      ];
  const values: Partial<Record<SettingName, string>> = {};
  const sources = {} as Record<SettingName, SettingSource>;
  for (const name of KNOWN_SETTINGS) {
    sources[name] = 'default';
    for (const [source, layer] of layers) {
      const value = layer[name];
      if (value !== undefined) {
        values[name] = value;
        sources[name] = source;
        break;
      }
    }
  }
  return {
    values,
    sources,
    file,
    dotenvPath: options.fileOnly ? null : dotenvFile.path,
  };
}

/** e.g. "14 from file, 2 from env". */
export function summarizeSources(sources: Record<string, SettingSource>): string {
  const counts = new Map<SettingSource, number>();
  for (const source of Object.values(sources)) {
    if (source !== 'default') {
      counts.set(source, (counts.get(source) ?? 0) + 1);
    }
  }
  const order: SettingSource[] = ['file', 'env', '.env'];
  const parts = order
    .filter((source) => counts.has(source))
    .map((source) => `${counts.get(source)} from ${source}`);
  return parts.length > 0 ? parts.join(', ') : 'nothing set (defaults only)';
}

/** Human wording of a source, for notes and errors. */
export function describeSource(source: SettingSource, settings?: ResolvedSettings): string {
  switch (source) {
    case 'env':
      return "the client's env block (or the system environment)";
    case '.env':
      return settings?.dotenvPath ? settings.dotenvPath : '.env in the working directory';
    case 'file':
      return settings ? settings.file.path : 'the configuration file';
    case 'default':
      return 'the default';
  }
}

/**
 * What to tell a user with no usable configuration: where the file is
 * expected and what it needs at minimum.
 */
export function missingConfigMessage(settings: ResolvedSettings, problem: string): string {
  const { file } = settings;
  const where = file.found
    ? `the configuration file ${file.path}`
    : `${file.path} (this file does not exist yet)`;
  return [
    `FoundryVTT MCP is not configured: ${problem}`,
    `Put the settings in ${where}, one KEY=value per line, at least:`,
    '  FOUNDRY_URL=http://localhost:30000',
    '  FOUNDRY_USERNAME=mcp-api',
    "  FOUNDRY_PASSWORD='your password'",
    "Put each value between '…' (between `…` if it contains an apostrophe), or set the same",
    'variables in the env block of your MCP client. See SETUP_GUIDE.md (Configuration).',
    ...(file.error ? [`Note: ${file.error}`] : []),
  ].join('\n');
}
