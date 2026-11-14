/**
 * @fileoverview Scene management tool handlers
 *
 * Handles scene information retrieval and management.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { readSceneLighting } from '../../foundry/scene-lighting.js';
import { withToolError } from './utils.js';

/**
 * Handles scene information requests
 */
export async function handleGetSceneInfo(
  args: {
    sceneId?: string;
  },
  foundryClient: FoundryClient,
) {
  const { sceneId } = args;

  return withToolError('get scene info', async () => {
    const scene = await foundryClient.getCurrentScene(sceneId);
    // The REST API module answers with the raw document, which keeps them under `environment`.
    const { darkness, globalLight } = readSceneLighting(scene);
    const lightLabel = globalLight === undefined ? 'Unknown' : globalLight ? 'Enabled' : 'Disabled';
    const darknessLabel = darkness === undefined ? 'Unknown' : `${Math.round(darkness * 100)}%`;

    return {
      content: [
        {
          type: 'text',
          text: `🗺️ **Scene Information**
**Name:** ${scene.name}
**ID:** ${scene._id}
**Active:** ${scene.active ? 'Yes' : 'No'}
**Navigation:** ${scene.navigation ? 'Enabled' : 'Disabled'}
**Dimensions:** ${scene.width} x ${scene.height} pixels
**Padding:** ${scene.padding * 100}%
**Grid:** ${scene.grid ? `${scene.grid.size}px, distance ${scene.grid.distance}${scene.grid.units ? ` ${scene.grid.units}` : ''}` : 'Unknown'}
**Global Light:** ${lightLabel}
**Darkness Level:** ${darknessLabel}

**Description:** ${scene.description || 'No description available.'}`,
        },
      ],
    };
  });
}

/**
 * Resolves a sceneId, defaulting to the currently active scene if omitted.
 * Throws an McpError if no scene is active and no sceneId is provided.
 */
export function resolveSceneId(sceneId: string | undefined, foundryClient: FoundryClient): string {
  if (sceneId) {
    return sceneId;
  }
  const active = foundryClient.getScenes().find((s) => s.active);
  if (!active) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'No active scene and no sceneId given — pass sceneId explicitly.',
    );
  }
  return active._id;
}

/**
 * Handles listing the Tiles placed on a scene.
 */
export async function handleListTiles(args: { sceneId?: string }, foundryClient: FoundryClient) {
  const sceneId = resolveSceneId(args.sceneId, foundryClient);

  return withToolError('list tiles', async () => {
    const scene = foundryClient.getScenes().find((s) => s._id === sceneId);
    const tiles = foundryClient.listTiles(sceneId);
    if (tiles.length === 0) {
      return {
        content: [{ type: 'text', text: `🧱 **No tiles placed on ${scene?.name ?? sceneId}.**` }],
      };
    }
    const lines = tiles.map(
      (t) =>
        `- **${t.src.split('/').pop()}** (${t.id}) — (${t.x}, ${t.y}) ${t.width}x${t.height}px${t.rotation ? `, rotated ${t.rotation}°` : ''}${t.hidden ? ' [hidden]' : ''}`,
    );
    return {
      content: [
        {
          type: 'text',
          text: `🧱 **Tiles on ${scene?.name ?? sceneId}** (${tiles.length})\n${lines.join('\n')}`,
        },
      ],
    };
  });
}

/**
 * Handles listing the Walls on a scene.
 */
export async function handleListWalls(args: { sceneId?: string }, foundryClient: FoundryClient) {
  const sceneId = resolveSceneId(args.sceneId, foundryClient);

  return withToolError('list walls', async () => {
    const scene = foundryClient.getScenes().find((s) => s._id === sceneId);
    const walls = foundryClient.listWalls(sceneId);
    if (walls.length === 0) {
      return {
        content: [{ type: 'text', text: `🧱 **No walls on ${scene?.name ?? sceneId}.**` }],
      };
    }
    const lines = walls.map((w) => {
      const kind = w.door === 1 ? ' [door]' : w.door === 2 ? ' [secret door]' : '';
      const state = w.door !== 0 ? ` (${['closed', 'open', 'locked'][w.ds]})` : '';
      return `- **${w.id}** — (${w.x1}, ${w.y1}) → (${w.x2}, ${w.y2})${kind}${state}`;
    });
    return {
      content: [
        {
          type: 'text',
          text: `🧱 **Walls on ${scene?.name ?? sceneId}** (${walls.length})\n${lines.join('\n')}`,
        },
      ],
    };
  });
}

