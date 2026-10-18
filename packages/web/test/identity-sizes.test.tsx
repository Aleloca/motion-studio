import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, renderJobKeyOf, type CreativeDetail, type IdentitySetInfo, type OutputFileInfo, type VersionEntry } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Route } from '../src/routes.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';

// The size grid, the logo on light and dark, the image status pill and the SVG refusals (Phase 14, Task 5).
vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });

const at = '2026-10-15T10:00:00.000Z';
const H1 = 'b'.repeat(64);
const FAV = 'identity-favicon';
const LOGO = 'identity-logo';
const favSet: IdentitySetInfo = {
  dir: FAV,
  files: [
    { path: 'favicon.ico', role: 'favicon' },
    { path: 'favicon.svg', role: 'vector' },
    { path: 'apple-touch-icon.png', width: 180, height: 180, alpha: false, role: 'opaque' },
    { path: 'icon-192.png', width: 192, height: 192, alpha: true, role: 'icon' },
    { path: 'icon-512-maskable.png', width: 512, height: 512, alpha: false, role: 'maskable' },
    { path: 'site.webmanifest', role: 'manifest' },
  ],
  warnings: ['icon-512-maskable.png: il 12% del disegno è fuori dalla zona sicura e la maschera potrebbe tagliarlo'],
};
const logoSet: IdentitySetInfo = { dir: LOGO, files: [{ path: 'logo.svg', role: 'vector' }, { path: 'logo.png', width: 1024, height: 400, alpha: true, role: 'raster' }], warnings: [] };
const out = (format: string, set?: IdentitySetInfo, rendered = true): OutputFileInfo => ({
  format, file: `${format}.png`, width: 1024, height: 1024, durationSec: null, verified: true, preview: null,
  ...(rendered ? { sha256: 'd'.repeat(64), fromComposition: H1 } : {}), ...(set ? { identitySet: set } : {}),
});
const version = (n: number, outputs: OutputFileInfo[]): VersionEntry => ({
  n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: '', outputs, problems: [], tools: [], renderCommand: null, basedOn: null,
  compositions: outputs.map((o) => ({ format: o.format, dir: `compositions/${o.format}`, hash: H1 })),
});
const detailOf = (formats: string[], versions: VersionEntry[]): CreativeDetail => ({
  slug: 'lancio', jobKey: 'creative:/w:acme:lancio', versions,
  creative: { schemaVersion: 1, title: 'Identità', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [], brief: { goal: 'g', message: '', formats, durationSec: null, assets: [], notes: '' } },
});

let detail = detailOf([FAV], [version(1, [out(FAV, favSet)])]);
let jobsNow: Record<string, unknown> = {};
const useAsBrandLogo = vi.fn(async (..._a: unknown[]) => ({ file: 'assets/brand/x.svg', variant: 'icon' }));
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async () => detail),
  getConversation: vi.fn(async () => []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  fileBytes: vi.fn(async (..._a: unknown[]): Promise<number | null> => 1000),
  renderVersion: vi.fn(async (..._a: unknown[]) => ({ id: 'r1', key: 'k', kind: 'render', label: 'x', state: 'queued', createdAt: at })),
  revealVersion: vi.fn(async () => ({ ok: true })),
  previewSession: vi.fn(async () => { throw Object.assign(new Error('no'), { status: 404 }); }),
  getEditorComposition: vi.fn(async () => { throw new Error('no'); }),
  getStoryboard: vi.fn(async () => { throw new Error('no'); }),
  revokePreview: vi.fn(async () => ({ revoked: true })),
  useAsBrandLogo,
};
class ApiError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { FormatView } = await import('../src/screens/FormatView.tsx');
const { IdentitySizes } = await import('../src/screens/identity/IdentitySizes.tsx');
const { ExportButton } = await import('../src/screens/ExportButton.tsx');
const { ProblemList } = await import('../src/components/ProblemList.tsx');
const { groupProblems } = await import('../src/screens/svgRefusals.ts');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { __resetPreviewSessions } = await import('../src/components/compositionPreview.ts');

