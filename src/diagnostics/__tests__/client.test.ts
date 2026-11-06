/**
 * @fileoverview Tests for DiagnosticsClient
 *
 * Unit tests for the DiagnosticsClient class that handles communication
 * with FoundryVTT's diagnostic API endpoints.
 *
 * @version 0.1.0
 * @author FoundryVTT MCP Team
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../foundry/client.js';
import { isRefusal } from '../../utils/refusal.js';
import { DiagnosticsClient, RestApiRequiredError } from '../client.js';
import type { ErrorDiagnosis, LogEntry, LogPatternSearchParams, SystemHealth } from '../types.js';

// Mock the FoundryClient
vi.mock('../../foundry/client.js');
vi.mock('../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('DiagnosticsClient', () => {
  let diagnosticsClient: DiagnosticsClient;
  let mockFoundryClient: vi.Mocked<FoundryClient>;

  beforeEach(() => {
    // Create mocked FoundryClient
    mockFoundryClient = {
      get: vi.fn(),
      hasRestApi: vi.fn(() => true),
    } as unknown as vi.Mocked<FoundryClient>;

    diagnosticsClient = new DiagnosticsClient(mockFoundryClient);
  });

  describe('getRecentLogs', () => {
    it('should retrieve recent logs with default parameters', async () => {
      const mockResponse = {
        data: {
          logs: [
            {
              timestamp: '2024-01-01T12:00:00.000Z',
              level: 'info',
              message: 'Test log message',
              source: 'foundry',
            },
          ] as LogEntry[],
          total: 1,
          bufferSize: 100,
          maxBufferSize: 1000,
        },
      };

      mockFoundryClient.get.mockResolvedValue(mockResponse);

      const result = await diagnosticsClient.getRecentLogs();

      expect(mockFoundryClient.get).toHaveBeenCalledWith('/api/diagnostics/logs');
      expect(result.logs).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.logs[0].message).toBe('Test log message');
    });

    it('should apply filters correctly', async () => {
      const mockResponse = {
        data: {
          logs: [] as LogEntry[],
          total: 0,
          bufferSize: 0,
          maxBufferSize: 1000,
        },
      };

      mockFoundryClient.get.mockResolvedValue(mockResponse);

      await diagnosticsClient.getRecentLogs({
        lines: 100,
        level: 'error',
        since: '2024-01-01T00:00:00.000Z',
        source: 'module',
        includeStack: true,
      });

      expect(mockFoundryClient.get).toHaveBeenCalledWith(
        '/api/diagnostics/logs?lines=100&level=error&since=2024-01-01T00%3A00%3A00.000Z&source=module&includeStack=true',
      );
    });

    it('should handle API errors gracefully', async () => {
      const error = new Error('API Error');
      mockFoundryClient.get.mockRejectedValue(error);

      await expect(diagnosticsClient.getRecentLogs()).rejects.toThrow(
        'Recent logs unavailable from the REST API module: API Error',
      );
    });
  });

  describe('searchLogs', () => {
    it('should search logs with pattern', async () => {
      const mockResponse = {
        data: {
          logs: [
            {
              timestamp: '2024-01-01T12:00:00.000Z',
              level: 'error',
              message: 'TypeError: Cannot read property',
              source: 'module',
            },
          ] as LogEntry[],
          matches: 1,
          pattern: 'TypeError',
          searchTimeframe: 'all',
        },
      };

      mockFoundryClient.get.mockResolvedValue(mockResponse);

      const result = await diagnosticsClient.searchLogs({ pattern: 'TypeError' });

      expect(mockFoundryClient.get).toHaveBeenCalledWith(
        '/api/diagnostics/search?pattern=TypeError',
      );
      expect(result.matches).toBe(1);
      expect(result.logs[0].message).toContain('TypeError');
    });

    it('should apply search filters', async () => {
      const mockResponse = {
        data: {
          logs: [],
          matches: 0,
          pattern: 'Error',
          searchTimeframe: '3600',
        },
      };

      mockFoundryClient.get.mockResolvedValue(mockResponse);

      await diagnosticsClient.searchLogs({
        pattern: 'Error',
        timeframe: '3600',
        level: 'error',
        caseSensitive: true,
      });

      expect(mockFoundryClient.get).toHaveBeenCalledWith(
        '/api/diagnostics/search?pattern=Error&timeframe=3600&level=error&caseSensitive=true',
      );
    });

    it('should throw error when pattern is missing', async () => {
      await expect(diagnosticsClient.searchLogs({} as LogPatternSearchParams)).rejects.toThrow(
        'Log search unavailable from the REST API module',
      );
    });
  });

  describe('getSystemHealth', () => {
    it('should retrieve system health metrics', async () => {
      const mockHealth: SystemHealth = {
        timestamp: '2024-01-01T12:00:00.000Z',
        server: {
          foundryVersion: '11.315',
          systemVersion: '5e 2.4.1',
          worldId: 'test-world',
          uptime: 3600,
        },
        users: {
          total: 5,
          active: 3,
          gm: 1,
        },
        modules: {
          total: 50,
          active: 35,
        },
        performance: {
          memory: {
            rss: 104857600,
            heapTotal: 83886080,
            heapUsed: 52428800,
            external: 1048576,
            arrayBuffers: 524288,
          },
          connectedClients: 3,
        },
        logs: {
          bufferSize: 500,
          recentErrors: 2,
          recentWarnings: 5,
          errorRate: 0.1,
        },
        status: 'healthy',
      };

      mockFoundryClient.get.mockResolvedValue({ data: mockHealth });

      const result = await diagnosticsClient.getSystemHealth();

      expect(mockFoundryClient.get).toHaveBeenCalledWith('/api/diagnostics/health');
      expect(result.status).toBe('healthy');
      expect(result.server.foundryVersion).toBe('11.315');
      expect(result.users.active).toBe(3);
    });

    it('should handle API errors', async () => {
      mockFoundryClient.get.mockRejectedValue(new Error('Server Error'));

      await expect(diagnosticsClient.getSystemHealth()).rejects.toThrow(
        'System health unavailable from the REST API module: Server Error',
      );
    });

    it('without FOUNDRY_API_KEY: refuses without any request or log line', async () => {
      const { logger } = await import('../../utils/logger.js');
      vi.mocked(logger.error).mockClear();
      vi.mocked(logger.warn).mockClear();
      mockFoundryClient.hasRestApi.mockReturnValue(false);

      const error = await diagnosticsClient.getSystemHealth().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RestApiRequiredError);
      expect(isRefusal(error)).toBe(true);
      expect(String(error)).toContain('FOUNDRY_API_KEY');
      expect(mockFoundryClient.get).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('with a key but no health endpoint (404): one warning, no error log, a refusal', async () => {
      const { logger } = await import('../../utils/logger.js');
      vi.mocked(logger.error).mockClear();
      vi.mocked(logger.warn).mockClear();
      const notFound = Object.assign(new Error('Request failed with status code 404'), {
        isAxiosError: true,
        response: { status: 404 },
      });
      mockFoundryClient.get.mockRejectedValue(notFound);

      for (let i = 0; i < 3; i++) {
        const error = await diagnosticsClient.getSystemHealth().catch((e: unknown) => e);
        expect(isRefusal(error)).toBe(true);
      }

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('diagnoseErrors', () => {
    it('should analyze errors and provide suggestions', async () => {
      const mockDiagnosis: ErrorDiagnosis = {
        timestamp: '2024-01-01T12:00:00.000Z',
        timeframe: '3600 seconds',
        summary: {
          totalErrors: 5,
          uniqueErrors: 3,
          categories: {
            TypeError: 2,
            Network: 3,
          },
        },
        recentErrors: [
          {
            timestamp: '2024-01-01T12:00:00.000Z',
            level: 'error',
            message: 'TypeError: Cannot read property',
            source: 'module',
          },
        ] as LogEntry[],
        suggestions: [
          {
            category: 'TypeError',
            suggestion: 'Check for undefined variables',
            priority: 'high',
          },
        ],
        healthScore: 75,
      };

      mockFoundryClient.get.mockResolvedValue({ data: mockDiagnosis });

      const result = await diagnosticsClient.diagnoseErrors(3600);

      expect(mockFoundryClient.get).toHaveBeenCalledWith('/api/diagnostics/errors?timeframe=3600');
      expect(result.healthScore).toBe(75);
      expect(result.summary.totalErrors).toBe(5);
      expect(result.suggestions).toHaveLength(1);
    });

    it('should use default timeframe', async () => {
      const mockDiagnosis: ErrorDiagnosis = {
        timestamp: '2024-01-01T12:00:00.000Z',
        timeframe: '3600 seconds',
        summary: { totalErrors: 0, uniqueErrors: 0, categories: {} },
        recentErrors: [],
        suggestions: [],
        healthScore: 100,
      };

      mockFoundryClient.get.mockResolvedValue({ data: mockDiagnosis });

      await diagnosticsClient.diagnoseErrors();

      expect(mockFoundryClient.get).toHaveBeenCalledWith('/api/diagnostics/errors?timeframe=3600');
    });
  });

  describe('getErrorsOnly', () => {
    it('should get only error logs', async () => {
      const mockResponse = {
        data: {
          logs: [
            {
              timestamp: '2024-01-01T12:00:00.000Z',
              level: 'error',
              message: 'Test error',
              source: 'foundry',
              stack: 'Error stack trace',
            },
          ] as LogEntry[],
          total: 1,
        },
      };

      mockFoundryClient.get.mockResolvedValue(mockResponse);

      const result = await diagnosticsClient.getErrorsOnly(3600);

      expect(result).toHaveLength(1);
      expect(result[0].level).toBe('error');
      expect(result[0].stack).toBeDefined();
    });

    it('should filter by different log levels', async () => {
      const mockResponse = {
        data: {
          logs: [
            {
              timestamp: '2024-01-01T12:00:00.000Z',
              level: 'warn',
              message: 'Test warning',
              source: 'foundry',
            },
          ] as LogEntry[],
          total: 1,
        },
      };

      mockFoundryClient.get.mockResolvedValue(mockResponse);

      const result = await diagnosticsClient.getErrorsOnly(1800, 'warn');

      expect(result).toHaveLength(1);
      expect(result[0].level).toBe('warn');
    });
  });

  describe('getHealthStatus', () => {
    it('should return simplified health status', async () => {
      const mockHealth: SystemHealth = {
        timestamp: '2024-01-01T12:00:00.000Z',
        server: {
          foundryVersion: '11.315',
          systemVersion: '5e 2.4.1',
          worldId: 'test-world',
        },
        users: { total: 5, active: 3, gm: 1 },
        modules: { total: 50, active: 35 },
        performance: { connectedClients: 3 },
        logs: { bufferSize: 500, recentErrors: 0, recentWarnings: 2, errorRate: 0 },
        status: 'healthy',
      };

      mockFoundryClient.get.mockResolvedValue({ data: mockHealth });

      const result = await diagnosticsClient.getHealthStatus();

      expect(result.status).toBe('healthy');
    });

    it('should return critical status on error', async () => {
      mockFoundryClient.get.mockRejectedValue(new Error('API Error'));

      const result = await diagnosticsClient.getHealthStatus();

      expect(result.status).toBe('critical');
    });

    /**
     * The signature and the JSDoc example both advertised a `score` the body
     * never sets — the same "documented field that does not exist" family as
     * laurigates/foundryvtt-mcp#216. Test files are outside the `tsc` surface (`exclude:
     * **\/*.test.ts`), so the declared shape is pinned here at runtime: the
     * result carries `status` and nothing else, on both paths.
     */
    it.each([
      { path: 'success', arrange: () => mockFoundryClient.get.mockResolvedValue({ data: {} }) },
      {
        path: 'failure',
        arrange: () => mockFoundryClient.get.mockRejectedValue(new Error('API Error')),
      },
    ])('returns status alone on the $path path — no score field', async ({ arrange }) => {
      arrange();

      const result = await diagnosticsClient.getHealthStatus();

      expect(Object.keys(result)).toEqual(['status']);
    });
  });

  describe('isAvailable', () => {
    it('should return true when API is available', async () => {
      mockFoundryClient.get.mockResolvedValue({ data: {} });

      const result = await diagnosticsClient.isAvailable();

      expect(result).toBe(true);
      expect(mockFoundryClient.get).toHaveBeenCalledWith('/api/diagnostics/health');
    });

    it('should return false when API is not available', async () => {
      mockFoundryClient.get.mockRejectedValue(new Error('Not Found'));

      const result = await diagnosticsClient.isAvailable();

      expect(result).toBe(false);
    });
  });

  describe('without FOUNDRY_API_KEY', () => {
    it.each([
      ['getRecentLogs', () => diagnosticsClient.getRecentLogs(), 'Recent logs'],
      ['searchLogs', () => diagnosticsClient.searchLogs({ pattern: 'TypeError' }), 'Log search'],
      ['diagnoseErrors', () => diagnosticsClient.diagnoseErrors(), 'Error diagnosis'],
    ])('%s refuses without any request or log line', async (_name, call, what) => {
      const { logger } = await import('../../utils/logger.js');
      vi.mocked(logger.error).mockClear();
      vi.mocked(logger.warn).mockClear();
      mockFoundryClient.hasRestApi.mockReturnValue(false);

      const error = await call().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RestApiRequiredError);
      expect(isRefusal(error)).toBe(true);
      expect((error as Error).message).toBe(
        `${what} requires the REST API module (FOUNDRY_API_KEY is not set)`,
      );
      expect(mockFoundryClient.get).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('a failed REST request', () => {
    it('logs one short warning, the stack at debug level, and refuses', async () => {
      const { logger } = await import('../../utils/logger.js');
      vi.mocked(logger.error).mockClear();
      vi.mocked(logger.warn).mockClear();
      vi.mocked(logger.debug).mockClear();
      const failure = Object.assign(new Error('Request failed with status code 500'), {
        response: { status: 500 },
      });
      mockFoundryClient.get.mockRejectedValue(failure);

      const error = await diagnosticsClient.diagnoseErrors().catch((e: unknown) => e);

      expect(isRefusal(error)).toBe(true);
      expect((error as Error).message).toBe(
        'Error diagnosis unavailable from the REST API module: HTTP 500',
      );
      expect(logger.error).not.toHaveBeenCalled();
      expect(vi.mocked(logger.warn).mock.calls).toEqual([
        ['DiagnosticsClient | Error diagnosis unavailable from the REST API module: HTTP 500'],
      ]);
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
        'DiagnosticsClient | Error diagnosis request failed',
        expect.objectContaining({ stack: expect.stringContaining('Error') }),
      );
    });
  });
});
