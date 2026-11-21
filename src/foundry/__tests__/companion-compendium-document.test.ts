/**
 * @fileoverview The companion module's `get_compendium_document` command run
 * under Node against a stand-in `game.packs`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCompendiumDocument } from '../../../foundry-module/scripts/commands/get-compendium-document.js';
import { CommandRefusal } from '../../../foundry-module/scripts/refusal.js';

const PACK = 'world.creatures';
const DOCUMENT = 'documentDDDDDDDD';

function stubPacks() {
  vi.stubGlobal('game', {
    packs: new Map([
      [
        PACK,
        {
          getDocument: async (id: string) =>
            id === DOCUMENT ? { toObject: () => ({ _id: DOCUMENT, name: 'Wolf' }) } : null,
        },
      ],
    ]),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('get_compendium_document module command', () => {
  it('returns the document', async () => {
    stubPacks();
    await expect(getCompendiumDocument({ packId: PACK, documentId: DOCUMENT })).resolves.toEqual({
      _id: DOCUMENT,
      name: 'Wolf',
    });
  });

  it('refuses a pack or a document that does not exist', async () => {
    stubPacks();
    const noPack = getCompendiumDocument({ packId: 'world.none', documentId: DOCUMENT });
    await expect(noPack).rejects.toThrow('Pack not found: world.none');
    await expect(noPack).rejects.toMatchObject({ name: 'CommandRefusal', code: 'not-found' });

    const noDocument = getCompendiumDocument({ packId: PACK, documentId: 'missingMMMMMMMMM' });
    await expect(noDocument).rejects.toThrow(`Document not found in ${PACK}: missingMMMMMMMMM`);
    await expect(noDocument).rejects.toMatchObject({ code: 'not-found' });
  });

  it('fails without a pack or a document id, which is not a refusal', async () => {
    stubPacks();
    const failure = getCompendiumDocument({ packId: PACK });
    await expect(failure).rejects.toThrow('packId and documentId are required');
    await expect(failure).rejects.not.toBeInstanceOf(CommandRefusal);
  });
});
