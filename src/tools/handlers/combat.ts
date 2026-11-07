/**
 * Combat state tool handler
 */

import type { FoundryClient } from '../../foundry/client.js';
import type { WorldCombat } from '../../foundry/types.js';
import { getTurnOrder, type WorldCombatant } from './combat-order.js';
import { withToolError } from './utils.js';

/**
 * A combatant's display name. v14 leaves `Combatant.name` empty unless it was
 * set explicitly (the UI falls back to the token), so do the same: the
 * combatant's own name, then its token's, then its actor's.
 */
export function combatantName(
  c: WorldCombatant,
  combat: WorldCombat,
  foundryClient: FoundryClient,
): string {
  if (c.name) {
    return c.name;
  }
  const sceneId = combatantSceneId(c, combat);
  const token = c.tokenId ? foundryClient.findToken(c.tokenId, sceneId)?.token : undefined;
  if (token && typeof token.name === 'string' && token.name) {
    return token.name;
  }
  const actor = c.actorId ? foundryClient.getRawActor(c.actorId) : undefined;
  return actor?.name ?? 'Unknown combatant';
}

function combatantSceneId(c: WorldCombatant, combat: WorldCombat): string | undefined {
  const own = (c as { sceneId?: string }).sceneId;
  return own ?? (combat as { scene?: string }).scene ?? undefined;
}

/**
 * " HP: v/max AC: n" for a combatant, read from its token's own actor so each
 * unlinked copy of a monster shows its own HP. AC is left out when absent.
 */
function combatantHpAc(
  c: WorldCombatant,
  combat: WorldCombat,
  foundryClient: FoundryClient,
): string {
  const sceneId = combatantSceneId(c, combat);
  const system = c.tokenId
    ? foundryClient.getTokenActorSystem(c.tokenId, sceneId)
    : c.actorId
      ? (foundryClient.getRawActor(c.actorId)?.system as Record<string, unknown> | undefined)
      : undefined;
  const attributes = system?.attributes as Record<string, unknown> | undefined;
  const hpData = attributes?.hp as { value?: number; max?: number } | undefined;
  const acData = attributes?.ac as { value?: number } | undefined;
  let text = '';
  if (hpData) {
    text += ` HP: ${hpData.value ?? '?'}/${hpData.max ?? '?'}`;
  }
  const ac = acData?.value;
  if (ac !== undefined && ac !== null) {
    text += ` AC: ${ac}`;
  }
  return text;
}

export async function handleGetCombatState(
  _args: Record<string, unknown>,
  foundryClient: FoundryClient,
) {
  return withToolError('get combat state', async () => {
    const combat = foundryClient.getCombatState();

    if (!combat) {
      return {
        content: [{ type: 'text', text: 'No active combat encounter.' }],
      };
    }

    // `combat` is a live reference into the world-data cache: sort a COPY via
    // the shared helper so a read never reorders cached state (laurigates/foundryvtt-mcp#214). The same
    // helper backs `next_turn`, so both tools agree on what `combat.turn` means.
    const combatants = getTurnOrder(combat)
      .map((c, i) => {
        const current = combat.turn === i ? ' <-- CURRENT' : '';
        const status = c.defeated ? ' [DEFEATED]' : c.hidden ? ' [HIDDEN]' : '';
        const init = c.initiative !== null ? c.initiative.toString() : '?';

        const hpAc = combatantHpAc(c, combat, foundryClient);
        const token = c.tokenId ? ` (token ${c.tokenId})` : '';

        return `${i + 1}. [${init}] **${combatantName(c, combat, foundryClient)}**${token}${hpAc}${status}${current}`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `**Active Combat** — Round ${combat.round}\n\n${combatants}`,
        },
      ],
    };
  });
}
