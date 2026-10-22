import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUBTITLES_SCHEMA_ID, subtitleCuesHash, subtitleSetHash, type Composition, type SubtitleSet } from '@motion-studio/shared';
import type { Git } from '../src/git.ts';
import {
  SubtitleCommits, audioFingerprint, defaultSubtitleLang, followSource, listSubtitleSets, speechSourceSet, readSubtitleSet, removeSubtitleSet, subtitlePath, subtitlesDir, writeSubtitleSet,
} from '../src/subtitles/store.ts';

const set = (lang: SubtitleSet['lang'], over: Partial<SubtitleSet> = {}): SubtitleSet => ({
  $schema: SUBTITLES_SCHEMA_ID, lang, origin: 'speech', transcript: 'whisper-small', detected: lang,
  timing: { version: 1, format: 'main', fingerprint: 'a'.repeat(64) },
  cues: [{ id: 'c1', start: 0, end: 1200, text: 'Ciao' }, { id: 'c2', start: 1200, end: 2400, text: 'a tutti', edited: true }],
  ...over,
});

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ms-subtitles-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('subtitle store', () => {
  it('the speech source is the set made from the original video, not one of a language\'s own voice (Task 24)', async () => {
    const german = set('de', { timing: { version: 1, format: 'main', fingerprint: 'b'.repeat(64), locale: 'de' } });
    await writeSubtitleSet(dir, german);
    // Only a localized voice's set: no source, and the original video draws nothing by default.
    expect(speechSourceSet(await listSubtitleSets(dir))).toBeUndefined();
    expect(await defaultSubtitleLang(dir, { locales: { primary: 'fr', extra: [] } })).toBeNull();
    await writeSubtitleSet(dir, set('it'));
    expect(speechSourceSet(await listSubtitleSets(dir))?.lang).toBe('it');
    // The original video draws the original speech by default, never a language's own voice.
    expect(await defaultSubtitleLang(dir, { locales: { primary: 'fr', extra: [] } })).toBe('it');
    expect(await defaultSubtitleLang(dir, { locales: { primary: 'fr', extra: [] } }, 'de')).toBe('de');
  });

  it('"Tempi controllati" on the source gives its timing only to a translation that was in step, or that truly follows now (final review I1)', async () => {
    const before = set('it');
    const after = set('it', { timing: { version: 2, format: 'main', fingerprint: 'c'.repeat(64) } });
    const translation = (lang: SubtitleSet['lang'], fingerprint: string, cues: SubtitleSet['cues']): SubtitleSet =>
      set(lang, { origin: 'translation', sourceLang: 'it', detected: null, timing: { version: 1, format: 'main', fingerprint }, cues });
    // In step with the source as it was: it takes the new timing.
    await writeSubtitleSet(dir, translation('en', 'a'.repeat(64), [{ id: 'c1', start: 0, end: 1200, text: 'Hi', source: { text: 'Ciao' } }]));
    // Lagging (an earlier retime it could not follow), its line on old times and from a text the source no longer has.
    await writeSubtitleSet(dir, translation('fr', 'b'.repeat(64), [{ id: 'c1', start: 3000, end: 4200, text: 'Salut', source: { text: 'Salve' } }]));
    // Lagging, but its line pairs with the source's by text: it moves there and truly follows.
    await writeSubtitleSet(dir, translation('de', 'b'.repeat(64), [{ id: 'c1', start: 3000, end: 4200, text: 'Hallo', source: { text: 'Ciao' } }]));
    await writeSubtitleSet(dir, after);
    expect((await followSource(dir, before, after)).sort()).toEqual(['de', 'en']);
    expect((await readSubtitleSet(dir, 'en'))!.set.timing.fingerprint).toBe('c'.repeat(64));
    expect((await readSubtitleSet(dir, 'fr'))!.set.timing.fingerprint).toBe('b'.repeat(64));
    const de = (await readSubtitleSet(dir, 'de'))!.set;
    expect([de.timing.fingerprint, de.cues[0]!.start, de.cues[0]!.end]).toEqual(['c'.repeat(64), 0, 1200]);
  });

  it('keeps one file per language under subtitles/', () => {
    expect(subtitlesDir('/c')).toBe(join('/c', 'subtitles'));
    expect(subtitlePath('/c', 'it')).toBe(join('/c', 'subtitles', 'it.json'));
  });

  it('writes, reads back and hashes a set the same way', async () => {
    const s = set('it');
    const hash = await writeSubtitleSet(dir, s);
    expect(hash).toBe(subtitleSetHash(s));
    expect(await readSubtitleSet(dir, 'it')).toEqual({ set: s, hash, cuesHash: subtitleCuesHash(s) });
    expect(await writeSubtitleSet(dir, s)).toBe(hash);
    expect(await readSubtitleSet(dir, 'en')).toBeNull();
  });

  it('lists the valid sets and skips a file too large or with a bad schema', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeSubtitleSet(dir, set('it'));
    await writeSubtitleSet(dir, set('en'));
    await writeFile(subtitlePath(dir, 'fr'), JSON.stringify({ ...set('fr'), extra: 1 }));
    await writeFile(subtitlePath(dir, 'de'), `${JSON.stringify(set('de'))}${' '.repeat(1_048_577)}`);
    expect(await readSubtitleSet(dir, 'fr')).toBeNull();
    expect(await readSubtitleSet(dir, 'de')).toBeNull();
    expect((await listSubtitleSets(dir)).map((s) => s.lang).sort()).toEqual(['en', 'it']);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('a missing folder lists nothing; a removed set is gone', async () => {
    expect(await listSubtitleSets(dir)).toEqual([]);
    await writeSubtitleSet(dir, set('it'));
    await removeSubtitleSet(dir, 'it');
    await removeSubtitleSet(dir, 'it');
    expect(await readSubtitleSet(dir, 'it')).toBeNull();
  });

  it('writes the exact set text (no temp file left)', async () => {
    await writeSubtitleSet(dir, set('it'));
    expect(JSON.parse(await readFile(subtitlePath(dir, 'it'), 'utf8'))).toEqual(set('it'));
    expect(await readdir(subtitlesDir(dir))).toEqual(['it.json']);
  });
});

describe('audioFingerprint', () => {
  const comp = (audioStart: number, textStart: number, duration = 6): Composition => ({
    $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration, background: '#000000', fonts: [], scenes: [],
    tracks: [
      { id: 't', kind: 'text', clips: [{ id: 'x', type: 'text', start: textStart, duration: 1, text: 'Hi', props: {} }] },
      { id: 'a', kind: 'audio', clips: [{ id: 'm', type: 'audio', src: 'assets/m.wav', start: audioStart, duration: 2 }] },
    ],
  } as unknown as Composition);

  it('ignores visual edits and follows the audio and the duration', () => {
    const base = audioFingerprint(comp(1, 0));
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(audioFingerprint(comp(1, 3))).toBe(base);
    expect(audioFingerprint(comp(1.5, 0))).not.toBe(base);
    expect(audioFingerprint(comp(1, 0, 7))).not.toBe(base);
  });
});

describe('SubtitleCommits', () => {
  const ref = { root: '/w', projectSlug: 'acme', projectDir: '/w/acme', creativeSlug: 'promo' };
  const fakeGit = () => {
    const commitPaths = vi.fn(async () => 'sha');
    return { git: { commitPaths } as unknown as Git, commitPaths };
  };

  it('commits once, after the quiet time, however many touches', async () => {
    const { git, commitPaths } = fakeGit();
    const c = new SubtitleCommits({ git, quietMs: 20 });
    c.touch(ref, 'one');
    c.touch(ref, 'two');
    c.touch(ref, 'three');
    expect(commitPaths).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 60));
    expect(commitPaths).toHaveBeenCalledTimes(1);
    expect(commitPaths).toHaveBeenCalledWith('/w/acme', ['creatives/promo/subtitles'], 'three');
  });

  it('flush commits at once, and only what was touched', async () => {
    const { git, commitPaths } = fakeGit();
    const c = new SubtitleCommits({ git, quietMs: 10_000 });
    await c.flush(ref);
    expect(commitPaths).not.toHaveBeenCalled();
    c.touch(ref, 'edit');
    c.touch({ ...ref, creativeSlug: 'other' }, 'edit 2');
    await c.flush(ref);
    expect(commitPaths).toHaveBeenCalledTimes(1);
    await c.flush();
    expect(commitPaths).toHaveBeenCalledTimes(2);
    expect(commitPaths).toHaveBeenLastCalledWith('/w/acme', ['creatives/other/subtitles'], 'edit 2');
  });

  it('flush waits for a commit the quiet timer already started', async () => {
    let release!: () => void;
    const commitPaths = vi.fn(() => new Promise<string>((r) => { release = () => r('sha'); }));
    const c = new SubtitleCommits({ git: { commitPaths } as unknown as Git, quietMs: 10 });
    c.touch(ref, 'edit');
    await vi.waitFor(() => expect(commitPaths).toHaveBeenCalledTimes(1));
    let flushed = 0;
    const all = c.flush().then(() => { flushed++; });
    const one = c.flush(ref).then(() => { flushed++; });
    await new Promise((r) => setTimeout(r, 30));
    expect(flushed).toBe(0);
    release();
    await Promise.all([all, one]);
    expect(flushed).toBe(2);
    expect(commitPaths).toHaveBeenCalledTimes(1);
  });

  it('a failed commit does not throw', async () => {
    const commitPaths = vi.fn(async () => { throw new Error('git'); });
    const c = new SubtitleCommits({ git: { commitPaths } as unknown as Git, quietMs: 10_000 });
    c.touch(ref, 'edit');
    await expect(c.flush(ref)).resolves.toBeUndefined();
  });
});
