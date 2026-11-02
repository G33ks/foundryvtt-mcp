import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultStateDir } from '../../shared/paths.js';
import { isWindowsSystemDir, processSettings } from '../env-layers.js';
import {
  configFilePath,
  displayValue,
  missingConfigMessage,
  resolveSettings,
  summarizeSources,
} from '../sources.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fvtt-mcp-config-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('configFilePath', () => {
  it('lives in the state directory on Windows', () => {
    expect(configFilePath({ LOCALAPPDATA: 'C:\\L' }, 'win32')).toBe(
      path.join('C:\\L', 'foundryvtt-mcp', 'config.env'),
    );
  });

  it('follows XDG_CONFIG_HOME on macOS and Linux, else ~/.config', () => {
    expect(configFilePath({ XDG_CONFIG_HOME: '/xdg' }, 'linux')).toBe(
      path.join('/xdg', 'foundryvtt-mcp', 'config.env'),
    );
    expect(configFilePath({}, 'darwin')).toBe(
      path.join(os.homedir(), '.config', 'foundryvtt-mcp', 'config.env'),
    );
  });

  it('moves into FOUNDRY_MCP_STATE_DIR when it is set', () => {
    expect(
      configFilePath({ FOUNDRY_MCP_STATE_DIR: '/iso', XDG_CONFIG_HOME: '/xdg' }, 'linux'),
    ).toBe(path.join(path.resolve('/iso'), 'config.env'));
  });

  it('is FOUNDRY_MCP_CONFIG above all', () => {
    expect(
      configFilePath(
        { FOUNDRY_MCP_CONFIG: '/elsewhere/my.env', FOUNDRY_MCP_STATE_DIR: '/iso' },
        'win32',
      ),
    ).toBe(path.resolve('/elsewhere/my.env'));
  });
});

/** A working directory with `.env` and a configuration file. */
function fixture(dotenv: string | null, file: string | null) {
  const cwd = tempDir();
  if (dotenv !== null) {
    writeFileSync(path.join(cwd, '.env'), dotenv);
  }
  const configFile = path.join(tempDir(), 'config.env');
  if (file !== null) {
    writeFileSync(configFile, file);
  }
  return { cwd, configFile };
}

describe('resolveSettings', () => {
  it('takes each setting from the first layer that defines it: env, .env, file, default', () => {
    const { cwd, configFile } = fixture(
      'FOUNDRY_USERNAME=from-dotenv\nFOUNDRY_WRITE_ENABLED=false\n',
      "FOUNDRY_URL=https://file.example\nFOUNDRY_USERNAME=from-file\nFOUNDRY_PASSWORD='p#ss'\nFOUNDRY_WRITE_ENABLED=true\nLOG_LEVEL=debug\n",
    );
    const settings = resolveSettings({
      env: { FOUNDRY_MCP_CONFIG: configFile, LOG_LEVEL: 'warn' },
      cwd,
      platform: 'linux',
    });

    expect(settings.values).toMatchObject({
      FOUNDRY_URL: 'https://file.example',
      FOUNDRY_USERNAME: 'from-dotenv',
      FOUNDRY_PASSWORD: 'p#ss',
      FOUNDRY_WRITE_ENABLED: 'false',
      LOG_LEVEL: 'warn',
    });
    expect(settings.sources).toMatchObject({
      FOUNDRY_URL: 'file',
      FOUNDRY_USERNAME: '.env',
      FOUNDRY_PASSWORD: 'file',
      FOUNDRY_WRITE_ENABLED: '.env',
      LOG_LEVEL: 'env',
      FOUNDRY_API_KEY: 'default',
    });
    expect(settings.file).toMatchObject({ path: configFile, found: true, error: null });
    expect(settings.dotenvPath).toBe(path.join(cwd, '.env'));
  });

  it('reads the file alone when asked (the shared process re-checking it)', () => {
    const { cwd, configFile } = fixture(
      'FOUNDRY_USERNAME=from-dotenv\n',
      'FOUNDRY_USERNAME=from-file\n',
    );
    const settings = resolveSettings({
      env: { FOUNDRY_MCP_CONFIG: configFile, FOUNDRY_URL: 'http://env' },
      cwd,
      platform: 'linux',
      fileOnly: true,
    });
    expect(settings.values).toEqual({ FOUNDRY_USERNAME: 'from-file' });
    expect(settings.sources.FOUNDRY_URL).toBe('default');
  });

  it('treats a missing file as no settings, and an unreadable one as an error', () => {
    const { cwd, configFile } = fixture(null, null);
    const missing = resolveSettings({
      env: { FOUNDRY_MCP_CONFIG: configFile },
      cwd,
      platform: 'linux',
    });
    expect(missing.file).toMatchObject({ found: false, error: null });

    const directory = path.join(tempDir(), 'config.env');
    mkdirSync(directory);
    const unreadable = resolveSettings({
      env: { FOUNDRY_MCP_CONFIG: directory },
      cwd,
      platform: 'linux',
    });
    expect(unreadable.file.error).toMatch(/cannot read the configuration file/);
  });

  it('warns when others than its owner may read the file (macOS/Linux only)', () => {
    const { cwd, configFile } = fixture(null, 'FOUNDRY_URL=http://x\n');
    // Windows reports every file as 0o666: the check reads as "readable by others".
    const linux = resolveSettings({
      env: { FOUNDRY_MCP_CONFIG: configFile },
      cwd,
      platform: 'linux',
    });
    if (process.platform === 'win32') {
      expect(linux.file.warning).toMatch(/chmod 600/);
    }
    const windows = resolveSettings({
      env: { FOUNDRY_MCP_CONFIG: configFile },
      cwd,
      platform: 'win32',
    });
    expect(windows.file.warning).toBeNull();
  });

  it('ignores a .env in C:\\Windows\\System32 (where Claude desktop starts servers)', () => {
    expect(
      isWindowsSystemDir('C:\\Windows\\System32', 'win32', { SystemRoot: 'C:\\Windows' }),
    ).toBe(true);
    expect(isWindowsSystemDir('C:\\work', 'win32', { SystemRoot: 'C:\\Windows' })).toBe(false);
    expect(isWindowsSystemDir('/Windows/System32', 'linux', {})).toBe(false);
  });
});

