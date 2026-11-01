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
