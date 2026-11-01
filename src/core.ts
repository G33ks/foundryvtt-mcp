/**
 * @fileoverview Everything that talks to FoundryVTT: the Socket.IO client,
 * the companion-module bridge, the headless GM session, and tool/resource
 * routing over them.
 *
 * Owned either by the all-in-one stdio server (`FOUNDRY_MCP_SHARED=false`)
 * or by the shared process that relays forward calls to.
 */

import path from 'node:path';
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
import { BRIDGE_PROTOCOL_VERSION, ModuleBridge } from './foundry/module-bridge.js';
import { defaultStateDir } from './shared/paths.js';
import { routeResourceRequest, routeToolRequest } from './tools/index.js';
import { isWriteTool } from './tools/write-tools.js';
import { DiagnosticSystem } from './utils/diagnostics.js';
import { logger } from './utils/logger.js';
import { SerialQueue } from './utils/serial-queue.js';

/** Snapshot reported by `foundryvtt-mcp status`. */
export interface CoreStatus {
  foundryConnected: boolean;
  bridge: {
    enabled: boolean;
    port: number;
    /** An authenticated module is connected. */
    moduleConnected: boolean;
    /** Handshake protocol version the bridge speaks. */
    protocol: number;
    /** The only `Origin` the bridge accepts. */
    origin: string;
    /** ISO time the current authenticated connection was established, or `null`. */
    moduleConnectedSince: string | null;
  };
  headlessGm: { enabled: boolean; active: boolean; status: string | null };
  /** Write calls queued or running. */
  writeQueue: number;
}

export class FoundryCore {
  readonly foundryClient: FoundryClient;
  private readonly diagnosticsClient: DiagnosticsClient;
  private readonly diagnosticSystem: DiagnosticSystem;
  private moduleBridge: ModuleBridge | null;
  private headlessGmSession: HeadlessGmSession | null;
  /** Serialises every write tool, in arrival order; reads bypass it. */
  private readonly writeQueue = new SerialQueue();

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
    // Same state directory as the shared process's daemon.json, in both modes.
    clientConfig.journalHistoryDir = path.join(defaultStateDir(), 'journal-history');
    if (config.headlessGm.username) {
      clientConfig.connectorUsernames = [config.headlessGm.username];
    }
    this.foundryClient = new FoundryClient(clientConfig);
    // A detected journal overwrite is whispered to the GMs. The whisper is a
    // write, so it waits its turn in the write queue like any tool write.
    this.foundryClient.onJournalConflict = (conflict) => {
      this.writeQueue
        .run(() => this.foundryClient.whisperJournalConflict(conflict))
        .catch((error: unknown) => {
          logger.warn('Could not whisper a journal overwrite to the GMs', {
            journalId: conflict.journalId,
            pageId: conflict.pageId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };

    // Canvas-only tools (scene screenshots, etc.) relay through a companion
    // Foundry module over a plain WebSocket; disabled unless opted in, since
    // most tools need only the Socket.IO document API set up above.
    // Only the module running in a page served from FOUNDRY_URL may connect.
    this.moduleBridge = config.moduleBridge.enabled
      ? new ModuleBridge(config.moduleBridge.port, {
          expectedOrigin: new URL(config.foundry.url).origin,
        })
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
      const bridge = this.moduleBridge;
      this.headlessGmSession = new HeadlessGmSession({
        foundryUrl: config.foundry.url,
        username: headlessUsername,
        password: headlessPassword,
        isBridgeConnected: () => this.moduleBridge?.isConnected() ?? false,
        // The module authenticates through the page; the secret stays in the bridge.
        bridgeCredentials: {
          info: () => bridge.info(),
          prove: (serverNonce) => bridge.prove(serverNonce),
        },
        ...(config.headlessGm.executablePath
          ? { executablePath: config.headlessGm.executablePath }
          : {}),
      });
    } else {
      this.headlessGmSession = null;
      if (this.moduleBridge && config.headlessGm.enabled) {
        logger.warn(
          'Headless GM session disabled — no username/password to log a browser in with (set FOUNDRY_USERNAME/FOUNDRY_PASSWORD or FOUNDRY_HEADLESS_GM_USERNAME/FOUNDRY_HEADLESS_GM_PASSWORD). The companion module only connects from that session, so canvas-only tools will be unavailable.',
        );
      } else if (this.moduleBridge) {
        logger.warn(
          'Module bridge enabled but FOUNDRY_HEADLESS_GM_ENABLED=false: the companion module only connects from the headless GM session (a manually opened GM tab is no longer supported), so canvas-only tools will be unavailable.',
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
            'Headless GM session failed to launch — the companion module cannot connect, so canvas-only tools will be unavailable:',
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

  /**
   * Runs one tool; failures surface as {@link McpError}. Write tools wait
   * for the writes submitted before them to finish.
   */
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (isWriteTool(name)) {
      return this.writeQueue.run(() => this.executeTool(name, args));
    }
    return this.executeTool(name, args);
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
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
        protocol: BRIDGE_PROTOCOL_VERSION,
        origin: new URL(config.foundry.url).origin,
        moduleConnectedSince: this.moduleBridge?.moduleConnectedSince()?.toISOString() ?? null,
      },
      headlessGm: {
        enabled: this.headlessGmSession !== null,
        active: this.headlessGmSession?.isActive() ?? false,
        status: this.headlessGmSession?.statusText() ?? null,
      },
      writeQueue: this.writeQueue.pending,
    };
  }
}
