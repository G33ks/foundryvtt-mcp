import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../foundry/client.js';
import { DiagnosticSystem, type HealthReport } from '../diagnostics.js';

const REPO = 'https://github.com/G33ks/foundryvtt-mcp';

function offlineReport(): HealthReport {
  return {
    connectivity: {
      status: 'offline',
      emoji: '❌',
      details: 'Cannot reach http://localhost:30000',
    },
    authentication: { method: 'none', status: 'untested', emoji: '❓' },
    features: {
      diceRolling: false,
      actorSearch: false,
      itemSearch: false,
      sceneData: false,
      diagnostics: false,
    },
    restApiAvailable: false,
    websocketAvailable: false,
  };
}

function fakeClient(overrides: Record<string, unknown>): FoundryClient {
  return {
    testConnection: vi.fn().mockResolvedValue(true),
    get: vi.fn().mockRejectedValue(new Error('no REST')),
    connect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    ...overrides,
  } as unknown as FoundryClient;
}

describe('DiagnosticSystem', () => {
  it('points an offline report at the configuration file and init --check, not a .env', () => {
    const text = new DiagnosticSystem(fakeClient({})).formatHealthReport(offlineReport());

    expect(text).not.toContain('.env');
    expect(text).toContain('configuration file');
    expect(text).toContain('init --check');
    expect(text).not.toContain('laurigates');
  });

  it('links the connectivity diagnostic to this repository', async () => {
    const system = new DiagnosticSystem(
      fakeClient({ testConnection: vi.fn().mockResolvedValue(false) }),
    );

    const result = await system.diagnoseFeatureProblem('actors');

    expect(result.documentationUrl).toBe(`${REPO}/blob/main/TROUBLESHOOTING.md#connection-issues`);
  });

  it('tells the REST diagnostic to set the key in the configuration file', async () => {
    const result = await new DiagnosticSystem(fakeClient({})).diagnoseFeatureProblem('actors');

    expect(result.suggestions).not.toContain('.env');
    expect(result.suggestions).toContain('configuration file');
    expect(result.documentationUrl).toBe(
      `${REPO}/blob/main/docs/guides/configuration.md#optional-diagnostics-tools`,
    );
  });

  it('links the empty-results diagnostic to an existing anchor', async () => {
    const result = await new DiagnosticSystem(fakeClient({})).diagnoseFeatureProblem('scenes');

    expect(result.documentationUrl).toBe(
      `${REPO}/blob/main/TROUBLESHOOTING.md#empty-search-results`,
    );
  });
});
