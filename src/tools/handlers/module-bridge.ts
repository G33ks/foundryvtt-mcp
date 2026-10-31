/**
 * @fileoverview Canvas-only tool handlers, relayed through the companion
 * Foundry module over {@link ModuleBridge} rather than FoundryVTT's own
 * Socket.IO document API — see module-bridge.ts for why.
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { ModuleBridge } from '../../foundry/module-bridge.js';
import { withToolError } from './utils.js';

interface CaptureSceneResult {
  sceneId: string;
  sceneName: string;
  image: string;
  mimeType: string;
  width: number;
  height: number;
}

function isCaptureSceneResult(value: unknown): value is CaptureSceneResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CaptureSceneResult).image === 'string' &&
    typeof (value as CaptureSceneResult).mimeType === 'string'
  );
}

/**
 * Handles capturing a screenshot of the current scene, with a grid
 * coordinate overlay for spatial reasoning. Requires the companion Foundry
 * module to be installed, enabled, and connected to the bridge.
 */
export async function handleCaptureScene(
  _args: Record<string, unknown>,
  moduleBridge: ModuleBridge | null,
) {
  if (!moduleBridge) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'The module bridge is disabled. Set FOUNDRY_MODULE_BRIDGE_ENABLED=true and install the companion Foundry module.',
    );
  }

  return withToolError('capture scene', async () => {
    const result = await moduleBridge.send('capture_scene', {});
    if (!isCaptureSceneResult(result)) {
      throw new McpError(
        ErrorCode.InternalError,
        'Module returned an unexpected capture_scene shape',
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: `📷 **Scene Captured: ${result.sceneName}**\n**Dimensions:** ${result.width}x${result.height}`,
        },
        {
          type: 'image',
          data: result.image,
          mimeType: result.mimeType,
        },
      ],
    };
  });
}

interface DocumentSchemaResult {
  documentType: string;
  type: string;
  fields: Record<string, unknown>;
}

function isDocumentSchemaResult(value: unknown): value is DocumentSchemaResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DocumentSchemaResult).documentType === 'string' &&
    typeof (value as DocumentSchemaResult).type === 'string' &&
    typeof (value as DocumentSchemaResult).fields === 'object'
  );
}

/**
 * Handles introspecting a game system's real DataModel schema for an Actor
 * or Item type — the exact field names, types, choices, and defaults
 * `create_world_actor`/`create_actor_item`/`create_full_actor` expect,
 * for whichever system is installed. Requires the companion Foundry module.
 */
export async function handleGetDocumentSchema(
  args: { documentType: 'Actor' | 'Item'; type: string },
  moduleBridge: ModuleBridge | null,
) {
  const { documentType, type } = args;

  if (documentType !== 'Actor' && documentType !== 'Item') {
    throw new McpError(ErrorCode.InvalidParams, 'documentType must be "Actor" or "Item"');
  }
  if (!type || typeof type !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'type is required and must be a string');
  }
  if (!moduleBridge) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'The module bridge is disabled. Set FOUNDRY_MODULE_BRIDGE_ENABLED=true and install the companion Foundry module.',
    );
  }

  return withToolError('get document schema', async () => {
    const result = await moduleBridge.send('get_document_schema', { documentType, type });
    if (!isDocumentSchemaResult(result)) {
      throw new McpError(
        ErrorCode.InternalError,
        'Module returned an unexpected get_document_schema shape',
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: `🧬 **${result.documentType} Schema: ${result.type}**\n\`\`\`json\n${JSON.stringify(result.fields, null, 2)}\n\`\`\``,
        },
      ],
    };
  });
}

interface CompendiumContentEntry {
  packId: string;
  packLabel: string;
  documentId: string;
  documentName: string;
  documentType: string;
  matchedIn: 'name' | 'content';
  snippet: string;
}

interface SearchCompendiumContentResult {
  results: CompendiumContentEntry[];
  total: number;
}

function isSearchCompendiumContentResult(value: unknown): value is SearchCompendiumContentResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as SearchCompendiumContentResult).results)
  );
}

