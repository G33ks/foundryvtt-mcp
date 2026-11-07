/**
 * @fileoverview Token manipulation mutation tool handlers (FR-019)
 *
 * Provides GM-gated token-control tools that operate on tokens placed on
 * scenes: moving a token to new coordinates, and applying/removing a status
 * condition (ActiveEffect) on the token's actor. All are WRITE operations —
 * they require FOUNDRY_WRITE_ENABLED=true and an active Socket.IO connection
 * (mutations use the core `modifyDocument` protocol), and the connected user
 * needs GM/owner permission.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { WorldEffect } from '../../foundry/types.js';
import { withToolError } from './utils.js';

/** Raw token fields we read to resolve its actor and link state. */
interface TokenActorRef {
  actorId?: string;
  actorLink?: boolean;
  name?: string;
}

/**
 * Moves a token to x/y coordinates on its scene (FR-019).
 *
 * The token is resolved from the cached worldData; `sceneId` is optional and
 * only scopes the lookup (the parent scene is derived from the located token).
 */
export async function handleMoveToken(
  args: { tokenId: string; x: number; y: number; sceneId?: string },
  foundryClient: FoundryClient,
) {
  const { tokenId, x, y, sceneId } = args;

  if (!tokenId || typeof tokenId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'tokenId is required and must be a string');
  }
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y)
  ) {
    throw new McpError(ErrorCode.InvalidParams, 'x and y are required and must be finite numbers');
  }

  const located = foundryClient.findToken(tokenId, sceneId);
  if (!located) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Token not found: ${tokenId}${sceneId ? ` on scene ${sceneId}` : ''}`,
    );
  }

  return withToolError('move token', async () => {
    const tokenName = (located.token as TokenActorRef).name ?? tokenId;
    await foundryClient.moveToken(located.scene._id, tokenId, x, y);

    return {
      content: [
        {
          type: 'text',
          text: `🚶 **Token Moved**
**Token:** ${tokenName} (${tokenId})
**Scene:** ${located.scene.name} (${located.scene._id})
**Position:** (${x}, ${y})`,
        },
      ],
    };
  });
}

/**
 * Applies or removes a status condition (ActiveEffect) on a token's actor
 * (FR-019).
 *
 * `active` defaults to `true` (apply). Mirrors `Actor#toggleStatusEffect`:
 * the effect is matched by its `statuses` array, so re-applying an already
 * present condition (or removing an absent one) is a no-op. Linked actors
 * resolve to `Actor.<id>`; unlinked tokens target their synthetic actor at
 * `Scene.<sid>.Token.<tid>.Actor.<aid>`, whose effects are the base actor's
 * merged with the token's delta: removing an inherited status is a delete
 * under the token's ActorDelta, for which FoundryVTT records a tombstone.
 */
