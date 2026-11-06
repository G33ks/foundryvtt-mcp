/**
 * @fileoverview `foundryvtt-mcp status` and `foundryvtt-mcp stop`.
 *
 * Connect as a `control` peer: no version/config check (so a terminal with
 * no FoundryVTT configuration can still inspect or stop the process), and
 * not counted as a relay for the idle timeout. Must not import the config
 * or the logger (`config/sources.ts` resolves settings without validating).
 */

import {
  type ConfigFileState,
  displayValue,
  KNOWN_SETTINGS,
  type ResolvedSettings,
  resolveSettings,
  type SettingSource,
  summarizeSources,
} from '../config/sources.js';
import { describeBrowser } from '../foundry/browser-detect.js';
import { EndpointUnavailableError, IpcConnection } from './ipc-client.js';
import { isEndpointAlive } from './ipc-server.js';
import { resolveSharedPaths, type SharedPaths } from './paths.js';
import {
  type DaemonStatus,
  DaemonStatusSchema,
  PROTOCOL_VERSION,
  StopReplySchema,
} from './protocol.js';
import { readStateFile } from './state-file.js';
import { readExistingToken } from './token.js';
import { buildVersion } from './version.js';

/** Exit code when no shared process is running. */
const EXIT_NOT_RUNNING = 3;

