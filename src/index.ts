#!/usr/bin/env node

/**
 * FoundryVTT Model Context Protocol Server
 *
 * This server provides integration between FoundryVTT and AI models through the Model Context Protocol (MCP).
 * It enables AI assistants to interact with FoundryVTT instances for RPG campaign management,
 * character handling, and game automation.
 *
 * One binary, several roles (first argument):
 * - (none)        MCP stdio server. By default a lightweight relay to the shared
 *                 process; with `FOUNDRY_MCP_SHARED=false`, the all-in-one server.
 * - `daemon`      the shared process owning the FoundryVTT connection.
 * - `status`      print the shared process's state.
 * - `stop`        stop the shared process.
 * - `init`        write the configuration file interactively; `init --check`
 *                 checks the existing configuration without writing anything.
 * - `daemon-launch` internal: starts `daemon` detached and exits (see shared/spawn.ts).
 *
 * Each role is imported on demand so the relay and the control commands do
 * not load Socket.IO or Playwright.
 *
 * @fileoverview Main entry point for the FoundryVTT MCP Server
 * @see {@link https://github.com/anthropics/mcp} Model Context Protocol
 * @see {@link https://foundryvtt.com/} FoundryVTT Virtual Tabletop
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** This script, re-run by the relay to start the shared process. */
const ENTRY = fileURLToPath(import.meta.url);

async function main(role: string | undefined): Promise<void> {
  switch (role) {
    case 'status': {
      const { runStatus } = await import('./shared/control.js');
      process.exit(await runStatus());
      break;
    }
    case 'stop': {
      const { runStop } = await import('./shared/control.js');
      process.exit(await runStop());
      break;
    }
    case 'init': {
      const { runInit } = await import('./cli/init.js');
      process.exit(await runInit(process.argv.slice(3), ENTRY));
      break;
    }
    case 'daemon-launch': {
      const { runDaemonLauncher } = await import('./shared/spawn.js');
      runDaemonLauncher(ENTRY);
      break;
    }
    case 'daemon': {
      const { runDaemon } = await import('./shared/daemon.js');
      await runDaemon();
      break;
    }
    case undefined: {
      // Read without validating: with no usable configuration yet the relay
      // (or the all-in-one server) still starts and explains it on each call.
      const { resolveSettings } = await import('./config/sources.js');
      if (resolveSettings().values.FOUNDRY_MCP_SHARED !== 'false') {
        const { runRelay } = await import('./shared/relay.js');
        await runRelay(ENTRY);
      } else {
        const { runAllInOne } = await import('./server.js');
        await runAllInOne();
      }
      break;
    }
    default:
      process.stderr.write(
        `Unknown command: ${role}\nUsage: foundryvtt-mcp [init [--check] | daemon | status | stop]\n`,
      );
      process.exit(2);
  }
}

// Run the server if this file is executed directly.
// Use realpath so the comparison works when npm/npx installs the bin as a
// symlink into node_modules/.bin (the literal `file://${argv[1]}` compare
// fails for symlinked invocations and on macOS where /tmp -> /private/tmp).
const isMainModule = (() => {
  const argv1 = process.argv[1];
  if (!argv1) {
    return false;
  }
  try {
    return realpathSync(argv1) === ENTRY;
  } catch {
    return import.meta.url === `file://${argv1}`;
  }
})();

if (isMainModule) {
  main(process.argv[2]).catch((error: unknown) => {
    process.stderr.write(
      `FoundryVTT MCP Server startup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
}
