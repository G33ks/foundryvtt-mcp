/**
 * @fileoverview Tests for the world-event ring buffer backing `watch_events`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { summarizeDocumentBroadcast, WorldEventLog } from '../event-log.js';
import type { WorldData } from '../types.js';
import type { DocumentBroadcast } from '../world-cache.js';

function makeEvent(overrides: Partial<Parameters<WorldEventLog['append']>[0]> = {}) {
  return {
    kind: 'document' as const,
    type: 'Actor',
    action: 'update',
    ids: ['actorAAAAAAAAAAA'],
    summary: 'test event',
    ...overrides,
  };
}

describe('WorldEventLog — append/head/oldest', () => {
  it('assigns 1-based increasing sequence numbers', () => {
    const log = new WorldEventLog(10);
    expect(log.head()).toBe(0);
    expect(log.oldest()).toBe(0);

    const first = log.append(makeEvent());
    const second = log.append(makeEvent());
    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(log.head()).toBe(2);
    expect(log.oldest()).toBe(1);
  });

  it('evicts the oldest event past capacity', () => {
    const log = new WorldEventLog(3);
    for (let i = 0; i < 5; i++) {
      log.append(makeEvent());
    }
    expect(log.size()).toBe(3);
    expect(log.oldest()).toBe(3);
    expect(log.head()).toBe(5);
  });
});

describe('WorldEventLog — read', () => {
  it('reports the exact dropped count for a stale cursor', () => {
    const log = new WorldEventLog(3);
    for (let i = 0; i < 5; i++) {
      log.append(makeEvent());
    }
    // Capacity 3 retains seq 3-5 (oldest() === 3). A cursor of 1 once pointed
    // at a real position — seq 2 — that has since been evicted, so exactly
    // one event (seq 2) is reported dropped.
    const result = log.read(1, {}, 50);
    expect(result.dropped).toBe(1);
    expect(result.events.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('reports zero dropped for cursor 0 even after eviction (0 means "from the start")', () => {
    const log = new WorldEventLog(3);
    for (let i = 0; i < 5; i++) {
      log.append(makeEvent());
    }
    const result = log.read(0, {}, 50);
    expect(result.dropped).toBe(0);
    expect(result.events.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('sets nextCursor to head() on a complete read', () => {
    const log = new WorldEventLog(10);
    log.append(makeEvent());
    log.append(makeEvent());
    const result = log.read(0, {}, 50);
    expect(result.more).toBe(false);
    expect(result.nextCursor).toBe(log.head());
    expect(result.nextCursor).toBe(2);
  });

  it('sets nextCursor to the last returned event on a truncated read', () => {
    const log = new WorldEventLog(10);
    log.append(makeEvent());
    log.append(makeEvent());
    log.append(makeEvent());
    const result = log.read(0, {}, 2);
    expect(result.more).toBe(true);
    expect(result.events).toHaveLength(2);
    expect(result.nextCursor).toBe(2);
    expect(result.nextCursor).not.toBe(log.head());
  });

  it('filters by type case-insensitively', () => {
    const log = new WorldEventLog(10);
    log.append(makeEvent({ type: 'Token' }));
    log.append(makeEvent({ type: 'ChatMessage' }));
    const result = log.read(0, { types: ['chatmessage'] }, 50);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.type).toBe('ChatMessage');
  });

  it('filters by action', () => {
    const log = new WorldEventLog(10);
    log.append(makeEvent({ action: 'create' }));
    log.append(makeEvent({ action: 'delete' }));
    const result = log.read(0, { actions: ['delete'] }, 50);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.action).toBe('delete');
  });

  it('filters by sceneId', () => {
    const log = new WorldEventLog(10);
    log.append(makeEvent({ sceneId: 'sceneAAAAAAAAAAA' }));
    log.append(makeEvent({ sceneId: 'sceneBBBBBBBBBBB' }));
    const result = log.read(0, { sceneId: 'sceneBBBBBBBBBBB' }, 50);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.sceneId).toBe('sceneBBBBBBBBBBB');
  });

  it('drops events matching excludeUserId but keeps events with no userId', () => {
    const log = new WorldEventLog(10);
    log.append(makeEvent({ userId: 'user0000user0000' }));
    log.append(makeEvent({ userId: 'user0001user0001' }));
    log.append(makeEvent());
    const result = log.read(0, { excludeUserId: 'user0000user0000' }, 50);
    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => e.userId)).toEqual(['user0001user0001', undefined]);
  });
});

describe('WorldEventLog — wait', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when head() already exceeds afterSeq (no lost wakeup)', async () => {
    const log = new WorldEventLog(10);
    log.append(makeEvent());
    // head() is already 1: an implementation missing the up-front check would
    // register a waiter instead and hang until the 5000ms timeout, failing
    // this test on vitest's own default timeout rather than a guessed delay.
    await expect(log.wait(0, 5000)).resolves.toBeUndefined();
  });

  it('resolves when an event is appended while waiting', async () => {
    const log = new WorldEventLog(10);
    const waitPromise = log.wait(0, 5000);
    log.append(makeEvent());
    await expect(waitPromise).resolves.toBeUndefined();
  });

  it('resolves on timeout when nothing is appended', () => {
    vi.useFakeTimers();
    const log = new WorldEventLog(10);
    const waitPromise = log.wait(0, 1000);
    let resolved = false;
    waitPromise.then(() => {
      resolved = true;
    });
    vi.advanceTimersByTime(999);
    expect(resolved).toBe(false);
    vi.advanceTimersByTime(2);
    return waitPromise.then(() => {
      expect(resolved).toBe(true);
    });
  });
});

const baseWorldData = { userId: 'user0000user0000', users: [], actors: [] } as unknown as WorldData;

function broadcast(overrides: Partial<DocumentBroadcast> = {}): DocumentBroadcast {
  return {
    type: 'ChatMessage',
    action: 'create',
    result: [{ _id: 'msgAAAAAAAAAAAAA' }],
    ...overrides,
  };
}

describe('summarizeDocumentBroadcast', () => {
  it('renders a ChatMessage create with HTML stripped', () => {
    const event = summarizeDocumentBroadcast(
      broadcast({
        result: [
          {
            _id: 'msgAAAAAAAAAAAAA',
            content: '<p>I kick the <b>door</b> open</p>',
            speaker: { alias: 'Alice' },
          },
        ],
      }),
      baseWorldData,
    );
    expect(event.summary).toBe('💬 Alice: I kick the door open');
    expect(event.kind).toBe('document');
  });

  it('renders a Token update with coordinates', () => {
    const event = summarizeDocumentBroadcast(
      broadcast({
        type: 'Token',
        action: 'update',
        result: [{ _id: 'tokenAAAAAAAAAA', name: 'Goblin', x: 600, y: 500 }],
        parentUuid: 'Scene.sceneAAAAAAAAAAA',
      }),
      baseWorldData,
    );
    expect(event.summary).toBe('🧙 Token Goblin → (600, 500)');
    expect(event.sceneId).toBe('sceneAAAAAAAAAAA');
  });

  it('falls back for an unmodelled type', () => {
    const event = summarizeDocumentBroadcast(
      broadcast({
        type: 'Cards',
        action: 'update',
        result: [{ _id: 'cardsAAAAAAAAAA', someField: 1 }],
      }),
      baseWorldData,
    );
    expect(event.summary).toContain('update Cards');
  });

  describe('ChatMessage author (G33ks/foundryvtt-mcp#13)', () => {
    const world = {
      ...baseWorldData,
      users: [
        { _id: 'gmUser0000000001', name: 'Gamemaster' },
        { _id: 'mcpUser000000001', name: 'mcp-api' },
      ],
    } as unknown as WorldData;
    const chat = (fields: Record<string, unknown>, userId?: string) =>
      summarizeDocumentBroadcast(
        broadcast({
          result: [{ _id: 'msgAAAAAAAAAAAAA', content: '<p>hi</p>', ...fields }],
          ...(userId ? { userId } : {}),
        }),
        world,
      ).summary;

    it('reads `author`, then the older `user`, then whoever sent the broadcast', () => {
      expect(chat({ author: 'mcpUser000000001' }, 'gmUser0000000001')).toBe('💬 mcp-api: hi');
      expect(chat({ user: 'gmUser0000000001' })).toBe('💬 Gamemaster: hi');
      expect(chat({}, 'gmUser0000000001')).toBe('💬 Gamemaster: hi');
    });

    it('says Unknown when nothing names a user', () => {
      expect(chat({})).toBe('💬 Unknown: hi');
    });
  });
});
