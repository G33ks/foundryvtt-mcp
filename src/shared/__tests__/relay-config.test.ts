import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayConfig } from '../relay-config.js';

let dir: string;
let file: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'fvtt-mcp-relay-config-'));
  file = path.join(dir, 'config.env');
  // Only the file configures this relay.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FOUNDRY_') || key === 'LOG_LEVEL') {
      delete process.env[key];
    }
  }
  process.env.FOUNDRY_MCP_CONFIG = file;
});

afterEach(() => {
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

describe('RelayConfig', () => {
  it('explains a missing configuration on each call, and works once the file is written', () => {
    const warn = vi.fn();
    const relay = new RelayConfig(warn);

    const first = relay.usable();
    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).toContain(`${file} (this file does not exist yet)`);
    // Told once, not once per call.
    relay.usable();
    expect(warn).toHaveBeenCalledTimes(1);

    writeFileSync(file, 'FOUNDRY_URL=http://localhost:30000\nFOUNDRY_USERNAME=mcp-api\n');
    const second = relay.usable();
    expect(second).not.toBeInstanceOf(Error);
  });

  it('re-reads the file before each handshake', () => {
    writeFileSync(file, 'FOUNDRY_URL=http://localhost:30000\nFOUNDRY_WRITE_ENABLED=false\n');
    const relay = new RelayConfig();
    const before = relay.helloFields('token');
    expect(before.configSources?.FOUNDRY_WRITE_ENABLED).toBe('file');

    writeFileSync(file, 'FOUNDRY_URL=http://localhost:30000\nFOUNDRY_WRITE_ENABLED=true\n');
    const after = relay.helloFields('token');
    expect(after.configHash).not.toBe(before.configHash);
    expect(after.configDigests?.FOUNDRY_WRITE_ENABLED).not.toBe(
      before.configDigests?.FOUNDRY_WRITE_ENABLED,
    );
    expect(after.configDigests?.FOUNDRY_URL).toBe(before.configDigests?.FOUNDRY_URL);
  });

  it('keeps the settings that last worked when the file breaks between two handshakes', () => {
    writeFileSync(file, 'FOUNDRY_URL=http://localhost:30000\n');
    const relay = new RelayConfig();
    const good = relay.helloFields('token');
    writeFileSync(file, 'FOUNDRY_URL=not a url\n');
    expect(relay.helloFields('token').configHash).toBe(good.configHash);
  });

  it('declares where each setting comes from, never a value', () => {
    writeFileSync(file, "FOUNDRY_URL=http://localhost:30000\nFOUNDRY_PASSWORD='hunter2'\n");
    process.env.FOUNDRY_WRITE_ENABLED = 'true';
    const fields = new RelayConfig().helloFields('token');
    expect(fields.configSources).toMatchObject({
      FOUNDRY_URL: 'file',
      FOUNDRY_PASSWORD: 'file',
      FOUNDRY_WRITE_ENABLED: 'env',
    });
    expect(JSON.stringify(fields)).not.toContain('hunter2');
  });
});