export async function handleSearchCompendiumContent(
  args: { query?: string; packType?: string; limit?: number },
  moduleBridge: ModuleBridge | null,
) {
  if (!moduleBridge) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'The module bridge is disabled. Set FOUNDRY_MODULE_BRIDGE_ENABLED=true and install the companion Foundry module.',
    );
  }

  return withToolError('search compendium content', async () => {
    const result = await moduleBridge.send('search_compendium_content', args);
    if (!isSearchCompendiumContentResult(result)) {
      throw new McpError(
        ErrorCode.InternalError,
        'Module returned an unexpected search_compendium_content shape',
      );
    }

    if (result.results.length === 0) {
      return {
        content: [
          { type: 'text', text: `📚 **No compendium matches found for "${args.query ?? ''}".**` },
        ],
      };
    }

    const lines = result.results.map((r) => {
      const matchTag = r.matchedIn === 'content' ? ' [content match]' : '';
      const snippetText = r.snippet ? `\n    > "${r.snippet}"` : '';
      return `- **${r.documentName}** (\`${r.documentId}\`) in _${r.packLabel}_ (\`${r.packId}\`)${matchTag}${snippetText}`;
    });

    return {
      content: [
        {
          type: 'text',
          text: `📚 **Compendium Content Matches** (${result.results.length})\n${lines.join('\n')}`,
        },
      ],
    };
  });
}

interface RollAndPostResult {
  formula: string;
  total: number;
  result: string;
}

function isRollAndPostResult(value: unknown): value is RollAndPostResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RollAndPostResult).formula === 'string' &&
    typeof (value as RollAndPostResult).total === 'number'
  );
}

export async function handleRollAndPost(
  args: {
    formula: string;
    flavor?: string;
    speakerAlias?: string;
    whisperTo?: string[];
    rollMode?: string;
  },
  moduleBridge: ModuleBridge | null,
) {
  const { formula } = args;
  if (!formula || typeof formula !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'formula is required and must be a string');
  }
  if (!moduleBridge) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'The module bridge is disabled. Set FOUNDRY_MODULE_BRIDGE_ENABLED=true and install the companion Foundry module.',
    );
  }

  return withToolError('roll and post', async () => {
    const result = await moduleBridge.send('roll_and_post', args);
    if (!isRollAndPostResult(result)) {
      throw new McpError(
        ErrorCode.InternalError,
        'Module returned an unexpected roll_and_post shape',
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: `🎲 **Dice Rolled & Posted to Chat**\n**Formula:** ${result.formula}\n**Total:** ${result.total}${args.flavor ? `\n**Flavor:** ${args.flavor}` : ''}`,
        },
      ],
    };
  });
}

/**
 * Handles importing a compendium Actor (with its embedded items/effects) as
 * a new top-level world Actor — the gap `spawn_token` cannot close on its
 * own, since it requires an actor that already exists in the world.
 *
 * Best-effort on embedded documents: if the system rejects an Actor create
 * carrying `items`/`effects` inline, the actor is recreated without them and
 * each item is seeded individually via `createActorItem`, mirroring
 * `createFullActor`'s per-item error reporting rather than losing the whole
 * import over one bad item.
 */
export async function handleImportCompendiumActor(
  args: { compendiumId: string; actorId: string; folderId?: string; name?: string },
  foundryClient: FoundryClient,
  moduleBridge: ModuleBridge | null,
) {
  const { compendiumId, actorId, folderId, name } = args;
  if (!compendiumId || typeof compendiumId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'compendiumId is required and must be a string');
  }
  if (!actorId || typeof actorId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'actorId is required and must be a string');
  }
  if (!moduleBridge) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'The module bridge is disabled. Set FOUNDRY_MODULE_BRIDGE_ENABLED=true and install the companion Foundry module.',
    );
  }

  return withToolError('import compendium actor', async () => {
    const rawDoc = (await moduleBridge.send('get_compendium_document', {
      packId: compendiumId,
      documentId: actorId,
    })) as Record<string, unknown>;

    if (typeof rawDoc.name !== 'string' || !rawDoc.name) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Compendium document ${compendiumId}/${actorId} has no usable name`,
      );
    }
    if (typeof rawDoc.type !== 'string' || !rawDoc.type) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Compendium document ${compendiumId}/${actorId} has no usable type`,
      );
    }

    const overrides: { name?: string; folder?: string } = {};
    if (name) {
      overrides.name = name;
    }
    if (folderId) {
      overrides.folder = folderId;
    }

    const rawItems = Array.isArray(rawDoc.items) ? rawDoc.items : [];
    const itemErrors: Array<{ name: string; error: string }> = [];
    let seededItems = rawItems.length;
    let fellBack = false;
    const actor = await foundryClient
      .createActorFromData(rawDoc, overrides)
      .catch(async (error) => {
        if (rawItems.length === 0) {
          throw error;
        }
        fellBack = true;
        seededItems = 0;
        return foundryClient.createActorFromData(rawDoc, { ...overrides, includeEmbedded: false });
      });

    if (fellBack) {
      for (const seed of rawItems) {
        const itemRecord =
          typeof seed === 'object' && seed !== null ? { ...(seed as Record<string, unknown>) } : {};
        delete itemRecord._id;
        delete itemRecord._stats;
        const itemName = typeof itemRecord.name === 'string' ? itemRecord.name : 'Unnamed item';
        try {
          await foundryClient.createActorItem(actor._id, { type: 'inline', item: itemRecord });
          seededItems++;
        } catch (itemError) {
          itemErrors.push({
            name: itemName,
            error: itemError instanceof Error ? itemError.message : String(itemError),
          });
        }
      }
    }

    const lines = [
      '📦 **Actor Imported**',
      `**Name:** ${actor.name}`,
      `**ID:** ${actor._id}`,
      `**Source:** compendium ${compendiumId} / ${actorId}`,
      `**Items:** ${seededItems}/${rawItems.length}`,
    ];
    if (fellBack) {
      lines.push('_The system rejected embedded items on create; items were seeded individually._');
    }
    if (itemErrors.length > 0) {
      lines.push('', '**Item errors:**', ...itemErrors.map((e) => `- ${e.name}: ${e.error}`));
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });
}

