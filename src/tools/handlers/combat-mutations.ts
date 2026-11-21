/**
 * @fileoverview Combat control mutation tool handlers (FR-018)
 *
 * Provides GM-gated combat-control tools that operate on the *active* combat:
 * advancing the turn, ending the encounter, and setting a combatant's
 * initiative. All are WRITE operations — they require FOUNDRY_WRITE_ENABLED=true
 * and an active Socket.IO connection (mutations use the core `modifyDocument`
 * protocol), and the connected user needs GM/owner permission. Starting a
 * combat goes through the companion module when it serves `create_combat`.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { ModuleBridge } from '../../foundry/module-bridge.js';
import type { WorldCombat, WorldData, WorldScene } from '../../foundry/types.js';
import { isRecord } from '../../utils/guards.js';
import { logger } from '../../utils/logger.js';
import { combatantName } from './combat.js';
import {
  getCurrentCombatant,
  getTurnOrder,
  turnIndexAfterInitiativeChange,
} from './combat-order.js';
import { deletionNote, withToolError } from './utils.js';

/** A combatant seed derived from a scene token, sent to the create wire. */
interface CombatantSeed {
  tokenId: string;
  sceneId: string;
  actorId?: string | undefined;
}

/**
 * Computes the next `{ turn, round }` for an active combat.
 *
 * Advances to the next combatant in order; wrapping past the last combatant
 * rolls over to turn 0 of the next round.
 *
 * `Combat#turn` is an index into the **initiative-sorted** turn order (see
 * `combat-order.ts`), *not* into the stored/creation order of
 * `combat.combatants` — the same order `get_combat_state` renders (laurigates/foundryvtt-mcp#214).
 *
 * When `skipDefeated` is true, `defeated` combatants are skipped — mirroring
 * Foundry's `Combat#nextTurn`/`nextRound` with the `skipDefeated` setting. If
 * every combatant is defeated, the round still advances (turn 0), matching
 * Foundry's "none remaining" fallback rather than hanging.
 *
 * @throws if the combat has no combatants (cannot advance an empty encounter).
 */
export function computeNextTurn(
  combat: WorldCombat,
  skipDefeated = false,
): { turn: number; round: number } {
  const combatants = getTurnOrder(combat);
  const n = combatants.length;
  if (n === 0) {
    throw new Error('Cannot advance turn: active combat has no combatants');
  }

  const cur = combat.turn ?? 0;

  // Scan forward within the current round for the next eligible combatant.
  for (let i = cur + 1; i < n; i++) {
    if (skipDefeated && combatants[i]?.defeated) {
      continue;
    }
    return { turn: i, round: combat.round };
  }

  // No eligible combatant left this round — advance to the next round.
  const round = combat.round + 1;
  if (!skipDefeated) {
    return { turn: 0, round };
  }
  const firstAlive = combatants.findIndex((c) => !c.defeated);
  return { turn: firstAlive === -1 ? 0 : firstAlive, round };
}

/**
 * Advances the active combat to the next turn (FR-018).
 *
 * Accepts an optional `skipDefeated` argument; when omitted it falls back to the
 * combat's `settings.skipDefeated` (if present in the worldData snapshot), then
 * to `false`.
 */
export async function handleNextTurn(
  args: { skipDefeated?: boolean },
  foundryClient: FoundryClient,
) {
  const combat = foundryClient.getCombatState();
  if (!combat) {
    throw new McpError(ErrorCode.InvalidRequest, 'No active combat to advance.');
  }

  const skipDefeated = args?.skipDefeated ?? combat.settings?.skipDefeated ?? false;

  return withToolError('advance combat turn', async () => {
    const { turn, round } = computeNextTurn(combat, skipDefeated);
    await foundryClient.updateCombat(combat._id, { turn, round });

    const current = getTurnOrder(combat)[turn];
    const currentName = current ? combatantName(current, combat, foundryClient) : 'unknown';

    return {
      content: [
        {
          type: 'text',
          text: `⚔️ **Combat Turn Advanced**
**Round:** ${round}
**Turn:** ${turn + 1} of ${combat.combatants.length}
**Now acting:** ${currentName}`,
        },
      ],
    };
  });
}

/**
 * Ends (deletes) the active combat encounter (FR-018).
 */
export async function handleEndCombat(
  _args: Record<string, unknown>,
  foundryClient: FoundryClient,
) {
  const combat = foundryClient.getCombatState();
  if (!combat) {
    throw new McpError(ErrorCode.InvalidRequest, 'No active combat to end.');
  }

  return withToolError('end combat', async () => {
    const note = await foundryClient.endCombat(combat._id);

    return {
      content: [
        {
          type: 'text',
          text: `⚔️ **Combat Ended**
**Encounter:** ${combat._id}
The active combat encounter has been removed.${deletionNote(note)}`,
        },
      ],
    };
  });
}