async function connectControl(paths: SharedPaths): Promise<IpcConnection | null> {
  const token = readExistingToken(paths.tokenFile);
  if (!token) {
    return null;
  }
  try {
    return await IpcConnection.connect(paths.endpoint, {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      role: 'control',
      version: buildVersion(),
      configHash: '',
      token,
    });
  } catch (error) {
    if (error instanceof EndpointUnavailableError) {
      return null;
    }
    throw error;
  }
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function formatRelays(status: DaemonStatus): string {
  const outdated = status.outdatedRelays ?? [];
  if (outdated.length === 0) {
    return `${status.relays} connected`;
  }
  return (
    `${status.relays} connected (${outdated.length} on an older build: ` +
    `${outdated.map((v) => `v${v}`).join(', ')} — restart that client)`
  );
}

/** The lines `foundryvtt-mcp status` prints for a running shared process. */
export function formatStatus(status: DaemonStatus): string[] {
  const { bridge, headlessGm } = status;
  const lines = [
    'Shared process: running',
    `  PID:            ${status.pid}`,
    `  Version:        ${status.version}`,
    `  Uptime:         ${formatUptime(status.uptimeSeconds)} (since ${status.startedAt})`,
    `  Relays:         ${formatRelays(status)}`,
    `  Calls running:  ${status.inFlight}`,
  ];
  if (status.writeQueue !== undefined) {
    lines.push(`  Write queue:    ${status.writeQueue} pending`);
  }
  lines.push(`  FoundryVTT:     ${formatFoundryConnection(status)}`);
  if (status.staleCache) {
    lines.push(`  World cache:    ${formatStaleCache(status.staleCache)}`);
  }
  if (status.account) {
    const role = status.account.role ? ` (${status.account.role})` : '';
    lines.push(`  Account:        ${status.account.name}${role}`);
    if (status.account.warning) {
      lines.push(`  Warning:        ${status.account.warning}`);
    }
  }
  if (status.startupError) {
    lines.push(`  Startup error:  ${status.startupError}`);
  }
  const bridgeState = bridge?.state ?? 'disabled';
  const notStarted = status.foundryConnected
    ? 'not started yet'
    : 'not started (FoundryVTT connection failed)';
  lines.push(`  Module bridge:  ${formatBridge(bridge, bridgeState, notStarted)}`);
  if (bridgeState === 'listening' && bridge?.origin) {
    lines.push(`  Bridge origin:  ${bridge.origin}`);
  }
  lines.push(`  Headless GM:    ${formatHeadlessGm(headlessGm, bridgeState, notStarted)}`);
  if (headlessGm?.browser) {
    lines.push(`  Browser:        ${describeBrowser(headlessGm.browser)}`);
  }
  lines.push(`  Endpoint:       ${status.endpoint}`, `  Log:            ${status.logFile}`);
  if (status.config) {
    lines.push('', 'Configuration of the shared process:');
    lines.push(...formatConfig(status.config.file, status.config.settings));
  }
  if (status.relayConfigs && status.relayConfigs.length > 0) {
    lines.push('', 'Clients (settings each relay declared):');
    for (const relay of status.relayConfigs) {
      lines.push(...formatRelayConfig(relay));
    }
  }
  return lines;
}

/** Configuration file line, then one line per setting that is not a default. */
export function formatConfig(
  file: ConfigFileState,
  settings: Array<{ name: string; value: string; source: SettingSource }>,
): string[] {
  const lines = [`  File:           ${formatConfigFile(file)}`];
  if (file.warning) {
    lines.push(`  Warning:        ${file.warning}`);
  }
  if (settings.length === 0) {
    lines.push('  Settings:       none set (defaults only)');
  }
  const width = Math.max(0, ...settings.map((s) => s.name.length));
  for (const setting of settings) {
    lines.push(`    ${setting.name.padEnd(width)} = ${setting.value}  (${setting.source})`);
  }
  return lines;
}

function formatConfigFile(file: ConfigFileState): string {
  if (file.error) {
    return `${file.path} (${file.error})`;
  }
  return `${file.path} (${file.found ? 'found' : 'not found'})`;
}

function formatRelayConfig(relay: NonNullable<DaemonStatus['relayConfigs']>[number]): string[] {
  const name = `  Relay ${relay.pid ?? '(pid unknown)'} (v${relay.version}): `;
  const lines = [
    name +
      (relay.sources === null
        ? 'an older build that does not declare its settings'
        : summarizeSources(relay.sources)),
  ];
  if (relay.ignored === null) {
    lines.push('    served with the shared process configuration; its own differs');
  } else if (relay.ignored.length > 0) {
    lines.push(
      `    served with the shared process configuration; ignored: ${relay.ignored
        .map((s) => `${s.name} (from ${s.source})`)
        .join(', ')}`,
    );
  }
  return lines;
}

/** `status` section for the configuration this command resolves itself. */
export function formatTerminalConfig(settings: ResolvedSettings = resolveSettings()): string[] {
  return [
    '',
    'This terminal (configuration resolved by this command):',
    ...formatConfig(
      settings.file,
      KNOWN_SETTINGS.filter((name) => settings.values[name] !== undefined).map((name) => ({
        name,
        value: displayValue(name, settings.values[name]),
        source: settings.sources[name],
      })),
    ),
  ];
}

/** e.g. "stale since 2026-11-06T13:02:11.000Z — the socket dropped". */
function formatStaleCache(stale: NonNullable<DaemonStatus['staleCache']>): string {
  const since = stale.since ? ` since ${stale.since}` : '';
  const reason = stale.reason ? ` — ${stale.reason}` : '';
  return `stale${since}${reason}`;
}

function formatFoundryConnection(status: DaemonStatus): string {
  if (status.foundryConnected) {
    return 'connected';
  }
  const connection = status.foundryConnection;
  if (!connection || connection.state === 'disconnected') {
    return connection?.error ? `not connected — ${connection.error}` : 'not connected';
  }
  return `not connected (${connection.state}${connection.error ? ` — ${connection.error}` : ''})`;
}

function formatBridge(
  bridge: DaemonStatus['bridge'],
  state: NonNullable<NonNullable<DaemonStatus['bridge']>['state']>,
  notStarted: string,
): string {
  if (!bridge || state === 'disabled') {
    return 'disabled';
  }
  if (state === 'failed') {
    return `failed to start — ${bridge.error ?? 'see the log'}`;
  }
  if (state === 'not-started') {
    return notStarted;
  }
  return (
    `listening on port ${bridge.port}, protocol v${bridge.protocol}, authenticated module connected: ` +
    yesNo(bridge.moduleConnected) +
    (bridge.moduleConnectedSince ? ` (since ${bridge.moduleConnectedSince})` : '')
  );
}

function formatHeadlessGm(
  headlessGm: DaemonStatus['headlessGm'],
  bridgeState: string,
  notStarted: string,
): string {
  if (headlessGm?.launchError) {
    return `browser launch failed — ${headlessGm.launchError}`;
  }
  const state = headlessGm?.state ?? 'disabled';
  if (!headlessGm || state === 'disabled') {
    return 'disabled';
  }
  if (state === 'not-started') {
    return bridgeState === 'failed'
      ? 'not started (the module bridge failed to start)'
      : notStarted;
  }
  const session = headlessGm.active ? 'logged in' : (headlessGm.sessionState ?? 'not logged in');
  return `${session} — ${headlessGm.modeText ?? headlessGm.status ?? ''}`;
}

function printLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

function printNotRunning(paths: SharedPaths): void {
  console.log('Shared process: not running');
  const stale = readStateFile(paths.stateFile);
  if (stale) {
    console.log(`  Stale state file from pid ${stale.pid} (v${stale.version}): ${paths.stateFile}`);
  }
  console.log(`  Endpoint: ${paths.endpoint}`);
  console.log(`  Log:      ${paths.daemonLog}`);
}

export async function runStatus(paths: SharedPaths = resolveSharedPaths()): Promise<number> {
  const connection = await connectControl(paths);
  if (!connection) {
    printNotRunning(paths);
    printLines(formatTerminalConfig());
    return EXIT_NOT_RUNNING;
  }
  try {
    const status = DaemonStatusSchema.parse(await connection.request('status'));
    printLines([...formatStatus(status), ...formatTerminalConfig()]);
    return 0;
  } finally {
    connection.close();
  }
}

export async function runStop(
  paths: SharedPaths = resolveSharedPaths(),
  waitMs = 150_000,
): Promise<number> {
  const connection = await connectControl(paths);
  if (!connection) {
    printNotRunning(paths);
    return EXIT_NOT_RUNNING;
  }
  let pid: number;
  try {
    ({ pid } = StopReplySchema.parse(await connection.request('stop')));
  } finally {
    connection.close();
  }
  console.log(`Stopping shared process ${pid} (waiting for running calls to finish)…`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!(await isEndpointAlive(paths.endpoint))) {
      console.log('Stopped.');
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log(`Still running after ${Math.round(waitMs / 1000)} s; see ${paths.daemonLog}`);
  return 1;
}
