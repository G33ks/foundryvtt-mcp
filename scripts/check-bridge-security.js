#!/usr/bin/env node

/**
 * Checks the module bridge's authentication against the running shared
 * process and its connected companion module.
 *
 * Usage (after `npm run build`, while the connector runs with your real
 * configuration and the headless GM session's module is connected):
 *
 *   node scripts/check-bridge-security.js
 *
 * Makes four connection attempts that must all be refused:
 *
 *   1. no Origin header                    → HTTP 403 at the upgrade
 *   2. a foreign Origin                    → HTTP 403 at the upgrade
 *   3. the Foundry Origin, never answering → close 4408
 *   4. the Foundry Origin, a forged proof  → close 4401
 *
 * After each one it asks the shared process (`status`) whether the
 * authenticated module is still connected, on the same connection as before.
 * Needs no FoundryVTT configuration: the port and the accepted Origin come
 * from `status`. Prints no secret, nonce or proof. Exit code 0 when every
 * check passes, 1 when one fails, 2 when the checks cannot run.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

const repoRoot = resolve(import.meta.dirname, '..');
const entry = join(repoRoot, 'dist', 'index.js');
if (!existsSync(entry)) {
  console.error(`✗ ${entry} not found — run \`npm run build\` first.`);
  process.exit(2);
}
const dist = (path) => import(pathToFileURL(join(repoRoot, 'dist', path)).href);
const { IpcConnection } = await dist('shared/ipc-client.js');
const { resolveSharedPaths } = await dist('shared/paths.js');
const { PROTOCOL_VERSION } = await dist('shared/protocol.js');
const { readExistingToken } = await dist('shared/token.js');

/** Longer than the bridge's 5 s authentication window. */
const SILENT_WAIT_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(ok, label, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) {
    failures++;
  }
}

// ---------------------------------------------------------------- control --

const paths = resolveSharedPaths();

async function status() {
  const token = readExistingToken(paths.tokenFile);
  if (!token) {
    return null;
  }
  try {
    const connection = await IpcConnection.connect(paths.endpoint, {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      role: 'control',
      version: 'check-bridge-security',
      configHash: '',
      token,
    });
    try {
      return await connection.request('status');
    } finally {
      connection.close();
    }
  } catch {
    return null;
  }
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(2);
}

let initial = await status();
if (!initial) {
  fail(`No shared process running (endpoint ${paths.endpoint}). Start the connector first.`);
}
if (!initial.bridge?.enabled) {
  fail('The module bridge is disabled in the running configuration (FOUNDRY_MODULE_BRIDGE_ENABLED).');
}
if (initial.bridge.origin === undefined) {
  fail(
    `Shared process ${initial.pid} (v${initial.version}) predates bridge authentication. ` +
      'Rebuild, then restart it: node dist/index.js stop',
  );
}
for (let i = 0; i < 60 && !initial.bridge.moduleConnected; i++) {
  if (i === 0) {
    console.log('Waiting up to 60 s for the authenticated module to connect…');
  }
  await sleep(1000);
  initial = (await status()) ?? initial;
}
if (!initial.bridge.moduleConnected) {
  fail(
    `No authenticated module connected (headless GM: ${initial.headlessGm?.status ?? 'disabled'}). ` +
      `See ${paths.daemonLog}`,
  );
}

const { port, origin, protocol } = initial.bridge;
const since = initial.bridge.moduleConnectedSince;
const url = `ws://127.0.0.1:${port}`;
console.log(`Shared process ${initial.pid}, bridge on port ${port}, protocol v${protocol}`);
console.log(`Accepted Origin: ${origin}`);
console.log(`Authenticated module connected since ${since}\n`);

// --------------------------------------------------------------- attempts --

/**
 * Opens a connection and reports how it ended: `{ status }` when the
 * upgrade was answered with an HTTP error, `{ close, messages }` otherwise.
 * `onMessage` may answer the server.
 */
function attempt(headers, onMessage = () => undefined, timeoutMs = SILENT_WAIT_MS + 5000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, headers.origin ? { origin: headers.origin } : {});
    const messages = [];
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ timedOut: true, messages });
    }, timeoutMs);
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      resolve({ status: res.statusCode });
      ws.terminate();
    });
    ws.on('error', () => undefined);
    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        message = {};
      }
      messages.push(message.type ?? '(untyped)');
      onMessage(ws, message);
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve({ close: code, messages });
    });
  });
}

function describeOutcome(outcome) {
  if (outcome.status !== undefined) {
    return `HTTP ${outcome.status}`;
  }
  if (outcome.timedOut) {
    return 'still open after the wait';
  }
  return `closed with ${outcome.close} after [${outcome.messages.join(', ')}]`;
}

async function moduleStillConnected() {
  const current = await status();
  check(
    current?.bridge?.moduleConnected === true && current.bridge.moduleConnectedSince === since,
    'authenticated module still connected, same connection',
    current?.bridge?.moduleConnected
      ? `since ${current.bridge.moduleConnectedSince}`
      : 'not connected',
  );
}

console.log('1. No Origin header');
let outcome = await attempt({});
check(outcome.status === 403, 'refused at the upgrade with 403', describeOutcome(outcome));
await moduleStillConnected();

console.log('\n2. Foreign Origin');
outcome = await attempt({ origin: 'http://bridge-check.invalid' });
check(outcome.status === 403, 'refused at the upgrade with 403', describeOutcome(outcome));
await moduleStillConnected();

console.log('\n3. Foundry Origin, never answering the challenge');
outcome = await attempt({ origin });
check(
  outcome.close === 4408 && outcome.messages.join() === 'auth_challenge',
  'closed with 4408 after the challenge alone',
  describeOutcome(outcome),
);
await moduleStillConnected();

console.log('\n4. Foundry Origin, forged proof');
outcome = await attempt({ origin }, (ws, message) => {
  if (message.type === 'auth_challenge') {
    ws.send(
      JSON.stringify({
        type: 'auth_response',
        protocol: message.protocol,
        nonce: randomBytes(32).toString('base64'),
        proof: randomBytes(32).toString('base64'),
      }),
    );
  }
});
check(
  outcome.close === 4401 && outcome.messages.join() === 'auth_challenge',
  'closed with 4401, no auth_ok',
  describeOutcome(outcome),
);
await moduleStillConnected();

console.log(`\nLog: ${paths.daemonLog}`);
console.log(failures ? `\n✗ ${failures} check(s) failed` : '\n✓ All checks passed');
process.exit(failures ? 1 : 0);
