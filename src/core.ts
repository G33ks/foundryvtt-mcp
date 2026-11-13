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
import { BRIDGE_MODULE_ID } from './cli/checks.js';
import { config, configSettings } from './config/index.js';
import { summarizeSources } from './config/sources.js';
import { DiagnosticsClient } from './diagnostics/client.js';
import { NoActiveWorldError } from './foundry/auth.js';
import type { BrowserChoice } from './foundry/browser-detect.js';
import {
  type ConnectionStatus,
  FoundryClient,
  type FoundryClientConfig,
  gamemasterAccountWarning,
  roleLabel,
} from './foundry/client.js';
import { HeadlessGmSession, type HeadlessSessionState } from './foundry/headless-gm-session.js';
import { BRIDGE_PROTOCOL_VERSION, ModuleBridge } from './foundry/module-bridge.js';
import { defaultStateDir } from './shared/paths.js';
import type { HealthRuntime } from './tools/handlers/diagnostics.js';
import { routeResourceRequest, routeToolRequest } from './tools/index.js';
import {
  needsBridge,
  prefersBridge,
  resourceDependency,
  type ToolDependency,
  toolDependency,
  waitsForSocket,
} from './tools/tool-dependencies.js';
import { isWriteTool } from './tools/write-tools.js';
import { DiagnosticSystem } from './utils/diagnostics.js';
import { redactToolArgs } from './utils/log-args.js';
import { logger } from './utils/logger.js';
import { bareMessage } from './utils/mcp-errors.js';
import { isRefusal, refusalError } from './utils/refusal.js';
import { SerialQueue } from './utils/serial-queue.js';

export type BridgeState = 'listening' | 'not-started' | 'failed' | 'disabled';
export type HeadlessGmState = 'running' | 'not-started' | 'launch-failed' | 'disabled';

/**
 * How long a tool call waits for a FoundryVTT reconnection in progress
 * before it is refused. A reauthentication takes about a second; a
 * socket.io transport reconnection a few.
 */
export const TOOL_RECONNECT_WAIT_MS = 15_000;

/**
 * How long a call that needs the companion module waits for it while the
 * headless page is starting or reconnecting. The module authenticates about
 * 0.6 s after `game.ready`, about 4 s after the browser launch.
 */
export const BRIDGE_CONNECT_WAIT_MS = 10_000;

/**
 * A page logged in for longer than this without a module is not about to
 * get one: the watchdog reloads it, and a call is refused at once meanwhile.
 */
export const BRIDGE_LOGGED_IN_GRACE_MS = 15_000;

/**
 * True when the headless GM page shares the connector's account (and
 * session): no FOUNDRY_HEADLESS_GM_USERNAME, or the same name as
 * FOUNDRY_USERNAME.
 */
export function isSharedAccount(
  headlessUsername: string | undefined,
  foundryUsername: string | undefined,
): boolean {
  return !headlessUsername || headlessUsername === foundryUsername;
}

/** Snapshot reported by `foundryvtt-mcp status`. */
export interface CoreStatus {
  foundryConnected: boolean;
  /** State of the Socket.IO link, and why it is down. */
  foundryConnection: ConnectionStatus;
  /** Since when and why the cached world stopped following live changes; `null` while live. */
  staleCache: { since: string | null; reason: string | null } | null;
  /** The connector's account, its role, and a warning about it if any. */
  account: { name: string; role: string | null; warning: string | null } | null;
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
    /** Version the connected module announced, or `null` (none connected, or a module before 0.6.0). */
    moduleVersion: string | null;
    /** Version of the module installed in the world, from the cached world; `null` when unknown. */
    moduleInstalledVersion: string | null;
    /** Commands the connected module announced, or `null` when it announced none. */
    moduleCommands: string[] | null;
    /** `not-started` until the FoundryVTT connection is up (the bridge starts after it). */
    state: BridgeState;
    /** Why the bridge failed to start; `null` otherwise. */
    error: string | null;
  };
  headlessGm: {
    enabled: boolean;
    active: boolean;
    status: string | null;
    /** The real error when the browser could not be launched; `null` otherwise. */
    launchError: string | null;
    state: HeadlessGmState;
    /** `shared`: the page reuses the connector's session; `separate`: its own account. */
    mode: 'shared' | 'separate' | null;
    /** e.g. "sharing the connector's session (mcp-api)". */
    modeText: string | null;
    sessionState: HeadlessSessionState | null;
    /** The browser the session runs, once launched. */
    browser: BrowserChoice | null;
  };
  /** Write calls queued or running. */
  writeQueue: number;
}