/**
 * Handles listing the Tokens placed on a scene, defaulting to the active
 * scene when sceneId is omitted (mirrors handleSpawnToken).
 */
export async function handleListTokens(args: { sceneId?: string }, foundryClient: FoundryClient) {
  const sceneId = resolveSceneId(args.sceneId, foundryClient);

  return withToolError('list tokens', async () => {
    const scene = foundryClient.getScenes().find((s) => s._id === sceneId);
    const tokens = foundryClient.listTokens(sceneId);
    if (tokens.length === 0) {
      return {
        content: [{ type: 'text', text: `🧍 **No tokens placed on ${scene?.name ?? sceneId}.**` }],
      };
    }
    const dispositionLabels: Record<number, string> = {
      [-2]: 'secret',
      [-1]: 'hostile',
      0: 'neutral',
      1: 'friendly',
    };
    const lines = tokens.map((t) => {
      const actorRef = t.actorId ? ` — actor ${t.actorId}${t.actorLink ? '' : ' (unlinked)'}` : '';
      const disposition = dispositionLabels[t.disposition] ?? `disposition ${t.disposition}`;
      return `- **${t.name || '(unnamed)'}** (${t.id}) — (${t.x}, ${t.y}) ${t.width}x${t.height} cells${t.elevation ? `, elevation ${t.elevation}` : ''}, ${disposition}${t.hidden ? ' [hidden]' : ''}${actorRef}`;
    });
    return {
      content: [
        {
          type: 'text',
          text: `🧍 **Tokens on ${scene?.name ?? sceneId}** (${tokens.length})\n${lines.join('\n')}`,
        },
      ],
    };
  });
}

/**
 * Handles listing the AmbientLights placed on a scene.
 */
export async function handleListLights(args: { sceneId?: string }, foundryClient: FoundryClient) {
  const sceneId = resolveSceneId(args.sceneId, foundryClient);

  return withToolError('list lights', async () => {
    const scene = foundryClient.getScenes().find((s) => s._id === sceneId);
    const lights = foundryClient.listLights(sceneId);
    if (lights.length === 0) {
      return {
        content: [{ type: 'text', text: `💡 **No ambient lights on ${scene?.name ?? sceneId}.**` }],
      };
    }
    const lines = lights.map(
      (l) =>
        `- **${l.id}** — (${l.x}, ${l.y}) dim: ${l.dim}, bright: ${l.bright}${l.color ? `, color: ${l.color}` : ''}${l.rotation ? `, rotated ${l.rotation}°` : ''}${l.animationType ? ` [animation: ${l.animationType}]` : ''}${l.hidden ? ' [hidden]' : ''}`,
    );
    return {
      content: [
        {
          type: 'text',
          text: `💡 **Ambient Lights on ${scene?.name ?? sceneId}** (${lights.length})\n${lines.join('\n')}`,
        },
      ],
    };
  });
}

/**
 * Handles listing the AmbientSounds placed on a scene.
 */
