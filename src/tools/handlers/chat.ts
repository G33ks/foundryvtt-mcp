/**
 * Chat message tool handler
 */

import type { FoundryClient } from '../../foundry/client.js';
import { messageAuthorId } from '../../foundry/message-author.js';
import { stripHtml } from '../../utils/sanitize.js';
import { withToolError } from './utils.js';

export async function handleGetChatMessages(
  args: { limit?: number },
  foundryClient: FoundryClient,
) {
  return withToolError('get chat messages', async () => {
    const limit = Math.min(args.limit ?? 20, 100);
    const messages = foundryClient.getChatMessages(limit);

    if (messages.length === 0) {
      return {
        content: [{ type: 'text', text: 'No chat messages found.' }],
      };
    }

    // Resolve user names from worldData
    const { users } = foundryClient.getUsers();
    const userMap = new Map(users.map((u) => [u._id, u.name]));

    const formatted = messages
      .map((m) => {
        const authorId = messageAuthorId(m);
        const speaker =
          m.speaker?.alias || (authorId ? userMap.get(authorId) : undefined) || 'Unknown';
        const time = new Date(m.timestamp).toLocaleTimeString();
        const content = stripHtml(m.content).trim().slice(0, 200);
        return `[${time}] **${speaker}**: ${content}`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `**Recent Chat Messages** (${messages.length})\n\n${formatted}`,
        },
      ],
    };
  });
}