describe('a development .env', () => {
  it('still sets FOUNDRY_MCP_STATE_DIR, and so moves the state and the configuration file', () => {
    const { cwd } = fixture('FOUNDRY_MCP_STATE_DIR=/dev-state\n', null);
    const layered = processSettings({}, cwd, 'win32');
    expect(defaultStateDir('win32', layered)).toBe(path.resolve('/dev-state'));
    expect(configFilePath(layered, 'win32')).toBe(
      path.join(path.resolve('/dev-state'), 'config.env'),
    );
  });

  it('is under the environment', () => {
    const { cwd } = fixture('FOUNDRY_MCP_STATE_DIR=/dev-state\n', null);
    expect(
      processSettings({ FOUNDRY_MCP_STATE_DIR: '/env-state' }, cwd, 'linux').FOUNDRY_MCP_STATE_DIR,
    ).toBe('/env-state');
  });
});

describe('display helpers', () => {
  it('masks secrets', () => {
    expect(displayValue('FOUNDRY_PASSWORD', 'hunter2')).toBe('<set>');
    expect(displayValue('FOUNDRY_HEADLESS_GM_PASSWORD', 'x')).toBe('<set>');
    expect(displayValue('FOUNDRY_API_KEY', 'k')).toBe('<set>');
    expect(displayValue('FOUNDRY_USERNAME', 'mcp-api')).toBe('mcp-api');
  });

  it('summarizes provenance', () => {
    expect(summarizeSources({ A: 'file', B: 'file', C: 'env', D: 'default' })).toBe(
      '2 from file, 1 from env',
    );
    expect(summarizeSources({ A: 'default' })).toBe('nothing set (defaults only)');
  });

  it('says where the file is expected and what it needs, without the old setup wizard', () => {
    const { cwd, configFile } = fixture(null, null);
    const settings = resolveSettings({
      env: { FOUNDRY_MCP_CONFIG: configFile },
      cwd,
      platform: 'linux',
    });
    const message = missingConfigMessage(settings, 'FOUNDRY_URL is not set.');
    expect(message).toContain(`${configFile} (this file does not exist yet)`);
    expect(message).toContain('FOUNDRY_URL=');
    expect(message).toContain('FOUNDRY_USERNAME=');
    expect(message).toContain('FOUNDRY_PASSWORD=');
    expect(message).toContain('SETUP_GUIDE.md');
    expect(message).not.toMatch(/npm run setup|wizard/i);
  });
});