interface SetTargetResult {
  targeted: boolean;
  count: number;
  tokens: string[];
}

function isSetTargetResult(value: unknown): value is SetTargetResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SetTargetResult).targeted === 'boolean' &&
    typeof (value as SetTargetResult).count === 'number'
  );
}

export async function handleSetTarget(
  args: { tokenIds?: string[]; targeted?: boolean; replace?: boolean },
  moduleBridge: ModuleBridge | null,
) {
  if (!moduleBridge) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'The module bridge is disabled. Set FOUNDRY_MODULE_BRIDGE_ENABLED=true and install the companion Foundry module.',
    );
  }

  return withToolError('set target', async () => {
    const result = await moduleBridge.send('set_target', args);
    if (!isSetTargetResult(result)) {
      throw new McpError(ErrorCode.InternalError, 'Module returned an unexpected set_target shape');
    }
    const label = result.targeted ? 'Targeted' : 'Un-targeted';
    const tokenList = result.tokens.length > 0 ? ` (${result.tokens.join(', ')})` : '';
    return {
      content: [
        {
          type: 'text',
          text: `🎯 **${label} ${result.count} Token${result.count === 1 ? '' : 's'}**${tokenList}`,
        },
      ],
    };
  });
}

interface GetTargetsResult {
  users: Array<{
    userId: string;
    userName: string;
    tokenIds: string[];
    tokenNames: string[];
  }>;
}

function isGetTargetsResult(value: unknown): value is GetTargetsResult {
  return (
    typeof value === 'object' && value !== null && Array.isArray((value as GetTargetsResult).users)
  );
}

export async function handleGetTargets(
  _args: Record<string, unknown>,
  moduleBridge: ModuleBridge | null,
) {
  if (!moduleBridge) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'The module bridge is disabled. Set FOUNDRY_MODULE_BRIDGE_ENABLED=true and install the companion Foundry module.',
    );
  }

  return withToolError('get targets', async () => {
    const result = await moduleBridge.send('get_targets', {});
    if (!isGetTargetsResult(result)) {
      throw new McpError(
        ErrorCode.InternalError,
        'Module returned an unexpected get_targets shape',
      );
    }
    if (result.users.length === 0) {
      return {
        content: [{ type: 'text', text: '🎯 **No tokens are currently targeted by any user.**' }],
      };
    }
    const lines = result.users.map(
      (u) => `- **${u.userName}** (\`${u.userId}\`): ${u.tokenNames.join(', ') || 'none'}`,
    );
    return {
      content: [{ type: 'text', text: `🎯 **Current Target Selections**\n${lines.join('\n')}` }],
    };
  });
}

interface PingCanvasResult {
  x: number;
  y: number;
  sceneId?: string;
}

function isPingCanvasResult(value: unknown): value is PingCanvasResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PingCanvasResult).x === 'number' &&
    typeof (value as PingCanvasResult).y === 'number'
  );
}

