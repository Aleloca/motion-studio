/**
 * Phase 15, Task 5: "Selezione finale" (spec §5). Final wave I1: the rows are the core's group export plan (`GET …/export-group`,
 * the same selection the export copies), never a selection recomputed in the web: a legacy export pick, a discarded A, a
 * follower and a stale ★ read exactly as the export will take them. The plan is read again after a group change and when a
 * member changes.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type VariantGroup, type VariantLetter, type VersionEntry } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { at, detailFor, groupOf, HOST, version } from './support/variants.ts';

vi.setConfig({ testTimeout: 30_000 });

let group: VariantGroup = groupOf(['a', 'b', 'c']);
let missing: VariantLetter[] = [];
let formats = ['instagram-post-1x1', 'tiktok-9x16'];
const versionsBy: Record<string, VersionEntry[]> = {
  [HOST]: [version(1, 'Dal brief'), version(2, 'Più chiaro')],
  [`${HOST}~b`]: [version(1, 'Dal brief')],
  [`${HOST}~c`]: [version(1, 'Dal brief'), version(2, 'x'), version(3, 'y')],
};
const build = (slug: string) => detailFor(slug, versionsBy[slug] ?? [], group, { missing, formats });
type PlanItem = { format: string; slug: string; letter: VariantLetter; version: number; source: 'pick' | 'default'; file: string; width: number; height: number; state: 'ready' | 'needs-render' | 'missing' };
const item = (format: string, letter: VariantLetter, n: number, source: 'pick' | 'default'): PlanItem =>
  ({ format, slug: letter === 'a' ? HOST : `${HOST}~${letter}`, letter, version: n, source, file: `${format}.png`, width: 1080, height: 1080, state: 'ready' });
let plan: PlanItem[] = [];
const api = {
  groupExportPlan: vi.fn(async (_s: string, _c: string) => ({ items: plan })),
  setVariantPick: vi.fn(async (..._a: unknown[]) => build(HOST)),
  setVariantLayout: vi.fn(async (..._a: unknown[]) => build(HOST)),
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async (_s: string, c: string) => build(c)),
  getConversation: vi.fn(async () => []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  getUsage: vi.fn(async () => { throw new Error('offline'); }),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: false, interrupt: false, checkedAt: at })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { CreativeCanvas } = await import('../src/screens/CreativeCanvas.tsx');
const { selectionRows } = await import('../src/screens/variants/variantModel.ts');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { __resetPendingPins } = await import('../src/screens/pendingPins.ts');

const emptyLive = (): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState);
function Harness({ locale = 'it', live = emptyLive(), creative = HOST }: { locale?: 'it' | 'en'; live?: EventsState; creative?: string }) {
  const shell = {
    route: { name: 'creative', slug: 'acme', creative }, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as unknown as Shell;
  return (
    <I18nProvider locale={locale}>
      <ShellContext.Provider value={shell}>
        <header className="ms-topbar"><TopBar /></header>
        <CreativeCanvas slug="acme" creative={creative} live={live} />
      </ShellContext.Provider>
    </I18nProvider>
  );
}
const open = async (name = 'Selezione finale') => {
  await screen.findByRole('toolbar', { name: /^Variant/ });
  await userEvent.click(screen.getByRole('button', { name }));
  return screen.findByRole('dialog', { name });
};
const rows = (dialog: HTMLElement) => within(dialog).getAllByRole('listitem').map((li) => li.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  api.getCreative.mockImplementation(async (_s: string, c: string) => build(c));
  group = groupOf(['a', 'b', 'c']);
  missing = [];
  formats = ['instagram-post-1x1', 'tiktok-9x16'];
  plan = [item('instagram-post-1x1', 'a', 2, 'default'), item('tiktok-9x16', 'a', 2, 'default')];
  __resetPendingPins();
  localStorage.clear();
  location.hash = '#/p/acme/c/lancio';
});

describe('selectionRows (the rows of the core\'s plan)', () => {
  it('one row per format of the brief, in its order: the plan\'s variant, version and source', () => {
    expect(selectionRows(['instagram-post-1x1', 'tiktok-9x16'], [item('tiktok-9x16', 'a', 2, 'default'), item('instagram-post-1x1', 'c', 3, 'pick')])).toEqual([
      { format: 'instagram-post-1x1', source: 'pick', variant: 'c', n: 3 },
      { format: 'tiktok-9x16', source: 'default', variant: 'a', n: 2 },
    ]);
  });
  it('a format the plan does not have (nothing to export) is the default rule with no variant', () => {
    expect(selectionRows(['instagram-post-1x1'], [])).toEqual([{ format: 'instagram-post-1x1', source: 'default', variant: null, n: null }]);
  });
  it('a format named like an object property does not trip it', () => {
    expect(() => selectionRows(['constructor', '__proto__', 'toString'], [])).not.toThrow();
  });
});

describe('Selezione finale (the popover)', () => {
  it('lists, format by format, the variant and version the export takes, and "regola predefinita" for the default rule', async () => {
    plan = [item('instagram-post-1x1', 'c', 3, 'pick'), item('tiktok-9x16', 'a', 2, 'default')];
    render(<Harness />);
    const dialog = await open();
    await waitFor(() => expect(rows(dialog)).toEqual([
      'Instagram · Post 1:1 · Variante C · v3',
      'TikTok · Video 9:16 · Variante A · v2 · regola predefinita',
    ]));
    expect(api.groupExportPlan).toHaveBeenCalledWith('acme', HOST);
  });

  it('(a) a legacy export pick of the host is not counted: the rows are the plan\'s (A\'s default rule)', async () => {
    versionsBy[HOST] = [version(1, 'Dal brief'), version(2, 'Più chiaro')];
    const legacy = build(HOST);
    api.getCreative.mockImplementation(async (_s: string, c: string) => (c === HOST ? { ...legacy, creative: { ...legacy.creative, exportPicks: { 'instagram-post-1x1': 1 } } } : build(c)));
    plan = [item('instagram-post-1x1', 'a', 2, 'default'), item('tiktok-9x16', 'a', 2, 'default')];
    render(<Harness />);
    const dialog = await open();
    await waitFor(() => expect(rows(dialog)[0]).toBe('Instagram · Post 1:1 · Variante A · v2 · regola predefinita'));
  });

  it('minor (Task 5): opened on a sister whose own brief lags the group\'s, the rows still follow the group\'s formats (the host\'s)', async () => {
    api.getCreative.mockImplementation(async (_s: string, c: string) => (c === `${HOST}~b` ? detailFor(c, versionsBy[c] ?? [], group, { missing, formats: ['instagram-post-1x1'] }) : build(c)));
    plan = [item('instagram-post-1x1', 'a', 2, 'default'), item('tiktok-9x16', 'a', 2, 'default')];
    render(<Harness creative={`${HOST}~b`} />);
    const dialog = await open();
    await waitFor(() => expect(rows(dialog)).toEqual([
      'Instagram · Post 1:1 · Variante A · v2 · regola predefinita',
      'TikTok · Video 9:16 · Variante A · v2 · regola predefinita',
    ]));
  });

  it('(b) A discarded: the default rule comes from the first active variant, as the export takes it (not "A")', async () => {
    group = groupOf(['a', 'b', 'c'], {}, { a: { status: 'discarded' } });
    plan = [item('instagram-post-1x1', 'b', 1, 'default'), item('tiktok-9x16', 'b', 1, 'default')];
    render(<Harness />);
    const dialog = await open();
    await waitFor(() => expect(rows(dialog)).toEqual([
      'Instagram · Post 1:1 · Variante B · v1 · regola predefinita',
      'TikTok · Video 9:16 · Variante B · v1 · regola predefinita',
    ]));
  });

  it('(c) a follower takes its primary\'s variant: shown with that variant, never "regola predefinita" with none', async () => {
    plan = [item('instagram-post-1x1', 'c', 3, 'pick'), item('tiktok-9x16', 'c', 3, 'pick')];
    render(<Harness />);
    const dialog = await open();
    await waitFor(() => expect(rows(dialog)[1]).toBe('TikTok · Video 9:16 · Variante C · v3'));
  });

  it('(d) a stale ★ the core falls back from reads as the fallback, not as ★', async () => {
    group = groupOf(['a', 'b', 'c'], { picks: { 'instagram-post-1x1': { slug: `${HOST}~c`, version: 9 } } });
    plan = [item('instagram-post-1x1', 'a', 2, 'default'), item('tiktok-9x16', 'a', 2, 'default')];
    render(<Harness />);
    const dialog = await open();
    await waitFor(() => expect(rows(dialog)[0]).toBe('Instagram · Post 1:1 · Variante A · v2 · regola predefinita'));
  });

  it('a format the plan does not have reads "regola predefinita" with no variant', async () => {
    formats = ['instagram-post-1x1'];
    plan = [];
    render(<Harness />);
    const dialog = await open();
    await waitFor(() => expect(rows(dialog)).toEqual(['Instagram · Post 1:1 · regola predefinita']));
  });

  it('is read again after a group change (a ★ set here) and when a member changes', async () => {
    const live = emptyLive();
    const { rerender } = render(<Harness live={live} />);
    await open();
    await waitFor(() => expect(api.groupExportPlan).toHaveBeenCalled());
    const calls = api.groupExportPlan.mock.calls.length;
    // A member's tick (its turn ended, a ★ moved there): the plan is asked again.
    plan = [item('instagram-post-1x1', 'b', 1, 'pick'), item('tiktok-9x16', 'a', 2, 'default')];
    rerender(<Harness live={{ ...live, creativeTicks: { [`acme/${HOST}~b`]: 1 } } as EventsState} />);
    await waitFor(() => expect(api.groupExportPlan.mock.calls.length).toBeGreaterThan(calls));
    const dialog = screen.getByRole('dialog', { name: 'Selezione finale' });
    await waitFor(() => expect(rows(dialog)[0]).toBe('Instagram · Post 1:1 · Variante B · v1'));
    // A group change made here (any of them ends in the same reload): the plan is asked again.
    const before = api.groupExportPlan.mock.calls.length;
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(screen.getByRole('toolbar', { name: 'Varianti' })).getByRole('radio', { name: 'Formato' }));
    await waitFor(() => expect(api.setVariantLayout).toHaveBeenCalled());
    await waitFor(() => expect(api.groupExportPlan.mock.calls.length).toBeGreaterThan(before));
  });

  it('is in English', async () => {
    plan = [item('instagram-post-1x1', 'a', 2, 'default'), item('tiktok-9x16', 'b', 1, 'pick')];
    render(<Harness locale="en" />);
    const dialog = await open('Final selection');
    await waitFor(() => expect(rows(dialog)).toEqual(['Instagram · Post 1:1 · Variant A · v2 · default rule', 'TikTok · Video 9:16 · Variant B · v1']));
  });
});
