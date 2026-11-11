/**
 * @fileoverview Unit tests for diagnostics handlers — get_recent_logs
 * filtering plus the get_system_health / get_health_status reports.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type DiagnosticsClient, RestApiRequiredError } from '../../../diagnostics/client.js';
import type { LogEntry, SystemHealth } from '../../../diagnostics/types.js';
import { SystemHealthSchema } from '../../../diagnostics/types.js';
import type { FoundryClient } from '../../../foundry/client.js';
import type { HeadlessGmSession } from '../../../foundry/headless-gm-session.js';
import type { JournalConflict } from '../../../foundry/journal-integrity.js';
import { ModuleBridge } from '../../../foundry/module-bridge.js';
import {
  handleDiagnoseErrors,
  handleGetHealthStatus,
  handleGetRecentLogs,
  handleGetSystemHealth,
} from '../diagnostics.js';

// Minimal LogEntry factory
function makeEntry(
  level: LogEntry['level'],
  timestamp: string,
  message = 'test message',
): LogEntry {
  return { timestamp, level, message, source: 'foundry' };
}

// Build a mock DiagnosticsClient that returns a fixed log list
function mockClient(logs: LogEntry[]): DiagnosticsClient {
  return {
    getRecentLogs: vi.fn().mockResolvedValue({ logs, total: logs.length }),
  } as unknown as DiagnosticsClient;
}

// Extract log lines from the MCP response text
function extractLines(result: Awaited<ReturnType<typeof handleGetRecentLogs>>): string[] {
  const text =
    (result as { content: Array<{ type: string; text: string }> }).content[0]?.text ?? '';
  // Lines after the header block (the blank line following "Since:")
  const body = text.split('\n\n').slice(1).join('\n\n').trim();
  return body === 'No log entries found.' ? [] : body.split('\n').filter(Boolean);
}

const now = new Date('2024-06-01T12:00:00.000Z').getTime();

// Sample dataset — 10 entries spanning different levels and times
const SAMPLE_LOGS: LogEntry[] = [
  makeEntry('error', new Date(now - 9000).toISOString(), 'error msg 1'),
  makeEntry('warn', new Date(now - 8000).toISOString(), 'warn msg 1'),
  makeEntry('info', new Date(now - 7000).toISOString(), 'info msg 1'),
  makeEntry('log', new Date(now - 6000).toISOString(), 'log msg 1'),
  makeEntry('error', new Date(now - 5000).toISOString(), 'error msg 2'),
  makeEntry('warn', new Date(now - 4000).toISOString(), 'warn msg 2'),
  makeEntry('info', new Date(now - 3000).toISOString(), 'info msg 2'),
  makeEntry('error', new Date(now - 2000).toISOString(), 'error msg 3'),
  makeEntry('info', new Date(now - 1000).toISOString(), 'info msg 3'),
  makeEntry('warn', new Date(now - 500).toISOString(), 'warn msg 3'),
];

describe('handleGetRecentLogs', () => {
  describe('default behavior (no filters)', () => {
    it('returns all entries when no args supplied', async () => {
      const client = mockClient(SAMPLE_LOGS);
      const result = await handleGetRecentLogs({}, client);
      const lines = extractLines(result);
      expect(lines).toHaveLength(SAMPLE_LOGS.length);
    });
  });

  describe('limit', () => {
    it('slices to the requested limit', async () => {
      const client = mockClient(SAMPLE_LOGS);
      const result = await handleGetRecentLogs({ limit: 3 }, client);
      const lines = extractLines(result);
      expect(lines).toHaveLength(3);
    });

    it('returns all entries when limit exceeds dataset size', async () => {
      const client = mockClient(SAMPLE_LOGS);
      const result = await handleGetRecentLogs({ limit: 500 }, client);
      const lines = extractLines(result);
      expect(lines).toHaveLength(SAMPLE_LOGS.length);
    });

    it('clamps to hard upper bound of 1000', async () => {
      // Build 1100 entries
      const bigLogs = Array.from({ length: 1100 }, (_, i) =>
        makeEntry('info', new Date(now + i * 1000).toISOString(), `msg ${i}`),
      );
      const client = mockClient(bigLogs);
      const result = await handleGetRecentLogs({ limit: 9999 }, client);
      const lines = extractLines(result);
      expect(lines).toHaveLength(1000);
    });
  });

  describe('level filter', () => {
    it('returns only error entries when level is "error"', async () => {
      const client = mockClient(SAMPLE_LOGS);
      const result = await handleGetRecentLogs({ level: 'error' }, client);
      const lines = extractLines(result);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toMatch(/\*\*ERROR\*\*/);
      }
    });

    it('returns only warn entries when level is "warn"', async () => {
      const client = mockClient(SAMPLE_LOGS);
      const result = await handleGetRecentLogs({ level: 'warn' }, client);
      const lines = extractLines(result);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toMatch(/\*\*WARN\*\*/);
      }
    });

    it('handles level as array, returning only matching entries', async () => {
      const client = mockClient(SAMPLE_LOGS);
      const result = await handleGetRecentLogs({ level: ['error', 'warn'] }, client);
      const lines = extractLines(result);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toMatch(/\*\*(ERROR|WARN)\*\*/);
      }
    });

    it('ignores unrecognized level and returns all entries', async () => {
      const client = mockClient(SAMPLE_LOGS);
      const result = await handleGetRecentLogs({ level: 'bogus' }, client);
      const lines = extractLines(result);
      // unrecognized level → no filter applied → all entries returned (up to default limit 20)
      expect(lines).toHaveLength(SAMPLE_LOGS.length);
    });

    it('does not throw when level is unrecognized', async () => {
      const client = mockClient(SAMPLE_LOGS);
      await expect(handleGetRecentLogs({ level: 'INVALID_LEVEL' }, client)).resolves.toBeDefined();
    });
  });

  describe('since filter', () => {
    it('returns empty array when since is a future timestamp', async () => {
      const futureTimestamp = new Date(now + 99_999_000).toISOString();
      const client = mockClient(SAMPLE_LOGS);
      const result = await handleGetRecentLogs({ since: futureTimestamp }, client);
      const lines = extractLines(result);
      expect(lines).toHaveLength(0);
    });

    it('returns only entries at or after the since timestamp', async () => {
      // Only the last 3 entries are within -3000ms of now
      const sinceTimestamp = new Date(now - 3000).toISOString();
      const client = mockClient(SAMPLE_LOGS);
      const result = await handleGetRecentLogs({ since: sinceTimestamp }, client);
      const lines = extractLines(result);
      // entries at -3000, -2000, -1000, -500 should pass (timestamp >= since)
      expect(lines.length).toBeGreaterThanOrEqual(1);
      // none of the earlier entries should appear
      for (const line of lines) {
        const match = line.match(/\[([^\]]+)\]/);
        if (match?.[1]) {
          const entryMs = Date.parse(match[1]);
          expect(entryMs).toBeGreaterThanOrEqual(Date.parse(sinceTimestamp));
        }
      }
    });

    it('ignores unparseable since and returns all entries', async () => {
      const client = mockClient(SAMPLE_LOGS);
      const result = await handleGetRecentLogs({ since: 'not-a-date' }, client);
      const lines = extractLines(result);
      expect(lines).toHaveLength(SAMPLE_LOGS.length);
    });

    it('does not throw when since is unparseable', async () => {
      const client = mockClient(SAMPLE_LOGS);
      await expect(handleGetRecentLogs({ since: '!!invalid!!' }, client)).resolves.toBeDefined();
    });
  });

  describe('combined filters', () => {
    it('applies level and limit together', async () => {
      const client = mockClient(SAMPLE_LOGS);
      const result = await handleGetRecentLogs({ level: 'error', limit: 2 }, client);
      const lines = extractLines(result);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line).toMatch(/\*\*ERROR\*\*/);
      }
    });

    it('applies since and level together', async () => {
      // Only errors at or after -5000ms
      const sinceTimestamp = new Date(now - 5000).toISOString();
      const client = mockClient(SAMPLE_LOGS);
      const result = await handleGetRecentLogs({ level: 'error', since: sinceTimestamp }, client);
      const lines = extractLines(result);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toMatch(/\*\*ERROR\*\*/);
      }
    });
  });

  describe('empty source', () => {
    it('returns "No log entries found." when source has no logs', async () => {
      const client = mockClient([]);
      const result = await handleGetRecentLogs({}, client);
      const text =
        (result as { content: Array<{ type: string; text: string }> }).content[0]?.text ?? '';
      expect(text).toContain('No log entries found.');
    });
  });
});

