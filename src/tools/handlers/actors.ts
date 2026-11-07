/**
 * @fileoverview Actor management tool handlers
 *
 * Handles searching for actors and retrieving detailed actor information.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import {
  type ActorTargetArgs,
  isUnlinkedToken,
  resolveActorTarget,
  tokenHeaderLine,
} from './actor-target.js';
import { withToolError } from './utils.js';

/**
 * Handles actor search requests
 */
export async function handleSearchActors(
  args: {
    query?: string;
    type?: string;
    limit?: number;
    cursor?: string;
  },
  foundryClient: FoundryClient,
) {
  const { query, type, limit = 10, cursor } = args;

  return withToolError('search actors', async () => {
    const searchParams: { query: string; type?: string; limit: number; cursor?: string } = {
      query: query || '',
      limit,
    };
    if (type) {
      searchParams.type = type;
    }
    if (cursor) {
      searchParams.cursor = cursor;
    }
    const result = await foundryClient.searchActors(searchParams);
    const actorList = result.actors
      .map(
        (actor) =>
          `- **${actor.name}** (${actor.type}) - Level ${actor.level || 'Unknown'} - HP: ${actor.hp?.value || 'Unknown'}/${actor.hp?.max || 'Unknown'}`,
      )
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `🎭 **Actor Search Results**
**Query:** ${query || 'All actors'}
**Type Filter:** ${type || 'All types'}
**Results:** ${result.actors.length}/${result.total} total

${actorList || 'No actors found matching the criteria.'}

**Page:** ${result.page} | **Limit:** ${result.limit}${result.nextCursor ? `\n\n_More results available. Pass cursor: "${result.nextCursor}" to retrieve the next page._` : ''}`,
        },
      ],
    };
  });
}

/**
 * Handles detailed actor information requests: a world actor by `actorId`,
 * or one token's actor by `sceneId` + `tokenId` (an unlinked token's own
 * HP and stats, base actor and delta merged).
 */
export async function handleGetActorDetails(args: ActorTargetArgs, foundryClient: FoundryClient) {
  if (args.actorId !== undefined && (typeof args.actorId !== 'string' || !args.actorId)) {
    throw new McpError(ErrorCode.InvalidParams, 'Actor ID is required and must be a string');
  }
  const target = resolveActorTarget(args, foundryClient);

  return withToolError('get actor details', async () => {
    const actor = isUnlinkedToken(target)
      ? foundryClient.getTokenActor(target.tokenId, target.sceneId)
      : await foundryClient.getActor(target.actorId);

    const abilities = actor.abilities
      ? Object.entries(actor.abilities)
          .map(
            ([key, ability]: [string, { value: number; mod: number }]) =>
              `**${key.toUpperCase()}:** ${ability.value} (${ability.mod >= 0 ? '+' : ''}${ability.mod})`,
          )
          .join('\n')
      : 'No ability scores available';

    return {
      content: [
        {
          type: 'text',
          text: `🎭 **Actor Details: ${actor.name}**
${tokenHeaderLine(target)}**Type:** ${actor.type}
**Level:** ${actor.level || 'Unknown'}
**Hit Points:** ${actor.hp?.value || 'Unknown'}/${actor.hp?.max || 'Unknown'}
**Armor Class:** ${actor.ac?.value || 'Unknown'}

**Ability Scores:**
${abilities}

**Description:** ${(actor as { description?: string }).description || 'No description available.'}`,
        },
      ],
    };
  });
}

/**
 * Handles listing an actor's owned items (equipment, spells, features).
 *
 * Reads full `system` data from the cached worldData, unlike
 * `get_actor_details`, which only reports the actor's own top-level stats.
 * For an unlinked token, the items are its base actor's and its delta's
 * merged (see `FoundryClient.getTokenActorItems`).
 */
export async function handleGetActorInventory(args: ActorTargetArgs, foundryClient: FoundryClient) {
  const target = resolveActorTarget(args, foundryClient);

  return withToolError('get actor inventory', async () => {
    const items = isUnlinkedToken(target)
      ? (foundryClient.getTokenActorItems(target.tokenId, target.sceneId) ?? [])
      : foundryClient.getActorItems(target.actorId);

    if (items.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: isUnlinkedToken(target)
              ? `${tokenHeaderLine(target)}Token ${target.tokenId}'s actor owns no items.`
              : `Actor ${target.actorId} owns no items.`,
          },
        ],
      };
    }

    const formatted = items
      .map((item) => {
        const qty = item.system.quantity;
        const qtySuffix = typeof qty === 'number' ? ` x${qty}` : '';
        return `- **${item.name}**${qtySuffix} (${item.type}) — ID: ${item._id}`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `🎒 **Actor Inventory** (${items.length} item${items.length !== 1 ? 's' : ''})\n${tokenHeaderLine(target)}\n${formatted}`,
        },
      ],
    };
  });
}
