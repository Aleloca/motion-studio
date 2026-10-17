/**
 * Phase 15, fix round 1: the ★ in the format view of a variant is the group's (variant + version, through the host), for the open
 * variant and for another variant's format view; it never writes the creative's own exportPicks, which a group export ignores.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type VariantGroup } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { at, detailFor, groupOf, HOST, version } from './support/variants.ts';

vi.setConfig({ testTimeout: 45_000 });
let group: VariantGroup = groupOf(['a', 'b']);
let vs = [version(1, 'Dal brief'), version(2, 'Più chiaro')];
let withLocales = false;
const build = (c: string) => {
  const d = detailFor(c, vs, group);
  return withLocales ? { ...d, creative: { ...d.creative, brief: { ...d.creative.brief, locales: { primary: 'it', extra: ['en'] } } } } : d;
};
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async (_s: string, c: string) => build(c)),
  getConversation: vi.fn(async () => []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  fileBytes: vi.fn(async () => null),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: false, interrupt: false, checkedAt: at })),
  getPinFrames: vi.fn(async () => ({ n: 1, expiresAt: at, frames: [] })),
  getUsage: vi.fn(async () => { throw new Error('offline'); }),
  setExportPick: vi.fn(async (..._a: unknown[]) => build(HOST)),
  setVariantPick: vi.fn(async (..._a: unknown[]) => build(HOST)),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { FormatView } = await import('../src/screens/FormatView.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { __resetPendingPins } = await import('../src/screens/pendingPins.ts');

const live = (): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState);
function Harness({ creative }: { creative: string }) {
  const l = live();
  const shell = {
    route: { name: 'format', slug: 'acme', creative, format: 'instagram-post-1x1' }, live: l,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as unknown as Shell;
  return (
    <I18nProvider locale="it"><ShellContext.Provider value={shell}>
      <header className="ms-topbar"><TopBar /></header>
      <FormatView slug="acme" creative={creative} format="instagram-post-1x1" live={l} />
    </ShellContext.Provider></I18nProvider>
  );
}
beforeEach(() => { vi.clearAllMocks(); group = groupOf(['a', 'b']); vs = [version(1, 'Dal brief'), version(2, 'Più chiaro')]; withLocales = false; __resetPendingPins(); localStorage.clear(); });

describe('the ★ in the format view of a variant', () => {
  for (const [creative, letter] of [[HOST, 'a'], [`${HOST}~b`, 'b']] as const) {
    it(`variant ${letter.toUpperCase()}: writes the group pick through the host, not the creative's own pick`, async () => {
      render(<Harness creative={creative} />);
      const bar = document.querySelector('.ms-topbar') as HTMLElement;
      // Not the group's ★ yet: the badge says the version without the star.
      const badge = await within(bar).findByRole('button', { name: /Apri le sue versioni/ });
      expect(badge.textContent).not.toContain('★');
      await userEvent.click(badge);
      const pop = await screen.findByRole('dialog', { name: /Versioni di/ });
      await userEvent.click(within(pop).getByRole('button', { name: /Usa la v1 per l/ }));
      await waitFor(() => expect(api.setVariantPick).toHaveBeenCalledWith('acme', HOST, 'instagram-post-1x1', { slug: creative, version: 1 }));
      expect(api.setExportPick).not.toHaveBeenCalled();
    });
  }
  it('shows the ★ when this variant holds the group pick', async () => {
    group = groupOf(['a', 'b'], { picks: { 'instagram-post-1x1': { slug: `${HOST}~b`, version: 1 } } });
    render(<Harness creative={`${HOST}~b`} />);
    const bar = document.querySelector('.ms-topbar') as HTMLElement;
    expect((await within(bar).findByRole('button', { name: /Apri le sue versioni/ })).textContent).toContain('★ v1');
  });
});

describe('final wave I2: a discarded variant is read-only in its format view', () => {
  const composed = () => [{ ...version(1, 'Dal brief'), compositions: [{ format: 'instagram-post-1x1', dir: 'compositions/instagram-post-1x1', hash: 'a'.repeat(64), problems: [] }] }];
  it('"Duplica formato" and "Lingue" are disabled with the reason; an active variant keeps them', async () => {
    vs = composed();
    withLocales = true;
    group = groupOf(['a', 'b'], {}, { b: { status: 'discarded' } });
    const { unmount } = render(<Harness creative={`${HOST}~b`} />);
    const bar = document.querySelector('.ms-topbar') as HTMLElement;
    await waitFor(() => expect(bar.querySelector('.ms-fv-duplicate')).not.toBeNull());
    const reason = 'Variante scartata: ripristinala per lavorarci';
    const dup = bar.querySelector('.ms-fv-duplicate') as HTMLButtonElement;
    expect(dup.disabled).toBe(true);
    expect(dup.title).toBe(reason);
    const langs = bar.querySelector('.ms-cv-languages') as HTMLButtonElement;
    expect(langs.disabled).toBe(true);
    expect(langs.title).toBe(reason);
    unmount();
    group = groupOf(['a', 'b']);
    render(<Harness creative={`${HOST}~b`} />);
    const bar2 = document.querySelector('.ms-topbar') as HTMLElement;
    await waitFor(() => expect(bar2.querySelector('.ms-fv-duplicate')).not.toBeNull());
    expect((bar2.querySelector('.ms-fv-duplicate') as HTMLButtonElement).disabled).toBe(false);
    expect((bar2.querySelector('.ms-cv-languages') as HTMLButtonElement).disabled).toBe(false);
  });
});
