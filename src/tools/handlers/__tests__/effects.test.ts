/**
 * @fileoverview Tests for the general-purpose ActiveEffect tool handlers.
 */

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import {
  handleCreateActorEffect,
  handleDeleteActorEffect,
  handleUpdateActorEffect,
} from '../effects.js';

const ACTOR_ID = 'actorAAAAAAAAAAA';
const SCENE_ID = 'sceneAAAAAAAAAAA';
const TOKEN_ID = 'tokenAAAAAAAAAAA';
const EFFECT_ID = 'effectAAAAAAAAAA';
const LINKED_TOKEN_ID = 'tokenLinkedAAAAA';

/** The cache holds TOKEN_ID (unlinked) and LINKED_TOKEN_ID (linked), both carrying ACTOR_ID. */
function resolveTokenActor(tokenId: string, sceneId?: string, actorId?: string) {
  if (sceneId !== SCENE_ID || (tokenId !== TOKEN_ID && tokenId !== LINKED_TOKEN_ID)) {
    throw new Error(`Token not found: ${tokenId} in scene ${sceneId}`);
  }
  if (actorId !== undefined && actorId !== ACTOR_ID) {
    throw new Error(`Token ${tokenId} carries actor ${ACTOR_ID}, not ${actorId}`);
  }
  return {
    scene: { _id: SCENE_ID },
    token: { _id: tokenId, name: 'Goblin' },
    actorId: ACTOR_ID,
    linked: tokenId === LINKED_TOKEN_ID,
  };
}

function buildClient(overrides: Partial<FoundryClient> = {}): FoundryClient {
  return {
    resolveTokenActor: vi.fn(resolveTokenActor),
    createActorEffect: vi.fn(async () => ({ _id: EFFECT_ID, name: 'Blessed' })),
    updateActorEffect: vi.fn(async () => ({ _id: EFFECT_ID, name: 'Blessed' })),
    deleteActorEffect: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as FoundryClient;
}

describe('handleCreateActorEffect — actor UUID resolution', () => {
  it('resolves a plain Actor.<id> UUID when only actorId is given', async () => {
    const client = buildClient();
    await handleCreateActorEffect({ actorId: ACTOR_ID, name: 'Blessed' }, client);
    expect(client.createActorEffect).toHaveBeenCalledWith(
      `Actor.${ACTOR_ID}`,
      expect.objectContaining({ actorId: ACTOR_ID, name: 'Blessed' }),
    );
  });

  it('resolves the unlinked-token-actor UUID when sceneId+tokenId are given together', async () => {
    const client = buildClient();
    await handleCreateActorEffect(
      { actorId: ACTOR_ID, sceneId: SCENE_ID, tokenId: TOKEN_ID, name: 'Blessed' },
      client,
    );
    expect(client.createActorEffect).toHaveBeenCalledWith(
      `Scene.${SCENE_ID}.Token.${TOKEN_ID}.Actor.${ACTOR_ID}`,
      expect.anything(),
    );
  });

  it("resolves a linked token to its world actor's Actor.<id> UUID", async () => {
    const client = buildClient();
    await handleCreateActorEffect(
      { actorId: ACTOR_ID, sceneId: SCENE_ID, tokenId: LINKED_TOKEN_ID, name: 'Blessed' },
      client,
    );
    expect(client.createActorEffect).toHaveBeenCalledWith(`Actor.${ACTOR_ID}`, expect.anything());
  });

  it('refuses a token that carries another actor', async () => {
    const client = buildClient();
    await expect(
      handleCreateActorEffect(
        { actorId: 'otherActor000001', sceneId: SCENE_ID, tokenId: TOKEN_ID, name: 'Blessed' },
        client,
      ),
    ).rejects.toThrow(`Token ${TOKEN_ID} carries actor ${ACTOR_ID}, not otherActor000001`);
    expect(client.createActorEffect).not.toHaveBeenCalled();
  });

  it('refuses a token that is not in the cache', async () => {
    const client = buildClient();
    await expect(
      handleCreateActorEffect(
        { actorId: ACTOR_ID, sceneId: SCENE_ID, tokenId: 'missingToken0001', name: 'Blessed' },
        client,
      ),
    ).rejects.toThrow(McpError);
    expect(client.createActorEffect).not.toHaveBeenCalled();
  });

  it('rejects sceneId without tokenId', async () => {
    const client = buildClient();
    await expect(
      handleCreateActorEffect({ actorId: ACTOR_ID, sceneId: SCENE_ID, name: 'Blessed' }, client),
    ).rejects.toThrow(McpError);
    expect(client.createActorEffect).not.toHaveBeenCalled();
  });

  it('rejects tokenId without sceneId', async () => {
    const client = buildClient();
    await expect(
      handleCreateActorEffect({ actorId: ACTOR_ID, tokenId: TOKEN_ID, name: 'Blessed' }, client),
    ).rejects.toThrow(McpError);
    expect(client.createActorEffect).not.toHaveBeenCalled();
  });

  it('rejects a missing name', async () => {
    const client = buildClient();
    await expect(handleCreateActorEffect({ actorId: ACTOR_ID } as never, client)).rejects.toThrow(
      McpError,
    );
  });

  it('rejects a missing actorId', async () => {
    const client = buildClient();
    await expect(handleCreateActorEffect({ name: 'Blessed' } as never, client)).rejects.toThrow(
      McpError,
    );
  });
});

describe('handleUpdateActorEffect — actor UUID resolution', () => {
  it('resolves the unlinked-token-actor UUID for update', async () => {
    const client = buildClient();
    await handleUpdateActorEffect(
      { actorId: ACTOR_ID, sceneId: SCENE_ID, tokenId: TOKEN_ID, effectId: EFFECT_ID },
      client,
    );
    expect(client.updateActorEffect).toHaveBeenCalledWith(
      `Scene.${SCENE_ID}.Token.${TOKEN_ID}.Actor.${ACTOR_ID}`,
      EFFECT_ID,
      expect.anything(),
    );
  });

  it('rejects a missing effectId', async () => {
    const client = buildClient();
    await expect(handleUpdateActorEffect({ actorId: ACTOR_ID } as never, client)).rejects.toThrow(
      McpError,
    );
  });
});

describe('handleDeleteActorEffect — actor UUID resolution', () => {
  it('resolves a plain Actor.<id> UUID for delete', async () => {
    const client = buildClient();
    await handleDeleteActorEffect({ actorId: ACTOR_ID, effectId: EFFECT_ID }, client);
    expect(client.deleteActorEffect).toHaveBeenCalledWith(`Actor.${ACTOR_ID}`, EFFECT_ID);
  });

  it('resolves the unlinked-token-actor UUID for delete', async () => {
    const client = buildClient();
    await handleDeleteActorEffect(
      { actorId: ACTOR_ID, sceneId: SCENE_ID, tokenId: TOKEN_ID, effectId: EFFECT_ID },
      client,
    );
    expect(client.deleteActorEffect).toHaveBeenCalledWith(
      `Scene.${SCENE_ID}.Token.${TOKEN_ID}.Actor.${ACTOR_ID}`,
      EFFECT_ID,
    );
  });
});
