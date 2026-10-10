import { DEFAULT_FORMATS, workspaceSettingsSchema, type VersionEntry } from '@motion-studio/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import type { FormatState } from '../src/screens/versionModel.ts';

const api = {
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  exportPicks: vi.fn(async (_s: string, _c: string, body: { destination: string }) => ({ destination: body.destination, files: [{ from: 'a', to: 'b' }], skipped: [] as string[] })),
  updateSettings: vi.fn(async (patch: { exportNamePattern?: string }) => workspaceSettingsSchema.parse({ schemaVersion: 1, ...patch })),
};
class ApiError extends Error { constructor(public status: number, msg: string, public code?: string) { super(msg); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { ExportDialog } = await import('../src/screens/ExportDialog.tsx');

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
const open = (s = states(), pattern = '{title}-{format}-v{v}', presets = DEFAULT_FORMATS) => render(
  <I18nProvider locale="en">
    <ExportDialog open onClose={() => {}} slug="acme" creative="c1" title="Summer launch" snapshot={{ versions, states: s }} presets={presets}
      pattern={pattern} onSettings={onSettings} />
  </I18nProvider>,
);
const patternField = () => screen.getByLabelText('File name pattern') as HTMLInputElement;
const setPattern = async (v: string) => { await userEvent.clear(patternField()); if (v) await userEvent.type(patternField(), v.replace(/[{[]/g, (c) => c + c)); };

beforeEach(() => { localStorage.setItem('ms.exportFolder', '/out'); api.exportPicks.mockClear(); api.updateSettings.mockClear(); onSettings.mockClear(); });

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

  it('sends the ★ picks, the followers apart, and the pattern', async () => {
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Export 3 files' }));
    await waitFor(() => expect(api.exportPicks).toHaveBeenCalledOnce());
    expect(api.exportPicks).toHaveBeenCalledWith('acme', 'c1', { destination: '/out', picks: { [REEL]: 5, [POST]: 7 }, follow: { [TIKTOK]: 5 }, pattern: '{title}-{format}-v{v}', date: DAY });
    expect((await screen.findByRole('status')).textContent).toContain('1 file exported');
  });

  it('a follower exported without its primary sends the version it shows, not a pick', async () => {
    open();
    await userEvent.click(screen.getByRole('checkbox', { name: /^Export Instagram · Story\/Reel/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Export 2 files' }));
    await waitFor(() => expect(api.exportPicks).toHaveBeenCalledWith('acme', 'c1', { destination: '/out', picks: { [POST]: 7 }, follow: { [TIKTOK]: 5 }, pattern: '{title}-{format}-v{v}', date: DAY }));
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
    await waitFor(() => expect(api.exportPicks).toHaveBeenCalledWith('acme', 'c1', { destination: '/out', picks: { [REEL]: 5, [POST]: 7 }, follow: { [TIKTOK]: 7 }, pattern: '{title}-{format}-v{v}', date: DAY }));
  });

  it('retries an export refused while old versions are hashed (hashes-pending), then succeeds (M9)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.exportPicks.mockRejectedValueOnce(Object.assign(new ApiError(503, 'Still computing', 'hashes-pending'), { retryAfterSec: 1 }));
      open();
      await userEvent.click(screen.getByRole('button', { name: 'Export 3 files' }));
      await waitFor(() => expect(api.exportPicks).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(1100);
      await waitFor(() => expect(api.exportPicks).toHaveBeenCalledTimes(2));
      expect(await screen.findByText('1 file exported')).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it('stops retrying when the dialog closes (M9)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.exportPicks.mockRejectedValue(Object.assign(new ApiError(503, 'Still computing', 'hashes-pending'), { retryAfterSec: 1 }));
      const view = open();
      await userEvent.click(screen.getByRole('button', { name: 'Export 3 files' }));
      await waitFor(() => expect(api.exportPicks).toHaveBeenCalledTimes(1));
      view.unmount();
      await vi.advanceTimersByTimeAsync(5000);
      expect(api.exportPicks).toHaveBeenCalledTimes(1);
    } finally { api.exportPicks.mockReset(); api.exportPicks.mockImplementation(async (_s, _c, body) => ({ destination: body.destination, files: [{ from: 'a', to: 'b' }], skipped: [] })); vi.useRealTimers(); }
  });

  it('shows a mapped message for a coded refusal', async () => {
    api.exportPicks.mockRejectedValueOnce(new ApiError(409, 'These files are missing or cannot be read safely, nothing was exported: TikTok · Video 9:16 v5', 'export-file-missing'));
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
