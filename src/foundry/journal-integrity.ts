/**
 * @fileoverview Journal page integrity: version tokens, text normalization and
 * the in-memory watch that detects a connector write being overwritten.
 *
 * Two ways a page write can be lost after the fact, both verified against the
 * FoundryVTT v14 source:
 *
 * - **A stale save** — someone saves an older copy of the page over ours. It
 *   arrives as an ordinary `modifyDocument` update broadcast carrying the
 *   author's `userId`.
 * - **A collaborative-editor autosave** — while a text page is open in an
 *   editor, the server holds its own in-memory copy of the page and writes it
 *   back every `core.editorAutosaveSecs` (60 s by default), even when nobody
 *   typed. A `modifyDocument` write never reaches that copy, so the autosave
 *   reverts it. The server saves the document directly (no `modifyDocument`
 *   broadcast) and only emits `pm.autosave(uuid, html)` — to every user,
 *   without saying who is editing.
 *
 * This module holds only pure logic and in-memory state; `FoundryClient`
 * feeds it socket events and performs the side effects (local copies,
 * logging, the GM whisper).
 */

import { createHash } from 'node:crypto';

/** How long a written page stays watched for an overwrite. */
export const WATCH_TTL_MS = 6 * 60 * 60 * 1000;
/** How recent a `pm.autosave` must be to warn that the page is open in an editor. */
export const RECENT_AUTOSAVE_MS = 10 * 60 * 1000;
/** How long detected conflicts stay listed by `get_health_status`. */
export const CONFLICT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Length of a page version token, in hex characters. */
const VERSION_LENGTH = 12;

/**
 * Version token of a page body: the first 12 hex characters of the SHA-256 of
 * `text.content` as stored by the server. It depends on the content only — not
 * on the page name, sort or ownership.
 */
export function journalVersion(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, VERSION_LENGTH);
}

/** Named entities worth decoding; anything else is left as-is. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  ndash: '–',
  mdash: '—',
  agrave: 'à',
  acirc: 'â',
  auml: 'ä',
  ccedil: 'ç',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  euml: 'ë',
  icirc: 'î',
  iuml: 'ï',
  ocirc: 'ô',
  ouml: 'ö',
  ugrave: 'ù',
  ucirc: 'û',
  uuml: 'ü',
  oelig: 'œ',
  Agrave: 'À',
  Acirc: 'Â',
  Ccedil: 'Ç',
  Eacute: 'É',
  Egrave: 'È',
  Ecirc: 'Ê',
  Icirc: 'Î',
  Ocirc: 'Ô',
  Ugrave: 'Ù',
  OElig: 'Œ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/** Tags whose start or end separates two blocks of text. */
const BLOCK_BOUNDARY =
  /<\/?(?:p|h[1-6]|li|div|br|ul|ol|blockquote|pre|table|tr|td|th|section|article|header|footer|hr)\b[^>]*>/gi;

/**
 * Splits page HTML into normalized blocks of text: tags removed, entities
 * decoded, whitespace collapsed, one entry per paragraph, heading, list item,
 * div or line break.
 *
 * Absorbs the rewrites the v14 server applies on save (`cleanHTML`: attribute
 * quoting, `<br/>` → `<br>`, named entities → characters, stripped tags and
 * attributes) and the different block markup a ProseMirror autosave produces.
 */
