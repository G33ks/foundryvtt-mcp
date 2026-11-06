/**
 * @fileoverview In-memory, cursor-addressed log of world activity.
 *
 * `world-cache.ts` consumes every `modifyDocument` broadcast to keep the cached
 * snapshot current, then discards the fact that anything happened. That left an
 * agent with no way to learn about a player's action except to re-poll
 * `get_chat_messages` / `get_combat_state` in a loop and diff the results.
 *
 * This module keeps the *notification* alongside the cache update: each
 * broadcast is summarized into one {@link WorldEvent} and appended to a bounded
 * ring. Readers address the ring by an opaque monotonic cursor and may block on
 * {@link WorldEventLog.wait} until something new lands, so waiting costs one
 * suspended request instead of N polling round-trips.
 *
 * Pure logic by design — no socket, no IO, no imports from `client.ts`. Mirrors
 * the layering of `world-cache.ts` so both are testable against plain objects.
 */

import { isRecord } from '../utils/guards.js';
import { stripHtml } from '../utils/sanitize.js';
import { messageAuthorId } from './message-author.js';
import type { WorldData } from './types.js';
import type { DocumentBroadcast } from './world-cache.js';

/** Origin category of a recorded event. */
export type WorldEventKind = 'document' | 'presence' | 'target';

/** Longest chat excerpt carried in a summary line, in characters. */
const MAX_SUMMARY_TEXT = 200;

/** One thing that happened in the world. */
export interface WorldEvent {
  /** Monotonic, 1-based, never reused for the life of the process. */
  seq: number;
  /** `Date.now()` at record time. */
  at: number;
  kind: WorldEventKind;
  /** Document name for kind `document` ("Token", "ChatMessage", …); `''` otherwise. */
  type: string;
  /**
   * `create` | `update` | `delete` for documents, `active` | `inactive` for
   * presence, `target` | `untarget` for targeting.
   */
  action: string;
  /** Originating Foundry user id, when the source carried one. */
  userId?: string;
  /** Scene id, when derivable. */
  sceneId?: string;
  /** Affected document ids. */
  ids: string[];
  /** One-line human-readable summary — the field an agent actually reads. */
  summary: string;
  /**
   * Changed fields (updates) or created-document highlights (creates).
   * Deliberately not the whole document: a full actor would swamp the reader's
   * context for no gain. Omitted when empty.
   */
  data?: Record<string, unknown>;
}

/** Server-side filter applied while reading. All conditions AND together. */
export interface EventFilter {
  kinds?: string[];
  /** Document names, matched case-insensitively. */
  types?: string[];
  actions?: string[];
  sceneId?: string;
  /**
   * When set, events whose `userId` equals this are dropped.
   *
   * An event with **no** `userId` always passes: some Foundry builds and some
   * actions omit the field, and silently hiding real world activity is far
   * worse than occasionally echoing back one of our own writes.
   */
  excludeUserId?: string;
}

/** Outcome of a {@link WorldEventLog.read}. */
export interface EventReadResult {
  events: WorldEvent[];
  /** Cursor to pass to the next read to continue without gaps or repeats. */
  nextCursor: number;
  /** Events evicted from the ring before the caller's cursor. 0 when none lost. */
  dropped: number;
  /** True when `limit` truncated the result and more matches are already buffered. */
  more: boolean;
}

interface Waiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Bounded ring of {@link WorldEvent}s with cursor reads and long-poll waits.
 *
 * Sequence numbers are assigned by the log and never reused, so a cursor stays
 * meaningful even after the events it pointed at have been evicted — that is
 * how {@link EventReadResult.dropped} can report a gap rather than silently
 * skipping it.
 */
export class WorldEventLog {
  private readonly capacity: number;
  private readonly events: WorldEvent[] = [];
  private waiters: Waiter[] = [];
  private nextSeq = 1;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  /**
   * Appends an event, evicting the oldest once over capacity, and wakes every
   * pending waiter.
   *
   * @returns The sequence number assigned to the new event.
   */
  append(event: Omit<WorldEvent, 'seq' | 'at'>): number {
    const seq = this.nextSeq++;
    this.events.push({ ...event, seq, at: Date.now() });
    while (this.events.length > this.capacity) {
      this.events.shift();
    }
    this.wakeAll();
    return seq;
  }

  /** Sequence number of the newest event; 0 when empty. */
  head(): number {
    return this.nextSeq - 1;
  }

