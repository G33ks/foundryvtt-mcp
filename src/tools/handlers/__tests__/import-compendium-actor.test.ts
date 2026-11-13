/**
 * @fileoverview Tests for the import_compendium_actor tool handler.
 */

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import type { ModuleBridge } from '../../../foundry/module-bridge.js';
import { handleImportCompendiumActor } from '../module-bridge.js';

const ACTOR_ID = 'actorAAAAAAAAAAA';

function buildBridge(sendImpl: (type: string, params: Record<string, unknown>) => unknown) {
  return {
    send: vi.fn(sendImpl),
  } as unknown as ModuleBridge;
}

describe('handleImportCompendiumActor', () => {
  it('rejects a compendium document with no usable name', async () => {
    const bridge = buildBridge(() => ({ type: 'npc' }));
    const client = {
      isWriteEnabled: () => true,
      createActorFromData: vi.fn(),
    } as unknown as FoundryClient;

    await expect(
      handleImportCompendiumActor(
        { compendiumId: 'cpr.npcs', actorId: 'docAAAAAAAAAAAAA' },
        client,
        bridge,
      ),
    ).rejects.toThrow(McpError);
    expect(client.createActorFromData).not.toHaveBeenCalled();
  });

  it('rejects a compendium document with no usable type', async () => {
    const bridge = buildBridge(() => ({ name: 'Ganger' }));
    const client = {
      isWriteEnabled: () => true,
      createActorFromData: vi.fn(),
    } as unknown as FoundryClient;

    await expect(
      handleImportCompendiumActor(
        { compendiumId: 'cpr.npcs', actorId: 'docAAAAAAAAAAAAA' },
        client,
        bridge,
      ),
    ).rejects.toThrow(McpError);
    expect(client.createActorFromData).not.toHaveBeenCalled();
  });

  it('imports directly (no fallback) when the create succeeds with embedded items', async () => {
    const bridge = buildBridge(() => ({
      name: 'Ganger',
      type: 'npc',
      items: [{ name: 'Pistol', type: 'weapon' }],
    }));
    const createActorFromData = vi.fn(async () => ({ _id: ACTOR_ID, name: 'Ganger' }));
    const createActorItem = vi.fn();
    const client = {
      isWriteEnabled: () => true,
      createActorFromData,
      createActorItem,
    } as unknown as FoundryClient;

    const result = await handleImportCompendiumActor(
      { compendiumId: 'cpr.npcs', actorId: 'docAAAAAAAAAAAAA' },
      client,
      bridge,
    );

    expect(createActorFromData).toHaveBeenCalledTimes(1);
    expect(createActorItem).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('Items:** 1/1');
    expect(result.content[0].text).not.toContain('seeded individually');
  });

  it('falls back to per-item seeding when the system rejects embedded items, reporting per-item failures', async () => {
    const bridge = buildBridge(() => ({
      name: 'Ganger',
      type: 'npc',
      items: [
        { _id: 'itemAAAAAAAAAAAA', name: 'Pistol', type: 'weapon' },
        { name: 'Bad Item', type: 'bogus' },
      ],
    }));

    const createActorFromData = vi
      .fn()
      .mockRejectedValueOnce(new Error('system rejects embedded items'))
      .mockResolvedValueOnce({ _id: ACTOR_ID, name: 'Ganger' });
    const createActorItem = vi
      .fn()
      .mockResolvedValueOnce({ _id: 'newItemAAAAAAAA', name: 'Pistol', type: 'weapon' })
      .mockRejectedValueOnce(new Error('Invalid item type: bogus'));

    const client = {
      isWriteEnabled: () => true,
      createActorFromData,
      createActorItem,
    } as unknown as FoundryClient;

    const result = await handleImportCompendiumActor(
      { compendiumId: 'cpr.npcs', actorId: 'docAAAAAAAAAAAAA' },
      client,
      bridge,
    );

    expect(createActorFromData).toHaveBeenCalledTimes(2);
    // Second call must drop embedded items/effects.
    expect(createActorFromData).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ includeEmbedded: false }),
    );
    expect(createActorItem).toHaveBeenCalledTimes(2);
    // Cleaned item must not carry the compendium's own _id through.
    expect(createActorItem).toHaveBeenNthCalledWith(1, ACTOR_ID, {
      type: 'inline',
      item: { name: 'Pistol', type: 'weapon' },
    });

    const text = result.content[0].text;
    expect(text).toContain('seeded individually');
    expect(text).toContain('Items:** 1/2');
    expect(text).toContain('**Item errors:**');
    expect(text).toContain('Bad Item: Invalid item type: bogus');
  });

  it('surfaces the original error when create fails with no embedded items to blame', async () => {
    const bridge = buildBridge(() => ({ name: 'Ganger', type: 'npc' }));
    const createActorFromData = vi.fn().mockRejectedValue(new Error('system totally broken'));
    const client = { isWriteEnabled: () => true, createActorFromData } as unknown as FoundryClient;

    await expect(
      handleImportCompendiumActor(
        { compendiumId: 'cpr.npcs', actorId: 'docAAAAAAAAAAAAA' },
        client,
        bridge,
      ),
    ).rejects.toThrow(/system totally broken/);
    expect(createActorFromData).toHaveBeenCalledTimes(1);
  });

  it('rejects when the module bridge is not configured', async () => {
    const client = {
      isWriteEnabled: () => true,
      createActorFromData: vi.fn(),
    } as unknown as FoundryClient;
    await expect(
      handleImportCompendiumActor(
        { compendiumId: 'cpr.npcs', actorId: 'docAAAAAAAAAAAAA' },
        client,
        null,
      ),
    ).rejects.toThrow(/FOUNDRY_MODULE_BRIDGE_ENABLED/);
  });
});
