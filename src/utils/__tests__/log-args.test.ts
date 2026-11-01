import { describe, expect, it } from 'vitest';
import { redactToolArgs } from '../log-args.js';

describe('redactToolArgs', () => {
  it('replaces page and chat content with its length, keeping ids and short parameters', () => {
    expect(
      redactToolArgs({
        journalId: '0123456789abcdef',
        pageId: 'fedcba9876543210',
        mode: 'append',
        expectedVersion: 'abcdef012345',
        content: '<p>The party arrived in Terris.</p>',
      }),
    ).toEqual({
      journalId: '0123456789abcdef',
      pageId: 'fedcba9876543210',
      mode: 'append',
      expectedVersion: 'abcdef012345',
      content: '<35 chars>',
    });
  });

  it('reaches content nested in arrays of objects', () => {
    expect(
      redactToolArgs({
        name: 'Session 12',
        pages: [
          { name: 'Recap', content: 'secret plot' },
          { name: 'Loot', content: '' },
        ],
      }),
    ).toEqual({
      name: 'Session 12',
      pages: [
        { name: 'Recap', content: '<11 chars>' },
        { name: 'Loot', content: '<0 chars>' },
      ],
    });
  });

  it('covers the other content-bearing arguments', () => {
    expect(
      redactToolArgs({
        text: 'roll result text',
        description: 'a long lore paragraph',
        flavor: 'It bites!',
        command: 'game.actors.forEach(…)',
        whisperTo: ['gamemaster000001'],
      }),
    ).toEqual({
      text: '<16 chars>',
      description: '<21 chars>',
      flavor: '<9 chars>',
      command: '<22 chars>',
      whisperTo: ['gamemaster000001'],
    });
  });

  it('treats any very long string as content', () => {
    const data = 'A'.repeat(5000);
    expect(redactToolArgs({ filename: 'map.webp', data })).toEqual({
      filename: 'map.webp',
      data: '<5000 chars>',
    });
  });

  it('leaves numbers, booleans and null alone and does not mutate its input', () => {
    const args = { x: 3, raw: true, folder: null, content: 'abc' };
    expect(redactToolArgs(args)).toEqual({ x: 3, raw: true, folder: null, content: '<3 chars>' });
    expect(args.content).toBe('abc');
  });
});