  /** Sequence number of the oldest retained event; 0 when empty. */
  oldest(): number {
    return this.events.length > 0 ? (this.events[0]?.seq ?? 0) : 0;
  }

  /** Number of events currently retained. */
  size(): number {
    return this.events.length;
  }

  /**
   * Returns matching events newer than `afterSeq`, capped at `limit`.
   *
   * `nextCursor` is `head()` on a complete read but the last returned event's
   * `seq` on a truncated one. Both halves matter: returning `head()` after
   * truncation would skip the matches that did not fit, while returning the
   * last match every time would make a caller whose filter excludes recent
   * traffic re-scan the same non-matching events on every call.
   */
  read(afterSeq: number, filter: EventFilter, limit: number): EventReadResult {
    const cap = Math.max(1, Math.floor(limit));
    const oldest = this.oldest();

    // Events between the caller's cursor and the oldest retained event have
    // been evicted. Report the size of that hole so the caller knows its view
    // of the world is incomplete rather than merely quiet.
    let dropped = 0;
    let from = afterSeq;
    if (afterSeq > 0 && oldest > 0 && afterSeq < oldest - 1) {
      dropped = oldest - 1 - afterSeq;
      from = oldest - 1;
    }

    const events: WorldEvent[] = [];
    let more = false;
    for (const event of this.events) {
      if (event.seq <= from) {
        continue;
      }
      if (!matchesFilter(event, filter)) {
        continue;
      }
      if (events.length >= cap) {
        more = true;
        break;
      }
      events.push(event);
    }

    const last = events.length > 0 ? events[events.length - 1] : undefined;
    const nextCursor = more && last ? last.seq : this.head();
    return { events, nextCursor, dropped, more };
  }

