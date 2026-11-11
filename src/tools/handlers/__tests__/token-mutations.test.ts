import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { FoundryClient } from '../../../foundry/client.js';
import type { ModuleBridge } from '../../../foundry/module-bridge.js';
import type { WorldActor, WorldEffect, WorldScene } from '../../../foundry/types.js';
import {
  handleApplyStatusEffect,
  handleMoveToken,
  handleMoveTokens,
  handleUpdateTokenVision,
} from '../token-mutations.js';

const SCENE_ID = 'ssssssssssssssss'; // 16 alphanumeric chars
const TOKEN_ID = 'tttttttttttttttt';
const ACTOR_ID = 'aaaaaaaaaaaaaaaa';
const EFFECT_ID = 'eeeeeeeeeeeeeeee';

/** Builds a minimal WorldScene carrying one token. */
const makeScene = (token: Record<string, unknown>): WorldScene =>
  ({
    _id: SCENE_ID,
    name: 'Test Scene',
    active: true,
    navigation: true,
    width: 1000,
    height: 1000,
    padding: 0.25,
    darkness: 0,
    globalLight: true,
    tokens: [token],
  }) as WorldScene;

describe('Token mutation handlers', () => {
  const createMockClient = (opts: {
    located?: { scene: WorldScene; token: Record<string, unknown> } | null;
    actor?: WorldActor | undefined;
    /** An unlinked token's effects, base actor and delta merged. */
    tokenEffects?: WorldEffect[];
    moveToken?: (sceneId: string, tokenId: string, x: number, y: number) => unknown;
    createEffect?: (uuid: string, statusId: string) => WorldEffect;
    deleteEffect?: (uuid: string, effectId: string) => unknown;
    writeEnabled?: boolean;
  }): FoundryClient =>
    ({
      isWriteEnabled: vi.fn(() => opts.writeEnabled ?? true),
      findToken: vi.fn(() => opts.located ?? null),
      getRawActor: vi.fn(() => opts.actor),
      getTokenActorEffects: vi.fn(() =>
        opts.located?.token.actorLink === true
          ? (opts.actor?.effects ?? [])
          : (opts.tokenEffects ?? []),
      ),
      moveToken: vi.fn(opts.moveToken ?? (() => ({}))),
      createActorStatusEffect: vi.fn(
        opts.createEffect ?? (() => ({ _id: EFFECT_ID, name: 'Prone', statuses: ['prone'] })),
      ),
      deleteActorEffect: vi.fn(opts.deleteEffect ?? (() => undefined)),
    }) as unknown as FoundryClient;

  describe('handleMoveToken', () => {
    it('moves a located token and reports the new position', async () => {
      const token = { _id: TOKEN_ID, name: 'Goblin', x: 0, y: 0 };
      const client = createMockClient({ located: { scene: makeScene(token), token } });

      const result = await handleMoveToken({ tokenId: TOKEN_ID, x: 100, y: 200 }, client);

      expect(result.content[0].text).toContain('Token Moved');
      expect(result.content[0].text).toContain('Goblin');
      expect(result.content[0].text).toContain('(100, 200)');
      expect(client.moveToken).toHaveBeenCalledWith(SCENE_ID, TOKEN_ID, 100, 200);
    });

    it('raises McpError when the token is not found', async () => {
      const client = createMockClient({ located: null });
      await expect(handleMoveToken({ tokenId: TOKEN_ID, x: 1, y: 2 }, client)).rejects.toThrow(
        McpError,
      );
      expect(client.moveToken).not.toHaveBeenCalled();
    });

    it('rejects non-finite coordinates before reaching the client', async () => {
      const client = createMockClient({});
      await expect(
        handleMoveToken({ tokenId: TOKEN_ID, x: Number.NaN, y: 0 }, client),
      ).rejects.toThrow(McpError);
      expect(client.moveToken).not.toHaveBeenCalled();
    });

    it('rejects a missing tokenId', async () => {
      const client = createMockClient({});
      await expect(handleMoveToken({ tokenId: '', x: 1, y: 2 }, client)).rejects.toThrow(McpError);
    });
  });

  describe('handleApplyStatusEffect', () => {
    it('applies a new status effect on a linked actor (parentUuid Actor.<id>)', async () => {
      const token = { _id: TOKEN_ID, name: 'Goblin', actorId: ACTOR_ID, actorLink: true };
      const actor = { _id: ACTOR_ID, name: 'Goblin', type: 'npc', system: {}, effects: [] };
      const client = createMockClient({
        located: { scene: makeScene(token), token },
        actor: actor as unknown as WorldActor,
      });

      const result = await handleApplyStatusEffect(
        { tokenId: TOKEN_ID, statusId: 'prone' },
        client,
      );

      expect(result.content[0].text).toContain('Status Effect Applied');
      expect(result.content[0].text).toContain('prone');
      expect(client.createActorStatusEffect).toHaveBeenCalledWith(`Actor.${ACTOR_ID}`, 'prone');
      expect(client.deleteActorEffect).not.toHaveBeenCalled();
    });

    it('targets the synthetic actor UUID for an unlinked token', async () => {
      const token = { _id: TOKEN_ID, name: 'Goblin', actorId: ACTOR_ID, actorLink: false };
      const client = createMockClient({
        located: { scene: makeScene(token), token },
        actor: undefined,
      });

      await handleApplyStatusEffect({ tokenId: TOKEN_ID, statusId: 'stunned' }, client);

      expect(client.createActorStatusEffect).toHaveBeenCalledWith(
        `Scene.${SCENE_ID}.Token.${TOKEN_ID}.Actor.${ACTOR_ID}`,
        'stunned',
      );
    });

    it("finds a status an unlinked token inherits from its base actor, and doesn't apply it again", async () => {
      const token = { _id: TOKEN_ID, name: 'Goblin', actorId: ACTOR_ID, actorLink: false };
      const client = createMockClient({
        located: { scene: makeScene(token), token },
        tokenEffects: [{ _id: EFFECT_ID, name: 'Prone', statuses: ['prone'] } as WorldEffect],
      });

      const result = await handleApplyStatusEffect(
        { tokenId: TOKEN_ID, statusId: 'prone' },
        client,
      );

      expect(result.content[0].text).toContain('already active');
      expect(client.getTokenActorEffects).toHaveBeenCalledWith(TOKEN_ID, SCENE_ID);
      expect(client.createActorStatusEffect).not.toHaveBeenCalled();
    });

    it("removes an inherited status through the token's own actor", async () => {
      const token = { _id: TOKEN_ID, name: 'Goblin', actorId: ACTOR_ID, actorLink: false };
      const client = createMockClient({
        located: { scene: makeScene(token), token },
        tokenEffects: [{ _id: EFFECT_ID, name: 'Prone', statuses: ['prone'] } as WorldEffect],
      });

      await handleApplyStatusEffect(
        { tokenId: TOKEN_ID, statusId: 'prone', active: false },
        client,
      );

      // The client sends this under the token's ActorDelta; FoundryVTT tombstones it there.
      expect(client.deleteActorEffect).toHaveBeenCalledWith(
        `Scene.${SCENE_ID}.Token.${TOKEN_ID}.Actor.${ACTOR_ID}`,
        EFFECT_ID,
      );
    });

    it('is a no-op when applying an already-present status', async () => {
      const token = { _id: TOKEN_ID, name: 'Goblin', actorId: ACTOR_ID, actorLink: true };
      const actor = {
        _id: ACTOR_ID,
        name: 'Goblin',
        type: 'npc',
        system: {},
        effects: [{ _id: EFFECT_ID, name: 'Prone', statuses: ['prone'] }],
      };
      const client = createMockClient({
        located: { scene: makeScene(token), token },
        actor: actor as unknown as WorldActor,
      });

      const result = await handleApplyStatusEffect(
        { tokenId: TOKEN_ID, statusId: 'prone' },
        client,
      );

      expect(result.content[0].text).toContain('already active');
      expect(client.createActorStatusEffect).not.toHaveBeenCalled();
    });

    it('removes an existing status effect by its id when active=false', async () => {
      const token = { _id: TOKEN_ID, name: 'Goblin', actorId: ACTOR_ID, actorLink: true };
      const actor = {
        _id: ACTOR_ID,
        name: 'Goblin',
        type: 'npc',
        system: {},
        effects: [{ _id: EFFECT_ID, name: 'Prone', statuses: ['prone'] }],
      };
      const client = createMockClient({
        located: { scene: makeScene(token), token },
        actor: actor as unknown as WorldActor,
      });

      const result = await handleApplyStatusEffect(
        { tokenId: TOKEN_ID, statusId: 'prone', active: false },
        client,
      );

      expect(result.content[0].text).toContain('Status Effect Removed');
      expect(client.deleteActorEffect).toHaveBeenCalledWith(`Actor.${ACTOR_ID}`, EFFECT_ID);
      expect(client.createActorStatusEffect).not.toHaveBeenCalled();
    });

    it('is a no-op when removing an absent status', async () => {
      const token = { _id: TOKEN_ID, name: 'Goblin', actorId: ACTOR_ID, actorLink: true };
      const actor = { _id: ACTOR_ID, name: 'Goblin', type: 'npc', system: {}, effects: [] };
      const client = createMockClient({
        located: { scene: makeScene(token), token },
        actor: actor as unknown as WorldActor,
      });

      const result = await handleApplyStatusEffect(
        { tokenId: TOKEN_ID, statusId: 'prone', active: false },
        client,
      );

      expect(result.content[0].text).toContain('nothing to remove');
      expect(client.deleteActorEffect).not.toHaveBeenCalled();
    });

    it('raises McpError when the token has no associated actor', async () => {
      const token = { _id: TOKEN_ID, name: 'Decoration' };
      const client = createMockClient({ located: { scene: makeScene(token), token } });
      await expect(
        handleApplyStatusEffect({ tokenId: TOKEN_ID, statusId: 'prone' }, client),
      ).rejects.toThrow(McpError);
    });

    it('raises McpError when the token is not found', async () => {
      const client = createMockClient({ located: null });
      await expect(
        handleApplyStatusEffect({ tokenId: TOKEN_ID, statusId: 'prone' }, client),
      ).rejects.toThrow(McpError);
    });

    it('rejects a missing statusId', async () => {
      const token = { _id: TOKEN_ID, actorId: ACTOR_ID, actorLink: true };
      const client = createMockClient({ located: { scene: makeScene(token), token } });
      await expect(
        handleApplyStatusEffect({ tokenId: TOKEN_ID, statusId: '' }, client),
      ).rejects.toThrow(McpError);
    });
  });

  describe('handleApplyStatusEffect through the companion module', () => {
    /** A connected module that announces toggle_status_effect (or not). */
    function buildBridge(opts: { announces?: boolean; answer?: unknown; error?: Error } = {}) {
      return {
        supports: vi.fn(
          (type: string) => (opts.announces ?? true) && type === 'toggle_status_effect',
        ),
        send: vi.fn(async () => {
          if (opts.error) {
            throw opts.error;
          }
          return (
            opts.answer ?? {
              active: true,
              changed: true,
              effectId: 'statusEffect0000',
              legacy: [],
            }
          );
        }),
        isConnected: vi.fn(() => true),
        describeModuleVersion: vi.fn(() => '0.5.2 (not announced)'),
      } as unknown as ModuleBridge;
    }

    const unlinked = { _id: TOKEN_ID, name: 'Goblin', actorId: ACTOR_ID, actorLink: false };

    it("applies through the system's status toggle, on the token's own actor", async () => {
      const client = createMockClient({ located: { scene: makeScene(unlinked), token: unlinked } });
      const bridge = buildBridge();

      const result = await handleApplyStatusEffect(
        { tokenId: TOKEN_ID, statusId: 'prone' },
        client,
        bridge,
      );

      expect(bridge.send).toHaveBeenCalledWith('toggle_status_effect', {
        target: { sceneId: SCENE_ID, tokenId: TOKEN_ID, actorId: ACTOR_ID },
        statusId: 'prone',
        active: true,
      });
      expect(client.createActorStatusEffect).not.toHaveBeenCalled();
      const text = result.content[0].text;
      expect(text).toContain('**Path:** game system');
      expect(text).toContain("Applied status effect 'prone' (effect statusEffect0000).");
    });

    it('always asks the module, which decides that nothing changes', async () => {
      // The cache holds an earlier-version effect with the status: the
      // module, not the cache, decides.
      const client = createMockClient({
        located: { scene: makeScene(unlinked), token: unlinked },
        tokenEffects: [{ _id: EFFECT_ID, name: 'Prone', statuses: ['prone'] } as WorldEffect],
      });
      const bridge = buildBridge({
        answer: { active: true, changed: false, effectId: 'statusEffect0000', legacy: [EFFECT_ID] },
      });

      const result = await handleApplyStatusEffect(
        { tokenId: TOKEN_ID, statusId: 'prone' },
        client,
        bridge,
      );

      expect(bridge.send).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain(
        "Status effect 'prone' is already active on Goblin (effect statusEffect0000).\n" +
          `Effect(s) ${EFFECT_ID} from an earlier version also carry this status; active=false removes them.`,
      );
    });

    it('reports the earlier-version effects next to a new one', async () => {
      const client = createMockClient({ located: { scene: makeScene(unlinked), token: unlinked } });
      const result = await handleApplyStatusEffect(
        { tokenId: TOKEN_ID, statusId: 'prone' },
        client,
        buildBridge({
          answer: { active: true, changed: true, effectId: 'statusEffect0000', legacy: ['a', 'b'] },
        }),
      );
      expect(result.content[0].text).toContain(
        "Applied status effect 'prone' (effect statusEffect0000).\n" +
          'Effect(s) a, b from an earlier version also carry this status; active=false removes them.',
      );
    });

    it('lists what the module removed, or says nothing was there', async () => {
      const client = createMockClient({ located: { scene: makeScene(unlinked), token: unlinked } });

      const removed = await handleApplyStatusEffect(
        { tokenId: TOKEN_ID, statusId: 'prone', active: false },
        client,
        buildBridge({
          answer: { active: false, changed: true, removed: ['statusEffect0000', EFFECT_ID] },
        }),
      );
      expect(removed.content[0].text).toContain(
        `Removed status effect 'prone' (effects statusEffect0000, ${EFFECT_ID}).`,
      );
      expect(removed.content[0].text).toContain('**Path:** game system');

      const untouched = await handleApplyStatusEffect(
        { tokenId: TOKEN_ID, statusId: 'prone', active: false },
        client,
        buildBridge({ answer: { active: false, changed: false, removed: [] } }),
      );
      expect(untouched.content[0].text).toContain(
        "Status effect 'prone' is not active on Goblin; nothing to remove.",
      );
      expect(client.deleteActorEffect).not.toHaveBeenCalled();
    });

    it('refuses an answer of the wrong shape', async () => {
      const client = createMockClient({ located: { scene: makeScene(unlinked), token: unlinked } });
      await expect(
        handleApplyStatusEffect(
          { tokenId: TOKEN_ID, statusId: 'prone' },
          client,
          buildBridge({ answer: { active: true, effectId: 'statusEffect0000' } }),
        ),
      ).rejects.toThrow('Module returned an unexpected toggle_status_effect shape');
    });

    it('keeps the socket path when the module does not announce the command', async () => {
      const client = createMockClient({ located: { scene: makeScene(unlinked), token: unlinked } });
      const bridge = buildBridge({ announces: false });

      const result = await handleApplyStatusEffect(
        { tokenId: TOKEN_ID, statusId: 'prone' },
        client,
        bridge,
      );

      expect(bridge.send).not.toHaveBeenCalled();
      expect(client.createActorStatusEffect).toHaveBeenCalled();
      expect(result.content[0].text).toContain('**Path:** socket');
    });

    it('while writes are disabled, refuses a change without asking the module', async () => {
      const client = createMockClient({
        located: { scene: makeScene(unlinked), token: unlinked },
        writeEnabled: false,
        // The socket path refuses, as the real client's assertWriteable does.
        createEffect: () => {
          throw new Error('Write operations are disabled. Set FOUNDRY_WRITE_ENABLED=true.');
        },
      });
      const bridge = buildBridge();

      await expect(
        handleApplyStatusEffect({ tokenId: TOKEN_ID, statusId: 'prone' }, client, bridge),
      ).rejects.toThrow('Write operations are disabled');
      expect(bridge.send).not.toHaveBeenCalled();
    });

    it('answers a no-op from the cache without the module, even while writes are disabled', async () => {
      const client = createMockClient({
        located: { scene: makeScene(unlinked), token: unlinked },
        writeEnabled: false,
      });
      const bridge = buildBridge();

      const result = await handleApplyStatusEffect(
        { tokenId: TOKEN_ID, statusId: 'prone', active: false },
        client,
        bridge,
      );

      expect(result.content[0].text).toContain('nothing to remove');
      expect(result.content[0].text).toContain('**Path:** none');
      expect(bridge.send).not.toHaveBeenCalled();
    });

    it("passes on the module's refusal of an unknown status", async () => {
      const client = createMockClient({ located: { scene: makeScene(unlinked), token: unlinked } });
      const bridge = buildBridge({
        error: new Error('Unknown status effect "nope". Valid ids: prone (Prone)'),
      });

      await expect(
        handleApplyStatusEffect({ tokenId: TOKEN_ID, statusId: 'nope' }, client, bridge),
      ).rejects.toThrow(
        'Failed to apply status effect: Unknown status effect "nope". Valid ids: prone (Prone)',
      );
    });
  });

  describe('handleApplyStatusEffect createOptions', () => {
    function buildBridge(opts: { announces?: boolean; answer?: unknown } = {}) {
      return {
        supports: vi.fn(
          (type: string) => (opts.announces ?? true) && type === 'toggle_status_effect',
        ),
        send: vi.fn(
          async () =>
            opts.answer ?? {
              active: true,
              changed: true,
              effectId: 'statusEffect0000',
              legacy: [],
            },
        ),
        isConnected: vi.fn(() => true),
        describeModuleVersion: vi.fn(() => '0.5.2 (not announced)'),
      } as unknown as ModuleBridge;
    }

    const unlinked = { _id: TOKEN_ID, name: 'Goblin', actorId: ACTOR_ID, actorLink: false };
    const apply = (
      createOptions: unknown,
      bridge: ModuleBridge | null,
      opts: { active?: boolean; writeEnabled?: boolean } = {},
    ) => {
      const client = createMockClient({
        located: { scene: makeScene(unlinked), token: unlinked },
        writeEnabled: opts.writeEnabled ?? true,
      });
      return {
        client,
        result: handleApplyStatusEffect(
          { tokenId: TOKEN_ID, statusId: 'prone', active: opts.active, createOptions },
          client,
          bridge,
        ),
      };
    };

    it('passes them to the module', async () => {
      const bridge = buildBridge();
      await apply({ level: 4 }, bridge).result;
      expect(bridge.send).toHaveBeenCalledWith('toggle_status_effect', {
        target: { sceneId: SCENE_ID, tokenId: TOKEN_ID, actorId: ACTOR_ID },
        statusId: 'prone',
        active: true,
        createOptions: { level: 4 },
      });
    });

    it('says they were ignored when the status was already active', async () => {
      const bridge = buildBridge({
        answer: { active: true, changed: false, effectId: 'statusEffect0000', legacy: [] },
      });
      const result = await apply({ level: 4 }, bridge).result;
      expect(result.content[0].text).toContain(
        "Status effect 'prone' is already active on Goblin (effect statusEffect0000). createOptions were ignored: nothing was created.",
      );
    });

    it('refuses what is not a small plain object of free option names', async () => {
      const bridge = buildBridge();
      const cases: Array<[unknown, string]> = [
        [[1], 'createOptions must be a JSON object'],
        ['level', 'createOptions must be a JSON object'],
        [
          Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i])),
          'createOptions may hold at most 10 keys',
        ],
        [{ 'bad-name': 1 }, 'createOptions key "bad-name" is not a valid option name'],
        [
          { parent: 'x', keepId: false, level: 2 },
          "createOptions may not set the core's own creation options: parent, keepId",
        ],
        [{ note: 'x'.repeat(1100) }, 'createOptions may hold at most 1024 bytes of JSON'],
      ];
      for (const [options, message] of cases) {
        await expect(apply(options, bridge).result, message).rejects.toThrow(message);
      }
      expect(bridge.send).not.toHaveBeenCalled();
    });

    it('refuses them with active=false', async () => {
      const bridge = buildBridge();
      await expect(apply({ level: 4 }, bridge, { active: false }).result).rejects.toThrow(
        'createOptions only apply when applying a status (active=true)',
      );
      expect(bridge.send).not.toHaveBeenCalled();
    });

    it('refuses them without the module path, and never falls back to the socket', async () => {
      const needs =
        "createOptions need the game system's path, through the companion module 0.6.0 or later with writes enabled, and it is not available: ";
      const disabled = apply({ level: 4 }, null);
      await expect(disabled.result).rejects.toThrow(
        `${needs}the module bridge is disabled. Nothing was changed.`,
      );
      expect(disabled.client.createActorStatusEffect).not.toHaveBeenCalled();

      const old = apply({ level: 4 }, buildBridge({ announces: false }));
      await expect(old.result).rejects.toThrow(
        `${needs}the connected companion module (0.5.2 (not announced)) does not provide 'toggle_status_effect'. Nothing was changed.`,
      );
      expect(old.client.createActorStatusEffect).not.toHaveBeenCalled();

      const readOnly = apply({ level: 4 }, buildBridge(), { writeEnabled: false });
      await expect(readOnly.result).rejects.toThrow(
        `${needs}writes are disabled (FOUNDRY_WRITE_ENABLED). Nothing was changed.`,
      );
      expect(readOnly.client.createActorStatusEffect).not.toHaveBeenCalled();
    });
  });

  describe('handleMoveTokens', () => {
    const createMoveTokensClient = (opts: {
      located?: Record<string, { scene: WorldScene; token: Record<string, unknown> } | null>;
      moveToken?: (sceneId: string, tokenId: string, x: number, y: number) => unknown;
      moveTokenPathfind?: (
        sceneId: string,
        tokenId: string,
        x: number,
        y: number,
        options: { openDoors?: boolean },
      ) => unknown;
      writeEnabled?: boolean;
    }): FoundryClient =>
      ({
        findToken: vi.fn((tokenId: string) => opts.located?.[tokenId] ?? null),
        moveToken: vi.fn(opts.moveToken ?? (() => ({}))),
        moveTokenPathfind: vi.fn(
          opts.moveTokenPathfind ??
            (() => ({ path: [{ x: 0, y: 0 }], doorsOpened: [], blocked: false, final: {} })),
        ),
        isWriteEnabled: vi.fn(() => opts.writeEnabled ?? true),
      }) as unknown as FoundryClient;

    it('moves every token directly and reports the success count', async () => {
      const tokenA = { _id: 'aaaaaaaaaaaaaaaa', name: 'Fighter' };
      const tokenB = { _id: 'bbbbbbbbbbbbbbbb', name: 'Rogue' };
      const client = createMoveTokensClient({
        located: {
          aaaaaaaaaaaaaaaa: { scene: makeScene(tokenA), token: tokenA },
          bbbbbbbbbbbbbbbb: { scene: makeScene(tokenB), token: tokenB },
        },
      });

      const result = await handleMoveTokens(
        {
          moves: [
            { tokenId: 'aaaaaaaaaaaaaaaa', x: 100, y: 200 },
            { tokenId: 'bbbbbbbbbbbbbbbb', x: 300, y: 400 },
          ],
        },
        client,
      );

      expect(result.content[0].text).toContain('Tokens Moved** (2/2)');
      expect(result.content[0].text).toContain('Fighter');
      expect(result.content[0].text).toContain('Rogue');
      expect(client.moveToken).toHaveBeenCalledWith(SCENE_ID, 'aaaaaaaaaaaaaaaa', 100, 200);
      expect(client.moveToken).toHaveBeenCalledWith(SCENE_ID, 'bbbbbbbbbbbbbbbb', 300, 400);
    });

    it('reports an unknown token as a per-item failure without losing the rest', async () => {
      const tokenA = { _id: 'aaaaaaaaaaaaaaaa', name: 'Fighter' };
      const client = createMoveTokensClient({
        located: { aaaaaaaaaaaaaaaa: { scene: makeScene(tokenA), token: tokenA } },
      });

      const result = await handleMoveTokens(
        {
          moves: [
            { tokenId: 'zzzzzzzzzzzzzzzz', x: 1, y: 2 },
            { tokenId: 'aaaaaaaaaaaaaaaa', x: 100, y: 200 },
          ],
        },
        client,
      );

      expect(result.content[0].text).toContain('Tokens Moved** (1/2)');
      expect(result.content[0].text).toContain('Failed (1)');
      expect(result.content[0].text).toContain('zzzzzzzzzzzzzzzz: token not found');
      expect(client.moveToken).toHaveBeenCalledTimes(1);
    });

    it('routes a move through moveTokenPathfind when pathfind is true, reporting a blocked route as a failure', async () => {
      const tokenA = { _id: 'aaaaaaaaaaaaaaaa', name: 'Fighter' };
      const tokenB = { _id: 'bbbbbbbbbbbbbbbb', name: 'Rogue' };
      const client = createMoveTokensClient({
        located: {
          aaaaaaaaaaaaaaaa: { scene: makeScene(tokenA), token: tokenA },
          bbbbbbbbbbbbbbbb: { scene: makeScene(tokenB), token: tokenB },
        },
        moveTokenPathfind: (_s, tokenId) =>
          tokenId === 'bbbbbbbbbbbbbbbb'
            ? { path: [], doorsOpened: [], blocked: true, final: null }
            : {
                path: [
                  { x: 1, y: 1 },
                  { x: 100, y: 200 },
                ],
                doorsOpened: ['w'],
                blocked: false,
                final: {},
              },
      });

      const result = await handleMoveTokens(
        {
          moves: [
            { tokenId: 'aaaaaaaaaaaaaaaa', x: 100, y: 200, pathfind: true },
            { tokenId: 'bbbbbbbbbbbbbbbb', x: 300, y: 400, pathfind: true },
          ],
        },
        client,
      );

      expect(result.content[0].text).toContain('Tokens Moved** (1/2)');
      expect(result.content[0].text).toContain('via 2 waypoint(s)');
      expect(result.content[0].text).toContain('opened 1 door(s)');
      expect(result.content[0].text).toContain('no route to (300, 400)');
      expect(client.moveToken).not.toHaveBeenCalled();
    });

    it('fails fast with one error when writes are disabled, without calling findToken', async () => {
      const client = createMoveTokensClient({ writeEnabled: false });

      await expect(
        handleMoveTokens({ moves: [{ tokenId: 'aaaaaaaaaaaaaaaa', x: 1, y: 2 }] }, client),
      ).rejects.toThrow(/FOUNDRY_WRITE_ENABLED/);
      expect(client.findToken).not.toHaveBeenCalled();
    });

    it('rejects an empty moves array', async () => {
      const client = createMoveTokensClient({});
      await expect(handleMoveTokens({ moves: [] }, client)).rejects.toThrow(McpError);
    });

    it('rejects a move with non-finite coordinates before reaching the client', async () => {
      const client = createMoveTokensClient({});
      await expect(
        handleMoveTokens({ moves: [{ tokenId: 'aaaaaaaaaaaaaaaa', x: Number.NaN, y: 0 }] }, client),
      ).rejects.toThrow(McpError);
      expect(client.isWriteEnabled).not.toHaveBeenCalled();
    });
  });

  describe('handleUpdateTokenVision', () => {
    it('updates vision settings on a located token', async () => {
      const token = { _id: TOKEN_ID, name: 'Goblin' };
      const client = {
        findToken: vi.fn(() => ({ scene: makeScene(token), token })),
        updateTokenVision: vi.fn(() => Promise.resolve({})),
      } as unknown as FoundryClient;

      const result = await handleUpdateTokenVision({ tokenId: TOKEN_ID, sightRange: 30 }, client);
      expect(result.content[0].text).toContain('Token Vision/Light Updated');
      expect(client.updateTokenVision).toHaveBeenCalledWith(SCENE_ID, TOKEN_ID, {
        tokenId: TOKEN_ID,
        sightRange: 30,
      });
    });

    it('throws McpError when token is missing', async () => {
      const client = {
        findToken: vi.fn(() => null),
      } as unknown as FoundryClient;

      await expect(handleUpdateTokenVision({ tokenId: TOKEN_ID }, client)).rejects.toThrow(
        McpError,
      );
    });
  });
});

