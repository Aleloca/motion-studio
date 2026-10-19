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
const { chosenSections, chosenView, readVariantView, variantViewKey, CHOSEN_LAYOUT } = await import('../src/screens/variants/variantModel.ts');
const { fitBoards, fitSections, canvasGroups, FIT_MIN } = await import('../src/screens/canvasModel.ts');
const { presetFor } = await import('../src/instances.ts');
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
  it('report 52: "Scelte" is laid out as the plain canvas: its sections\' boards in the canvas\'s groups and lines', () => {
    const b = (format: string) => ({ id: format, preset: presetFor(DEFAULT_FORMATS, format), out: null });
    const pack = new Set(['appstore-iphone-69', 'playstore-phone-9x16']);
    const sections = chosenSections([b('appstore-iphone-69'), b('playstore-phone-9x16'), b('youtube-16x9')], [b('tiktok-9x16')], pack);
    // The groups of the formats column (a store pack by store, alone on its lines), "Senza scelta" with its hint under it.
    expect(sections.map((s) => s.groups.map((g) => g.boards.map((x) => x.id)))).toEqual([[['appstore-iphone-69'], ['playstore-phone-9x16'], ['youtube-16x9']], [['tiktok-9x16']]]);
    expect(sections[0]!.groups).toEqual(canvasGroups([b('appstore-iphone-69'), b('playstore-phone-9x16'), b('youtube-16x9')], pack));
    expect(sections[1]!.head).toBeGreaterThan(sections[0]!.head);
    // Nothing without a choice: one section.
    expect(chosenSections([b('youtube-16x9')], [], pack)).toHaveLength(1);
    // A single 16:9 opens at the zoom the plain canvas would give it.
    const one = chosenSections([b('youtube-16x9')], [], pack);
    expect(fitSections(one, { width: 820, height: 700 }, FIT_MIN, CHOSEN_LAYOUT)).toBe(fitBoards(canvasGroups([b('youtube-16x9')], pack), { width: 820, height: 700 }, FIT_MIN));
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
    await waitFor(() => expect(chosen.querySelectorAll('.ms-cv-board')).toHaveLength(1));
    const cell = chosen.querySelector('.ms-cv-board')!;
    // Report 52: a board of the canvas, its header with the variant's letter and short name above the format's name.
    expect(cell.querySelector('.ms-cv-board-name')?.getAttribute('title')).toBe('Instagram · Post 1:1');
    const from = cell.querySelector('.ms-cv-board-from')!;
    expect(from.querySelector('.ms-vcard-letter')?.textContent).toBe('C');
    expect(from.textContent).toContain('Giocosa');
    // The chosen version (v2 of C), not the version C's card shows (v3).
    await waitFor(() => expect(cell.querySelector('img')?.getAttribute('src')).toBe(`/f/acme/${HOST}~c/outputs/v2/post.png`));
    const open = screen.getByRole('region', { name: 'Senza scelta' });
    await waitFor(() => expect(open.querySelectorAll('.ms-cv-board')).toHaveLength(1));
    expect(open.querySelector('.ms-cv-board-name')?.getAttribute('title')).toBe('TikTok · Video 9:16');
    expect(open.querySelector('.ms-cv-board-from')?.textContent).toContain('Regola predefinita');
    expect(open.textContent).toContain('sceglili in Selezione finale');
    // Report 52: no card at all in this view (the sections are headings on the canvas, the boards in its lines); the final
    // selection is still there.
    expect(document.querySelectorAll('.ms-vcard')).toHaveLength(0);
    expect(document.querySelector('.ms-cv-world')!.classList.contains('ms-cv-lined')).toBe(true);
    expect(chosen.querySelectorAll('.ms-cv-line')).toHaveLength(1);
    expect(chosen.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it('report 52: "Scelte" opens fitted as the plain canvas (width and height), the cards\' view to its cards', async () => {
    group = picked();
    plan = [item('instagram-post-1x1', 'c', 2, 'pick'), item('tiktok-9x16', 'a', 2, 'default')];
    const size = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? 800 : 0; });
    const high = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? 900 : 0; });
    try {
      render(<Harness />);
      await screen.findByRole('region', { name: 'Scelte' });
      const z = () => (document.querySelector('.ms-cv-world') as HTMLElement).style.getPropertyValue('--cv-z');
      const b = (format: string) => ({ id: format, preset: presetFor(DEFAULT_FORMATS, format), out: null });
      const want = fitSections(chosenSections([b('instagram-post-1x1')], [b('tiktok-9x16')], new Set()), { width: 800, height: 900 }, FIT_MIN, CHOSEN_LAYOUT)!;
      // The two sections one above the other fill the height: below 100% (three cards at 800 px would be 65%).
      expect(want).toBeLessThan(1);
      expect(want).not.toBe(0.65);
      await waitFor(() => expect(z()).toBe(String(want)));
      await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Vista delle varianti' })).getByRole('radio', { name: 'Tutte le varianti' }));
      await waitFor(() => expect(z()).toBe('0.65'));
    } finally { size.mockRestore(); high.mockRestore(); }
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
    const cell = await waitFor(() => { const el = chosen.querySelector('[data-board$="instagram-post-1x1"]'); expect(el).toBeTruthy(); return el!; });
    expect(cell.textContent).not.toContain('Nessuna variante ha ancora questo formato');
    expect(within(cell as HTMLElement).getByRole('status')).toBeTruthy();
    release();
    await waitFor(() => expect(chosen.querySelector('[data-board] img')).toBeTruthy());
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