export async function handleApplyStatusEffect(
  args: { tokenId: string; statusId: string; active?: boolean; sceneId?: string },
  foundryClient: FoundryClient,
) {
  const { tokenId, statusId, sceneId } = args;
  const active = args.active ?? true;

  if (!tokenId || typeof tokenId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'tokenId is required and must be a string');
  }
  if (!statusId || typeof statusId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'statusId is required and must be a string');
  }

  const located = foundryClient.findToken(tokenId, sceneId);
  if (!located) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Token not found: ${tokenId}${sceneId ? ` on scene ${sceneId}` : ''}`,
    );
  }

  const token = located.token as TokenActorRef;
  const actorId = token.actorId;
  if (!actorId) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Token ${tokenId} has no associated actor; cannot apply status effects.`,
    );
  }

  // Linked tokens share the world actor; unlinked tokens own a synthetic actor
  // (the per-token delta) that must be addressed through the Scene→Token path.
  const linked = token.actorLink === true;
  const parentActorUuid = linked
    ? `Actor.${actorId}`
    : `Scene.${located.scene._id}.Token.${tokenId}.Actor.${actorId}`;

  // Find an existing effect carrying this status (matches toggleStatusEffect).
  const effects: WorldEffect[] =
    foundryClient.getTokenActorEffects(tokenId, located.scene._id) ?? [];
  const existing = effects.find((e) => e.statuses?.includes(statusId));

  return withToolError('apply status effect', async () => {
    if (active) {
      if (existing) {
        return statusResult(
          `Status effect '${statusId}' is already active on ${token.name ?? tokenId}.`,
          tokenId,
          located.scene,
          statusId,
          true,
        );
      }
      const effect = await foundryClient.createActorStatusEffect(parentActorUuid, statusId);
      return statusResult(
        `Applied status effect '${statusId}' (effect ${effect._id}).`,
        tokenId,
        located.scene,
        statusId,
        true,
      );
    }

    if (!existing) {
      return statusResult(
        `Status effect '${statusId}' is not active on ${token.name ?? tokenId}; nothing to remove.`,
        tokenId,
        located.scene,
        statusId,
        false,
      );
    }
    await foundryClient.deleteActorEffect(parentActorUuid, existing._id);
    return statusResult(
      `Removed status effect '${statusId}' (effect ${existing._id}).`,
      tokenId,
      located.scene,
      statusId,
      false,
    );
  });
}

/** Builds the MCP text result for a status-effect mutation. */
function statusResult(
  summary: string,
  tokenId: string,
  scene: { _id: string; name: string },
  statusId: string,
  active: boolean,
) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `${active ? '✨' : '🧹'} **Status Effect ${active ? 'Applied' : 'Removed'}**
**Token:** ${tokenId}
**Scene:** ${scene.name} (${scene._id})
**Status:** ${statusId}
${summary}`,
      },
    ],
  };
}

/**
 * Places a new token for an existing actor onto a scene.
 *
 * Defaults `sceneId` to the current active scene when omitted.
 */
export async function handleSpawnToken(
  args: {
    actorId: string;
    x: number;
    y: number;
    sceneId?: string;
    name?: string;
    hidden?: boolean;
  },
  foundryClient: FoundryClient,
) {
  const { actorId, x, y, name, hidden } = args;

  if (!actorId || typeof actorId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'actorId is required and must be a string');
  }
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y)
  ) {
    throw new McpError(ErrorCode.InvalidParams, 'x and y are required and must be finite numbers');
  }

  let resolvedSceneId = args.sceneId;
  if (!resolvedSceneId) {
    const active = foundryClient.getScenes().find((s) => s.active);
    if (!active) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'No active scene and no sceneId given — pass sceneId explicitly.',
      );
    }
    resolvedSceneId = active._id;
  }
  const sceneId = resolvedSceneId;

  return withToolError('spawn token', async () => {
    const scenes = foundryClient.getScenes();
    const scene = scenes.find((s) => s._id === sceneId);
    const tokenOptions: { name?: string; hidden?: boolean } = {};
    if (name) {
      tokenOptions.name = name;
    }
    if (hidden !== undefined) {
      tokenOptions.hidden = hidden;
    }
    const token = await foundryClient.spawnToken(sceneId, actorId, x, y, tokenOptions);
    const tokenId =
      token && typeof token === 'object' && '_id' in token && typeof token._id === 'string'
        ? token._id
        : 'unknown';

    return {
      content: [
        {
          type: 'text',
          text: `🧙 **Token Spawned**
**Token ID:** ${tokenId}
**Actor:** ${actorId}
**Scene:** ${scene?.name ?? sceneId} (${sceneId})
**Position:** (${x}, ${y})`,
        },
      ],
    };
  });
}

/**
 * Handles removing a token from a scene (does not delete the actor).
 */
