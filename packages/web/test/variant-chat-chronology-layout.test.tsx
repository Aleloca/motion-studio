/**
 * User reports 96 and 97 (decisions 1983-1995) in real Chrome (1440 x 900, light, IT): a group's chat with two variants working
 * at once reads in time order (A, B, A, A's card with its chip, last), and the canvas of a group whose variants generate with
 * nothing saved yet shows no "Ancora niente di generato" card. Without Chrome the test is skipped (MS_REQUIRE_CHROME=1 makes a
 * missing browser a failure, MS_LAYOUT_CHROME=1 turns it on). MS_LAYOUT_SHOTS=<folder> saves screenshots.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_FORMATS, type AgentEvent, type ApprovalRequest, type ConversationEntry, type JobSummary, type VersionEntry } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { chromePath, chromeRequired, LayoutRig } from './support/layoutPage.ts';
import { settled } from './support/settle.ts';
import { at, detailFor, groupOf, HOST } from './support/variants.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const group = groupOf(['a', 'b', 'c', 'd']);
const versionsBy: Record<string, VersionEntry[]> = {};
const api = {
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: true, interrupt: true, checkedAt: at })),
  sendCreativeTurn: vi.fn(), postLiveMessage: vi.fn(), redirectJob: vi.fn(), stopJob: vi.fn(), removeQueued: vi.fn(), editQueued: vi.fn(), reorderQueue: vi.fn(), runNext: vi.fn(), decideApproval: vi.fn(),
  getPinFrames: vi.fn(async () => ({ n: 1, expiresAt: at, frames: [] })), fileUrl: () => 'data:,',
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async (_s: string, c: string) => detailFor(c, versionsBy[c] ?? [], group, { status: 'working' })),
  getConversation: vi.fn(async () => [] as ConversationEntry[]),
  getUsage: vi.fn(async () => { throw new Error('offline'); }),
  getStoryboard: vi.fn(async () => { throw new Error('none'); }),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { Conversation } = await import('../src/components/Conversation.tsx');
const { CreativeCanvas } = await import('../src/screens/CreativeCanvas.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');

// Times a few minutes before now, so the card's countdown reads as it would in the app.
const BASE = Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000;
const t = (min: number) => new Date(BASE + min * 60_000).toISOString();
const job = (id: string, slug: string, over: Partial<JobSummary> = {}): JobSummary => ({ id, key: `creative:/w:acme:${slug}`, kind: 'creative', label: 'Lancio', state: 'running', createdAt: t(0), ...over });
const said = (min: number, text: string, jobId: string, variant: 'a' | 'b'): ConversationEntry => ({ type: 'agent', at: t(min), jobId, event: { kind: 'text', text }, variant } as ConversationEntry);
const step = (min: number, text: string, jobId: string, variant: 'a' | 'b'): ConversationEntry => ({ type: 'agent', at: t(min), jobId, event: { kind: 'progress', text } as AgentEvent, variant } as ConversationEntry);

function chatHtml(): string {
  const entries: ConversationEntry[] = [
    ...(['a', 'b'] as const).map((variant) => ({ type: 'user', at: t(0), text: 'Tre identità per Audin: logo, favicon e icona app.', pins: [], attachments: [], variant, fanout: 'r1' } as ConversationEntry)),
    said(1, 'Parto dalla direzione minimale: logo a linea singola.', 'ja', 'a'),
    step(1, 'Leggo il brief', 'ja', 'a'),
    said(2, 'Variante B: provo un marchio pieno con colori caldi.', 'jb', 'b'),
    step(2, 'Scrivo la composizione', 'jb', 'b'),
    said(3, 'Il logo è pronto: ora preparo la favicon.', 'ja', 'a'),
  ];
  const approval: ApprovalRequest = {
    id: 'apa', jobId: 'ja', projectSlug: 'acme', creativeSlug: HOST, kind: 'tool', title: 'Eseguire un comando', detail: 'npx svgo logo.svg', toolName: 'Bash',
    alwaysRule: null, explanation: null, agentReason: null, createdAt: t(4), expiresAt: t(14),
  };
  const { container, unmount } = render(
    <I18nProvider locale="it">
      <div className="ms-chat-col" style={{ width: 460, height: 860 }}><div className="ms-chat-card">
        <Conversation slug="acme" creative={HOST} entries={entries} approvals={[approval]} job={job('ja', HOST)} self="a" onSent={() => {}} canGenerate={false}
          memberJobs={[{ job: job('ja', HOST), live: [], variant: 'a' }, { job: job('jb', `${HOST}~b`), live: [], variant: 'b' }]}
          variants={{ group, current: 'a', all: true, missing: [], onSelect: (() => {}) as never, runAll: async () => ({ jobs: {}, queued: [], skipped: [], failed: {} }) }} />
      </div></div>
    </I18nProvider>);
  const out = container.innerHTML;
  unmount();
  return out;
}

async function canvasHtml(): Promise<string> {
  const jobs: Record<string, JobSummary> = {
    ja: job('ja', HOST), jb: job('jb', `${HOST}~b`),
    jc: job('jc', `${HOST}~c`, { state: 'queued', waitReason: 'variant-slot' }), jd: job('jd', `${HOST}~d`, { state: 'queued', waitReason: 'variant-slot' }),
  };
  const live = { approvals: {}, jobs, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState;
  const size = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? 1440 - 252 - 368 : 0; });
  const high = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? 820 : 0; });
  const shell = {
    route: { name: 'creative', slug: 'acme', creative: HOST }, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as unknown as Shell;
  const { container, unmount } = render(
    <I18nProvider locale="it"><ShellContext.Provider value={shell}><CreativeCanvas slug="acme" creative={HOST} live={live} /></ShellContext.Provider></I18nProvider>);
  try {
    await screen.findByRole('region', { name: 'Variante D' });
    await waitFor(() => expect(api.getCreative).toHaveBeenCalledWith('acme', `${HOST}~d`));
    await settled(() => container.innerHTML);
    // jsdom keeps CSS `zoom` (the frames' scale) out of the style attribute: written back, so Chrome lays the frames out as the app does.
    for (const el of container.querySelectorAll<HTMLElement>('.ms-cv-frame')) if (el.style.zoom) el.setAttribute('style', `${el.getAttribute('style') ?? ''}; zoom: ${el.style.zoom}`);
    return (container.querySelector('.ms-cv') as HTMLElement).outerHTML;
  } finally { unmount(); size.mockRestore(); high.mockRestore(); }
}

const run = chromePath ? describe : describe.skip;
if (!chromePath && chromeRequired) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('reports 96 and 97 in real Chrome', () => {
  const rig = new LayoutRig();
  beforeAll(async () => { await rig.start(); }, 60_000);
  afterAll(async () => { await rig.stop(); }, 60_000);

  it('the chat of two variants working at once is in time order, the card last with its chip, nothing cut or outside the panel', async () => {
    const r = await rig.measure<{ order: string[]; cut: string[]; out: string[]; chip: string | null }>(chatHtml(), `(() => {
      const col = document.querySelector('.ms-chat-col');
      const lis = [...document.querySelectorAll('.ms-convo-list > li')];
      const order = lis.map((li) => li.querySelector('.ms-convo-approval') ? 'card' : (li.querySelector('.ms-vchip')?.textContent ?? '-'));
      return { order, cut: cutIn(col, '.ms-vchip, .ms-msg-meta'), out: outside(col, '.ms-vchip, .ms-approval, .ms-msg', col.getBoundingClientRect()),
        chip: document.querySelector('.ms-convo-approval .ms-vchip')?.textContent ?? null };
    })()`, { name: 'vchat-interleaved', width: 1440, height: 900, theme: 'light', reduce: true }, 'vchat-interleaved');
    expect(r.order.filter((x) => x !== '-')).toEqual(['A', 'A', 'B', 'A', 'card']);
    expect(r.chip).toBe('A');
    expect(r.cut).toEqual([]);
    expect(r.out).toEqual([]);
  });

  it('the group generating with nothing saved yet: no "nothing generated" card over the boards', async () => {
    const r = await rig.measure<{ nothing: boolean; overflow: boolean }>(`<div style="height:900px">${await canvasHtml()}</div>`,
      `({ nothing: !!document.querySelector('.ms-cv-nothing'), overflow: document.documentElement.scrollWidth > innerWidth })`,
      { name: 'vchat-generating', width: 1440, height: 900, theme: 'light', reduce: true }, 'vchat-generating');
    expect(r.nothing).toBe(false);
    expect(r.overflow).toBe(false);
  });
});
