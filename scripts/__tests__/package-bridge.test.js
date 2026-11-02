import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createZip,
  downloadUrl,
  MANIFEST_URL,
  packageBridge,
  parseTag,
  releaseManifest,
  ZIP_NAME,
} from '../package-bridge.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const committed = JSON.parse(
  readFileSync(join(repoRoot, 'foundry-module', 'module.json'), 'utf8'),
);

/** Entries of a zip, read from its central directory: { name: Buffer }. */
function readZip(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let pos = zip.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(pos)).toBe(0x02014b50);
    const compressedSize = zip.readUInt32LE(pos + 20);
    const nameLength = zip.readUInt16LE(pos + 28);
    const extraLength = zip.readUInt16LE(pos + 30);
    const commentLength = zip.readUInt16LE(pos + 32);
    const localOffset = zip.readUInt32LE(pos + 42);
    const name = zip.toString('utf8', pos + 46, pos + 46 + nameLength);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, inflateRawSync(zip.subarray(dataStart, dataStart + compressedSize)));
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const base = {
  id: 'foundryvtt-mcp-bridge',
  version: '0.5.1',
  manifest: MANIFEST_URL,
  download: downloadUrl('bridge-v0.5.1'),
};

describe('parseTag', () => {
  it('reads a final tag', () => {
    expect(parseTag('bridge-v0.5.1')).toEqual({
      version: '0.5.1',
      baseVersion: '0.5.1',
      prerelease: false,
    });
  });

  it('reads a pre-release tag', () => {
    expect(parseTag('bridge-v0.5.1-rc.1')).toEqual({
      version: '0.5.1-rc.1',
      baseVersion: '0.5.1',
      prerelease: true,
    });
  });

  it.each(['v0.5.1', 'bridge-0.5.1', 'bridge-v0.5', 'bridge-v0.5.1-', 'foundryvtt-mcp-v1.5.2'])(
    'refuses %s',
    (tag) => {
      expect(() => parseTag(tag)).toThrow(/Invalid tag/);
    },
  );
});

describe('releaseManifest', () => {
  it('writes the exact pre-release version and its own download, keeping the stable manifest', () => {
    const manifest = releaseManifest(base, 'bridge-v0.5.1-rc.1');
    expect(manifest.version).toBe('0.5.1-rc.1');
    expect(manifest.download).toBe(
      'https://github.com/G33ks/foundryvtt-mcp/releases/download/bridge-v0.5.1-rc.1/foundryvtt-mcp-bridge.zip',
    );
    expect(manifest.manifest).toBe(MANIFEST_URL);
  });

  it('accepts a final tag whose download is committed', () => {
    expect(releaseManifest(base, 'bridge-v0.5.1')).toEqual(base);
  });

  it('refuses a tag whose base version differs from module.json', () => {
    expect(() => releaseManifest(base, 'bridge-v0.5.2-rc.1')).toThrow(/module.json says 0.5.1/);
  });

  it('refuses a final tag whose committed download points elsewhere', () => {
    const stale = { ...base, download: downloadUrl('bridge-v0.5.0') };
    expect(() => releaseManifest(stale, 'bridge-v0.5.1')).toThrow(/download/);
  });

  it('lets a pre-release through with a download committed for the final tag', () => {
    expect(releaseManifest(base, 'bridge-v0.5.1-rc.2').download).toBe(
      downloadUrl('bridge-v0.5.1-rc.2'),
    );
  });

  it('refuses a manifest URL other than the stable one', () => {
    const latest = { ...base, manifest: 'https://example.com/releases/latest/module.json' };
    expect(() => releaseManifest(latest, 'bridge-v0.5.1-rc.1')).toThrow(/stable URL/);
  });

  it('accepts the committed module.json for its own final tag', () => {
    expect(releaseManifest(committed, `bridge-v${committed.version}`)).toEqual(committed);
  });
});

describe('createZip', () => {
  it('round-trips names and contents', () => {
    const zip = createZip([
      { name: 'a.txt', data: Buffer.from('hello') },
      { name: 'dir/b.txt', data: Buffer.from('é'.repeat(1000)) },
    ]);
    const entries = readZip(zip);
    expect([...entries.keys()]).toEqual(['a.txt', 'dir/b.txt']);
    expect(entries.get('dir/b.txt').toString('utf8')).toBe('é'.repeat(1000));
  });
});

describe('packageBridge', () => {
  let outDir;
  afterEach(() => {
    if (outDir) {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('writes the release module.json and a zip with module.json at its root', () => {
    outDir = mkdtempSync(join(tmpdir(), 'bridge-package-'));
    const tag = `bridge-v${committed.version}-rc.1`;
    const result = packageBridge({ repoRoot, outDir, tag });

    expect(result.prerelease).toBe(true);
    const attached = JSON.parse(readFileSync(join(outDir, 'module.json'), 'utf8'));
    expect(attached.version).toBe(`${committed.version}-rc.1`);
    expect(attached.download).toBe(downloadUrl(tag));
    expect(attached.manifest).toBe(MANIFEST_URL);

    const entries = readZip(readFileSync(join(outDir, ZIP_NAME)));
    const names = [...entries.keys()];
    expect(names.slice(0, 3)).toEqual(['module.json', 'README.md', 'LICENSE']);
    expect(names.slice(3).every((name) => name.startsWith('scripts/'))).toBe(true);
    expect(JSON.parse(entries.get('module.json').toString('utf8'))).toEqual(attached);
    for (const esmodule of attached.esmodules) {
      expect(names).toContain(esmodule);
    }
    expect(entries.get('scripts/main.js')).toEqual(
      readFileSync(join(repoRoot, 'foundry-module', 'scripts', 'main.js')),
    );
  });

  it('packages the committed version as final without a tag', () => {
    outDir = mkdtempSync(join(tmpdir(), 'bridge-package-'));
    const result = packageBridge({ repoRoot, outDir });
    expect(result.tag).toBe(`bridge-v${committed.version}`);
    expect(result.prerelease).toBe(false);
  });
});
