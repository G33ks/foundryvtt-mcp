/**
 * @fileoverview `foundryvtt-mcp status` and `foundryvtt-mcp stop`.
 *
 * Connect as a `control` peer: no version/config check (so a terminal with
 * no FoundryVTT configuration can still inspect or stop the process), and
 * not counted as a relay for the idle timeout. Must not import the config
 * or the logger.
 */

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
  lines.push(`  FoundryVTT:     ${status.foundryConnected ? 'connected' : 'not connected'}`);
  if (status.startupError) {
    lines.push(`  Startup error:  ${status.startupError}`);
  }
  lines.push(
    bridge?.enabled
      ? `  Module bridge:  listening on port ${bridge.port}, ` +
          (bridge.protocol === undefined
            ? // A shared process from before bridge authentication.
              `no authentication, module connected: ${yesNo(bridge.moduleConnected)}`
            : `protocol v${bridge.protocol}, authenticated module connected: ` +
              yesNo(bridge.moduleConnected) +
              (bridge.moduleConnectedSince ? ` (since ${bridge.moduleConnectedSince})` : ''))
      : '  Module bridge:  disabled',
  );
  if (bridge?.enabled && bridge.origin) {
    lines.push(`  Bridge origin:  ${bridge.origin}`);
  }
  lines.push(
    headlessGm?.launchError
      ? `  Headless GM:    browser launch failed — ${headlessGm.launchError}`
      : headlessGm?.enabled
        ? `  Headless GM:    ${headlessGm.active ? 'logged in' : 'not logged in'} (${headlessGm.status})`
        : '  Headless GM:    disabled',
  );
  lines.push(`  Endpoint:       ${status.endpoint}`, `  Log:            ${status.logFile}`);
  return lines;
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
    return EXIT_NOT_RUNNING;
  }
  try {
    const status = DaemonStatusSchema.parse(await connection.request('status'));
    for (const line of formatStatus(status)) {
      console.log(line);
    }
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
