/**
 * @fileoverview Configuration management for FoundryVTT MCP Server
 *
 * This module validates the configuration resolved by `sources.ts` (environment,
 * `.env`, configuration file, defaults) using Zod schemas.
 *
 * @version 0.1.0
 * @author FoundryVTT MCP Team
 */

import { z } from 'zod';
import {
  describeSource,
  missingConfigMessage,
  type ResolvedSettings,
  resolveSettings,
  type SettingName,
} from './sources.js';

/**
 * Zod schema for validating server configuration
 *
 * Defines the structure and validation rules for all configuration options,
 * including server settings, FoundryVTT connection details, and caching options.
 */
const ConfigSchema = z.object({
  serverName: z.string().default('foundryvtt-mcp'),
  serverVersion: z.string().default('0.1.0'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),

  foundry: z.object({
    url: z
      .string()
      .url('Invalid FoundryVTT URL - must include protocol (http:// or https://)')
      .refine((url) => {
        try {
          const parsed = new URL(url);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
          return false;
        }
      }, 'URL must use http:// or https:// protocol')
      .refine((url) => {
        try {
          const parsed = new URL(url);
          // Warning for localhost in production
          if (
            process.env.NODE_ENV === 'production' &&
            (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
          ) {
            console.warn('⚠️  Warning: Using localhost URL in production environment');
          }
          return true;
        } catch {
          return false;
        }
      }, 'URL validation failed'),
    apiKey: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    userId: z.string().optional(),
    socketPath: z.string().default('/socket.io/'),
    timeout: z.number().default(10000),
    retryAttempts: z.number().default(3),
    retryDelay: z.number().default(1000),
    writeEnabled: z.boolean().default(false),
  }),

  cache: z.object({
    enabled: z.boolean().default(true),
    ttlSeconds: z.number().default(300), // 5 minutes
    maxSize: z.number().default(1000),
  }),

  /**
   * WebSocket relay for the companion Foundry module (canvas-only tools:
   * scene screenshots, etc.). Disabled by default — most tools need only
   * the Socket.IO document API, not a browser-side module.
   */
  moduleBridge: z.object({
    enabled: z.boolean().default(false),
    port: z.number().default(31415),
  }),

  /**
   * Invisible GM/Assistant-GM browser session that hosts the module bridge
   * without a human needing to manually open and log into a second Foundry
   * browser tab. Only launched when `moduleBridge` is also enabled — it
   * exists purely to give the companion module somewhere GM-tier to run.
   *
   * By default (no `username`, or the same one as `foundry.username`) the
   * page shares `FoundryClient`'s own session: one account, one cookie, no
   * `/join` of its own. A different `username` (with its `password`, which
   * falls back to `foundry.password`) is the advanced two-account mode: the
   * page logs that account in through the `/join` form.
   */
  headlessGm: z.object({
    enabled: z.boolean().default(true),
    username: z.string().optional(),
    password: z.string().optional(),
    executablePath: z.string().optional(),
  }),

  /**
   * Local filesystem access to FoundryVTT's `Data` directory — the same
   * directory the running Foundry server serves scene backgrounds and tile
   * textures from (`assets/...` paths in Scene/Tile documents resolve
   * relative to it). Optional: unset unless the MCP server runs on the same
   * host as FoundryVTT. Enables `list_scene_assets` (browsing available map
   * and prop art) and lets `create_scene`/`create_tile` read an image's
   * real pixel dimensions from disk instead of requiring the caller to
   * supply them by hand.
   */
  assets: z.object({
    dataPath: z.string().optional(),
  }),

  /**
   * In-memory world-event ring backing `watch_events` — the cursor-addressed
   * activity log an agent long-polls instead of re-calling
   * `get_chat_messages`/`get_combat_state` in a loop.
   */
  events: z.object({
    bufferSize: z.number().default(500),
    defaultWaitMs: z.number().default(25000),
  }),

  /**
   * Shared-process mode: MCP clients start lightweight stdio relays that
   * forward tool calls to one long-lived background process owning the
   * FoundryVTT connection, the module bridge and the headless GM session.
   * `enabled: false` keeps the all-in-one process (one connection per
   * client-spawned instance).
   */
  shared: z.object({
    enabled: z.boolean().default(true),
    /** Minutes with no relay connected before the shared process exits; 0 = never. */
    idleTimeoutMinutes: z.number().min(0).default(5),
  }),
});

/**
 * TypeScript type derived from the ConfigSchema
 *
 * This type provides compile-time type checking for configuration objects
 * and ensures consistency between the schema and type definitions.
 */
type Config = z.infer<typeof ConfigSchema>;

/**
 * No usable configuration: no FOUNDRY_URL anywhere, or a value that does not
 * validate. The message says where the configuration file is expected and
 * what it needs (see {@link missingConfigMessage}).
 */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

function int(value: string | undefined): number | undefined {
  return value ? parseInt(value, 10) : undefined;
}

function bool(value: string | undefined): boolean | undefined {
  return value !== undefined ? value === 'true' : undefined;
}

/** The raw configuration object the schema validates, from resolved settings. */
function rawConfig(v: ResolvedSettings['values']) {
  return {
    serverName: v.MCP_SERVER_NAME,
    serverVersion: v.MCP_SERVER_VERSION,
    logLevel: v.LOG_LEVEL,
    nodeEnv: v.NODE_ENV,

    foundry: {
      url: v.FOUNDRY_URL,
      apiKey: v.FOUNDRY_API_KEY,
      username: v.FOUNDRY_USERNAME,
      password: v.FOUNDRY_PASSWORD,
      userId: v.FOUNDRY_USER_ID,
      socketPath: v.FOUNDRY_SOCKET_PATH,
      timeout: int(v.FOUNDRY_TIMEOUT),
      retryAttempts: int(v.FOUNDRY_RETRY_ATTEMPTS),
      retryDelay: int(v.FOUNDRY_RETRY_DELAY),
      writeEnabled: bool(v.FOUNDRY_WRITE_ENABLED),
    },

    cache: {
      enabled: bool(v.CACHE_ENABLED),
      ttlSeconds: int(v.CACHE_TTL_SECONDS),
      maxSize: int(v.CACHE_MAX_SIZE),
    },

    moduleBridge: {
      enabled: bool(v.FOUNDRY_MODULE_BRIDGE_ENABLED),
      port: int(v.FOUNDRY_MODULE_BRIDGE_PORT),
    },

    headlessGm: {
      enabled: bool(v.FOUNDRY_HEADLESS_GM_ENABLED),
      username: v.FOUNDRY_HEADLESS_GM_USERNAME,
      password: v.FOUNDRY_HEADLESS_GM_PASSWORD,
      executablePath: v.FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH,
    },

    assets: {
      dataPath: v.FOUNDRY_DATA_PATH,
    },

    events: {
      bufferSize: int(v.FOUNDRY_EVENT_BUFFER_SIZE),
      defaultWaitMs: int(v.FOUNDRY_EVENT_WAIT_MS),
    },

    shared: {
      enabled: v.FOUNDRY_MCP_SHARED !== undefined ? v.FOUNDRY_MCP_SHARED !== 'false' : undefined,
      idleTimeoutMinutes: v.FOUNDRY_MCP_IDLE_TIMEOUT_MINUTES
        ? Number(v.FOUNDRY_MCP_IDLE_TIMEOUT_MINUTES)
        : undefined,
    },
  };
}

/** Schema path → environment variable, to name the setting in an error. */
const PATH_TO_SETTING: Record<string, string> = {
  'foundry.url': 'FOUNDRY_URL',
  logLevel: 'LOG_LEVEL',
  nodeEnv: 'NODE_ENV',
  'shared.idleTimeoutMinutes': 'FOUNDRY_MCP_IDLE_TIMEOUT_MINUTES',
};

/**
 * Validates resolved settings into a configuration.
 *
 * @throws {ConfigError} with the full explanation when there is none usable
 */
export function configFromSettings(settings: ResolvedSettings): Config {
  if (!settings.values.FOUNDRY_URL) {
    throw new ConfigError(missingConfigMessage(settings, 'FOUNDRY_URL is not set.'));
  }
  const parsed = ConfigSchema.safeParse(rawConfig(settings.values));
  if (parsed.success) {
    return parsed.data;
  }
  const problems = parsed.error.issues.map((issue) => {
    const where = issue.path.join('.');
    const name = PATH_TO_SETTING[where];
    const source = name
      ? ` (${name}, from ${describeSource(settings.sources[name as SettingName], settings)})`
      : '';
    return `${where}: ${issue.message}${source}`;
  });
  throw new ConfigError(
    missingConfigMessage(settings, `invalid settings — ${problems.join('; ')}.`),
  );
}

/**
 * Resolves and validates the configuration of this process.
 *
 * @throws {ConfigError} when there is none usable
 */
function loadConfig(): Config {
  const settings = resolveSettings();
  _settings = settings;
  return configFromSettings(settings);
}

/**
 * Cached configuration instance
 */
let _config: Config | null = null;
/** The settings the cached configuration was built from. */
let _settings: ResolvedSettings | null = null;

/**
 * Gets the global configuration instance
 *
 * This loads and caches the configuration on first access, allowing tests
 * to set environment variables before triggering configuration validation.
 * Throws {@link ConfigError} on access while no usable configuration exists;
 * the next access tries again.
 *
 * @returns Validated configuration object
 * @example
 * ```typescript
 * import { config } from './config/index.js';
 *
 * console.log(`Connecting to ${config.foundry.url}`);
 * ```
 */
export const config = new Proxy({} as Config, {
  get(_target, prop) {
    if (_config === null) {
      _config = loadConfig();
    }
    return _config[prop as keyof Config];
  },
});

/**
 * Returns the whole validated configuration as a plain object. Unlike the
 * {@link config} proxy it can be enumerated (e.g. to fingerprint it).
 *
 * @throws {ConfigError} when there is none usable (not cached: the next call retries)
 */
export function getConfig(): Config {
  if (_config === null) {
    _config = loadConfig();
  }
  return _config;
}

/** The configuration, or the error that explains why there is none. */
export function tryGetConfig(): { config: Config } | { error: ConfigError } {
  try {
    return { config: getConfig() };
  } catch (error) {
    if (error instanceof ConfigError) {
      return { error };
    }
    throw error;
  }
}

/** Settings the current configuration was resolved from (resolving them if needed). */
export function configSettings(): ResolvedSettings {
  if (_settings === null) {
    _settings = resolveSettings();
  }
  return _settings;
}

/**
 * Resets the cached configuration - used for testing, and by a relay that
 * re-reads its settings before each handshake
 * @internal
 */
export function resetConfig(): void {
  _config = null;
  _settings = null;
}

/**
 * Export the Config type for use in other modules
 *
 * @example
 * ```typescript
 * import type { Config } from './config/index.js';
 *
 * function processConfig(cfg: Config) {
 *   // Process configuration
 * }
 * ```
 */
export type { Config };
