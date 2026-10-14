// @vitest-environment node
/**
 * Localization overlays (Phase 12, Task 3): the path segments, the overlay checks (strict schema, ids, voice files), the
 * atomic store and its hash, the stale ids, and the text-box estimate (Review Focus 1).
 */
import { createHash } from 'node:crypto';
import { readCompositionFolder } from '../src/compositions/composition-files.ts';
import { checkCompositionObject } from '../src/creatives/composition-contract.ts';
import { activeLocaleRenders, sweepProjectRenders } from '../src/render/render-sweep.ts';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCALIZATION_SCHEMA_ID, messages, type Composition, type Localization, type VersionEntry } from '@motion-studio/shared';
import { currentLocale } from '../src/i18n.ts';
import { emptyOverlay, overlayText, readOverlay, writeOverlay } from '../src/localization/store.ts';
import { checkedInstance, checkedLocale, checkLocalizedComposition, checkOverlay, estimateLines, fitTexts, staleIds, voiceFileOk, withoutGone } from '../src/localization/validate.ts';
import { CodedError } from '../src/workspace-store.ts';

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'ms-test-l10n-store-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

const v = () => messages(currentLocale()).variants;
const comp = (title = 'Hello', script?: string): Composition => ({
  $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: 2, background: '#101010', fonts: [], scenes: [],
  tracks: [
    { id: 'v', kind: 'visual', clips: [
      { id: 'title', name: 'Title', type: 'text', start: 0, duration: 2, props: { x: 10, y: 10, width: 200, height: 40, text: title, fontSize: 20, color: '#ffffff' } },
      { id: 'box', type: 'shape', start: 0, duration: 2, props: { x: 0, y: 0, width: 10, height: 10, fill: '#ff0000' } },
    ] },
    { id: 'a', kind: 'audio', clips: [{ id: 'vo', type: 'audio', role: 'voice', src: 'assets/vo.mp3', start: 0, duration: 2, ...(script !== undefined ? { script } : {}) }] },
  ],
} as unknown as Composition);
const overlay = (o: Partial<Localization> = {}): Localization => ({ ...emptyOverlay('de', 'test-wide'), ...o });
const check = (raw: unknown, roots: string[] = [base]) => checkOverlay(raw, { composition: comp(), locale: 'de', instanceId: 'test-wide', voiceRoots: roots, uiLocale: currentLocale() });

describe('path segments', () => {
  it('a locale outside the curated list is refused, a right-to-left one with its translated reason', () => {
    expect(checkedLocale('de', currentLocale())).toBe('de');
    expect(checkedLocale('zh-Hans', currentLocale())).toBe('zh-Hans');
    for (const [raw, code] of [['ar', 'locale-rtl'], ['he', 'locale-rtl'], ['fa-IR', 'locale-rtl'], ['ur', 'locale-rtl'], ['xx', 'locale-unsupported'],
      ['../de', 'locale-unsupported'], ['de/../../x', 'locale-unsupported'], ['', 'locale-unsupported'], [undefined, 'locale-unsupported'], ['DE', 'locale-unsupported']] as const) {
      let err: unknown = null;
      try { checkedLocale(raw, currentLocale()); } catch (e) { err = e; }
      expect(err, String(raw)).toBeInstanceOf(CodedError);
      expect((err as CodedError).apiCode).toBe(code);
      expect((err as CodedError).status).toBe(400);
    }
    let rtl: CodedError | null = null;
    try { checkedLocale('ar', currentLocale()); } catch (e) { rtl = e as CodedError; }
    expect(rtl!.message).toBe(v().localeRtl({ tag: 'ar' }));
  });

  it('an instance segment must be an instance id of the version (never a path)', () => {
    const ver = { n: 3, compositions: [{ format: 'test-wide', dir: 'compositions/test-wide', hash: 'a'.repeat(64) }, { format: 'test-wide@2', dir: 'compositions/test-wide@2', hash: 'b'.repeat(64) }] } as VersionEntry;
    expect(checkedInstance('test-wide@2', ver, currentLocale())).toBe('test-wide@2');
    for (const raw of ['test-tall', '../test-wide', 'test-wide/..', 'test-wide@21', 'Test-Wide', '', 'test-wide@2/x', 'x'.repeat(300)]) {
      expect(() => checkedInstance(raw, ver, currentLocale()), raw).toThrow(CodedError);
    }
  });
});

