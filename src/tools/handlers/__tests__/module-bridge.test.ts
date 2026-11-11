import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { ModuleBridge } from '../../../foundry/module-bridge.js';
import { refusalError } from '../../../utils/refusal.js';
import {
  handleGetActorStats,
  handleGetDocumentSchema,
  handleRollAndPost,
  handleSearchCompendiumContent,
} from '../module-bridge.js';

describe('handleGetDocumentSchema', () => {
  function buildBridge(sendImpl: (type: string, params: Record<string, unknown>) => unknown) {
    return {
      send: vi.fn(sendImpl),
    } as unknown as ModuleBridge;
  }

  it('formats a schema result as a labeled JSON code block', async () => {
    const bridge = buildBridge(() => ({
      documentType: 'Actor',
      type: 'character',
      fields: { stats: { type: 'Schema', fields: {} } },
    }));

    const result = await handleGetDocumentSchema(
      { documentType: 'Actor', type: 'character' },
      bridge,
    );

    const text = result.content[0].text;
    expect(text).toContain('Actor Schema: character');
    expect(text).toContain('```json');
    expect(text).toContain('"stats"');
    expect(bridge.send).toHaveBeenCalledWith('get_document_schema', {
      documentType: 'Actor',
      type: 'character',
    });
  });

  it('says when a schema comes from template.json defaults', async () => {
    const bridge = buildBridge(() => ({
      documentType: 'Actor',
      type: 'legacy',
      source: 'template',
      fields: { level: { type: 'Number', inferred: true, initial: 1 } },
    }));

    const result = await handleGetDocumentSchema({ documentType: 'Actor', type: 'legacy' }, bridge);

    const text = result.content[0].text;
    expect(text).toContain('Declared by template.json');
    expect(text).toContain('"inferred": true');
  });

  it('names the schema source: DataModel, or template.json with inferred types', async () => {
    const answer = (source?: string) =>
      buildBridge(() => ({ documentType: 'Actor', type: 'hero', source, fields: {} }));
    const header = async (source?: string) =>
      (await handleGetDocumentSchema({ documentType: 'Actor', type: 'hero' }, answer(source)))
        .content[0].text;

    expect(await header('datamodel')).toContain(
      '🧬 **Actor Schema: hero**\nSchema source: DataModel\n```json',
    );
    // A module before 0.6.0 sends no source: it only reads DataModels.
    expect(await header(undefined)).toContain('\nSchema source: DataModel\n');
    expect(await header('template')).toContain(
      '🧬 **Actor Schema: hero**\nSchema source: template.json (types inferred)\n_Declared by template.json',
    );
  });

  it('leaves out a min or max that is not a finite number, at any depth', async () => {
    const bridge = buildBridge(() => ({
      documentType: 'Actor',
      type: 'hero',
      source: 'datamodel',
      fields: {
        level: { type: 'Number', min: 1, max: null, integer: true },
        pool: {
          type: 'Schema',
          fields: {
            value: { type: 'Number', min: null, max: 10 },
            min: { type: 'Number', min: 0, max: 'Infinity' },
          },
        },
        marks: { type: 'Array', element: { type: 'Number', min: -1, max: {} } },
      },
    }));

    const text = (await handleGetDocumentSchema({ documentType: 'Actor', type: 'hero' }, bridge))
      .content[0].text;
    const json = JSON.parse(text.slice(text.indexOf('```json\n') + 8, text.lastIndexOf('\n```')));

    expect(json).toEqual({
      level: { type: 'Number', min: 1, integer: true },
      pool: {
        type: 'Schema',
        fields: {
          value: { type: 'Number', max: 10 },
          // A sub-field named "min" is a field, not a bound.
          min: { type: 'Number', min: 0 },
        },
      },
      marks: { type: 'Array', element: { type: 'Number', min: -1 } },
    });
  });

  it('rejects a documentType other than Actor or Item', async () => {
    const bridge = buildBridge(() => ({}));
    await expect(
      handleGetDocumentSchema({ documentType: 'Scene' as unknown as 'Actor', type: 'x' }, bridge),
    ).rejects.toThrow(McpError);
    expect(bridge.send).not.toHaveBeenCalled();
  });

  it('rejects a missing type', async () => {
    const bridge = buildBridge(() => ({}));
    await expect(
      handleGetDocumentSchema({ documentType: 'Item', type: '' }, bridge),
    ).rejects.toThrow(McpError);
    expect(bridge.send).not.toHaveBeenCalled();
  });

  it('rejects when the module bridge is not configured', async () => {
    await expect(
      handleGetDocumentSchema({ documentType: 'Actor', type: 'character' }, null),
    ).rejects.toThrow(/FOUNDRY_MODULE_BRIDGE_ENABLED/);
  });

  it('propagates a not-connected error from the bridge', async () => {
    const bridge = buildBridge(() => {
      throw new Error('No Foundry module connected to the bridge.');
    });
    await expect(
      handleGetDocumentSchema({ documentType: 'Actor', type: 'character' }, bridge),
    ).rejects.toThrow(/No Foundry module connected/);
  });

  it('propagates an unknown-type error surfaced by the module', async () => {
    const bridge = buildBridge(() => {
      throw new Error('Unknown Actor type: "bogus". Valid types for this world: character, npc');
    });
    await expect(
      handleGetDocumentSchema({ documentType: 'Actor', type: 'bogus' }, bridge),
    ).rejects.toThrow(/Unknown Actor type/);
  });

  it('rejects a malformed result shape from the module', async () => {
    const bridge = buildBridge(() => ({ nonsense: true }));
    await expect(
      handleGetDocumentSchema({ documentType: 'Actor', type: 'character' }, bridge),
    ).rejects.toThrow(/unexpected get_document_schema shape/);
  });
});

