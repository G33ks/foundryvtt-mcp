/**
 * @fileoverview Local copies of journal page bodies, kept in the state
 * directory before every page write and when an overwrite is detected.
 *
 * Layout: `<root>/<journalId>/<pageId>/<timestamp>-<reason>.html` with a
 * `.json` sidecar (entry and page names, reason, version token, user, date).
 * Each new copy prunes its page's folder to {@link MAX_COPIES_PER_PAGE}
 * copies, dropping any older than {@link MAX_COPY_AGE_MS}.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { journalVersion } from './journal-integrity.js';

export const MAX_COPIES_PER_PAGE = 20;
export const MAX_COPY_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** FoundryVTT document ids: the only path segments a copy may be filed under. */
const DOCUMENT_ID = /^[a-zA-Z0-9]{16}$/;

export interface JournalCopy {
  journalId: string;
  pageId: string;
  journalName: string;
  pageName: string;
  /** `before-replace`, `before-append`, `overwritten-by-<user>`, … */
  reason: string;
  /** The page body being kept. */
  content: string;
  /** Name of the user whose version this is (or who is about to replace it). */
  user: string;
}

/** Makes a reason safe as part of a file name (user names may hold anything). */
function fileSafe(reason: string): string {
  return reason.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80) || 'unknown';
}

export class JournalHistory {
  constructor(
    readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Writes one copy and prunes the page's folder.
   *
   * @returns the path of the `.html` copy
   * @throws when the copy cannot be written — callers must not go ahead with
   *   a page write they could not back up
   */
  save(copy: JournalCopy): string {
    if (!DOCUMENT_ID.test(copy.journalId) || !DOCUMENT_ID.test(copy.pageId)) {
      throw new Error(
        `Invalid journal or page id for a local copy: ${copy.journalId}/${copy.pageId}`,
      );
    }
    const dir = path.join(this.root, copy.journalId, copy.pageId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const savedAt = new Date(this.now());
    const stem = `${savedAt.toISOString().replace(/[:.]/g, '-')}-${fileSafe(copy.reason)}`;
    let base = path.join(dir, stem);
    for (let n = 2; existsSync(`${base}.html`); n++) {
      base = path.join(dir, `${stem}-${n}`);
    }
    const htmlPath = `${base}.html`;
    writeFileSync(htmlPath, copy.content, { encoding: 'utf8', mode: 0o600 });
    writeFileSync(
      `${base}.json`,
      `${JSON.stringify(
        {
          journalId: copy.journalId,
          pageId: copy.pageId,
          journalName: copy.journalName,
          pageName: copy.pageName,
          reason: copy.reason,
          version: journalVersion(copy.content),
          user: copy.user,
          savedAt: savedAt.toISOString(),
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    this.prune(dir);
    return htmlPath;
  }

  private prune(dir: string): void {
    const cutoff = this.now() - MAX_COPY_AGE_MS;
    const copies = readdirSync(dir)
      .filter((name) => name.endsWith('.html'))
      .map((name) => ({ name, savedAt: savedAtOf(name) ?? statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.savedAt - a.savedAt || b.name.localeCompare(a.name));
    copies.forEach((copy, index) => {
      if (index >= MAX_COPIES_PER_PAGE || copy.savedAt < cutoff) {
        const stem = copy.name.slice(0, -'.html'.length);
        rmSync(path.join(dir, `${stem}.html`), { force: true });
        rmSync(path.join(dir, `${stem}.json`), { force: true });
      }
    });
  }
}

/** The save time encoded at the start of a copy's file name. */
function savedAtOf(name: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
  if (!match) {
    return null;
  }
  const [, day, h, m, s, ms] = match;
  const time = Date.parse(`${day}T${h}:${m}:${s}.${ms}Z`);
  return Number.isNaN(time) ? null : time;
}
