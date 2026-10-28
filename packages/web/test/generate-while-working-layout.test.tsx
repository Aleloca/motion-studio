/**
 * User report 94 (decisions 1971-1975) in real Chrome (1440 x 900, light, IT): the chat of a variant group while its variants
 * work shows one send button and no "Generate"; a never-started group shows "Generate" beside "Send", on one row. Without
 * Chrome the test is skipped (MS_REQUIRE_CHROME=1 makes a missing browser a failure). MS_LAYOUT_SHOTS=<folder> saves screenshots.
 */
import { render } from '@testing-library/react';
import type { ConversationEntry, JobSummary } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { chromePath, chromeRequired, LayoutRig } from './support/layoutPage.ts';
import { groupOf, HOST } from './support/variants.ts';

const at = '2026-10-28T10:00:00.000Z';
const api = {
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: true, interrupt: true, checkedAt: at })),
  sendCreativeTurn: vi.fn(), postLiveMessage: vi.fn(), redirectJob: vi.fn(), stopJob: vi.fn(), removeQueued: vi.fn(), editQueued: vi.fn(), reorderQueue: vi.fn(), runNext: vi.fn(), decideApproval: vi.fn(),
  getPinFrames: vi.fn(async () => ({ n: 1, expiresAt: at, frames: [] })), fileUrl: () => 'data:,',
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { Conversation } = await import('../src/components/Conversation.tsx');

const group = groupOf(['a', 'b', 'c']);
const job = (id: string, over: Partial<JobSummary> = {}): JobSummary => ({ id, key: `creative:/w:acme:${HOST}`, kind: 'creative', label: 'Lancio', state: 'running', createdAt: at, ...over });
const entries: ConversationEntry[] = [{ type: 'user', at, text: 'Tre identità per Audin: logo, favicon e icona app.', pins: [], attachments: [] } as ConversationEntry];

function html(working: boolean): string {
  const members = working ? [{ job: job('j2', { key: `${HOST}~b` }), live: [], variant: 'b' as const }, { job: job('j3', { key: `${HOST}~c`, state: 'queued', waitReason: 'variant-slot' }), live: [], variant: 'c' as const }] : [];
  const { container, unmount } = render(
    <I18nProvider locale="it">
      <div className="ms-chat-col" style={{ width: 460, height: 800 }}><div className="ms-chat-card">
        <Conversation slug="acme" creative={HOST} entries={entries} approvals={[]} job={working ? job('j1') : undefined} onSent={() => {}} canGenerate={!working} memberJobs={members}
          variants={{ group, current: 'a', all: true, missing: [], onSelect: (() => {}) as never, runAll: async () => ({ jobs: {}, queued: [], skipped: [], failed: {} }) }} />
      </div></div>
    </I18nProvider>);
  const out = container.innerHTML;
  unmount();
  return out;
}

const footButtons = `(() => {
  const foot = document.querySelector('.ms-composer-foot');
  const bs = [...foot.querySelectorAll('button')].filter((b) => b.getClientRects().length && b.type === 'submit' || b.getAttribute('aria-label') === 'Genera');
  const rects = bs.map((b) => b.getBoundingClientRect());
  return { labels: bs.map((b) => b.getAttribute('aria-label')), tops: rects.map((r) => Math.round(r.top)), footRight: foot.getBoundingClientRect().right, rights: rects.map((r) => r.right) };
})()`;

const run = chromePath ? describe : describe.skip;
if (!chromePath && chromeRequired) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('the variant-group chat while the variants work: real Chrome (report 94)', () => {
  const rig = new LayoutRig();
  beforeAll(async () => { await rig.start(); }, 60_000);
  afterAll(async () => { await rig.stop(); }, 60_000);
  type R = { labels: string[]; tops: number[]; footRight: number; rights: number[] };

  it('working: one send button, no Generate', async () => {
    const r = await rig.measure<R>(html(true), footButtons, { name: 'gen-working', width: 1440, height: 900, theme: 'light', reduce: true }, 'gen-working');
    expect(r.labels).toEqual(['Invia']);
  }, 120_000);

  it('never started: Generate and Send on the same row, inside the box', async () => {
    const r = await rig.measure<R>(html(false), footButtons, { name: 'gen-fresh', width: 1440, height: 900, theme: 'light', reduce: true }, 'gen-fresh');
    expect(r.labels).toEqual(['Genera', 'Invia']);
    expect(new Set(r.tops).size).toBe(1);
    expect(Math.max(...r.rights)).toBeLessThanOrEqual(r.footRight + 0.5);
  }, 120_000);
});
