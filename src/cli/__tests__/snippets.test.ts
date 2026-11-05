/**
 * @fileoverview Tests for the client snippets `init` prints.
 */

import { describe, expect, it } from 'vitest';
import { packageName } from '../../shared/version.js';
import {
  claudeCodeCommand,
  claudeDesktopSnippet,
  connectorCommand,
  installKind,
} from '../snippets.js';

const WINDOWS_NODE = 'C:\\Program Files\\nodejs\\node.exe';
const POSIX_NODE = '/home/me/.nvm/versions/node/v24.11.0/bin/node';

const ENTRIES = {
  windows: {
    clone: 'C:\\Users\\me\\source\\foundryvtt-mcp\\dist\\index.js',
    global:
      'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@g33ks\\foundryvtt-mcp\\dist\\index.js',
    npx: 'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\4f3a2b1c\\node_modules\\@g33ks\\foundryvtt-mcp\\dist\\index.js',
  },
  posix: {
    clone: '/home/me/src/foundryvtt-mcp/dist/index.js',
    global: '/usr/local/lib/node_modules/@g33ks/foundryvtt-mcp/dist/index.js',
    npx: '/home/me/.npm/_npx/4f3a2b1c/node_modules/@g33ks/foundryvtt-mcp/dist/index.js',
  },
} as const;

describe('installKind', () => {
  for (const os of ['windows', 'posix'] as const) {
    it(`tells a clone, a global install and npx's cache apart (${os})`, () => {
      expect(installKind(ENTRIES[os].clone)).toBe('clone');
      expect(installKind(ENTRIES[os].global)).toBe('global');
      expect(installKind(ENTRIES[os].npx)).toBe('npx');
    });
  }

  it('does not mistake a folder merely containing "_npx" for the cache', () => {
    expect(installKind('/home/me/my_npx_tests/foundryvtt-mcp/dist/index.js')).toBe('clone');
  });
});

describe('connectorCommand', () => {
  for (const os of ['windows', 'posix'] as const) {
    it(`runs the entry through node, quoted, from a clone (${os})`, () => {
      expect(connectorCommand(ENTRIES[os].clone)).toBe(`node "${ENTRIES[os].clone}"`);
    });

    it(`uses the package command for a global install (${os})`, () => {
      expect(connectorCommand(ENTRIES[os].global)).toBe('foundryvtt-mcp');
    });

    it(`runs the package through npx from npx's cache (${os})`, () => {
      expect(connectorCommand(ENTRIES[os].npx)).toBe(`npx ${packageName()}`);
    });
  }
});

describe('claudeDesktopSnippet', () => {
  it('is valid JSON with the absolute paths of Node and of the entry, intact', () => {
    const entry = ENTRIES.windows.global;
    const text = claudeDesktopSnippet(WINDOWS_NODE, entry);
    expect(text).toContain('C:\\\\Program Files\\\\nodejs\\\\node.exe');
    expect(JSON.parse(text)).toEqual({
      mcpServers: { foundryvtt: { command: WINDOWS_NODE, args: [entry] } },
    });
  });

  it('carries no env block', () => {
    expect(claudeDesktopSnippet(POSIX_NODE, ENTRIES.posix.clone)).not.toContain('env');
  });
});

describe('claudeCodeCommand', () => {
  it('registers the server at user scope by default, both paths quoted', () => {
    expect(claudeCodeCommand(WINDOWS_NODE, ENTRIES.windows.clone)).toBe(
      `claude mcp add foundryvtt --scope user -- "${WINDOWS_NODE}" "${ENTRIES.windows.clone}"`,
    );
  });

  it('offers the local scope', () => {
    expect(claudeCodeCommand(POSIX_NODE, ENTRIES.posix.global, 'local')).toBe(
      `claude mcp add foundryvtt --scope local -- "${POSIX_NODE}" "${ENTRIES.posix.global}"`,
    );
  });
});