export async function handleListSounds(args: { sceneId?: string }, foundryClient: FoundryClient) {
  const sceneId = resolveSceneId(args.sceneId, foundryClient);

  return withToolError('list sounds', async () => {
    const scene = foundryClient.getScenes().find((s) => s._id === sceneId);
    const sounds = foundryClient.listSounds(sceneId);
    if (sounds.length === 0) {
      return {
        content: [{ type: 'text', text: `🔊 **No ambient sounds on ${scene?.name ?? sceneId}.**` }],
      };
    }
    const lines = sounds.map(
      (s) =>
        `- **${s.id}** — (${s.x}, ${s.y}) radius: ${s.radius}px, path: \`${s.path}\`, volume: ${s.volume}${s.repeat ? ' [repeat]' : ''}${s.hidden ? ' [hidden]' : ''}`,
    );
    return {
      content: [
        {
          type: 'text',
          text: `🔊 **Ambient Sounds on ${scene?.name ?? sceneId}** (${sounds.length})\n${lines.join('\n')}`,
        },
      ],
    };
  });
}

/**
 * Handles listing the Notes (map pins) placed on a scene.
 */
export async function handleListNotes(args: { sceneId?: string }, foundryClient: FoundryClient) {
  const sceneId = resolveSceneId(args.sceneId, foundryClient);

  return withToolError('list notes', async () => {
    const scene = foundryClient.getScenes().find((s) => s._id === sceneId);
    const notes = foundryClient.listNotes(sceneId);
    if (notes.length === 0) {
      return {
        content: [{ type: 'text', text: `📌 **No map notes on ${scene?.name ?? sceneId}.**` }],
      };
    }
    const lines = notes.map(
      (n) =>
        `- **${n.id}** — (${n.x}, ${n.y})${n.text ? ` text: "${n.text}"` : ''}${n.entryId ? ` (linked journal ${n.entryId}${n.pageId ? ` page ${n.pageId}` : ''})` : ''}${n.global ? ' [global]' : ''}`,
    );
    return {
      content: [
        {
          type: 'text',
          text: `📌 **Map Notes on ${scene?.name ?? sceneId}** (${notes.length})\n${lines.join('\n')}`,
        },
      ],
    };
  });
}

/**
 * Handles listing the Drawings placed on a scene.
 */
export async function handleListDrawings(args: { sceneId?: string }, foundryClient: FoundryClient) {
  const sceneId = resolveSceneId(args.sceneId, foundryClient);

  return withToolError('list drawings', async () => {
    const scene = foundryClient.getScenes().find((s) => s._id === sceneId);
    const drawings = foundryClient.listDrawings(sceneId);
    if (drawings.length === 0) {
      return {
        content: [{ type: 'text', text: `🎨 **No drawings on ${scene?.name ?? sceneId}.**` }],
      };
    }
    const lines = drawings.map(
      (d) =>
        `- **${d.id}** — [${d.shapeType}] (${d.x}, ${d.y})${d.width !== null ? ` ${d.width}x${d.height}px` : ''}${d.radius !== null ? ` radius ${d.radius}px` : ''}${d.text ? ` text: "${d.text}"` : ''}${d.fillColor ? ` fill: ${d.fillColor}` : ''}${d.strokeColor ? ` stroke: ${d.strokeColor}` : ''}${d.hidden ? ' [hidden]' : ''}${d.locked ? ' [locked]' : ''}`,
    );
    return {
      content: [
        {
          type: 'text',
          text: `🎨 **Drawings on ${scene?.name ?? sceneId}** (${drawings.length})\n${lines.join('\n')}`,
        },
      ],
    };
  });
}

/**
 * Handles listing the MeasuredTemplates placed on a scene.
 */
export async function handleListTemplates(
  args: { sceneId?: string },
  foundryClient: FoundryClient,
) {
  const sceneId = resolveSceneId(args.sceneId, foundryClient);

  return withToolError('list templates', async () => {
    const scene = foundryClient.getScenes().find((s) => s._id === sceneId);
    const templates = foundryClient.listTemplates(sceneId);
    if (templates.length === 0) {
      return {
        content: [
          { type: 'text', text: `📐 **No measured templates on ${scene?.name ?? sceneId}.**` },
        ],
      };
    }
    const lines = templates.map(
      (t) =>
        `- **${t.id}** — [${t.t}] (${t.x}, ${t.y}) distance: ${t.distance}${t.direction ? `, dir: ${t.direction}°` : ''}${t.angle ? `, angle: ${t.angle}°` : ''}${t.width ? `, width: ${t.width}` : ''}${t.fillColor ? ` fill: ${t.fillColor}` : ''}${t.hidden ? ' [hidden]' : ''}`,
    );
    return {
      content: [
        {
          type: 'text',
          text: `📐 **Measured Templates on ${scene?.name ?? sceneId}** (${templates.length})\n${lines.join('\n')}`,
        },
      ],
    };
  });
}