export async function handleDeleteToken(
  args: { tokenId: string; sceneId?: string },
  foundryClient: FoundryClient,
) {
  const { tokenId, sceneId } = args;

  if (!tokenId || typeof tokenId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'tokenId is required and must be a string');
  }

  const located = foundryClient.findToken(tokenId, sceneId);
  if (!located) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Token not found: ${tokenId}${sceneId ? ` on scene ${sceneId}` : ''}`,
    );
  }

  return withToolError('delete token', async () => {
    const tokenName = (located.token as TokenActorRef).name ?? tokenId;
    await foundryClient.deleteToken(located.scene._id, tokenId);

    return {
      content: [
        {
          type: 'text',
          text: `🧹 **Token Removed**
**Token:** ${tokenName} (${tokenId})
**Scene:** ${located.scene.name} (${located.scene._id})`,
        },
      ],
    };
  });
}

/**
 * Handles moving a token to (x, y), routing around walls and — unless
 * openDoors is false — opening any closed doors the route needs to pass
 * through.
 */
export async function handleMoveTokenPathfind(
  args: { tokenId: string; x: number; y: number; sceneId?: string; openDoors?: boolean },
  foundryClient: FoundryClient,
) {
  const { tokenId, x, y, sceneId, openDoors } = args;

  if (!tokenId || typeof tokenId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'tokenId is required and must be a string');
  }
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y)
  ) {
    throw new McpError(ErrorCode.InvalidParams, 'x and y are required and must be finite numbers');
  }

  const located = foundryClient.findToken(tokenId, sceneId);
  if (!located) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Token not found: ${tokenId}${sceneId ? ` on scene ${sceneId}` : ''}`,
    );
  }

  return withToolError('move token (pathfinding)', async () => {
    const tokenName = (located.token as TokenActorRef).name ?? tokenId;
    const pathOptions: { openDoors?: boolean } = {};
    if (openDoors !== undefined) {
      pathOptions.openDoors = openDoors;
    }
    const result = await foundryClient.moveTokenPathfind(
      located.scene._id,
      tokenId,
      x,
      y,
      pathOptions,
    );

    if (result.blocked) {
      return {
        content: [
          {
            type: 'text',
            text: `🚧 **No Route Found**
**Token:** ${tokenName} (${tokenId})
**Scene:** ${located.scene.name} (${located.scene._id})
No path to (${x}, ${y}) avoiding walls${openDoors === false ? '' : ' and closed doors'}.`,
          },
        ],
      };
    }

    const doorsLine =
      result.doorsOpened.length > 0 ? `\n**Doors Opened:** ${result.doorsOpened.join(', ')}` : '';

    return {
      content: [
        {
          type: 'text',
          text: `🚶 **Token Moved (pathfinding)**
**Token:** ${tokenName} (${tokenId})
**Scene:** ${located.scene.name} (${located.scene._id})
**Waypoints:** ${result.path.length}
**Destination:** (${x}, ${y})${doorsLine}`,
        },
      ],
    };
  });
}

/** One move within a {@link handleMoveTokens} batch. */
interface TokenMoveRequest {
  tokenId: string;
  x: number;
  y: number;
  sceneId?: string;
  pathfind?: boolean;
  openDoors?: boolean;
}

/**
 * Moves several tokens in a single call — direct (`move_token`) by default,
 * or wall-aware pathfinding (`move_token_pathfind`) per move when
 * `pathfind: true`. Best-effort per move, like `create_full_actor`'s item
 * seeding: one bad move (an unknown tokenId, a blocked route, a rejected
 * write) is reported in the failure list rather than aborting moves that
 * already succeeded.
 *
 * `FOUNDRY_WRITE_ENABLED` is checked once up front so a fully-disabled
 * batch reports one clear error instead of the same "writes disabled"
 * message once per move.
 */
