// Report 44: the project's icon, automatic or chosen: the mark (project bar, Projects page), the choice in Project settings,
// and "Use as project icon" in an image's detail.
import { workspaceSettingsSchema, type AssetEntry } from '@motion-studio/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';
import { __resetToasts, getToasts } from '../src/ui/toast.tsx';

const at = '2026-10-19T10:00:00.000Z';
const asset = (file: string, kind: AssetEntry['kind'] = 'image'): AssetEntry =>
  ({ file, kind, origin: 'upload', sourceUrl: null, description: '', tags: [], width: 512, height: 512, addedAt: at, attribution: null });
const project = (icon?: unknown) => ({ schemaVersion: 1, name: 'Audin Desk', description: '', createdAt: at, updatedAt: at, linkedCodebases: [], ...(icon !== undefined ? { icon } : {}) });
const api = {
  projectFileUrl: (s: string, rel: string) => `/pf/${s}/${rel}`,
  getProject: vi.fn(),
  getCodebases: vi.fn(async () => []),
  updateProject: vi.fn(),
  listAssets: vi.fn(async () => ({ assets: [asset('brand/mark.png'), asset('photo.jpg'), asset('Inter.woff2', 'font'), asset('logo.svg', 'svg')], error: null, unregistered: [] })),
  listProjects: vi.fn(),
  recentCreatives: vi.fn(async () => []),
  getFormats: vi.fn(async () => ({ presets: [], error: null, path: '/x' })),
  listCreatives: vi.fn(async () => []),
  getBrand: vi.fn(async () => ({ kit: { colors: [], fonts: [], logos: [] }, kitError: null, guidelines: '', sources: [], sourcesError: null, proposals: [], jobKey: 'b' })),
  updateSettings: vi.fn(),
  getPermissions: vi.fn(async () => []),
  updateAsset: vi.fn(),
  assetWaveform: vi.fn(async () => ({ peaks: [] })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ProjectMark } = await import('../src/shell/ProjectSwitcher.tsx');
const { Projects } = await import('../src/screens/Projects.tsx');
const { ProjectSettings } = await import('../src/screens/ProjectSettings.tsx');
const { AssetDetail } = await import('../src/screens/assets/AssetDetail.tsx');

const live = (): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} });
const it_ = (node: React.ReactNode) => render(<I18nProvider locale="it">{node}</I18nProvider>);
beforeEach(() => { __resetToasts(); });
afterEach(() => { vi.clearAllMocks(); __resetToasts(); });

describe('the project mark', () => {
  it('shows the icon in a rounded square; the initials without one or when the file cannot be read', () => {
    const { container, rerender } = it_(<ProjectMark name="Audin Desk" slug="audin" icon="assets/brand/mark.png" />);
    const img = container.querySelector('.ms-projmark img')!;
    expect(img.getAttribute('src')).toBe('/pf/audin/assets/brand/mark.png');
    expect(container.querySelector('.ms-projmark')!.classList.contains('ms-has-icon')).toBe(true);
    fireEvent.error(img);
    expect(container.querySelector('.ms-projmark img')).toBeNull();
    expect(container.querySelector('.ms-projmark')!.textContent).toBe('AD');
    rerender(<I18nProvider locale="it"><ProjectMark name="Audin Desk" slug="audin" icon={null} /></I18nProvider>);
    expect(container.querySelector('.ms-projmark')!.textContent).toBe('AD');
  });

  it('the Projects page card shows the project icon in place of the initials', async () => {
    api.listProjects.mockResolvedValue([{ slug: 'audin', ok: true, project: project(), icon: 'assets/brand/mark.png' }, { slug: 'kx', ok: true, project: { ...project(), name: 'Kappa X' }, icon: null }]);
    it_(<Projects live={live()} />);
    const card = (await screen.findByText('Audin Desk', { selector: '.ms-pcard-name' })).closest('a')!;
    expect(card.querySelector('.ms-pmono img')?.getAttribute('src')).toBe('/pf/audin/assets/brand/mark.png');
    const other = screen.getByText('Kappa X', { selector: '.ms-pcard-name' }).closest('a')!;
    expect(other.querySelector('.ms-pmono')!.textContent).toBe('KX');
  });
});

describe('the Projects page follows the project icon', () => {
  it('review 6: a project change (its tick) reloads the list, so a new icon shows', async () => {
    api.listProjects.mockResolvedValue([{ slug: 'audin', ok: true, project: project(), icon: null }]);
    const { rerender } = it_(<Projects live={live()} />);
    const card = (await screen.findByText('Audin Desk', { selector: '.ms-pcard-name' })).closest('a')!;
    expect(card.querySelector('.ms-pmono img')).toBeNull();
    api.listProjects.mockResolvedValue([{ slug: 'audin', ok: true, project: project(), icon: 'assets/brand/mark.png' }]);
    rerender(<I18nProvider locale="it"><Projects live={{ ...live(), projectTicks: { audin: 1 } }} /></I18nProvider>);
    await waitFor(() => expect(screen.getByText('Audin Desk', { selector: '.ms-pcard-name' }).closest('a')!.querySelector('.ms-pmono img')?.getAttribute('src')).toBe('/pf/audin/assets/brand/mark.png'));
  });
});

