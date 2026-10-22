/**
 * Task 12: the subtitle editor (layout B) measured in real Chrome at 1280 × 800 and 900 × 700, light and dark: the player and
 * the list of lines sit side by side under the header with nothing scrolling sideways, the list scrolls by itself (the page
 * does not), a two-line text shows whole in its box, the rows' fields, buttons and warnings stay inside their row, the
 * frame keeps the format's proportions inside its column. MS_LAYOUT_SHOTS=<folder> keeps a screenshot of each case.
 */
import type { CreativeDetail, SubtitleCue, VersionEntry } from '@motion-studio/shared';
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
const detail: CreativeDetail = {
  slug: 'lancio', jobKey: 'creative:/w:acme:lancio', versions: [version],
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
const api = {
  getCreative: vi.fn(async () => detail),
  subtitleSet: vi.fn(async () => ({ set: { $schema: 'motion-studio/subtitles@1', lang: 'it', origin: 'speech', transcript: 'whisper-small', detected: 'it', timing: { version: 2, format: REEL, fingerprint: 'f'.repeat(64) }, cues: CUES }, hash: 'a'.repeat(64) })),
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
const { I18nProvider } = await import('../src/i18n.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');

async function markup(): Promise<string> {
  const shell = { route: { name: 'subtitles', slug: 'acme', creative: 'lancio', lang: 'it' }, live: { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } } as unknown as Shell;
  const { container, unmount } = render(
    <I18nProvider locale="it"><ShellContext.Provider value={shell}><div id="page"><SubtitlesScreen slug="acme" creative="lancio" lang="it" /></div></ShellContext.Provider></I18nProvider>);
  await screen.findByRole('list', { name: 'Righe dei sottotitoli' });
  await waitFor(() => expect(container.querySelector('.ms-subs-caption')).not.toBeNull());
  // A selected row, as after a click (the playhead moves to it).
  await userEvent.click(within(screen.getAllByRole('listitem')[1]!).getByText('2'));
  const html = container.querySelector('#page')!.innerHTML;
  unmount();
  return html;
}

const MEASURE = `(() => {
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
    cut: [...cutIn(document.querySelector('.ms-subs-head'), 'button, .ms-pill'), ...cutIn(document.querySelector('.ms-subs-side'), 'button, .ms-chip')],
    headOut: outside(head, 'button, .ms-pill, h1, [role="status"]', head.getBoundingClientRect()),
    frameInside: frame.left >= stage.left - 0.5 && frame.right <= stage.right + 0.5 && frame.top >= stage.top - 0.5 && frame.bottom <= stage.bottom + 0.5,
    ratio: frame.width / frame.height,
    frameWidth: frame.width,
    caption: (() => { const c = document.querySelector('.ms-subs-caption'); if (!c) return false; const b = c.getBoundingClientRect(); return b.left >= frame.left - 0.5 && b.right <= frame.right + 0.5 && b.bottom <= frame.bottom + 0.5; })(),
    listWidth: side.width,
  };
})()`;
type M = {
  sideBySide: boolean; underHead: boolean; insideApp: boolean; pageSideways: boolean; pageScrolls: boolean; listScrolls: boolean; listSideways: boolean;
  twoLinesWhole: boolean; rowOut: string[]; cut: string[]; headOut: string[]; frameInside: boolean; ratio: number; frameWidth: number; caption: boolean; listWidth: number;
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
      it(`${theme} ${width}×${height}: player and lines side by side, the list scrolls by itself, a two-line text shows whole`, async () => {
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
      }, 120_000);
    }
  }
});
