/**
 * @fileoverview Tests for the upload_asset tool handler.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FoundryClient } from '../../../foundry/client.js';
import type { ModuleBridge } from '../../../foundry/module-bridge.js';
import { handleUploadAsset } from '../module-bridge.js';

function buildBridge(sendImpl: (type: string, params: Record<string, unknown>) => unknown) {
  return {
    send: vi.fn(sendImpl),
  } as unknown as ModuleBridge;
}

/** A client with writes enabled: the write check lets the call through. */
const writer = () => new FoundryClient({ baseUrl: 'http://localhost:30000', writeEnabled: true });

describe('handleUploadAsset', () => {
  it('uploads via contentBase64 and infers mimeType from the filename extension', async () => {
    const bridge = buildBridge(() => ({ path: 'assets/uploads/map.png' }));
    const result = await handleUploadAsset(
      { targetDir: 'assets/uploads', filename: 'map.png', contentBase64: 'aGVsbG8=' },
      writer(),
      bridge,
    );
    expect(result.content[0].text).toContain('assets/uploads/map.png');
    expect(bridge.send).toHaveBeenCalledWith('upload_asset', {
      targetDir: 'assets/uploads',
      filename: 'map.png',
      contentBase64: 'aGVsbG8=',
      mimeType: 'image/png',
    });
  });

  it('rejects when both contentBase64 and sourcePath are provided', async () => {
    const bridge = buildBridge(() => ({ path: 'x' }));
    await expect(
      handleUploadAsset(
        {
          targetDir: 'assets',
          filename: 'a.png',
          contentBase64: 'aGVsbG8=',
          sourcePath: '/tmp/a.png',
        },
        writer(),
        bridge,
      ),
    ).rejects.toThrow(/Exactly one of contentBase64 or sourcePath/);
    expect(bridge.send).not.toHaveBeenCalled();
  });

  it('rejects when neither contentBase64 nor sourcePath is provided', async () => {
    const bridge = buildBridge(() => ({ path: 'x' }));
    await expect(
      handleUploadAsset({ targetDir: 'assets', filename: 'a.png' }, writer(), bridge),
    ).rejects.toThrow(/Exactly one of contentBase64 or sourcePath/);
    expect(bridge.send).not.toHaveBeenCalled();
  });

  it('rejects a contentBase64 payload estimated over the 8 MiB limit', async () => {
    const bridge = buildBridge(() => ({ path: 'x' }));
    // Estimated decoded size = length * 3/4; need > 8 MiB (8388608 bytes).
    const oversized = 'A'.repeat(11_184_812);
    await expect(
      handleUploadAsset(
        { targetDir: 'assets', filename: 'huge.png', contentBase64: oversized },
        writer(),
        bridge,
      ),
    ).rejects.toThrow(/exceeds the 8 MiB upload limit/);
    expect(bridge.send).not.toHaveBeenCalled();
  });

  it('rejects when the module bridge is not configured', async () => {
    await expect(
      handleUploadAsset(
        { targetDir: 'assets', filename: 'a.png', contentBase64: 'aGVsbG8=' },
        writer(),
        null,
      ),
    ).rejects.toThrow(/FOUNDRY_MODULE_BRIDGE_ENABLED/);
  });

  it('rejects a missing targetDir', async () => {
    const bridge = buildBridge(() => ({ path: 'x' }));
    await expect(
      handleUploadAsset(
        { targetDir: '', filename: 'a.png', contentBase64: 'aGVsbG8=' },
        writer(),
        bridge,
      ),
    ).rejects.toThrow(McpError);
  });

  it('rejects a malformed result shape from the module', async () => {
    const bridge = buildBridge(() => ({ nonsense: true }));
    await expect(
      handleUploadAsset(
        { targetDir: 'assets', filename: 'a.png', contentBase64: 'aGVsbG8=' },
        writer(),
        bridge,
      ),
    ).rejects.toThrow(/unexpected upload_asset shape/);
  });
});

