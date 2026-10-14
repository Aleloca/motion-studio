// @vitest-environment node
/**
 * The browser's judgement of a translation under the creative's lock (final wave Part 1, fix round 1, M3 and N1): the lane is
 * tried without waiting, the fits are bisected, and an overall deadline hands the decision back to the estimate. A clip whose
 * source already overflows is judged by the source-relative estimate and noted.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messages, type Composition, type FormatPreset, type VersionEntry } from '@motion-studio/shared';
import { readCompositionFolder } from '../src/compositions/composition-files.ts';
import { currentLocale } from '../src/i18n.ts';
import { emptyOverlay, finishOverlay, instanceComposition } from '../src/localization/store.ts';
import { PreviewLane, PreviewLaneBusyError } from '../src/render/preview-lane.ts';

const PRESETS: FormatPreset[] = [{ id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'] }];
const v = () => messages(currentLocale()).variants;

describe('the browser judgement of an overlay', () => {
  let base: string;
  let n = 0;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'ms-test-l10n-measure-')); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  /** A version with one title "Hello" (200×40 at 20 px) and its instance composition. */
  async function ic(text = 'Hello') {
    n++;
    const comp = { $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: 2, background: '#101010', fonts: [{ family: 'Mono', src: 'assets/Mono.woff2', weight: 400 }], scenes: [],
      tracks: [{ id: 'v', kind: 'visual', clips: [{ id: 'title', name: 'Title', type: 'text', start: 0, duration: 2, props: { x: 10, y: 10, width: 200, height: 40, text, fontSize: 20, color: '#ffffff' } }] }] } as unknown as Composition;
    const dir = join(base, 'outputs', `v${n}`, 'compositions', 'test-wide');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'Mono.woff2'), 'wOF2');
    writeFileSync(join(dir, 'composition.json'), JSON.stringify(comp));
    const version = { n, compositions: [{ format: 'test-wide', dir: 'compositions/test-wide', hash: (await readCompositionFolder(dir)).hash }] } as VersionEntry;
    return (await instanceComposition(base, version, 'test-wide', PRESETS))!;
  }
  const finish = async (text: string, measure: (c: Composition, s: AbortSignal) => Promise<string[] | null>, deadline?: number) => finishOverlay({
    overlay: { ...emptyOverlay('de', 'test-wide'), texts: { title: { source: 'Hello', text } } }, base: await ic(), voice: 'original',
    chooseFit: new Set(['title']), uiLocale: currentLocale(), projectDir: base, voiceRoots: [base], measure, ...(deadline !== undefined ? { measureDeadlineMs: deadline } : {}),
  });

  it('bisects the fit: at most four measures of the translation, the largest fit the browser accepts', async () => {
    const sizes: number[] = [];
    const done = await finish('Hallo Welt', async (c) => {
      const p = (c.tracks[0]!.clips[0] as unknown as { props: { text: string; fontSize: number } }).props;
      if (p.text !== 'Hello') sizes.push(p.fontSize);
      return p.text !== 'Hello' && p.fontSize > 20 * 0.8 + 1e-6 ? ['title'] : [];
    });
    expect(done.overlay.fit).toEqual({ title: 0.8 });
    expect(done.problems).toEqual([]);
    expect(sizes.length).toBeLessThanOrEqual(4);
  });

  it('past the overall deadline the estimate decides (a measure that hangs never holds the lock)', async () => {
    const t0 = Date.now();
    const done = await finish('Hallo', (_c, signal) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve(null), { once: true }); }), 50);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(done.measured).toBeNull();
    expect(done.sourceOverflow).toBeNull();
    expect(done.problems).toEqual([]);
  });

  it('a source that already overflows: the clip leaves the browser\'s verdict; the estimate judges it against the source, with a note', async () => {
    // The browser flags the title whatever its text. A same-length translation: no problem, only the note.
    const same = await finish('Hallo', async () => ['title']);
    expect(same.problems).toEqual([]);
    expect(same.issues).toEqual([{ code: 'sourceTextOverflow', clipId: 'title', message: v().sourceLayoutOverflow({ clip: 'Title' }) }]);
    // Far longer than the source: the estimate still flags it (it needs more room than the source).
    const longer = await finish('Herzlich willkommen zur brandneuen Version unserer wunderbaren Anwendung für alle', async () => ['title']);
    expect(longer.problems).toEqual([v().textOverflow({ clip: 'Title' })]);
  });
});

describe('the preview lane without waiting', () => {
  it('a caller that must not wait is refused at once when every slot is taken', async () => {
    const lane = new PreviewLane({ slots: 1 });
    let release!: () => void;
    const busy = lane.run(() => new Promise<void>((r) => { release = r; }));
    await expect(lane.run(async () => 1, undefined, { noWait: true })).rejects.toBeInstanceOf(PreviewLaneBusyError);
    release();
    await busy;
    expect(await lane.run(async () => 2, undefined, { noWait: true })).toBe(2);
  });
});
