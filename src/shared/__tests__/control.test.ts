import { describe, expect, it } from 'vitest';
import { formatStatus, formatTerminalConfig } from '../control.js';
import type { DaemonStatus } from '../protocol.js';

const BASE: DaemonStatus = {
  pid: 4242,
  version: '1.5.2+b',
  startedAt: '2026-11-01T10:00:00.000Z',
  uptimeSeconds: 65,
  endpoint: '\\\\.\\pipe\\foundryvtt-mcp-test',
  logFile: 'daemon.log',
  relays: 2,
  inFlight: 0,
  startupError: null,
  foundryConnected: true,
};

function line(status: DaemonStatus, label: string): string | undefined {
  return formatStatus(status).find((l) => l.trimStart().startsWith(`${label}:`));
}

describe('formatStatus', () => {
  it('shows the relay count alone when every relay runs the process build', () => {
    expect(line({ ...BASE, outdatedRelays: [] }, 'Relays')).toBe('  Relays:         2 connected');
  });

  it('names the relays on an older build and says to restart their client', () => {
    expect(line({ ...BASE, outdatedRelays: ['1.5.2+a'] }, 'Relays')).toBe(
      '  Relays:         2 connected (1 on an older build: v1.5.2+a — restart that client)',
    );
  });

  it('reads a shared process from before relay builds were reported', () => {
    expect(line(BASE, 'Relays')).toBe('  Relays:         2 connected');
  });

  const BRIDGE = {
    enabled: true,
    port: 31415,
    moduleConnected: false,
    protocol: 1,
    origin: 'https://foundry.example',
    moduleConnectedSince: null,
  };

  it('does not claim the bridge listens when the FoundryVTT connection failed', () => {
    const status: DaemonStatus = {
      ...BASE,
      foundryConnected: false,
      startupError: 'No active world on FoundryVTT: launch it from the Setup screen.',
      bridge: { ...BRIDGE, state: 'not-started' },
      headlessGm: {
        enabled: true,
        active: false,
        status: '⏳ Logging in…',
        launchError: null,
        state: 'not-started',
      },
    };
    expect(line(status, 'Module bridge')).toBe(
      '  Module bridge:  not started (FoundryVTT connection failed)',
    );
    expect(line(status, 'Bridge origin')).toBeUndefined();
    expect(line(status, 'Headless GM')).toBe(
      '  Headless GM:    not started (FoundryVTT connection failed)',
    );
  });

  it('shows a bridge that failed to start with its error', () => {
    const status: DaemonStatus = {
      ...BASE,
      bridge: { ...BRIDGE, state: 'failed', error: 'listen EADDRINUSE 127.0.0.1:31415' },
      headlessGm: {
        enabled: true,
        active: false,
        status: null,
        launchError: null,
        state: 'not-started',
      },
    };
    expect(line(status, 'Module bridge')).toBe(
      '  Module bridge:  failed to start — listen EADDRINUSE 127.0.0.1:31415',
    );
    expect(line(status, 'Headless GM')).toBe(
      '  Headless GM:    not started (the module bridge failed to start)',
    );
  });

  it('keeps the listening line for a running bridge', () => {
    const status: DaemonStatus = {
      ...BASE,
      bridge: { ...BRIDGE, state: 'listening' },
      headlessGm: {
        enabled: true,
        active: true,
        status: '✅ Logged in as `mcp-gm`',
        launchError: null,
        state: 'running',
      },
    };
    expect(line(status, 'Module bridge')).toBe(
      '  Module bridge:  listening on port 31415, protocol v1, authenticated module connected: no',
    );
    expect(line(status, 'Headless GM')).toBe(
      '  Headless GM:    logged in — ✅ Logged in as `mcp-gm`',
    );
  });

  it('shows the real browser launch error rather than "disabled"', () => {
    const status: DaemonStatus = {
      ...BASE,
      headlessGm: {
        enabled: true,
        active: false,
        status: null,
        launchError:
          "Could not launch the browser at FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH=C:\\b.exe: Executable doesn't exist",
      },
    };
    expect(line(status, 'Headless GM')).toBe(
      "  Headless GM:    browser launch failed — Could not launch the browser at FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH=C:\\b.exe: Executable doesn't exist",
    );
  });

  it('shows the browser of the headless GM session and where it comes from', () => {
    const headlessGm = {
      enabled: true,
      active: true,
      status: 'x',
      state: 'running' as const,
      browser: { name: 'Brave', path: 'C:\\b\\brave.exe', origin: 'detected' as const },
    };
    expect(line({ ...BASE, headlessGm }, 'Browser')).toBe(
      '  Browser:        Brave — C:\\b\\brave.exe (detected)',
    );
    expect(
      line({ ...BASE, headlessGm: { ...headlessGm, browser: null } }, 'Browser'),
    ).toBeUndefined();
  });

  it('shows the shared session mode and its state', () => {
    const headlessGm = {
      enabled: true,
      status: 'x',
      state: 'running' as const,
      mode: 'shared' as const,
      modeText: "sharing the connector's session (mcp-api)",
    };
    expect(
      line(
        { ...BASE, headlessGm: { ...headlessGm, active: true, sessionState: 'logged-in' } },
        'Headless GM',
      ),
    ).toBe("  Headless GM:    logged in — sharing the connector's session (mcp-api)");
    expect(
      line(
        {
          ...BASE,
          headlessGm: { ...headlessGm, active: false, sessionState: 'waiting-for-session' },
        },
        'Headless GM',
      ),
    ).toBe("  Headless GM:    waiting-for-session — sharing the connector's session (mcp-api)");
  });

  it('says why FoundryVTT is not connected and that it retries', () => {
    const status: DaemonStatus = {
      ...BASE,
      foundryConnected: false,
      foundryConnection: {
        state: 'waiting-for-world',
        error: 'No active world on FoundryVTT: launch it from the Setup screen.',
      },
    };
    expect(line(status, 'FoundryVTT')).toBe(
      '  FoundryVTT:     not connected (waiting-for-world — No active world on FoundryVTT: launch it from the Setup screen.)',
    );
  });

  it('shows the account and a Gamemaster warning', () => {
    const status: DaemonStatus = {
      ...BASE,
      account: {
        name: 'mcp-api',
        role: 'Gamemaster',
        warning: 'Make this account an Assistant GM.',
      },
    };
    expect(line(status, 'Account')).toBe('  Account:        mcp-api (Gamemaster)');
    expect(line(status, 'Warning')).toBe('  Warning:        Make this account an Assistant GM.');
  });
});

