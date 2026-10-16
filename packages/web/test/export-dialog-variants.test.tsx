import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

type Item = { format: string; slug: string; letter: string; version: number; source: 'pick' | 'default'; v?: number; file: string; width: number; height: number; state: 'ready' | 'needs-render' | 'missing' };
const POST = 'instagram-post-1x1';
const BANNER = 'web-banner-300x250';
const item = (o: Partial<Item> & Pick<Item, 'format' | 'slug' | 'letter' | 'version' | 'source'>): Item => ({ file: `${o.format}.png`, width: 300, height: 250, state: 'ready', ...o });
let plan: Item[];
const api = {
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  groupExportPlan: vi.fn(async (_s: string, _c: string) => ({ items: plan })),
  exportGroup: vi.fn(async (_s: string, _c: string, body: { destination: string; formats?: string[] }) => ({ destination: body.destination, files: [{ from: 'a', to: 'b' }], skipped: [] as string[], unavailable: [] as Array<{ message: string }> })),
  exportPicks: vi.fn(async (_s: string, _c: string, body: { destination: string }) => ({ destination: body.destination, files: [], skipped: [] as string[] })),
  prepareExport: vi.fn(async () => ({ renders: [] })),
  updateSettings: vi.fn(),
};
class ApiError extends Error { constructor(public status: number, msg: string, public code?: string) { super(msg); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { ExportDialog } = await import('../src/screens/ExportDialog.tsx');

const open = (locale: 'it' | 'en' = 'it', group = true) => render(
  <I18nProvider locale={locale}>
    <ExportDialog open onClose={() => {}} slug="acme" creative="lancio" title="Lancio" snapshot={{ versions: [], states: {} }} presets={DEFAULT_FORMATS}
      pattern="{title}-{format}-v{v}" {...(group ? { group: true } : {})} />
  </I18nProvider>,
);

beforeEach(() => {
  localStorage.setItem('ms.exportFolder', '/out');
  for (const f of [api.groupExportPlan, api.exportGroup, api.exportPicks]) f.mockClear();
  plan = [item({ format: POST, slug: 'lancio', letter: 'a', version: 2, source: 'default' }), item({ format: BANNER, slug: 'lancio~b', letter: 'b', version: 3, source: 'pick' })];
});

describe('ExportDialog · group export', () => {
  it('lists each format with where it comes from, named as the host names it', async () => {
    open();
    const dialog = await screen.findByRole('dialog', { name: /Esporta la selezione finale/ });
    await within(dialog).findAllByText('lancio-web-banner-300x250-v3.png');
    expect(within(dialog).getByText('Variante B · v3')).toBeTruthy();
    expect(within(dialog).getByText('Variante A · v2 · regola predefinita')).toBeTruthy();
    expect(within(dialog).getAllByText('lancio-instagram-post-1x1-v2.png').length).toBeGreaterThan(0);
    expect(dialog.textContent).not.toContain('~');
    // The thumbnail of a format picked from B is B's own file.
    expect(dialog.querySelector('img[src*="lancio~b"]')).toBeTruthy();
    expect(api.groupExportPlan).toHaveBeenCalledWith('acme', 'lancio');
  });

  it('exports through the group route with the ticked formats, never through the per-creative one; lists what was left out', async () => {
    api.exportGroup.mockResolvedValueOnce({ destination: '/out', files: [{ from: 'a', to: 'b' }], skipped: [], unavailable: [{ message: 'Banner (variante C v1): il file manca' }] });
    open();
    await screen.findAllByText('lancio-web-banner-300x250-v3.png');
    await userEvent.click(screen.getByRole('checkbox', { name: /^Esporta Instagram · Post/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Esporta 1 file' }));
    await waitFor(() => expect(api.exportGroup).toHaveBeenCalled());
    expect(api.exportGroup).toHaveBeenCalledWith('acme', 'lancio', expect.objectContaining({ destination: '/out', formats: [BANNER], pattern: '{title}-{format}-v{v}' }));
    expect(api.exportPicks).not.toHaveBeenCalled();
    expect(await screen.findByText(/Non esportati: Banner \(variante C v1\): il file manca/)).toBeTruthy();
  });

  it('a format whose file is missing is disabled with the reason; the dialog is translated', async () => {
    plan = [item({ format: POST, slug: 'lancio~c', letter: 'c', version: 1, source: 'pick', state: 'missing' }), plan[1]!];
    open('en');
    await screen.findAllByText('lancio-web-banner-300x250-v3.png');
    expect((screen.getByRole('checkbox', { name: /^Export Instagram · Post/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('The file of v1 is missing or cannot be read safely')).toBeTruthy();
    expect(screen.getByText('Variant B · v3')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export 1 file' })).toBeTruthy();
  });

  it('a follower keeps its primary\'s version in its name', async () => {
    plan = [item({ format: POST, slug: 'lancio~b', letter: 'b', version: 2, v: 4, source: 'pick' })];
    open();
    expect((await screen.findAllByText('lancio-instagram-post-1x1-v4.png')).length).toBeGreaterThan(0);
  });

  it('shows a clear error when the selection cannot be read', async () => {
    api.groupExportPlan.mockRejectedValueOnce(new ApiError(409, 'no group', 'variant-no-group'));
    open();
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('without the group flag the dialog is the per-creative one (no plan request)', () => {
    open('it', false);
    expect(api.groupExportPlan).not.toHaveBeenCalled();
    expect(screen.queryByText('Lettura della selezione finale…')).toBeNull();
  });
});