describe('handleSearchCompendiumContent', () => {
  function buildBridge(sendImpl: (type: string, params: Record<string, unknown>) => unknown) {
    return {
      send: vi.fn(sendImpl),
    } as unknown as ModuleBridge;
  }

  it('formats compendium search results with snippets', async () => {
    const bridge = buildBridge(() => ({
      results: [
        {
          packId: 'cpr.weapons',
          packLabel: 'Weapons',
          documentId: 'doc1234567890123',
          documentName: 'Heavy Pistol',
          documentType: 'Item',
          matchedIn: 'content',
          snippet: 'A standard heavy pistol dealing 3d6 damage.',
        },
      ],
      total: 1,
    }));

    const result = await handleSearchCompendiumContent({ query: 'heavy pistol' }, bridge);
    expect(result.content[0].text).toContain('**Compendium Content Matches** (1)');
    expect(result.content[0].text).toContain('Heavy Pistol');
    expect(result.content[0].text).toContain('[content match]');
    expect(result.content[0].text).toContain('3d6 damage');
  });

  it('reports empty result nicely', async () => {
    const bridge = buildBridge(() => ({ results: [], total: 0 }));
    const result = await handleSearchCompendiumContent({ query: 'nonexistent' }, bridge);
    expect(result.content[0].text).toContain('No compendium matches found for "nonexistent"');
  });

  it('rejects when bridge is null', async () => {
    await expect(handleSearchCompendiumContent({ query: 'x' }, null)).rejects.toThrow(McpError);
  });
});

describe('handleRollAndPost', () => {
  function buildBridge(sendImpl: (type: string, params: Record<string, unknown>) => unknown) {
    return {
      send: vi.fn(sendImpl),
    } as unknown as ModuleBridge;
  }

  it('evaluates and posts roll via bridge', async () => {
    const bridge = buildBridge(() => ({
      formula: '4d6kh3',
      total: 15,
      result: '5 + 5 + 5 (dropped 2)',
    }));

    const result = await handleRollAndPost({ formula: '4d6kh3', flavor: 'Stat Roll' }, bridge);
    expect(result.content[0].text).toContain('Dice Rolled & Posted to Chat');
    expect(result.content[0].text).toContain('4d6kh3');
    expect(result.content[0].text).toContain('15');
    expect(result.content[0].text).toContain('Stat Roll');
    expect(bridge.send).toHaveBeenCalledWith('roll_and_post', {
      formula: '4d6kh3',
      flavor: 'Stat Roll',
    });
  });

  it('rejects missing formula', async () => {
    const bridge = buildBridge(() => ({}));
    await expect(handleRollAndPost({ formula: '' }, bridge)).rejects.toThrow(McpError);
  });
});

