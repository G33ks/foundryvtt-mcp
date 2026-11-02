#!/usr/bin/env node

/**
 * Stress test for shared-process mode, against a live FoundryVTT.
 *
 * Usage (after `npm run build`, with the usual configuration: the configuration
 * file, the environment, or a .env file in the working directory):
 *
 *   node scripts/stress-shared.js [--tool get_world_summary] [--keep]
 *
 * Runs an isolated shared process (its own state dir and pipe, see
 * FOUNDRY_MCP_STATE_DIR) through three scenarios:
 *
 *   1. 5 relays started at once with no shared process: exactly one shared
 *      process starts, every relay's call succeeds, and — when the module
 *      bridge is enabled — the module connects to the bridge.
 *   2. 10 tools/call in parallel spread over several relays: all succeed.
 *   3. Relays killed and relaunched in bursts: every call succeeds, the
 *      shared process keeps its pid and never reconnects to FoundryVTT.
 *
 * Your regular shared process must be stopped first (`foundryvtt-mcp stop`):
 * both would compete for the module bridge port. The isolated process is
 * stopped at the end unless --keep is given. Exit code 0 when every check
 * passes, 1 otherwise.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = resolve(import.meta.dirname, '..');
const entry = join(repoRoot, 'dist', 'index.js');
if (!existsSync(entry)) {
  console.error(`✗ ${entry} not found — run \`npm run build\` first.`);
  process.exit(2);
}
const dist = (path) => import(pathToFileURL(join(repoRoot, 'dist', path)).href);
const { IpcConnection } = await dist('shared/ipc-client.js');
const { defaultStateDir, resolveSharedPaths } = await dist('shared/paths.js');
const { PROTOCOL_VERSION } = await dist('shared/protocol.js');
const { readExistingToken } = await dist('shared/token.js');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const TOOL = option('--tool', 'get_world_summary');
const KEEP = args.includes('--keep');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(ok, label, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) {
    failures++;
  }
}

// ---------------------------------------------------------------- control --

async function control(paths, op) {
  const token = readExistingToken(paths.tokenFile);
  if (!token) {
    return null;
  }
  try {
    const connection = await IpcConnection.connect(paths.endpoint, {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      role: 'control',
      version: 'stress',
      configHash: '',
      token,
    });
    try {
      return await connection.request(op);
    } finally {
      connection.close();
    }
  } catch {
    return null;
  }
}

// The isolated state dir below would also move the configuration file
// (<state dir>/config.env): keep reading the regular one.
const { configFilePath } = await dist('config/sources.js');
const { tryGetConfig } = await dist('config/index.js');
process.env.FOUNDRY_MCP_CONFIG ??= configFilePath();
// Relays answer without a configuration (each call says what is missing),
// so check it here rather than wait for calls that cannot succeed.
const loaded = tryGetConfig();
if ('error' in loaded) {
  console.error(`✗ ${loaded.error.message}`);
  process.exit(2);
}

// The regular (non-isolated) shared process would hold the bridge port.
delete process.env.FOUNDRY_MCP_STATE_DIR;
const regular = await control(resolveSharedPaths(defaultStateDir()), 'status');
if (regular) {
  console.error(
    `✗ Your regular shared process (pid ${regular.pid}) is running. Stop it first:
` +
      '    node dist/index.js stop',
  );
  process.exit(2);
}

// An isolated shared process: own state dir, hence own pipe.
const stateDir = mkdtempSync(join(tmpdir(), 'fvtt-mcp-stress-'));
process.env.FOUNDRY_MCP_STATE_DIR = stateDir;
const env = { ...process.env, FOUNDRY_MCP_SHARED: 'true' };
const paths = resolveSharedPaths(stateDir);
console.log(`State dir: ${stateDir}
Tool: ${TOOL}
`);

// ------------------------------------------------------------------ relay --

class Relay {
  constructor() {
    this.child = spawn(process.execPath, [entry], {
      cwd: process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.buffer = '';
    this.nextId = 1;
    this.waiters = new Map();
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        newline = this.buffer.indexOf('\n');
        try {
          const message = JSON.parse(line);
          this.waiters.get(message.id)?.(message);
          this.waiters.delete(message.id);
        } catch {
          // not JSON-RPC
        }
      }
    });
    this.child.stderr.resume();
    this.child.on('exit', () => {
      for (const [, resolve] of this.waiters) {
        resolve({ error: { message: 'relay exited' } });
      }
      this.waiters.clear();
    });
  }

  rpc(method, params) {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.waiters.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async initialize() {
    const reply = await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'stress-shared', version: '0' },
    });
    this.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    return reply;
  }

  /** Resolves `{ ok, detail }`. */
  async call(tool) {
    const reply = await this.rpc('tools/call', { name: tool, arguments: {} });
    if (reply.error) {
      return { ok: false, detail: reply.error.message };
    }
    if (reply.result?.isError) {
      return { ok: false, detail: JSON.stringify(reply.result.content).slice(0, 200) };
    }
    return { ok: true };
  }

  kill() {
    this.child.kill();
  }

  close() {
    this.child.stdin.end();
  }
}

