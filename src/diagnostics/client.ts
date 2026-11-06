/**
 * @fileoverview DiagnosticsClient for accessing FoundryVTT logs and system health
 *
 * This module provides a client interface for accessing diagnostic information
 * from FoundryVTT through the REST API module's diagnostic endpoints.
 *
 * @version 0.1.0
 * @author FoundryVTT MCP Team
 */

import type { z } from 'zod';
import type { FoundryClient } from '../foundry/client.js';
import { logger } from '../utils/logger.js';
import { RefusedError } from '../utils/refusal.js';
import type { LogPatternSearchParams, LogSearchParams } from './types.js';
import {
  ErrorDiagnosisSchema,
  LogResponseSchema,
  LogSearchResponseSchema,
  SystemHealthSchema,
} from './types.js';

type LogResponse = z.infer<typeof LogResponseSchema>;
type LogSearchResponse = z.infer<typeof LogSearchResponseSchema>;
type SystemHealth = z.infer<typeof SystemHealthSchema>;
type ErrorDiagnosis = z.infer<typeof ErrorDiagnosisSchema>;

/** HTTP status of an axios error, if it carries a response. */
function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) {
    return undefined;
  }
  const { response } = error;
  return typeof response === 'object' &&
    response !== null &&
    'status' in response &&
    typeof response.status === 'number'
    ? response.status
    : undefined;
}

/**
 * Logs, log search, error diagnosis and system health come from the REST API
 * module only. Without `FOUNDRY_API_KEY` (or with a module that lacks the
 * endpoint) asking for them is not a failure: an expected refusal, logged as
 * one warning line at most — and no request is sent.
 */
export class RestApiRequiredError extends RefusedError {
  override name = 'RestApiRequiredError';
}

/** The REST API module did not answer a diagnostics request; see {@link restFailure}. */
export class RestApiUnavailableError extends RestApiRequiredError {
  override name = 'RestApiUnavailableError';
}

/** Longest reason kept from a failed request (a schema error lists every issue). */
const MAX_FAILURE_REASON_LENGTH = 200;

/**
 * A diagnostics request to the REST API module failed: one short warning
 * line, the full error at debug level, and a refusal for the caller, so the
 * tool call that asked logs a warning rather than two errors with stacks.
 */
function restFailure(what: string, error: unknown): RestApiUnavailableError {
  const status = httpStatus(error);
  const reason = (
    status !== undefined ? `HTTP ${status}` : error instanceof Error ? error.message : String(error)
  ).slice(0, MAX_FAILURE_REASON_LENGTH);
  logger.warn(`DiagnosticsClient | ${what} unavailable from the REST API module: ${reason}`);
  logger.debug(
    `DiagnosticsClient | ${what} request failed`,
    error instanceof Error ? { message: error.message, stack: error.stack } : error,
  );
  return new RestApiUnavailableError(`${what} unavailable from the REST API module: ${reason}`);
}

/**
 * Client for accessing FoundryVTT diagnostic and logging information
 *
 * Provides methods to retrieve logs, search for specific patterns,
 * monitor system health, and analyze errors through the REST API.
 *
 * @class DiagnosticsClient
 * @example
 * ```typescript
 * const diagnostics = new DiagnosticsClient(foundryClient);
 *
 * // Get recent errors
 * const errors = await diagnostics.getRecentLogs({ level: 'error', lines: 20 });
 *
 * // Search for specific patterns
 * const matches = await diagnostics.searchLogs({ pattern: 'TypeError', timeframe: '3600' });
 *
 * // Check system health
 * const health = await diagnostics.getSystemHealth();
 * ```
 */
export class DiagnosticsClient {
  /**
   * Create a new DiagnosticsClient instance
   *
   * @param foundryClient - The FoundryClient instance to use for API calls
   */
  /** The health endpoint answered 404 once already: warned, not again. */
  private healthEndpointMissingWarned = false;

  /** Refuses, without any request, when no `FOUNDRY_API_KEY` is set. */
  private requireRestApi(what: string): void {
    if (!this.foundryClient.hasRestApi()) {
      throw new RestApiRequiredError(
        `${what} requires the REST API module (FOUNDRY_API_KEY is not set)`,
      );
    }
  }

  constructor(private foundryClient: FoundryClient) {}

  /**
   * Get recent log entries with optional filtering
   *
   * @param params - Search parameters for filtering logs
   * @returns Promise resolving to log response with entries and metadata
   *
   * @example
   * ```typescript
   * // Get last 50 log entries
   * const logs = await diagnostics.getRecentLogs();
   *
   * // Get only error logs from the last hour
   * const errors = await diagnostics.getRecentLogs({
   *   level: 'error',
   *   since: new Date(Date.now() - 3600000).toISOString()
   * });
   *
   * // Get logs with stack traces included
   * const detailed = await diagnostics.getRecentLogs({
   *   lines: 100,
   *   includeStack: true
   * });
   * ```
   */
  async getRecentLogs(params: LogSearchParams = {}): Promise<LogResponse> {
    this.requireRestApi('Recent logs');
    try {
      logger.debug('DiagnosticsClient | Getting recent logs', params);

      const searchParams = new URLSearchParams();

      if (params.lines !== undefined) {
        searchParams.set('lines', params.lines.toString());
      }
      if (params.level) {
        searchParams.set('level', params.level);
      }
      if (params.since) {
        searchParams.set('since', params.since);
      }
      if (params.source) {
        searchParams.set('source', params.source);
      }
      if (params.includeStack !== undefined) {
        searchParams.set('includeStack', params.includeStack.toString());
      }

      const queryString = searchParams.toString();
      const url = `/api/diagnostics/logs${queryString ? `?${queryString}` : ''}`;

      const response = await this.foundryClient.get(url);
      const parsed = LogResponseSchema.parse(response.data);

      logger.debug('DiagnosticsClient | Retrieved logs', {
        count: parsed.total,
        bufferSize: parsed.bufferSize,
      });

      return parsed;
    } catch (error) {
      throw restFailure('Recent logs', error);
    }
  }

