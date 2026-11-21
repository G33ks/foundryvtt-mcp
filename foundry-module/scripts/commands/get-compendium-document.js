import { CommandRefusal } from '../refusal.js';

/**
 * Retrieves a full document from a compendium pack. A pack or document that
 * does not exist is a refusal (`not-found`).
 *
 * @param {{ packId: string; documentId: string }} params
 */
export async function getCompendiumDocument(params) {
  const { packId, documentId } = params;
  if (!packId || !documentId) {
    throw new Error('packId and documentId are required');
  }
  const pack = game.packs.get(packId);
  if (!pack) {
    throw new CommandRefusal('not-found', `Pack not found: ${packId}`);
  }
  const doc = await pack.getDocument(documentId);
  if (!doc) {
    throw new CommandRefusal('not-found', `Document not found in ${packId}: ${documentId}`);
  }
  return doc.toObject();
}