// --------------------------------------------------------------------------
// Client-level: exercise the real methods with a mock socket, asserting the
// emitted modifyDocument body (mirrors combat-mutations.test.ts).
// --------------------------------------------------------------------------
describe('FoundryClient token mutations', () => {
  type SocketEmitMock = (event: string, payload: unknown, cb: (response: unknown) => void) => void;

  const buildClient = (opts: { writeEnabled?: boolean; connected?: boolean }) => {
    const client = new FoundryClient({
      baseUrl: 'http://localhost:30000',
      writeEnabled: opts.writeEnabled ?? true,
    });
    const emit = vi.fn(((_event, payload, cb) => {
      const op = (
        payload as {
          operation?: {
            updates?: Array<Record<string, unknown>>;
            data?: Array<Record<string, unknown>>;
          };
        }
      ).operation;
      const result = op?.updates ?? op?.data ?? [];
      cb({ result: [result[0] ?? { _id: EFFECT_ID }] });
    }) as SocketEmitMock);
    if (opts.connected !== false) {
      (client as unknown as { socket: { connected: boolean; emit: SocketEmitMock } }).socket = {
        connected: true,
        emit,
      };
    }
    return { client, emit };
  };

  it('moveToken emits a Token update with parentUuid Scene.<id>', async () => {
    const { client, emit } = buildClient({});
    await client.moveToken(SCENE_ID, TOKEN_ID, 150, 250);
    const [event, body] = emit.mock.calls[0] as unknown[] as [string, Record<string, unknown>];
    expect(event).toBe('modifyDocument');
    expect(body).toMatchObject({
      type: 'Token',
      action: 'update',
      operation: {
        updates: [{ _id: TOKEN_ID, x: 150, y: 250 }],
        parentUuid: `Scene.${SCENE_ID}`,
      },
    });
  });

  it('createActorStatusEffect emits an ActiveEffect create with statuses and parentUuid', async () => {
    const { client, emit } = buildClient({});
    await client.createActorStatusEffect(`Actor.${ACTOR_ID}`, 'prone');
    const [, body] = emit.mock.calls[0] as unknown[] as [string, Record<string, unknown>];
    expect(body).toMatchObject({
      type: 'ActiveEffect',
      action: 'create',
      operation: {
        data: [{ name: 'prone', statuses: ['prone'] }],
        parentUuid: `Actor.${ACTOR_ID}`,
      },
    });
  });

  it('createActorStatusEffect accepts the unlinked synthetic-actor UUID form', async () => {
    const { client, emit } = buildClient({});
    (client as unknown as { worldData: unknown }).worldData = {
      actors: [],
      scenes: [{ _id: SCENE_ID, tokens: [{ _id: TOKEN_ID, actorId: ACTOR_ID, actorLink: false }] }],
    };
    const uuid = `Scene.${SCENE_ID}.Token.${TOKEN_ID}.Actor.${ACTOR_ID}`;
    await client.createActorStatusEffect(uuid, 'stunned', { name: 'Stunned', img: 'x.png' });
    const [, body] = emit.mock.calls[0] as unknown[] as [string, Record<string, unknown>];
    expect(body).toMatchObject({
      type: 'ActiveEffect',
      action: 'create',
      operation: {
        data: [{ name: 'Stunned', statuses: ['stunned'], img: 'x.png' }],
        parentUuid: `Scene.${SCENE_ID}.Token.${TOKEN_ID}.ActorDelta.${TOKEN_ID}`,
      },
    });
  });

  it('deleteActorEffect emits an ActiveEffect delete carrying ids and parentUuid', async () => {
    const { client, emit } = buildClient({});
    await client.deleteActorEffect(`Actor.${ACTOR_ID}`, EFFECT_ID);
    const [, body] = emit.mock.calls[0] as unknown[] as [string, Record<string, unknown>];
    expect(body).toMatchObject({
      type: 'ActiveEffect',
      action: 'delete',
      operation: { ids: [EFFECT_ID], parentUuid: `Actor.${ACTOR_ID}` },
    });
  });

  it('rejects token writes when FOUNDRY_WRITE_ENABLED is false', async () => {
    const { client } = buildClient({ writeEnabled: false });
    await expect(client.moveToken(SCENE_ID, TOKEN_ID, 1, 2)).rejects.toThrow(
      /FOUNDRY_WRITE_ENABLED/,
    );
  });

  it('rejects token writes when the Socket.IO connection is not active', async () => {
    const { client } = buildClient({ writeEnabled: true, connected: false });
    await expect(client.moveToken(SCENE_ID, TOKEN_ID, 1, 2)).rejects.toThrow(
      /Socket\.IO connection/,
    );
  });

  it('rejects a malformed sceneId', async () => {
    const { client } = buildClient({});
    await expect(client.moveToken('short', TOKEN_ID, 1, 2)).rejects.toThrow(/Invalid sceneId/);
  });

  it('rejects a malformed tokenId', async () => {
    const { client } = buildClient({});
    await expect(client.moveToken(SCENE_ID, 'short', 1, 2)).rejects.toThrow(/Invalid tokenId/);
  });

  it('rejects non-finite coordinates at the client', async () => {
    const { client } = buildClient({});
    await expect(client.moveToken(SCENE_ID, TOKEN_ID, Number.POSITIVE_INFINITY, 0)).rejects.toThrow(
      /Invalid coordinates/,
    );
  });

  it('rejects a malformed actor UUID for status effects', async () => {
    const { client } = buildClient({});
    await expect(client.createActorStatusEffect('Actor.short', 'prone')).rejects.toThrow(
      /Invalid actor UUID/,
    );
  });

  it('rejects a malformed effectId on delete', async () => {
    const { client } = buildClient({});
    await expect(client.deleteActorEffect(`Actor.${ACTOR_ID}`, 'short')).rejects.toThrow(
      /Invalid effectId/,
    );
  });
});