  /**
   * Search log entries for specific patterns using regular expressions
   *
   * @param params - Search parameters including pattern and filters
   * @returns Promise resolving to matching log entries
   *
   * @example
   * ```typescript
   * // Search for any TypeError occurrences
   * const typeErrors = await diagnostics.searchLogs({
   *   pattern: 'TypeError'
   * });
   *
   * // Search for network errors in the last hour
   * const networkErrors = await diagnostics.searchLogs({
   *   pattern: 'Failed to fetch|Network Error',
   *   timeframe: '3600',
   *   level: 'error'
   * });
   *
   * // Case-sensitive search for specific module errors
   * const moduleErrors = await diagnostics.searchLogs({
   *   pattern: 'Module.*failed',
   *   caseSensitive: true
   * });
   * ```
   */
  async searchLogs(params: LogPatternSearchParams): Promise<LogSearchResponse> {
    this.requireRestApi('Log search');
    try {
      logger.debug('DiagnosticsClient | Searching logs', params);

      const searchParams = new URLSearchParams();
      searchParams.set('pattern', params.pattern);

      if (params.timeframe) {
        searchParams.set('timeframe', params.timeframe);
      }
      if (params.level) {
        searchParams.set('level', params.level);
      }
      if (params.caseSensitive !== undefined) {
        searchParams.set('caseSensitive', params.caseSensitive.toString());
      }

      const url = `/api/diagnostics/search?${searchParams.toString()}`;
      const response = await this.foundryClient.get(url);
      const parsed = LogSearchResponseSchema.parse(response.data);

      logger.debug('DiagnosticsClient | Search completed', {
        pattern: params.pattern,
        matches: parsed.matches,
      });

      return parsed;
    } catch (error) {
      throw restFailure('Log search', error);
    }
  }

  /**
   * Get comprehensive system health and performance metrics
   *
   * @returns Promise resolving to complete system health information
   *
   * @example
   * ```typescript
   * const health = await diagnostics.getSystemHealth();
   *
   * console.log(`Server status: ${health.status}`);
   * console.log(`Active users: ${health.users.active}/${health.users.total}`);
   * console.log(`Recent errors: ${health.logs.recentErrors}`);
   *
   * if (health.status === 'critical') {
   *   console.warn('Server requires immediate attention!');
   * }
   * ```
   */
  async getSystemHealth(): Promise<SystemHealth> {
    this.requireRestApi('System health');
    try {
      logger.debug('DiagnosticsClient | Getting system health');

      const response = await this.foundryClient.get('/api/diagnostics/health');
      const parsed = SystemHealthSchema.parse(response.data);

      logger.debug('DiagnosticsClient | System health retrieved', {
        status: parsed.status,
        activeUsers: parsed.users?.active,
        recentErrors: parsed.logs?.recentErrors,
      });

      return parsed;
    } catch (error) {
      if (httpStatus(error) === 404) {
        if (!this.healthEndpointMissingWarned) {
          this.healthEndpointMissingWarned = true;
          logger.warn(
            'DiagnosticsClient | The REST API module does not provide /api/diagnostics/health (HTTP 404); system health is unavailable',
          );
        }
        throw new RestApiRequiredError(
          'System health is unavailable: the REST API module does not provide /api/diagnostics/health (HTTP 404)',
        );
      }
      throw restFailure('System health', error);
    }
  }

  /**
   * Analyze recent errors and get diagnostic suggestions
   *
   * @param timeframe - Time window in seconds to analyze (default: 3600)
   * @returns Promise resolving to error diagnosis with suggestions
   *
   * @example
   * ```typescript
   * // Analyze errors from the last hour
   * const diagnosis = await diagnostics.diagnoseErrors();
   *
   * // Analyze errors from the last 30 minutes
   * const recentDiagnosis = await diagnostics.diagnoseErrors(1800);
   *
   * console.log(`Health score: ${diagnosis.healthScore}/100`);
   * console.log(`Total errors: ${diagnosis.summary.totalErrors}`);
   *
   * // Display suggestions
   * diagnosis.suggestions.forEach(suggestion => {
   *   console.log(`${suggestion.priority.toUpperCase()}: ${suggestion.suggestion}`);
   * });
   * ```
   */
  async diagnoseErrors(timeframe: number = 3600): Promise<ErrorDiagnosis> {
    this.requireRestApi('Error diagnosis');
    try {
      logger.debug('DiagnosticsClient | Diagnosing errors', { timeframe });

      const searchParams = new URLSearchParams();
      searchParams.set('timeframe', timeframe.toString());

      const url = `/api/diagnostics/errors?${searchParams.toString()}`;
      const response = await this.foundryClient.get(url);
      const parsed = ErrorDiagnosisSchema.parse(response.data);

      logger.debug('DiagnosticsClient | Error diagnosis completed', {
        totalErrors: parsed.summary?.totalErrors,
        healthScore: parsed.healthScore,
        suggestionCount: parsed.suggestions?.length,
      });

      return parsed;
    } catch (error) {
      throw restFailure('Error diagnosis', error);
    }
  }
}
