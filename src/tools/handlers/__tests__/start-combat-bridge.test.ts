/**
 * @fileoverview start_combat through the companion module's create_combat,
 * and what it does without it (declared combat types).
 */

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import type { ModuleBridge } from '../../../foundry/module-bridge.js';
import type { WorldCombat, WorldData } from '../../../foundry/types.js';
import { logger } from '../../../utils/logger.js';
import { isRefusal, RefusedError } from '../../../utils/refusal.js';
import {
  CACHED_COMBAT_WAIT_MS,
  declaredCombatTypes,
  handleStartCombat,
} from '../combat-mutations.js';

const SCENE = 'sceneSSSSSSSSSSS';
const LINKED = 'tokenLLLLLLLLLLL';
const UNLINKED = 'tokenUUUUUUUUUUU';
const ACTOR = 'actorAAAAAAAAAAA';
const COMBAT = 'combatCCCCCCCCCC';

const scene = {
  _id: SCENE,
  name: 'ZZ arena',
  active: true,
  tokens: [{ _id: LINKED, actorId: ACTOR }, { _id: UNLINKED }],
};

/** A begun combat as the cache shows it once the broadcast arrived. */
const cachedCombat = (combatants = 2): WorldCombat => ({
  _id: COMBAT,
  active: true,
  round: 1,
  turn: 0,
  combatants: Array.from({ length: combatants }, (_, i) => ({
    _id: `combatant${i}`.padEnd(16, '0'),
    name: `C${i}`,
    initiative: null,
    hidden: false,
    defeated: false,
  })),
});

function makeClient(
  opts: { writeEnabled?: boolean; world?: Partial<WorldData>; combats?: () => WorldCombat[] } = {},
) {
  const world = { ...opts.world } as Record<string, unknown>;
  return {
    getScenes: vi.fn(() => [scene]),
    isWriteEnabled: vi.fn(() => opts.writeEnabled ?? true),
    getWorldData: vi.fn(() => ({ ...world, combats: opts.combats?.() ?? [] }) as WorldData),
    startCombat: vi.fn(async () => ({ combatId: 'socketCOMBAT0000', combatantCount: 2 })),
  };
}

function makeBridge(opts: { serves?: boolean; connected?: boolean; answer?: unknown } = {}) {
  return {
    supports: vi.fn((type: string) => (opts.serves ?? true) && type === 'create_combat'),
    isConnected: vi.fn(() => opts.connected ?? true),
    missingCommandMessage: vi.fn(
      (type: string) =>
        `the connected companion module 0.6.0 does not provide '${type}', which needs 0.7.0 or later`,
    ),
    send: vi.fn(async () =>
      'answer' in opts
        ? opts.answer
        : {
            combatId: COMBAT,
            sceneId: SCENE,
            combatantIds: ['combatant0000000', 'combatant1000000'],
            round: 1,
            turn: 0,
          },
    ),
  };
}

const start = (
  client: ReturnType<typeof makeClient>,
  bridge: ReturnType<typeof makeBridge> | null,
  args: { tokenIds?: string[]; sceneId?: string } = {},
) =>
  handleStartCombat(
    args,
    client as unknown as FoundryClient,
    bridge as unknown as ModuleBridge | null,
  );

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** A world whose game system declares a combat type of its own. */
const declaringWorld = { model: { Combat: { standard: {} }, Combatant: { standard: {} } } };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The info lines start_combat logged about the cache. */
function cacheLogLines(info: ReturnType<typeof vi.spyOn>): string[] {
  return info.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes('the cache'));
}

describe('declaredCombatTypes', () => {
  it('reads the model, without base', () => {
    expect(
      declaredCombatTypes({
        model: { Combat: { base: {}, standard: {} } },
      } as unknown as WorldData),
    ).toEqual(['standard']);
  });

  it('reads the system manifest when the payload has no model', () => {
    expect(
      declaredCombatTypes({
        system: { documentTypes: { Combatant: { duelist: {} } } },
      } as unknown as WorldData),
    ).toEqual(['duelist']);
  });

  it('finds none in a world that declares none, or without world data', () => {
    expect(
      declaredCombatTypes({ model: { Combat: { base: {} } } } as unknown as WorldData),
    ).toEqual([]);
    expect(declaredCombatTypes({} as WorldData)).toEqual([]);
    expect(declaredCombatTypes(null)).toEqual([]);
  });
});