describe('overlay checks', () => {
  it('accepts an overlay of existing entries', async () => {
    const r = await check(overlay({ texts: { title: { source: 'Hello', text: 'Hallo' } }, fit: { title: 0.8 } }));
    expect(r.ok).toBe(true);
  });

  it('refuses every field the spec does not allow, at every level', async () => {
    const good = overlay({ texts: { title: { source: 'Hello', text: 'Hallo' } } });
    const bad: unknown[] = [
      { ...good, tracks: [] },
      { ...good, width: 100 },
      { ...good, texts: { title: { source: 'Hello', text: 'Hallo', x: 10 } } },
      { ...good, texts: { title: { source: 'Hello', text: 'Hallo', props: { color: '#000' } } } },
      { ...good, voices: { vo: { src: 'assets/vo.mp3', script: 'a', sourceScript: 'b', volume: 1 } } },
      { ...good, fit: { title: 0.5 } },
      { ...good, fit: { title: 1.2 } },
      { ...good, fonts: [{ family: 'X', files: ['assets/x.ttf'], weight: 400 }] },
      { ...good, locale: 'fr' },
      { ...good, instanceId: 'test-tall' },
      { ...good, $schema: 'motion-studio/composition@1' },
    ];
    for (const b of bad) expect((await check(b)).ok, JSON.stringify(b)).toBe(false);
  });

  it('refuses ids that are not translatable entries of the composition, or of the wrong kind', async () => {
    expect(await check(overlay({ texts: { nope: { source: 'a', text: 'b' } } }))).toEqual({ ok: false, problems: [v().localizationMismatch({ entry: 'nope' })] });
    expect((await check(overlay({ texts: { box: { source: 'a', text: 'b' } } }))).ok).toBe(false);
    expect((await check(overlay({ voices: { title: { src: 'assets/vo.mp3', script: 'a', sourceScript: 'b' } } }))).ok).toBe(false);
  });

  it('a voice file must be a regular file under assets/ of a known root: never outside, never a link, never `..`', async () => {
    mkdirSync(join(base, 'assets', 'audio'), { recursive: true });
    writeFileSync(join(base, 'assets', 'audio', 'de.mp3'), 'mp3');
    writeFileSync(join(base, 'outside.mp3'), 'mp3');
    symlinkSync(join(base, 'outside.mp3'), join(base, 'assets', 'audio', 'link.mp3'));
    linkSync(join(base, 'outside.mp3'), join(base, 'assets', 'audio', 'hard.mp3'));
    mkdirSync(join(base, 'elsewhere'));
    writeFileSync(join(base, 'elsewhere', 'x.mp3'), 'mp3');
    symlinkSync(join(base, 'elsewhere'), join(base, 'assets', 'dirlink'));
    const voice = (src: string) => overlay({ voices: { vo: { src, script: 'Hallo', sourceScript: 'Hello' } } });
    expect((await check(voice('assets/audio/de.mp3'))).ok).toBe(true);
    for (const src of ['assets/audio/link.mp3', 'assets/audio/hard.mp3', 'assets/dirlink/x.mp3', 'assets/audio/missing.mp3', 'assets/../outside.mp3', 'layers/x.mp3', 'outside.mp3', '/etc/passwd']) {
      expect((await check(voice(src))).ok, src).toBe(false);
    }
    expect(await voiceFileOk([base], 'assets/audio/../audio/de.mp3')).toBe(false);
    expect(await voiceFileOk([join(base, 'nope'), base], 'assets/audio/de.mp3')).toBe(true);
  });
});