describe('configuration in status', () => {
  const STATUS: DaemonStatus = {
    ...BASE,
    config: {
      file: { path: 'C:L\foundryvtt-mcpconfig.env', found: true, error: null, warning: null },
      settings: [
        { name: 'FOUNDRY_URL', value: 'https://foundry.example', source: 'file' },
        { name: 'FOUNDRY_PASSWORD', value: '<set>', source: 'file' },
        { name: 'LOG_LEVEL', value: 'debug', source: 'env' },
      ],
    },
    relayConfigs: [
      {
        pid: 11,
        version: '1.5.2+b',
        sources: { FOUNDRY_URL: 'file', LOG_LEVEL: 'env' },
        ignored: [],
      },
      {
        pid: 12,
        version: '1.5.2+b',
        sources: { FOUNDRY_URL: 'file', FOUNDRY_WRITE_ENABLED: 'env' },
        ignored: [{ name: 'FOUNDRY_WRITE_ENABLED', source: 'env' }],
      },
      { pid: null, version: '1.5.2+a', sources: null, ignored: null },
    ],
  };

  it("shows the shared process's file and each setting with its source", () => {
    const lines = formatStatus(STATUS);
    expect(lines).toContain('Configuration of the shared process:');
    expect(lines).toContain('  File:           C:L\foundryvtt-mcpconfig.env (found)');
    expect(lines).toContain('    FOUNDRY_PASSWORD = <set>  (file)');
    expect(lines).toContain('    LOG_LEVEL        = debug  (env)');
  });

  it('lists each relay, its provenance and its ignored settings', () => {
    const lines = formatStatus(STATUS);
    expect(lines).toContain('  Relay 11 (v1.5.2+b): 1 from file, 1 from env');
    expect(lines).toContain(
      '    served with the shared process configuration; ignored: FOUNDRY_WRITE_ENABLED (from env)',
    );
    expect(lines).toContain(
      '  Relay (pid unknown) (v1.5.2+a): an older build that does not declare its settings',
    );
    expect(lines).toContain('    served with the shared process configuration; its own differs');
  });

  it("shows this terminal's own resolution, secrets masked", () => {
    const lines = formatTerminalConfig({
      values: { FOUNDRY_URL: 'http://x', FOUNDRY_PASSWORD: 'hunter2' },
      sources: { FOUNDRY_URL: 'env', FOUNDRY_PASSWORD: '.env' } as never,
      file: { path: '/cfg/config.env', found: false, error: null, warning: null },
      dotenvPath: null,
    });
    expect(lines).toContain('This terminal (configuration resolved by this command):');
    expect(lines).toContain('  File:           /cfg/config.env (not found)');
    expect(lines.join('\n')).toContain('FOUNDRY_PASSWORD = <set>  (.env)');
    expect(lines.join('\n')).not.toContain('hunter2');
  });
});