describe('Project settings · project icon', () => {
  const page = () => <ProjectSettings slug="audin" live={live()} settings={workspaceSettingsSchema.parse({ schemaVersion: 1 })} onSettings={() => {}} />;
  const openGeneral = async () => { await userEvent.click(await screen.findByRole('button', { name: 'Generali' })); return screen.findByRole('radiogroup', { name: 'Icona del progetto' }); };

  it('offers Automatic, Initials and the library images (no fonts), and saves the choice', async () => {
    api.getProject.mockResolvedValue({ slug: 'audin', jobKey: 'k', project: project(), icon: 'assets/brand/mark.png' });
    api.updateProject.mockImplementation(async (_s: string, body: { icon: unknown }) => ({ slug: 'audin', jobKey: 'k', project: project(body.icon ?? undefined), icon: body.icon === 'initials' ? null : 'assets/photo.jpg' }));
    it_(page());
    const group = await openGeneral();
    const radios = await waitFor(() => { const r = within(group).getAllByRole('radio'); expect(r).toHaveLength(5); return r; });
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Automatica', 'Iniziali', 'brand/mark.png', 'photo.jpg', 'logo.svg']);
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true');
    // Automatic shows what it picked.
    expect(radios[0]!.querySelector('img')?.getAttribute('src')).toBe('/pf/audin/assets/brand/mark.png');
    await userEvent.click(radios[3]!);
    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith('audin', { icon: { asset: 'photo.jpg' } }));
    await waitFor(() => expect(within(group).getByRole('radio', { name: 'photo.jpg' }).getAttribute('aria-checked')).toBe('true'));
    await userEvent.click(within(group).getByRole('radio', { name: 'Iniziali' }));
    await waitFor(() => expect(api.updateProject).toHaveBeenLastCalledWith('audin', { icon: 'initials' }));
    await userEvent.click(within(group).getByRole('radio', { name: 'Automatica' }));
    await waitFor(() => expect(api.updateProject).toHaveBeenLastCalledWith('audin', { icon: null }));
  });
});

describe('Project settings · project icon · keyboard', () => {
  it('review 10: one tab stop (the checked choice); arrows move between choices, Space or Enter picks', async () => {
    api.getProject.mockResolvedValue({ slug: 'audin', jobKey: 'k', project: project(), icon: null });
    api.updateProject.mockImplementation(async (_s: string, body: { icon: unknown }) => ({ slug: 'audin', jobKey: 'k', project: project(body.icon ?? undefined), icon: null }));
    it_(<ProjectSettings slug="audin" live={live()} settings={workspaceSettingsSchema.parse({ schemaVersion: 1 })} onSettings={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Generali' }));
    const group = await screen.findByRole('radiogroup', { name: 'Icona del progetto' });
    const radios = await waitFor(() => { const r = within(group).getAllByRole('radio'); expect(r).toHaveLength(5); return r; });
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    radios[0]!.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(radios[1]);
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(radios[4]);
    expect(api.updateProject).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith('audin', { icon: { asset: 'logo.svg' } }));
  });
});

describe('an image\'s detail · Use as project icon', () => {
  const detail = (x: AssetEntry) => it_(<AssetDetail slug="audin" asset={x} describing={false} busy={false} onClose={() => {}} onSaved={() => {}} onRenamed={() => {}} onDescribe={() => {}} onUse={() => {}} onDelete={() => {}} />);

  it('sets the image as the project icon', async () => {
    api.updateProject.mockResolvedValue({ slug: 'audin', jobKey: 'k', project: project({ asset: 'brand/mark.png' }), icon: 'assets/brand/mark.png' });
    detail(asset('brand/mark.png'));
    await userEvent.click(screen.getByRole('button', { name: 'Usa come icona del progetto' }));
    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith('audin', { icon: { asset: 'brand/mark.png' } }));
    await waitFor(() => expect(getToasts().map((x) => x.text)).toContain('Icona del progetto aggiornata'));
  });

  it('is not offered for a font, an audio file or a video', () => {
    for (const x of [asset('Inter.woff2', 'font'), asset('jingle.mp3', 'audio'), asset('clip.mp4', 'video')]) {
      const { unmount } = detail(x);
      expect(screen.queryByRole('button', { name: 'Usa come icona del progetto' })).toBeNull();
      unmount();
    }
  });
});
