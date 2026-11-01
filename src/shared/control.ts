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
import { DaemonStatusSchema, PROTOCOL_VERSION, StopReplySchema } from './protocol.js';
import { readStateFile } from './state-file.js';
import { readExistingToken } from './token.js';
import { packageVersion } from './version.js';

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
      version: packageVersion(),
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
    const { bridge, headlessGm } = status;
    console.log('Shared process: running');
    console.log(`  PID:            ${status.pid}`);
    console.log(`  Version:        ${status.version}`);
    console.log(
      `  Uptime:         ${formatUptime(status.uptimeSeconds)} (since ${status.startedAt})`,
    );
    console.log(`  Relays:         ${status.relays} connected`);
    console.log(`  Calls running:  ${status.inFlight}`);
    if (status.writeQueue !== undefined) {
      console.log(`  Write queue:    ${status.writeQueue} pending`);
    }
    console.log(`  FoundryVTT:     ${status.foundryConnected ? 'connected' : 'not connected'}`);
    if (status.startupError) {
      console.log(`  Startup error:  ${status.startupError}`);
    }
    console.log(
      bridge?.enabled
        ? `  Module bridge:  listening on port ${bridge.port}, module connected: ${yesNo(bridge.moduleConnected)}`
        : '  Module bridge:  disabled',
    );
    console.log(
      headlessGm?.enabled
        ? `  Headless GM:    ${headlessGm.active ? 'logged in' : 'not logged in'} (${headlessGm.status})`
        : '  Headless GM:    disabled',
    );
    console.log(`  Endpoint:       ${status.endpoint}`);
    console.log(`  Log:            ${status.logFile}`);
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
