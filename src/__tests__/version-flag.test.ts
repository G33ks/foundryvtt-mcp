import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url));
// `--import` takes a URL: a bare Windows path reads as a URL scheme.
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

describe('foundryvtt-mcp --version', () => {
  let dir: string;

  beforeAll(() => {
    // An unreadable configuration everywhere: `--version` must not look at it.
    dir = mkdtempSync(join(tmpdir(), 'fvtt-mcp-version-'));
    writeFileSync(join(dir, '.env'), 'FOUNDRY_URL=not a url\nFOUNDRY_TIMEOUT=abc\n');
    writeFileSync(join(dir, 'config.env'), 'FOUNDRY_URL=not a url\n');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(['--version', '-v', 'version'])(
    '%s prints the package version and nothing else',
    (arg) => {
      const result = spawnSync(process.execPath, ['--import', TSX, ENTRY, arg], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          FOUNDRY_MCP_STATE_DIR: dir,
          FOUNDRY_MCP_CONFIG: join(dir, 'config.env'),
          LOG_LEVEL: 'debug',
        },
        timeout: 30_000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${VERSION}\n`);
      expect(result.stderr).toBe('');
    },
  );
});
