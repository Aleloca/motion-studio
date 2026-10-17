/**
 * Phase 15, live check D2: the ★ of the formats column reads the same core plan as "Selezione finale", in both groupings: a row
 * is starred when the plan takes its variant for the format (a pick shows the PICK's version, a default-rule choice is starred
 * too and marked), and no other row is. The column and the popover never disagree.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type VariantGroup, type VariantLetter, type VersionEntry } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { at, detailFor, groupOf, HOST, version } from './support/variants.ts';
import { settled } from './support/settle.ts';

vi.setConfig({ testTimeout: 30_000 });

let group: VariantGroup = groupOf(['a', 'b', 'c']);
const versionsBy: Record<string, VersionEntry[]> = {
  [HOST]: [version(1, 'x'), version(2, 'x')],
  [`${HOST}~b`]: [version(1, 'x'), version(2, 'x')],
  [`${HOST}~c`]: [version(1, 'x'), version(2, 'x')],
};
type PlanItem = { format: string; slug: string; letter: VariantLetter; version: number; source: 'pick' | 'default'; file: string; width: number; height: number; state: 'ready' };
const item = (format: string, letter: VariantLetter, n: number, source: 'pick' | 'default'): PlanItem =>
  ({ format, slug: letter === 'a' ? HOST : `${HOST}~${letter}`, letter, version: n, source, file: `${format}.png`, width: 1080, height: 1080, state: 'ready' });
let plan: PlanItem[] = [];
const build = (slug: string) => detailFor(slug, versionsBy[slug] ?? [], group);
const api = {
  groupExportPlan: vi.fn(async () => ({ items: plan })),
  setVariantLayout: vi.fn(async () => build(HOST)),
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async (_s: string, c: string) => build(c)),
  getConversation: vi.fn(async () => []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  getUsage: vi.fn(async () => { throw new Error('offline'); }),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: false, interrupt: false, checkedAt: at })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { CreativeCanvas } = await import('../src/screens/CreativeCanvas.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { __resetPendingPins } = await import('../src/screens/pendingPins.ts');

const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState;
function Harness() {
  const shell = {
    route: { name: 'creative', slug: 'acme', creative: HOST }, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as unknown as Shell;
  return (
    <I18nProvider locale="it"><ShellContext.Provider value={shell}>
      <header className="ms-topbar"><TopBar /></header>
      <CreativeCanvas slug="acme" creative={HOST} live={live} />
    </ShellContext.Provider></I18nProvider>
  );
}
beforeEach(() => { vi.clearAllMocks(); group = groupOf(['a', 'b', 'c']); plan = []; __resetPendingPins(); localStorage.clear(); location.hash = '#/p/acme/c/lancio'; });

/** The column's rows as "group label | format | side", for the rows whose side shows a ★. */
async function starred(): Promise<string[]> {
  await screen.findByRole('toolbar', { name: /^Variant/ });
  const col = document.querySelector('.ms-cv-formats') as HTMLElement;
  await waitFor(() => expect(api.groupExportPlan).toHaveBeenCalled());
  await settled(() => col.innerHTML);
  // The open variant's rows sit in channel groups nested in its own group: the head is the outermost group's.
  return [...col.querySelectorAll('.ms-cv-fmt')].map((btn) => {
    let g = btn.closest('.ms-cv-group') as HTMLElement;
    while (g.parentElement?.closest('.ms-cv-group')) g = g.parentElement.closest('.ms-cv-group') as HTMLElement;
    return `${g.getAttribute('aria-label')}|${btn.querySelector('.ms-navitem-label')?.textContent}|${btn.querySelector('.ms-cv-fmt-side')?.textContent}`;
  }).filter((r) => r.includes('★'));
}

for (const layout of ['variant', 'format'] as const) {
  describe(`column ★ grouped by ${layout}`, () => {
    beforeEach(() => { group = { ...groupOf(['a', 'b', 'c']), layout }; });
    it('a pick shows on its variant only, with the pick\'s version even when the row shows another', async () => {
      // instagram -> C v1 (C's row shows v2), thumbnail-like second format -> B v1 (B's row shows v2).
      plan = [item('instagram-post-1x1', 'c', 1, 'pick'), item('tiktok-9x16', 'b', 1, 'pick')];
      render(<Harness />);
      const rows = await starred();
      expect(rows).toHaveLength(2);
      if (layout === 'variant') {
        expect(rows.some((r) => r.startsWith('Variante C') && r.endsWith('★ v1'))).toBe(true);
        expect(rows.some((r) => r.startsWith('Variante B') && r.endsWith('★ v1'))).toBe(true);
      } else {
        expect(rows.filter((r) => r.endsWith('★ v1')).map((r) => r.split('|')[1]).sort()).toEqual(['B', 'C']);
      }
      expect(rows.some((r) => r.startsWith('Variante A') || r.includes('|A|'))).toBe(false);
    });
    it('the default rule stars the variant it chose, marked as default', async () => {
      plan = [item('instagram-post-1x1', 'a', 2, 'default'), item('tiktok-9x16', 'a', 2, 'default')];
      render(<Harness />);
      const rows = await starred();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.endsWith('★ v2'))).toBe(true);
      expect(document.querySelectorAll('.ms-cv-fmt-side[data-source="default"]')).toHaveLength(2);
      expect(document.querySelector('.ms-cv-fmt-side[data-source="default"]')?.getAttribute('title')).toMatch(/regola predefinita|predefinit/i);
    });
    it('agrees with Selezione finale', async () => {
      plan = [item('instagram-post-1x1', 'c', 1, 'pick'), item('tiktok-9x16', 'a', 2, 'default')];
      render(<Harness />);
      await starred();
      await userEvent.click(screen.getByRole('button', { name: 'Selezione finale' }));
      const dialog = await screen.findByRole('dialog', { name: 'Selezione finale' });
      await waitFor(() => expect(within(dialog).getAllByRole('listitem').map((l) => l.textContent)).toEqual([
        'Instagram · Post 1:1 · Variante C · v1', 'TikTok · Video 9:16 · Variante A · v2 · regola predefinita']));
      const rows = await starred();
      expect(rows).toHaveLength(2);
    });
  });
}
