/**
 * Report 49: once the group has a pick, the variants page opens on a "Scelte" view: per format only the chosen variant and
 * version (the group's ★); the formats without a choice under "Senza scelta" with the variant the default rule takes. A
 * "Scelte | Tutte le varianti" switch shows every variant again, remembered per creative; nothing is deleted and the final
 * selection stays.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type VariantGroup, type VariantId, type VersionEntry } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { at, detailFor, groupOf, HOST, version } from './support/variants.ts';

vi.setConfig({ testTimeout: 30_000 });

let group: VariantGroup = groupOf(['a', 'b', 'c']);
const versionsBy: Record<string, VersionEntry[]> = {
  [HOST]: [version(1, 'Dal brief'), version(2, 'Più chiaro')],
  [`${HOST}~b`]: [version(1, 'Dal brief')],
  [`${HOST}~c`]: [version(1, 'Dal brief'), version(2, 'x'), version(3, 'y')],
};
const build = (slug: string) => detailFor(slug, versionsBy[slug] ?? [], group);
type PlanItem = { format: string; slug: string; letter: VariantId; version: number; source: 'pick' | 'default'; file: string; width: number; height: number; state: 'ready' };
const item = (format: string, letter: VariantId, n: number, source: 'pick' | 'default'): PlanItem =>
  ({ format, slug: letter === 'a' ? HOST : `${HOST}~${letter}`, letter, version: n, source, file: `${format}.png`, width: 1080, height: 1080, state: 'ready' });
let plan: PlanItem[] = [];
const api = {
  groupExportPlan: vi.fn(async (_s: string, _c: string) => ({ items: plan, formats: ['instagram-post-1x1', 'tiktok-9x16'] })),
  setVariantPick: vi.fn(async (..._a: unknown[]) => build(HOST)),
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async (_s: string, c: string) => build(c)),
  getConversation: vi.fn(async () => []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  getUsage: vi.fn(async () => { throw new Error('offline'); }),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: false, interrupt: false, checkedAt: at })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { CreativeCanvas } = await import('../src/screens/CreativeCanvas.tsx');
const { chosenColumns, chosenView, fitChosen, readVariantView, variantViewKey } = await import('../src/screens/variants/variantModel.ts');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');

const emptyLive = (): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState);
function Harness({ creative = HOST }: { creative?: string }) {
  const shell = {
    route: { name: 'creative', slug: 'acme', creative }, live: emptyLive(),
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as unknown as Shell;
  return (
    <I18nProvider locale="it">
      <ShellContext.Provider value={shell}>
        <header className="ms-topbar"><TopBar /></header>
        <CreativeCanvas slug="acme" creative={creative} live={emptyLive()} />
      </ShellContext.Provider>
    </I18nProvider>
  );
}
const picked = () => groupOf(['a', 'b', 'c'], { picks: { 'instagram-post-1x1': { slug: `${HOST}~c`, version: 2 } } });

beforeEach(() => {
  vi.clearAllMocks();
  group = groupOf(['a', 'b', 'c']);
  plan = [item('instagram-post-1x1', 'a', 2, 'default'), item('tiktok-9x16', 'a', 2, 'default')];
  localStorage.clear();
  location.hash = '#/p/acme/c/lancio';
});

describe('chosenView (the model)', () => {
  it('a format with a pick is chosen (the plan\'s variant and version); the others go with the default rule, or nothing', () => {
    const g = picked();
    const v = chosenView(['instagram-post-1x1', 'tiktok-9x16', 'youtube-16x9'], g, [item('instagram-post-1x1', 'c', 2, 'pick'), item('tiktok-9x16', 'a', 2, 'default')]);
    expect(v.chosen).toEqual([{ format: 'instagram-post-1x1', letter: 'c', slug: `${HOST}~c`, n: 2 }]);
    expect(v.open).toEqual([{ format: 'tiktok-9x16', letter: 'a', slug: HOST, n: 2 }, { format: 'youtube-16x9', letter: null, slug: null, n: null }]);
  });
  it('until the plan is read, the stored picks stand in', () => {
    const v = chosenView(['instagram-post-1x1', 'tiktok-9x16'], picked(), null);
    expect(v.chosen).toEqual([{ format: 'instagram-post-1x1', letter: 'c', slug: `${HOST}~c`, n: 2 }]);
    expect(v.open).toEqual([{ format: 'tiktok-9x16', letter: null, slug: null, n: null }]);
  });
  it('decision 1334: the opening zoom of "Scelte" puts the widest section\'s boards on one line, within 50%–100%', () => {
    // 1440 px: 4 chosen boards fit at 100%; 8 need less; 30 stop at 50% and wrap.
    expect(fitChosen(4, 1440, 0.5)).toBe(1);
    const z = fitChosen(8, 1440, 0.5)!;
    expect(z).toBeLessThan(1);
    expect(chosenColumns(1440 - 2 * 16 - 2 * 12, 8, z).cols).toBe(8);
    expect(chosenColumns(1440 - 2 * 16 - 2 * 12, 8, z + 0.05).cols).toBeLessThan(8);
    expect(fitChosen(30, 1440, 0.5)).toBe(0.5);
    expect(fitChosen(0, 1440, 0.5)).toBeNull();
    expect(fitChosen(3, 0, 0.5)).toBeNull();
  });
  it('the view: "chosen" by default when there are picks, the remembered one otherwise; storage errors are ignored', () => {
    expect(readVariantView('acme', HOST, true)).toBe('chosen');
    expect(readVariantView('acme', HOST, false)).toBe('all');
    localStorage.setItem(variantViewKey('acme', HOST), 'all');
    expect(readVariantView('acme', HOST, true)).toBe('all');
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readVariantView('acme', HOST, true)).toBe('chosen');
    spy.mockRestore();
  });
});

describe('the "Scelte" view of a variant group', () => {
  it('without picks: the cards of every variant, no switch', async () => {
    render(<Harness />);
    const bar = await screen.findByRole('toolbar', { name: 'Varianti' });
    await waitFor(() => expect(document.querySelectorAll('.ms-vcard[data-variant]')).toHaveLength(3));
    expect(within(bar).queryByRole('radiogroup', { name: 'Vista delle varianti' })).toBeNull();
  });

  it('with a pick: opens on "Scelte", only the chosen variant and version of each format; "Senza scelta" with the default rule', async () => {
    group = picked();
    plan = [item('instagram-post-1x1', 'c', 2, 'pick'), item('tiktok-9x16', 'a', 2, 'default')];
    render(<Harness />);
    const bar = await screen.findByRole('toolbar', { name: 'Varianti' });
    const view = await within(bar).findByRole('radiogroup', { name: 'Vista delle varianti' });
    expect(within(view).getByRole('radio', { name: 'Scelte' }).getAttribute('aria-checked')).toBe('true');
    const chosen = await screen.findByRole('region', { name: 'Scelte' });
    await waitFor(() => expect(chosen.querySelectorAll('.ms-vchosen-cell')).toHaveLength(1));
    const cell = chosen.querySelector('.ms-vchosen-cell')!;
    expect(cell.textContent).toContain('Instagram · Post 1:1');
    expect(cell.textContent).toContain('C');
    expect(cell.textContent).toContain('Giocosa');
    // The chosen version (v2 of C), not the version C's card shows (v3).
    await waitFor(() => expect(cell.querySelector('img')?.getAttribute('src')).toBe(`/f/acme/${HOST}~c/outputs/v2/post.png`));
    const open = screen.getByRole('region', { name: 'Senza scelta' });
    expect(open.querySelectorAll('.ms-vchosen-cell')).toHaveLength(1);
    expect(open.textContent).toContain('TikTok · Video 9:16');
    expect(open.textContent).toContain('Regola predefinita');
    // No variant card in this view; the final selection is still there.
    expect(document.querySelectorAll('.ms-vcard[data-variant]')).toHaveLength(0);
    expect(within(bar).getByRole('button', { name: 'Selezione finale' })).toBeTruthy();
  });

  it('decision 1336: the view belongs to the group: a member\'s page opens on the view chosen from another one, read once', async () => {
    group = picked();
    plan = [item('instagram-post-1x1', 'c', 2, 'pick'), item('tiktok-9x16', 'a', 2, 'default')];
    localStorage.setItem(variantViewKey('acme', HOST), 'all');
    const get = vi.spyOn(Storage.prototype, 'getItem');
    render(<Harness creative={`${HOST}~b`} />);
    await waitFor(() => expect(document.querySelectorAll('.ms-vcard[data-variant]')).toHaveLength(3));
    const reads = () => get.mock.calls.filter(([k]) => k === variantViewKey('acme', HOST)).length;
    const before = reads();
    expect(before).toBeGreaterThan(0);
    // Re-renders of the page (the final selection opening and closing) do not read it again.
    await userEvent.click(screen.getByRole('button', { name: 'Selezione finale' }));
    await screen.findByRole('dialog', { name: 'Selezione finale' });
    expect(reads()).toBe(before);
    get.mockRestore();
  });

  it('"Tutte le varianti" shows the cards again and is remembered for the group', async () => {
    group = picked();
    plan = [item('instagram-post-1x1', 'c', 2, 'pick'), item('tiktok-9x16', 'a', 2, 'default')];
    const { unmount } = render(<Harness />);
    const view = await screen.findByRole('radiogroup', { name: 'Vista delle varianti' });
    await userEvent.click(within(view).getByRole('radio', { name: 'Tutte le varianti' }));
    await waitFor(() => expect(document.querySelectorAll('.ms-vcard[data-variant]')).toHaveLength(3));
    expect(screen.queryByRole('region', { name: 'Scelte' })).toBeNull();
    expect(localStorage.getItem(variantViewKey('acme', HOST))).toBe('all');
    unmount();
    render(<Harness />);
    await waitFor(() => expect(document.querySelectorAll('.ms-vcard[data-variant]')).toHaveLength(3));
    await userEvent.click(within(await screen.findByRole('radiogroup', { name: 'Vista delle varianti' })).getByRole('radio', { name: 'Scelte' }));
    expect(await screen.findByRole('region', { name: 'Scelte' })).toBeTruthy();
    expect(localStorage.getItem(variantViewKey('acme', HOST))).toBe('chosen');
  });

  it('decision 1334: "Scelte" opens fitted to its boards, the cards\' view to its cards', async () => {
    group = picked();
    plan = [item('instagram-post-1x1', 'c', 2, 'pick'), item('tiktok-9x16', 'a', 2, 'default')];
    const size = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? 800 : 0; });
    try {
      render(<Harness />);
      await screen.findByRole('region', { name: 'Scelte' });
      const z = () => (document.querySelector('.ms-cv-world') as HTMLElement).style.getPropertyValue('--cv-z');
      // One board per section: 100% (three cards at 800 px would be 65%).
      await waitFor(() => expect(z()).toBe('1'));
      await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Vista delle varianti' })).getByRole('radio', { name: 'Tutte le varianti' }));
      await waitFor(() => expect(z()).toBe('0.65'));
    } finally { size.mockRestore(); }
  });

  it('decision 1337: while the chosen variant is still being read its cell says it is loading, never "no variant has this format"', async () => {
    group = picked();
    plan = [item('instagram-post-1x1', 'c', 2, 'pick'), item('tiktok-9x16', 'a', 2, 'default')];
    let release: () => void = () => {};
    api.getCreative.mockImplementation(async (_s: string, c: string) => {
      if (c === `${HOST}~c`) await new Promise<void>((r) => { release = r; });
      return build(c);
    });
    render(<Harness />);
    const chosen = await screen.findByRole('region', { name: 'Scelte' });
    const cell = await waitFor(() => { const el = chosen.querySelector('.ms-vchosen-cell'); expect(el).toBeTruthy(); return el!; });
    expect(cell.textContent).not.toContain('Nessuna variante ha ancora questo formato');
    expect(within(cell as HTMLElement).getByRole('status')).toBeTruthy();
    release();
    await waitFor(() => expect(cell.querySelector('img')).toBeTruthy());
    api.getCreative.mockImplementation(async (_s: string, c: string) => build(c));
  });

  it('the ★ of a chosen board still changes the pick (nothing is deleted)', async () => {
    group = picked();
    plan = [item('instagram-post-1x1', 'c', 2, 'pick'), item('tiktok-9x16', 'a', 2, 'default')];
    render(<Harness />);
    const chosen = await screen.findByRole('region', { name: 'Scelte' });
    const star = await within(chosen).findByRole('button', { pressed: true });
    await userEvent.click(star);
    await waitFor(() => expect(api.setVariantPick).toHaveBeenCalledWith('acme', HOST, 'instagram-post-1x1', null));
  });
});