describe('handleGetActorStats', () => {
  const ACTOR = 'actorAAAAAAAAAAA';
  const SCENE = 'sceneSSSSSSSSSSS';
  const TOKEN = 'tokenTTTTTTTTTTT';

  /** TOKEN is an unlinked token on SCENE carrying ACTOR. */
  function buildClient(): FoundryClient {
    const resolveTokenActor = vi.fn((tokenId: string, sceneId?: string, actorId?: string) => {
      if (tokenId !== TOKEN || sceneId !== SCENE) {
        throw new Error(`Token not found: ${tokenId} in scene ${sceneId}`);
      }
      if (actorId !== undefined && actorId !== ACTOR) {
        throw new Error(`Token ${tokenId} carries actor ${ACTOR}, not ${actorId}`);
      }
      return { token: { _id: TOKEN, name: 'Scout' }, actorId: ACTOR, linked: false };
    });
    return { resolveTokenActor } as unknown as FoundryClient;
  }

  function buildBridge(answer: unknown) {
    return { send: vi.fn(async () => answer) } as unknown as ModuleBridge;
  }

  const system = { pool: { max: 10, spent: 2, value: 8 }, level: 3 };

  it('relays a world actor and returns its prepared system as compact JSON', async () => {
    const bridge = buildBridge({
      results: [{ actorId: ACTOR, name: 'Wanderer', type: 'traveler', system }],
      truncated: false,
      bytes: 120,
    });
    const result = await handleGetActorStats({ actorId: ACTOR }, buildClient(), bridge);

    expect(bridge.send).toHaveBeenCalledWith('get_actor_stats', {
      targets: [{ actorId: ACTOR }],
      maxBytes: 32768,
    });
    const text = result.content[0].text;
    expect(text).not.toContain('\n');
    expect(JSON.parse(text)).toEqual({
      actorId: ACTOR,
      name: 'Wanderer',
      type: 'traveler',
      system,
      truncated: false,
    });
  });

  it('relays one token, with its actor, paths and maxBytes', async () => {
    const bridge = buildBridge({
      results: [
        {
          sceneId: SCENE,
          tokenId: TOKEN,
          actorId: ACTOR,
          linked: false,
          values: { 'pool.value': 3 },
          missing: ['nothing'],
        },
      ],
      truncated: false,
    });
    const result = await handleGetActorStats(
      { sceneId: SCENE, tokenId: TOKEN, paths: ['pool.value', 'nothing'], maxBytes: 4096 },
      buildClient(),
      bridge,
    );

    expect(bridge.send).toHaveBeenCalledWith('get_actor_stats', {
      targets: [{ sceneId: SCENE, tokenId: TOKEN, actorId: ACTOR }],
      paths: ['pool.value', 'nothing'],
      maxBytes: 4096,
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      values: { 'pool.value': 3 },
      missing: ['nothing'],
    });
  });

  it('checks the target against the cache before sending anything', async () => {
    const bridge = buildBridge({ results: [] });
    await expect(
      handleGetActorStats({ sceneId: SCENE, tokenId: 'otherTTTTTTTTTTT' }, buildClient(), bridge),
    ).rejects.toThrow(/Token not found/);
    await expect(
      handleGetActorStats(
        { sceneId: SCENE, tokenId: TOKEN, actorId: 'otherAAAAAAAAAAA' },
        buildClient(),
        bridge,
      ),
    ).rejects.toThrow(/carries actor/);
    await expect(handleGetActorStats({ sceneId: SCENE }, buildClient(), bridge)).rejects.toThrow(
      /together/,
    );
    await expect(handleGetActorStats({}, buildClient(), bridge)).rejects.toThrow(McpError);
    expect(bridge.send).not.toHaveBeenCalled();
  });

  it('refuses bad paths and maxBytes before sending anything', async () => {
    const bridge = buildBridge({ results: [] });
    for (const args of [
      { actorId: ACTOR, paths: [] },
      { actorId: ACTOR, paths: ['a', 3] },
      { actorId: ACTOR, paths: Array.from({ length: 51 }, (_, i) => `p${i}`) },
      { actorId: ACTOR, maxBytes: 65537 },
      { actorId: ACTOR, maxBytes: 0 },
      { actorId: ACTOR, maxBytes: 1.5 },
      { actorId: ACTOR, maxBytes: '100' },
    ]) {
      await expect(
        handleGetActorStats(args, buildClient(), bridge),
        JSON.stringify(args),
      ).rejects.toThrow(McpError);
    }
    await expect(
      handleGetActorStats({ actorId: ACTOR, maxBytes: 65537 }, buildClient(), bridge),
    ).rejects.toThrow('maxBytes must be an integer from 1 to 65536');
    expect(bridge.send).not.toHaveBeenCalled();
  });

  it('reports a target the module could not read', async () => {
    const bridge = buildBridge({
      results: [{ actorId: ACTOR, error: `Actor ${ACTOR} not found` }],
      truncated: false,
    });
    await expect(handleGetActorStats({ actorId: ACTOR }, buildClient(), bridge)).rejects.toThrow(
      `Failed to get actor stats: Actor ${ACTOR} not found`,
    );
  });

  it('turns tooLarge into a clear error: size, largest keys, then paths', async () => {
    const bridge = buildBridge({
      tooLarge: true,
      bytes: 40000,
      maxBytes: 32768,
      results: [
        {
          actorId: ACTOR,
          topLevel: [
            { key: 'skills', bytes: 30000 },
            { key: 'pool', bytes: 512 },
          ],
        },
      ],
    });
    await expect(handleGetActorStats({ actorId: ACTOR }, buildClient(), bridge)).rejects.toThrow(
      'The answer is 40000 bytes of JSON, over maxBytes 32768. Top-level keys of system, largest first: skills (29.3 KiB), pool (512 B). Pass paths to read only what you need, e.g. ["skills"], or raise maxBytes (at most 65536).',
    );
  });

  it('checks the size again on its side', async () => {
    const big = { notes: 'x'.repeat(2000), pool: { value: 1 } };
    const bridge = buildBridge({
      results: [{ actorId: ACTOR, name: 'Wanderer', type: 'traveler', system: big }],
      truncated: false,
    });
    await expect(
      handleGetActorStats({ actorId: ACTOR, maxBytes: 1000 }, buildClient(), bridge),
    ).rejects.toThrow(
      /over maxBytes 1000\. Top-level keys of system, largest first: notes \(2\.0 KiB\), pool \(11 B\)/,
    );
  });

  it('refuses before sending when the connected module is older than 0.6.0', async () => {
    const bridge = new ModuleBridge(0, {
      expectedOrigin: 'http://localhost:30000',
      installedModuleVersion: () => '0.5.2',
    });
    const socketSend = vi.fn();
    Reflect.set(bridge, 'socket', { readyState: 1, send: socketSend });

    await expect(handleGetActorStats({ actorId: ACTOR }, buildClient(), bridge)).rejects.toThrow(
      refusalError(
        ErrorCode.InvalidRequest,
        "the connected companion module 0.5.2 (not announced) does not provide 'get_actor_stats', which needs 0.6.0 or later",
      ),
    );
    expect(socketSend).not.toHaveBeenCalled();
  });

  it('says the bridge is disabled', async () => {
    await expect(handleGetActorStats({ actorId: ACTOR }, buildClient(), null)).rejects.toThrow(
      /module bridge is disabled/,
    );
  });
});
