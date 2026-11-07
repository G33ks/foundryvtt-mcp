/**
 * @fileoverview Which actor an actor tool addresses: a world actor by `actorId`,
 * or one token's actor by `sceneId` + `tokenId`.
 *
 * An unlinked token has an actor of its own (its base actor plus the token's
 * delta); a linked token shares its world actor, so it addresses that actor.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';

export interface ActorTargetArgs {
  actorId?: string;
  sceneId?: string;
  tokenId?: string;
}

export type ActorTarget =
  | { kind: 'actor'; actorId: string }
  | {
      kind: 'token';
      actorId: string;
      sceneId: string;
      tokenId: string;
      linked: boolean;
      tokenName?: string;
    };

/**
 * Resolves `actorId`, or `sceneId` + `tokenId` (together; an `actorId` given
 * as well must be the token's actor).
 *
 * @param options.actorRequired - `actorId` is required even with a token
 * @throws McpError when the arguments don't name one actor, or the token isn't
 *   in the cache or carries another actor
 */
export function resolveActorTarget(
  args: ActorTargetArgs,
  foundryClient: FoundryClient,
  options: { actorRequired?: boolean } = {},
): ActorTarget {
  const { actorId, sceneId, tokenId } = args;
  if (actorId !== undefined && (typeof actorId !== 'string' || !actorId)) {
    throw new McpError(ErrorCode.InvalidParams, 'actorId must be a non-empty string');
  }
  const hasScene = sceneId !== undefined;
  const hasToken = tokenId !== undefined;
  if (hasScene !== hasToken) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'sceneId and tokenId must be supplied together (for one token on a scene) or not at all',
    );
  }
  if (actorId === undefined && (options.actorRequired || !hasToken)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      options.actorRequired
        ? 'actorId is required and must be a string'
        : 'actorId (or sceneId + tokenId) is required and must be a string',
    );
  }
  if (!hasToken && actorId !== undefined) {
    return { kind: 'actor', actorId };
  }
  if (typeof sceneId !== 'string' || !sceneId || typeof tokenId !== 'string' || !tokenId) {
    throw new McpError(ErrorCode.InvalidParams, 'sceneId and tokenId must be non-empty strings');
  }
  let resolved: ReturnType<FoundryClient['resolveTokenActor']>;
  try {
    resolved = foundryClient.resolveTokenActor(tokenId, sceneId, actorId);
  } catch (error) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      error instanceof Error ? error.message : String(error),
    );
  }
  const name = resolved.token.name;
  return {
    kind: 'token',
    actorId: resolved.actorId,
    sceneId,
    tokenId,
    linked: resolved.linked,
    ...(typeof name === 'string' && name ? { tokenName: name } : {}),
  };
}

/**
 * The embedded-document parent UUID for a target: `Actor.<id>` for a world
 * actor or a linked token, the token's synthetic actor otherwise (which the
 * client sends to the token's ActorDelta).
 */
export function actorParentUuid(target: ActorTarget): string {
  return target.kind === 'token' && !target.linked
    ? `Scene.${target.sceneId}.Token.${target.tokenId}.Actor.${target.actorId}`
    : `Actor.${target.actorId}`;
}

/** "token <name> (<id>) on scene <id>" or "actor <id>", for tool output. */
export function describeActorTarget(target: ActorTarget): string {
  if (target.kind === 'actor') {
    return `actor ${target.actorId}`;
  }
  const name = target.tokenName ? `${target.tokenName} (${target.tokenId})` : target.tokenId;
  return `token ${name} on scene ${target.sceneId}${target.linked ? ', linked' : ''}`;
}
