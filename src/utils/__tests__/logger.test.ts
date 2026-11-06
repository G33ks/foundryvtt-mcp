import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

// Mock the config module before importing logger
vi.mock('../../config/index.js', () => ({
  config: {
    logLevel: 'info',
  },
}));

const { Logger } = await import('../logger.js');

type ConsoleMethod = 'log' | 'debug' | 'info' | 'warn' | 'error';

describe('Logger', () => {
  let consoleSpy: Record<ConsoleMethod, MockInstance>;

  beforeEach(() => {
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Lines written, without their timestamp. */
  const written = (method: ConsoleMethod) =>
    consoleSpy[method].mock.calls.map(([line]) => String(line).replace(/^\[[^\]]+\] /, ''));

  describe('stdout stays free for the MCP protocol', () => {
    it('writes every level to stderr (console.error, console.warn), never to stdout', () => {
      const logger = new Logger('debug');
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(written('error')).toEqual(['DEBUG: d', 'INFO: i', 'ERROR: e']);
      expect(written('warn')).toEqual(['WARN: w']);
      expect(consoleSpy.log).not.toHaveBeenCalled();
      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.debug).not.toHaveBeenCalled();
    });
  });

  describe('log level filtering', () => {
    it('drops debug at info, keeps info', () => {
      const logger = new Logger('info');
      logger.debug('hidden');
      logger.info('shown');
      expect(written('error')).toEqual(['INFO: shown']);
    });

    it('keeps only warn and error at warn', () => {
      const logger = new Logger('warn');
      logger.info('hidden');
      logger.warn('shown');
      logger.error('also shown');
      expect(written('warn')).toEqual(['WARN: shown']);
      expect(written('error')).toEqual(['ERROR: also shown']);
    });

    it('defaults to info', () => {
      const logger = new Logger();
      logger.debug('hidden');
      logger.info('shown');
      expect(written('error')).toEqual(['INFO: shown']);
    });

    it('follows setLevel', () => {
      const logger = new Logger('info');
      logger.setLevel('debug');
      logger.debug('now shown');
      expect(written('error')).toEqual(['DEBUG: now shown']);
    });

    it('logs at info while the level cannot be resolved, then takes it once it can', () => {
      let level: 'error' | null = null;
      const resolve = vi.fn(() => level);
      const logger = new Logger(resolve);
      logger.info('shown at info meanwhile');
      level = 'error';
      logger.warn('hidden at error');
      logger.info('hidden too');
      expect(written('error')).toEqual(['INFO: shown at info meanwhile']);
      expect(written('warn')).toEqual([]);
      // Resolved once, then kept.
      const calls = resolve.mock.calls.length;
      logger.error('shown');
      expect(resolve.mock.calls.length).toBe(calls);
    });
  });

  describe('message formatting', () => {
    it('prefixes an ISO timestamp and the level', () => {
      new Logger('debug').info('test message');
      expect(String(consoleSpy.error.mock.calls[0]?.[0])).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] INFO: test message$/,
      );
    });

    it('appends metadata as JSON', () => {
      new Logger('debug').info('test message', { key: 'value', number: 42 });
      expect(written('error')).toEqual(['INFO: test message {"key":"value","number":42}']);
    });

    it('writes an Error as its message and stack', () => {
      new Logger('debug').error('test message', new Error('test error'));
      const line = written('error')[0] ?? '';
      expect(line).toContain('ERROR: test message');
      expect(line).toContain('"message":"test error"');
      expect(line).toContain('"stack"');
    });
  });

  describe('sinks', () => {
    it('hands every written line to each sink, and nothing that was filtered out', () => {
      const logger = new Logger('info');
      const sink = vi.fn();
      logger.addSink(sink);
      logger.debug('filtered');
      logger.info('kept');
      logger.warn('kept too');
      expect(sink.mock.calls.map(([line]) => String(line).replace(/^\[[^\]]+\] /, ''))).toEqual([
        'INFO: kept',
        'WARN: kept too',
      ]);
    });
  });
});