export function normalizeJournalHtml(html: string): string[] {
  if (!html) {
    return [];
  }
  // Raw newlines are plain whitespace in HTML; only block tags separate blocks.
  const separated = html
    .replace(/\0/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(BLOCK_BOUNDARY, '\0');
  return separated
    .split('\0')
    .map((block) =>
      decodeEntities(block.replace(/<[^>]*>/g, ''))
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((block) => block.length > 0);
}

/**
 * What a connector write added to a page: the normalized blocks it put there.
 *
 * - Append: the blocks of the appended fragment that the stored page actually
 *   contains (the server may strip part of the fragment — a block it dropped
 *   was never ours to lose).
 * - Replace: the blocks present after the write but not before it.
 */
export function journalContribution(params: {
  before: string;
  after: string;
  fragment?: string;
}): string[] {
  const afterBlocks = normalizeJournalHtml(params.after);
  if (params.fragment !== undefined) {
    const stored = new Set(afterBlocks);
    return unique(normalizeJournalHtml(params.fragment).filter((block) => stored.has(block)));
  }
  const beforeBlocks = new Set(normalizeJournalHtml(params.before));
  return unique(afterBlocks.filter((block) => !beforeBlocks.has(block)));
}

/** The contribution blocks missing from `content`. */
export function lostContribution(contribution: readonly string[], content: string): string[] {
  const present = new Set(normalizeJournalHtml(content));
  return contribution.filter((block) => !present.has(block));
}

function unique(blocks: string[]): string[] {
  return [...new Set(blocks)];
}

/** Who wrote a change the connector did not make. */
export type ForeignSource = { kind: 'user'; userId: string } | { kind: 'autosave' };

/** A page body change made by someone other than the connector. */
export interface ForeignChange {
  journalId: string;
  pageId: string;
  /** The new `text.content`, or `undefined` when the change left it untouched. */
  content: string | undefined;
  source: ForeignSource;
}

/** A page the connector wrote, watched for an overwrite. */
export interface WatchedWrite {
  journalId: string;
  pageId: string;
  journalName: string;
  pageName: string;
  /** Page body as stored right after the connector's write. */
  after: string;
  /** Normalized blocks the write added (see {@link journalContribution}). */
  contribution: string[];
}

/** A detected loss, as listed by `get_health_status`. */
export interface JournalConflict {
  at: number;
  journalId: string;
  pageId: string;
  journalName: string;
  pageName: string;
  /** History reason: `overwritten-by-<user>`, `overwritten-by-editor-autosave` or `overwritten-by-connector`. */
  reason: string;
  /** Display name of whoever saved; `null` for a collaborative-editor autosave. */
  savedBy: string | null;
  /** Local copy of the overwritten version, when one could be written. */
  historyPath: string | null;
}

/** Reason recorded when a connector write overwrote someone else's change. */
export const OVERWRITTEN_BY_CONNECTOR = 'overwritten-by-connector';

/** English label of whoever saved, for logs and tool responses. */
export function conflictAuthor(conflict: Pick<JournalConflict, 'savedBy'>): string {
  return conflict.savedBy ?? 'an open editor (autosave)';
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The chat message whispered to the GMs about a conflict: entry, page, who
 * saved, and where the local copy is. French or English.
 */
export function journalConflictMessage(conflict: JournalConflict, french: boolean): string {
  const entry = escapeHtml(conflict.journalName);
  const page = escapeHtml(conflict.pageName);
  const who = escapeHtml(
    conflict.savedBy ??
      (french ? 'un éditeur ouvert (sauvegarde automatique)' : 'an open editor (autosave)'),
  );
  const copy = conflict.historyPath
    ? `<code>${escapeHtml(conflict.historyPath)}</code>`
    : french
      ? 'aucune copie n’a pu être écrite'
      : 'no copy could be written';
  const byConnector = conflict.reason === OVERWRITTEN_BY_CONNECTOR;

  if (french) {
    const what = byConnector
      ? `Une modification de ${who} sur la page « ${page} » de l’entrée « ${entry} » est arrivée pendant une écriture du connecteur et a été écrasée.`
      : `La page « ${page} » de l’entrée « ${entry} » a été sauvegardée par ${who}, et du texte écrit par le connecteur a disparu.`;
    return `<p><strong>Connecteur MCP — écrasement de journal détecté</strong></p><p>${what}</p><p>Version écrasée : ${copy}</p>`;
  }
  const what = byConnector
    ? `A change by ${who} to page “${page}” of entry “${entry}” reached the server while the connector was writing it, and was overwritten.`
    : `Page “${page}” of entry “${entry}” was saved by ${who}, and text written by the connector is gone.`;
  return `<p><strong>MCP connector — journal overwrite detected</strong></p><p>${what}</p><p>Overwritten version: ${copy}</p>`;
}

/** What {@link JournalWatch.observe} made of a foreign change. */
export type ObservedChange =
  | { kind: 'ignored' }
  /** Arrived while a connector write to the page was in flight. */
  | { kind: 'race' }
  /** Ended a watch with the contribution intact. */
  | { kind: 'kept' }
  /** Ended a watch with part of the contribution gone. */
  | { kind: 'lost'; watched: WatchedWrite; lost: string[] };

function pageKey(journalId: string, pageId: string): string {
  return `${journalId}.${pageId}`;
}

/**
 * In-memory integrity state for journal pages: writes in flight, watched
 * writes, recent editor autosaves, pending warnings and recent conflicts.
 */
export class JournalWatch {
  private readonly watches = new Map<string, WatchedWrite & { expiresAt: number }>();
  private readonly inflight = new Map<string, ForeignChange[]>();
  private readonly autosaves = new Map<string, number>();
  private readonly warnings: string[] = [];
  private conflicts: JournalConflict[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** Starts collecting foreign changes to a page while a connector write is in flight. */
  beginWrite(journalId: string, pageId: string): void {
    this.inflight.set(pageKey(journalId, pageId), []);
  }

  /** Stops collecting, returning the foreign body changes seen during the write. */
  endWrite(journalId: string, pageId: string): ForeignChange[] {
    const key = pageKey(journalId, pageId);
    const seen = this.inflight.get(key) ?? [];
    this.inflight.delete(key);
    return seen;
  }

  /** Watches a written page for {@link WATCH_TTL_MS}, replacing any earlier watch. */
  watch(write: WatchedWrite): void {
    if (write.contribution.length === 0) {
      this.watches.delete(pageKey(write.journalId, write.pageId));
      return;
    }
    this.watches.set(pageKey(write.journalId, write.pageId), {
      ...write,
      expiresAt: this.now() + WATCH_TTL_MS,
    });
  }

  isWatched(journalId: string, pageId: string): boolean {
    this.pruneWatches();
    return this.watches.has(pageKey(journalId, pageId));
  }

  /**
   * Feeds a change made by someone other than the connector.
   *
   * During a write it is held for {@link endWrite}. Otherwise the first body
   * change to a watched page ends the watch: either someone saved a version
   * that still holds the connector's contribution, or part of it is gone.
   */
  observe(change: ForeignChange): ObservedChange {
    const key = pageKey(change.journalId, change.pageId);
    if (change.source.kind === 'autosave') {
      this.autosaves.set(key, this.now());
    }
    if (change.content === undefined) {
      return { kind: 'ignored' };
    }
    const window = this.inflight.get(key);
    if (window) {
      window.push(change);
      return { kind: 'race' };
    }
    this.pruneWatches();
    const watched = this.watches.get(key);
    if (!watched) {
      return { kind: 'ignored' };
    }
    this.watches.delete(key);
    const lost = lostContribution(watched.contribution, change.content);
    if (lost.length === 0) {
      return { kind: 'kept' };
    }
    const { expiresAt: _expiresAt, ...write } = watched;
    return { kind: 'lost', watched: write, lost };
  }

  /** True when an editor autosaved the page within {@link RECENT_AUTOSAVE_MS}. */
  hasRecentAutosave(journalId: string, pageId: string): boolean {
    const at = this.autosaves.get(pageKey(journalId, pageId));
    return at !== undefined && this.now() - at <= RECENT_AUTOSAVE_MS;
  }

  /** Queues a warning for the next journal tool response. */
  addWarning(text: string): void {
    this.warnings.push(text);
  }

  /** Returns and clears the pending warnings. */
  drainWarnings(): string[] {
    return this.warnings.splice(0, this.warnings.length);
  }

  recordConflict(conflict: JournalConflict): void {
    this.conflicts.push(conflict);
    this.pruneConflicts();
  }

  /** Conflicts detected within {@link CONFLICT_RETENTION_MS}, oldest first. */
  recentConflicts(): JournalConflict[] {
    this.pruneConflicts();
    return [...this.conflicts];
  }

  private pruneWatches(): void {
    const now = this.now();
    for (const [key, watched] of this.watches) {
      if (watched.expiresAt <= now) {
        this.watches.delete(key);
      }
    }
  }

  private pruneConflicts(): void {
    const cutoff = this.now() - CONFLICT_RETENTION_MS;
    this.conflicts = this.conflicts.filter((conflict) => conflict.at > cutoff);
  }
}
