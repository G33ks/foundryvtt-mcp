/**
 * @fileoverview Per-user locations used by the shared process: the state
 * directory (token, state file, logs) and the IPC endpoint relays dial.
 *
 * Kept free of config/logger imports: `status` and `stop` resolve these
 * paths without a valid FoundryVTT configuration.
 */

import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Longest Unix socket path we bind to; `sun_path` is 104 bytes on macOS, 108 on Linux. */
const MAX_UNIX_SOCKET_PATH = 100;

export interface SharedPaths {
  /** Per-user state directory, created with owner-only permissions. */
  stateDir: string;
  /** Named pipe (Windows) or Unix socket the shared process listens on. */
  endpoint: string;
  /** Secret token relays must present at the handshake. */
  tokenFile: string;
  /** `{ pid, version, startedAt, endpoint, logFile }` of the running shared process. */
  stateFile: string;
  /** Shared process log (rotated). */
  daemonLog: string;
  /** Relay log (rotated, written by every relay). */
  relayLog: string;
}

/** Sanitised OS user name, safe inside a pipe name or file name. */
function userTag(): string {
  let name: string;
  try {
    name = os.userInfo().username;
  } catch {
    name = process.env.USERNAME ?? process.env.USER ?? 'user';
  }
  return name.replace(/[^A-Za-z0-9_.-]/g, '_') || 'user';
}

/**
 * `%LOCALAPPDATA%\foundryvtt-mcp` on Windows, `$XDG_STATE_HOME/foundryvtt-mcp`
 * or `~/.local/state/foundryvtt-mcp` elsewhere.
 */
export function defaultStateDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'foundryvtt-mcp');
  }
  const base = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'foundryvtt-mcp');
}

/**
 * The IPC endpoint. A Unix socket path longer than `sun_path` allows cannot
 * be bound, so a deep state directory falls back to a private directory
 * under the system temp dir.
 */
export function endpointFor(
  stateDir: string,
  platform: NodeJS.Platform = process.platform,
  user: string = userTag(),
): string {
  if (platform === 'win32') {
    return `\\\\.\\pipe\\foundryvtt-mcp-${user}`;
  }
  const preferred = path.join(stateDir, 'daemon.sock');
  if (Buffer.byteLength(preferred) <= MAX_UNIX_SOCKET_PATH) {
    return preferred;
  }
  return path.join(os.tmpdir(), `foundryvtt-mcp-${user}`, 'daemon.sock');
}

/** Resolves every shared-process path and creates the directories they live in. */
export function resolveSharedPaths(stateDir: string = defaultStateDir()): SharedPaths {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const endpoint = endpointFor(stateDir);
  if (process.platform !== 'win32') {
    mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  }
  return {
    stateDir,
    endpoint,
    tokenFile: path.join(stateDir, 'token'),
    stateFile: path.join(stateDir, 'daemon.json'),
    daemonLog: path.join(stateDir, 'daemon.log'),
    relayLog: path.join(stateDir, 'relay.log'),
  };
}
