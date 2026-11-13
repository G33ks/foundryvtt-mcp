import { describe, expect, it } from 'vitest';
import { ConfigError, configFromSettings } from '../../config/index.js';
import { KNOWN_SETTINGS, type ResolvedSettings, type SettingName } from '../../config/sources.js';
import { configDigests, configFingerprint, differingSettings } from '../config-hash.js';

/** A validated configuration from raw settings, as a relay or the shared process builds it. */
function configOf(values: Partial<Record<SettingName, string>>) {
  const sources = Object.fromEntries(
    KNOWN_SETTINGS.map((name) => [name, 'env']),
  ) as ResolvedSettings['sources'];
  return configFromSettings({
    values: { FOUNDRY_URL: 'http://localhost:30000', ...values },
    sources,
    file: { path: 'config.env', found: false, error: null, warning: null },
    dotenvPath: null,
  });
}

describe('configFingerprint', () => {
  const base = configOf({ FOUNDRY_USERNAME: 'mcp-api', FOUNDRY_PASSWORD: 'hunter2' });

  it('ignores the settings outside the connection identity', () => {
    const noisy = configOf({
      FOUNDRY_USERNAME: 'mcp-api',
      FOUNDRY_PASSWORD: 'hunter2',
      LOG_LEVEL: 'debug',
      FOUNDRY_TIMEOUT: '30000',
      FOUNDRY_MCP_IDLE_TIMEOUT_MINUTES: '0',
      FOUNDRY_MCP_SHARED: 'true',
      FOUNDRY_EVENT_BUFFER_SIZE: '42',
    });
    expect(configFingerprint(noisy, 'k')).toBe(configFingerprint(base, 'k'));
  });

  it.each([
    ['FOUNDRY_WRITE_ENABLED', 'true'],
    ['FOUNDRY_URL', 'http://other:30000'],
    ['FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH', 'C:\\brave.exe'],
    ['FOUNDRY_MODULE_BRIDGE_PORT', '31416'],
    ['FOUNDRY_DATA_PATH', '/data'],
    ['FOUNDRY_UPLOAD_SOURCE_DIR', '/uploads'],
  ] as const)('changes with %s', (name, value) => {
    const changed = configOf({
      FOUNDRY_USERNAME: 'mcp-api',
      FOUNDRY_PASSWORD: 'hunter2',
      [name]: value,
    });
    expect(configFingerprint(changed, 'k')).not.toBe(configFingerprint(base, 'k'));
  });

  it('compares validated values, not their spelling', () => {
    const a = configOf({ FOUNDRY_WRITE_ENABLED: 'false' });
    const b = configOf({});
    expect(configFingerprint(a, 'k')).toBe(configFingerprint(b, 'k'));
  });

  it('depends on the token and never contains a secret in clear', () => {
    expect(configFingerprint(base, 'other')).not.toBe(configFingerprint(base, 'k'));
    expect(configFingerprint(base, 'k')).not.toContain('hunter2');
    expect(JSON.stringify(configDigests(base, 'k'))).not.toContain('hunter2');
  });
});

describe('differingSettings', () => {
  it('names the identity settings whose digests differ', () => {
    const ours = configDigests(configOf({ FOUNDRY_WRITE_ENABLED: 'true' }), 'k');
    const theirs = configDigests(
      configOf({ FOUNDRY_WRITE_ENABLED: 'false', LOG_LEVEL: 'debug' }),
      'k',
    );
    expect(differingSettings(ours, theirs)).toEqual(['FOUNDRY_WRITE_ENABLED']);
    expect(differingSettings(ours, ours)).toEqual([]);
  });
});

describe('configFromSettings', () => {
  it('refuses settings with no FOUNDRY_URL, and names the bad setting otherwise', () => {
    const empty = {
      values: {},
      sources: Object.fromEntries(
        KNOWN_SETTINGS.map((n) => [n, 'default']),
      ) as ResolvedSettings['sources'],
      file: { path: 'C:\\cfg\\config.env', found: true, error: null, warning: null },
      dotenvPath: null,
    };
    expect(() => configFromSettings(empty)).toThrow(ConfigError);
    expect(() => configFromSettings({ ...empty, values: { FOUNDRY_URL: 'not a url' } })).toThrow(
      /FOUNDRY_URL, from the default/,
    );
  });

  it('defaults the idle timeout to 5 minutes', () => {
    expect(configOf({}).shared.idleTimeoutMinutes).toBe(5);
    expect(configOf({ FOUNDRY_MCP_IDLE_TIMEOUT_MINUTES: '0' }).shared.idleTimeoutMinutes).toBe(0);
  });
});
