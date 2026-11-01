import { describe, expect, it } from 'vitest';
import {
  CONFLICT_RETENTION_MS,
  JournalWatch,
  journalContribution,
  journalVersion,
  lostContribution,
  normalizeJournalHtml,
  RECENT_AUTOSAVE_MS,
  WATCH_TTL_MS,
} from '../journal-integrity.js';

const J = '0123456789abcdef';
const P = 'fedcba9876543210';

describe('journalVersion', () => {
  it('is the first 12 hex characters of the SHA-256 of the content', () => {
    // sha256("") = e3b0c44298fc1c149afbf4c8996fb924…
    expect(journalVersion('')).toBe('e3b0c44298fc');
    expect(journalVersion('<p>Initial</p>')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('changes with the content and only with the content', () => {
    expect(journalVersion('<p>a</p>')).toBe(journalVersion('<p>a</p>'));
    expect(journalVersion('<p>a</p>')).not.toBe(journalVersion('<p>b</p>'));
  });
});

describe('normalizeJournalHtml', () => {
  it('splits on block tags and line breaks', () => {
    expect(
      normalizeJournalHtml(
        '<h2>Titre</h2><p>un<br>deux</p><ul><li>a</li><li>b</li></ul><div>c</div>',
      ),
    ).toEqual(['Titre', 'un', 'deux', 'a', 'b', 'c']);
  });

  it('drops inline tags, decodes entities and collapses whitespace', () => {
    expect(
      normalizeJournalHtml(
        '<p>Un <b>gras</b> &eacute; &amp; &#233;&#xE9;&nbsp;fin   et\n  plus</p>',
      ),
    ).toEqual(['Un gras é & éé fin et plus']);
  });

  it('absorbs the rewrites FoundryVTT v14 applies on save', () => {
    // Observed live: what the connector sent vs what the server stored.
    const sent =
      '<p>Avant &amp; après<br/>ligne 2</p><p class="x" onclick="alert(1)">Un <b>gras</b> &eacute; \'sq\' "dq" &nbsp;fin</p><div>bloc</div><script>x()</script><ul><li>un</li><li>deux</li></ul><h2>Titre</h2><p>a  b   c</p>';
    const stored =
      '<p>Avant &amp; après<br>ligne 2</p><p class="x">Un <b>gras</b> é \'sq\' "dq"  fin</p><div>bloc</div><ul><li>un</li><li>deux</li></ul><h2>Titre</h2><p>a  b   c</p>';
    expect(normalizeJournalHtml(sent)).toEqual(normalizeJournalHtml(stored));
  });

  it('absorbs a ProseMirror re-serialization of the same text', () => {
    expect(normalizeJournalHtml('<div>Ajout</div><p>Fin</p>')).toEqual(
      normalizeJournalHtml('<p>Ajout</p>\n<p>Fin</p>'),
    );
  });

  it('returns nothing for empty content', () => {
    expect(normalizeJournalHtml('')).toEqual([]);
    expect(normalizeJournalHtml('<p> </p><p></p>')).toEqual([]);
  });
});

describe('journalContribution', () => {
  it('is the appended fragment for an append', () => {
    expect(
      journalContribution({
        before: '<p>Old</p>',
        after: '<p>Old</p><p>New &eacute;</p>',
        fragment: '<p>New &eacute;</p>',
      }),
    ).toEqual(['New é']);
  });

  it('leaves out fragment blocks the server stripped', () => {
    expect(
      journalContribution({
        before: '',
        after: '<p>Kept</p>',
        fragment: '<p>Kept</p><script>gone()</script><iframe>gone</iframe>',
      }),
    ).toEqual(['Kept']);
  });

  it('is what the write added for a replace', () => {
    expect(
      journalContribution({
        before: '<p>A</p><p>B</p>',
        after: '<p>A</p><p>B2</p><p>C</p>',
      }),
    ).toEqual(['B2', 'C']);
  });
});

describe('lostContribution', () => {
  it('lists the contribution blocks no longer present', () => {
    expect(lostContribution(['B2', 'C'], '<p>A</p><p>B2</p>')).toEqual(['C']);
    expect(lostContribution(['B2'], '<div>B2</div><p>typed later</p>')).toEqual([]);
  });
});

describe('JournalWatch', () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };
  const written = {
    journalId: J,
    pageId: P,
    journalName: 'Session',
    pageName: 'Recap',
    after: '<p>Old</p><p>Ours</p>',
    contribution: ['Ours'],
  };
  const user = { kind: 'user', userId: 'player0000000001' } as const;

  it('reports a later save that dropped the contribution, then stops watching', () => {
    const watch = new JournalWatch();
    watch.watch(written);
    const seen = watch.observe({ journalId: J, pageId: P, content: '<p>Old</p>', source: user });
    expect(seen).toMatchObject({ kind: 'lost', lost: ['Ours'], watched: { pageName: 'Recap' } });
    expect(watch.isWatched(J, P)).toBe(false);
  });

  it('stops watching quietly when the save kept the contribution', () => {
    const watch = new JournalWatch();
    watch.watch(written);
    expect(
      watch.observe({
        journalId: J,
        pageId: P,
        content: '<p>Old</p><p>Ours</p><p>Theirs</p>',
        source: user,
      }),
    ).toEqual({ kind: 'kept' });
    expect(watch.isWatched(J, P)).toBe(false);
  });

  it('ignores changes that leave the body untouched, and unwatched pages', () => {
    const watch = new JournalWatch();
    watch.watch(written);
    expect(watch.observe({ journalId: J, pageId: P, content: undefined, source: user })).toEqual({
      kind: 'ignored',
    });
    expect(watch.isWatched(J, P)).toBe(true);
    expect(
      watch.observe({ journalId: J, pageId: 'aaaaaaaaaaaaaaaa', content: '', source: user }),
    ).toEqual({ kind: 'ignored' });
  });

  it('treats an editor autosave like a save', () => {
    const watch = new JournalWatch();
    watch.watch(written);
    expect(
      watch.observe({
        journalId: J,
        pageId: P,
        content: '<p>Old</p>',
        source: { kind: 'autosave' },
      }),
    ).toMatchObject({ kind: 'lost' });
  });

  it('stops watching after six hours', () => {
    const c = clock();
    const watch = new JournalWatch(c.now);
    watch.watch(written);
    c.advance(WATCH_TTL_MS + 1);
    expect(watch.observe({ journalId: J, pageId: P, content: '', source: user })).toEqual({
      kind: 'ignored',
    });
  });

  it('does not watch a write that added nothing', () => {
    const watch = new JournalWatch();
    watch.watch({ ...written, contribution: [] });
    expect(watch.isWatched(J, P)).toBe(false);
  });

  it('holds body changes seen while a write is in flight', () => {
    const watch = new JournalWatch();
    watch.watch(written);
    watch.beginWrite(J, P);
    const change = { journalId: J, pageId: P, content: '<p>Theirs</p>', source: user };
    expect(watch.observe(change)).toEqual({ kind: 'race' });
    expect(watch.observe({ ...change, content: undefined })).toEqual({ kind: 'ignored' });
    expect(watch.endWrite(J, P)).toEqual([change]);
    expect(watch.endWrite(J, P)).toEqual([]);
  });

  it('remembers editor autosaves for ten minutes', () => {
    const c = clock();
    const watch = new JournalWatch(c.now);
    expect(watch.hasRecentAutosave(J, P)).toBe(false);
    watch.observe({ journalId: J, pageId: P, content: '<p>x</p>', source: { kind: 'autosave' } });
    expect(watch.hasRecentAutosave(J, P)).toBe(true);
    c.advance(RECENT_AUTOSAVE_MS + 1);
    expect(watch.hasRecentAutosave(J, P)).toBe(false);
  });

  it('hands out pending warnings once', () => {
    const watch = new JournalWatch();
    watch.addWarning('a');
    watch.addWarning('b');
    expect(watch.drainWarnings()).toEqual(['a', 'b']);
    expect(watch.drainWarnings()).toEqual([]);
  });

  it('keeps conflicts for 24 hours', () => {
    const c = clock();
    const watch = new JournalWatch(c.now);
    const conflict = {
      at: c.now(),
      journalId: J,
      pageId: P,
      journalName: 'Session',
      pageName: 'Recap',
      reason: 'overwritten-by-Alice',
      savedBy: 'Alice',
      historyPath: null,
    };
    watch.recordConflict(conflict);
    expect(watch.recentConflicts()).toEqual([conflict]);
    c.advance(CONFLICT_RETENTION_MS + 1);
    expect(watch.recentConflicts()).toEqual([]);
  });
});
