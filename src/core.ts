/**
 * @fileoverview Everything that talks to FoundryVTT: the Socket.IO client,
 * the companion-module bridge, the headless GM session, and tool/resource
 * routing over them.
 *
 * Owned either by the all-in-one stdio server (`FOUNDRY_MCP_SHARED=false`)
 * or by the shared process that relays forward calls to.
 */

import {
  type CallToolResult,
  ErrorCode,
  McpError,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from './config/index.js';
import { DiagnosticsClient } from './diagnostics/client.js';
import { FoundryClient, type FoundryClientConfig } from './foundry/client.js';
import { HeadlessGmSession } from './foundry/headless-gm-session.js';
import { ModuleBridge } from './foundry/module-bridge.js';
import { routeResourceRequest, routeToolRequest } from './tools/index.js';
import { DiagnosticSystem } from './utils/diagnostics.js';
import { logger } from './utils/logger.js';

/** Snapshot reported by `foundryvtt-mcp status`. */
export interface CoreStatus {
  foundryConnected: boolean;
  bridge: { enabled: boolean; port: number; moduleConnected: boolean };
  headlessGm: { enabled: boolean; active: boolean; status: string | null };
}

export class FoundryCore {
  readonly foundryClient: FoundryClient;
  private readonly diagnosticsClient: DiagnosticsClient;
  private readonly diagnosticSystem: DiagnosticSystem;
  private moduleBridge: ModuleBridge | null;
  private headlessGmSession: HeadlessGmSession | null;

  constructor() {
    // Initialize FoundryVTT client with configuration
    const clientConfig: FoundryClientConfig = {
      baseUrl: config.foundry.url,
      socketPath: config.foundry.socketPath,
      timeout: config.foundry.timeout,
      retryAttempts: config.foundry.retryAttempts,
      retryDelay: config.foundry.retryDelay,
      writeEnabled: config.foundry.writeEnabled,
      eventBufferSize: config.events.bufferSize,
    };
    if (config.foundry.apiKey) {
      clientConfig.apiKey = config.foundry.apiKey;
    }
    if (config.foundry.username) {
      clientConfig.username = config.foundry.username;
    }
    if (config.foundry.password) {
      clientConfig.password = config.foundry.password;
    }
    if (config.foundry.userId) {
      clientConfig.userId = config.foundry.userId;
    }
    if (config.assets.dataPath) {
      clientConfig.dataPath = config.assets.dataPath;
    }
    this.foundryClient = new FoundryClient(clientConfig);

    // Canvas-only tools (scene screenshots, etc.) relay through a companion
    // Foundry module over a plain WebSocket; disabled unless opted in, since
    // most tools need only the Socket.IO document API set up above.
    this.moduleBridge = config.moduleBridge.enabled
      ? new ModuleBridge(config.moduleBridge.port)
      : null;
    if (this.moduleBridge) {
      // The bridge stays ignorant of FoundryClient; it only relays what the
      // module pushed unsolicited (canvas targeting, pings, …).
      this.moduleBridge.onEvent = (type, payload) =>
        this.foundryClient.recordModuleEvent(type, payload);
    }

    // Invisible GM-tier browser session that hosts the companion module —
    // no human has to manually open and log into a second Foundry tab.
    // Only worth building when there's a bridge for it to connect to, and
    // only possible with username/password credentials (an apiKey-only
    // setup has nothing to log a browser in with).
    const headlessUsername = config.headlessGm.username ?? config.foundry.username;
    const headlessPassword = config.headlessGm.password ?? config.foundry.password;
    if (this.moduleBridge && config.headlessGm.enabled && headlessUsername && headlessPassword) {
      this.headlessGmSession = new HeadlessGmSession({
        foundryUrl: config.foundry.url,
        username: headlessUsername,
        password: headlessPassword,
        isBridgeConnected: () => this.moduleBridge?.isConnected() ?? false,
        ...(config.headlessGm.executablePath
          ? { executablePath: config.headlessGm.executablePath }
          : {}),
      });
    } else {
      this.headlessGmSession = null;
      if (this.moduleBridge && config.headlessGm.enabled) {
        logger.warn(
          'Headless GM session disabled — no username/password to log a browser in with (set FOUNDRY_USERNAME/FOUNDRY_PASSWORD or FOUNDRY_HEADLESS_GM_USERNAME/FOUNDRY_HEADLESS_GM_PASSWORD, or open a GM browser tab manually).',
        );
      }
    }

    // Initialize DiagnosticsClient
    this.diagnosticsClient = new DiagnosticsClient(this.foundryClient);

    // Initialize DiagnosticSystem
    this.diagnosticSystem = new DiagnosticSystem(this.foundryClient);
  }

  /**
   * Connects to FoundryVTT, then starts the module bridge and the headless
   * GM session (both best-effort).
   *
   * @throws if the FoundryVTT connection fails
   */
  async start(): Promise<void> {
    try {
      // Connect to FoundryVTT
      await this.foundryClient.connect();
      logger.info('Connected to FoundryVTT successfully');

      // The module bridge is optional, best-effort infrastructure for a
      // handful of canvas-only tools (capture_scene, etc.) — a failure here
      // (e.g. the port is already taken by a still-shutting-down previous
      // instance) must never take down the FoundryVTT Socket.IO connection
      // and the 40+ tools that don't need a module at all.
      if (this.moduleBridge) {
        try {
          await this.moduleBridge.start();
        } catch (error) {
          logger.error(
            'Module bridge failed to start — canvas-only tools (capture_scene) will report unavailable; all other tools are unaffected:',
            error,
          );
          this.moduleBridge = null;
          this.headlessGmSession = null;
        }
      }

      // Same best-effort isolation as the module bridge itself: a browser
      // that fails to launch (no Chrome/Edge installed) must never take
      // down the Socket.IO connection or the module bridge's WS server —
      // canvas-only tools just report unavailable until this resolves.
      // Login happens in the background after this resolves (Foundry may
      // still be booting); see HeadlessGmSession.start().
      if (this.headlessGmSession) {
        try {
          await this.headlessGmSession.start();
        } catch (error) {
          logger.error(
            'Headless GM session failed to launch — open a GM/Assistant-GM browser tab manually for canvas-only tools to work:',
            error,
          );
          this.headlessGmSession = null;
        }
      }
    } catch (error) {
      logger.error('Failed to connect to FoundryVTT:', error);
      throw error;
    }
  }

  /** Disconnects from FoundryVTT and stops the headless session and the bridge. */
  async shutdown(): Promise<void> {
    try {
      await this.foundryClient.disconnect();
      if (this.headlessGmSession) {
        await this.headlessGmSession.stop();
      }
      if (this.moduleBridge) {
        await this.moduleBridge.stop();
      }
      logger.info('FoundryVTT MCP Server shutdown completed');
    } catch (error) {
      logger.error('Error during shutdown:', error);
    }
  }

  /** Runs one tool; failures surface as {@link McpError}. */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    logger.info('Executing tool', { name, args });

    try {
      return (await routeToolRequest(
        name,
        args,
        this.foundryClient,
        this.diagnosticsClient,
        this.diagnosticSystem,
        this.moduleBridge,
        this.headlessGmSession,
      )) as CallToolResult;
    } catch (error) {
      logger.error('Tool execution failed:', error);

      if (error instanceof McpError) {
        throw error;
      }

      throw new McpError(
        ErrorCode.InternalError,
        `Tool execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /** Reads one `foundry://` resource; failures surface as {@link McpError}. */
  async readResource(uri: string): Promise<ReadResourceResult> {
    logger.info('Reading resource', { uri });

    try {
      return (await routeResourceRequest(
        uri,
        this.foundryClient,
        this.diagnosticsClient,
      )) as ReadResourceResult;
    } catch (error) {
      logger.error('Resource read failed:', error);

      if (error instanceof McpError) {
        throw error;
      }

      throw new McpError(
        ErrorCode.InternalError,
        `Resource read failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  status(): CoreStatus {
    return {
      foundryConnected: this.foundryClient.isConnected(),
      bridge: {
        enabled: this.moduleBridge !== null,
        port: config.moduleBridge.port,
        moduleConnected: this.moduleBridge?.isConnected() ?? false,
      },
      headlessGm: {
        enabled: this.headlessGmSession !== null,
        active: this.headlessGmSession?.isActive() ?? false,
        status: this.headlessGmSession?.statusText() ?? null,
      },
    };
  }
}
