/**
 * @fileoverview World document tool handlers (folders, macros, playlists).
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { OWNERSHIP_LEVELS } from '../../foundry/types.js';
import { deletionNote, withToolError } from './utils.js';

// ============================================================================
// Folder handlers
// ============================================================================

export async function handleListFolders(args: { type?: string }, foundryClient: FoundryClient) {
  return withToolError('list folders', async () => {
    const folders = foundryClient.listFolders(args);
    if (folders.length === 0) {
      return {
        content: [{ type: 'text', text: '📁 **No folders found.**' }],
      };
    }
    const lines = folders.map(
      (f) =>
        `- **${f.name}** (${f.id}) — type: ${f.type}${f.parent ? `, parent: ${f.parent}` : ''}${f.color ? `, color: ${f.color}` : ''}`,
    );
    return {
      content: [
        {
          type: 'text',
          text: `📁 **Folders** (${folders.length})\n${lines.join('\n')}`,
        },
      ],
    };
  });
}

export async function handleCreateFolder(
  args: {
    name: string;
    type: string;
    parent?: string;
    color?: string;
    sorting?: 'a' | 'm';
  },
  foundryClient: FoundryClient,
) {
  const { name, type } = args;
  if (!name || typeof name !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'name is required and must be a string');
  }
  if (!type || typeof type !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'type is required and must be a string');
  }

  return withToolError('create folder', async () => {
    const created = (await foundryClient.createFolder(name, type, args)) as
      | { _id?: string }
      | undefined;
    const folderId = created?._id ?? 'unknown';

    return {
      content: [
        {
          type: 'text',
          text: `📁 **Folder Created**\n**ID:** ${folderId}\n**Name:** ${name}\n**Type:** ${type}`,
        },
      ],
    };
  });
}

// ============================================================================
// Macro handlers
// ============================================================================

export async function handleListMacros(
  _args: Record<string, unknown>,
  foundryClient: FoundryClient,
) {
  return withToolError('list macros', async () => {
    const macros = foundryClient.listMacros();
    if (macros.length === 0) {
      return {
        content: [{ type: 'text', text: '📜 **No macros found.**' }],
      };
    }
    const lines = macros.map(
      (m) =>
        `- **${m.name}** (${m.id}) — type: ${m.type}, scope: ${m.scope}${m.folder ? `, folder: ${m.folder}` : ''}\n  Preview: \`${m.commandPreview}\``,
    );
    return {
      content: [
        {
          type: 'text',
          text: `📜 **Macros** (${macros.length})\n${lines.join('\n')}`,
        },
      ],
    };
  });
}

export async function handleCreateMacro(
  args: {
    name: string;
    type: 'script' | 'chat';
    command: string;
    img?: string;
    folder?: string;
    scope?: 'global' | 'actors' | 'actor';
  },
  foundryClient: FoundryClient,
) {
  const { name, type, command } = args;
  if (!name || typeof name !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'name is required and must be a string');
  }
  if (type !== 'script' && type !== 'chat') {
    throw new McpError(ErrorCode.InvalidParams, 'type must be "script" or "chat"');
  }
  if (typeof command !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'command is required and must be a string');
  }

  return withToolError('create macro', async () => {
    const created = (await foundryClient.createMacro(name, type, command, args)) as
      | { _id?: string }
      | undefined;
    const macroId = created?._id ?? 'unknown';

    return {
      content: [
        {
          type: 'text',
          text: `📜 **Macro Created**\n**ID:** ${macroId}\n**Name:** ${name}\n**Type:** ${type}\n_Note: Macros are authored and managed here, not executed._`,
        },
      ],
    };
  });
}

export async function handleDeleteMacro(args: { macroId: string }, foundryClient: FoundryClient) {
  const { macroId } = args;
  if (!macroId || typeof macroId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'macroId is required and must be a string');
  }

  return withToolError('delete macro', async () => {
    const note = await foundryClient.deleteMacro(macroId);

    return {
      content: [
        {
          type: 'text',
          text: `🗑️ **Macro Deleted**\n**ID:** ${macroId}${deletionNote(note)}`,
        },
      ],
    };
  });
}

// ============================================================================
// Playlist handlers
// ============================================================================

export async function handleListPlaylists(
  _args: Record<string, unknown>,
  foundryClient: FoundryClient,
) {
  return withToolError('list playlists', async () => {
    const playlists = foundryClient.listPlaylists();
    if (playlists.length === 0) {
      return {
        content: [{ type: 'text', text: '🎵 **No playlists found.**' }],
      };
    }
    const lines = playlists.map((p) => {
      const modeLabel = ['', 'sequential', 'shuffle', 'simultaneous'][p.mode + 1] ?? 'unknown';
      const soundLines = p.sounds
        .map((s) => `    - ${s.name} (${s.id}) — \`${s.path}\`${s.playing ? ' [playing]' : ''}`)
        .join('\n');
      return `- **${p.name}** (${p.id}) — ${p.playing ? '▶️ playing' : '⏹️ stopped'}, mode: ${modeLabel}, channel: ${p.channel} (${p.soundCount} track${p.soundCount !== 1 ? 's' : ''})${soundLines ? `\n${soundLines}` : ''}`;
    });
    return {
      content: [
        {
          type: 'text',
          text: `🎵 **Playlists** (${playlists.length})\n${lines.join('\n')}`,
        },
      ],
    };
  });
}

export async function handleCreatePlaylist(
  args: {
    name: string;
    description?: string;
    mode?: -1 | 0 | 1 | 2;
    channel?: 'music' | 'environment' | 'interface';
    fade?: number;
    folder?: string;
    sounds?: Array<{ name: string; path: string; volume?: number; repeat?: boolean }>;
  },
  foundryClient: FoundryClient,
) {
  const { name } = args;
  if (!name || typeof name !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'name is required and must be a string');
  }

  return withToolError('create playlist', async () => {
    const created = (await foundryClient.createPlaylist(name, args)) as
      | { _id?: string }
      | undefined;
    const playlistId = created?._id ?? 'unknown';

    return {
      content: [
        {
          type: 'text',
          text: `🎵 **Playlist Created**\n**ID:** ${playlistId}\n**Name:** ${name}\n**Tracks Added:** ${args.sounds?.length ?? 0}`,
        },
      ],
    };
  });
}

export async function handleSetPlaylistState(
  args: {
    playlistId: string;
    playing: boolean;
    soundId?: string;
  },
  foundryClient: FoundryClient,
) {
  const { playlistId, playing, soundId } = args;
  if (!playlistId || typeof playlistId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'playlistId is required and must be a string');
  }
  if (typeof playing !== 'boolean') {
    throw new McpError(ErrorCode.InvalidParams, 'playing is required and must be a boolean');
  }

  return withToolError('set playlist state', async () => {
    await foundryClient.setPlaylistState(
      playlistId,
      playing,
      soundId !== undefined ? { soundId } : {},
    );
    return {
      content: [
        {
          type: 'text',
          text: `🎵 **Playlist State Updated**\n**ID:** ${playlistId}${soundId ? ` (Track: ${soundId})` : ''}\n**Status:** ${playing ? '▶️ Playing' : '⏹️ Stopped'}`,
        },
      ],
    };
  });
}

export async function handleDeletePlaylist(
  args: { playlistId: string },
  foundryClient: FoundryClient,
) {
  const { playlistId } = args;
  if (!playlistId || typeof playlistId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'playlistId is required and must be a string');
  }

  return withToolError('delete playlist', async () => {
    const note = await foundryClient.deletePlaylist(playlistId);

    return {
      content: [
        {
          type: 'text',
          text: `🗑️ **Playlist Deleted**\n**ID:** ${playlistId}${deletionNote(note)}`,
        },
      ],
    };
  });
}

// ============================================================================
// Document ownership handlers
// ============================================================================

export async function handleSetDocumentOwnership(
  args: {
    documentType: 'Actor' | 'Item' | 'Scene' | 'JournalEntry' | 'RollTable' | 'Macro';
    documentId: string;
    entries: Array<{ target: string; level: keyof typeof OWNERSHIP_LEVELS }>;
  },
  foundryClient: FoundryClient,
) {
  const { documentType, documentId, entries } = args;
  if (!documentType || typeof documentType !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'documentType is required and must be a string');
  }
  if (!documentId || typeof documentId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'documentId is required and must be a string');
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'entries is required and must contain at least one { target, level } entry',
    );
  }

  return withToolError('set document ownership', async () => {
    await foundryClient.setDocumentOwnership(documentType, documentId, entries);
    const formatted = entries.map((e) => `- ${e.target}: ${e.level}`).join('\n');
    return {
      content: [
        {
          type: 'text',
          text: `🔐 **Document Ownership Updated**\n**Type:** ${documentType}\n**ID:** ${documentId}\n**Permissions:**\n${formatted}`,
        },
      ],
    };
  });
}