describe('handleUploadAsset: write check and paths', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  let root: string;
  let allowed: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fvtt-mcp-upload-'));
    allowed = join(root, 'allowed');
    mkdirSync(allowed);
    writeFileSync(join(allowed, 'map.png'), PNG);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function client(options: { writeEnabled?: boolean; uploadSourceDir?: string } = {}) {
    return new FoundryClient({
      baseUrl: 'http://localhost:30000',
      writeEnabled: options.writeEnabled ?? true,
      ...(options.uploadSourceDir ? { uploadSourceDir: options.uploadSourceDir } : {}),
    });
  }

  function bridge() {
    const send = vi.fn(async (_type: string, params: Record<string, unknown>) => ({
      path: `${params.targetDir}/${params.filename}`,
    }));
    return { bridge: { send } as unknown as ModuleBridge, send };
  }

  type UploadArgs = Parameters<typeof handleUploadAsset>[0];

  async function refused(args: Partial<UploadArgs>, foundry: FoundryClient, pattern: RegExp) {
    const { bridge: b, send } = bridge();
    await expect(
      handleUploadAsset({ targetDir: 'maps', filename: 'map.png', ...args }, foundry, b),
    ).rejects.toThrow(pattern);
    expect(send).not.toHaveBeenCalled();
  }

  it('is refused while writes are disabled, before reading sourcePath', async () => {
    // A missing file: reading it first would fail with ENOENT instead.
    await refused(
      { sourcePath: join(allowed, 'missing.png') },
      client({ writeEnabled: false, uploadSourceDir: allowed }),
      /Write operations are disabled/,
    );
  });

  it('refuses sourcePath while FOUNDRY_UPLOAD_SOURCE_DIR is not set', async () => {
    await refused({ sourcePath: join(allowed, 'map.png') }, client(), /FOUNDRY_UPLOAD_SOURCE_DIR/);
  });

  it('refuses a sourcePath outside the upload source folder', async () => {
    writeFileSync(join(root, 'outside.png'), PNG);
    await refused(
      { sourcePath: join(root, 'outside.png') },
      client({ uploadSourceDir: allowed }),
      /outside/,
    );
  });

  it('refuses a sourcePath that climbs out of the folder with ..', async () => {
    writeFileSync(join(root, 'outside.png'), PNG);
    await refused(
      { sourcePath: join(allowed, '..', 'outside.png') },
      client({ uploadSourceDir: allowed }),
      /outside/,
    );
  });

  it('refuses a link inside the folder that points outside it', async (ctx) => {
    writeFileSync(join(root, 'outside.png'), PNG);
    try {
      symlinkSync(join(root, 'outside.png'), join(allowed, 'link.png'));
    } catch {
      ctx.skip(); // Windows without the privilege to create symbolic links
    }
    await refused(
      { sourcePath: join(allowed, 'link.png') },
      client({ uploadSourceDir: allowed }),
      /outside/,
    );
  });

  it('refuses a sourcePath that is not a regular file', async () => {
    mkdirSync(join(allowed, 'folder.png'));
    await refused(
      { sourcePath: join(allowed, 'folder.png') },
      client({ uploadSourceDir: allowed }),
      /regular file/,
    );
  });

  it('refuses a source file over the size limit', async () => {
    const big = join(allowed, 'big.png');
    writeFileSync(big, '');
    truncateSync(big, 8 * 1024 * 1024 + 1);
    await refused(
      { sourcePath: big, filename: 'big.png' },
      client({ uploadSourceDir: allowed }),
      /8 MiB/,
    );
  });

  it('refuses a filename whose extension differs from the source file', async () => {
    await refused(
      { sourcePath: join(allowed, 'map.png'), filename: 'map.jpg' },
      client({ uploadSourceDir: allowed }),
      /extension/,
    );
  });

  it.each(['page.svg', 'data.json', 'doc.pdf', 'tool.exe', 'noextension'])(
    'refuses %s, not a media file type',
    async (filename) => {
      await refused({ filename, contentBase64: 'AAAA' }, client(), /file type/);
    },
  );

  it('refuses a mimeType that does not match the extension', async () => {
    await refused({ contentBase64: 'AAAA', mimeType: 'text/html' }, client(), /mimeType/);
  });

  it.each(['../maps', 'maps/../../x', 'a/./../b'])(
    'refuses the targetDir %s, which climbs with ..',
    async (targetDir) => {
      await refused({ targetDir, contentBase64: 'AAAA' }, client(), /targetDir/);
    },
  );

  it.each(['/etc', 'C:/maps', 'c:maps', '\\\\server\\share', 'https://example.com/x'])(
    'refuses the absolute targetDir %s',
    async (targetDir) => {
      await refused({ targetDir, contentBase64: 'AAAA' }, client(), /targetDir/);
    },
  );

  it.each(['a/map.png', 'a\\map.png', 'c:map.png'])(
    'refuses a filename with a separator: %s',
    async (filename) => {
      await refused({ filename, contentBase64: 'AAAA' }, client(), /filename/);
    },
  );

  it.each(['..', '.png', '.hidden.png'])('refuses the filename %s', async (filename) => {
    await refused({ filename, contentBase64: 'AAAA' }, client(), /filename/);
  });

  it('refuses contentBase64 that is not base64', async () => {
    await refused({ contentBase64: 'not base64!' }, client(), /base64/);
  });

  it('uploads a media file from the upload source folder', async () => {
    const { bridge: b, send } = bridge();
    const result = await handleUploadAsset(
      { targetDir: 'maps', filename: 'map.png', sourcePath: join(allowed, 'map.png') },
      client({ uploadSourceDir: allowed }),
      b,
    );
    expect(send).toHaveBeenCalledWith('upload_asset', {
      targetDir: 'maps',
      filename: 'map.png',
      contentBase64: PNG.toString('base64'),
      mimeType: 'image/png',
    });
    expect(result.content[0].text).toContain('maps/map.png');
  });

  it('uploads base64 content without any upload source folder', async () => {
    const { bridge: b, send } = bridge();
    await handleUploadAsset(
      { targetDir: 'audio/music', filename: 'theme.ogg', contentBase64: 'AAAA' },
      client(),
      b,
    );
    expect(send).toHaveBeenCalledWith('upload_asset', {
      targetDir: 'audio/music',
      filename: 'theme.ogg',
      contentBase64: 'AAAA',
      mimeType: 'audio/ogg',
    });
  });
});