// ============================================================================
// System health handlers (laurigates/foundryvtt-mcp#216)
//
// `SystemHealthSchema.parse()` strips unknown keys, so the fixtures below are
// deliberately run through the real schema: anything the handlers read must be
// a field the schema actually declares, or it will be `undefined` here just as
// it is in production.
// ============================================================================

function makeHealth(overrides: Record<string, unknown> = {}): SystemHealth {
  return SystemHealthSchema.parse({
    timestamp: '2024-06-01T12:00:00.000Z',
    server: {
      foundryVersion: '12.331',
      systemVersion: 'dnd5e 3.3.1',
      worldId: 'test-world',
      uptime: 7320, // 2h 2m
    },
    users: { total: 5, active: 3, gm: 1 },
    modules: { total: 50, active: 35 },
    performance: {
      memory: {
        rss: 209_715_200, // 200 MB
        heapTotal: 67_108_864, // 64 MB
        heapUsed: 47_185_920, // 45 MB
        external: 1_048_576,
        arrayBuffers: 524_288,
      },
      connectedClients: 3,
    },
    logs: { bufferSize: 500, recentErrors: 2, recentWarnings: 5, errorRate: 0.1 },
    status: 'healthy',
    ...overrides,
  });
}

function healthClient(health: SystemHealth): DiagnosticsClient {
  return {
    getSystemHealth: vi.fn().mockResolvedValue(health),
  } as unknown as DiagnosticsClient;
}

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('handleGetSystemHealth', () => {
  it('renders the nested values the schema actually defines', async () => {
    const text = getText(await handleGetSystemHealth({}, healthClient(makeHealth())));

    expect(text).toContain('**Overall Status:** healthy');
    expect(text).toContain('**Reported At:** 2024-06-01T12:00:00.000Z');
    // server.*
    expect(text).toContain('12.331');
    expect(text).toContain('dnd5e 3.3.1');
    expect(text).toContain('test-world');
    expect(text).toContain('**Uptime:** 2h 2m');
    // users.* / modules.*
    expect(text).toContain('3 active / 5 total');
    expect(text).toContain('1 GM');
    expect(text).toContain('35 active / 50 installed');
    // performance.*
    expect(text).toContain('**Connected Clients:** 3');
    expect(text).toContain('45 MB used / 64 MB total');
    expect(text).toContain('200 MB');
    // logs.*
    expect(text).toContain('**Recent Errors:** 2');
    expect(text).toContain('**Recent Warnings:** 5');
    expect(text).toContain('**Buffer:** 500 entries');
    expect(text).toContain('**Error Rate:** 0.1%');
  });

  it('renders no "N/A" placeholders for a fully populated payload', async () => {
    const text = getText(await handleGetSystemHealth({}, healthClient(makeHealth())));
    expect(text).not.toContain('N/A');
  });

  it('drops metrics the diagnostics schema has no field for', async () => {
    const text = getText(await handleGetSystemHealth({}, healthClient(makeHealth())));

    // No CPU/disk/throughput/response-time field exists anywhere in SystemHealthSchema
    expect(text).not.toMatch(/CPU/i);
    expect(text).not.toMatch(/Disk/i);
    expect(text).not.toMatch(/Throughput/i);
    expect(text).not.toMatch(/Response Time/i);
  });

  it('omits optional server uptime rather than printing a placeholder', async () => {
    const health = makeHealth({
      server: { foundryVersion: '12.331', systemVersion: 'dnd5e 3.3.1', worldId: 'test-world' },
    });

    const text = getText(await handleGetSystemHealth({}, healthClient(health)));

    expect(text).not.toContain('**Uptime:**');
    expect(text).not.toContain('N/A');
    expect(text).toContain('**Overall Status:** healthy');
  });

  it('omits memory lines when performance.memory is absent', async () => {
    const health = makeHealth({ performance: { connectedClients: 7 } });

    const text = getText(await handleGetSystemHealth({}, healthClient(health)));

    expect(text).toContain('**Connected Clients:** 7');
    expect(text).not.toContain('MB');
    expect(text).not.toContain('N/A');
  });

  it('reports a critical status verbatim', async () => {
    const text = getText(
      await handleGetSystemHealth({}, healthClient(makeHealth({ status: 'critical' }))),
    );
    expect(text).toContain('**Overall Status:** critical');
  });
});

