import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JournalHistory, MAX_COPIES_PER_PAGE, MAX_COPY_AGE_MS } from '../journal-history.js';
import { journalVersion } from '../journal-integrity.js';

const J = '0123456789abcdef';
const P = 'fedcba9876543210';

const copy = (overrides = {}) => ({
  journalId: J,
  pageId: P,
  journalName: 'Session 11',
  pageName: 'Recap',
  reason: 'before-append',
  content: '<p>Old</p>',
  user: 'mcp-api',
  ...overrides,
});

describe('JournalHistory', () => {
  let root: string;
  let now: number;
  let history: JournalHistory;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'journal-history-'));
    now = Date.parse('2026-11-01T15:05:09.123Z');
    history = new JournalHistory(root, () => now);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const pageDir = () => path.join(root, J, P);

  it('writes the body and a metadata sidecar under <journalId>/<pageId>', () => {
    const file = history.save(copy());

    expect(file).toBe(path.join(pageDir(), '2026-11-01T15-05-09-123Z-before-append.html'));
    expect(readFileSync(file, 'utf8')).toBe('<p>Old</p>');
    const meta = JSON.parse(readFileSync(file.replace(/\.html$/, '.json'), 'utf8'));
    expect(meta).toEqual({
      journalId: J,
      pageId: P,
      journalName: 'Session 11',
      pageName: 'Recap',
      reason: 'before-append',
      version: journalVersion('<p>Old</p>'),
      user: 'mcp-api',
      savedAt: '2026-11-01T15:05:09.123Z',
    });
  });

  it('keeps two copies made in the same millisecond', () => {
    const a = history.save(copy());
    const b = history.save(copy({ content: '<p>Newer</p>' }));
    expect(a).not.toBe(b);
    expect(readFileSync(b, 'utf8')).toBe('<p>Newer</p>');
  });

  it('makes user names safe in file names', () => {
    const file = history.save(copy({ reason: 'overwritten-by-Zoé / ../x' }));
    expect(path.dirname(file)).toBe(pageDir());
    expect(path.basename(file)).toMatch(/^2026-11-01T15-05-09-123Z-overwritten-by-Zo_x\.html$/);
  });

  it('refuses ids that are not FoundryVTT document ids', () => {
    expect(() => history.save(copy({ journalId: '../../etc' }))).toThrow(
      /Invalid journal or page id/,
    );
  });

  it(`keeps at most ${MAX_COPIES_PER_PAGE} copies per page, dropping the oldest`, () => {
    for (let i = 0; i < MAX_COPIES_PER_PAGE + 3; i++) {
      history.save(copy({ content: `<p>${i}</p>` }));
      now += 1000;
    }
    const files = readdirSync(pageDir());
    expect(files.filter((f) => f.endsWith('.html'))).toHaveLength(MAX_COPIES_PER_PAGE);
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(MAX_COPIES_PER_PAGE);
    const bodies = files
      .filter((f) => f.endsWith('.html'))
      .map((f) => readFileSync(path.join(pageDir(), f), 'utf8'));
    expect(bodies).not.toContain('<p>0</p>');
    expect(bodies).toContain(`<p>${MAX_COPIES_PER_PAGE + 2}</p>`);
  });

  it('drops copies older than 30 days when a new one is written', () => {
    const old = history.save(copy({ content: '<p>old</p>' }));
    now += MAX_COPY_AGE_MS + 1;
    history.save(copy({ content: '<p>new</p>' }));
    const files = readdirSync(pageDir());
    expect(files).not.toContain(path.basename(old));
    expect(files.filter((f) => f.endsWith('.html'))).toHaveLength(1);
  });

  it('only prunes the page it writes to', () => {
    history.save(copy());
    now += MAX_COPY_AGE_MS + 1;
    history.save(copy({ pageId: 'aaaaaaaaaaaaaaaa' }));
    expect(readdirSync(pageDir()).filter((f) => f.endsWith('.html'))).toHaveLength(1);
  });

  it('throws when the copy cannot be written', () => {
    // A file where the journal folder should be makes mkdir fail.
    writeFileSync(path.join(root, J), 'not a folder');
    expect(() => history.save(copy())).toThrow();
  });
});
