/**
 * @fileoverview Who wrote a chat message.
 *
 * FoundryVTT stores the author of a chat message in `author` since v12
 * (v14: common/documents/chat-message.mjs,
 * `author: new fields.DocumentAuthorField(documents.BaseUser)`); `user` is
 * its earlier name, kept for messages from older data (G33ks/foundryvtt-mcp#13).
 */

/** The id of the user who wrote `message`: `author`, else `user`; `undefined` when neither is a string. */
export function messageAuthorId(message: { author?: unknown; user?: unknown }): string | undefined {
  if (typeof message.author === 'string' && message.author !== '') {
    return message.author;
  }
  if (typeof message.user === 'string' && message.user !== '') {
    return message.user;
  }
  return undefined;
}
