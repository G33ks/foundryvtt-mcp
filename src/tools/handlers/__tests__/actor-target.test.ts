/**
 * @fileoverview Tests for the actor addressing rule shared by the actor tools:
 * `actorId`, or `sceneId` + `tokenId`, and the reads that take it.
 */

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { actorParentUuid, resolveActorTarget, tokenHeaderLine } from '../actor-target.js';
import { handleGetActorDetails, handleGetActorInventory } from '../actors.js';
import { handleListActorEffects } from '../effects.js';

const ACTOR_ID = 'actorAAAAAAAAAAA';
const SCENE_ID = 'sceneAAAAAAAAAAA';
const TOKEN_ID = 'tokenAAAAAAAAAAA';
const LINKED_TOKEN_ID = 'tokenLinkedAAAAA';

/** TOKEN_ID is unlinked, LINKED_TOKEN_ID linked; both carry ACTOR_ID. */
function resolveTokenActor(tokenId: string, sceneId?: string, actorId?: string) {
  if (sceneId !== SCENE_ID || (tokenId !== TOKEN_ID && tokenId !== LINKED_TOKEN_ID)) {
    throw new Error(`Token not found: ${tokenId} in scene ${sceneId}`);
  }
  if (actorId !== undefined && actorId !== ACTOR_ID) {
    throw new Error(`Token ${tokenId} carries actor ${ACTOR_ID}, not ${actorId}`);
  }
  return {
    scene: { _id: SCENE_ID },
    token: { _id: tokenId, name: 'Scout' },
    actorId: ACTOR_ID,
    linked: tokenId === LINKED_TOKEN_ID,
  };
}

function buildClient(overrides: Record<string, unknown> = {}): FoundryClient {
  return {
    resolveTokenActor: vi.fn(resolveTokenActor),
    getActor: vi.fn(async () => ({
      _id: ACTOR_ID,
      name: 'Scout',
      type: 'npc',
      hp: { value: 20, max: 20 },
    })),
    getTokenActor: vi.fn(() => ({
      _id: ACTOR_ID,
      name: 'Scout',
      type: 'npc',
      hp: { value: 7, max: 20 },
    })),
    getActorItems: vi.fn(() => [
      { _id: 'baseItem00000001', name: 'Rope', type: 'loot', system: { quantity: 1 } },
    ]),
    getTokenActorItems: vi.fn(() => [
      { _id: 'ownItem000000001', name: 'Key', type: 'loot', system: { quantity: 1 } },
    ]),
    listActorEffects: vi.fn(() => [{ _id: 'baseEffect000001', name: 'Blessed' }]),
    getTokenActorEffects: vi.fn(() => [{ _id: 'ownEffect0000001', name: 'Hasted' }]),
    ...overrides,
  } as unknown as FoundryClient;
}

const text = (result: { content: Array<{ text: string }> }) => result.content[0]?.text ?? '';

describe('resolveActorTarget', () => {
  it('takes actorId alone as a world actor', () => {
    expect(resolveActorTarget({ actorId: ACTOR_ID }, buildClient())).toEqual({
      kind: 'actor',
      actorId: ACTOR_ID,
    });
  });

  it("takes sceneId + tokenId as that token's actor", () => {
    expect(resolveActorTarget({ sceneId: SCENE_ID, tokenId: TOKEN_ID }, buildClient())).toEqual({
      kind: 'token',
      actorId: ACTOR_ID,
      sceneId: SCENE_ID,
      tokenId: TOKEN_ID,
      linked: false,
      tokenName: 'Scout',
    });
  });

  it("accepts an actorId given with the token when it is the token's actor", () => {
    expect(
      resolveActorTarget(
        { actorId: ACTOR_ID, sceneId: SCENE_ID, tokenId: TOKEN_ID },
        buildClient(),
      ),
    ).toMatchObject({ kind: 'token', actorId: ACTOR_ID });
  });

  it('refuses an actorId that is not the token actor', () => {
    expect(() =>
      resolveActorTarget(
        { actorId: 'otherActor000001', sceneId: SCENE_ID, tokenId: TOKEN_ID },
        buildClient(),
      ),
    ).toThrow(`Token ${TOKEN_ID} carries actor ${ACTOR_ID}, not otherActor000001`);
  });

  it('refuses a token that is not in the cache', () => {
    expect(() =>
      resolveActorTarget({ sceneId: SCENE_ID, tokenId: 'missingToken0001' }, buildClient()),
    ).toThrow(McpError);
  });

  it('refuses half a token pair, and no target at all', () => {
    const client = buildClient();
    expect(() => resolveActorTarget({ tokenId: TOKEN_ID }, client)).toThrow(/together/);
    expect(() => resolveActorTarget({ sceneId: SCENE_ID, actorId: ACTOR_ID }, client)).toThrow(
      /together/,
    );
    expect(() => resolveActorTarget({}, client)).toThrow(/actorId \(or sceneId \+ tokenId\)/);
  });

  it('requires actorId even with a token when asked to', () => {
    expect(() =>
      resolveActorTarget({ sceneId: SCENE_ID, tokenId: TOKEN_ID }, buildClient(), {
        actorRequired: true,
      }),
    ).toThrow('actorId is required and must be a string');
  });
});

