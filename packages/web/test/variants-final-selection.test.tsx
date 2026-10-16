/**
 * Phase 15, Task 5: "Selezione finale" (spec §5) and Review Focus 2 and 3 on the UI side: a ★ whose format was removed, or whose
 * variant was discarded or is missing, never throws and never shows as a pick; the format falls back to the default rule.
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
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async (_s: string, c: string) => build(c)),
  getConversation: vi.fn(async () => []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  getUsage: vi.fn(async () => { throw new Error('offline'); }),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: false, interrupt: false, checkedAt: at })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { CreativeCanvas } = await import('../src/screens/CreativeCanvas.tsx');
const { finalSelection } = await import('../src/screens/variants/variantModel.ts');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { __resetPendingPins } = await import('../src/screens/pendingPins.ts');

const emptyLive = (): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState);
function Harness({ locale = 'it' }: { locale?: 'it' | 'en' }) {
  const live = emptyLive();
  const shell = {
    route: { name: 'creative', slug: 'acme', creative: HOST }, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as unknown as Shell;
  return (
    <I18nProvider locale={locale}>
      <ShellContext.Provider value={shell}>
        <header className="ms-topbar"><TopBar /></header>
        <CreativeCanvas slug="acme" creative={HOST} live={live} />
      </ShellContext.Provider>
    </I18nProvider>
  );
}
const open = async (name = 'Selezione finale') => {
  await screen.findByRole('region', { name: /^Variante? A$/ });
  await userEvent.click(screen.getByRole('button', { name }));
  return screen.findByRole('dialog', { name });
};
const rows = (dialog: HTMLElement) => within(dialog).getAllByRole('listitem').map((li) => li.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  group = groupOf(['a', 'b', 'c']);
  missing = [];
  formats = ['instagram-post-1x1', 'tiktok-9x16'];
  __resetPendingPins();
  localStorage.clear();
  location.hash = '#/p/acme/c/lancio';
});

describe('finalSelection (the rows)', () => {
  const g = (picks: VariantGroup['picks'], extra: Parameters<typeof groupOf>[2] = {}) => groupOf(['a', 'b', 'c'], { picks }, extra);
  const star = (f: string) => (f === 'tiktok-9x16' ? 2 : 1);
  it('one row per format of the brief: the ★ (variant, version) or the default rule on A', () => {
    expect(finalSelection(g({ 'instagram-post-1x1': { slug: `${HOST}~c`, version: 3 } }), ['instagram-post-1x1', 'tiktok-9x16'], [], star)).toEqual([
      { format: 'instagram-post-1x1', source: 'pick', variant: 'c', n: 3 },
      { format: 'tiktok-9x16', source: 'default', variant: 'a', n: 2 },
    ]);
  });
  it('a format with no version at all has no variant in its default row', () => {
    expect(finalSelection(g({}), ['instagram-post-1x1'], [], () => null)).toEqual([{ format: 'instagram-post-1x1', source: 'default', variant: null, n: null }]);
  });
  it('Review Focus 2: a ★ of a format the brief no longer has is not listed, and does not throw', () => {
    const rowsOf = finalSelection(g({ 'tiktok-9x16': { slug: `${HOST}~c`, version: 2 }, 'instagram-post-1x1': { slug: `${HOST}~b`, version: 1 } }), ['instagram-post-1x1'], [], star);
    expect(rowsOf).toEqual([{ format: 'instagram-post-1x1', source: 'pick', variant: 'b', n: 1 }]);
  });
  it('Review Focus 3: a ★ of a discarded or missing variant, or of a slug that is not in the group, falls back to the default rule', () => {
    const picks = { 'instagram-post-1x1': { slug: `${HOST}~c`, version: 3 }, 'tiktok-9x16': { slug: 'ghost~z', version: 1 } };
    const discarded = finalSelection(g(picks, { c: { status: 'discarded' } }), ['instagram-post-1x1', 'tiktok-9x16'], [], star);
    expect(discarded.map((r) => r.source)).toEqual(['default', 'default']);
    const gone = finalSelection(g(picks), ['instagram-post-1x1'], ['c'], star);
    expect(gone[0]).toMatchObject({ source: 'default', variant: 'a' });
  });
  it('a format named like an object property does not trip it', () => {
    expect(() => finalSelection(g({}), ['constructor', '__proto__', 'toString'], [], () => null)).not.toThrow();
  });
});

describe('Selezione finale (the popover)', () => {
  it('lists, format by format, which variant and version the ★ comes from, and "regola predefinita" without one', async () => {
    group = groupOf(['a', 'b', 'c'], { picks: { 'instagram-post-1x1': { slug: `${HOST}~c`, version: 3 } } });
    render(<Harness />);
    const dialog = await open();
    await waitFor(() => expect(rows(dialog)).toEqual([
      'Instagram · Post 1:1 · Variante C · v3',
      'TikTok · Video 9:16 · Variante A · v2 · regola predefinita',
    ]));
  });

  it('with no ★ at all every format says "regola predefinita"', async () => {
    render(<Harness />);
    const dialog = await open();
    expect(rows(dialog).every((r) => /regola predefinita$/.test(r ?? ''))).toBe(true);
  });

  it('Review Focus 2: after a format is removed, its stale ★ is not in the summary and nothing throws', async () => {
    formats = ['instagram-post-1x1'];
    group = groupOf(['a', 'b', 'c'], { picks: { 'instagram-post-1x1': { slug: `${HOST}~b`, version: 1 }, 'tiktok-9x16': { slug: `${HOST}~c`, version: 2 } } });
    render(<Harness />);
    const dialog = await open();
    expect(rows(dialog)).toEqual(['Instagram · Post 1:1 · Variante B · v1']);
    expect(within(dialog).queryByText(/Video 9:16/)).toBeNull();
  });

  it('Review Focus 3: the ★s of a discarded variant read as the default rule, and a restored one has none', async () => {
    group = groupOf(['a', 'b', 'c'], { picks: { 'instagram-post-1x1': { slug: `${HOST}~c`, version: 3 } } }, { c: { status: 'discarded' } });
    render(<Harness />);
    const dialog = await open();
    expect(rows(dialog)[0]).toBe('Instagram · Post 1:1 · Variante A · v2 · regola predefinita');
  });

  it('a missing variant\'s ★ reads as the default rule too', async () => {
    missing = ['c'];
    group = groupOf(['a', 'b', 'c'], { picks: { 'instagram-post-1x1': { slug: `${HOST}~c`, version: 3 } } });
    render(<Harness />);
    const dialog = await open();
    expect(rows(dialog)[0]).toMatch(/regola predefinita$/);
  });

  it('is in English', async () => {
    group = groupOf(['a', 'b', 'c'], { picks: { 'tiktok-9x16': { slug: `${HOST}~b`, version: 1 } } });
    render(<Harness locale="en" />);
    const dialog = await open('Final selection');
    expect(rows(dialog)).toEqual(['Instagram · Post 1:1 · Variant A · v2 · default rule', 'TikTok · Video 9:16 · Variant B · v1']);
  });
});