/**
 * Sets a combatant's initiative in the active combat (FR-018).
 *
 * `combatId` defaults to the active combat when omitted.
 *
 * Writing an initiative re-sorts the turn order underneath the stored
 * `Combat#turn`, which indexes that order (laurigates/foundryvtt-mcp#214) — so a different combatant can
 * slide under the stored index. FoundryVTT's `Combat#setupTurns` re-finds the
 * combatant that was acting and re-points `turn` at its new index; this handler
 * mirrors that, so the MCP and Foundry never disagree about whose turn it is
 * after an initiative correction. The re-anchor is skipped when there is
 * nothing to anchor: no combatant is acting yet (round-0 setup, `turn` null, or
 * a stale index), the acting combatant's index is unchanged, or the write
 * targets a combat other than the active one (the only one readable here).
 */
export async function handleSetInitiative(
  args: { combatantId: string; initiative: number; combatId?: string },
  foundryClient: FoundryClient,
) {
  const { combatantId, initiative, combatId } = args;

  if (!combatantId || typeof combatantId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'combatantId is required and must be a string');
  }
  if (typeof initiative !== 'number' || !Number.isFinite(initiative)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'initiative is required and must be a finite number',
    );
  }

  const activeCombat = foundryClient.getCombatState();
  const resolvedCombatId = combatId ?? activeCombat?._id;
  if (!resolvedCombatId) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'No active combat and no combatId provided; cannot set initiative.',
    );
  }

  // Only the active combat is readable from the world-data cache, so only its
  // turn order can be recomputed. Capture who is acting BEFORE the write.
  const combat = activeCombat?._id === resolvedCombatId ? activeCombat : undefined;
  const acting = combat ? getCurrentCombatant(combat) : undefined;

  return withToolError('set combatant initiative', async () => {
    await foundryClient.setCombatantInitiative(resolvedCombatId, combatantId, initiative);

    let reanchored = '';
    if (combat && acting) {
      const turn = turnIndexAfterInitiativeChange(combat, { combatantId, initiative }, acting._id);
      if (turn !== undefined && turn !== combat.turn) {
        await foundryClient.updateCombat(resolvedCombatId, { turn });
        reanchored = `
**Still acting:** ${combatantName(acting, combat, foundryClient)} (turn ${turn + 1} of ${combat.combatants.length})`;
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: `⚔️ **Initiative Set**
**Combat:** ${resolvedCombatId}
**Combatant:** ${combatantId}
**Initiative:** ${initiative}${reanchored}`,
        },
      ],
    };
  });
}

/** How long start_combat waits for the cache to show a combat the module created. */
export const CACHED_COMBAT_WAIT_MS = 2000;
const CACHED_COMBAT_POLL_MS = 25;

/**
 * The sub-types the world's game system declares for `Combat` or
 * `Combatant`, other than `base`: from the world payload's `model` (what the
 * browsers build `game.documentTypes` from), else from its system manifest's
 * `documentTypes`. Such a system may define data of its own for them, which
 * only code loaded by the browsers fills in.
 */
export function declaredCombatTypes(world: WorldData | null): string[] {
  if (!world) {
    return [];
  }
  const typesOf = (documentName: string): string[] => {
    const fromModel = isRecord(world.model) ? world.model[documentName] : undefined;
    if (isRecord(fromModel)) {
      return Object.keys(fromModel);
    }
    const manifestTypes = isRecord(world.system) ? world.system.documentTypes : undefined;
    const fromManifest = isRecord(manifestTypes) ? manifestTypes[documentName] : undefined;
    return isRecord(fromManifest) ? Object.keys(fromManifest) : [];
  };
  return [...new Set([...typesOf('Combat'), ...typesOf('Combatant')])].filter(
    (type) => type !== 'base',
  );
}

/**
 * Waits, up to {@link CACHED_COMBAT_WAIT_MS}, for the cache to show a combat
 * the module created, begun and with its combatants. The module answers once
 * its own page has the combat; FoundryVTT broadcasts it to the connector's
 * socket at the same time, but nothing orders the two.
 *
 * Logs one info line with the time waited and the number of polls (waits of
 * {@link CACHED_COMBAT_POLL_MS}): 0 polls means the cache already had it.
 *
 * @returns false when the time ran out first
 */
async function waitForCachedCombat(
  foundryClient: FoundryClient,
  combatId: string,
  combatantCount: number,
): Promise<boolean> {
  const started = Date.now();
  const deadline = started + CACHED_COMBAT_WAIT_MS;
  for (let polls = 0; ; polls++) {
    const combat = foundryClient.getWorldData()?.combats.find((c) => c._id === combatId);
    const cached =
      combat !== undefined && combat.round >= 1 && combat.combatants.length >= combatantCount;
    if (cached || Date.now() >= deadline) {
      logger.info(
        `combat ${combatId} ${cached ? 'in' : 'not yet in'} the cache after ${Date.now() - started} ms (${polls} polls)${cached ? '' : '; answered with a note'}`,
      );
      return cached;
    }
    await new Promise((resolve) => setTimeout(resolve, CACHED_COMBAT_POLL_MS));
  }
}

/** What the module's create_combat answered. */
interface ModuleCombat {
  combatId: string;
  combatantIds: string[];
  incomplete?: string;
}