describe('the store', () => {
  it('writes atomically (no temp left) and the row hash is the file hash; a hand-edited file no longer reads as the recorded one', async () => {
    const creativeDir = join(base, 'c');
    mkdirSync(join(creativeDir, 'outputs', 'v1'), { recursive: true });
    const o = overlay({ texts: { title: { source: 'Hello', text: 'Hallo' } } });
    const hash = await writeOverlay(creativeDir, 1, o);
    const file = join(creativeDir, 'outputs', 'v1', 'locales', 'de', 'test-wide.json');
    expect(readFileSync(file, 'utf8')).toBe(overlayText(o));
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(hash);
    expect(readdirSync(join(creativeDir, 'outputs', 'v1', 'locales', 'de'))).toEqual(['test-wide.json']);
    expect(await readOverlay(creativeDir, 1, 'de', 'test-wide')).toEqual({ overlay: o, hash });
    writeFileSync(file, overlayText({ ...o, texts: { title: { source: 'Hello', text: 'Edited' } } }));
    expect((await readOverlay(creativeDir, 1, 'de', 'test-wide'))!.hash).not.toBe(hash);
    writeFileSync(file, '{"$schema":"motion-studio/localization@1","locale":"de","instanceId":"test-wide","texts":{},"params":{},"voices":{},"fit":{},"fonts":[],"tracks":[]}');
    expect(await readOverlay(creativeDir, 1, 'de', 'test-wide')).toBeNull();
  });

  it('never writes through a link planted in the path', async () => {
    const creativeDir = join(base, 'c');
    mkdirSync(join(creativeDir, 'outputs', 'v1'), { recursive: true });
    mkdirSync(join(base, 'target'));
    symlinkSync(join(base, 'target'), join(creativeDir, 'outputs', 'v1', 'locales'));
    await expect(writeOverlay(creativeDir, 1, overlay())).rejects.toThrow();
    expect(readdirSync(join(base, 'target'))).toEqual([]);
    expect(existsSync(join(base, 'target', 'de'))).toBe(false);
  });

  it('refuses to store an overlay with fields beyond the schema', async () => {
    const creativeDir = join(base, 'c');
    mkdirSync(join(creativeDir, 'outputs', 'v1'), { recursive: true });
    await expect(writeOverlay(creativeDir, 1, { ...overlay(), tracks: [] } as unknown as Localization)).rejects.toThrow();
    expect(existsSync(join(creativeDir, 'outputs', 'v1', 'locales', 'de', 'test-wide.json'))).toBe(false);
    expect(LOCALIZATION_SCHEMA_ID).toBe('motion-studio/localization@1');
  });
});

describe('stale ids and gone entries', () => {
  it('a text whose source changed is stale; a voice whose script changed is stale; a gone clip is dropped with its fit', () => {
    const o = overlay({
      texts: { title: { source: 'Hello', text: 'Hallo' } }, fit: { title: 0.9 },
      voices: { vo: { src: 'assets/vo.mp3', script: 'Hallo', sourceScript: 'Hello' } },
    });
    expect(staleIds(o, comp('Hello', 'Hello'))).toEqual([]);
    expect(staleIds(o, comp('Hi there', 'Hello'))).toEqual(['title']);
    expect(staleIds(o, comp('Hello', 'Hi'))).toEqual(['vo']);
    const gone = comp();
    gone.tracks[0]!.clips = gone.tracks[0]!.clips.filter((c) => c.id !== 'title');
    expect(withoutGone(o, gone)).toMatchObject({ texts: {}, fit: {}, voices: { vo: o.voices.vo } });
  });
});

describe('the text-box estimate (Review Focus 1)', () => {
  it('wraps on spaces, breaks wide scripts anywhere, and grows with the size', () => {
    expect(estimateLines('Hello', 20, 200).lines).toBe(1);
    expect(estimateLines('Hello world this is a much longer line of text', 20, 200).lines).toBeGreaterThan(1);
    expect(estimateLines('一二三四五六七八九十一二三四五六七八九十', 20, 200).lines).toBe(2);
    expect(estimateLines('a\nb', 20, 200).lines).toBe(2);
  });

  it('the core picks the largest fit that fits; a text that overflows even at 0.7 keeps 0.7 and is reported', () => {
    const c = comp('Hello');
    const fits = fitTexts(c, overlay({ texts: { title: { source: 'Hello', text: 'Hallo' } } }), [], new Set(['title']));
    expect(fits).toEqual({ overlay: expect.objectContaining({ fit: {} }), overflowing: [] });
    // Two lines at 20 px do not fit 40 px (48 px), at 0.8 they do (38.4 px).
    const two = fitTexts(c, overlay({ texts: { title: { source: 'Hello', text: 'Willkommen zur neuen Version unserer App' } } }), [], new Set(['title']));
    expect(two.overflowing).toEqual([]);
    expect(two.overlay.fit.title).toBeLessThan(1);
    expect(two.overlay.fit.title).toBeGreaterThanOrEqual(0.7);
    const long = 'Herzlich willkommen zur brandneuen Version unserer wunderbaren Anwendung für alle Geräte';
    const over = fitTexts(c, overlay({ texts: { title: { source: 'Hello', text: long } } }), [], new Set(['title']));
    expect(over).toEqual({ overlay: expect.objectContaining({ fit: { title: 0.7 } }), overflowing: ['title'] });
    // A fit the user chose is kept: overflowing at it is reported, never changed.
    const chosen = fitTexts(c, overlay({ texts: { title: { source: 'Hello', text: 'Willkommen zur neuen Version unserer App' } }, fit: { title: 1 } }), [], new Set());
    expect(chosen).toEqual({ overlay: expect.objectContaining({ fit: { title: 1 } }), overflowing: ['title'] });
    // A stale text is not checked (the source text is shown for it).
    expect(fitTexts(c, overlay({ texts: { title: { source: 'Old', text: long } } }), ['title'], new Set(['title'])).overflowing).toEqual([]);
  });

  it('never flags a translation that needs no more room than the source already takes', () => {
    const source = 'One two three four five six seven eight nine ten eleven twelve';
    const c = comp(source);
    expect(fitTexts(c, overlay({ texts: { title: { source, text: 'Eins zwei drei vier fünf sechs sieben acht neun' } } }), [], new Set(['title'])).overflowing).toEqual([]);
  });
});

