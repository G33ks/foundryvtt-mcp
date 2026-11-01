#!/usr/bin/env node
/**
 * Phase 0 spike: does a detached child survive the MCP client killing the
 * stdio server (and its process tree / Job Object)?
 *
 * Roles (same file):
 *   node scripts/spike-detached.mjs          MCP stdio server exposing `spike_ping`
 *   node scripts/spike-detached.mjs child    detached heartbeat child (singleton)
 *   node scripts/spike-detached.mjs launch   intermediate launcher (spawns child, exits)
 *   node scripts/spike-detached.mjs status   print the heartbeat and the logs' tail
 *   node scripts/spike-detached.mjs stop     kill the heartbeat child
 *
 * The child holds a named pipe / Unix socket as a single-instance lock and
 * writes { pid, startedAt, lastBeat, beats } to heartbeat.json every second.
 * State lives in %LOCALAPPDATA%\foundryvtt-mcp\spike (Windows) or
 * $XDG_STATE_HOME|~/.local/state/foundryvtt-mcp/spike elsewhere.
 *
 * Throwaway code: not part of the build, delete once the spike is settled.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const SCRIPT = fileURLToPath(import.meta.url);
const USER = os.userInfo().username.replace(/[^A-Za-z0-9_.-]/g, '_');

function stateDir() {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const dir = path.join(base, 'foundryvtt-mcp', 'spike');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const DIR = stateDir();
const HEARTBEAT = path.join(DIR, 'heartbeat.json');
const RELAY_LOG = path.join(DIR, 'relay.log');
const CHILD_LOG = path.join(DIR, 'child.log');
const LOCK_PATH =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\foundryvtt-mcp-spike-${USER}`
    : path.join(DIR, 'spike.sock');

function log(file, msg) {
  try {
    fs.appendFileSync(file, `${new Date().toISOString()} [pid ${process.pid}] ${msg}\n`);
  } catch {
    // logging must never break the spike
  }
}

function readHeartbeat() {
  // The child rewrites the file every second; retry a torn read.
  for (let i = 0; i < 3; i++) {
    try {
      return JSON.parse(fs.readFileSync(HEARTBEAT, 'utf8'));
    } catch {
      // missing or mid-write
    }
  }
  return null;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function freshHeartbeat() {
  const hb = readHeartbeat();
  if (!hb || !isAlive(hb.pid)) return null;
  if (Date.now() - Date.parse(hb.lastBeat) > 3000) return null;
  return hb;
}

// ---------------------------------------------------------------- child ----

function runChild() {
  const lock = net.createServer((sock) => sock.end());
  lock.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(CHILD_LOG, 'lock already held, another child is running: exiting');
      process.exit(0);
    }
    log(CHILD_LOG, `lock error: ${err.stack}`);
    process.exit(1);
  });

  const listen = () =>
    lock.listen(LOCK_PATH, () => {
      const startedAt = new Date().toISOString();
      let beats = 0;
      log(CHILD_LOG, `child started (ppid ${process.ppid}), lock ${LOCK_PATH}`);
      const beat = () => {
        beats++;
        const hb = { pid: process.pid, startedAt, lastBeat: new Date().toISOString(), beats };
        try {
          fs.writeFileSync(HEARTBEAT, JSON.stringify(hb));
        } catch (err) {
          log(CHILD_LOG, `heartbeat write failed: ${err.message}`);
        }
      };
      beat();
      setInterval(beat, 1000);
    });

  // A Unix socket file left by a crash makes listen() fail with EADDRINUSE
  // even though nobody listens: probe it and remove it if stale.
  if (process.platform !== 'win32' && fs.existsSync(LOCK_PATH)) {
    const probe = net.connect(LOCK_PATH);
    probe.on('connect', () => {
      probe.destroy();
      log(CHILD_LOG, 'lock already held, another child is running: exiting');
      process.exit(0);
    });
    probe.on('error', () => {
      fs.rmSync(LOCK_PATH, { force: true });
      listen();
    });
  } else {
    listen();
  }

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    process.on(sig, () => {
      log(CHILD_LOG, `received ${sig}: exiting`);
      process.exit(0);
    });
  }
  process.on('exit', (code) => log(CHILD_LOG, `child exit code ${code}`));
}

// ---------------------------------------------------------------- relay ----

function spawnDetached(role) {
  const child = spawn(process.execPath, [SCRIPT, role], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
    cwd: process.cwd(),
  });
  child.unref();
  return child.pid;
}

// SPIKE_SPAWN=direct: relay -> child. Its ParentProcessId stays the relay's
// pid, so `taskkill /T` on the relay kills the child too.
// Default (launcher): relay -> launcher -> child, launcher exits at once and
// the child is orphaned, out of reach of a tree kill.
function spawnChild() {
  const direct = process.env.SPIKE_SPAWN === 'direct';
  const pid = spawnDetached(direct ? 'child' : 'launch');
  log(RELAY_LOG, `spawned ${direct ? 'child' : 'launcher'} pid ${pid}`);
}

function runLauncher() {
  const pid = spawnDetached('child');
  log(CHILD_LOG, `launcher (ppid ${process.ppid}) spawned child pid ${pid}`);
  process.exit(0);
}

async function ensureChild() {
  let hb = freshHeartbeat();
  if (hb) return { hb, spawned: false };
  spawnChild();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    hb = freshHeartbeat();
    if (hb) return { hb, spawned: true };
  }
  throw new Error(`child did not produce a heartbeat within 5s (see ${CHILD_LOG})`);
}

async function runRelay() {
  log(
    RELAY_LOG,
    `relay started (ppid ${process.ppid}, cwd ${process.cwd()}, node ${process.version})`
  );
  process.stdin.on('end', () => log(RELAY_LOG, 'relay stdin closed'));
  process.on('exit', (code) => log(RELAY_LOG, `relay exit code ${code}`));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    process.on(sig, () => {
      log(RELAY_LOG, `relay received ${sig}`);
      process.exit(0);
    });
  }

  const server = new Server(
    { name: 'foundryvtt-mcp-spike', version: '0.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'spike_ping',
        description:
          'Spike: start the detached heartbeat child if needed and report its pid and age.',
        inputSchema: {
          type: 'object',
          properties: {
            delay_ms: {
              type: 'number',
              description: 'Optional delay before answering (0-10000 ms), to overlap calls.',
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'spike_ping') {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
    const delay = Math.min(Math.max(Number(request.params.arguments?.delay_ms) || 0, 0), 10000);
    if (delay) await new Promise((r) => setTimeout(r, delay));

    const { hb, spawned } = await ensureChild();
    const result = {
      child_pid: hb.pid,
      child_started_at: hb.startedAt,
      child_age_s: Math.round((Date.now() - Date.parse(hb.startedAt)) / 1000),
      child_beats: hb.beats,
      last_beat_ms_ago: Date.now() - Date.parse(hb.lastBeat),
      spawned_by_this_call: spawned,
      relay_pid: process.pid,
      relay_ppid: process.ppid,
      state_dir: DIR,
    };
    log(RELAY_LOG, `spike_ping -> ${JSON.stringify(result)}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  await server.connect(new StdioServerTransport());
}

// -------------------------------------------------------------- commands ---

function tail(file, n) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n');
  } catch {
    return '(none)';
  }
}

function runStatus() {
  const hb = readHeartbeat();
  console.log(`state dir: ${DIR}`);
  if (!hb) {
    console.log('no heartbeat file');
  } else {
    const alive = isAlive(hb.pid);
    console.log(
      `child pid ${hb.pid} (${alive ? 'alive' : 'DEAD'}), started ${hb.startedAt}, ` +
        `age ${Math.round((Date.now() - Date.parse(hb.startedAt)) / 1000)}s, ` +
        `beats ${hb.beats}, last beat ${Date.now() - Date.parse(hb.lastBeat)}ms ago`
    );
  }
  console.log(`\n--- child.log (last 10) ---\n${tail(CHILD_LOG, 10)}`);
  console.log(`\n--- relay.log (last 20) ---\n${tail(RELAY_LOG, 20)}`);
}

function runStop() {
  const hb = readHeartbeat();
  if (!hb || !isAlive(hb.pid)) {
    console.log('no running child');
    return;
  }
  process.kill(hb.pid);
  console.log(`killed child pid ${hb.pid}`);
}

const mode = process.argv[2];
if (mode === 'child') runChild();
else if (mode === 'launch') runLauncher();
else if (mode === 'status') runStatus();
else if (mode === 'stop') runStop();
else
  runRelay().catch((err) => {
    log(RELAY_LOG, `relay failed: ${err.stack}`);
    process.exit(1);
  });
