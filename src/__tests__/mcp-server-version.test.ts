import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

async function announcedVersion(): Promise<string | undefined> {
  const { createMcpServer } = await import('../mcp-server.js');
  const server = createMcpServer({
    callTool: async () => ({ content: [] }),
    readResource: async () => ({ contents: [] }),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const version = client.getServerVersion()?.version;
  await client.close();
  await server.close();
  return version;
}

describe('initialize', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let dir: string;

  beforeEach(() => {
    originalEnv = process.env;
    dir = mkdtempSync(join(tmpdir(), 'fvtt-mcp-initialize-'));
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('announces the package version', async () => {
    const file = join(dir, 'config.env');
    writeFileSync(file, 'FOUNDRY_URL=http://localhost:30000\n');
    process.env = { FOUNDRY_MCP_CONFIG: file };
    expect(await announcedVersion()).toBe(VERSION);
  });

  it('announces the package version with no usable configuration', async () => {
    process.env = { FOUNDRY_MCP_CONFIG: join(dir, 'missing.env') };
    expect(await announcedVersion()).toBe(VERSION);
  });

  it('ignores a leftover MCP_SERVER_VERSION in the configuration file', async () => {
    const file = join(dir, 'config.env');
    writeFileSync(file, 'FOUNDRY_URL=http://localhost:30000\nMCP_SERVER_VERSION=0.1.0\n');
    process.env = { FOUNDRY_MCP_CONFIG: file };
    const { tryGetConfig } = await import('../config/index.js');
    expect('config' in tryGetConfig()).toBe(true);
    expect(await announcedVersion()).toBe(VERSION);
  });
});
