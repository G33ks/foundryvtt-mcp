/**
 * @fileoverview Scene mutation tool handler
 *
 * WRITE operation — requires FOUNDRY_WRITE_ENABLED=true and an active
 * Socket.IO connection (mutations use the core `modifyDocument` protocol).
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { resolveSceneId } from './scenes.js';
import { deletionNote, withToolError } from './utils.js';

/**
 * Handles creating a new Scene document from a background image on disk.
 */
export async function handleCreateScene(
  args: {
    name: string;
    backgroundSrc: string;
    width?: number;
    height?: number;
    gridSize?: number;
    gridType?: number;
    gridDistance?: number;
    gridUnits?: string;
    padding?: number;
    backgroundColor?: string;
    activate?: boolean;
  },
  foundryClient: FoundryClient,
) {
  const { name, backgroundSrc, ...options } = args;

  if (!name || typeof name !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'name is required and must be a string');
  }
  if (!backgroundSrc || typeof backgroundSrc !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'backgroundSrc is required and must be a string');
  }

  return withToolError('create scene', async () => {
    const scene = (await foundryClient.createScene(name, backgroundSrc, options)) as {
      _id?: string;
      width?: number;
      height?: number;
      grid?: { size?: number };
    };
    return {
      content: [
        {
          type: 'text',
          text: `🗺️ **Scene Created**\n**Name:** ${name}\n**ID:** ${scene._id}\n**Dimensions:** ${scene.width} x ${scene.height} pixels\n**Grid:** ${scene.grid?.size}px${options.activate ? '\n**Activated:** Yes' : ''}`,
        },
      ],
    };
  });
}

/**
 * Handles activating a scene, switching every connected client's canvas to it.
 */
export async function handleSwitchScene(args: { sceneId: string }, foundryClient: FoundryClient) {
  const { sceneId } = args;

  if (!sceneId || typeof sceneId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'sceneId is required and must be a string');
  }

  return withToolError('switch scene', async () => {
    const scenes = foundryClient.getScenes();
    const target = scenes.find((s) => s._id === sceneId);
    const name = target?.name ?? sceneId;

    await foundryClient.switchScene(sceneId);

    return {
      content: [
        {
          type: 'text',
          text: `🗺️ **Scene Activated**
**Scene:** ${name} (${sceneId})
All connected players' canvases now show this scene.`,
        },
      ],
    };
  });
}

/**
 * Handles permanently deleting a Scene document.
 */
export async function handleDeleteScene(args: { sceneId: string }, foundryClient: FoundryClient) {
  const { sceneId } = args;

  if (!sceneId || typeof sceneId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'sceneId is required and must be a string');
  }

  return withToolError('delete scene', async () => {
    const target = foundryClient.getScenes().find((s) => s._id === sceneId);
    const name = target?.name ?? sceneId;
    const note = await foundryClient.deleteScene(sceneId);

    return {
      content: [
        {
          type: 'text',
          text: `🗑️ **Scene Deleted**\n**Scene:** ${name} (${sceneId})${deletionNote(note)}`,
        },
      ],
    };
  });
}

/**
 * Handles setting a scene's darkness level and/or global illumination fields.
 */
export async function handleSetSceneLighting(
  args: {
    sceneId: string;
    darkness?: number;
    globalLight?: boolean;
    globalLightThreshold?: number;
  },
  foundryClient: FoundryClient,
) {
  const { sceneId, darkness, globalLight, globalLightThreshold } = args;

  if (!sceneId || typeof sceneId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'sceneId is required and must be a string');
  }
  if (darkness === undefined && globalLight === undefined && globalLightThreshold === undefined) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'At least one of darkness, globalLight, globalLightThreshold is required',
    );
  }

  return withToolError('set scene lighting', async () => {
    const target = foundryClient.getScenes().find((s) => s._id === sceneId);
    const name = target?.name ?? sceneId;
    const options: { darkness?: number; globalLight?: boolean; globalLightThreshold?: number } = {};
    if (darkness !== undefined) {
      options.darkness = darkness;
    }
    if (globalLight !== undefined) {
      options.globalLight = globalLight;
    }
    if (globalLightThreshold !== undefined) {
      options.globalLightThreshold = globalLightThreshold;
    }
    await foundryClient.setSceneLighting(sceneId, options);

    const changes = [
      darkness !== undefined ? `darkness → ${darkness}` : null,
      globalLight !== undefined ? `globalLight → ${globalLight}` : null,
      globalLightThreshold !== undefined ? `globalLightThreshold → ${globalLightThreshold}` : null,
    ]
      .filter((line): line is string => line !== null)
      .join(', ');

    return {
      content: [
        {
          type: 'text',
          text: `💡 **Scene Lighting Updated**\n**Scene:** ${name} (${sceneId})\n**Changed:** ${changes}`,
        },
      ],
    };
  });
}

/**
 * Handles resetting fog of war exploration for a scene.
 */
export async function handleResetFog(args: { sceneId?: string }, foundryClient: FoundryClient) {
  const sceneId = resolveSceneId(args.sceneId, foundryClient);

  return withToolError('reset fog', async () => {
    const scene = foundryClient.getScenes().find((s) => s._id === sceneId);
    await foundryClient.resetFog(sceneId);

    return {
      content: [
        {
          type: 'text',
          text: `🌫️ **Fog of War Reset Requested**\n**Scene:** ${scene?.name ?? sceneId} (${sceneId})\n_Exploration progress reset sent via socket; verify canvas via capture_scene if needed._`,
        },
      ],
    };
  });
}

/**
 * Handles updating or clearing a scene's weather effect.
 */
export async function handleSetSceneWeather(
  args: { weather: string; sceneId?: string },
  foundryClient: FoundryClient,
) {
  const { weather } = args;
  if (typeof weather !== 'string') {
    throw new McpError(
      ErrorCode.InvalidParams,
      'weather is required and must be a string (empty to clear)',
    );
  }
  const sceneId = resolveSceneId(args.sceneId, foundryClient);

  return withToolError('set scene weather', async () => {
    const target = foundryClient.getScenes().find((s) => s._id === sceneId);
    const name = target?.name ?? sceneId;
    await foundryClient.setSceneWeather(sceneId, weather);

    const label = weather ? `set to "${weather}"` : 'cleared';
    return {
      content: [
        {
          type: 'text',
          text: `🌧️ **Scene Weather Updated**\n**Scene:** ${name} (${sceneId})\n**Weather:** ${label}`,
        },
      ],
    };
  });
}
