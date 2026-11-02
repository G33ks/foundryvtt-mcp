import { afterEach, describe, expect, it, vi } from 'vitest';

// A configuration that cannot be resolved yet: reading it throws (ConfigError).
let usable = false;
vi.mock('../../config/index.js', () => ({
  config: {
    get logLevel() {
      if (!usable) {
        throw new Error('FoundryVTT MCP is not configured: FOUNDRY_URL is not set.');
      }
      return 'warn';
    },
  },
}));

const { Logger, logger } = await import('../logger.js');

afterEach(() => {
  vi.restoreAllMocks();
  usable = false;
});

describe('logger without a usable configuration', () => {
  it('neither throws nor exits, and logs at info meanwhile', () => {
    const write = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    expect(() => logger.info('starting without configuration')).not.toThrow();
    logger.debug('hidden at info');

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toContain('INFO: starting without configuration');
    expect(exit).not.toHaveBeenCalled();
  });

  it('takes the configured level as soon as it can be resolved', () => {
    const lines: string[] = [];
    const capture = (line: unknown) => {
      lines.push(String(line));
    };
    vi.spyOn(console, 'error').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    let level: 'warn' | null = null;
    const local = new Logger(() => level);
    local.info('shown at the default level');
    level = 'warn';
    local.info('hidden at warn');
    local.warn('shown at warn');
    expect(lines.map((line) => line.replace(/^\[[^\]]+\] /, ''))).toEqual([
      'INFO: shown at the default level',
      'WARN: shown at warn',
    ]);
  });
});
