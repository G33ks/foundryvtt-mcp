#!/usr/bin/env node

/**
 * Package the companion module (foundry-module/) for a GitHub release.
 *
 * Produces the two release attachments in the output directory:
 *   - module.json: the committed manifest with the exact version of the tag and
 *     the `download` URL of this tag's zip (`manifest` stays the stable URL on main);
 *   - foundryvtt-mcp-bridge.zip: module.json at the root, plus scripts/, README.md
 *     and the repository LICENSE. Nothing else from foundry-module/ is shipped.
 *
 * Checks, so a tag cannot publish something the repository does not describe:
 *   - the tag is bridge-vX.Y.Z or bridge-vX.Y.Z-<prerelease>;
 *   - X.Y.Z equals the committed module.json version;
 *   - the committed `manifest` is the stable URL;
 *   - for a final tag, the committed `download` already points at this tag.
 *
 * Used by .github/workflows/bridge-release.yml and, as a fallback, locally:
 *   npm run bridge:package -- --tag bridge-v0.5.1-rc.1
 * then `gh release create` (see foundry-module/README.md, "Releasing").
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

export const MODULE_ID = 'foundryvtt-mcp-bridge';
export const REPOSITORY = 'G33ks/foundryvtt-mcp';
export const ZIP_NAME = `${MODULE_ID}.zip`;
export const MANIFEST_URL = `https://raw.githubusercontent.com/${REPOSITORY}/main/foundry-module/module.json`;

const TAG_PATTERN = /^bridge-v(\d+\.\d+\.\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

/** The `download` URL of a tag's zip. */
export function downloadUrl(tag) {
  return `https://github.com/${REPOSITORY}/releases/download/${tag}/${ZIP_NAME}`;
}

/** Split a release tag: `bridge-v0.5.1-rc.1` → version 0.5.1-rc.1, base 0.5.1, prerelease. */
export function parseTag(tag) {
  const match = TAG_PATTERN.exec(tag ?? '');
  if (!match) {
    throw new Error(`Invalid tag ${JSON.stringify(tag)}: expected bridge-vX.Y.Z or bridge-vX.Y.Z-<prerelease>`);
  }
  const [, baseVersion, suffix] = match;
  return {
    version: suffix ? `${baseVersion}-${suffix}` : baseVersion,
    baseVersion,
    prerelease: Boolean(suffix),
  };
}

/** The manifest attached to the release of `tag`, checked against the committed one. */
export function releaseManifest(committed, tag) {
  const { version, baseVersion, prerelease } = parseTag(tag);
  if (committed.id !== MODULE_ID) {
    throw new Error(`module.json id is ${JSON.stringify(committed.id)}, expected ${MODULE_ID}`);
  }
  if (committed.version !== baseVersion) {
    throw new Error(
      `Tag ${tag} is for version ${baseVersion}, but module.json says ${committed.version}`,
    );
  }
  if (committed.manifest !== MANIFEST_URL) {
    throw new Error(`module.json manifest must be the stable URL ${MANIFEST_URL}`);
  }
  const download = downloadUrl(tag);
  if (!prerelease && committed.download !== download) {
    throw new Error(
      `module.json download is ${JSON.stringify(committed.download)}, expected ${download} for the final tag ${tag}`,
    );
  }
  return { ...committed, version, download };
}

function listFiles(dir, prefix) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const name = `${prefix}/${entry.name}`;
      return entry.isDirectory() ? listFiles(join(dir, entry.name), name) : [name];
    })
    .sort();
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// 1980-01-01 00:00 in DOS format: a fixed timestamp keeps the zip reproducible.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** A deflated zip of `entries` ({ name, data }), in the given order. */
export function createZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralSize = centrals.reduce((size, part) => size + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * Write the release module.json and zip for `tag` into `outDir`.
 * Without a tag, packages the committed version as a final release.
 */
export function packageBridge({ repoRoot, outDir, tag }) {
  const moduleDir = join(repoRoot, 'foundry-module');
  const committed = JSON.parse(readFileSync(join(moduleDir, 'module.json'), 'utf8'));
  const releaseTag = tag ?? `bridge-v${committed.version}`;
  const manifest = releaseManifest(committed, releaseTag);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

  const entries = [
    { name: 'module.json', data: Buffer.from(manifestText, 'utf8') },
    { name: 'README.md', data: readFileSync(join(moduleDir, 'README.md')) },
    { name: 'LICENSE', data: readFileSync(join(repoRoot, 'LICENSE')) },
    ...listFiles(join(moduleDir, 'scripts'), 'scripts').map((name) => ({
      name,
      data: readFileSync(join(moduleDir, name)),
    })),
  ];

  mkdirSync(outDir, { recursive: true });
  const manifestPath = join(outDir, 'module.json');
  const zipPath = join(outDir, ZIP_NAME);
  writeFileSync(manifestPath, manifestText);
  writeFileSync(zipPath, createZip(entries));
  return {
    tag: releaseTag,
    manifest,
    prerelease: parseTag(releaseTag).prerelease,
    files: entries.map((entry) => entry.name),
    manifestPath,
    zipPath,
  };
}

function parseArgs(argv) {
  const args = { tag: undefined, out: undefined, githubOutput: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tag') {
      args.tag = argv[++i];
    } else if (arg === '--out') {
      args.out = argv[++i];
    } else if (arg === '--github-output') {
      args.githubOutput = true;
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const args = parseArgs(process.argv.slice(2));
    const result = packageBridge({
      repoRoot,
      outDir: resolve(args.out ?? join(repoRoot, 'build', 'bridge-release')),
      tag: args.tag,
    });
    console.log(`Packaged ${MODULE_ID} ${result.manifest.version} for ${result.tag}`);
    console.log(`  ${result.prerelease ? 'pre-release' : 'final release'}`);
    console.log(`  download: ${result.manifest.download}`);
    console.log(`  ${result.manifestPath}`);
    console.log(`  ${result.zipPath} (${result.files.length} files)`);
    if (args.githubOutput && process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `version=${result.manifest.version}\nprerelease=${result.prerelease}\n`,
      );
    }
  } catch (error) {
    console.error(`bridge:package failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