/**
 * Handles scanning a scene's grid for open (wall-free, unoccupied) cells.
 */
export async function handleFindOpenCells(
  args: { sceneId: string; limit?: number },
  foundryClient: FoundryClient,
) {
  const { sceneId, limit } = args;
  if (!sceneId || typeof sceneId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'sceneId is required and must be a string');
  }

  return withToolError('find open cells', async () => {
    const cells = foundryClient.findOpenCells(sceneId, limit !== undefined ? { limit } : {});
    if (cells.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: '🔲 **No open cells found** (scene may be fully walled or occupied).',
          },
        ],
      };
    }
    const lines = cells.map((c) => `- col ${c.col}, row ${c.row} → (${c.x}, ${c.y})`);
    return {
      content: [
        {
          type: 'text',
          text: `🔲 **Open Cells** (${cells.length})\n${lines.join('\n')}`,
        },
      ],
    };
  });
}

/**
 * Handles listing image assets under FoundryVTT's Data directory.
 */
export async function handleListSceneAssets(
  args: { subdir?: string; query?: string; limit?: number },
  foundryClient: FoundryClient,
) {
  const { subdir, query, limit } = args;

  return withToolError('list scene assets', async () => {
    const options: { query?: string; limit?: number } = {};
    if (query !== undefined) {
      options.query = query;
    }
    if (limit !== undefined) {
      options.limit = limit;
    }
    const assets = foundryClient.listSceneAssets(subdir, options);
    if (assets.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: '🖼️ **No assets found.** Verify FOUNDRY_DATA_PATH is set and the folder exists.',
          },
        ],
      };
    }
    const lines = assets.map(
      (a) =>
        `- **${a.name}** — \`${a.path}\` (${a.width}x${a.height})${a.tags.length ? ` [${a.tags.join(', ')}]` : ''}`,
    );
    return {
      content: [
        {
          type: 'text',
          text: `🖼️ **Scene Assets** (${assets.length})\n${lines.join('\n')}`,
        },
      ],
    };
  });
}

/**
 * Handles listing the Scene Regions placed on a scene (FoundryVTT v12+).
 */
export async function handleListRegions(args: { sceneId?: string }, foundryClient: FoundryClient) {
  const sceneId = resolveSceneId(args.sceneId, foundryClient);

  return withToolError('list regions', async () => {
    const scene = foundryClient.getScenes().find((s) => s._id === sceneId);
    const regions = foundryClient.listRegions(sceneId);
    if (regions.length === 0) {
      return {
        content: [{ type: 'text', text: `🌐 **No regions on ${scene?.name ?? sceneId}.**` }],
      };
    }
    const lines = regions.map((r) => {
      const elev =
        r.elevation.bottom !== null || r.elevation.top !== null
          ? ` elevation: [${r.elevation.bottom ?? '-∞'}, ${r.elevation.top ?? '+∞'}]`
          : '';
      const color = r.color ? ` color: ${r.color}` : '';
      return `- **${r.name || r.id}** (\`${r.id}\`)${color}${elev} (${r.shapesCount} shape${r.shapesCount === 1 ? '' : 's'}, ${r.behaviorsCount} behavior${r.behaviorsCount === 1 ? '' : 's'})`;
    });
    return {
      content: [
        {
          type: 'text',
          text: `🌐 **Scene Regions on ${scene?.name ?? sceneId}** (${regions.length})\n${lines.join('\n')}`,
        },
      ],
    };
  });
}