describe('handleGetHealthStatus', () => {
  function worldClient(
    connected: boolean,
    stale = false,
    conflicts: JournalConflict[] = [],
  ): FoundryClient {
    return {
      isConnected: () => connected,
      isReconnecting: () => false,
      connectionStatus: () => ({ state: connected ? 'connected' : 'disconnected', error: null }),
      accountInfo: () => null,
      activeGameMaster: () => null,
      isWorldDataStale: () => stale,
      getRecentJournalConflicts: () => conflicts,
      getJournalHistoryDir: () => '/state/journal-history',
      getWorldInfo: vi.fn().mockResolvedValue({
        id: 'test-world',
        title: 'Test World',
        description: '',
        system: 'dnd5e',
        coreVersion: '12.331',
        systemVersion: '3.3.1',
        playtime: 0,
        created: '2024-01-01T00:00:00.000Z',
        modified: '2024-06-01T00:00:00.000Z',
      }),
    } as unknown as FoundryClient;
  }

  it('renders real world and system-health values, not placeholders', async () => {
    const text = getText(
      await handleGetHealthStatus({}, worldClient(true), healthClient(makeHealth())),
    );

    expect(text).toContain('✅ Connected');
    expect(text).toContain('**Title:** Test World');
    expect(text).toContain('**System:** dnd5e');
    expect(text).toContain('**Core Version:** 12.331');
    expect(text).toContain('**Status:** healthy');
    expect(text).toContain('**Uptime:** 2h 2m');
    expect(text).toContain('3 active / 5 total');
    expect(text).toContain('45 MB');
    expect(text).toContain('**Recent Errors:** 2');
    expect(text).not.toContain('N/A');
  });

  it('drops the unbacked CPU and playtime lines', async () => {
    const text = getText(
      await handleGetHealthStatus({}, worldClient(true), healthClient(makeHealth())),
    );

    expect(text).not.toMatch(/CPU/i);
    expect(text).not.toMatch(/Playtime/i);
  });

  it('degrades gracefully when system health is unavailable', async () => {
    const failing = {
      getSystemHealth: vi.fn().mockRejectedValue(new Error('no REST module')),
    } as unknown as DiagnosticsClient;

    const text = getText(await handleGetHealthStatus({}, worldClient(false), failing));

    expect(text).toContain('❌ Disconnected');
    expect(text).toContain('**Title:** Test World');
    expect(text).toContain('ℹ️ Not available');
  });

  it('says system health needs the REST API module when no key is set', async () => {
    const noKey = {
      getSystemHealth: vi
        .fn()
        .mockRejectedValue(
          new RestApiRequiredError(
            'System health requires the REST API module (FOUNDRY_API_KEY is not set)',
          ),
        ),
    } as unknown as DiagnosticsClient;

    const text = getText(await handleGetHealthStatus({}, worldClient(true), noKey));

    expect(text).toContain(
      'ℹ️ System health requires the REST API module (FOUNDRY_API_KEY is not set)',
    );
  });

  it('shows the connector account, the active GM and the Gamemaster warning', async () => {
    const client = {
      ...worldClient(true),
      accountInfo: () => ({ userId: 'u', name: 'mcp-api', role: 4 }),
      activeGameMaster: () => ({ userId: 'u', name: 'mcp-api', role: 4 }),
    } as unknown as FoundryClient;

    const text = getText(
      await handleGetHealthStatus({}, client, healthClient(makeHealth()), null, null, {
        sharedAccount: true,
      }),
    );

    expect(text).toContain('**Connector Account:**');
    expect(text).toContain('- **Name:** mcp-api (Gamemaster)');
    expect(text).toContain(
      "- **Active GM (as FoundryVTT's clients elect it):** mcp-api (Gamemaster)",
    );
    expect(text).toMatch(/⚠️ The connector's account "mcp-api" is a Gamemaster/);
  });

  it('says the connection is being restored and why', async () => {
    const client = {
      ...worldClient(false),
      isReconnecting: () => true,
      connectionStatus: () => ({ state: 'waiting-for-world', error: 'No active world' }),
    } as unknown as FoundryClient;

    const text = getText(await handleGetHealthStatus({}, client, healthClient(makeHealth())));

    expect(text).toContain(
      '❌ Disconnected — waiting-for-world: No active world (retrying on its own)',
    );
  });

  it('shows the configuration file and where the settings come from', async () => {
    const text = getText(
      await handleGetHealthStatus({}, worldClient(true), healthClient(makeHealth()), null, null, {
        configuration: { file: 'C:Lconfig.env (found)', sources: '15 from file, 1 from env' },
      }),
    );
    expect(text).toContain('**Configuration:**');
    expect(text).toContain('- **File:** C:Lconfig.env (found)');
    expect(text).toContain('- **Settings:** 15 from file, 1 from env');
  });

  it('degrades gracefully when world info is unavailable', async () => {
    const failingWorld = {
      isConnected: () => false,
      isReconnecting: () => false,
      connectionStatus: () => ({ state: 'disconnected', error: null }),
      accountInfo: () => null,
      activeGameMaster: () => null,
      isWorldDataStale: () => false,
      getRecentJournalConflicts: () => [],
      getJournalHistoryDir: () => '/state/journal-history',
      getWorldInfo: vi.fn().mockRejectedValue(new Error('not connected')),
    } as unknown as FoundryClient;

    const text = getText(await handleGetHealthStatus({}, failingWorld, healthClient(makeHealth())));

    expect(text).toContain('ℹ️ Not available');
    expect(text).toContain('**Status:** healthy');
  });

  /**
   * laurigates/foundryvtt-mcp#217's second impact bullet: after the socket drops, reads keep being
   * served from the cache. Rendering that snapshot with no marker presents a
   * point-in-time copy as though it were live — and after an automatic
   * reconnect the connection line reads "✅ Connected" again while the cache is
   * still missing every broadcast from the outage.
   */
  it('marks the world section stale when the cache is no longer being kept live', async () => {
    const text = getText(
      await handleGetHealthStatus({}, worldClient(true, true), healthClient(makeHealth())),
    );

    expect(text).toMatch(/stale/i);
    expect(text).toContain('refresh_world_data');
    // Still rendered — a flagged answer beats no answer.
    expect(text).toContain('**Title:** Test World');
  });

  it('has no shared-process section in the all-in-one mode', async () => {
    const text = getText(
      await handleGetHealthStatus({}, worldClient(true), healthClient(makeHealth())),
    );
    expect(text).not.toContain('**Shared Process:**');
  });

  it('lists the relays and asks to restart the clients on an older build', async () => {
    const text = getText(
      await handleGetHealthStatus({}, worldClient(true), healthClient(makeHealth()), null, null, {
        relays: { connected: 2, outdated: ['1.5.2+a'] },
      }),
    );
    expect(text).toContain('**Shared Process:**');
    expect(text).toContain('**Relays:** 2 connected');
    expect(text).toMatch(/1 on an older connector build \(v1\.5\.2\+a\).*restart them/);
  });

  it('leaves the world section unmarked while the cache is live', async () => {
    const text = getText(
      await handleGetHealthStatus({}, worldClient(true), healthClient(makeHealth())),
    );

    expect(text).not.toMatch(/stale/i);
    expect(text).not.toContain('refresh_world_data');
  });

  it('omits the Module Bridge section entirely when no bridge is configured', async () => {
    const text = getText(
      await handleGetHealthStatus({}, worldClient(true), healthClient(makeHealth())),
    );

    expect(text).not.toContain('Module Bridge');
  });

  it('reports the bridge connected, with the version the module announced', async () => {
    const bridge = {
      isConnected: () => true,
      describeModuleVersion: () => '0.6.0',
    } as unknown as ModuleBridge;

    const text = getText(
      await handleGetHealthStatus({}, worldClient(true), healthClient(makeHealth()), bridge),
    );

    expect(text).toContain('**Module Bridge:**');
    expect(text).toContain('✅ Connected — authenticated module 0.6.0 (protocol v1)');
  });

  it('reports the installed version of a module that announces none', async () => {
    const bridge = new ModuleBridge(0, {
      expectedOrigin: 'http://localhost:30000',
      installedModuleVersion: () => '0.5.2',
    });
    vi.spyOn(bridge, 'isConnected').mockReturnValue(true);

    const text = getText(
      await handleGetHealthStatus({}, worldClient(true), healthClient(makeHealth()), bridge),
    );

    expect(text).toContain(
      '✅ Connected — authenticated module 0.5.2 (not announced) (protocol v1)',
    );
  });

  it('surfaces the headless GM session status when the bridge has no module connected', async () => {
    const bridge = { isConnected: () => false } as unknown as ModuleBridge;
    const headlessSession = {
      statusText: () => '⏳ Not connected yet — no user named "mcp-api" in the join list',
      browserInfo: () => ({ name: 'Brave', path: 'C:\\b\\brave.exe', origin: 'detected' }),
    } as unknown as HeadlessGmSession;

    const text = getText(
      await handleGetHealthStatus(
        {},
        worldClient(true),
        healthClient(makeHealth()),
        bridge,
        headlessSession,
      ),
    );

    expect(text).toContain('❌ Not connected');
    expect(text).toContain('**Headless GM Session:**');
    expect(text).toContain('no user named "mcp-api"');
    expect(text).toContain('- **Browser:** Brave — C:\\b\\brave.exe (detected)');
  });

  it('explains the module needs the headless session when none is configured', async () => {
    const bridge = { isConnected: () => false } as unknown as ModuleBridge;

    const text = getText(
      await handleGetHealthStatus({}, worldClient(true), healthClient(makeHealth()), bridge),
    );

    expect(text).toContain('❌ Not connected');
    expect(text).toContain('FOUNDRY_HEADLESS_GM_ENABLED');
    expect(text).toContain('no longer supported');
  });

  it('says the bridge has not started while the FoundryVTT connection is down', async () => {
    const bridge = { isConnected: () => false } as unknown as ModuleBridge;
    const text = getText(
      await handleGetHealthStatus(
        {},
        worldClient(false),
        healthClient(makeHealth()),
        bridge,
        null,
        {
          bridgeState: 'not-started',
        },
      ),
    );
    expect(text).toContain('**Module Bridge:**');
    expect(text).toContain('Not started — it starts once the FoundryVTT connection is up');
    expect(text).not.toContain('Logging in');
  });

  it('shows a bridge that failed to start, even though it was dropped', async () => {
    const text = getText(
      await handleGetHealthStatus({}, worldClient(true), healthClient(makeHealth()), null, null, {
        bridgeState: 'failed',
        bridgeError: 'listen EADDRINUSE 127.0.0.1:31415',
      }),
    );
    expect(text).toContain('❌ Failed to start — listen EADDRINUSE 127.0.0.1:31415');
  });

  it('shows the real browser launch error instead of configuration advice', async () => {
    const bridge = { isConnected: () => false } as unknown as ModuleBridge;

    const text = getText(
      await handleGetHealthStatus({}, worldClient(true), healthClient(makeHealth()), bridge, null, {
        headlessLaunchError:
          'Could not launch the browser at FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH=x',
      }),
    );

    expect(text).toContain('could not be launched');
    expect(text).toContain('FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH=x');
    expect(text).not.toContain('FOUNDRY_HEADLESS_GM_ENABLED');
  });

  it('reports no journal overwrite and where the local copies are', async () => {
    const text = getText(
      await handleGetHealthStatus({}, worldClient(true), healthClient(makeHealth())),
    );
    expect(text).toContain('**Journal Integrity:**');
    expect(text).toContain('✅ No overwrite detected in the last 24 hours');
    expect(text).toContain('**Local copies:** /state/journal-history');
  });

  it('lists the journal overwrites of the last 24 hours', async () => {
    const conflict: JournalConflict = {
      at: Date.parse('2026-11-01T20:00:00.000Z'),
      journalId: '0123456789abcdef',
      pageId: 'fedcba9876543210',
      journalName: 'Session 11',
      pageName: 'Recap',
      reason: 'overwritten-by-editor-autosave',
      savedBy: null,
      historyPath: '/state/journal-history/a.html',
    };
    const text = getText(
      await handleGetHealthStatus(
        {},
        worldClient(true, false, [conflict]),
        healthClient(makeHealth()),
      ),
    );
    expect(text).toContain('⚠️ 1 overwrite(s) detected in the last 24 hours:');
    expect(text).toContain(
      '- 2026-11-01T20:00:00.000Z — "Recap" of "Session 11" (0123456789abcdef/fedcba9876543210), overwritten-by-editor-autosave; copy: /state/journal-history/a.html (copy missing)',
    );
  });

  it('gives the path of a local copy that is still there, without a note', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fvtt-mcp-health-copy-'));
    const copy = path.join(dir, 'a.html');
    writeFileSync(copy, '<p>x</p>');
    const conflict: JournalConflict = {
      at: Date.parse('2026-11-01T20:00:00.000Z'),
      journalId: '0123456789abcdef',
      pageId: 'fedcba9876543210',
      journalName: 'Session 11',
      pageName: 'Recap',
      reason: 'overwritten-by-Alice',
      savedBy: 'Alice',
      historyPath: copy,
    };
    try {
      const text = getText(
        await handleGetHealthStatus(
          {},
          worldClient(true, false, [conflict]),
          healthClient(makeHealth()),
        ),
      );
      expect(text).toContain(`overwritten-by-Alice; copy: ${copy}`);
      expect(text).not.toContain('(copy missing)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('handleDiagnoseErrors', () => {
  it('renders diagnosis summary, categories, sorted suggestions, and errors', async () => {
    const mockDiagClient = {
      diagnoseErrors: vi.fn().mockResolvedValue({
        timestamp: '2024-06-01T12:00:00.000Z',
        timeframe: '3600',
        summary: {
          totalErrors: 5,
          uniqueErrors: 2,
          categories: { socket: 3, database: 2 },
        },
        recentErrors: [
          {
            timestamp: '2024-06-01T11:55:00.000Z',
            level: 'error',
            message: 'Socket drop',
            source: 'foundry',
          },
        ],
        suggestions: [
          { category: 'socket', suggestion: 'Check network cable', priority: 'critical' },
          { category: 'database', suggestion: 'Optimize query', priority: 'medium' },
        ],
        healthScore: 85,
      }),
    } as unknown as DiagnosticsClient;

    const text = getText(await handleDiagnoseErrors({ timeframe: 3600 }, mockDiagClient));
    expect(text).toContain('Health Score:** 85/100');
    expect(text).toContain('Total Errors:** 5');
    expect(text).toContain('**socket:** 3 error(s)');
    expect(text).toContain('[CRITICAL] **socket:** Check network cable');
    expect(text).toContain('Socket drop');
  });

  it('filters by category when requested', async () => {
    const mockDiagClient = {
      diagnoseErrors: vi.fn().mockResolvedValue({
        summary: {
          totalErrors: 5,
          uniqueErrors: 2,
          categories: { socket: 3, database: 2 },
        },
        suggestions: [],
        recentErrors: [],
        healthScore: 85,
      }),
    } as unknown as DiagnosticsClient;

    const text = getText(await handleDiagnoseErrors({ category: 'socket' }, mockDiagClient));
    expect(text).toContain('**socket:** 3 error(s)');
    expect(text).not.toContain('database');
  });
});
