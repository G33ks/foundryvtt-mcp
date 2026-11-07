/**
 * @fileoverview Actor item mutation tool handlers (create / update / delete)
 *
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active Socket.IO
 * connection (mutations use the core `modifyDocument` protocol). The canonical
 * mutation target is the D&D 5e v4+ activity schema; item `system` patches
 * honour JSON-merge-patch semantics on nested paths such as
 * `activities.{id}.consumption.targets`.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { ModuleBridge } from '../../foundry/module-bridge.js';
import type { ActorItemCreateSource } from '../../foundry/types.js';
import {
  type ActorTarget,
  type ActorTargetArgs,
  isUnlinkedToken,
  resolveActorTarget,
  tokenHeaderLine,
} from './actor-target.js';
import { withToolError } from './utils.js';

/** The token to pass to the client: only an unlinked one has an actor of its own. */
function tokenOf(target: ActorTarget) {
  return isUnlinkedToken(target) ? { sceneId: target.sceneId, tokenId: target.tokenId } : undefined;
}

/**
 * Handles creating an item on an actor from a compendium reference or an inline
 * item document. `actorId`, or `sceneId` + `tokenId`, names the actor (see
 * actor-target.ts); an unlinked token gets the item on its own actor only.
 */
export async function handleCreateActorItem(
  args: ActorTargetArgs & {
    source: ActorItemCreateSource;
  },
  foundryClient: FoundryClient,
  moduleBridge: ModuleBridge | null = null,
) {
  const { source } = args;
  const target = resolveActorTarget(args, foundryClient);

  if (!source || typeof source !== 'object') {
    throw new McpError(ErrorCode.InvalidParams, 'source is required and must be an object');
  }
  if (source.type === 'compendium') {
    if (typeof source.compendiumId !== 'string' || typeof source.itemId !== 'string') {
      throw new McpError(
        ErrorCode.InvalidParams,
        'compendium source requires compendiumId and itemId strings',
      );
    }
  } else if (source.type === 'inline') {
    if (!source.item || typeof source.item !== 'object') {
      throw new McpError(ErrorCode.InvalidParams, 'inline source requires an item object');
    }
  } else {
    throw new McpError(ErrorCode.InvalidParams, 'source.type must be "compendium" or "inline"');
  }

  return withToolError('create item', async () => {
    let effectiveSource: ActorItemCreateSource = source;
    if (source.type === 'compendium') {
      if (!moduleBridge) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          'Creating an item from a compendium source requires the companion Foundry module. Set FOUNDRY_MODULE_BRIDGE_ENABLED=true and install the module, or provide an inline item.',
        );
      }
      const rawDoc = (await moduleBridge.send('get_compendium_document', {
        packId: source.compendiumId,
        documentId: source.itemId,
      })) as Record<string, unknown>;

      const cleanDoc = { ...rawDoc };
      delete cleanDoc._id;
      delete cleanDoc._stats;
      effectiveSource = { type: 'inline', item: cleanDoc };
    }

    const newItem = await foundryClient.createActorItem(
      target.actorId,
      effectiveSource,
      tokenOf(target),
    );

    const origin =
      source.type === 'compendium'
        ? `compendium ${source.compendiumId} / ${source.itemId}`
        : 'inline definition';

    return {
      content: [
        {
          type: 'text',
          text: `⚔️ **Item Created**
${tokenHeaderLine(target)}**Actor:** ${target.actorId}
**Item:** ${newItem.name} (${newItem.type})
**Item ID:** ${newItem._id}
**Source:** ${origin}

_Canonical target: D&D 5e v4+ activity schema._`,
        },
      ],
    };
  });
}

/**
 * Handles applying a JSON merge patch to an item's `system` data. Supports
 * nested paths (e.g. `activities.{id}.consumption.targets`). An unlinked
 * token's item changes on that token only.
 */
export async function handleUpdateActorItem(
  args: ActorTargetArgs & {
    itemId: string;
    patch: Record<string, unknown>;
  },
  foundryClient: FoundryClient,
) {
  const { itemId, patch } = args;
  const target = resolveActorTarget(args, foundryClient);

  if (!itemId || typeof itemId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'itemId is required and must be a string');
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new McpError(ErrorCode.InvalidParams, 'patch is required and must be an object');
  }

  return withToolError('update item', async () => {
    const updatedItem = await foundryClient.updateActorItem(
      target.actorId,
      itemId,
      patch,
      tokenOf(target),
    );

    return {
      content: [
        {
          type: 'text',
          text: `⚔️ **Item Updated**
${tokenHeaderLine(target)}**Actor:** ${target.actorId}
**Item:** ${updatedItem.name} (${updatedItem.type})
**Item ID:** ${updatedItem._id}
**Patched keys:** ${Object.keys(patch).join(', ') || '(none)'}

_JSON merge patch applied to item.system. Canonical target: D&D 5e v4+ activity schema (e.g. activities.{id}.consumption.targets)._`,
        },
      ],
    };
  });
}

/**
 * Handles deleting an item owned by an actor. An unlinked token loses the
 * item on its own actor only.
 */
export async function handleDeleteActorItem(
  args: ActorTargetArgs & {
    itemId: string;
  },
  foundryClient: FoundryClient,
) {
  const { itemId } = args;
  const target = resolveActorTarget(args, foundryClient);

  if (!itemId || typeof itemId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'itemId is required and must be a string');
  }

  return withToolError('delete item', async () => {
    await foundryClient.deleteActorItem(target.actorId, itemId, tokenOf(target));

    return {
      content: [
        {
          type: 'text',
          text: `🗑️ **Item Deleted**
${tokenHeaderLine(target)}**Actor:** ${target.actorId}
**Item ID:** ${itemId}

_Canonical target: D&D 5e v4+ activity schema._`,
        },
      ],
    };
  });
}
