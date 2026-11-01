import { describe, expect, it } from 'vitest';
import { formatStatus } from '../control.js';
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
      '  Headless GM:    logged in (✅ Logged in as `mcp-gm`)',
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
});
