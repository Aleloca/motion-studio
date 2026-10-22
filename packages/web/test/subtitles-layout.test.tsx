/**
 * Task 12: the subtitle editor (layout B) measured in real Chrome at 1280 × 800 and 900 × 700, light and dark: the player and
 * the list of lines sit side by side under the header with nothing scrolling sideways, the list scrolls by itself (the page
 * does not), a two-line text shows whole in its box, the rows' fields, buttons and warnings stay inside their row, the
 * frame keeps the format's proportions inside its column. Task 13: the timeline runs under both columns, full width and inside
 * the window, its blocks inside its track, the waveform drawn (by the component's own `drawWave`, run in the page: the
 * markup is static). Task 26: a creative with six subtitle languages, opened on a translation: the language switcher, "+ Lingua"
 * and "Ritraduci tutto" fit the header (every language on one line, nothing cut or outside), the stale marks, "Ritraduci" and
 * the source text stay inside their row. MS_LAYOUT_SHOTS=<folder> keeps a screenshot of each case.
 */
import type { CreativeDetail, SubtitleCue, SubtitlesSummary, VersionEntry } from '@motion-studio/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { chromePath, chromeRequired, LayoutRig } from './support/layoutPage.ts';

const at = '2026-10-22T10:00:00.000Z';
const REEL = 'instagram-reel-9x16';
const version: VersionEntry = {
  n: 2, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: '', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null,
  compositions: [{ format: REEL, dir: `compositions/${REEL}`, hash: '2'.repeat(64) }],
};
const TIMING = { version: 2, format: REEL, fingerprint: 'f'.repeat(64) };
const summary = (lang: SubtitlesSummary['lang'], translated: boolean): SubtitlesSummary => ({
  lang, origin: translated ? 'translation' : 'speech', ...(translated ? { sourceLang: 'it' as const } : {}), cues: 30, edited: 0, hash: 'a'.repeat(64),
  timing: TIMING, timingChanged: false, staleCues: translated ? 2 : 0,
});
const detail: CreativeDetail = {
  slug: 'lancio', jobKey: 'creative:/w:acme:lancio', versions: [version],
  // Task 26: six subtitle languages, the original speech and five translations.
  subtitles: [summary('it', false), ...(['en', 'de', 'fr', 'es', 'pt'] as const).map((l) => summary(l, true))],
  creative: {
    schemaVersion: 1, title: 'Lancio estivo', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'g', message: 'm', formats: [REEL], durationSec: 60, assets: [], notes: '' },
  },
};
const TWO_LINES = 'Prenota la tua prossima vacanza al mare\ncon tre tocchi dall’app di Acme Viaggi';
const SAID = ['Benvenuti nella nuova app di Acme Viaggi', 'Cerca la meta che sogni da sempre', 'Confronta i prezzi in un attimo', 'Scegli le date e i posti', 'Paga in modo sicuro'];
const CUES: SubtitleCue[] = Array.from({ length: 30 }, (_, i) => ({
  id: `c${i + 1}`, start: i * 3000, end: i * 3000 + (i === 2 ? 1800 : 2800),
  text: i === 1 ? TWO_LINES : i === 2 ? 'Una frase davvero molto lunga che si legge troppo in fretta' : i === 3 ? '\u2026' : SAID[i % SAID.length]!,
}));
// A voice: speech under each line, quiet in between (90 s, 1200 peaks).
const PEAKS = Array.from({ length: 1200 }, (_, i) => {
  const ms = (i / 1200) * 90_000;
  const on = CUES.some((c) => ms >= c.start && ms < c.end);
  return Math.round((on ? 0.25 + 0.7 * Math.abs(Math.sin(i / 3.1) * Math.cos(i / 11.7)) : 0.03) * 1000) / 1000;
});
/** Task 26: the English translation, two of its lines translated from a source text that changed since. */
const SAID_EN = ['Welcome to the new Acme Travel app', 'Find the place you have always dreamed of', 'Compare prices in a moment', 'Pick the dates and the seats', 'Pay safely'];
const EN: SubtitleCue[] = CUES.map((c, i) => ({
  ...c, text: i === 1 ? 'Book your next holiday by the sea\nin three taps with the Acme Travel app' : i === 2 ? 'A really long sentence that reads far too fast' : i === 3 ? c.text : SAID_EN[i % SAID_EN.length]!,
  source: { text: i === 0 || i === 2 ? 'Un testo di prima, cambiato da allora' : c.text },
}));
const api = {
  subtitleWaveform: vi.fn(async () => ({ peaks: PEAKS, durationMs: 90_000 })),
  getCreative: vi.fn(async () => detail),
  subtitleSet: vi.fn(async (_s: string, _c: string, lang: string) => ({ set: { $schema: 'motion-studio/subtitles@1', lang, origin: lang === 'it' ? 'speech' : 'translation', ...(lang === 'it' ? {} : { sourceLang: 'it' }),
    transcript: 'whisper-small', detected: 'it', timing: TIMING, cues: lang === 'it' ? CUES : EN }, hash: 'a'.repeat(64) })),
  saveSubtitleSet: vi.fn(async () => ({ hash: 'b'.repeat(64) })),
  subtitleFile: vi.fn(async () => new Blob([''])),
  revokePreview: vi.fn(async () => ({ revoked: true })),
  previewSession: vi.fn(async (_s: string, _c: string, n: number, format: string) => ({
    url: `http://127.0.0.1:61234/tok-v${n}/runtime/index.html`, token: `tok-v${n}`, origin: 'http://127.0.0.1:61234',
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), format, hash: 'h'.repeat(64), width: 1080, height: 1920, duration: 90, fps: 30,
  })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
// The player as a picture: Chrome measures the page's own layout, not a runtime frame.
const media = vi.hoisted(() => {
  const events = new EventTarget();
  return {
    currentTime: 3.5, duration: 90, loop: false, playbackRate: 1, paused: true,
    play: async () => {}, pause: () => {},
    addEventListener: (t: string, l: EventListener) => events.addEventListener(t, l),
    removeEventListener: (t: string, l: EventListener) => events.removeEventListener(t, l),
  };
});
vi.mock('../src/components/CompositionPlayer.tsx', async () => {
  const React = await import('react');
  return {
    CompositionMedia: class {},
    CompositionPlayer: (p: { onMedia?(m: unknown): void }) => {
      const props = React.useRef(p);
      React.useEffect(() => { props.current.onMedia?.(media); }, []);
      return React.createElement('div', { className: 'ms-cplayer' },
        React.createElement('div', { style: { position: 'absolute', inset: 0, background: 'linear-gradient(160deg, #3b6ea5, #c06c3c)' } }));
    },
  };
});
const { SubtitlesScreen } = await import('../src/screens/subtitles/SubtitlesScreen.tsx');
const { drawWave } = await import('../src/screens/subtitles/CueTimeline.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');

async function markup(lang: 'it' | 'en' = 'it'): Promise<string> {
  const shell = { route: { name: 'subtitles', slug: 'acme', creative: 'lancio', lang }, live: { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } } as unknown as Shell;
  const { container, unmount } = render(
    <I18nProvider locale="it"><ShellContext.Provider value={shell}><div id="page"><SubtitlesScreen slug="acme" creative="lancio" lang={lang} /></div></ShellContext.Provider></I18nProvider>);
  await screen.findByRole('list', { name: 'Righe dei sottotitoli' });
  // A translation: its source read, the stale marks shown.
  if (lang !== 'it') await screen.findAllByText('Testo originale cambiato');
  await waitFor(() => expect(container.querySelector('.ms-subs-caption')).not.toBeNull());
  // The waveform has loaded (no "loading" note in the markup).
  await waitFor(() => expect(container.querySelector('.ms-subtl-loading')).toBeNull());
  // A selected row, as after a click (the playhead moves to it).
  await userEvent.click(within(screen.getAllByRole('listitem')[1]!).getByText('2'));
  const html = container.querySelector('#page')!.innerHTML;
  unmount();
  return html;
}

const MEASURE = `(() => {
  const tl = document.querySelector('.ms-subs-timeline').getBoundingClientRect();
  const view = document.querySelector('.ms-subtl-view');
  const track = document.querySelector('.ms-subtl-track').getBoundingClientRect();
  const canvas = document.querySelector('.ms-subtl-wave');
  (${drawWave.toString()})(canvas, { peaks: ${JSON.stringify(PEAKS)}, cover: 90000, span: 90000, trackW: view.clientWidth, scrollX: 0, viewW: view.clientWidth });
  const px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let inked = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 0) inked++;
  const blocks = [...document.querySelectorAll('.ms-subtl-cue')];
  const page = document.querySelector('.ms-page');
  const subs = document.querySelector('.ms-subs').getBoundingClientRect();
  const head = document.querySelector('.ms-subs-head');
  const player = document.querySelector('.ms-subs-player').getBoundingClientRect();
  const side = document.querySelector('.ms-subs-side').getBoundingClientRect();
  const stage = document.querySelector('.ms-subs-stage').getBoundingClientRect();
  const frame = document.querySelector('.ms-subs-frame').getBoundingClientRect();
  const scroll = document.querySelector('.ms-subs-scroll');
  const two = [...document.querySelectorAll('.ms-subs-text')].find((t) => t.value.includes('\\n'));
  const rows = [...document.querySelectorAll('.ms-subs-row')];
  const rowOut = rows.flatMap((r) => outside(r, '.ms-subs-time, .ms-subs-row-actions .ms-btn, .ms-subs-text, .ms-chip', r.getBoundingClientRect()));
  return {
    sideBySide: player.right <= side.left + 0.5 && player.top < side.bottom && side.top < player.bottom,
    underHead: head.getBoundingClientRect().bottom <= Math.min(player.top, side.top) + 0.5,
    insideApp: subs.left >= -0.5 && subs.right <= innerWidth + 0.5 && side.bottom <= innerHeight + 0.5 && player.bottom <= innerHeight + 0.5,
    pageSideways: document.documentElement.scrollWidth > innerWidth || page.scrollWidth > page.clientWidth + 1 || document.querySelector('.ms-subs').scrollWidth > document.querySelector('.ms-subs').clientWidth + 1,
    pageScrolls: page.scrollHeight > page.clientHeight + 1,
    listScrolls: scroll.scrollHeight > scroll.clientHeight + 50 && getComputedStyle(scroll).overflowY === 'auto',
    listSideways: scroll.scrollWidth > scroll.clientWidth + 1,
    twoLinesWhole: !!two && two.scrollHeight <= two.clientHeight + 1 && two.clientHeight >= 2 * parseFloat(getComputedStyle(two).lineHeight),
    rowOut,
    langs: (() => {
      const box = document.querySelector('.ms-subs-langs');
      if (!box) return null;
      const seg = [...box.querySelectorAll('.ms-seg button')];
      const tops = seg.map((b) => Math.round(b.getBoundingClientRect().top));
      return {
        count: seg.length,
        oneLine: tops.every((t) => t === tops[0]),
        out: outside(head, '.ms-subs-langs, .ms-subs-langs .ms-btn, .ms-seg button', head.getBoundingClientRect()),
        cut: cutIn(box, 'button'),
        headHeight: Math.round(head.getBoundingClientRect().height),
        marks: document.querySelectorAll('.ms-subs-stale .ms-chip').length,
        sources: document.querySelectorAll('.ms-subs-source').length,
        sourceOut: rows.flatMap((r) => outside(r, '.ms-subs-source, .ms-subs-stale .ms-btn, .ms-subs-stale .ms-chip', r.getBoundingClientRect())),
      };
    })(),
    cut: [...cutIn(document.querySelector('.ms-subs-head'), 'button, .ms-pill'), ...cutIn(document.querySelector('.ms-subs-side'), 'button, .ms-chip')],
    headOut: outside(head, 'button, .ms-pill, h1, [role="status"]', head.getBoundingClientRect()),
    frameInside: frame.left >= stage.left - 0.5 && frame.right <= stage.right + 0.5 && frame.top >= stage.top - 0.5 && frame.bottom <= stage.bottom + 0.5,
    ratio: frame.width / frame.height,
    frameWidth: frame.width,
    caption: (() => { const c = document.querySelector('.ms-subs-caption'); if (!c) return false; const b = c.getBoundingClientRect(); return b.left >= frame.left - 0.5 && b.right <= frame.right + 0.5 && b.bottom <= frame.bottom + 0.5; })(),
    listWidth: side.width,
    timelineUnder: tl.top >= Math.max(player.bottom, side.bottom) - 0.5,
    timelineFull: tl.left <= player.left + 0.5 && tl.right >= side.right - 0.5,
    timelineInside: tl.bottom <= innerHeight + 0.5 && tl.height >= 90,
    blocks: blocks.length,
    blocksInTrack: blocks.every((b) => { const r = b.getBoundingClientRect(); return r.top >= track.top - 0.5 && r.bottom <= track.bottom + 0.5 && r.left >= track.left - 0.5 && r.right <= track.right + 0.5; }),
    waveInked: inked / (canvas.width * canvas.height),
    edges: [...document.querySelectorAll('.ms-subtl-cue.ms-on .ms-subtl-edge')].map((e) => Math.round(e.getBoundingClientRect().width)),
  };
})()`;
type M = {
  sideBySide: boolean; underHead: boolean; insideApp: boolean; pageSideways: boolean; pageScrolls: boolean; listScrolls: boolean; listSideways: boolean;
  twoLinesWhole: boolean; rowOut: string[]; cut: string[];
  langs: { count: number; oneLine: boolean; out: string[]; cut: string[]; headHeight: number; marks: number; sources: number; sourceOut: string[] } | null; headOut: string[]; frameInside: boolean; ratio: number; frameWidth: number; caption: boolean; listWidth: number;
  timelineUnder: boolean; timelineFull: boolean; timelineInside: boolean; blocks: number; blocksInTrack: boolean; waveInked: number; edges: number[];
};
// The app as the shell lays it out: the 52 px bar, then the page.
const shell = (page: string) => `<div class="ms-app"><div style="height:52px;border-bottom:1px solid var(--line);background:var(--panel)"></div><main class="ms-main"><div class="ms-stage"><div class="ms-page" data-page-active>${page}</div></div></main></div>`;

const run = chromePath ? describe : describe.skip;
if (!chromePath && chromeRequired) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('the subtitle editor: real Chrome layout (Task 12)', () => {
  const rig = new LayoutRig();
  let html = '';
  beforeAll(async () => { await rig.start(); html = await markup(); }, 120_000);
  afterAll(() => rig.stop(), 60_000);

  for (const theme of ['light', 'dark'] as const) {
    for (const [width, height] of [[1280, 800], [900, 700]] as const) {
      it(`${theme} ${width}×${height}: player and lines side by side, the list scrolls by itself, a two-line text shows whole, the timeline under both`, async () => {
        const r = await rig.measure<M>(shell(html), MEASURE, { name: 'subs-editor', width, height, theme }, 'subs-editor');
        expect(r.sideBySide, 'the player left of the list').toBe(true);
        expect(r.underHead).toBe(true);
        expect(r.insideApp, 'both columns inside the window').toBe(true);
        expect(r.pageSideways, 'nothing scrolls sideways').toBe(false);
        expect(r.pageScrolls, 'the page itself does not scroll').toBe(false);
        expect(r.listScrolls, 'the list scrolls by itself').toBe(true);
        expect(r.listSideways).toBe(false);
        expect(r.twoLinesWhole, 'a two-line text is fully visible').toBe(true);
        expect(r.rowOut, 'the rows\' fields, buttons and warnings inside their row').toEqual([]);
        expect(r.cut).toEqual([]);
        expect(r.headOut).toEqual([]);
        expect(r.frameInside).toBe(true);
        expect(r.ratio).toBeCloseTo(1080 / 1920, 2);
        expect(r.frameWidth).toBeGreaterThan(150);
        expect(r.caption, 'the caption inside the picture').toBe(true);
        expect(r.listWidth).toBeGreaterThanOrEqual(340);
        expect(r.timelineUnder, 'the timeline under the player and the list').toBe(true);
        expect(r.timelineFull, 'the timeline as wide as both columns').toBe(true);
        expect(r.timelineInside, 'the timeline inside the window').toBe(true);
        expect(r.blocks).toBe(CUES.length);
        expect(r.blocksInTrack).toBe(true);
        expect(r.waveInked, 'the waveform is drawn').toBeGreaterThan(0.02);
        expect(r.edges, 'the selected line\'s two 6 px handles').toEqual([6, 6]);
      }, 120_000);
    }
  }
});

run('the subtitle languages: real Chrome layout (Task 26)', () => {
  const rig = new LayoutRig();
  let html = '';
  beforeAll(async () => { await rig.start(); html = await markup('en'); }, 120_000);
  afterAll(() => rig.stop(), 60_000);

  for (const theme of ['light', 'dark'] as const) {
    for (const [width, height] of [[1280, 800], [900, 700]] as const) {
      it(`${theme} ${width}×${height}: six languages, "+ Lingua" and "Ritraduci tutto" fit the header; the stale marks and the source text stay in their row`, async () => {
        const r = await rig.measure<M>(shell(html), MEASURE, { name: 'subs-langs', width, height, theme }, 'subs-langs');
        expect(r.langs, 'the switcher is in the header').not.toBeNull();
        expect(r.langs!.count).toBe(6);
        expect(r.langs!.oneLine, 'every language on one line').toBe(true);
        expect(r.langs!.out, 'the switcher inside the header').toEqual([]);
        expect(r.langs!.cut, 'no language cut').toEqual([]);
        expect(r.headOut).toEqual([]);
        expect(r.cut).toEqual([]);
        // At most two rows of controls: the editor keeps its room.
        expect(r.langs!.headHeight).toBeLessThanOrEqual(100);
        expect(r.langs!.marks, 'the two stale lines are marked').toBe(2);
        expect(r.langs!.sources, 'every translated line shows its source text').toBe(CUES.length);
        expect(r.langs!.sourceOut).toEqual([]);
        expect(r.rowOut).toEqual([]);
        expect(r.sideBySide).toBe(true);
        expect(r.insideApp).toBe(true);
        expect(r.pageSideways).toBe(false);
        expect(r.pageScrolls).toBe(false);
        expect(r.listScrolls).toBe(true);
        expect(r.listSideways).toBe(false);
        expect(r.timelineInside).toBe(true);
      }, 120_000);
    }
  }
});
