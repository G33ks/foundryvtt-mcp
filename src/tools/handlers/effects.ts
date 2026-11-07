/**
 * @fileoverview General-purpose ActiveEffect tool handlers (create/update/delete/list).
 *
 * `apply_status_effect` (token-mutations.ts) stays a separate, simpler
 * contract — toggle a condition by status id, idempotent — and is not
 * superseded by these; these exist for mechanical buffs/debuffs carrying
 * real `changes`/`duration`.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { ActorEffectInput } from '../../foundry/types.js';
import { type ActorTargetArgs, actorParentUuid, resolveActorTarget } from './actor-target.js';
import { withToolError } from './utils.js';

type ActorRef = ActorTargetArgs & { actorId: string };

/**
 * Resolves the `ActiveEffect` parent UUID from an actor reference.
 *
 * `actorId` is always required. `sceneId` and `tokenId` are an optional
 * pair — supplying only one of the two is rejected — naming the token whose
 * actor to change: its world actor when the token is linked, its own
 * (synthetic) actor when it is not. The token must be cached and carry
 * `actorId`.
 */
function resolveActorUuid(ref: ActorRef, foundryClient: FoundryClient): string {
  return actorParentUuid(resolveActorTarget(ref, foundryClient, { actorRequired: true }));
}

function formatEffect(effect: {
  _id: string;
  name: string;
  statuses?: string[];
  changes?: unknown[];
  duration?: unknown;
}): string {
  const parts = [`**ID:** ${effect._id}`, `**Name:** ${effect.name}`];
  if (effect.statuses && effect.statuses.length > 0) {
    parts.push(`**Statuses:** ${effect.statuses.join(', ')}`);
  }
  if (effect.changes && effect.changes.length > 0) {
    parts.push(`**Changes:** ${JSON.stringify(effect.changes)}`);
  }
  if (effect.duration && Object.keys(effect.duration as object).length > 0) {
    parts.push(`**Duration:** ${JSON.stringify(effect.duration)}`);
  }
  return parts.join('\n');
}

export async function handleCreateActorEffect(
  args: ActorRef & ActorEffectInput,
  foundryClient: FoundryClient,
) {
  const parentActorUuid = resolveActorUuid(args, foundryClient);
  if (!args.name || typeof args.name !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'name is required and must be a string');
  }

  return withToolError('create actor effect', async () => {
    const effect = await foundryClient.createActorEffect(parentActorUuid, args);
    return {
      content: [{ type: 'text' as const, text: `✨ **Effect Created**\n${formatEffect(effect)}` }],
    };
  });
}

export async function handleUpdateActorEffect(
  args: ActorRef & { effectId: string } & ActorEffectInput,
  foundryClient: FoundryClient,
) {
  const parentActorUuid = resolveActorUuid(args, foundryClient);
  if (!args.effectId || typeof args.effectId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'effectId is required and must be a string');
  }

  return withToolError('update actor effect', async () => {
    const effect = await foundryClient.updateActorEffect(parentActorUuid, args.effectId, args);
    return {
      content: [{ type: 'text' as const, text: `✨ **Effect Updated**\n${formatEffect(effect)}` }],
    };
  });
}

export async function handleDeleteActorEffect(
  args: ActorRef & { effectId: string },
  foundryClient: FoundryClient,
) {
  const parentActorUuid = resolveActorUuid(args, foundryClient);
  if (!args.effectId || typeof args.effectId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'effectId is required and must be a string');
  }

  return withToolError('delete actor effect', async () => {
    await foundryClient.deleteActorEffect(parentActorUuid, args.effectId);
    return {
      content: [{ type: 'text' as const, text: `🗑️ **Effect Deleted**\n**ID:** ${args.effectId}` }],
    };
  });
}

export async function handleListActorEffects(
  args: { actorId: string },
  foundryClient: FoundryClient,
) {
  if (!args.actorId || typeof args.actorId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'actorId is required and must be a string');
  }

  return withToolError('list actor effects', async () => {
    const effects = foundryClient.listActorEffects(args.actorId);
    if (effects.length === 0) {
      return {
        content: [{ type: 'text' as const, text: '✨ **No active effects on this actor.**' }],
      };
    }
    const lines = effects.map((effect) => `- ${formatEffect(effect)}`.replace(/\n/g, ' | '));
    return {
      content: [
        {
          type: 'text' as const,
          text: `✨ **Active Effects** (${effects.length})\n${lines.join('\n')}`,
        },
      ],
    };
  });
}
