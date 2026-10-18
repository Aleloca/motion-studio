/**
 * The bars of a creative and of a format (user test reports 17, 23 and 29; decisions 972, 974, 976): one bar system. Left the
 * way back as a breadcrumb whose ancestors are links (the app, the project, the creative: no "← All formats" button), the
 * creative by its readable title (a variant sister, missing from the bar's catalog, by the page's title, else a cleaned
 * folder name); then the current item; right the object's actions, one filled (Esporta), the rare ones in "…", one version
 * control per format; then a separator and the app's controls. The format's facts are secondary text, and a duration off the
 * brief is a warning with the fix ("Usa 8 s nel brief").
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type CreativeDetail, type OutputFileInfo, type VersionEntry } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Route } from '../src/routes.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';

vi.setConfig({ testTimeout: 45_000 });

const at = '2026-10-08T10:00:00.000Z';
const VIDEO = 'tiktok-9x16';
const H = 'b'.repeat(64);
const out = (format: string, file: string, durationSec: number | null = null): OutputFileInfo => ({ format, file, width: 1080, height: 1920, durationSec, verified: true, preview: null });
const version = (n: number): VersionEntry => ({
  n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: n === 1 ? '' : 'Più ritmo', problems: [], tools: [], renderCommand: null, basedOn: null,
  outputs: [{ ...out(VIDEO, 'tiktok.mp4', 8), sha256: `${n}`.repeat(64).slice(0, 64), fromComposition: `${n}`.repeat(64).slice(0, 64) }],
  compositions: [{ format: VIDEO, dir: `compositions/${VIDEO}`, hash: `${n}`.repeat(64).slice(0, 64) }],
});
let briefSec = 8;
const detailOf = (slug = 'lancio'): CreativeDetail => ({
  slug, jobKey: `creative:/w:acme:${slug}`, versions: [version(1), version(2)],
  creative: {
    schemaVersion: 1, title: 'Lancio estivo per la nuova collezione di occhiali da sole', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'g', message: 'm', formats: [VIDEO], durationSec: briefSec, assets: [], notes: '' },
  },
} as unknown as CreativeDetail);

const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async (_s: string, c: string) => detailOf(c)),
  getConversation: vi.fn(async () => []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  fileBytes: vi.fn(async () => null),
  revokePreview: vi.fn(async () => ({ revoked: true })),
  getUsage: vi.fn(async () => { throw new Error('offline'); }),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: false, interrupt: false, checkedAt: at })),
  getPinFrames: vi.fn(async () => ({ n: 1, expiresAt: at, frames: [] })),
  revealVersion: vi.fn(async () => ({})),
  updateCreative: vi.fn(async (_s: string, _c: string, body: { brief?: { durationSec?: number } }) => ({ ...detailOf().creative, brief: { ...detailOf().creative.brief, ...body.brief } })),
  previewSession: vi.fn(async (_s: string, _c: string, n: number, format: string) => ({
    url: `http://127.0.0.1:61234/tok-${format}-v${n}/runtime/index.html?mode=preview&parentOrigin=x`, token: `tok-${format}-v${n}`, origin: 'http://127.0.0.1:61234',
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), format, hash: H, width: 1080, height: 1920, duration: 8, fps: 30,
  })),
  getEditorComposition: vi.fn(async (_s: string, _c: string, n: number, format: string) => ({
    n, format, primaryFormat: format, hash: `${n}`.repeat(64).slice(0, 64), files: [], fonts: [],
    composition: { $schema: 'motion-studio/composition@1', width: 1080, height: 1920, fps: 30, duration: 8, background: '#000000', fonts: [], scenes: [], tracks: [] },
  })),
  getStoryboard: vi.fn(async (_s: string, _c: string, _n: number, format: string) => ({ format, hash: H, width: 270, expiresAt: new Date(Date.now() + 600_000).toISOString(), frames: [] })),
};
class ApiError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { EditorScreen } = await import('../src/screens/editor/EditorScreen.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');

const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState;
function Harness({ creative = 'lancio', page = true, creatives = [{ slug: 'lancio', title: 'Lancio estivo' }], route }: {
  creative?: string; page?: boolean; creatives?: Array<{ slug: string; title: string }>; route?: Route;
}) {
  const shell = {
    route: route ?? { name: 'format', slug: 'acme', creative, format: VIDEO }, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: { acme: creatives }, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} },
    openPalette: () => {},
  } as unknown as Shell;
  return (
    <I18nProvider locale="it"><ShellContext.Provider value={shell}>
      <TopBar />
      {page ? <EditorScreen slug="acme" creative={creative} format={VIDEO} live={live} /> : null}
    </ShellContext.Provider></I18nProvider>
  );
}
const bar = () => document.querySelector('header.ms-topbar') as HTMLElement;
const crumbs = () => within(bar()).getByRole('navigation', { name: 'Posizione' });

beforeEach(() => { vi.clearAllMocks(); briefSec = 8; location.hash = `#/p/acme/c/lancio/f/${VIDEO}`; localStorage.clear(); });
afterEach(() => cleanup());

describe('the breadcrumb (user report 23)', () => {
  it('every ancestor is a link: the app, the project, the creative; no back button any more', () => {
    render(<Harness page={false} />);
    const nav = crumbs();
    expect(within(nav).getByRole('link', { name: 'Home di Motion Studio' }).getAttribute('href')).toBe('#/');
    expect(within(nav).getByRole('link', { name: 'Acme' }).getAttribute('href')).toBe('#/p/acme');
    expect(within(nav).getByRole('link', { name: 'Lancio estivo' }).getAttribute('href')).toBe('#/p/acme/c/lancio');
    expect(within(bar()).queryByRole('button', { name: 'Tutti i formati' })).toBeNull();
    expect(within(bar()).queryByRole('button', { name: 'Creatività' })).toBeNull();
  });

  it('a variant sister takes its group\'s title from the catalog, with its letter', () => {
    render(<Harness page={false} creative="lancio~b" />);
    const link = within(crumbs()).getByRole('link', { name: /^Lancio estivo/ });
    expect(link.getAttribute('href')).toBe('#/p/acme/c/lancio~b');
    expect(link.textContent).toContain('B');
  });

  it('an unknown creative shows its folder name cleaned (no date, no dashes), the whole text in the tooltip', () => {
    render(<Harness page={false} creative="2026-10-17-create-a-60-second-16-9~b" creatives={[]} />);
    const link = within(crumbs()).getByRole('link', { name: /^Create a 60 second 16 9/ });
    expect(link.getAttribute('title')).toMatch(/^Create a 60 second 16 9/);
  });

  it('the new-creative page: the project is the way back, "Nuova creatività" the current item', () => {
    render(<Harness page={false} route={{ name: 'new-creative', slug: 'acme' }} />);
    expect(within(crumbs()).getByRole('link', { name: 'Acme' }).getAttribute('href')).toBe('#/p/acme');
    expect(within(bar()).queryByRole('button', { name: 'Creatività' })).toBeNull();
  });
});

describe('the format page\'s bar (user reports 17, 19, 23)', () => {
  const ready = async () => {
    await waitFor(() => expect(bar().querySelector('.ms-cv-export')).not.toBeNull());
    await waitFor(() => expect(bar().querySelector('.ms-fv-crumb')).not.toBeNull());
  };

  it('the creative crumb takes the page\'s title and goes back to the creative', async () => {
    render(<Harness creatives={[]} />);
    await ready();
    const link = await within(crumbs()).findByRole('link', { name: /^Lancio estivo per la nuova collezione/ });
    expect(link.getAttribute('title')).toBe('Lancio estivo per la nuova collezione di occhiali da sole');
    await userEvent.click(link);
    expect(location.hash).toBe('#/p/acme/c/lancio');
  });

  it('one filled action (Esporta), one version control, the rare actions in "…", a separator before the app', async () => {
    render(<Harness />);
    await ready();
    const filled = [...bar().querySelectorAll('.ms-btn.ms-ink, .ms-btn.ms-accent')];
    expect(filled).toHaveLength(1);
    expect(filled[0]!.classList.contains('ms-cv-export')).toBe(true);
    // Decision 972 and report 17: no creative-wide "Versioni" menu beside the format's badge.
    expect(bar().querySelector('.ms-cv-vbtn')).toBeNull();
    expect(within(bar()).getAllByRole('button', { name: /si esporta la v/ })).toHaveLength(1);
    expect(within(bar()).queryByRole('button', { name: 'Duplica formato' })).toBeNull();
    const sep = bar().querySelector('.ms-bar-sep');
    expect(sep).not.toBeNull();
    expect(sep!.nextElementSibling?.classList.contains('ms-topbar-end')).toBe(true);
    // Report 17: "Live preview" is never a pill in the bar.
    expect(within(bar()).queryByText(/anteprima dal vivo/i)).toBeNull();

    await userEvent.click(within(bar()).getByRole('button', { name: 'Altre azioni' }));
    const menu = await screen.findByRole('menu', { name: 'Altre azioni' });
    expect(within(menu).getByRole('menuitem', { name: /Duplica formato/ })).toBeTruthy();
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Cronologia delle versioni/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Versioni' });
    await userEvent.click(within(dialog).getByRole('button', { name: /Mostra nel/ }));
    expect(api.revealVersion).toHaveBeenCalledWith('acme', 'lancio', 2);
  });

  it('the format\'s facts are secondary text and also the name\'s tooltip', async () => {
    render(<Harness />);
    await ready();
    expect(within(bar()).getByText('1080×1920 · 8 s · 30 fps')).toBeTruthy();
    expect(bar().querySelector('.ms-fv-crumb b')!.getAttribute('title')).toContain('1080×1920 · 8 s · 30 fps');
    expect(within(bar()).queryByRole('button', { name: /Il brief dice/ })).toBeNull();
  });

  it('a duration off the brief is a warning with the fix: "Usa 8 s nel brief" saves the brief\'s duration', async () => {
    briefSec = 6;
    render(<Harness />);
    await ready();
    expect(within(bar()).queryByText(/brief 6 s/)).toBeNull();
    await userEvent.click(within(bar()).getByRole('button', { name: /Il brief dice 6 s/ }));
    const pop = await screen.findByRole('dialog', { name: /Il brief dice 6 s/ });
    await userEvent.click(within(pop).getByRole('button', { name: 'Usa 8 s nel brief' }));
    await waitFor(() => expect(api.updateCreative).toHaveBeenCalledTimes(1));
    const [slug, creative, body] = api.updateCreative.mock.calls[0]!;
    expect([slug, creative]).toEqual(['acme', 'lancio']);
    expect(body).toEqual({ brief: expect.objectContaining({ durationSec: 8, goal: 'g', formats: [VIDEO] }) });
    await act(async () => {});
  });
});
