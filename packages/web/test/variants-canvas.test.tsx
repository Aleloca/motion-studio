/**
 * Phase 15, Task 5: the canvas of a variant group. Decision 973: one card per variant (letter, short name, the direction, one
 * state, its formats), the ★ across variants ("Scegli" / "Scelta"), discard and restore with "Mostra scartate", the ⋯ menu,
 * "+ Variante", a missing member and an orphan sister. The sibling files cover the chat selector, the final selection, the New
 * creative field and the list.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type ConversationEntry, type JobSummary, type VariantGroup, type VariantLetter, type VersionEntry } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Route } from '../src/routes.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { at, detailFor, groupOf, HOST, out, version } from './support/variants.ts';

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
  archiveCreative: vi.fn(async (_s: string, c: string) => ({ archived: [c] })),
  deleteCreative: vi.fn(async (_s: string, c: string) => ({ deleted: [c] })),
  creativeRemoval: vi.fn(async (_s: string, c: string) => ({ role: c.includes('~') ? 'sister' : 'host', members: 3, letter: c.includes('~') ? c.slice(-1) : 'a', title: 'Lancio', archived: false, blocked: null })),
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

describe('variant canvas · cards', () => {
  it('one card per variant: the letter and its name, one state, and the formats inside it', async () => {
    render(<Harness live={emptyLive()} />);
    await loaded();
    for (const [letter, dir] of [['A', 'Minimale'], ['B', 'Audace'], ['C', 'Giocosa']] as const) {
      const card = await region(`Variante ${letter}`);
      expect(card.className).toMatch(/ms-vcard/);
      expect(within(card).getByRole('button', { name: `Variante ${letter} · ${dir}` }).textContent).toBe(`${letter}${dir}`);
      // One state only: the work of the variant, never a render state next to it.
      expect(within(card).getByText('Pronta')).toBeTruthy();
      expect(within(card).queryByText(/Non renderizzato|Renderizzato/)).toBeNull();
      const formats = within(card).getByRole('group', { name: `Formati della variante ${letter}` });
      await waitFor(() => expect(within(formats).getAllByRole('img', { name: /(Post 1:1|Video 9:16) v\d/ }).length).toBe(2));
    }
    // B's newest version is on its board (its own boards are read from its own creative).
    expect(within(await region('Variante B')).getByRole('img', { name: /Post 1:1 v2/ })).toBeTruthy();
    // "Mostra scartate", "Selezione finale" and "+ Variante" are in the variant bar; no grouping toggle any more.
    const bar = screen.getByRole('toolbar', { name: 'Varianti' });
    expect(within(bar).queryByRole('radio')).toBeNull();
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
    expect(screen.getByRole('group', { name: 'Formats of variant B' })).toBeTruthy();
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
  it('a long direction: a short name (its first clause), the whole direction on a second line and in the tooltip', async () => {
    const long = 'Minimal Apple-style keynote: white space, one idea per scene, slow fades';
    group = groupOf(['a', 'b', 'c'], {}, { a: { direction: long } });
    render(<Harness live={emptyLive()} />);
    const card = await loaded();
    const name = within(card).getByRole('button', { name: `Variante A · ${long}` });
    expect(name.textContent).toBe('AMinimal Apple-style keynote');
    expect(name.title).toBe(long);
    const second = card.querySelector('.ms-vcard-dir') as HTMLElement;
    expect(second.textContent).toBe(long);
    expect(second.title).toBe(long);
    // A direction that is already short has no second line.
    expect((await region('Variante B')).querySelector('.ms-vcard-dir')).toBeNull();
  });

  it('the stored "format" grouping still shows the cards (the chooser is the view by format)', async () => {
    group = { ...groupOf(['a', 'b', 'c']), layout: 'format' };
    const { container } = render(<Harness live={emptyLive()} />);
    await loaded();
    await waitFor(() => expect(container.querySelectorAll('.ms-vcard').length).toBe(3));
    expect(container.querySelector('.ms-vgroup')).toBeNull();
  });

  it('a card with one format makes it the hero; the format\'s proportions are kept', async () => {
    api.getCreative.mockImplementation(async (_s: string, c: string) => detailFor(c, [version(1, 'Dal brief', [out('tiktok-9x16', 'tiktok.mp4', '.previews/tiktok.mp4.jpg')])], group, { formats: ['tiktok-9x16'] }));
    try {
      render(<Harness live={emptyLive()} />);
      const card = await loaded();
      await waitFor(() => expect(card.querySelector('.ms-vcard-formats.ms-hero')).toBeTruthy());
      const wrap = await waitFor(() => { const w = card.querySelector<HTMLElement>('.ms-cv-frame-wrap'); expect(w).toBeTruthy(); return w!; });
      // 9:16 (304×540 at 100%): width / height stays 304 / 540.
      expect(parseFloat(wrap.style.width) / parseFloat(wrap.style.height)).toBeCloseTo(304 / 540, 2);
    } finally { api.getCreative.mockImplementation(async (_s: string, c: string) => build(c)); }
  });

  it('every card shows the same plain version badge, and the open variant\'s name has no outline when clicked', async () => {
    const { container } = render(<Harness live={emptyLive()} />);
    await loaded();
    await waitFor(() => expect(container.querySelectorAll('.ms-vcard .ms-vver').length).toBe(6));
    expect([...container.querySelectorAll('.ms-vcard .ms-vver')].every((b) => b.tagName === 'SPAN' && b.className === 'ms-vbadge ms-vver')).toBe(true);
    // No version menu on a card, nor the old "›" open button.
    expect(container.querySelector('.ms-vcard .ms-fvb')).toBeNull();
    expect(container.querySelector('.ms-vopen')).toBeNull();
  });

  it('by variant the formats column lists each variant with its formats', async () => {
    render(<Harness live={emptyLive()} />);
    await loaded();
    const column = await screen.findByRole('complementary', { name: /Formati|Formats/ });
    const b = await within(column).findByRole('group', { name: 'Variante B · Audace' });
    // B's formats come from B's own creative detail, which loads after A's region is up.
    await waitFor(() => expect(within(b).getAllByRole('button').length).toBe(2));
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

  it('decision 915: a variant B..E is archived or deleted alone from its row menu (A has no such items)', async () => {
    render(<Harness live={emptyLive()} />);
    const row = await region('Variante C');
    await userEvent.click(within(row).getByRole('button', { name: 'Opzioni della variante C' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Archivia la variante C' }));
    await waitFor(() => expect(api.archiveCreative).toHaveBeenCalledWith('acme', `${HOST}~c`, false));
    await userEvent.click(within(row).getByRole('button', { name: 'Opzioni della variante C' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Elimina la variante C…' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('La variante C esce dal gruppo');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sposta nel Cestino' }));
    await waitFor(() => expect(api.deleteCreative).toHaveBeenCalledWith('acme', `${HOST}~c`, false));
    const a = await region('Variante A');
    await userEvent.click(within(a).getByRole('button', { name: 'Opzioni della variante A' }));
    await screen.findByRole('menuitem', { name: 'Modifica direzione' });
    expect(screen.queryByRole('menuitem', { name: /Archivia la variante/ })).toBeNull();
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

  it('one click on a format of another variant opens it in the format view', async () => {
    render(<Harness live={emptyLive()} />);
    const card = await region('Variante C');
    const img = await within(card).findByRole('img', { name: /Post 1:1 v1/ });
    await userEvent.click(img.closest('.ms-cv-frame') as HTMLElement);
    await waitFor(() => expect(location.hash).toBe(`#/p/acme/c/${HOST}~c/f/instagram-post-1x1`));
  });

  it('one click on a format of the open variant opens it too', async () => {
    render(<Harness live={emptyLive()} />);
    const card = await loaded();
    const img = await within(card).findByRole('img', { name: /Post 1:1 v1/ });
    await userEvent.click(img.closest('.ms-cv-frame') as HTMLElement);
    await waitFor(() => expect(location.hash).toBe(`#/p/acme/c/${HOST}/f/instagram-post-1x1`));
  });

  it('hovering a format plays its rendered file, muted and looping (not the first frame of a still)', async () => {
    const { container } = render(<Harness live={emptyLive()} />);
    const card = await region('Variante B');
    const tiktok = await waitFor(() => { const b = card.querySelector<HTMLElement>('[data-board="b:tiktok-9x16"]'); expect(b).toBeTruthy(); return b!; });
    // At rest: the poster (a picture), no video.
    expect(tiktok.querySelector('video')).toBeNull();
    fireEvent.pointerEnter(tiktok.querySelector('.ms-cv-frame-wrap')!);
    const video = await waitFor(() => { const v = tiktok.querySelector<HTMLVideoElement>('video.ms-cv-live-file'); expect(v).toBeTruthy(); return v!; });
    expect(video.getAttribute('src')).toBe(`/f/acme/${HOST}~b/outputs/v2/tiktok.mp4`);
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);
    fireEvent.pointerLeave(tiktok.querySelector('.ms-cv-frame-wrap')!);
    await waitFor(() => expect(tiktok.querySelector('video')).toBeNull());
    // A still format (the post, a PNG) never plays.
    const post = container.querySelector('[data-board="b:instagram-post-1x1"] .ms-cv-frame-wrap')!;
    fireEvent.pointerEnter(post);
    await new Promise((r) => setTimeout(r, 600));
    expect(post.querySelector('video')).toBeNull();
  });

  it('Comment on a format of the open variant places a comment on that format', async () => {
    render(<Harness live={emptyLive()} />);
    const card = await loaded();
    fireEvent.click(await within(card).findByRole('button', { name: 'Commenta un punto di Instagram · Post 1:1' }));
    fireEvent.click(within(card).getByRole('button', { name: /^Commenta Instagram · Post 1:1/ }));
    expect(await screen.findByLabelText('Testo del commento')).toBeTruthy();
  });

  it('Comment on a format of another variant opens that variant and starts commenting on the same format there', async () => {
    render(<Harness live={emptyLive()} />);
    const card = await region('Variante C');
    fireEvent.click(await within(card).findByRole('button', { name: 'Commenta un punto di Instagram · Post 1:1' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'C' }).getAttribute('aria-checked')).toBe('true'));
    const open = await region('Variante C');
    // C is the open variant now: its post takes the click (only that board), its chat gets the comment.
    expect(await within(open).findByRole('button', { name: /^Commenta Instagram · Post 1:1/ })).toBeTruthy();
    expect(within(open).queryByRole('button', { name: /^Commenta TikTok/ })).toBeNull();
    expect(screen.getByText('Clicca una tavola per commentare · Esc per uscire')).toBeTruthy();
  });

  it('"Scegli" is labelled: "Scelta" on the chosen format, in English "Choose" / "Chosen"', async () => {
    group = groupOf(['a', 'b', 'c'], { picks: { 'instagram-post-1x1': { slug: `${HOST}~b`, version: 2 } } });
    const { unmount } = render(<Harness live={emptyLive()} />);
    const b = await region('Variante B');
    expect((await within(b).findByRole('button', { name: /Post 1:1: la variante B v2 è scelta/ })).textContent).toBe('Scelta');
    expect(within(b).getByRole('button', { name: /Video 9:16 v2 della variante B per/ }).textContent).toBe('Scegli');
    unmount();
    render(<Harness live={emptyLive()} locale="en" />);
    const en = await screen.findByRole('region', { name: 'Variant B' });
    expect((await within(en).findByRole('button', { name: /variant B v2 is chosen/ })).textContent).toBe('Chosen');
  });
});

describe('variant canvas · a creative with no variants yet', () => {
  it('its menu has one "Aggiungi variante" (no double plus): the group is made with the total count and the new variant starts', async () => {
    group = null;
    api.addVariants.mockImplementationOnce(async () => { group = groupOf(['a', 'b']); return build(HOST); });
    render(<Harness live={emptyLive()} />);
    await screen.findByRole('img', { name: /Post 1:1 v1/ });
    await userEvent.click(screen.getByRole('button', { name: 'Altro' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Aggiungi variante' }));
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
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Aggiungi variante' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aggiungi una variante' });
    await userEvent.click(within(dialog).getByRole('button', { name: /Parti da/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Variante A, versione 1' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aggiungi variante' }));
    await waitFor(() => expect(api.addVariants).toHaveBeenCalledWith('acme', HOST, { count: 2, directions: [null, null], baseFrom: { slug: HOST, version: 1 } }));
  });

  it('a group\'s menu has no "+ Variante" (it is in its bar): only archive and delete of the whole group (decision 915)', async () => {
    render(<Harness live={emptyLive()} />);
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: 'Altro' }));
    const menu = await screen.findByRole('menu', { name: 'Altro' });
    expect(within(menu).queryByRole('menuitem', { name: /Variante/ })).toBeNull();
    expect(await within(menu).findByRole('menuitem', { name: 'Archivia tutte le 3 varianti' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Elimina tutte le 3 varianti…' })).toBeTruthy();
    expect(api.creativeRemoval).toHaveBeenCalledWith('acme', 'lancio');
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