describe('actorParentUuid and tokenHeaderLine', () => {
  const unlinked = resolveActorTarget({ sceneId: SCENE_ID, tokenId: TOKEN_ID }, buildClient());
  const linked = resolveActorTarget({ sceneId: SCENE_ID, tokenId: LINKED_TOKEN_ID }, buildClient());

  it("parents an unlinked token's documents to its synthetic actor, the rest to Actor.<id>", () => {
    expect(actorParentUuid(unlinked)).toBe(`Scene.${SCENE_ID}.Token.${TOKEN_ID}.Actor.${ACTOR_ID}`);
    expect(actorParentUuid(linked)).toBe(`Actor.${ACTOR_ID}`);
    expect(actorParentUuid({ kind: 'actor', actorId: ACTOR_ID })).toBe(`Actor.${ACTOR_ID}`);
  });

  it('names the token only for an unlinked one', () => {
    expect(tokenHeaderLine(unlinked)).toBe(
      `**Token:** Scout (${TOKEN_ID}) on scene ${SCENE_ID} - unlinked: its own copy of actor ${ACTOR_ID}\n`,
    );
    expect(tokenHeaderLine(linked)).toBe('');
  });
});

describe('reads by token', () => {
  it("get_actor_details reads an unlinked token's own actor and says which token", async () => {
    const client = buildClient();
    const result = text(
      await handleGetActorDetails({ sceneId: SCENE_ID, tokenId: TOKEN_ID }, client),
    );
    expect(client.getTokenActor).toHaveBeenCalledWith(TOKEN_ID, SCENE_ID);
    expect(client.getActor).not.toHaveBeenCalled();
    expect(result).toContain(`**Token:** Scout (${TOKEN_ID})`);
    expect(result).toContain('**Hit Points:** 7/20');
  });

  it('get_actor_details reads the world actor for a linked token, as it always has', async () => {
    const client = buildClient();
    const result = text(
      await handleGetActorDetails({ sceneId: SCENE_ID, tokenId: LINKED_TOKEN_ID }, client),
    );
    expect(client.getActor).toHaveBeenCalledWith(ACTOR_ID);
    expect(result).not.toContain('**Token:**');
    expect(result).toBe(text(await handleGetActorDetails({ actorId: ACTOR_ID }, client)));
  });

  it("get_actor_inventory lists an unlinked token's merged items", async () => {
    const client = buildClient();
    const result = text(
      await handleGetActorInventory({ sceneId: SCENE_ID, tokenId: TOKEN_ID }, client),
    );
    expect(client.getTokenActorItems).toHaveBeenCalledWith(TOKEN_ID, SCENE_ID);
    expect(result).toContain('**Token:** Scout');
    expect(result).toContain('**Key** x1 (loot) — ID: ownItem000000001');
    expect(result).not.toContain('Rope');
  });

  it('get_actor_inventory says when an unlinked token owns nothing', async () => {
    const client = buildClient({ getTokenActorItems: vi.fn(() => []) });
    const result = text(
      await handleGetActorInventory({ sceneId: SCENE_ID, tokenId: TOKEN_ID }, client),
    );
    expect(result).toContain(`Token ${TOKEN_ID}'s actor owns no items.`);
  });

  it("list_actor_effects lists an unlinked token's merged effects", async () => {
    const client = buildClient();
    const result = text(
      await handleListActorEffects({ sceneId: SCENE_ID, tokenId: TOKEN_ID }, client),
    );
    expect(client.getTokenActorEffects).toHaveBeenCalledWith(TOKEN_ID, SCENE_ID);
    expect(result).toContain('**Token:** Scout');
    expect(result).toContain('ownEffect0000001');
    expect(client.listActorEffects).not.toHaveBeenCalled();
  });

  it("list_actor_effects reads a linked token's world actor", async () => {
    const client = buildClient();
    await handleListActorEffects({ sceneId: SCENE_ID, tokenId: LINKED_TOKEN_ID }, client);
    expect(client.listActorEffects).toHaveBeenCalledWith(ACTOR_ID);
  });

  it('the reads refuse a token carrying another actor', async () => {
    const client = buildClient();
    const args = { actorId: 'otherActor000001', sceneId: SCENE_ID, tokenId: TOKEN_ID };
    await expect(handleGetActorDetails(args, client)).rejects.toThrow(McpError);
    await expect(handleGetActorInventory(args, client)).rejects.toThrow(McpError);
    await expect(handleListActorEffects(args, client)).rejects.toThrow(McpError);
  });
});
