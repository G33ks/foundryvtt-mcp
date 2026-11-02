/**
 * @fileoverview Fingerprint of the settings that define the FoundryVTT
 * connection, compared at the relay handshake (see `mismatchDecision` in
 * `daemon.ts`).
 *
 * Only {@link IDENTITY_SETTINGS} count: a relay whose LOG_LEVEL, timeouts or
 * idle delay differ is served as it is, with the shared process's values.
 * They are compared as validated values, so `true` and `TRUE`… compare as
 * FoundryVTT MCP reads them, not as typed.
 *
 * The settings include the FoundryVTT password. A plain hash of it could be
 * brute-forced offline if it ever leaked, so the fingerprint and the
 * per-setting digests are HMACs keyed by the per-user IPC token. Even so
 * they are never logged nor shown by `status`.
 */

import { createHmac } from 'node:crypto';
import type { Config } from '../config/index.js';

/** The settings that define the connection, with how to read each from a configuration. */
export const IDENTITY_SETTINGS = {
  FOUNDRY_URL: (c: Config) => c.foundry.url,
  FOUNDRY_USERNAME: (c: Config) => c.foundry.username,
  FOUNDRY_PASSWORD: (c: Config) => c.foundry.password,
  FOUNDRY_USER_ID: (c: Config) => c.foundry.userId,
  FOUNDRY_API_KEY: (c: Config) => c.foundry.apiKey,
  FOUNDRY_SOCKET_PATH: (c: Config) => c.foundry.socketPath,
  FOUNDRY_WRITE_ENABLED: (c: Config) => c.foundry.writeEnabled,
  FOUNDRY_MODULE_BRIDGE_ENABLED: (c: Config) => c.moduleBridge.enabled,
  FOUNDRY_MODULE_BRIDGE_PORT: (c: Config) => c.moduleBridge.port,
  FOUNDRY_HEADLESS_GM_ENABLED: (c: Config) => c.headlessGm.enabled,
  FOUNDRY_HEADLESS_GM_USERNAME: (c: Config) => c.headlessGm.username,
  FOUNDRY_HEADLESS_GM_PASSWORD: (c: Config) => c.headlessGm.password,
  FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH: (c: Config) => c.headlessGm.executablePath,
  FOUNDRY_DATA_PATH: (c: Config) => c.assets.dataPath,
} as const satisfies Record<string, (c: Config) => unknown>;

export type IdentitySetting = keyof typeof IDENTITY_SETTINGS;

function identityValues(config: Config): Array<[IdentitySetting, unknown]> {
  return (Object.keys(IDENTITY_SETTINGS) as IdentitySetting[])
    .sort()
    .map((name) => [name, IDENTITY_SETTINGS[name](config) ?? null]);
}

/** HMAC of the identity settings: equal when, and only when, they all are. */
export function configFingerprint(config: Config, token: string): string {
  return createHmac('sha256', token)
    .update(JSON.stringify(identityValues(config)))
    .digest('hex');
}

/**
 * One HMAC per identity setting, so the shared process can tell which
 * settings of a relay differ from its own without receiving any value.
 */
export function configDigests(config: Config, token: string): Record<IdentitySetting, string> {
  const digests = {} as Record<IdentitySetting, string>;
  for (const [name, value] of identityValues(config)) {
    digests[name] = createHmac('sha256', token)
      .update(JSON.stringify([name, value]))
      .digest('hex');
  }
  return digests;
}

/** Identity settings whose digests differ (all of them when `theirs` is unknown). */
export function differingSettings(
  ours: Record<string, string>,
  theirs: Record<string, string> | undefined,
): IdentitySetting[] {
  return (Object.keys(IDENTITY_SETTINGS) as IdentitySetting[]).filter(
    (name) => theirs === undefined || ours[name] !== theirs[name],
  );
}