export async function handlePingCanvas(
  args: { x: number; y: number; sceneId?: string },
  moduleBridge: ModuleBridge | null,
) {
  if (typeof args.x !== 'number' || typeof args.y !== 'number') {
    throw new McpError(
      ErrorCode.InvalidParams,
      'x and y coordinates are required and must be numbers',
    );
  }
  if (!moduleBridge) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'The module bridge is disabled. Set FOUNDRY_MODULE_BRIDGE_ENABLED=true and install the companion Foundry module.',
    );
  }

  return withToolError('ping canvas', async () => {
    const result = await moduleBridge.send('ping_canvas', args);
    if (!isPingCanvasResult(result)) {
      throw new McpError(
        ErrorCode.InternalError,
        'Module returned an unexpected ping_canvas shape',
      );
    }
    return {
      content: [
        {
          type: 'text',
          text: `📍 **Canvas Pinged at (${result.x}, ${result.y})**${result.sceneId ? ` on scene \`${result.sceneId}\`` : ''}`,
        },
      ],
    };
  });
}

interface SetPauseResult {
  paused: boolean;
}

function isSetPauseResult(value: unknown): value is SetPauseResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SetPauseResult).paused === 'boolean'
  );
}

export async function handleSetPause(
  args: { paused?: boolean },
  moduleBridge: ModuleBridge | null,
) {
  if (!moduleBridge) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'The module bridge is disabled. Set FOUNDRY_MODULE_BRIDGE_ENABLED=true and install the companion Foundry module.',
    );
  }

  return withToolError('set pause', async () => {
    const result = await moduleBridge.send('set_pause', args);
    if (!isSetPauseResult(result)) {
      throw new McpError(ErrorCode.InternalError, 'Module returned an unexpected set_pause shape');
    }
    return {
      content: [
        {
          type: 'text',
          text: result.paused ? '⏸️ **Game Paused**' : '▶️ **Game Resumed**',
        },
      ],
    };
  });
}

interface UploadAssetResult {
  path: string;
}

function isUploadAssetResult(value: unknown): value is UploadAssetResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as UploadAssetResult).path === 'string'
  );
}

const MIME_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
};

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MiB

export async function handleUploadAsset(
  args: {
    targetDir: string;
    filename: string;
    contentBase64?: string;
    sourcePath?: string;
    mimeType?: string;
  },
  moduleBridge: ModuleBridge | null,
) {
  const { targetDir, filename, contentBase64, sourcePath } = args;
  if (!targetDir || typeof targetDir !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'targetDir is required and must be a string');
  }
  if (!filename || typeof filename !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'filename is required and must be a string');
  }

  const hasBase64 = typeof contentBase64 === 'string' && contentBase64.length > 0;
  const hasSource = typeof sourcePath === 'string' && sourcePath.length > 0;

  if ((!hasBase64 && !hasSource) || (hasBase64 && hasSource)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Exactly one of contentBase64 or sourcePath must be provided',
    );
  }

  if (!moduleBridge) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'The module bridge is disabled. Set FOUNDRY_MODULE_BRIDGE_ENABLED=true and install the companion Foundry module.',
    );
  }

  return withToolError('upload asset', async () => {
    let base64Payload: string;
    let mimeType = args.mimeType;

    if (hasSource && sourcePath) {
      const buffer = await readFile(sourcePath);
      if (buffer.byteLength > MAX_UPLOAD_BYTES) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `File size (${buffer.byteLength} bytes) exceeds the 8 MiB upload limit`,
        );
      }
      base64Payload = buffer.toString('base64');
      if (!mimeType) {
        const ext = extname(sourcePath).toLowerCase();
        mimeType = MIME_EXTENSIONS[ext] ?? 'application/octet-stream';
      }
    } else {
      base64Payload = contentBase64 ?? '';
      const estimatedBytes = Math.ceil((base64Payload.length * 3) / 4);
      if (estimatedBytes > MAX_UPLOAD_BYTES) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Estimated payload size (${estimatedBytes} bytes) exceeds the 8 MiB upload limit`,
        );
      }
      if (!mimeType) {
        const ext = extname(filename).toLowerCase();
        mimeType = MIME_EXTENSIONS[ext] ?? 'application/octet-stream';
      }
    }

    const result = await moduleBridge.send('upload_asset', {
      targetDir,
      filename,
      contentBase64: base64Payload,
      mimeType,
    });

    if (!isUploadAssetResult(result)) {
      throw new McpError(
        ErrorCode.InternalError,
        'Module returned an unexpected upload_asset shape',
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: `📤 **Asset Uploaded**\n**Path:** \`${result.path}\`\n**Target Directory:** \`${targetDir}\`\n**Filename:** \`${filename}\`\n_Pass this path directly to create_scene (backgroundSrc), create_tile (src), or create_sound (path)._`,
        },
      ],
    };
  });
}