describe('start_combat through the companion module', () => {
  it('sends the scene and the tokens, never a type, and waits for the cache', async () => {
    let caught = false;
    setTimeout(() => {
      caught = true;
    }, 60);
    const client = makeClient({ combats: () => (caught ? [cachedCombat()] : []) });
    const bridge = makeBridge();
    const info = vi.spyOn(logger, 'info');

    const result = await start(client, bridge);

    expect(bridge.send).toHaveBeenCalledWith('create_combat', {
      sceneId: SCENE,
      combatants: [{ tokenId: LINKED, actorId: ACTOR }, { tokenId: UNLINKED }],
    });
    expect(client.startCombat).not.toHaveBeenCalled();
    expect(caught).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain(`**Encounter:** ${COMBAT}`);
    expect(text).toContain('**Combatants:** 2');
    expect(text).toContain('**Created by:** the companion module');
    expect(text).not.toContain('⚠️');
    // One line, with the time waited and at least one poll.
    const lines = cacheLogLines(info);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      new RegExp(`^combat ${COMBAT} in the cache after \\d+ ms \\(([1-9]\\d*) polls\\)$`),
    );
  });

  it('logs 0 polls when the cache already has the combat', async () => {
    const info = vi.spyOn(logger, 'info');
    await start(makeClient({ combats: () => [cachedCombat()] }), makeBridge());
    expect(cacheLogLines(info)).toEqual([
      expect.stringMatching(
        new RegExp(`^combat ${COMBAT} in the cache after \\d+ ms \\(0 polls\\)$`),
      ),
    ]);
  });

  it('answers after a bounded wait, with a note, when the cache does not catch up', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(logger, 'info');
    const client = makeClient({ combats: () => [] });
    const pending = start(client, makeBridge());
    await vi.advanceTimersByTimeAsync(CACHED_COMBAT_WAIT_MS + 100);
    const result = await pending;
    expect(result.content[0].text).toContain("The connector's cache had not caught up");
    expect(cacheLogLines(info)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^combat ${COMBAT} not yet in the cache after ${CACHED_COMBAT_WAIT_MS} ms \\(\\d+ polls\\); answered with a note$`,
        ),
      ),
    ]);
  });

  it('reports a combat left in place, with its id, as a failure', async () => {
    const bridge = makeBridge({
      answer: {
        combatId: COMBAT,
        sceneId: SCENE,
        combatantIds: [],
        round: 0,
        turn: null,
        incomplete: 'its combatants could not be created (validation failed), and it was not begun',
      },
    });
    const error = await rejection(start(makeClient(), bridge));
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).message).toContain(
      `Combat ${COMBAT} was created on scene ZZ arena (${SCENE}), but its combatants could not be created (validation failed), and it was not begun. It was left in place; end_combat removes it.`,
    );
    expect(isRefusal(error)).toBe(false);
  });

  it("passes the module's refusal on as a refusal", async () => {
    const bridge = makeBridge();
    bridge.send.mockRejectedValueOnce(new RefusedError('Token tokenX not found on scene'));
    const error = await rejection(start(makeClient(), bridge));
    expect(isRefusal(error)).toBe(true);
    expect((error as McpError).message).toContain('Token tokenX not found on scene');
  });

  it('fails on an answer of the wrong shape', async () => {
    const error = await rejection(start(makeClient(), makeBridge({ answer: { combatId: 7 } })));
    expect((error as McpError).message).toContain('unexpected create_combat shape');
  });

  it('leaves the module out while writes are disabled: the socket path turns the call down', async () => {
    const client = makeClient({ writeEnabled: false, world: declaringWorld });
    const bridge = makeBridge();
    await start(client, bridge);
    expect(bridge.send).not.toHaveBeenCalled();
    expect(client.startCombat).toHaveBeenCalled();
  });
});

describe('start_combat without create_combat', () => {
  it.each([
    ['a module without the command', makeBridge({ serves: false })],
    ['no module connected', makeBridge({ serves: false, connected: false })],
    ['the bridge disabled', null],
  ])(
    'creates the combat over the socket with a note, with %s, when the game system declares combat types',
    async (_label, bridge) => {
      const client = makeClient({ world: declaringWorld });
      const result = await start(client, bridge);
      expect(client.startCombat).toHaveBeenCalled();
      const text = result.content[0].text;
      expect(text).toContain('**Created by:** the socket');
      expect(text).toContain(
        "This world's game system defines its own combat data (types: standard)",
      );
      expect(text).toContain(
        'Created without it, the combat is rejected by open browsers until each user reloads FoundryVTT (F5); later updates then show live.',
      );
    },
  );

  it('creates the combat over the socket when the game system declares none', async () => {
    const client = makeClient({ world: { model: { Combat: { base: {} } } } });
    const result = await start(client, makeBridge({ serves: false }));
    expect(client.startCombat).toHaveBeenCalledWith(SCENE, [
      { tokenId: LINKED, sceneId: SCENE, actorId: ACTOR },
      { tokenId: UNLINKED, sceneId: SCENE, actorId: undefined },
    ]);
    expect(result.content[0].text).toContain('**Created by:** the socket');
  });
});