describe('the checks a turn runs, on a composition object (Ruling K)', () => {
  it('validateComposition, the html layers\' static checks (warnings) and the duration against the brief', async () => {
    const dir = join(base, 'comp');
    mkdirSync(join(dir, 'layers'), { recursive: true });
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'Mono.woff2'), 'wOF2');
    writeFileSync(join(dir, 'layers', 'fx.html'), '<!doctype html><html><body><script>fetch("https://example.com/x")</script></body></html>');
    const c = {
      $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: 2, background: '#101010', fonts: [{ family: 'Mono', src: 'assets/Mono.woff2', weight: 400 }], scenes: [],
      tracks: [{ id: 'v', kind: 'visual', clips: [
        { id: 'fx', type: 'html', src: 'layers/fx.html', start: 0, duration: 2, props: { x: 0, y: 0, width: 320, height: 180 } },
        { id: 'title', type: 'text', start: 0, duration: 2, props: { x: 0, y: 0, width: 100, height: 30, text: 'Hallo', fontSize: 20 } },
      ] }],
    };
    writeFileSync(join(dir, 'composition.json'), JSON.stringify(c));
    const folder = await readCompositionFolder(dir);
    const preset = { id: 'test-wide', channel: 'T', name: 'W', width: 320, height: 180, kind: 'video' as const, extensions: ['mp4'] };
    const r = await checkCompositionObject(c, { preset, compDir: dir, folder, briefDurationSec: 10 });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.problems.map((p) => p.key)).toEqual(['composition.durationOffBrief']);
    const loc = await checkLocalizedComposition(c as unknown as Composition, { preset, compDir: dir, folder, files: folder.sizes, uiLocale: currentLocale() });
    expect(loc.problems).toEqual([]);
    expect(loc.warnings.length).toBeGreaterThan(0);
    // A file the localized composition names but the folder lacks is a problem.
    const missing = { ...c, fonts: [...c.fonts, { family: 'Noto Sans JP', src: 'assets/fonts/x.ttf' }] };
    expect((await checkLocalizedComposition(missing as unknown as Composition, { preset, compDir: dir, folder, files: folder.sizes, uiLocale: currentLocale() })).problems).not.toEqual([]);
  });
});

describe('startup sweep of localized render copies', () => {
  it('removes old r-<16 hex> folders only: never a young one, one in use, another name or a link', async () => {
    const root = join(base, 'p', '.studio', 'cache', 'locale-render');
    const mk = (name: string, old: boolean) => { mkdirSync(join(root, name, 'outputs'), { recursive: true }); if (old) utimesSync(join(root, name), new Date(0), new Date(0)); return join(root, name); };
    const old = mk('r-0123456789abcdef', true);
    const young = mk('r-1123456789abcdef', false);
    const busy = mk('r-2123456789abcdef', true);
    const other = mk('keep-me', true);
    mkdirSync(join(base, 'outside'));
    symlinkSync(join(base, 'outside'), join(root, 'r-3123456789abcdef'));
    activeLocaleRenders.add(busy);
    try {
      const removed = await sweepProjectRenders(join(base, 'p'));
      expect(removed).toEqual([old]);
    } finally { activeLocaleRenders.delete(busy); }
    expect([existsSync(old), existsSync(young), existsSync(busy), existsSync(other), existsSync(join(base, 'outside'))]).toEqual([false, true, true, true, true]);
  });
});
