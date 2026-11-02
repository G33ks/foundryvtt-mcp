/**
 * @fileoverview Tests for the client snippets `init` prints.
 */

import { describe, expect, it } from 'vitest';
import { claudeCodeCommand, claudeDesktopSnippet } from '../snippets.js';

const WINDOWS_ENTRY = 'C:\\Users\\Goret\\source\\foundryvtt-mcp\\dist\\index.js';

describe('claudeDesktopSnippet', () => {
  it('is valid JSON whose args hold the Windows path intact', () => {
    const text = claudeDesktopSnippet(WINDOWS_ENTRY);
    expect(text).toContain('C:\\\\Users\\\\Goret');
    expect(JSON.parse(text)).toEqual({
      mcpServers: { foundryvtt: { command: 'node', args: [WINDOWS_ENTRY] } },
    });
  });

  it('carries no env block', () => {
    expect(claudeDesktopSnippet('/opt/mcp/dist/index.js')).not.toContain('env');
  });
});

describe('claudeCodeCommand', () => {
  it('registers the server at user scope by default, the path quoted', () => {
    expect(claudeCodeCommand(WINDOWS_ENTRY)).toBe(
      `claude mcp add foundryvtt --scope user -- node "${WINDOWS_ENTRY}"`,
    );
  });

  it('offers the local scope', () => {
    expect(claudeCodeCommand('/opt/mcp/dist/index.js', 'local')).toBe(
      'claude mcp add foundryvtt --scope local -- node "/opt/mcp/dist/index.js"',
    );
  });
});
