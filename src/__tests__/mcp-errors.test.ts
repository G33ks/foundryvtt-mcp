/**
 * @fileoverview Errors as an MCP client sees them (G33ks/foundryvtt-mcp#15):
 * exactly one "MCP error <code>: " prefix, the code and the data kept, in
 * both modes — through a relay to a shared process, and all-in-one.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  type CallToolResult,
  CallToolResultSchema,
  ErrorCode,
  McpError,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreStatus } from '../core.js';
import { createMcpServer, type McpBackend } from '../mcp-server.js';
import { SharedProcess } from '../shared/daemon.js';
import { DaemonLink } from '../shared/daemon-link.js';
import type { SharedPaths } from '../shared/paths.js';
import { PROTOCOL_VERSION } from '../shared/protocol.js';
import { bareMessage, withBareErrors } from '../utils/mcp-errors.js';
import { refusalError } from '../utils/refusal.js';

const TOKEN = 'e'.repeat(64);

/** What the core throws for each tool, as FoundryCore surfaces its failures. */
function coreError(name: string): McpError {
  switch (name) {
    case 'bad_params':
      return new McpError(ErrorCode.InvalidParams, 'Missing required parameter: formula', {
        parameter: 'formula',
      });
    case 'refused':
      return refusalError(
        ErrorCode.InvalidRequest,
        'Reconnecting to FoundryVTT… (disconnected: the socket dropped).',
      );
    default:
      return new McpError(ErrorCode.InternalError, 'Tool execution failed: boom');
  }
}

const throwingCore = {
  callTool: async (name: string): Promise<CallToolResult> => {
    throw coreError(name);
  },
  readResource: async (): Promise<never> => {
    throw new McpError(ErrorCode.InvalidParams, 'Unknown resource URI: foundry://nope');
  },
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A client connected to `backend` through createMcpServer, and every message the server sent. */
async function clientFor(backend: McpBackend) {
  const server = createMcpServer(backend);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const sent: JSONRPCMessage[] = [];
  const send = serverSide.send.bind(serverSide);
  serverSide.send = (message, options) => {
    sent.push(message);
    return send(message, options);
  };
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, sent };
}

/** A shared process running `throwingCore`, and the relay's backend in front of it. */
async function relayBackend(): Promise<McpBackend> {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'fvtt-mcp-errors-'));
  const tag = `fvtt-mcp-errors-${process.pid}-${randomBytes(4).toString('hex')}`;
  const paths: SharedPaths = {
    stateDir,
    endpoint:
      process.platform === 'win32' ? `\\\\.\\pipe\\${tag}` : path.join(stateDir, 'daemon.sock'),
    tokenFile: path.join(stateDir, 'token'),
    stateFile: path.join(stateDir, 'daemon.json'),
    daemonLog: path.join(stateDir, 'daemon.log'),
    relayLog: path.join(stateDir, 'relay.log'),
  };
  const shared = new SharedProcess({
    paths,
    version: '1.0.0',
    token: TOKEN,
    configHash: 'cfg',
    createCore: async () => ({
      start: async () => {},
      shutdown: async () => {},
      status: () => ({}) as CoreStatus,
      ...throwingCore,
    }),
    exit: vi.fn(),
    shutdownGraceMs: 1000,
  });
  expect(await shared.start()).toBe('listening');
  const link = new DaemonLink({
    endpoint: paths.endpoint,
    logFile: paths.daemonLog,
    hello: () => ({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      role: 'relay',
      version: '1.0.0',
      configHash: 'cfg',
      token: TOKEN,
    }),
    spawnDaemon: () => {},
    readyTimeoutMs: 5000,
    drainTimeoutMs: 5000,
  });
  cleanups.push(async () => {
    link.close();
    await shared.drainAndExit('test cleanup');
    rmSync(stateDir, { recursive: true, force: true });
  });
  // As the relay does (src/shared/relay.ts).
  return {
    callTool: async (name, args) => CallToolResultSchema.parse(await link.call('tool', name, args)),
    readResource: async (uri) => ReadResourceResultSchema.parse(await link.call('resource', uri)),
  };
}

const errorOf = (attempt: Promise<unknown>) =>
  attempt.then(
    () => {
      throw new Error('expected an error');
    },
    (error: unknown) => error as McpError,
  );

describe.each([
  ['through a relay to the shared process', relayBackend],
  ['all-in-one', async (): Promise<McpBackend> => throwingCore],
])('errors seen by an MCP client, %s', (_mode, backend) => {
  it.each([
    [
      'bad_params',
      ErrorCode.InvalidParams,
      'MCP error -32602: Missing required parameter: formula',
      { parameter: 'formula' },
    ],
    [
      'refused',
      ErrorCode.InvalidRequest,
      'MCP error -32600: Reconnecting to FoundryVTT… (disconnected: the socket dropped).',
      { refusal: true },
    ],
    ['boom', ErrorCode.InternalError, 'MCP error -32603: Tool execution failed: boom', undefined],
  ])('%s: code %i, one prefix, data kept', async (name, code, message, data) => {
    const { client, sent } = await clientFor(await backend());

    const error = await errorOf(client.callTool({ name, arguments: {} }));

    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
    if (data === undefined) {
      expect(error.data).toBeUndefined();
    } else {
      expect(error.data).toMatchObject(data);
    }
    // On the wire, the bare text: the client adds the prefix.
    const wire = sent.find((m) => 'error' in m) as { error: { message: string } } | undefined;
    expect(wire?.error.message).toBe(message.replace(/^MCP error -?\d+: /, ''));
  });

  it('resource read errors get one prefix too', async () => {
    const { client } = await clientFor(await backend());

    const error = await errorOf(client.readResource({ uri: 'foundry://nope' }));

    expect(error.message).toBe('MCP error -32602: Unknown resource URI: foundry://nope');
  });
});

describe('withBareErrors', () => {
  it('strips the prefix of an McpError and keeps code and data', async () => {
    const error = await errorOf(
      withBareErrors(async () => {
        throw new McpError(ErrorCode.InvalidParams, 'x', { a: 1 });
      }),
    );
    expect(error).not.toBeInstanceOf(McpError);
    expect(error).toMatchObject({ code: -32602, message: 'x', data: { a: 1 } });
  });

  it('leaves other errors alone', async () => {
    const boom = new Error('plain');
    await expect(
      withBareErrors(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it('bareMessage strips one prefix', () => {
    expect(bareMessage(new McpError(ErrorCode.InvalidRequest, 'refused'))).toBe('refused');
  });
});