export interface FoundryCoreOptions {
  /** Relays of the shared process hosting this core, for `get_health_status`. */
  relays?: () => NonNullable<HealthRuntime['relays']>;
}

/** The reason of a refusal for the log: an McpError's text without its "MCP error <code>: " prefix. */
function refusalReason(error: unknown): string {
  if (error instanceof McpError) {
    return bareMessage(error);
  }
  return error instanceof Error ? error.message : String(error);
}

/** One line for get_health_status: the configuration file and where settings come from. */
function configurationSummary(): { file: string; sources: string } | undefined {
  let settings: ReturnType<typeof configSettings>;
  try {
    settings = configSettings();
  } catch {
    return undefined;
  }
  const { file, sources } = settings;
  const state = file.error ? file.error : file.found ? 'found' : 'not found';
  return { file: `${file.path} (${state})`, sources: summarizeSources(sources) };
}

export class FoundryCore {
  readonly foundryClient: FoundryClient;
  private readonly diagnosticsClient: DiagnosticsClient;
  private readonly diagnosticSystem: DiagnosticSystem;
  private moduleBridge: ModuleBridge | null;
  private headlessGmSession: HeadlessGmSession | null;
  /** Why the headless GM session's browser could not be launched, if it could not. */
  private headlessLaunchError: string | null = null;
  /** Why the module bridge failed to start, if it did. */
  private bridgeError: string | null = null;
  /** A headless GM session was configured (it may since have been dropped). */
  private readonly headlessGmConfigured: boolean;
  /** The headless GM page shares the connector's account; see {@link isSharedAccount}. */
  private readonly sharedAccount: boolean;
  /** Serialises every write tool, in arrival order; reads bypass it. */
  private readonly writeQueue = new SerialQueue();

