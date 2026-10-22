/**
 * Subtitles Task 22: the export dialog's "Sottotitoli" section measured in real Chrome, light and dark, in the app's smallest
 * window (1024 × 700): the dialog at its own 760 px and narrowed to 520 px. The three rows (name, hint and a check per
 * language), the clean-video note and the file-name preview (the `-sub-<lang>` videos and the `.srt`/`.vtt` names) stay
 * inside the dialog with nothing scrolling sideways, and the list of formats above keeps at least one row in view (the
 * section never squeezes it away). The markup is rendered in jsdom with the rows ticked; MS_LAYOUT_SHOTS=<folder> keeps a
 * screenshot of each case.
 */
import { DEFAULT_FORMATS, type VersionEntry } from '@motion-studio/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FormatState } from '../src/screens/versionModel.ts';
import { chromePath, chromeRequired, LayoutRig } from './support/layoutPage.ts';

vi.mock('../src/api.ts', () => ({ api: { fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}` }, ApiError: class extends Error {} }));
const { ExportDialog } = await import('../src/screens/ExportDialog.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');

const REEL = 'instagram-reel-9x16';
const YT = 'youtube-16x9';
const out = (format: string, w: number, h: number) => ({ format, file: `${format}.mp4`, width: w, height: h, durationSec: 20, verified: true, preview: null });
const version: VersionEntry = {
  n: 4, commit: 'c', sessionId: 's', status: 'complete', createdAt: '2026-10-22T10:00:00.000Z', request: '', problems: [], tools: [], renderCommand: null, basedOn: null,
  outputs: [out(REEL, 1080, 1920), out(YT, 1920, 1080)],
};
const state = (id: string): FormatState => ({ id, history: [4], star: { version: 4, manual: false, newer: null, follows: null }, defaultVersion: 4, exportVersion: 4, starFileMissing: false, linkable: [], follows: null });
const sub = (lang: string) => ({ lang, origin: 'speech', cues: 12, edited: 0, hash: 'a'.repeat(64), timing: { version: 4, format: REEL, fingerprint: 'b'.repeat(64) }, timingChanged: false, staleCues: 0 }) as never;

async function markup(): Promise<string> {
  localStorage.setItem('ms.exportFolder', '/Users/me/Consegne/Lancio estivo');
  const { unmount } = render(
    <I18nProvider locale="it">
      <ExportDialog open onClose={() => {}} slug="acme" creative="promo" title="Promo autunno" snapshot={{ versions: [version], states: { [REEL]: state(REEL), [YT]: state(YT) } }}
        presets={DEFAULT_FORMATS} pattern="{title}-{format}-v{v}" subtitles={[sub('it'), sub('en'), sub('pt-BR')]} />
    </I18nProvider>,
  );
  try {
    for (const name of [/^Nel video.*inglese/i, /^Nel video.*italiano/i, /^File \.srt e \.vtt.*italiano/i, /^File \.srt e \.vtt.*inglese/i, /^Traccia nel file MP4.*italiano/i]) {
      await userEvent.click(screen.getByRole('checkbox', { name }));
    }
    expect(screen.getByText('File e tracce vanno con un video senza sottotitoli disegnati.')).toBeTruthy();
    return (document.querySelector('.ms-modal') as HTMLElement).outerHTML;
  } finally { unmount(); }
}

/** Review round 1: a plain export (no subtitle sets) of eight rendered video formats, as after decision 1726. */
async function plainMarkup(): Promise<string> {
  const presets = DEFAULT_FORMATS.filter((p) => p.kind !== 'image').slice(0, 8);
  const hash = (i: number) => String(i).repeat(64);
  const v: VersionEntry = { ...version, n: 5,
    compositions: presets.map((p, i) => ({ format: p.id, dir: `compositions/${p.id}`, hash: hash(i) })),
    outputs: presets.map((p, i) => ({ ...out(p.id, p.width, p.height), sha256: 'f'.repeat(64), fromComposition: hash(i) })) };
  const st = (id: string): FormatState => ({ ...state(id), history: [5], star: { version: 5, manual: false, newer: null, follows: null }, defaultVersion: 5, exportVersion: 5 });
  const { unmount } = render(
    <I18nProvider locale="it">
      <ExportDialog open onClose={() => {}} slug="acme" creative="promo" title="Promo autunno" snapshot={{ versions: [v], states: Object.fromEntries(presets.map((p) => [p.id, st(p.id)])) }}
        presets={DEFAULT_FORMATS} pattern="{title}-{format}-v{v}" />
    </I18nProvider>,
  );
  try {
    expect(screen.queryByText('Sottotitoli')).toBeNull();
    expect(document.querySelectorAll('.ms-exp-row:not(.ms-exp-cols)')).toHaveLength(8);
    return (document.querySelector('.ms-modal') as HTMLElement).outerHTML;
  } finally { unmount(); }
}
const PLAIN = `(() => {
  const list = document.querySelector('.ms-exp-rows').getBoundingClientRect();
  const foot = document.querySelector('.ms-exp-foot').getBoundingClientRect();
  const run = [...document.querySelectorAll('.ms-exp-foot .ms-btn')].map((b) => b.getBoundingClientRect());
  const rows = [...document.querySelectorAll('.ms-exp-row:not(.ms-exp-cols)')].filter((r) => { const b = r.getBoundingClientRect(); return b.top >= list.top - 0.5 && b.bottom <= list.bottom + 0.5; });
  return { rowsShown: rows.length, footInView: foot.top >= 0 && foot.bottom <= innerHeight + 0.5 && run.every((b) => b.bottom <= innerHeight + 0.5 && b.right <= innerWidth), sideways: document.documentElement.scrollWidth > innerWidth };
})()`;

const MEASURE = `(() => {
  const dialog = document.querySelector('.ms-dialog');
  const d = dialog.getBoundingClientRect();
  const section = document.querySelector('.ms-exp-subs');
  const s = section.getBoundingClientRect();
  const rows = [...section.querySelectorAll('.ms-exp-subs-row')];
  const note = section.querySelector('.ms-exp-subs-note');
  const preview = document.querySelector('.ms-exp-subs-out');
  const list = document.querySelector('.ms-exp-rows');
  const first = list.querySelector('.ms-exp-row:not(.ms-exp-cols)');
  return {
    dialogWidth: Math.round(d.width),
    formatRowShown: list.getBoundingClientRect().height >= first.getBoundingClientRect().height + first.offsetTop - list.offsetTop - 1,
    sideways: document.documentElement.scrollWidth > innerWidth || dialog.scrollWidth > dialog.clientWidth + 1 || section.scrollWidth > section.clientWidth + 1
      || [...document.querySelectorAll('.ms-exp-preview')].some((p) => p.scrollWidth > p.clientWidth + 1),
    dialogInside: d.left >= -0.5 && d.right <= innerWidth + 0.5,
    sectionInside: within(s, d),
    rows: rows.length,
    out: [...outside(section, '.ms-exp-subs-row, .ms-exp-lang, .ms-exp-subs-name b, .ms-exp-subs-name .ms-faint, .ms-exp-subs-note, .ms-exp-subs-out', s), ...outside(preview, '.ms-exp-preview-line', preview.getBoundingClientRect())],
    checks: rows.map((r) => r.querySelectorAll('[role="checkbox"]').length),
    note: !!note && note.getBoundingClientRect().height > 0,
    previewLines: [...preview.querySelectorAll('.ms-exp-preview-line')].map((l) => l.textContent),
  };
})()`;
type M = { dialogWidth: number; formatRowShown: boolean; sideways: boolean; dialogInside: boolean; sectionInside: boolean; rows: number; out: string[]; checks: number[]; note: boolean; previewLines: string[] };

const run = chromePath ? describe : describe.skip;
if (!chromePath && chromeRequired) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('the export dialog\'s Sottotitoli section: real Chrome layout (Task 22)', () => {
  const rig = new LayoutRig();
  let html = '';
  let plain = '';
  beforeAll(async () => { await rig.start(); html = await markup(); plain = await plainMarkup(); }, 120_000);
  afterAll(() => rig.stop(), 60_000);

  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: a plain export of eight formats (no subtitles) shows at least three rows and the footer in 1024 × 700`, async () => {
      const r = await rig.measure<{ rowsShown: number; footInView: boolean; sideways: boolean }>(plain, PLAIN, { name: 'export-plain', width: 1024, height: 700, theme }, 'export-subs-plain8');
      expect(r.rowsShown).toBeGreaterThanOrEqual(3);
      expect(r.footInView).toBe(true);
      expect(r.sideways).toBe(false);
    }, 120_000);
    for (const dialog of [760, 520]) {
    it(`${theme}, a ${dialog} px dialog in 1024 × 700: three rows with a check per language, the note and the preview inside the dialog, nothing sideways`, async () => {
      const page = html.replace('style="width: 760px;"', `style="width: ${dialog}px;"`);
      expect(page).toContain(`width: ${dialog}px`);
      const r = await rig.measure<M>(page, MEASURE, { name: `export-subs-${dialog}`, width: 1024, height: 700, theme }, `export-subs-dialog${dialog}`);
      expect(r.dialogWidth).toBe(dialog);
      expect(r.formatRowShown, 'the formats list keeps a row in view').toBe(true);
      expect(r.sideways, 'nothing scrolls sideways').toBe(false);
      expect(r.dialogInside).toBe(true);
      expect(r.sectionInside).toBe(true);
      expect(r.rows).toBe(3);
      expect(r.checks).toEqual([3, 3, 3]);
      expect(r.out, 'rows, checks, hints, note and preview lines inside their box').toEqual([]);
      expect(r.note).toBe(true);
      expect(r.previewLines.some((l) => l.includes('-sub-en.mp4'))).toBe(true);
      expect(r.previewLines.some((l) => l.includes('.it.srt'))).toBe(true);
    }, 120_000);
    }
  }
});