function parseModuleCombat(outcome: unknown): ModuleCombat {
  if (
    !isRecord(outcome) ||
    typeof outcome.combatId !== 'string' ||
    !Array.isArray(outcome.combatantIds) ||
    !outcome.combatantIds.every((id) => typeof id === 'string') ||
    (outcome.incomplete !== undefined && typeof outcome.incomplete !== 'string')
  ) {
    throw new McpError(
      ErrorCode.InternalError,
      'Module returned an unexpected create_combat shape',
    );
  }
  return {
    combatId: outcome.combatId,
    combatantIds: outcome.combatantIds,
    ...(outcome.incomplete !== undefined ? { incomplete: outcome.incomplete } : {}),
  };
}

function startedResult(
  combatId: string,
  scene: WorldScene,
  combatantCount: number,
  createdBy: string,
  note = '',
) {
  return {
    content: [
      {
        type: 'text',
        text: `⚔️ **Combat Started**
**Encounter:** ${combatId}
**Scene:** ${scene.name} (${scene._id})
**Combatants:** ${combatantCount}
**Created by:** ${createdBy}${note}`,
      },
    ],
  };
}

/**
 * Starts a new combat encounter, seeding combatants from tokens (FR-018, laurigates/foundryvtt-mcp#172).
 *
 * Resolves the target scene (explicit `sceneId`, else the active scene), then
 * builds combatant seeds from the requested `tokenIds` (or every token on the
 * scene when none are given).
 *
 * With writes enabled and a companion module that serves `create_combat`
 * (0.7.0 or later; FoundryCore waited for one on its way), the module creates
 * and begins the combat in the headless GM page, so the game system prepares
 * it. Otherwise the client creates it over the socket; when the world's game
 * system declares combat sub-types ({@link declaredCombatTypes}), the
 * open browsers reject that combat until each user reloads, and the answer
 * says so.
 */
export async function handleStartCombat(
  args: { tokenIds?: string[]; sceneId?: string },
  foundryClient: FoundryClient,
  moduleBridge: ModuleBridge | null = null,
) {
  const { tokenIds, sceneId } = args ?? {};

  const scenes = foundryClient.getScenes();
  const scene: WorldScene | undefined = sceneId
    ? scenes.find((s) => s._id === sceneId)
    : scenes.find((s) => s.active);

  if (!scene) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      sceneId
        ? `Scene not found: ${sceneId}`
        : 'No active scene to start combat on; provide a sceneId.',
    );
  }

  const sceneTokens = scene.tokens ?? [];
  const tokenIdOf = (t: Record<string, unknown>): string | undefined =>
    typeof t._id === 'string' ? t._id : undefined;
  const actorIdOf = (t: Record<string, unknown>): string | undefined =>
    typeof t.actorId === 'string' ? t.actorId : undefined;

  const seeds: CombatantSeed[] = [];
  if (tokenIds && tokenIds.length > 0) {
    for (const id of tokenIds) {
      const token = sceneTokens.find((t) => tokenIdOf(t) === id);
      if (!token) {
        throw new McpError(ErrorCode.InvalidParams, `Token not found on scene ${scene._id}: ${id}`);
      }
      seeds.push({ tokenId: id, sceneId: scene._id, actorId: actorIdOf(token) });
    }
  } else {
    for (const t of sceneTokens) {
      const id = tokenIdOf(t);
      if (id) {
        seeds.push({ tokenId: id, sceneId: scene._id, actorId: actorIdOf(t) });
      }
    }
  }

  return withToolError('start combat', async () => {
    const writeEnabled = foundryClient.isWriteEnabled();
    if (writeEnabled && moduleBridge?.supports('create_combat')) {
      const created = parseModuleCombat(
        await moduleBridge.send('create_combat', {
          sceneId: scene._id,
          combatants: seeds.map(({ tokenId, actorId }) => ({
            tokenId,
            ...(actorId ? { actorId } : {}),
          })),
        }),
      );
      if (created.incomplete !== undefined) {
        throw new Error(
          `Combat ${created.combatId} was created on scene ${scene.name} (${scene._id}), but ${created.incomplete}. It was left in place; end_combat removes it.`,
        );
      }
      const cached = await waitForCachedCombat(
        foundryClient,
        created.combatId,
        created.combatantIds.length,
      );
      return startedResult(
        created.combatId,
        scene,
        created.combatantIds.length,
        'the companion module (the game system prepared it)',
        cached
          ? ''
          : `\n\n⚠️ The connector's cache had not caught up with this combat after ${CACHED_COMBAT_WAIT_MS / 1000} s; get_combat_state may show it a moment later.`,
      );
    }

    // Writes disabled: the socket path below turns the call down as every write does.
    const declared = writeEnabled ? declaredCombatTypes(foundryClient.getWorldData()) : [];
    const { combatId, combatantCount } = await foundryClient.startCombat(scene._id, seeds);
    return startedResult(
      combatId,
      scene,
      combatantCount,
      'the socket',
      declared.length > 0
        ? `\n\n⚠️ This world's game system defines its own combat data (types: ${declared.join(', ')}), which only the companion module 0.7.0 or later can create. Created without it, the combat is rejected by open browsers until each user reloads FoundryVTT (F5); later updates then show live.`
        : '',
    );
  });
}
