import { DEFAULT_FORMATS, workspaceSettingsSchema, type JobSummary, type VersionEntry } from '@motion-studio/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import type { FormatState } from '../src/screens/versionModel.ts';

/** The export job the core answers with (decision 974): the dialog follows it in the live jobs. */
const exportJob = (over: Partial<JobSummary> = {}): JobSummary => ({ id: 'e1', key: 'export:/w:acme:c1:abcd0123', kind: 'export', label: 'Export · Summer launch', state: 'running', createdAt: '2026-10-08T10:00:00.000Z', ...over });
const api = {
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  getStoryboard: vi.fn(async (_s: string, c: string, n: number, f: string) => ({ format: f, hash: 'e'.repeat(64), width: 270, expiresAt: new Date(Date.now() + 600_000).toISOString(),
    frames: [{ t: 3, kind: 'poster', url: `/sb/${c}/v${n}/${f}.jpg`, width: 270, height: 480 }] })),
  exportPicksJob: vi.fn(async (_s: string, _c: string, _body: { destination: string }) => ({ job: exportJob({ state: 'queued' }) })),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
  updateSettings: vi.fn(async (patch: { exportNamePattern?: string }) => workspaceSettingsSchema.parse({ schemaVersion: 1, ...patch })),
  prepareExport: vi.fn(async (_s: string, _c: string, _body: unknown): Promise<{ renders: Array<{ version: number; formats: string[]; job: JobSummary; covers: boolean }> }> => ({ renders: [] })),
};
class ApiError extends Error { constructor(public status: number, msg: string, public code?: string) { super(msg); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { ExportDialog } = await import('../src/screens/ExportDialog.tsx');

/** The live jobs, as the app's event stream would update them. */
let liveJobs: Record<string, JobSummary> = {};
const listeners = new Set<() => void>();
const setJob = (j: JobSummary) => act(() => { liveJobs = { ...liveJobs, [j.id]: j }; for (const l of listeners) l(); });
const useJobs = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => liveJobs);
/** The export job ends with these files in /out. */
const finish = (files: string[], over: Partial<NonNullable<JobSummary['export']>> = {}) =>
  setJob(exportJob({ state: 'succeeded', export: { stage: 'done', pct: 100, destination: '/out', files, ...over } }));
function Live(p: Omit<Parameters<typeof ExportDialog>[0], 'jobs'>) {
  return <ExportDialog {...p} jobs={useJobs()} />;
}

const REEL = 'instagram-reel-9x16';
const TIKTOK = 'tiktok-9x16';
const POST = 'instagram-post-1x1';
const out = (format: string, ext: string, size = 1080) => ({ format, file: `${format}.${ext}`, width: 1080, height: size, durationSec: null, verified: true, preview: null });
const ver = (n: number, outputs: VersionEntry['outputs']): VersionEntry =>
  ({ n, commit: 'c', sessionId: 's', status: 'complete', createdAt: '2026-10-08T10:00:00.000Z', request: '', outputs, problems: [], tools: [], renderCommand: null, basedOn: null });
const versions = [ver(5, [out(REEL, 'mp4', 1920), out(TIKTOK, 'mp4', 1920), out(POST, 'png')]), ver(7, [out(REEL, 'mp4', 1920), out(TIKTOK, 'mp4', 1920), out(POST, 'png')])];
const state = (id: string, s: Partial<FormatState>): FormatState => ({
  id, history: [5, 7], star: { version: 7, manual: false, newer: null, follows: null }, defaultVersion: 7, exportVersion: 7, starFileMissing: false, linkable: [], follows: null, ...s,
});
const states = (over: Record<string, Partial<FormatState>> = {}) => ({
  [REEL]: state(REEL, { star: { version: 5, manual: true, newer: 7, follows: null }, exportVersion: 5, ...over[REEL] }),
  [TIKTOK]: state(TIKTOK, { history: [], star: { version: null, manual: false, newer: null, follows: REEL }, defaultVersion: null, exportVersion: 5, follows: REEL, ...over[TIKTOK] }),
  [POST]: state(POST, { ...over[POST] }),
});
const onSettings = vi.fn();
const DAY = expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/);
const open = (s = states(), pattern = '{title}-{format}-v{v}', presets = DEFAULT_FORMATS, onClose: () => void = () => {}) => render(
  <I18nProvider locale="en">
    <Live open onClose={onClose} slug="acme" creative="c1" title="Summer launch" snapshot={{ versions, states: s }} presets={presets}
      pattern={pattern} onSettings={onSettings} />
  </I18nProvider>,
);
const patternField = () => screen.getByLabelText('File name pattern') as HTMLInputElement;
const setPattern = async (v: string) => { await userEvent.clear(patternField()); if (v) await userEvent.type(patternField(), v.replace(/[{[]/g, (c) => c + c)); };

beforeEach(() => {
  localStorage.setItem('ms.exportFolder', '/out');
  localStorage.removeItem('ms.exportProfile');
  liveJobs = {};
  api.exportPicksJob.mockClear(); api.cancelJob.mockClear(); api.prepareExport.mockClear(); api.updateSettings.mockClear(); onSettings.mockClear();
});
const HIGH = { quality: 'high' };

describe('ExportDialog · the starred versions', () => {
  it('shows each format at its ★, the newer version, and followers named after themselves in their primary’s ★', () => {
    open();
    const dialog = screen.getByRole('dialog', { name: 'Export the starred versions of “Summer launch”' });
    expect(within(dialog).getByRole('heading', { name: 'Export the starred versions' })).toBeTruthy();
    // The row's name, and the live preview of the first one.
    expect(within(dialog).getAllByText('summer-launch-instagram-reel-9x16-v5.mp4')).toHaveLength(2);
    // The Reel's ★, and the same ★ on its follower.
    expect(within(dialog).getAllByText('★ v5')).toHaveLength(2);
    expect(within(dialog).getByText('v7 newer')).toBeTruthy();
    // The follower: its own file, in the Reel's ★ (v5), and "follows" instead of a ★.
    expect(within(dialog).getByText('summer-launch-tiktok-9x16-v5.mp4')).toBeTruthy();
    expect(dialog.querySelector('.ms-exp-follows')!.textContent).toBe('follows Story/Reel 9:16★ v5');
    expect(within(dialog).getByText('summer-launch-instagram-post-1x1-v7.png')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Export 3 files' })).toBeTruthy();
  });

  it('a ★ whose file is missing is unchecked and disabled, with the reason', () => {
    open(states({ [POST]: { starFileMissing: true } }));
    const check = screen.getByRole('checkbox', { name: /^Export Instagram · Post/ }) as HTMLButtonElement;
    expect(check.disabled).toBe(true);
    expect(check.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('The file of v7 is missing or cannot be read safely')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export 2 files' })).toBeTruthy();
  });

  it('a follower without its own file in the primary’s ★ is disabled with the reason', () => {
    const v5 = ver(5, [out(REEL, 'mp4', 1920), out(POST, 'png')]);
    render(
      <I18nProvider locale="en">
        <ExportDialog open onClose={() => {}} slug="acme" creative="c1" title="Summer launch" snapshot={{ versions: [v5, versions[1]!], states: states({ [TIKTOK]: { exportVersion: null, starFileMissing: true } }) }} presets={DEFAULT_FORMATS} pattern="{title}-{format}-v{v}" />
      </I18nProvider>,
    );
    expect((screen.getByRole('checkbox', { name: /^Export TikTok/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('v5 of the Story/Reel 9:16 has no file for this format')).toBeTruthy();
  });

  it('sends the ★ picks, the followers apart, the pattern and the default quality; the job ends with the files', async () => {
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Export 3 files' }));
    await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalledOnce());
    expect(api.exportPicksJob).toHaveBeenCalledWith('acme', 'c1', { destination: '/out', picks: { [REEL]: 5, [POST]: 7 }, follow: { [TIKTOK]: 5 }, pattern: '{title}-{format}-v{v}', date: DAY, ...HIGH });
    expect(await screen.findByText(/The export goes on in the background/)).toBeTruthy();
    finish(['/out/b.png']);
    expect((await screen.findByText('1 file exported')).closest('[role="status"]')).not.toBeNull();
  });

  it('can be closed while the export runs, and Cancel export stops the job (user report 20)', async () => {
    const onClose = vi.fn();
    open(states(), '{title}-{format}-v{v}', DEFAULT_FORMATS, onClose);
    await userEvent.click(screen.getByRole('button', { name: 'Export 3 files' }));
    await screen.findByRole('button', { name: 'Cancel export' });
    for (const b of screen.getAllByRole('button', { name: 'Close' })) expect((b as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel export' }));
    expect(api.cancelJob).toHaveBeenCalledWith('e1');
    setJob(exportJob({ state: 'cancelled' }));
    expect(await screen.findByText('Export cancelled')).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    expect(onClose).toHaveBeenCalled();
  });

  it('review #9: the started export leaves its "Render anyway" for when the dialog is closed, and says when it is open', async () => {
    const { exportRegistry } = await import('../src/screens/exportModel.ts');
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Export 3 files' }));
    await screen.findByRole('button', { name: 'Cancel export' });
    expect(exportRegistry.watched('e1')).toBe(true);
    const retry = exportRegistry.takeRetry('e1')!;
    await retry();
    expect(api.exportPicksJob).toHaveBeenLastCalledWith('acme', 'c1', expect.objectContaining({ force: true, picks: { [REEL]: 5, [POST]: 7 } }));
  });

  it('a failed export job says why, and the export can be tried again', async () => {
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Export 3 files' }));
    await screen.findByRole('button', { name: 'Cancel export' });
    setJob(exportJob({ state: 'failed', error: 'Render failed: Story/Reel 9:16 v5' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Export failed: Render failed: Story/Reel 9:16 v5');
    expect(screen.getByRole('button', { name: 'Export 3 files' })).toBeTruthy();
  });

  it('Show in Finder: one file is selected in its folder, several open the folder itself (user report 21)', async () => {
    const revealPath = vi.fn(async () => {});
    const openFolder = vi.fn(async () => {});
    (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => null, revealPath, openFolder };
    try {
      const view = open();
      await userEvent.click(screen.getByRole('button', { name: 'Export 3 files' }));
      await screen.findByRole('button', { name: 'Cancel export' });
      finish(['/out/a.mp4']);
      await userEvent.click(await screen.findByRole('button', { name: /Show in (Finder|folder)/ }));
      expect(revealPath).toHaveBeenCalledWith('/out/a.mp4');
      view.unmount();
      liveJobs = {};
      open();
      await userEvent.click(screen.getByRole('button', { name: 'Export 3 files' }));
      await screen.findByRole('button', { name: 'Cancel export' });
      finish(['/out/a.mp4', '/out/b.mp4']);
      await userEvent.click(await screen.findByRole('button', { name: /Show in (Finder|folder)/ }));
      expect(openFolder).toHaveBeenCalledWith('/out');
    } finally { delete (window as unknown as { motionStudio?: unknown }).motionStudio; }
  });

  it('a follower exported without its primary sends the version it shows, not a pick', async () => {
    open();
    await userEvent.click(screen.getByRole('checkbox', { name: /^Export Instagram · Story\/Reel/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Export 2 files' }));
    await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalledWith('acme', 'c1', { destination: '/out', picks: { [POST]: 7 }, follow: { [TIKTOK]: 5 }, pattern: '{title}-{format}-v{v}', date: DAY, ...HIGH }));
  });

  it('a follower whose file in the primary’s ★ is missing is disabled with the reason, which keeps full contrast', () => {
    open(states({ [TIKTOK]: { starFileMissing: true } }));
    const check = screen.getByRole('checkbox', { name: /^Export TikTok/ }) as HTMLButtonElement;
    expect(check.disabled).toBe(true);
    const reason = screen.getByText('The file of v5 is missing or cannot be read safely');
    // Only the picture and label of a blocked row are dimmed, not the row (and so not the reason).
    expect(reason.closest('.ms-exp-row')!.classList.contains('ms-blocked')).toBe(true);
    expect(reason.closest('.ms-exp-row')!.classList.contains('ms-off')).toBe(false);
  });

  it('a follower added without the agent exports its own later file, named and shown with its primary’s ★ (decisions log 140)', async () => {
    // Reel ★ v5; TikTok exists only in v7, where the Reel is an identical repeat.
    const v5 = ver(5, [out(REEL, 'mp4', 1920), out(POST, 'png')]);
    render(
      <I18nProvider locale="en">
        <ExportDialog open onClose={() => {}} slug="acme" creative="c1" title="Summer launch" snapshot={{ versions: [v5, versions[1]!], states: states({ [TIKTOK]: { exportVersion: 7 } }) }} presets={DEFAULT_FORMATS} pattern="{title}-{format}-v{v}" />
      </I18nProvider>,
    );
    const check = screen.getByRole('checkbox', { name: /^Export TikTok/ }) as HTMLButtonElement;
    expect(check.disabled).toBe(false);
    expect(screen.getByText('summer-launch-tiktok-9x16-v5.mp4')).toBeTruthy();
    expect(document.querySelector('.ms-exp-follows')!.textContent).toBe('follows Story/Reel 9:16★ v5');
    // The thumbnail is the follower's own file, from v7.
    expect(check.closest('.ms-exp-row')!.querySelector('video')!.getAttribute('src')).toContain('outputs/v7/');
  });

  it('a follower added without the agent sends its resolved version', async () => {
    open(states({ [TIKTOK]: { exportVersion: 7 } }));
    await userEvent.click(screen.getByRole('button', { name: 'Export 3 files' }));
    await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalledWith('acme', 'c1', { destination: '/out', picks: { [REEL]: 5, [POST]: 7 }, follow: { [TIKTOK]: 7 }, pattern: '{title}-{format}-v{v}', date: DAY, ...HIGH }));
  });

  it('retries an export refused while old versions are hashed (hashes-pending), then succeeds (M9)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.exportPicksJob.mockRejectedValueOnce(Object.assign(new ApiError(503, 'Still computing', 'hashes-pending'), { retryAfterSec: 1 }));
      open();
      await userEvent.click(screen.getByRole('button', { name: 'Export 3 files' }));
      await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(1100);
      await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalledTimes(2));
      expect(await screen.findByRole('button', { name: 'Cancel export' })).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it('stops retrying when the dialog closes (M9)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.exportPicksJob.mockRejectedValue(Object.assign(new ApiError(503, 'Still computing', 'hashes-pending'), { retryAfterSec: 1 }));
      const view = open();
      await userEvent.click(screen.getByRole('button', { name: 'Export 3 files' }));
      await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalledTimes(1));
      view.unmount();
      await vi.advanceTimersByTimeAsync(5000);
      expect(api.exportPicksJob).toHaveBeenCalledTimes(1);
    } finally { api.exportPicksJob.mockReset(); api.exportPicksJob.mockImplementation(async () => ({ job: exportJob({ state: 'queued' }) })); vi.useRealTimers(); }
  });

  it('shows a mapped message for a coded refusal', async () => {
    api.exportPicksJob.mockRejectedValueOnce(new ApiError(409, 'These files are missing or cannot be read safely, nothing was exported: TikTok · Video 9:16 v5', 'export-file-missing'));
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Export 3 files' }));
    expect((await screen.findByRole('alert')).textContent).toBe('These files are missing or cannot be read safely, nothing was exported: TikTok · Video 9:16 v5. Reopen Export to refresh the list.');
  });
});

describe('ExportDialog · name pattern', () => {
  it('updates the names and the preview live, and inserts tokens from the chips', async () => {
    open();
    await setPattern('{channel}_{ratio}_');
    expect(screen.getByText('instagram_9x16.mp4', { selector: '.ms-exp-preview .ms-exp-file' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '{v}' }));
    expect(patternField().value).toBe('{channel}_{ratio}_{v}');
    expect(screen.getByText('instagram_1x1_7.png')).toBeTruthy();
    expect(screen.getByText('tiktok_9x16_5.mp4')).toBeTruthy();
  });

  it('flags unknown variables (left out of the names)', async () => {
    open();
    await setPattern('{title}-{client}-v{v}');
    expect(screen.getByText('Unknown variables are left out: {client}')).toBeTruthy();
    expect(screen.getByText('summer-launch-v7.png')).toBeTruthy();
  });

  it('shows a collision inline, suggesting {format}, and blocks the export', async () => {
    open();
    await setPattern('{title}-v{v}');
    expect(screen.getByRole('alert').textContent).toBe('Two formats would get the same file name (summer-launch-v5.mp4). Add {format} to the pattern.');
    expect((screen.getByRole('button', { name: 'Export 3 files' }) as HTMLButtonElement).disabled).toBe(true);
    // Unchecking one of the two lifts it.
    await userEvent.click(screen.getByRole('checkbox', { name: /^Export TikTok/ }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'Export 2 files' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('refuses a pattern that gives an empty name, and cannot save it as default', async () => {
    open();
    await setPattern('!!!');
    expect(screen.getByRole('alert').textContent).toBe('This pattern gives an empty file name');
    expect((screen.getByRole('button', { name: 'Export 3 files' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Save as default' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('an empty name on a row not chosen blocks only “Save as default”, not the export (M4)', async () => {
    // The Reel (row 0) has a channel that slugs to nothing: `{channel}` names it empty.
    open(states(), '{title}-{format}-v{v}', DEFAULT_FORMATS.map((p) => (p.id === REEL ? { ...p, channel: '***' } : p)));
    await setPattern('{channel}');
    expect((screen.getByRole('button', { name: 'Export 3 files' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: /^Export .*Story/ }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'Export 2 files' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Save as default' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('“Save as default” saves the workspace pattern', async () => {
    open();
    const saveButton = screen.getByRole('button', { name: 'Save as default' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    await setPattern('{date}-{format}-v{v}');
    await userEvent.click(saveButton);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ exportNamePattern: '{date}-{format}-v{v}' }));
    expect(await screen.findByText('Saved as the workspace default')).toBeTruthy();
    expect(onSettings).toHaveBeenCalledWith(expect.objectContaining({ exportNamePattern: '{date}-{format}-v{v}' }));
    expect(saveButton.disabled).toBe(true);
  });
});


describe('ExportDialog · compositions rendered first (Task 8)', () => {
  const comp = (format: string) => ({ format, dir: `compositions/${format}`, hash: 'e'.repeat(64) });
  // v7 is a v2 version: the post is rendered (its file comes from the composition), the reel is not yet.
  const v7 = { ...ver(7, [{ ...out(POST, 'png'), sha256: 'f'.repeat(64), fromComposition: 'e'.repeat(64) }]), compositions: [comp(REEL), comp(POST)] };
  const twoStates = () => ({ [REEL]: state(REEL, { history: [7] }), [POST]: state(POST, { history: [7] }) });
  const job = (over: Partial<JobSummary> = {}): JobSummary => ({ id: 'r7', key: 'render:/w:acme:c1:v7', kind: 'render', label: 'Render · Summer launch v7', state: 'running', createdAt: '2026-10-08T10:00:00.000Z', formats: [REEL], ...over });
  const openWith = () => render(
    <I18nProvider locale="en">
      <Live open onClose={() => {}} slug="acme" creative="c1" title="Summer launch" snapshot={{ versions: [v7], states: twoStates() }} presets={DEFAULT_FORMATS}
        pattern="{title}-{format}-v{v}" />
    </I18nProvider>,
  );

  it('a ★ composition without a render is exportable, named with its render’s extension, and marked', () => {
    openWith();
    expect(screen.getAllByText('summer-launch-instagram-reel-9x16-v7.mp4')).toHaveLength(2);
    expect(screen.getAllByText('Rendered first')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Export 2 files' })).toBeTruthy();
  });

  it('report 47: a composition without a render shows a still of it; a rendered one its file', async () => {
    openWith();
    const thumbs = () => [...document.querySelectorAll('.ms-exp-row:not(.ms-exp-cols) .ms-exp-thumb')];
    await waitFor(() => expect(thumbs()[0]!.querySelector('img')?.getAttribute('src')).toBe(`/sb/c1/v7/${REEL}.jpg`));
    expect(api.getStoryboard).toHaveBeenCalledWith('acme', 'c1', 7, REEL);
    expect(thumbs()[1]!.querySelector('img')?.getAttribute('src')).toBe(`/f/acme/c1/outputs/v7/${POST}.png`);
    expect(api.getStoryboard).not.toHaveBeenCalledWith('acme', 'c1', 7, POST);
  });

  it('the core renders the missing formats first: the dialog shows the job\'s progress, then the files', async () => {
    openWith();
    await userEvent.click(screen.getByRole('button', { name: 'Export 2 files' }));
    await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalledWith('acme', 'c1', expect.objectContaining({ picks: { [REEL]: 7, [POST]: 7 } })));
    expect(api.prepareExport).not.toHaveBeenCalled();
    setJob(exportJob({ export: { stage: 'rendering', pct: 50, destination: '/out', renders: ['r7'] } }));
    expect(screen.getByRole('progressbar', { name: 'Rendering · 50%' }).getAttribute('aria-valuenow')).toBe('50');
    setJob(exportJob({ export: { stage: 'copying', pct: null, destination: '/out', renders: ['r7'] } }));
    expect(screen.getAllByText('Copying the files…').length).toBeGreaterThan(0);
    finish(['/out/a', '/out/b'], { renders: ['r7'] });
    expect(await screen.findByText('2 files exported')).toBeTruthy();
  });

  it('a ★ render with problems is shown with its reasons and starts unchecked; ticking it exports it anyway (I2)', async () => {
    const bad = { ...v7, outputs: [{ ...v7.outputs[0]!, problems: ['instagram-post-1x1.png is 31 MB, over the 30 MB limit'] }, { ...out(REEL, 'mp4', 1920), sha256: 'a'.repeat(64), fromComposition: 'e'.repeat(64) }] };
    render(
      <I18nProvider locale="en">
        <ExportDialog open onClose={() => {}} slug="acme" creative="c1" title="Summer launch" snapshot={{ versions: [bad], states: twoStates() }} presets={DEFAULT_FORMATS} pattern="{title}-{format}-v{v}" />
      </I18nProvider>,
    );
    expect(screen.getByText('Rendered with problems: instagram-post-1x1.png is 31 MB, over the 30 MB limit. Tick it to export it anyway')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export 1 file' })).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: /Post/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Export 2 files' }));
    await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalledWith('acme', 'c1', expect.objectContaining({ picks: { [REEL]: 7, [POST]: 7 } })));
  });

  it('the problem row says the short reason in the UI\'s language: "duration 4.8 s instead of 6 s" (P2)', () => {
    const bad = { ...v7, outputs: [{ ...v7.outputs[0]!, problems: ['instagram-post-1x1.png: duration 4.8s, about 6s requested'], issues: [{ code: 'durationOffTarget' as const, params: { duration: 4.8, target: 6 } }] }, { ...out(REEL, 'mp4', 1920), sha256: 'a'.repeat(64), fromComposition: 'e'.repeat(64) }] };
    render(
      <I18nProvider locale="en">
        <ExportDialog open onClose={() => {}} slug="acme" creative="c1" title="Summer launch" snapshot={{ versions: [bad], states: twoStates() }} presets={DEFAULT_FORMATS} pattern="{title}-{format}-v{v}" />
      </I18nProvider>,
    );
    expect(screen.getByText('Rendered with problems: duration 4.8 s instead of 6 s. Tick it to export it anyway')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: /Post/ }) as HTMLElement).getAttribute('aria-checked')).toBe('false');
  });

  it('a render made during the export that had problems is said in the final summary, with its reason (P2)', async () => {
    openWith();
    await userEvent.click(screen.getByRole('button', { name: 'Export 2 files' }));
    await screen.findByRole('button', { name: 'Cancel export' });
    finish(['/out/b'], { excluded: [{ format: REEL, version: 7, problems: ['x'], issues: [{ code: 'tooLarge', params: { size: 31.2, max: 30 } }] }] });
    const line = await screen.findByText(/^Not exported because the render has problems:/);
    expect(line.textContent).toMatch(/v7 \(31\.2 MB instead of at most 30 MB\)$/);
    expect(line.getAttribute('role')).toBe('alert');
  });

  it('nothing to render: no prepare step', async () => {
    const rendered = { ...v7, outputs: [...v7.outputs, { ...out(REEL, 'mp4', 1920), sha256: 'a'.repeat(64), fromComposition: 'e'.repeat(64) }] };
    render(
      <I18nProvider locale="en">
        <ExportDialog open onClose={() => {}} slug="acme" creative="c1" title="Summer launch" snapshot={{ versions: [rendered], states: twoStates() }} presets={DEFAULT_FORMATS} pattern="{title}-{format}-v{v}" />
      </I18nProvider>,
    );
    expect(screen.queryByText('Rendered first')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Export 2 files' }));
    await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalled());
    expect(api.prepareExport).not.toHaveBeenCalled();
  });
});

describe('ExportDialog · resolution and quality (decision 974, user report 22)', () => {
  const IMG = 'instagram-image-1x1';
  const comp = (format: string) => ({ format, dir: `compositions/${format}`, hash: 'e'.repeat(64) });
  const rendered = (format: string, ext: string, h: number) => ({ ...out(format, ext, h), sha256: 'a'.repeat(64), fromComposition: 'e'.repeat(64) });
  const v7 = { ...ver(7, [rendered(REEL, 'mp4', 1920), rendered(IMG, 'png', 1080)]), compositions: [comp(REEL), comp(IMG)] };
  const st = () => ({ [REEL]: state(REEL, { history: [7] }), [IMG]: state(IMG, { history: [7] }) });
  const openV2 = (locales?: { primary: 'en'; extra: ['it'] }) => render(
    <I18nProvider locale="en">
      <Live open onClose={() => {}} slug="acme" creative="c1" title="Summer launch" snapshot={{ versions: [v7], states: st() }} presets={DEFAULT_FORMATS}
        pattern="{title}-{format}-v{v}" {...(locales ? { locales } : {})} />
    </I18nProvider>,
  );

  it('offers the format size and 480p to 2160p, and Standard / High / Max with High first chosen', async () => {
    openV2();
    expect(screen.getByRole('button', { name: /^Resolution/ }).textContent).toContain('Format size');
    expect(screen.getByRole('radio', { name: 'High' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/about 8 Mbps at 1080p/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /^Resolution/ }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Format size', '480p', '720p', '1080p', '1440p (2K)', '2160p (4K)']);
  });

  it('a legacy export (no composition) offers no choice: its files are copied as they are', () => {
    open();
    expect(screen.queryByRole('button', { name: /^Resolution/ })).toBeNull();
  });

  it('sends the chosen resolution and quality, shows the video\'s size (the image keeps its own), and remembers them', async () => {
    const view = openV2();
    await userEvent.click(screen.getByRole('button', { name: /^Resolution/ }));
    await userEvent.click(await screen.findByRole('option', { name: '720p' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Max' }));
    // A 9:16 video at 720p is 720×1280; the image row shows no size.
    expect([...document.querySelectorAll('.ms-exp-size')].map((e) => e.textContent)).toEqual([' → 720×1280']);
    await userEvent.click(screen.getByRole('button', { name: 'Export 2 files' }));
    await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalledWith('acme', 'c1', expect.objectContaining({ quality: 'max', resolution: 720 })));
    view.unmount();
    openV2();
    expect(screen.getByRole('radio', { name: 'Max' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: /^Resolution/ }).textContent).toContain('720p');
  });

  it('report 39: offers the format\'s own frame rate (its recorded value) and 24 to 60 fps; sends and shows the choice, never remembers it', async () => {
    const view = openV2();
    expect(screen.getByRole('button', { name: /^Frame rate/ }).textContent).toContain('The format\'s own');
    await userEvent.click(screen.getByRole('button', { name: /^Frame rate/ }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(["The format's own", '24 fps', '25 fps', '30 fps', '50 fps', '60 fps']);
    await userEvent.click(await screen.findByRole('option', { name: '60 fps' }));
    expect([...document.querySelectorAll('.ms-exp-size')].map((e) => e.textContent)).toEqual([' → 60 fps']);
    await userEvent.click(screen.getByRole('button', { name: 'Export 2 files' }));
    await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalledWith('acme', 'c1', expect.objectContaining({ quality: 'high', fps: 60 })));
    view.unmount();
    // Not remembered (decision 1242): the next export starts again at the format's own.
    openV2();
    expect(screen.getByRole('button', { name: /^Frame rate/ }).textContent).toContain("The format's own");
  });

  it('report 39: the format\'s own frame rate shows its value when the renders recorded it; by default no fps is sent', async () => {
    const at = (o: ReturnType<typeof rendered>) => ({ ...o, render: { quality: 'high' as const, width: o.width, height: o.height, encoder: 'libx264' as const, fps: 30 as const } });
    const v = { ...v7, outputs: v7.outputs.map((o) => (o.format === REEL ? at(o as ReturnType<typeof rendered>) : o)) };
    render(
      <I18nProvider locale="en">
        <Live open onClose={() => {}} slug="acme" creative="c1" title="Summer launch" snapshot={{ versions: [v], states: st() }} presets={DEFAULT_FORMATS} pattern="{title}-{format}-v{v}" />
      </I18nProvider>,
    );
    expect(screen.getByRole('button', { name: /^Frame rate/ }).textContent).toContain("30 fps (the format's own)");
    await userEvent.click(screen.getByRole('button', { name: 'Export 2 files' }));
    await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalled());
    expect(api.exportPicksJob.mock.calls[0]![2]).not.toHaveProperty('fps');
  });

  it('with other languages the videos keep the format size and High: the choice is locked and said', async () => {
    openV2({ primary: 'en', extra: ['it'] });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Italian' }));
    expect(screen.getByText(/With other languages the videos are exported at the format size and High quality/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Resolution/ }) as HTMLButtonElement).disabled).toBe(true);
    // Review round 1 (Task 22): two formats in two languages are four files.
    await userEvent.click(screen.getByRole('button', { name: /^Export 4 files/ }));
    await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalledWith('acme', 'c1', expect.objectContaining({ quality: 'high', locales: ['en', 'it'] })));
    expect(api.exportPicksJob.mock.calls[0]![2]).not.toHaveProperty('resolution');
    expect(api.exportPicksJob.mock.calls[0]![2]).not.toHaveProperty('fps');
  });
});

describe('ExportDialog · subtitle files', () => {
  const sub = (lang: string) => ({ lang, origin: 'speech', cues: 3, edited: 0, hash: 'a'.repeat(64), timing: { version: 1, format: REEL, fingerprint: 'b'.repeat(64) }, timingChanged: false, staleCues: 0 }) as never;
  const openWith = (subtitles?: never[]) => render(
    <I18nProvider locale="it">
      <Live open onClose={() => {}} slug="acme" creative="c1" title="Summer launch" snapshot={{ versions, states: states() }} presets={DEFAULT_FORMATS}
        pattern="{title}-{format}-v{v}" onSettings={onSettings} {...(subtitles ? { subtitles } : {})} />
    </I18nProvider>,
  );
  it('shows the section only when the creative has subtitles', () => {
    openWith();
    expect(screen.queryByText('Sottotitoli')).toBeNull();
  });
  it('sends the ticked languages as subtitles.files (none ticked by default)', async () => {
    openWith([sub('it'), sub('en')] as never[]);
    const group = screen.getByRole('group', { name: 'Sottotitoli' });
    expect(within(group).getByText('File .srt e .vtt')).toBeTruthy();
    expect(within(group).getByText('Accanto a ogni video, per YouTube, Vimeo, LinkedIn e i siti.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Esporta 3 file' }));
    await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalledOnce());
    expect(api.exportPicksJob.mock.calls[0]![2]).not.toHaveProperty('subtitles');
  });
  it('ticking Italian sends subtitles: { files: [it] }', async () => {
    openWith([sub('it'), sub('en')] as never[]);
    await userEvent.click(screen.getByRole('checkbox', { name: /File \.srt e \.vtt.*italiano/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Esporta 7 file' }));
    await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalledOnce());
    expect(api.exportPicksJob.mock.calls[0]![2]).toMatchObject({ subtitles: { files: ['it'] } });
  });
});

describe('ExportDialog · the Sottotitoli section (Task 22)', () => {
  const sub = (lang: string, hash = 'a'.repeat(64)) => ({ lang, origin: 'speech', cues: 3, edited: 0, hash, timing: { version: 1, format: REEL, fingerprint: 'b'.repeat(64) }, timingChanged: false, staleCues: 0 }) as never;
  const openWith = (subtitles: never[], locale: 'it' | 'en' = 'it', snapshot: { versions: VersionEntry[]; states: Record<string, FormatState> } = { versions, states: states() }) => render(
    <I18nProvider locale={locale}>
      <Live open onClose={() => {}} slug="acme" creative="c1" title="Summer launch" snapshot={snapshot} presets={DEFAULT_FORMATS}
        pattern="{title}-{format}-v{v}" onSettings={onSettings} subtitles={subtitles} />
    </I18nProvider>,
  );
  /** The subtitle outputs, listed under the section (review round 1). */
  const preview = () => document.querySelector('.ms-exp-subs-out')?.textContent ?? '';
  const NOTE = 'File e tracce vanno con un video senza sottotitoli disegnati.';

  it('three rows, a check per language each: Nel video, File .srt e .vtt, Traccia nel file MP4; nothing ticked by default', () => {
    openWith([sub('it'), sub('en')]);
    const group = screen.getByRole('group', { name: 'Sottotitoli' });
    for (const row of ['Nel video', 'File .srt e .vtt', 'Traccia nel file MP4']) {
      const r = within(group).getByRole('group', { name: row });
      expect(within(r).getAllByRole('checkbox').map((c) => c.getAttribute('aria-checked'))).toEqual(['false', 'false']);
    }
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it('"Nel video: Inglese" and "Traccia nel file MP4: Italiano" send drawn [en] and soft [it], say the video is clean, and preview the -sub-en video', async () => {
    openWith([sub('it'), sub('en')]);
    await userEvent.click(screen.getByRole('checkbox', { name: /^Nel video.*inglese/i }));
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(preview()).toContain('summer-launch-instagram-reel-9x16-v5-sub-en.mp4');
    await userEvent.click(screen.getByRole('checkbox', { name: /^Traccia nel file MP4.*italiano/i }));
    expect(screen.getByText(NOTE)).toBeTruthy();
    expect(preview()).toContain('summer-launch-instagram-reel-9x16-v5-sub-en.mp4');
    expect(preview()).toContain('summer-launch-tiktok-9x16-v5-sub-en.mp4');
    // The still never gets a drawn copy.
    expect(preview()).not.toContain('post-1x1-v7-sub-en');
    // Every file counts: two clean videos, two drawn ones and the still (review round 1).
    expect(screen.getByText('5 file')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Esporta 5 file' }));
    await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalledOnce());
    expect(api.exportPicksJob.mock.calls[0]![2]).toMatchObject({ subtitles: { drawn: ['en'], soft: ['it'] } });
    expect((api.exportPicksJob.mock.calls[0]![2] as unknown as { subtitles: object }).subtitles).not.toHaveProperty('files');
  });

  it('the .srt and .vtt go next to the clean videos, named <stem>.<lang>, and the note says so', async () => {
    openWith([sub('it'), sub('en')]);
    await userEvent.click(screen.getByRole('checkbox', { name: /^File \.srt e \.vtt.*italiano/i }));
    expect(screen.getByText(NOTE)).toBeTruthy();
    for (const name of ['summer-launch-instagram-reel-9x16-v5.it.srt', 'summer-launch-instagram-reel-9x16-v5.it.vtt', 'summer-launch-tiktok-9x16-v5.it.srt']) expect(preview()).toContain(name);
    expect(preview()).not.toContain('post-1x1-v7.it.srt');
    // Three files and four subtitle files.
    expect(screen.getByRole('button', { name: 'Esporta 7 file' })).toBeTruthy();
  });

  it('only drawn languages: the plain video is named nowhere (it is not exported); its row names its drawn videos', async () => {
    openWith([sub('it'), sub('en')]);
    await userEvent.click(screen.getByRole('checkbox', { name: /^Nel video.*italiano/i }));
    const names = [...document.querySelectorAll('.ms-exp-file')].map((e) => e.textContent).join(' ');
    expect(names).not.toMatch(/reel-9x16-v5\.mp4/);
    const reel = document.querySelector('.ms-exp-row:not(.ms-exp-cols) .ms-exp-file')!;
    expect(reel.textContent).toBe('summer-launch-instagram-reel-9x16-v5-sub-it.mp4');
    expect(preview()).toContain('summer-launch-instagram-reel-9x16-v5-sub-it.mp4');
    expect(screen.getByRole('button', { name: 'Esporta 3 file' })).toBeTruthy();
  });

  it('"Nel video" names and counts the -sub- videos of the rows whose composition has the track only (final review I2)', async () => {
    openWith([sub('it'), sub('en')], 'it', { versions, states: states({ [REEL]: { subtitlesTrack: false }, [TIKTOK]: { subtitlesTrack: true }, [POST]: { subtitlesTrack: false } }) });
    await userEvent.click(screen.getByRole('checkbox', { name: /^Nel video.*inglese/i }));
    expect(preview()).toContain('summer-launch-tiktok-9x16-v5-sub-en.mp4');
    expect(preview()).not.toContain('reel-9x16-v5-sub-en');
    // The Reel draws no subtitles: with drawn languages only it gives no file, and its row says so.
    const reel = document.querySelector('.ms-exp-row:not(.ms-exp-cols) .ms-exp-file')!;
    expect(reel.textContent).toBe('Non disegna i sottotitoli: non esportato');
    // The TikTok's drawn video and the still.
    expect(screen.getByRole('button', { name: 'Esporta 2 file' })).toBeTruthy();
    // Files with it: the Reel's clean video and its files count again.
    await userEvent.click(screen.getByRole('checkbox', { name: /^File \.srt e \.vtt.*italiano/i }));
    expect(screen.getByRole('button', { name: 'Esporta 8 file' })).toBeTruthy();
  });

  it('no ticked row has the track: no "Nel video" row (final review I2)', async () => {
    openWith([sub('it')], 'it', { versions, states: states({ [REEL]: { subtitlesTrack: true }, [TIKTOK]: { subtitlesTrack: false }, [POST]: { subtitlesTrack: false } }) });
    const group = screen.getByRole('group', { name: 'Sottotitoli' });
    expect(within(group).getByRole('group', { name: 'Nel video' })).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: /^Nel video.*italiano/i }));
    // Unticking the only format with the track: the row goes, and its ticked language is not sent.
    await userEvent.click(screen.getByRole('checkbox', { name: /^Esporta Instagram · Story\/Reel/ }));
    expect(within(group).queryByRole('group', { name: 'Nel video' })).toBeNull();
    for (const row of ['File .srt e .vtt', 'Traccia nel file MP4']) expect(within(group).getByRole('group', { name: row })).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: /^Traccia nel file MP4.*italiano/i }));
    await userEvent.click(screen.getByRole('button', { name: /^Esporta \d+ file$/ }));
    await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalledOnce());
    expect((api.exportPicksJob.mock.calls[0]![2] as unknown as { subtitles: object }).subtitles).toEqual({ soft: ['it'] });
  });

  it('a set whose lines are unchanged (only its timing checked) keeps the render; one with corrected lines does not (final review M3)', () => {
    const comp = { format: REEL, dir: `compositions/${REEL}`, hash: 'e'.repeat(64) };
    const v7 = { ...ver(7, [{ ...out(REEL, 'mp4', 1920), sha256: 'f'.repeat(64), fromComposition: 'e'.repeat(64), subtitles: { lang: 'it', hash: 'a'.repeat(64) } }]), compositions: [comp] };
    const snap = { versions: [v7], states: { [REEL]: state(REEL, { history: [7] }) } };
    const withCues = (hash: string, cuesHash: string) => ({ ...(sub('it', hash) as object), cuesHash }) as never;
    const { unmount } = openWith([withCues('d'.repeat(64), 'a'.repeat(64))], 'en', snap);
    expect(screen.queryByText('Rendered first')).toBeNull();
    unmount();
    openWith([withCues('d'.repeat(64), 'c'.repeat(64))], 'en', snap);
    expect(screen.getByText('Rendered first')).toBeTruthy();
  });

  it('a ★ render that drew a set since corrected is rendered first (renderState with the creative\'s subtitle hashes)', () => {
    const comp = { format: REEL, dir: `compositions/${REEL}`, hash: 'e'.repeat(64) };
    const v7 = { ...ver(7, [{ ...out(REEL, 'mp4', 1920), sha256: 'f'.repeat(64), fromComposition: 'e'.repeat(64), subtitles: { lang: 'it', hash: 'a'.repeat(64) } }]), compositions: [comp] };
    const snap = { versions: [v7], states: { [REEL]: state(REEL, { history: [7] }) } };
    const { unmount } = openWith([sub('it', 'a'.repeat(64))], 'en', snap);
    expect(screen.queryByText('Rendered first')).toBeNull();
    unmount();
    openWith([sub('it', 'c'.repeat(64))], 'en', snap);
    expect(screen.getByText('Rendered first')).toBeTruthy();
  });
});

describe('ExportDialog · subtitle languages (Task 27)', () => {
  const sub = (lang: string, voice?: string) => ({ lang, origin: lang === 'it' || voice ? 'speech' : 'translation', cues: 3, edited: 0, hash: 'a'.repeat(64),
    timing: { version: 1, format: REEL, fingerprint: 'b'.repeat(64), ...(voice ? { locale: voice } : {}) }, timingChanged: false, staleCues: 0 }) as never;
  const openWith = (subtitles: never[]) => render(
    <I18nProvider locale="it">
      <Live open onClose={() => {}} slug="acme" creative="c1" title="Summer launch" snapshot={{ versions, states: states() }} presets={DEFAULT_FORMATS}
        pattern="{title}-{format}-v{v}" onSettings={onSettings} subtitles={subtitles} locales={{ primary: 'it', extra: ['de'] }} />
    </I18nProvider>,
  );
  const preview = () => document.querySelector('.ms-exp-subs-out')?.textContent ?? '';
  const videoOf = (language: RegExp) => screen.getByRole('button', { name: language });
  const sent = () => api.exportPicksJob.mock.calls[0]![2] as unknown as { subtitles: Record<string, unknown>; locales?: string[] };

  it('default pairing (U8): German subtitles on the German video, English on the original; any pair can be chosen', async () => {
    openWith([sub('it'), sub('en'), sub('de')]);
    await userEvent.click(screen.getByRole('checkbox', { name: /^Nel video.*tedesco/i }));
    await userEvent.click(screen.getByRole('checkbox', { name: /^Nel video.*inglese/i }));
    expect(videoOf(/^Video dei sottotitoli in tedesco/i).textContent).toMatch(/tedesco/i);
    expect(videoOf(/^Video dei sottotitoli in inglese/i).textContent).toMatch(/Originale/);
    expect(preview()).toContain('summer-launch-instagram-reel-9x16-v5-de-sub-de.mp4');
    expect(preview()).toContain('summer-launch-instagram-reel-9x16-v5-sub-en.mp4');
    // The Italian video's two drawn videos and its still; the German subtitles' two videos.
    expect(screen.getByRole('button', { name: 'Esporta 5 file' })).toBeTruthy();
    // English on the German video instead.
    await userEvent.click(videoOf(/^Video dei sottotitoli in inglese/i));
    await userEvent.click(screen.getByRole('option', { name: /tedesco/i }));
    expect(preview()).toContain('summer-launch-instagram-reel-9x16-v5-de-sub-en.mp4');
    // Nothing is asked of the Italian video now: its three files are exported as they are, next to the four German drawn ones.
    await userEvent.click(screen.getByRole('button', { name: 'Esporta 7 file' }));
    await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalledOnce());
    expect(sent().subtitles).toEqual({ drawn: [{ video: 'de', lang: 'en' }, { video: 'de', lang: 'de' }] });
  });

  it('files and tracks go with every exported video language: names and count per language', async () => {
    openWith([sub('it'), sub('en'), sub('de')]);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Tedesco' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /^File \.srt e \.vtt.*inglese/i }));
    for (const name of ['summer-launch-instagram-reel-9x16-v5.en.srt', 'summer-launch-instagram-reel-9x16-v5-de.en.srt', 'summer-launch-tiktok-9x16-v5-de.en.vtt']) expect(preview()).toContain(name);
    // Per language: two clean videos with two files each, and the still.
    expect(screen.getByRole('button', { name: 'Esporta 14 file' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Esporta 14 file' }));
    await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalledOnce());
    expect(sent()).toMatchObject({ locales: ['it', 'de'], subtitles: { files: ['en'] } });
  });

  it('a set timed on the German voice goes only on the German video: no other choice, files and tracks only with that video', async () => {
    openWith([sub('it'), sub('de', 'de')]);
    await userEvent.click(screen.getByRole('checkbox', { name: /^Nel video.*tedesco/i }));
    const video = videoOf(/^Video dei sottotitoli in tedesco/i) as HTMLButtonElement;
    expect([video.textContent, video.disabled]).toEqual([expect.stringMatching(/tedesco/i), true]);
    const soft = screen.getByRole('checkbox', { name: /^Traccia nel file MP4.*tedesco/i }) as HTMLButtonElement;
    expect(soft.disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Tedesco' }));
    expect(soft.disabled).toBe(false);
    await userEvent.click(soft);
    await userEvent.click(screen.getByRole('button', { name: /^Esporta \d+ file$/ }));
    await waitFor(() => expect(api.exportPicksJob).toHaveBeenCalledOnce());
    expect(sent().subtitles).toEqual({ drawn: [{ video: 'de', lang: 'de' }], soft: ['de'] });
  });
});
