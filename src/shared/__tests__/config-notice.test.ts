import { describe, expect, it } from 'vitest';
import { IgnoredConfigNotice, ignoredConfigNotice } from '../config-notice.js';

describe('ignored configuration notice', () => {
  const ignored = {
    settings: [{ name: 'FOUNDRY_WRITE_ENABLED', source: 'env' as const }],
    configFile: 'C:\\L\\foundryvtt-mcp\\config.env',
  };

  it("names the ignored settings, where they come from, and the shared process's file", () => {
    const text = ignoredConfigNotice(ignored);
    expect(text).toContain("This MCP client's own settings are ignored");
    expect(text).toContain("FOUNDRY_WRITE_ENABLED from this client's env block");
    expect(text).toContain('(C:\\L\\foundryvtt-mcp\\config.env)');
    expect(text).toContain('node dist/index.js status');
    expect(ignoredConfigNotice(null)).toBeNull();
  });

  it('is handed out once per distinct set of ignored settings', () => {
    const notice = new IgnoredConfigNotice();
    notice.connected(ignored);
    expect(notice.take()).not.toBeNull();
    expect(notice.take()).toBeNull();
    // Reconnected with the same difference: not said again.
    notice.connected(ignored);
    expect(notice.take()).toBeNull();
    // Nothing ignored any more, then ignored again: said again.
    notice.connected(null);
    notice.connected(ignored);
    expect(notice.take()).not.toBeNull();
  });
});
