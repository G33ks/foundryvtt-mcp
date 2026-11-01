/**
 * @fileoverview Starting the shared process so it outlives the relay.
 *
 * The relay starts `daemon-launch`, which starts `daemon` and exits at once.
 * A direct detached child keeps the relay as its parent pid, so a tree kill
 * of the relay (`taskkill /T`) takes it down too; through the short-lived
 * launcher the shared process is orphaned and out of reach of a tree kill.
 * Detached children also leave the MCP client's kill-on-close Job Object
 * (verified with Claude desktop on Windows, see scripts/spike-detached.mjs).
 */

import { spawn } from 'node:child_process';

/**
 * Re-runs this program detached with `role` as its first argument: same
 * Node binary and flags (so `tsx` keeps working), same entry script, same
 * environment and working directory (so configuration resolves the same way).
 */
export function spawnDetachedRole(entry: string, role: 'daemon' | 'daemon-launch'): void {
  const child = spawn(process.execPath, [...process.execArgv, entry, role], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
    cwd: process.cwd(),
  });
  child.on('error', () => {
    // Reported by the relay as "did not become available" with the log path.
  });
  child.unref();
}

/** Relay side: start the shared process through the launcher. */
export function spawnDaemon(entry: string): void {
  spawnDetachedRole(entry, 'daemon-launch');
}

/** `daemon-launch`: start the shared process and exit immediately. */
export function runDaemonLauncher(entry: string): void {
  spawnDetachedRole(entry, 'daemon');
  process.exit(0);
}
