import { DEFAULT_FORMATS, type JobSummary } from '@motion-studio/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

type Item = { format: string; slug: string; letter: string; version: number; source: 'pick' | 'default'; v?: number; file: string; width: number; height: number; state: 'ready' | 'needs-render' | 'missing'; composed?: true; hash?: string };
const POST = 'instagram-post-1x1';
const BANNER = 'web-banner-300x250';
const item = (o: Partial<Item> & Pick<Item, 'format' | 'slug' | 'letter' | 'version' | 'source'>): Item => ({ file: `${o.format}.png`, width: 300, height: 250, state: 'ready', ...o });
let plan: Item[];
/** The export job (decision 974): the group export answers with it; the dialog follows it in the live jobs. */
const exportJob = (over: Partial<JobSummary> = {}): JobSummary => ({ id: 'g1', key: 'export:/w:acme:lancio:00aa11bb', kind: 'export', label: 'Export · Lancio', state: 'running', createdAt: '2026-10-08T10:00:00.000Z', ...over });
let liveJobs: Record<string, JobSummary> = {};
const listeners = new Set<() => void>();
const setJob = (j: JobSummary) => act(() => { liveJobs = { ...liveJobs, [j.id]: j }; for (const l of listeners) l(); });
const useJobs = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => liveJobs);
const api = {
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  getStoryboard: vi.fn(async (_s: string, c: string, n: number, f: string) => ({ format: f, hash: 'e'.repeat(64), width: 270, expiresAt: new Date(Date.now() + 600_000).toISOString(),
    frames: [{ t: 3, kind: 'poster', url: `/sb/${c}/v${n}/${f}.jpg`, width: 270, height: 480 }] })),
  groupExportPlan: vi.fn(async (_s: string, _c: string) => ({ items: plan })),
  exportGroupJob: vi.fn(async (_s: string, _c: string, _body: { destination: string; formats?: string[] }) => ({ job: exportJob({ state: 'queued' }) })),
  exportPicksJob: vi.fn(async () => ({ job: exportJob({ id: 'p1', state: 'queued' }) })),
  prepareExport: vi.fn(async () => ({ renders: [] })),
  updateSettings: vi.fn(),
};
class ApiError extends Error { constructor(public status: number, msg: string, public code?: string, public retryAfterSec?: number, public problems?: string[]) { super(msg); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { ExportDialog } = await import('../src/screens/ExportDialog.tsx');
function Live(p: Omit<Parameters<typeof ExportDialog>[0], 'jobs'>) {
  return <ExportDialog {...p} jobs={useJobs()} />;
}

const open = (locale: 'it' | 'en' = 'it', group = true) => render(
  <I18nProvider locale={locale}>
    <Live open onClose={() => {}} slug="acme" creative="lancio" title="Lancio" snapshot={{ versions: [], states: {} }} presets={DEFAULT_FORMATS}
      pattern="{title}-{format}-v{v}" {...(group ? { group: true } : {})} />
  </I18nProvider>,
);

beforeEach(() => {
  localStorage.setItem('ms.exportFolder', '/out');
  liveJobs = {};
  for (const f of [api.groupExportPlan, api.exportGroupJob, api.exportPicksJob]) f.mockClear();
  plan = [item({ format: POST, slug: 'lancio', letter: 'a', version: 2, source: 'default' }), item({ format: BANNER, slug: 'lancio~b', letter: 'b', version: 3, source: 'pick' })];
});

describe('ExportDialog · group export', () => {
  it('report 47: a member\'s composition without a render shows a still of it, from that member', async () => {
    plan = [item({ format: POST, slug: 'lancio', letter: 'a', version: 2, source: 'default' }),
      item({ format: BANNER, slug: 'lancio~b', letter: 'b', version: 3, source: 'pick', file: '', state: 'needs-render', composed: true, hash: 'e'.repeat(64) })];
    open();
    const dialog = await screen.findByRole('dialog', { name: /Esporta la selezione finale/ });
    await waitFor(() => expect(dialog.querySelector(`img[src="/sb/lancio~b/v3/${BANNER}.jpg"]`)).toBeTruthy());
    expect(api.getStoryboard).toHaveBeenCalledWith('acme', 'lancio~b', 3, BANNER);
  });

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
    open();
    await screen.findAllByText('lancio-web-banner-300x250-v3.png');
    await userEvent.click(screen.getByRole('checkbox', { name: /^Esporta Instagram · Post/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Esporta 1 file' }));
    await waitFor(() => expect(api.exportGroupJob).toHaveBeenCalled());
    expect(api.exportGroupJob).toHaveBeenCalledWith('acme', 'lancio', expect.objectContaining({ destination: '/out', formats: [BANNER], pattern: '{title}-{format}-v{v}', quality: 'high' }));
    expect(api.exportPicksJob).not.toHaveBeenCalled();
    await screen.findByRole('button', { name: 'Annulla export' });
    setJob(exportJob({ state: 'succeeded', export: { stage: 'done', pct: 100, destination: '/out', files: ['/out/b'], skipped: ['Banner (variante C v1): il file manca'] } }));
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

  it('final wave I3: a translation that needs "render anyway" shows the list, and "Render anyway" sends force to the group export', async () => {
    render(
      <I18nProvider locale="en">
        <Live open onClose={() => {}} slug="acme" creative="lancio" title="Lancio" snapshot={{ versions: [], states: {} }} presets={DEFAULT_FORMATS}
          pattern="{title}-{format}-v{v}" group locales={{ primary: 'en', extra: ['de'] }} />
      </I18nProvider>,
    );
    await screen.findAllByText('lancio-web-banner-300x250-v3.png');
    await userEvent.click(screen.getByRole('checkbox', { name: 'German' }));
    await userEvent.click(screen.getByRole('button', { name: /^Export \d+ files?$/ }));
    // In the background (decision 974) the refusal comes with the export job, its code and list kept.
    await screen.findByRole('button', { name: 'Cancel export' });
    setJob(exportJob({ state: 'failed', error: 'raw', export: { stage: 'rendering', pct: null, destination: '/out', refusal: { code: 'localization-needs-force', problems: ['Web · Banner (de)'] } } }));
    const item = await screen.findByText('Web · Banner (de)');
    expect(item.closest('[role=alert]')!.textContent).toContain('These translations have open problems or outdated texts:');
    await userEvent.click(screen.getByRole('button', { name: 'Render anyway' }));
    await waitFor(() => expect(api.exportGroupJob).toHaveBeenCalledTimes(2));
    expect(api.exportGroupJob.mock.calls[0]![2]).not.toHaveProperty('force');
    expect(api.exportGroupJob.mock.calls[1]![2]).toMatchObject({ locales: ['en', 'de'], force: true });
    expect(api.exportPicksJob).not.toHaveBeenCalled();
  });

  it('without the group flag the dialog is the per-creative one (no plan request)', () => {
    open('it', false);
    expect(api.groupExportPlan).not.toHaveBeenCalled();
    expect(screen.queryByText('Lettura della selezione finale…')).toBeNull();
  });
});
