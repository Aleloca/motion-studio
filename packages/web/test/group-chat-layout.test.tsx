/**
 * Phase 3–5 of the single agent, review of feat/single-agent-coordinator: the new chat rows (a helper's folded row, the group
 * turn's "worked on" line), the group composer's note with other variants' comments, and the Activity center's child rows,
 * measured in real Chrome at narrow and wide panel widths: nothing leaves its row, the page never scrolls sideways, a long
 * helper step is ellipsized (its full text in the title), the Activity child rows sit under their group row. The markup is
 * rendered in jsdom and given the real stylesheets. Without Chrome the measuring tests are skipped (MS_REQUIRE_CHROME=1
 * makes a missing browser a failure).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, waitFor } from '@testing-library/react';
import type { ConversationEntry, JobSummary, Pin } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';

const at = '2026-10-18T10:00:00.000Z';
const api = {
  sendCreativeTurn: vi.fn(), stopJob: vi.fn(), getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: true, interrupt: true, checkedAt: at })),
  postLiveMessage: vi.fn(), redirectJob: vi.fn(), removeQueued: vi.fn(), editQueued: vi.fn(), reorderQueue: vi.fn(), runNext: vi.fn(), decideApproval: vi.fn(),
  getConversation: vi.fn(async () => []), cancelJob: vi.fn(),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { Conversation } = await import('../src/components/Conversation.tsx');
const { ActivityCenter } = await import('../src/shell/ActivityCenter.tsx');

const src = (p: string) => readFileSync(join(import.meta.dirname, '../src', p), 'utf8');
const CSS = ['theme.css', 'ui/ui.css', 'components/conversation.css', 'components/services.css', 'shell/shell.css'].map(src).join('\n');
const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;

const LONG = 'Ingrandisco il titolo principale e ricalcolo le distanze dei testi secondari in tutti i formati verticali e orizzontali';
const pin = (variant: string, note: string): Pin => ({ format: 'instagram-post-1x1', x: 0.5, y: 0.5, timeSec: 1.5, note, variant });
const HOST = 'lancio-estivo-con-un-titolo-molto-lungo';
const entries: ConversationEntry[] = [
  { type: 'user', at, text: 'Varianti B, C e AA: più contrasto', pins: [pin('c', 'qui')], attachments: [], jobId: 'g1', group: true },
  { type: 'agent', at, jobId: 'g1', event: { kind: 'text', text: 'Lavoro su B, C e AA.' }, group: true },
  { type: 'agent', at, jobId: 'hc', event: { kind: 'text', text: 'Fatto' }, variant: 'c', groupJobId: 'g1' },
  { type: 'version', at, n: 12, status: 'incomplete', variant: 'c', groupJobId: 'g1' },
  { type: 'agent', at, jobId: 'haa', event: { kind: 'text', text: 'Niente da cambiare' }, variant: 'aa', groupJobId: 'g1' },
  { type: 'system', at, level: 'info', text: 'Nessuna modifica', keptVersion: 3, variant: 'aa', groupJobId: 'g1' },
  { type: 'group-turn', at, jobId: 'g1', group: true, outcome: [
    { variant: 'b', jobId: 'hb', version: null, kept: false, status: 'failed' },
    { variant: 'c', jobId: 'hc', version: 12, kept: false, status: 'incomplete' },
    { variant: 'aa', jobId: 'haa', version: 3, kept: true, status: 'unchanged' },
  ], usage: { tokens: { input: 1200, output: 34_000, cacheRead: 0, cacheWrite: 900 }, costUsd: 1.23 } },
];
const group: JobSummary = { id: 'g2', key: `group:creative:/w:acme:${HOST}`, kind: 'creative-group', label: `${HOST} · agente`, state: 'running', createdAt: at, groupPhase: 'helpers' };
const helper = (v: string, over: Partial<JobSummary> = {}): JobSummary => ({ id: `h${v}`, key: `creative:/w:acme:${HOST}~${v}`, kind: 'creative', label: 'Lancio', state: 'running', createdAt: at, parentJobId: 'g2', variant: v, ...over });

async function chatMarkup(locale: 'it' | 'en'): Promise<string> {
  const { container, unmount } = render(
    <I18nProvider locale={locale}>
      <Conversation slug="acme" creative={`${HOST}~b`} entries={entries} approvals={[]} job={{ ...group, groupPhase: 'helpers' }} single self="b"
        pins={[pin('b', 'il titolo qui è troppo piccolo e troppo vicino al bordo superiore')]} otherPins={[pin('aa', 'logo'), pin('c', LONG)]} onRemoveOtherPin={vi.fn()} onRemovePin={vi.fn()}
        memberJobs={[{ job: helper('b'), live: [{ kind: 'progress', text: LONG }], variant: 'b' }]} />
    </I18nProvider>,
  );
  await waitFor(() => { expect(container.querySelector('[data-helper]')).toBeTruthy(); });
  const html = container.innerHTML;
  unmount();
  return html;
}

async function idleComposerMarkup(locale: 'it' | 'en'): Promise<string> {
  const { container, unmount } = render(
    <I18nProvider locale={locale}>
      <Conversation slug="acme" creative={HOST} entries={[]} approvals={[]} job={undefined} single self="a" pins={[]} otherPins={[pin('b', LONG), pin('aa', 'logo')]} onRemoveOtherPin={vi.fn()} />
    </I18nProvider>,
  );
  const html = (container.querySelector('form.ms-composer') as HTMLElement).outerHTML;
  unmount();
  return html;
}

function activityMarkup(locale: 'it' | 'en'): string {
  const live = { approvals: {}, jobs: Object.fromEntries([group, helper('b'), helper('c', { state: 'queued', waitReason: 'variant-slot' }), helper('aa')].map((j) => [j.id, j])),
    events: { hb: [{ kind: 'progress', text: LONG }] }, creativeTicks: {}, projectTicks: {} } as unknown as EventsState;
  const { container, unmount } = render(<I18nProvider locale={locale}><ActivityCenter live={live} initialTab="running" where={(p, c) => `${p} · ${c}`} /></I18nProvider>);
  // As in its popover, whose padding the center's negative margin takes back.
  const html = `<div style="padding:8px">${container.innerHTML}</div>`;
  unmount();
  return html;
}

const MEASURE = `(() => {
const problems = [];
const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
if (document.documentElement.scrollWidth > innerWidth) problems.push('page overflows ' + document.documentElement.scrollWidth);
const box = document.getElementById('w').getBoundingClientRect();
for (const el of document.querySelectorAll('#w *')) {
  if (!vis(el)) continue;
  const r = el.getBoundingClientRect();
  if (r.width === 0) continue;
  if (r.right > box.right + 0.5 || r.left < box.left - 0.5) problems.push('outside: ' + (el.className.baseVal ?? el.className) + ' ' + (el.textContent || '').slice(0, 30));
}
// A helper row: its button stays in its row; a clipped step is ellipsized and carries its full text in the title.
const rows = [...document.querySelectorAll('[data-helper]')].map((h) => {
  const b = h.querySelector('button').getBoundingClientRect();
  const hr = h.getBoundingClientRect();
  if (b.right > hr.right + 0.5) problems.push('helper button leaves its row ' + h.dataset.helper);
  const t = h.querySelector('.ms-convo-helper-text');
  const clipped = t.scrollWidth > t.clientWidth + 1;
  if (clipped && (getComputedStyle(t).textOverflow !== 'ellipsis' || !t.title)) problems.push('helper text clipped without ellipsis/title');
  if (b.height > 30) problems.push('helper row wraps ' + b.height);
  return { v: h.dataset.helper, clipped };
});
// Activity: the child rows are under their group row, inside it, indented.
const parent = document.querySelector('.ms-activity-parent');
let children = null;
if (parent) {
  const head = parent.querySelector(':scope > .ms-activity-row').getBoundingClientRect();
  const list = parent.querySelector(':scope > .ms-activity-children').getBoundingClientRect();
  if (list.top < head.bottom - 0.5) problems.push('child rows beside, not under, their group row');
  if (list.left <= head.left) problems.push('child rows not indented');
  children = parent.querySelectorAll('.ms-activity-children > li').length;
}
const note = document.querySelector('.ms-composer-group');
if (note && note.scrollWidth > note.clientWidth + 1) problems.push('group note clipped');
const groupTurn = document.querySelector('[data-group-turn]');
return ({ problems, rows, children, note: !!note && vis(note), groupTurn: !!groupTurn && vis(groupTurn) });
})()`;

const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('group chat, group composer and Activity child rows: real Chrome layout', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-group-layout-')); browser = await launchChrome(chrome!); }, 120_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  type Measure = { problems: string[]; rows: Array<{ v: string; clipped: boolean }>; children: number | null; note: boolean; groupTurn: boolean };
  async function measure(html: string, width: number, name: string, wide = false): Promise<Measure> {
    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${CSS}
      body{margin:0}${wide ? ' #w *{letter-spacing:.07em !important}' : ''} #w{width:${width}px;box-sizing:border-box;position:relative}
      #w .ms-convo{height:1600px} #w .ms-convo-list{overflow:visible}</style></head><body><div id="w">${html}</div></body></html>`;
    const file = join(dir, `${name}-${width}${wide ? '-wide' : ''}.html`);
    writeFileSync(file, page);
    const tab = await browser.newPage(width + 40, 1800);
    try {
      await tab.goto(`file://${file}`);
      return await tab.eval<Measure>(MEASURE, 30_000);
    } finally { await tab.close(); }
  }

  for (const locale of ['it', 'en'] as const) {
    it(`${locale}: the chat's helper rows and the "worked on" line stay in the panel at 300–760 px`, async () => {
      const html = await chatMarkup(locale);
      for (const width of [300, 360, 480, 760]) {
        for (const wide of [false, true]) {
          const r = await measure(html, width, `${locale}-chat`, wide);
          expect(r.problems, `${locale} chat @${width}${wide ? ' wide' : ''}`).toEqual([]);
          expect(r.rows.map((x) => x.v).sort(), 'the rows are there').toEqual(['aa', 'b', 'c']);
          expect(r.groupTurn).toBe(true);
        }
      }
      // A long step is ellipsized at a narrow width (never vacuous).
      expect((await measure(html, 300, `${locale}-chat`)).rows.find((x) => x.v === 'b')!.clipped).toBe(true);
    }, 120_000);

    it(`${locale}: the group composer's note and other variants' comments fit at 300–760 px`, async () => {
      const html = await idleComposerMarkup(locale);
      for (const width of [300, 360, 480, 760]) {
        for (const wide of [false, true]) {
          const r = await measure(html, width, `${locale}-composer`, wide);
          expect(r.problems, `${locale} composer @${width}${wide ? ' wide' : ''}`).toEqual([]);
          expect(r.note, 'the group note shows').toBe(true);
        }
      }
    }, 120_000);

    // The Activity center is a 440 px popover (TopBars), narrower only in a very small window.
    it(`${locale}: the Activity center's group row has its helpers under it at 380 and 440 px`, async () => {
      const html = activityMarkup(locale);
      for (const width of [380, 440]) {
        for (const wide of [false, true]) {
          const r = await measure(html, width, `${locale}-activity`, wide);
          expect(r.problems, `${locale} activity @${width}${wide ? ' wide' : ''}`).toEqual([]);
          expect(r.children, 'three child rows').toBe(3);
        }
      }
    }, 120_000);
  }
});