function countInLog(pattern) {
  try {
    return readFileSync(paths.daemonLog, 'utf8').split('\n').filter((l) => pattern.test(l))
      .length;
  } catch {
    return 0;
  }
}

function summarize(results) {
  const failed = results.filter((r) => !r.ok);
  return failed.length ? `${failed.length} failed: ${failed[0].detail}` : `${results.length} ok`;
}

// -------------------------------------------------------------- scenarios --

const LISTENING = /Shared process \d+ \(v.*\) listening on/;
const CONNECTED = /Connected to FoundryVTT successfully/;

console.log('1. Five relays started at once, no shared process running');
let relays = Array.from({ length: 5 }, () => new Relay());
await Promise.all(relays.map((r) => r.initialize()));
let results = await Promise.all(relays.map((r) => r.call(TOOL)));
check(results.every((r) => r.ok), 'every relay call succeeded', summarize(results));
const status1 = await control(paths, 'status');
check(status1 !== null, 'shared process is running', status1 ? `pid ${status1.pid}` : '');
check(countInLog(LISTENING) === 1, 'exactly one shared process took the endpoint',
  `${countInLog(LISTENING)} listening line(s) in daemon.log`);
check(status1?.relays === 5, '5 relays connected', `${status1?.relays}`);
if (status1?.bridge?.enabled) {
  let status = status1;
  for (let i = 0; i < 60 && !status?.bridge?.moduleConnected; i++) {
    await sleep(1000);
    status = await control(paths, 'status');
  }
  check(status?.bridge?.moduleConnected === true, 'module connected to the bridge',
    `headless GM: ${status?.headlessGm?.status ?? 'disabled'}`);
} else {
  console.log('  - module bridge disabled in this configuration: bridge check skipped');
}
const pid = status1?.pid;

console.log('\n2. Ten tools/call in parallel over several relays');
results = await Promise.all(Array.from({ length: 10 }, (_, i) => relays[i % 3].call(TOOL)));
check(results.every((r) => r.ok), '10 parallel calls succeeded', summarize(results));

console.log('\n3. Relays killed and relaunched in bursts');
const connectedBefore = countInLog(CONNECTED);
for (let round = 1; round <= 5; round++) {
  for (const relay of relays) {
    relay.kill();
  }
  relays = Array.from({ length: 3 }, () => new Relay());
  await Promise.all(relays.map((r) => r.initialize()));
  results = await Promise.all(relays.map((r) => r.call(TOOL)));
  check(results.every((r) => r.ok), `round ${round}: calls through fresh relays succeeded`,
    summarize(results));
}
const status3 = await control(paths, 'status');
check(status3?.pid === pid, 'shared process kept its pid', `${pid} → ${status3?.pid}`);
check(countInLog(CONNECTED) === connectedBefore, 'no FoundryVTT reconnection in the log',
  `${countInLog(CONNECTED)} "Connected to FoundryVTT" line(s), ${connectedBefore} before the bursts`);
check(status3?.foundryConnected === true, 'FoundryVTT still connected');

for (const relay of relays) {
  relay.close();
}
if (!KEEP) {
  await control(paths, 'stop');
}
console.log(`\nLog: ${paths.daemonLog}`);
console.log(failures ? `\n✗ ${failures} check(s) failed` : '\n✓ All checks passed');
process.exit(failures ? 1 : 0);