export async function handleMoveTokens(
  args: { moves: TokenMoveRequest[] },
  foundryClient: FoundryClient,
) {
  const { moves } = args;
  if (!Array.isArray(moves) || moves.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, 'moves is required and must be a non-empty array');
  }
  for (const [i, move] of moves.entries()) {
    if (!move || typeof move !== 'object') {
      throw new McpError(ErrorCode.InvalidParams, `moves[${i}] must be an object`);
    }
    if (!move.tokenId || typeof move.tokenId !== 'string') {
      throw new McpError(
        ErrorCode.InvalidParams,
        `moves[${i}].tokenId is required and must be a string`,
      );
    }
    if (
      typeof move.x !== 'number' ||
      !Number.isFinite(move.x) ||
      typeof move.y !== 'number' ||
      !Number.isFinite(move.y)
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `moves[${i}].x and moves[${i}].y are required and must be finite numbers`,
      );
    }
  }
  if (!foundryClient.isWriteEnabled()) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'Write operations are disabled. Set FOUNDRY_WRITE_ENABLED=true to allow game-state mutation.',
    );
  }

  return withToolError('move tokens', async () => {
    const succeeded: string[] = [];
    const failed: string[] = [];

    for (const move of moves) {
      const located = foundryClient.findToken(move.tokenId, move.sceneId);
      if (!located) {
        failed.push(
          `${move.tokenId}: token not found${move.sceneId ? ` on scene ${move.sceneId}` : ''}`,
        );
        continue;
      }
      const tokenName = (located.token as TokenActorRef).name ?? move.tokenId;
      try {
        if (move.pathfind) {
          const pathOptions: { openDoors?: boolean } = {};
          if (move.openDoors !== undefined) {
            pathOptions.openDoors = move.openDoors;
          }
          const result = await foundryClient.moveTokenPathfind(
            located.scene._id,
            move.tokenId,
            move.x,
            move.y,
            pathOptions,
          );
          if (result.blocked) {
            failed.push(`${tokenName} (${move.tokenId}): no route to (${move.x}, ${move.y})`);
            continue;
          }
          const doorsNote =
            result.doorsOpened.length > 0 ? `, opened ${result.doorsOpened.length} door(s)` : '';
          succeeded.push(
            `${tokenName} (${move.tokenId}) → (${move.x}, ${move.y}) via ${result.path.length} waypoint(s)${doorsNote}`,
          );
        } else {
          await foundryClient.moveToken(located.scene._id, move.tokenId, move.x, move.y);
          succeeded.push(`${tokenName} (${move.tokenId}) → (${move.x}, ${move.y})`);
        }
      } catch (error) {
        failed.push(
          `${tokenName} (${move.tokenId}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const lines = [
      `🚶 **Tokens Moved** (${succeeded.length}/${moves.length})`,
      ...succeeded.map((s) => `- ${s}`),
    ];
    if (failed.length > 0) {
      lines.push('', `**Failed (${failed.length}):**`, ...failed.map((f) => `- ${f}`));
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });
}

/**
 * Updates a token's vision and/or light emission properties.
 */
export async function handleUpdateTokenVision(
  args: {
    tokenId: string;
    sceneId?: string;
    sightEnabled?: boolean;
    sightRange?: number;
    sightAngle?: number;
    visionMode?: string;
    lightDim?: number;
    lightBright?: number;
    lightColor?: string;
    lightAngle?: number;
    lightAnimationType?: string;
  },
  foundryClient: FoundryClient,
) {
  const { tokenId, sceneId } = args;
  if (!tokenId || typeof tokenId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'tokenId is required and must be a string');
  }

  const located = foundryClient.findToken(tokenId, sceneId);
  if (!located) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Token not found: ${tokenId}${sceneId ? ` on scene ${sceneId}` : ''}`,
    );
  }

  return withToolError('update token vision', async () => {
    const tokenName = (located.token as TokenActorRef).name ?? tokenId;
    await foundryClient.updateTokenVision(located.scene._id, tokenId, args);

    return {
      content: [
        {
          type: 'text',
          text: `👁️ **Token Vision/Light Updated**\n**Token:** ${tokenName} (${tokenId})\n**Scene:** ${located.scene.name} (${located.scene._id})`,
        },
      ],
    };
  });
}