  /**
   * Resolves as soon as an event newer than `afterSeq` exists, or after
   * `timeoutMs`, whichever comes first. Never rejects.
   *
   * The up-front `head()` check is not an optimization: without it, an event
   * appended between a caller's `read` and its `wait` would already have woken
   * nobody, and the caller would block for the full timeout despite the news it
   * was waiting for having arrived.
   */
  wait(afterSeq: number, timeoutMs: number): Promise<void> {
    if (this.head() > afterSeq) {
      return Promise.resolve();
    }
    if (timeoutMs <= 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          resolve();
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** Resolves and clears every pending waiter, leaking no timers. */
  private wakeAll(): void {
    if (this.waiters.length === 0) {
      return;
    }
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }
}

function matchesFilter(event: WorldEvent, filter: EventFilter): boolean {
  if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (filter.types && filter.types.length > 0) {
    const wanted = filter.types.map((entry) => entry.toLowerCase());
    if (!wanted.includes(event.type.toLowerCase())) {
      return false;
    }
  }
  if (filter.actions && filter.actions.length > 0 && !filter.actions.includes(event.action)) {
    return false;
  }
  if (filter.sceneId && event.sceneId !== filter.sceneId) {
    return false;
  }
  // Absent userId passes deliberately — see EventFilter.excludeUserId.
  if (filter.excludeUserId && event.userId === filter.excludeUserId) {
    return false;
  }
  return true;
}

/** Truncates to {@link MAX_SUMMARY_TEXT}, marking that it was cut. */
function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SUMMARY_TEXT ? `${flat.slice(0, MAX_SUMMARY_TEXT)}…` : flat;
}

/** Extracts the scene id a broadcast pertains to, if any. */
function resolveSceneId(
  broadcast: DocumentBroadcast,
  docs: Record<string, unknown>[],
): string | undefined {
  const match = broadcast.parentUuid?.match(/^Scene\.([a-zA-Z0-9]+)/);
  if (match) {
    return match[1];
  }
  if (broadcast.type === 'Scene') {
    const id = docs[0]?._id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

function userName(worldData: WorldData | null, userId: string | undefined): string | undefined {
  if (!userId || !worldData) {
    return undefined;
  }
  return worldData.users?.find((user) => user._id === userId)?.name;
}

function actorName(worldData: WorldData | null, actorId: string | undefined): string | undefined {
  if (!actorId || !worldData) {
    return undefined;
  }
  return worldData.actors?.find((actor) => actor._id === actorId)?.name;
}

/**
 * Renders one `modifyDocument` broadcast as a {@link WorldEvent}.
 *
 * `worldData` is consulted only for cheap id→name lookups so summaries read as
 * "Token Goblin moved" rather than "Token aBcDeFgHiJkLmNoP moved"; a null
 * snapshot degrades to ids and never fails.
 */
export function summarizeDocumentBroadcast(
  broadcast: DocumentBroadcast,
  worldData: WorldData | null,
): Omit<WorldEvent, 'seq' | 'at'> {
  const docs = broadcast.result.filter(isRecord);

  const ids =
    broadcast.action === 'delete'
      ? broadcast.result.filter((entry): entry is string => typeof entry === 'string')
      : docs.map((doc) => doc._id).filter((id): id is string => typeof id === 'string');

  const first = docs[0];
  // Foundry sends update payloads as diffs, so the payload's own keys *are*
  // the changed set — no comparison against the cache is needed.
  const changed = first ? Object.keys(first).filter((key) => key !== '_id') : [];

  let data: Record<string, unknown> | undefined;
  if (first && broadcast.action === 'update') {
    data = {};
    for (const key of changed) {
      data[key] = first[key];
    }
  } else if (first && broadcast.action === 'create') {
    const highlights: Record<string, unknown> = {};
    if (typeof first.name === 'string') {
      highlights.name = first.name;
    }
    if (typeof first.type === 'string' || typeof first.type === 'number') {
      highlights.type = first.type;
    }
    if (Object.keys(highlights).length > 0) {
      data = highlights;
    }
  }
  if (data && Object.keys(data).length === 0) {
    data = undefined;
  }

  const event: Omit<WorldEvent, 'seq' | 'at'> = {
    kind: 'document',
    type: broadcast.type,
    action: broadcast.action,
    ids,
    summary: '',
    ...(broadcast.userId ? { userId: broadcast.userId } : {}),
  };

  const sceneId = resolveSceneId(broadcast, docs);
  if (sceneId) {
    event.sceneId = sceneId;
  }
  if (data) {
    event.data = data;
  }

  event.summary = renderSummary(broadcast, first, changed, ids, worldData);
  return event;
}

function renderSummary(
  broadcast: DocumentBroadcast,
  first: Record<string, unknown> | undefined,
  changed: string[],
  ids: string[],
  worldData: WorldData | null,
): string {
  const { type, action } = broadcast;
  const name = first && typeof first.name === 'string' ? first.name : undefined;

  if (type === 'ChatMessage' && action === 'create' && first) {
    const speaker = isRecord(first.speaker) ? first.speaker : undefined;
    const alias = speaker && typeof speaker.alias === 'string' ? speaker.alias : undefined;
    const author =
      alias ?? userName(worldData, messageAuthorId(first) ?? broadcast.userId) ?? 'Unknown';
    const raw = typeof first.content === 'string' ? first.content : '';
    const text = truncate(stripHtml(raw));
    const flavor = typeof first.flavor === 'string' ? truncate(stripHtml(first.flavor)) : '';
    const body = text || flavor || '(no text)';
    return `💬 ${author}: ${body}`;
  }

  if (type === 'Token' && action === 'update' && first) {
    const label = name ?? ids[0] ?? 'unknown';
    if (typeof first.x === 'number' || typeof first.y === 'number') {
      return `🧙 Token ${label} → (${String(first.x ?? '?')}, ${String(first.y ?? '?')})`;
    }
    return `🧙 Token ${label}: ${changed.join(', ') || 'updated'}`;
  }

  if (type === 'Actor' && action === 'update') {
    const label = name ?? actorName(worldData, ids[0]) ?? ids[0] ?? 'unknown';
    return `🎭 Actor ${label}: ${changed.join(', ') || 'updated'}`;
  }

  if (type === 'Combat' && action === 'update' && first) {
    const parts: string[] = [];
    if (first.round !== undefined) {
      parts.push(`round ${String(first.round)}`);
    }
    if (first.turn !== undefined) {
      parts.push(`turn ${String(first.turn)}`);
    }
    return `⚔️ Combat ${parts.length > 0 ? parts.join(', ') : changed.join(', ') || 'updated'}`;
  }

  if (type === 'ActiveEffect' && (action === 'create' || action === 'delete')) {
    const label = name ?? ids[0] ?? 'unknown';
    const where = broadcast.parentUuid ?? 'unknown';
    return `✨ Effect ${label} ${action === 'create' ? 'applied to' : 'removed from'} ${where}`;
  }

  if (type === 'Wall' && action === 'update' && first && first.ds !== undefined) {
    return `🚪 Door ${ids[0] ?? 'unknown'} state → ${String(first.ds)}`;
  }

  const label = name ? `${name} (${ids.join(', ')})` : ids.join(', ') || 'unknown';
  return `📄 ${action} ${type} ${label}`;
}