const emptyLive = (): EventsState => ({ approvals: {}, jobs: jobsNow, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState);
function Harness({ format }: { format: string }) {
  const route: Route = { name: 'format', slug: 'acme', creative: 'lancio', format };
  const shell = { route, live: emptyLive(), catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {} } as unknown as Shell;
  return (
    <I18nProvider locale="it">
      <ShellContext.Provider value={shell}>
        <header className="ms-topbar"><TopBar /></header>
        <FormatView slug="acme" creative="lancio" format={format} live={emptyLive()} />
      </ShellContext.Provider>
    </I18nProvider>
  );
}
beforeEach(() => { __resetPreviewSessions(); vi.clearAllMocks(); jobsNow = {}; detail = detailOf([FAV], [version(1, [out(FAV, favSet)])]); location.hash = '#/p/acme/c/lancio/f/identity-favicon'; });

const url = (path: string) => `/f/acme/lancio/outputs/v1/${FAV}/${path}`;

describe('IdentitySizes', () => {
  const view = (kind: 'favicon' | 'logo' | 'app-icon', set: IdentitySetInfo) => render(<I18nProvider locale="it"><IdentitySizes slug="acme" creative="lancio" n={1} set={set} kind={kind} /></I18nProvider>);

  it('lists every picture of the set at 1:1 with its size, and the other files by name', () => {
    view('favicon', favSet);
    const grid = screen.getByRole('list', { name: 'Dimensioni' });
    const names = within(grid).getAllByRole('listitem').map((li) => li.querySelector('b')?.textContent);
    expect(names).toEqual(['favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512-maskable.png']);
    const apple = within(grid).getByAltText('apple-touch-icon.png, 180×180 px') as HTMLImageElement;
    expect(apple.getAttribute('src')).toBe(url('apple-touch-icon.png'));
    expect(within(grid).getByText('180×180 px · 1:1')).not.toBeNull();
    expect(screen.getByText('favicon.ico · site.webmanifest')).not.toBeNull();
  });

  it('zooms the pictures with the toggle', async () => {
    view('favicon', favSet);
    const pic = () => screen.getByAltText('icon-192.png, 192×192 px').parentElement as HTMLElement;
    expect(pic().style.width).toBe('160px');
    await userEvent.click(screen.getByRole('switch', { name: 'Ingrandisci' }));
    expect(pic().style.width).toBe('256px');
    expect(screen.queryByText(/· 1:1/)).toBeNull();
  });

  it('shows the contexts of a favicon: browser tab, iOS rounded corners and the maskable circle with its safe zone', () => {
    const { container } = view('favicon', favSet);
    expect(screen.getByText(/Scheda del browser/)).not.toBeNull();
    expect(container.querySelectorAll('.ms-idn-tab img').length).toBe(2);
    expect(container.querySelector('.ms-idn-ios img')?.getAttribute('src')).toBe(url('apple-touch-icon.png'));
    expect(container.querySelector('.ms-idn-circle img')?.getAttribute('src')).toBe(url('icon-512-maskable.png'));
    expect(container.querySelector('.ms-idn-circle .ms-idn-safe')).not.toBeNull();
    expect(screen.getByText(/Il cerchio tratteggiato è la zona sicura \(80%/)).not.toBeNull();
  });

  it('shows the Android circle of an app icon with background and foreground and the 66/108 safe zone', () => {
    const set: IdentitySetInfo = { dir: FAV, warnings: [], files: [
      { path: 'AppIcon-1024.png', width: 1024, height: 1024, alpha: false, role: 'opaque' },
      { path: 'ic_launcher_foreground.png', width: 432, height: 432, alpha: true, role: 'android-foreground' },
      { path: 'ic_launcher_background.png', width: 432, height: 432, alpha: false, role: 'android-background' },
    ] };
    const { container } = view('app-icon', set);
    expect(container.querySelectorAll('.ms-idn-circle img').length).toBe(2);
    expect(container.querySelector('.ms-idn-ios img')?.getAttribute('src')).toBe(url('AppIcon-1024.png'));
    expect(screen.getByText(/zona sicura \(61%/)).not.toBeNull();
  });

  it('lists the set\'s warnings', () => {
    view('favicon', favSet);
    const note = screen.getByRole('note');
    expect(within(note).getByText(/il 12% del disegno è fuori dalla zona sicura/)).not.toBeNull();
  });

  it('a logo has no context masks', () => {
    const { container } = view('logo', logoSet);
    expect(container.querySelector('.ms-idn-ctx')).toBeNull();
    expect(screen.getByText('1024×400 px · 1:1')).not.toBeNull();
  });
});

describe('Export control · image formats (decision 974: no Render button)', () => {
  const control = (v: VersionEntry, format: string, jobs: unknown[] = []) => render(
    <I18nProvider locale="it"><ExportButton jobs={jobs as never} jobKey="creative:/w:acme:lancio" scope={{ version: v, format }} onClick={() => {}} /></I18nProvider>);

  it('idle: Esporta, and nothing offers a render', () => {
    control(version(1, [out(FAV, undefined, false)]), FAV);
    expect(screen.getByRole('button', { name: 'Esporta' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /render/i })).toBeNull();
  });

  it('while the image renders: the percent inside the same control', () => {
    const key = renderJobKeyOf('creative:/w:acme:lancio', 1)!;
    const job = { id: 'r1', key, kind: 'render', label: 'x', state: 'running', createdAt: at, formats: [FAV], progress: { format: FAV, phase: 'frames', done: 40, total: 100 } };
    control(version(1, [out(FAV, undefined, false)]), FAV, [job]);
    expect(screen.getByRole('button', { name: 'Render 40%' }).classList.contains('ms-cv-export')).toBe(true);
  });
});

describe('FormatView · identity formats', () => {
  it('a favicon: the picture, a Dimensioni view with the grid, and the pill for the set', async () => {
    render(<Harness format={FAV} />);
    await waitFor(() => expect(within(document.querySelector('.ms-topbar') as HTMLElement).getByRole('button', { name: 'Esporta' })).not.toBeNull());
    expect(screen.queryByRole('list', { name: 'Dimensioni' })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Dimensioni' }));
    expect(screen.getByRole('list', { name: 'Dimensioni' })).not.toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Immagine' }));
    expect(screen.queryByRole('list', { name: 'Dimensioni' })).toBeNull();
  });

  it('a logo is shown on light and on dark, side by side', async () => {
    detail = detailOf([LOGO], [version(1, [out(LOGO, logoSet)])]);
    location.hash = '#/p/acme/c/lancio/f/identity-logo';
    const { container } = render(<Harness format={LOGO} />);
    const split = await waitFor(() => { const el = container.querySelector('.ms-idn-split'); expect(el).not.toBeNull(); return el as HTMLElement; });
    expect(split.querySelectorAll('img').length).toBe(2);
    expect(within(split).getByText('Su chiaro')).not.toBeNull();
    expect(within(split).getByText('Su scuro')).not.toBeNull();
  });

  it('a logo with its negative shows logo-dark.png on dark, and no hint (note 9)', async () => {
    const withDark: IdentitySetInfo = { ...logoSet, files: [...logoSet.files, { path: 'logo-dark.svg', role: 'vector-dark' }, { path: 'logo-dark.png', width: 1024, height: 400, alpha: true, role: 'raster-dark' }] };
    detail = detailOf([LOGO], [version(1, [out(LOGO, withDark)])]);
    location.hash = '#/p/acme/c/lancio/f/identity-logo';
    const { container } = render(<Harness format={LOGO} />);
    const split = await waitFor(() => { const el = container.querySelector('.ms-idn-split'); expect(el).not.toBeNull(); return el as HTMLElement; });
    const dark = split.querySelector('.ms-idn-dark img') as HTMLImageElement;
    const light = split.querySelector('.ms-idn-light img') as HTMLImageElement;
    expect(dark.getAttribute('src')).toContain(`${LOGO}/logo-dark.png`);
    expect(light.getAttribute('src')).not.toContain('logo-dark');
    expect(screen.queryByText('Rigenera per avere il logo negativo')).toBeNull();
  });

  it('an older logo without its negative shows the main logo on dark, with a hint to regenerate', async () => {
    detail = detailOf([LOGO], [version(1, [out(LOGO, logoSet)])]);
    location.hash = '#/p/acme/c/lancio/f/identity-logo';
    const { container } = render(<Harness format={LOGO} />);
    const split = await waitFor(() => { const el = container.querySelector('.ms-idn-split'); expect(el).not.toBeNull(); return el as HTMLElement; });
    const srcs = [...split.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(srcs[0]).toBe(srcs[1]);
    expect((await screen.findByText('Rigenera per avere il logo negativo')).closest('[role="note"]')).not.toBeNull();
  });

  it('the favicon\'s SVG can be used as the brand logo; a set without SVG offers nothing', async () => {
    const first = render(<Harness format={FAV} />);
    await screen.findByRole('button', { name: /Usa .* come logo del brand/ });
    const set: IdentitySetInfo = { dir: 'identity-app-icon', files: [{ path: 'AppIcon-1024.png', width: 1024, height: 1024, alpha: false, role: 'opaque' }], warnings: [] };
    detail = detailOf(['identity-app-icon'], [version(1, [out('identity-app-icon', set)])]);
    location.hash = '#/p/acme/c/lancio/f/identity-app-icon';
    // Unmounted through React: the Tooltip's description is portalled into body, so wiping body would orphan it.
    first.unmount();
    render(<Harness format="identity-app-icon" />);
    await screen.findByRole('radio', { name: 'Dimensioni' });
    expect(screen.queryByRole('button', { name: /come logo del brand/ })).toBeNull();
  });
});

describe('SVG refusals in the problems', () => {
  const it1 = 'logo.svg è stato rifiutato dal controllo SVG: the SVG has a <script> element';
  const it2 = 'logo.svg è stato rifiutato dal controllo SVG: the SVG has an onclick attribute';

  it('groups the refusals of one file and leaves the other problems alone', () => {
    // The English line carries the format's name before a colon, as the core writes it; it joins the same file's group.
    expect(groupProblems([it1, 'La composizione dura 3s', it2, 'identity-logo: logo.svg was refused by the SVG check: the SVG is over 512 KB'])).toEqual([
      { kind: 'svg', file: 'logo.svg', reasons: ['the SVG has a <script> element', 'the SVG has an onclick attribute', 'the SVG is over 512 KB'] },
      { kind: 'plain', text: 'La composizione dura 3s' },
    ]);
    expect(groupProblems(['a.svg è stato rifiutato dal controllo SVG: x', 'b.svg è stato rifiutato dal controllo SVG: y']).map((i) => i.kind)).toEqual(['svg', 'svg']);
  });

  it('shows the translated summary and the English reasons only behind "Dettagli"', async () => {
    render(<I18nProvider locale="it"><ProblemList problems={[it1, it2]} /></I18nProvider>);
    expect(screen.getByText('logo.svg non ha passato il controllo di sicurezza degli SVG (2 motivi)')).not.toBeNull();
    expect(screen.queryByText(/<script>/)).toBeNull();
    const btn = screen.getByRole('button', { name: 'Dettagli' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('the SVG has a <script> element')).not.toBeNull();
  });

  it('the tooltip and the short reasons give the summary, never the colon-cut English reason', async () => {
    const { summarizeProblems } = await import('../src/screens/svgRefusals.ts');
    const { shortProblems } = await import('../src/screens/renderModel.ts');
    const { messages } = await import('@motion-studio/shared');
    const m = messages('it');
    const raw = ['identity-logo: ' + it1, it2, 'Test · Logo: il file pesa troppo'];
    expect(summarizeProblems(raw, m)).toEqual(['logo.svg non ha passato il controllo di sicurezza degli SVG (2 motivi)', 'Test · Logo: il file pesa troppo']);
    const short = shortProblems({ problems: raw }, m, 'it');
    expect(short).toEqual(['logo.svg non ha passato il controllo di sicurezza degli SVG (2 motivi)', 'il file pesa troppo']);
    expect(short.join(' ')).not.toMatch(/script|onclick/);
    const { RenderProblemChip } = await import('../src/screens/CanvasBoard.tsx');
    render(<I18nProvider locale="it"><RenderProblemChip problems={[it1, it2]} label="Logo" onRender={() => {}} /></I18nProvider>);
    const chip = screen.getByRole('button', { name: /Logo/ });
    expect(chip.getAttribute('title')).toBe('logo.svg non ha passato il controllo di sicurezza degli SVG (2 motivi)');
    await userEvent.click(chip);
    expect(screen.queryByText(/<script>/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Dettagli' }));
    expect(screen.getByText('the SVG has a <script> element')).not.toBeNull();
  });

  it('only the SVG refusals are picked out of a failed render\'s job notes', async () => {
    const { svgRefusalsOf } = await import('../src/screens/svgRefusals.ts');
    expect(svgRefusalsOf(['Test: 3 avvisi di fotogramma', it1])).toEqual([it1]);
  });
});