  constructor(private readonly options: FoundryCoreOptions = {}) {
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
    if (config.assets.uploadSourceDir) {
      clientConfig.uploadSourceDir = config.assets.uploadSourceDir;
    }
    // Same state directory as the shared process's daemon.json, in both modes.
    clientConfig.journalHistoryDir = path.join(defaultStateDir(), 'journal-history');
    clientConfig.journalConflictsFile = path.join(defaultStateDir(), 'journal-conflicts.json');
    // Shared account: the page reuses the connector's own session, so the
    // connector's user id already covers it. Separate account: its changes
    // are the connector's own too.
    this.sharedAccount = isSharedAccount(config.headlessGm.username, config.foundry.username);
    if (!this.sharedAccount && config.headlessGm.username) {
      clientConfig.connectorUsernames = [config.headlessGm.username];
    }
    this.foundryClient = new FoundryClient(clientConfig);
    this.foundryClient.onSessionChanged(() => this.warnIfGamemaster());
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
          installedModuleVersion: () => this.foundryClient.installedModuleVersion(BRIDGE_MODULE_ID),
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
    // setup has nothing to log a browser in with). By default it shares the
    // connector's session; FOUNDRY_HEADLESS_GM_USERNAME naming another
    // account gives it a login of its own.
    const socketUser = config.foundry.username ?? config.foundry.userId;
    const headlessUsername = this.sharedAccount ? socketUser : config.headlessGm.username;
    const headlessPassword = this.sharedAccount
      ? config.foundry.password
      : (config.headlessGm.password ?? config.foundry.password);
    if (this.moduleBridge && config.headlessGm.enabled && headlessUsername && headlessPassword) {
      const bridge = this.moduleBridge;
      const client = this.foundryClient;
      this.headlessGmSession = new HeadlessGmSession({
        foundryUrl: config.foundry.url,
        username: headlessUsername,
        ...(this.sharedAccount
          ? {
              sessionSource: {
                currentSession: () => client.currentSession(),
                onSessionChanged: (listener) => client.onSessionChanged(listener),
                reauthenticate: (reason) => client.reauthenticate(reason),
              },
            }
          : { password: headlessPassword }),
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

    this.headlessGmConfigured = this.headlessGmSession !== null;

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
      // Connect to FoundryVTT. With no world launched yet, keep starting:
      // the client reconnects in the background once one is, and the
      // headless page waits for its session meanwhile.
      try {
        await this.foundryClient.connect();
        logger.info('Connected to FoundryVTT successfully');
      } catch (error) {
        if (!(error instanceof NoActiveWorldError)) {
          throw error;
        }
        logger.warn(
          `Could not connect to FoundryVTT yet: ${error.message} Retrying in the background.`,
        );
        this.foundryClient.startReconnecting(error);
      }

      // The module bridge is optional, best-effort infrastructure for a
      // handful of canvas-only tools (capture_scene, etc.) — a failure here
      // (e.g. the port is already taken by a still-shutting-down previous
      // instance) must never take down the FoundryVTT Socket.IO connection
      // and the 40+ tools that don't need a module at all.
      if (this.moduleBridge) {
        try {
          await this.moduleBridge.start();
        } catch (error) {
          this.bridgeError = error instanceof Error ? error.message : String(error);
          logger.error(
            'Module bridge failed to start — canvas-only tools (capture_scene) will report unavailable; all other tools are unaffected:',
            error,
          );
          this.moduleBridge = null;
          this.headlessGmSession = null;
        }
      }

      // Same best-effort isolation as the module bridge itself: a browser
      // that fails to launch (none installed) must never take
      // down the Socket.IO connection or the module bridge's WS server —
      // canvas-only tools just report unavailable until this resolves.
      // Login happens in the background after this resolves (Foundry may
      // still be booting); see HeadlessGmSession.start().
      if (this.headlessGmSession) {
        try {
          await this.headlessGmSession.start();
        } catch (error) {
          // Kept for status / get_health_status: the session is dropped, so
          // without it they would read "disabled".
          this.headlessLaunchError = error instanceof Error ? error.message : String(error);
          logger.error(
            'Headless GM session failed to launch — the companion module cannot connect, so canvas-only tools will be unavailable:',
            error,
          );
          this.headlessGmSession = null;
        }
      }
    } catch (error) {
      if (isRefusal(error)) {
        // Expected (e.g. no world launched yet): one line, no stack.
        logger.warn(`Could not connect to FoundryVTT: ${(error as Error).message}`);
      } else {
        logger.error('Failed to connect to FoundryVTT:', error);
      }
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
    logger.info('Executing tool', { name, args: redactToolArgs(args) });

    try {
      await this.waitForReconnection(toolDependency(name));
      if (needsBridge(name, args)) {
        await this.waitForModule();
      } else if (prefersBridge(name) && this.foundryClient.isWriteEnabled()) {
        await this.waitForModuleIfComing();
      }
      return (await routeToolRequest(
        name,
        args,
        this.foundryClient,
        this.diagnosticsClient,
        this.diagnosticSystem,
        this.moduleBridge,
        this.headlessGmSession,
        this.healthRuntime(),
      )) as CallToolResult;
    } catch (error) {
      if (isRefusal(error)) {
        // Turned down by design (e.g. an outdated journal page version): the
        // caller is told why; the log needs one line, not a stack.
        logger.warn('Tool call refused', { name, reason: refusalReason(error) });
      } else {
        logger.error('Tool execution failed:', error);
      }

      if (error instanceof McpError) {
        throw error;
      }

      throw new McpError(
        ErrorCode.InternalError,
        `Tool execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * A call that needs the socket, made while the connection is being
   * restored, waits for it (a write keeps its place in the write queue
   * meanwhile), then is refused with the reason if it is still down: reads
   * would answer from a cache nobody keeps live, and nothing may be sent on
   * an anonymous socket. Calls that never touch the socket (module, REST,
   * local, health) go ahead at once; see {@link toolDependency}.
   */
  private async waitForReconnection(dependency: ToolDependency | undefined): Promise<void> {
    if (!waitsForSocket(dependency) || !this.foundryClient.isReconnecting()) {
      return;
    }
    if (await this.foundryClient.waitUntilConnected(TOOL_RECONNECT_WAIT_MS)) {
      return;
    }
    const { state, error } = this.foundryClient.connectionStatus();
    throw refusalError(
      ErrorCode.InvalidRequest,
      `Reconnecting to FoundryVTT… (${state}${error ? `: ${error}` : ''}). ` +
        'The connector retries on its own; try again in a moment.',
    );
  }

  /**
   * A call that needs the companion module waits for it while the headless
   * page is on its way (browser starting, /game loading, page reconnecting,
   * just logged in), up to {@link BRIDGE_CONNECT_WAIT_MS}. It is refused at
   * once when the module cannot come: the bridge is disabled or failed to
   * start, the browser could not be launched, no headless session is
   * configured, the session is failing, or the page has been logged in for
   * more than {@link BRIDGE_LOGGED_IN_GRACE_MS} without a module.
   */
  private async waitForModule(): Promise<void> {
    const bridge = this.moduleBridge;
    if (bridge?.isConnected()) {
      return;
    }
    const refuse = (reason: string) =>
      refusalError(ErrorCode.InvalidRequest, `The companion module is not connected: ${reason}`);
    if (!bridge) {
      throw refuse(
        this.bridgeError !== null
          ? `the module bridge failed to start (${this.bridgeError}). Fix the cause (often the port is taken), then restart the shared process (foundryvtt-mcp stop).`
          : 'the module bridge is disabled. Set FOUNDRY_MODULE_BRIDGE_ENABLED=true and install the companion Foundry module.',
      );
    }
    const session = this.headlessGmSession;
    if (!session) {
      throw refuse(
        this.headlessLaunchError !== null
          ? `the headless GM browser could not be launched (${this.headlessLaunchError}).`
          : 'no headless GM session is configured (FOUNDRY_HEADLESS_GM_ENABLED and credentials), and the module only connects from it.',
      );
    }
    if (session.isRetrying()) {
      throw refuse(
        `the headless GM session is failing and retries on its own — ${session.statusText()}`,
      );
    }
    const loggedInSince = session.loggedInSince();
    if (loggedInSince !== null && Date.now() - loggedInSince > BRIDGE_LOGGED_IN_GRACE_MS) {
      throw refuse(
        'the headless GM page is logged in but the module has not connected; the watchdog reloads the page. Check that the companion module is enabled in the world.',
      );
    }
    if (await bridge.waitUntilConnected(BRIDGE_CONNECT_WAIT_MS)) {
      return;
    }
    throw refuse(
      `still waiting for it after ${BRIDGE_CONNECT_WAIT_MS / 1000} s — ${session.statusText()}. Try again in a moment.`,
    );
  }

  /**
   * For a tool that only prefers the module ({@link prefersBridge}): the same
   * wait as {@link waitForModule}, but a module that cannot come, or does not
   * come in time, leaves the call to go ahead on its socket path.
   */
  private async waitForModuleIfComing(): Promise<void> {
    try {
      await this.waitForModule();
    } catch (error) {
      if (!isRefusal(error)) {
        throw error;
      }
      logger.debug('Going ahead without the companion module', { reason: refusalReason(error) });
    }
  }

  /** Logs {@link gamemasterAccountWarning} after each authentication. */
  private warnIfGamemaster(): void {
    const warning = gamemasterAccountWarning(this.sharedAccount, this.foundryClient.accountInfo());
    if (warning) {
      logger.warn(warning);
    }
  }

  private healthRuntime(): HealthRuntime {
    const configuration = configurationSummary();
    return {
      ...(this.options.relays ? { relays: this.options.relays() } : {}),
      ...(this.headlessLaunchError ? { headlessLaunchError: this.headlessLaunchError } : {}),
      bridgeState: this.bridgeState(),
      sharedAccount: this.headlessGmSession?.mode() === 'shared',
      ...(configuration ? { configuration } : {}),
      ...(this.bridgeError ? { bridgeError: this.bridgeError } : {}),
    };
  }

  /** Reads one `foundry://` resource; failures surface as {@link McpError}. */
  async readResource(uri: string): Promise<ReadResourceResult> {
    logger.info('Reading resource', { uri });

    try {
      await this.waitForReconnection(resourceDependency(uri));
      return (await routeResourceRequest(
        uri,
        this.foundryClient,
        this.diagnosticsClient,
      )) as ReadResourceResult;
    } catch (error) {
      if (isRefusal(error)) {
        logger.warn('Resource read refused', { uri, reason: refusalReason(error) });
      } else {
        logger.error('Resource read failed:', error);
      }

      if (error instanceof McpError) {
        throw error;
      }

      throw new McpError(
        ErrorCode.InternalError,
        `Resource read failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  private bridgeState(): BridgeState {
    if (!config.moduleBridge.enabled) {
      return 'disabled';
    }
    if (this.bridgeError !== null) {
      return 'failed';
    }
    return this.moduleBridge?.isListening() ? 'listening' : 'not-started';
  }

  private headlessGmState(): HeadlessGmState {
    if (this.headlessLaunchError !== null) {
      return 'launch-failed';
    }
    if (!this.headlessGmConfigured) {
      return 'disabled';
    }
    return this.headlessGmSession?.isStarted() ? 'running' : 'not-started';
  }

  status(): CoreStatus {
    const bridgeState = this.bridgeState();
    const headlessGmState = this.headlessGmState();
    const account = this.foundryClient.accountInfo();
    return {
      foundryConnected: this.foundryClient.isConnected(),
      foundryConnection: this.foundryClient.connectionStatus(),
      staleCache: this.foundryClient.worldDataStaleness(),
      account: account
        ? {
            name: account.name,
            role: account.role === null ? null : roleLabel(account.role),
            warning: gamemasterAccountWarning(this.sharedAccount, account),
          }
        : null,
      bridge: {
        // Kept for `status` commands older than `state`: true only while listening.
        enabled: bridgeState === 'listening',
        state: bridgeState,
        error: this.bridgeError,
        port: config.moduleBridge.port,
        moduleConnected: this.moduleBridge?.isConnected() ?? false,
        protocol: BRIDGE_PROTOCOL_VERSION,
        origin: new URL(config.foundry.url).origin,
        moduleConnectedSince: this.moduleBridge?.moduleConnectedSince()?.toISOString() ?? null,
        moduleVersion: this.moduleBridge?.moduleAnnouncement().version ?? null,
        moduleInstalledVersion: this.foundryClient.installedModuleVersion(BRIDGE_MODULE_ID),
        moduleCommands: this.moduleBridge?.moduleAnnouncement().commands ?? null,
      },
      headlessGm: {
        enabled: headlessGmState !== 'disabled',
        active: this.headlessGmSession?.isActive() ?? false,
        status: this.headlessGmSession?.statusText() ?? null,
        launchError: this.headlessLaunchError,
        state: headlessGmState,
        mode: this.headlessGmSession?.mode() ?? null,
        modeText: this.headlessGmSession?.modeText() ?? null,
        sessionState: this.headlessGmSession?.sessionState() ?? null,
        browser: this.headlessGmSession?.browserInfo() ?? null,
      },
      writeQueue: this.writeQueue.pending,
    };
  }
}
