/**
 * Phase 15, Task 5: a creative without a variant group renders EXACTLY as it did before the variants (no selector, no toggle, no
 * new toolbar items, no new markup). The fixtures are the canvas of such a creative as the code of the commit before this task
 * rendered it (idle in Italian, working in English), with the generated ids normalised; this test renders it with the current
 * code and compares. Decision 973 changed the canvas on purpose (no tool bar, a Comment button on each board): the fixtures were
 * made again from that code (`MS_UPDATE_GOLDEN=1` writes them), and again for report 40 (the boards in lines, one per group of the formats column), and still guard the ungrouped canvas against the variant code.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_FORMATS, type ConversationEntry, type JobSummary } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { at, detailFor, version } from './support/variants.ts';
import { settled } from './support/settle.ts';

vi.setConfig({ testTimeout: 60_000 });
const detail = detailFor('lancio', [version(1, 'Dal brief'), version(2, 'Più chiaro')], null);
const conversation: ConversationEntry[] = [
  { type: 'user', at, text: 'Fallo più chiaro', pins: [], attachments: [] },
  { type: 'agent', at, jobId: 'j0', event: { kind: 'text', text: 'Fatto, ecco la versione 2.' } },
  { type: 'version', at, n: 2, status: 'complete' },
];
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async () => detail),
  getConversation: vi.fn(async () => conversation),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  getUsage: vi.fn(async () => { throw new Error('offline'); }),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: true, interrupt: true, checkedAt: at })),
  getPinFrames: vi.fn(async () => ({ n: 1, expiresAt: at, frames: [] })),
  sendCreativeTurn: vi.fn(), setExportPick: vi.fn(), stopJob: vi.fn(),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { CreativeCanvas } = await import('../src/screens/CreativeCanvas.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');

// Generated ids are normalised, and so is the text of a <time> (it is the local time of the machine: the test must not depend on its zone).
const norm = (html: string) => html.replace(/:r[0-9a-z]+:|_r_[0-9a-z]+_/g, 'ID').replace(/(<time\b[^>]*>)[^<]*(<\/time>)/g, '$1TIME$2');
const live = (jobs: JobSummary[] = []): EventsState => ({ approvals: {}, jobs: Object.fromEntries(jobs.map((j) => [j.id, j])), events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState);
const running: JobSummary = { id: 'j1', key: 'creative:/w:acme:lancio', kind: 'creative', label: 'Lancio', state: 'running', createdAt: at };
const golden = (name: string, actual: string) => {
  const file = join(import.meta.dirname, 'fixtures', `ungrouped-canvas.${name}.html`);
  if (process.env.MS_UPDATE_GOLDEN === '1') writeFileSync(file, actual);
  return readFileSync(file, 'utf8');
};

function Harness({ l, locale }: { l: EventsState; locale: 'it' | 'en' }) {
  const shell = {
    route: { name: 'creative', slug: 'acme', creative: 'lancio' }, live: l,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as unknown as Shell;
  return (
    <I18nProvider locale={locale}>
      <ShellContext.Provider value={shell}>
        <header className="ms-topbar"><TopBar /></header>
        <CreativeCanvas slug="acme" creative="lancio" live={l} />
      </ShellContext.Provider>
    </I18nProvider>
  );
}
async function html(l: EventsState, locale: 'it' | 'en'): Promise<string> {
  const r = render(<Harness l={l} locale={locale} />);
  await screen.findByRole('img', { name: /Post 1:1 v2/ });
  await waitFor(() => expect(screen.getByRole('log')).toBeTruthy());
  await settled(() => r.container.innerHTML);
  return norm(r.container.innerHTML);
}

beforeEach(() => { localStorage.clear(); location.hash = '#/p/acme/c/lancio'; });

describe('a creative without a variant group', () => {
  it('idle: the canvas is byte for byte the one before the variants', async () => {
    const out = await html(live(), 'it');
    expect(out).toBe(golden('idle-it', out));
  });
  it('working: so is the canvas of a running creative (the chat in its busy mode)', async () => {
    const out = await html(live([running]), 'en');
    expect(out).toBe(golden('working-en', out));
  });
  it('has no selector, no toggle and no variant toolbar', async () => {
    const out = await html(live(), 'it');
    expect(out).not.toMatch(/data-variant-selector|ms-vbar|ms-vstar|ms-vrow|ms-cv-vworld|Raggruppa per|Selezione finale|Mostra scartate/);
    expect(screen.queryByRole('radiogroup', { name: 'Variante' })).toBeNull();
    expect(screen.queryByRole('toolbar', { name: 'Varianti' })).toBeNull();
  });
});
