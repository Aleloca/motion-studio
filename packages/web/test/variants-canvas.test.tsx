/**
 * Phase 15, Task 5: the canvas of a variant group. One row per variant (or one group per format), the layout toggle, the ★ across
 * variants, discard and restore with "Mostra scartate", the ⋯ menu, "+ Variante", a missing member and an orphan sister. The
 * sibling files cover the chat selector, the final selection, the New creative field and the list.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type ConversationEntry, type JobSummary, type VariantGroup, type VariantLetter, type VersionEntry } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Route } from '../src/routes.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { at, detailFor, groupOf, HOST, version } from './support/variants.ts';

vi.setConfig({ testTimeout: 30_000 });

let group: VariantGroup | null = groupOf(['a', 'b', 'c']);
let missing: VariantLetter[] = [];
let orphan = false;
const versionsBy: Record<string, VersionEntry[]> = {
  [HOST]: [version(1, 'Dal brief')],
  [`${HOST}~b`]: [version(1, 'Dal brief'), version(2, 'Più audace')],
  [`${HOST}~c`]: [version(1, 'Dal brief')],
  [`${HOST}~d`]: [version(1, 'Dal brief')],
  [`${HOST}~e`]: [version(1, 'Dal brief')],
};
const conversations: Record<string, ConversationEntry[]> = {};
const build = (slug: string) => {
  if (orphan) return { ...detailFor(slug, versionsBy[slug] ?? [], null), variants: { orphan: true as const, host: HOST, letter: slug.slice(-1) as VariantLetter } };
  return detailFor(slug, versionsBy[slug] ?? [], group, { missing });
};
const reply = (slug = HOST) => build(slug);
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async (_s: string, c: string) => build(c)),
  getConversation: vi.fn(async (_s: string, c: string) => conversations[c] ?? []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  sendCreativeTurn: vi.fn(async (..._a: unknown[]) => ({ id: 'j9', key: 'creative:/w:acme:lancio', kind: 'creative', label: 'x', state: 'queued', createdAt: at })),
  updateCreative: vi.fn(async () => build(HOST).creative),
  restoreVersion: vi.fn(async () => build(HOST).creative),
  revealVersion: vi.fn(async () => ({ ok: true })),
  exportPicks: vi.fn(async (_s: string, _c: string, body: { destination: string; picks: Record<string, number> }) => ({ destination: body.destination, files: [], skipped: [] as string[] })),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
  setExportPick: vi.fn(async (..._a: unknown[]) => build(HOST)),
  setFormatLink: vi.fn(async (..._a: unknown[]) => build(HOST)),
  getUsage: vi.fn(async (_q?: unknown) => { throw new Error('offline'); }),
  renderVersion: vi.fn(async (..._a: unknown[]) => ({ id: 'r1' })),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: false, interrupt: false, checkedAt: at })),
  getPinFrames: vi.fn(async () => ({ n: 1, expiresAt: at, frames: [] })),
  // Phase 15.
  runVariants: vi.fn(async (..._a: unknown[]) => ({ jobs: { c: 'j1' }, queued: [], skipped: [], failed: {} })),
  addVariants: vi.fn(async (..._a: unknown[]) => build(HOST)),
  discardVariant: vi.fn(async (..._a: unknown[]) => build(HOST)),
  restoreVariant: vi.fn(async (..._a: unknown[]) => build(HOST)),
  useVariantForAll: vi.fn(async (..._a: unknown[]) => build(HOST)),
  setVariantPick: vi.fn(async (..._a: unknown[]) => build(HOST)),
  setVariantLayout: vi.fn(async (_s: string, _c: string, layout: 'variant' | 'format') => { if (group) group = { ...group, layout }; return build(HOST); }),
  setVariantDirection: vi.fn(async (..._a: unknown[]) => build(HOST)),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { CreativeCanvas } = await import('../src/screens/CreativeCanvas.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { __resetPendingPins } = await import('../src/screens/pendingPins.ts');
const { __resetPreviewSessions } = await import('../src/components/compositionPreview.ts');

const emptyLive = (): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState);
const job = (slug: string, over: Partial<JobSummary> = {}): JobSummary => ({ id: `job-${slug}`, key: `creative:/w:acme:${slug}`, kind: 'creative', label: 'Lancio', state: 'running', createdAt: at, ...over });
const route: Route = { name: 'creative', slug: 'acme', creative: HOST };

function Harness({ live, locale = 'it', creative = HOST }: { live: EventsState; locale?: 'it' | 'en'; creative?: string }) {
  const shell = {
    route: { ...route, creative }, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} },
    openPalette: () => {},
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
const region = (name: string) => screen.findByRole('region', { name });
const loaded = () => screen.findByRole('region', { name: 'Variante A' });

let platform: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => {
  __resetPreviewSessions();
  vi.clearAllMocks();
  group = groupOf(['a', 'b', 'c']);
  missing = [];
  orphan = false;
  versionsBy[`${HOST}~b`] = [version(1, 'Dal brief'), version(2, 'Più audace')];
  __resetPendingPins();
  localStorage.clear();
  location.hash = '#/p/acme/c/lancio';
  platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
});
afterEach(() => { platform?.mockRestore(); platform = null; });

describe('variant canvas · rows', () => {
  it('one row per variant, headed "B · direzione", each with the boards of every format', async () => {
    render(<Harness live={emptyLive()} />);
    await loaded();
    for (const [letter, dir] of [['A', 'Minimale'], ['B', 'Audace'], ['C', 'Giocosa']] as const) {
      const row = await region(`Variante ${letter}`);
      expect(within(row).getByRole('button', { name: `Variante ${letter} · ${dir}` }).textContent).toBe(`${letter} · ${dir}`);
      await waitFor(() => expect(within(row).getAllByRole('img', { name: /(Post 1:1|Video 9:16) v\d/ }).length).toBe(2));
    }
    // B's newest version is on its board (its own boards are read from its own creative).
    expect(within(await region('Variante B')).getByRole('img', { name: /Post 1:1 v2/ })).toBeTruthy();
    // The layout toggle, "Mostra scartate", "Selezione finale" and "+ Variante" are in the variant bar.
    const bar = screen.getByRole('toolbar', { name: 'Varianti' });
    expect(within(bar).getByRole('radio', { name: 'Variante' }).getAttribute('aria-checked')).toBe('true');
    expect(within(bar).getByRole('radio', { name: 'Formato' }).getAttribute('aria-checked')).toBe('false');
    expect(within(bar).getByRole('switch', { name: 'Mostra scartate' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Selezione finale' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: '+ Variante' })).toBeTruthy();
  });

  it('the state of a row is its work: waiting reasons in words, working, and needs you', async () => {
    const live = emptyLive();
    live.jobs = {
      b: job(`${HOST}~b`, { id: 'b', state: 'queued', waitReason: 'variant-slot' }),
      c: job(`${HOST}~c`, { id: 'c', state: 'queued', waitReason: 'variant-directions' }),
      a: job(HOST, { id: 'a', state: 'running' }),
    };
    render(<Harness live={live} />);
    await loaded();
    expect(within(await region('Variante B')).getByText('in coda: due varianti già al lavoro')).toBeTruthy();
    expect(within(await region('Variante C')).getByText('in attesa delle direzioni')).toBeTruthy();
    expect(within(await region('Variante A')).getByText('In lavorazione')).toBeTruthy();
  });

  it('is in English too, waiting reasons included', async () => {
    const live = emptyLive();
    live.jobs = { b: job(`${HOST}~b`, { id: 'b', state: 'queued', waitReason: 'variant-confirm' }) };
    render(<Harness live={live} locale="en" />);
    await screen.findByRole('region', { name: 'Variant A' });
    expect(within(await region('Variant B')).getByText('waiting for confirmation')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Variant' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Show discarded' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Final selection' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Variant' })).toBeTruthy();
  });

  it('a failed or stopped variant shows its state and "Riprova", which runs that variant alone', async () => {
    const stopped = { ...build(`${HOST}~c`), creative: { ...build(`${HOST}~c`).creative, status: 'interrupted' as const } };
    api.getCreative.mockImplementation(async (_s: string, c: string) => (c === `${HOST}~c` ? stopped : build(c)));
    conversations[`${HOST}~c`] = [{ type: 'user', at, text: 'Più grande', pins: [], attachments: [] }];
    render(<Harness live={emptyLive()} />);
    const row = await region('Variante C');
    await waitFor(() => expect(within(row).getByText('Interrotta')).toBeTruthy());
    await userEvent.click(within(row).getByRole('button', { name: 'Riprova' }));
    await waitFor(() => expect(api.runVariants).toHaveBeenCalledWith('acme', HOST, { targets: ['c'], request: { text: 'Più grande' } }));
    api.getCreative.mockImplementation(async (_s: string, c: string) => build(c));
    delete conversations[`${HOST}~c`];
  });
});

describe('variant canvas · layout', () => {
  it('the toggle saves the layout in the group, and "Formato" shows the variants of a format side by side', async () => {
    const { container, rerender } = render(<Harness live={emptyLive()} />);
    await loaded();
    await userEvent.click(screen.getByRole('radio', { name: 'Formato' }));
    await waitFor(() => expect(api.setVariantLayout).toHaveBeenCalledWith('acme', HOST, 'format'));
    const post = await waitFor(() => { const g = container.querySelector<HTMLElement>('.ms-vgroup[data-format="instagram-post-1x1"]'); expect(g).toBeTruthy(); return g!; });
    // One board per variant, each tagged with its letter.
    await waitFor(() => expect(post.querySelectorAll('.ms-cv-board-tag').length).toBe(3));
    expect([...post.querySelectorAll('.ms-cv-board-tag')].map((e) => e.textContent)).toEqual(['A', 'B', 'C']);
    expect(screen.getByRole('radio', { name: 'Formato' }).getAttribute('aria-checked')).toBe('true');
    // The formats column follows the grouping: one group per format, the variants inside it.
    const column = screen.getByRole('complementary', { name: /Formati|Formats/ });
    const fmt = within(column).getAllByRole('group').find((g) => /Post 1:1/.test(g.getAttribute('aria-label') ?? ''))!;
    expect(within(fmt).getAllByRole('button').map((b) => b.textContent)).toEqual([expect.stringMatching(/^A/), expect.stringMatching(/^B/), expect.stringMatching(/^C/)]);
    rerender(<Harness live={emptyLive()} />);
  });

  it('by variant the formats column lists each variant with its formats', async () => {
    render(<Harness live={emptyLive()} />);
    await loaded();
    const column = screen.getByRole('complementary', { name: /Formati|Formats/ });
    const b = within(column).getByRole('group', { name: 'Variante B · Audace' });
    expect(within(b).getAllByRole('button').length).toBe(2);
  });
});

describe('variant canvas · ★ across variants', () => {
  it('the ★ of a board of another variant writes the group pick (that variant, that version)', async () => {
    render(<Harness live={emptyLive()} />);
    const row = await region('Variante B');
    const star = await within(row).findByRole('button', { name: /Post 1:1 v2 della variante B per l'esportazione/ });
    expect(star.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(star);
    await waitFor(() => expect(api.setVariantPick).toHaveBeenCalledWith('acme', HOST, 'instagram-post-1x1', { slug: `${HOST}~b`, version: 2 }));
    expect(api.setExportPick).not.toHaveBeenCalled();
  });

  it('the ★ of the open variant writes the group pick too, not its own export pick', async () => {
    render(<Harness live={emptyLive()} />);
    const row = await loaded();
    await userEvent.click(await within(row).findByRole('button', { name: /Post 1:1 v1 della variante A per l'esportazione/ }));
    await waitFor(() => expect(api.setVariantPick).toHaveBeenCalledWith('acme', HOST, 'instagram-post-1x1', { slug: HOST, version: 1 }));
    expect(api.setExportPick).not.toHaveBeenCalled();
  });

  it('the chosen board shows a filled ★, and a click on it clears the group pick', async () => {
    group = groupOf(['a', 'b', 'c'], { picks: { 'instagram-post-1x1': { slug: `${HOST}~b`, version: 2 } } });
    render(<Harness live={emptyLive()} />);
    const row = await region('Variante B');
    const star = await within(row).findByRole('button', { name: /Post 1:1: la variante B v2 è scelta per l'esportazione/ });
    expect(star.getAttribute('aria-pressed')).toBe('true');
    // Only one ★ per format in the whole group.
    expect(screen.getAllByRole('button', { name: /Post 1:1.*per l'esportazione/ }).filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    await userEvent.click(star);
    await waitFor(() => expect(api.setVariantPick).toHaveBeenCalledWith('acme', HOST, 'instagram-post-1x1', null));
  });

  it('"Usa questa variante per tutti i formati" is in the ⋯ menu of the row', async () => {
    render(<Harness live={emptyLive()} />);
    const row = await region('Variante C');
    await userEvent.click(within(row).getByRole('button', { name: 'Opzioni della variante C' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Usa questa variante per tutti i formati' }));
    await waitFor(() => expect(api.useVariantForAll).toHaveBeenCalledWith('acme', HOST, 'c'));
  });
});

describe('variant canvas · discard and restore', () => {
  it('Scarta discards that variant (through the host)', async () => {
    render(<Harness live={emptyLive()} />);
    const row = await region('Variante C');
    await userEvent.click(within(row).getByRole('button', { name: 'Opzioni della variante C' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Scarta' }));
    await waitFor(() => expect(api.discardVariant).toHaveBeenCalledWith('acme', HOST, 'c'));
  });

  it('a discarded variant is hidden; "Mostra scartate" shows it grey with "Ripristina", which restores it', async () => {
    group = groupOf(['a', 'b', 'c'], {}, { c: { status: 'discarded' } });
    render(<Harness live={emptyLive()} />);
    await loaded();
    expect(screen.queryByRole('region', { name: 'Variante C' })).toBeNull();
    expect(screen.queryByRole('group', { name: /Variante C/ })).toBeNull();
    await userEvent.click(screen.getByRole('switch', { name: 'Mostra scartate' }));
    const row = await region('Variante C');
    expect(row.className).toMatch(/ms-discarded/);
    expect(within(row).getByText('Scartata')).toBeTruthy();
    // Nothing to ⋯ on a discarded row: only Ripristina.
    expect(within(row).queryByRole('button', { name: 'Opzioni della variante C' })).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: 'Ripristina' }));
    await waitFor(() => expect(api.restoreVariant).toHaveBeenCalledWith('acme', HOST, 'c'));
  });

  it('final wave I2: a discarded sister is read-only: its Brief tab cannot be edited and says why', async () => {
    group = groupOf(['a', 'b', 'c'], {}, { b: { status: 'discarded' } });
    render(<Harness live={emptyLive()} creative={`${HOST}~b`} />);
    await screen.findByRole('toolbar', { name: 'Varianti' });
    await userEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    const edit = await screen.findByRole('button', { name: 'Modifica il brief' });
    expect((edit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Variante scartata: ripristinala per lavorarci')).toBeTruthy();
  });

  it('final wave I2: a discarded A keeps its Brief tab editable (the host carries the group\'s brief)', async () => {
    group = groupOf(['a', 'b', 'c'], {}, { a: { status: 'discarded' } });
    render(<Harness live={emptyLive()} />);
    await screen.findByRole('toolbar', { name: 'Varianti' });
    await userEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    expect(((await screen.findByRole('button', { name: 'Modifica il brief' })) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a variant that works cannot be discarded: the item is disabled and says why', async () => {
    const live = emptyLive();
    live.jobs = { b: job(`${HOST}~b`, { id: 'b' }) };
    render(<Harness live={live} />);
    const row = await region('Variante B');
    await userEvent.click(within(row).getByRole('button', { name: 'Opzioni della variante B' }));
    const item = await screen.findByRole('menuitem', { name: 'Scarta' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Fermala prima di scartarla')).toBeTruthy();
    expect(item.getAttribute('aria-describedby')).toBeTruthy();
    await userEvent.click(item);
    expect(api.discardVariant).not.toHaveBeenCalled();
  });

  it('the last active variant cannot be discarded: disabled, with its reason', async () => {
    group = groupOf(['a', 'b', 'c'], {}, { b: { status: 'discarded' }, c: { status: 'discarded' } });
    render(<Harness live={emptyLive()} />);
    const row = await loaded();
    await userEvent.click(within(row).getByRole('button', { name: 'Opzioni della variante A' }));
    const item = await screen.findByRole('menuitem', { name: 'Scarta' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText("È l'ultima variante attiva: tienine almeno una")).toBeTruthy();
  });

  it('English reasons', async () => {
    const live = emptyLive();
    live.jobs = { b: job(`${HOST}~b`, { id: 'b' }) };
    render(<Harness live={live} locale="en" />);
    const row = await screen.findByRole('region', { name: 'Variant B' });
    await userEvent.click(within(row).getByRole('button', { name: 'Options of variant B' }));
    expect(await screen.findByText('Stop it before discarding it')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Use this variant for all formats' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Export this variant' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Edit direction' })).toBeTruthy();
  });
});

describe('variant canvas · every board, whichever variant is open', () => {
  it('the ★ of a board of variant C works while A is open: the group pick is C\'s slug and version', async () => {
    render(<Harness live={emptyLive()} />);
    const open = await loaded();
    expect(open.querySelector('[aria-pressed="true"].ms-vrow-title')).toBeTruthy();
    const row = await region('Variante C');
    const star = await within(row).findByRole('button', { name: /Post 1:1 v1 della variante C per l'esportazione/ });
    expect((star as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(star);
    await waitFor(() => expect(api.setVariantPick).toHaveBeenCalledWith('acme', HOST, 'instagram-post-1x1', { slug: `${HOST}~c`, version: 1 }));
    // The same for the other format, and A is still the open variant (no switch happened).
    await userEvent.click(within(row).getByRole('button', { name: /Video 9:16 v1 della variante C per l'esportazione/ }));
    await waitFor(() => expect(api.setVariantPick).toHaveBeenCalledWith('acme', HOST, 'tiktok-9x16', { slug: `${HOST}~c`, version: 1 }));
    expect(screen.getByRole('radio', { name: 'A' }).getAttribute('aria-checked')).toBe('true');
    expect(api.getConversation).not.toHaveBeenCalledWith('acme', `${HOST}~c`);
  });

  it('"Apri questa variante" on a board of another variant opens that variant in one click', async () => {
    render(<Harness live={emptyLive()} />);
    await loaded();
    const row = await region('Variante C');
    await userEvent.click(within(row).getAllByRole('button', { name: /^Apri questa variante: C$/ })[0]!);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'C' }).getAttribute('aria-checked')).toBe('true'));
    expect(api.getConversation).toHaveBeenCalledWith('acme', `${HOST}~c`);
  });

  it('is in English', async () => {
    render(<Harness live={emptyLive()} locale="en" />);
    const row = await screen.findByRole('region', { name: 'Variant C' });
    expect((await within(row).findAllByRole('button', { name: 'Open this variant: C' })).length).toBe(2);
  });
});

describe('variant canvas · a creative with no variants yet', () => {
  it('its menu has one "+ Variante": the group is made with the total count and the new variant starts', async () => {
    group = null;
    api.addVariants.mockImplementationOnce(async () => { group = groupOf(['a', 'b']); return build(HOST); });
    render(<Harness live={emptyLive()} />);
    await screen.findByRole('img', { name: /Post 1:1 v1/ });
    await userEvent.click(screen.getByRole('button', { name: 'Altro' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '+ Variante' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiungi una variante' });
    await userEvent.type(within(dialog).getByLabelText('Direzione (facoltativa)'), 'Tipografica');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aggiungi variante' }));
    await waitFor(() => expect(api.addVariants).toHaveBeenCalledWith('acme', HOST, { count: 2, directions: [null, 'Tipografica'] }));
    await waitFor(() => expect(api.runVariants).toHaveBeenCalledWith('acme', HOST, { targets: ['b'], request: null }));
  });

  it('can start from its own latest version', async () => {
    group = null;
    api.addVariants.mockImplementationOnce(async () => { group = groupOf(['a', 'b']); return build(HOST); });
    render(<Harness live={emptyLive()} />);
    await screen.findByRole('img', { name: /Post 1:1 v1/ });
    await userEvent.click(screen.getByRole('button', { name: 'Altro' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '+ Variante' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiungi una variante' });
    await userEvent.click(within(dialog).getByRole('button', { name: /Parti da/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Variante A, versione 1' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aggiungi variante' }));
    await waitFor(() => expect(api.addVariants).toHaveBeenCalledWith('acme', HOST, { count: 2, directions: [null, null], baseFrom: { slug: HOST, version: 1 } }));
  });

  it('a group has no such menu (it has "+ Variante" in its bar)', async () => {
    render(<Harness live={emptyLive()} />);
    await loaded();
    expect(screen.queryByRole('button', { name: 'Altro' })).toBeNull();
  });
});

describe('variant canvas · ⋯ menu', () => {
  it('"Modifica direzione" saves the direction of that variant', async () => {
    render(<Harness live={emptyLive()} />);
    const row = await region('Variante B');
    await userEvent.click(within(row).getByRole('button', { name: 'Opzioni della variante B' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Modifica direzione' }));
    const dialog = await screen.findByRole('dialog', { name: /Modifica direzione/ });
    const field = within(dialog).getByLabelText('Direzione della variante B (facoltativa)') as HTMLInputElement;
    expect(field.value).toBe('Audace');
    await userEvent.clear(field);
    await userEvent.type(field, 'Molto scuro');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salva direzione' }));
    await waitFor(() => expect(api.setVariantDirection).toHaveBeenCalledWith('acme', HOST, 'b', 'Molto scuro'));
  });

  it('"Esporta questa variante" opens the export of that variant alone', async () => {
    render(<Harness live={emptyLive()} />);
    const row = await region('Variante B');
    await userEvent.click(within(row).getByRole('button', { name: 'Opzioni della variante B' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Esporta questa variante' }));
    const dialog = await screen.findByRole('dialog', { name: /Esporta|Export/ });
    // It is THAT variant's export: B's newest version (v2), where A has only v1.
    await waitFor(() => expect(within(dialog).getAllByText('lancio-estivo-instagram-post-1x1-v2.png')[0]).toBeTruthy());
    expect(within(dialog).queryByText(/-v1\.png$/)).toBeNull();
  });
});

describe('variant canvas · + Variante', () => {
  it('adds one variant with an optional direction and starts it', async () => {
    api.addVariants.mockImplementationOnce(async () => {
      group = groupOf(['a', 'b', 'c', 'd']);
      return build(HOST);
    });
    render(<Harness live={emptyLive()} />);
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: '+ Variante' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiungi una variante' });
    await userEvent.type(within(dialog).getByLabelText('Direzione (facoltativa)'), 'Tipografica');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aggiungi variante' }));
    await waitFor(() => expect(api.addVariants).toHaveBeenCalledWith('acme', HOST, { count: 1, directions: ['Tipografica'] }));
    await waitFor(() => expect(api.runVariants).toHaveBeenCalledWith('acme', HOST, { targets: ['d'], request: null }));
  });

  it('can start from the last version of a chosen variant', async () => {
    api.addVariants.mockImplementationOnce(async () => {
      group = groupOf(['a', 'b', 'c', 'd']);
      return build(HOST);
    });
    render(<Harness live={emptyLive()} />);
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: '+ Variante' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiungi una variante' });
    await userEvent.click(within(dialog).getByRole('button', { name: /Parti da/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Variante B, versione 2' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aggiungi variante' }));
    await waitFor(() => expect(api.addVariants).toHaveBeenCalledWith('acme', HOST, { count: 1, directions: [null], baseFrom: { slug: `${HOST}~b`, version: 2 } }));
  });

  it('is disabled at five variants, with the reason', async () => {
    group = groupOf(['a', 'b', 'c', 'd', 'e']);
    render(<Harness live={emptyLive()} />);
    await loaded();
    const add = screen.getByRole('button', { name: '+ Variante' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.title).toBe('Hai raggiunto il limite di 5 varianti');
  });
});

describe('variant canvas · a member is missing, or the group is', () => {
  it('a missing member is listed as "mancante" in its row and in the column, and nothing throws', async () => {
    missing = ['c'];
    render(<Harness live={emptyLive()} />);
    await loaded();
    const row = await region('Variante C');
    expect(within(row).getByText('mancante')).toBeTruthy();
    expect(within(row).queryByRole('img')).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Opzioni della variante C' })).toBeNull();
    const column = screen.getByRole('complementary', { name: /Formati|Formats/ });
    expect(within(column).getByText(/Giocosa · mancante|C · Giocosa · mancante/)).toBeTruthy();
    // The selector does not offer it.
    expect((screen.getByRole('radio', { name: 'C' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('an orphan sister opens as a single creative, with a notice and no variant controls', async () => {
    orphan = true;
    const { container } = render(<Harness live={emptyLive()} creative={`${HOST}~b`} />);
    await screen.findByRole('img', { name: /Post 1:1 v\d/ });
    expect(screen.getByRole('status', { name: '' }).textContent).toMatch(/Il gruppo di questa variante non si trova/);
    expect(screen.queryByRole('toolbar', { name: 'Varianti' })).toBeNull();
    expect(container.querySelector('[data-variant-selector]')).toBeNull();
    expect(container.querySelector('.ms-vstar')).toBeNull();
    expect(container.querySelector('.ms-cv-vworld')).toBeNull();
  });
});

describe('variant canvas · the group never starts one variant alone', () => {
  it('an unstarted group: the canvas "Genera" starts every variant (one fan-out)', async () => {
    for (const k of Object.keys(versionsBy)) versionsBy[k] = [];
    render(<Harness live={emptyLive()} />);
    await loaded();
    await userEvent.click(await within(screen.getByRole('main')).findByRole('button', { name: 'Genera' }));
    await waitFor(() => expect(api.runVariants).toHaveBeenCalledWith('acme', HOST, { targets: 'all-active', request: null }));
    expect(api.sendCreativeTurn).not.toHaveBeenCalled();
    versionsBy[HOST] = [version(1, 'Dal brief')];
    versionsBy[`${HOST}~b`] = [version(1, 'Dal brief'), version(2, 'Più audace')];
    versionsBy[`${HOST}~c`] = [version(1, 'Dal brief')];
  });

  it('minor (Task 5): a partly started group: "Genera" starts the open variant and the other variants that have no version, not those that have', async () => {
    versionsBy[HOST] = [];
    versionsBy[`${HOST}~b`] = [];
    // C has versions (the group's default fixture): it is left alone.
    render(<Harness live={emptyLive()} />);
    await loaded();
    await userEvent.click(await within(screen.getByRole('main')).findByRole('button', { name: 'Genera' }));
    await waitFor(() => expect(api.runVariants).toHaveBeenCalledWith('acme', HOST, { targets: ['a', 'b'], request: null }));
    expect(api.sendCreativeTurn).not.toHaveBeenCalled();
    versionsBy[HOST] = [version(1, 'Dal brief')];
    versionsBy[`${HOST}~b`] = [version(1, 'Dal brief'), version(2, 'Più audace')];
  });

  it('fix wave: members whose detail has not loaded yet are not counted as empty: "Genera" starts the open variant alone', async () => {
    versionsBy[HOST] = [];
    versionsBy[`${HOST}~b`] = [];
    versionsBy[`${HOST}~c`] = [];
    // Everything but the open creative never answers.
    api.getCreative.mockImplementation((_s: string, c: string) => (c === HOST ? Promise.resolve(build(c)) : new Promise(() => {})));
    try {
      render(<Harness live={emptyLive()} />);
      await userEvent.click(await within(await screen.findByRole('main')).findByRole('button', { name: 'Genera' }));
      await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalled());
      expect(api.runVariants).not.toHaveBeenCalled();
    } finally { api.getCreative.mockImplementation(async (_s: string, c: string) => build(c)); }
    versionsBy[HOST] = [version(1, 'Dal brief')];
    versionsBy[`${HOST}~b`] = [version(1, 'Dal brief'), version(2, 'Più audace')];
    versionsBy[`${HOST}~c`] = [version(1, 'Dal brief')];
  });

  it('the paid-services card filed under the host shows in the chat of every variant', async () => {
    const live = emptyLive();
    live.approvals = {
      batch: { id: 'batch', jobId: 'batch', projectSlug: 'acme', creativeSlug: HOST, kind: 'paid-batch', title: 'Servizi a pagamento per 3 varianti', detail: '', toolName: 'provider:variant-batch', alwaysRule: null, explanation: null, agentReason: null,
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
        paidBatch: { provider: 'elevenlabs', calls: [{ label: 'Variante A · Voce (ElevenLabs)', chars: 0 }], items: [{ variant: 'a', provider: 'elevenlabs', capability: 'voice' }], total: { variants: 3, calls: 1, providers: [{ provider: 'elevenlabs', calls: 1 }] } } },
    } as unknown as EventsState['approvals'];
    render(<Harness live={live} />);
    await loaded();
    // Open B's chat: the card is still there.
    await userEvent.click(screen.getByRole('radio', { name: 'B' }));
    expect(await screen.findByRole('group', { name: 'Servizi a pagamento per 3 varianti' })).toBeTruthy();
  });
});
