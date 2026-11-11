/**
 * @fileoverview Actor attribute mutation tool handlers (laurigates/foundryvtt-mcp#143)
 *
 * Handles patching attributes on an actor's `system` object via dot-paths.
 * WRITE operation — requires FOUNDRY_WRITE_ENABLED=true and an active Socket.IO
 * connection (mutations use the core `modifyDocument` protocol).
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { AttributePatch, FoundryClient } from '../../foundry/client.js';
import { withToolError } from './utils.js';

/**
 * Handles actor attribute update requests.
 *
 * `patch` keys are dot-paths into the actor's `system` object — e.g.
 * `attributes.hp.value`, `attributes.hp.temp`, `currency.gp`,
 * `resources.primary.value`, `spells.spell1.value`, `attributes.exhaustion`.
 * The post-update value of every patched path is echoed back.
 */
export async function handleUpdateActorAttribute(
  args: {
    actorId?: string;
    sceneId?: string;
    tokenId?: string;
    patch: AttributePatch;
  },
  foundryClient: FoundryClient,
) {
  const { actorId, sceneId, tokenId, patch } = args;
  const byToken = typeof tokenId === 'string' && tokenId.length > 0;

  if (byToken && (typeof sceneId !== 'string' || !sceneId)) {
    throw new McpError(ErrorCode.InvalidParams, 'sceneId is required together with tokenId');
  }
  if (!byToken && (!actorId || typeof actorId !== 'string')) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'actorId (or sceneId + tokenId) is required and must be a string',
    );
  }
  if (
    patch === null ||
    typeof patch !== 'object' ||
    Array.isArray(patch) ||
    Object.keys(patch).length === 0
  ) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'patch is required and must be a non-empty object of dot-path attributes',
    );
  }

  return withToolError('update actor attributes', async () => {
    const result = byToken
      ? await foundryClient.updateTokenActorAttribute(sceneId as string, tokenId as string, patch)
      : await foundryClient.updateActorAttribute(actorId as string, patch);

    const updatedList = Object.entries(result.updatedAttributes)
      .map(([path, value]) => `- **${path}** → ${String(value)}`)
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `⚔️ **Actor Attributes Updated**
${byToken ? `**Token ID:** ${tokenId} (scene ${sceneId})` : `**Actor ID:** ${actorId}`}
**Status:** ${result.success ? 'Success' : 'Failed'}

**Updated attributes** (dot-paths into actor.system):
${updatedList}`,
        },
      ],
    };
  });
}

/**
 * Handles creating a new top-level Actor document (NPC/character sheet).
 */
export async function handleCreateWorldActor(
  args: {
    name: string;
    type: string;
    system?: Record<string, unknown>;
    folder?: string;
    flags?: Record<string, unknown>;
  },
  foundryClient: FoundryClient,
) {
  const { name, type, system, folder, flags } = args;

  if (!name || typeof name !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'name is required and must be a string');
  }
  if (!type || typeof type !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'type is required and must be a string');
  }

  return withToolError('create world actor', async () => {
    const actor = await foundryClient.createWorldActor(name, type, system, folder, flags);

    return {
      content: [
        {
          type: 'text',
          text: `🎭 **Actor Created**
**Name:** ${actor.name}
**Type:** ${actor.type}
**ID:** ${actor._id}`,
        },
      ],
    };
  });
}

/**
 * Handles creating a new top-level Actor document AND seeding it with
 * starting items (skills, gear, weapons, …) in one call.
 */
export async function handleCreateFullActor(
  args: {
    name: string;
    type: string;
    system?: Record<string, unknown>;
    folder?: string;
    items?: Array<{ name: string; type: string; system?: Record<string, unknown> }>;
  },
  foundryClient: FoundryClient,
) {
  const { name, type, ...options } = args;

  if (!name || typeof name !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'name is required and must be a string');
  }
  if (!type || typeof type !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'type is required and must be a string');
  }
  if (options.items !== undefined && !Array.isArray(options.items)) {
    throw new McpError(ErrorCode.InvalidParams, 'items must be an array when provided');
  }

  return withToolError('create full actor', async () => {
    const { actor, items, itemErrors } = await foundryClient.createFullActor(name, type, options);

    const itemLines =
      items.length > 0
        ? items.map((i) => `- ${i.name} (${i.type}) — ID: ${i._id}`).join('\n')
        : '_none_';
    const errorLines =
      itemErrors.length > 0
        ? `\n\n**Item Failures (${itemErrors.length}):**\n${itemErrors.map((e) => `- ${e.name}: ${e.error}`).join('\n')}`
        : '';

    return {
      content: [
        {
          type: 'text',
          text: `🎭 **Full Actor Created**
**Name:** ${actor.name}
**Type:** ${actor.type}
**ID:** ${actor._id}
**Items Created (${items.length}):**
${itemLines}${errorLines}`,
        },
      ],
    };
  });
}

/**
 * Handles permanently deleting a top-level Actor document.
 */
export async function handleDeleteWorldActor(
  args: { actorId: string },
  foundryClient: FoundryClient,
) {
  const { actorId } = args;

  if (!actorId || typeof actorId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'actorId is required and must be a string');
  }

  return withToolError('delete actor', async () => {
    await foundryClient.deleteWorldActor(actorId);

    return {
      content: [{ type: 'text', text: `🗑️ **Actor Deleted**\n**ID:** ${actorId}` }],
    };
  });
}
