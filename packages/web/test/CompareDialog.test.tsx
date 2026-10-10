// Compare for one format (spec §3.2): chips from the format's history with the ★ marked, the image slider by default with
// "Side by side", two synced videos side by side with one transport (Space, ←/→), a per-side error, and the ★ actions.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type OutputFileInfo, type VersionEntry } from '@motion-studio/shared';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormatState } from '../src/screens/versionModel.ts';

const at = '2026-10-08T10:00:00.000Z';
const api = {
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  setExportPick: vi.fn(async (..._a: unknown[]) => ({})),
  setFormatLink: vi.fn(async (..._a: unknown[]) => ({})),
  restoreVersion: vi.fn(async () => ({})),
  revealVersion: vi.fn(async () => ({ ok: true })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { CompareDialog } = await import('../src/screens/CompareDialog.tsx');
const { useVersionActions } = await import('../src/screens/FormatVersions.tsx');

const POST = 'instagram-post-1x1';
const REEL = 'instagram-reel-9x16';
const TIKTOK = 'tiktok-9x16';
const out = (format: string, file: string, durationSec: number | null = null): OutputFileInfo =>
  ({ format, file, width: 1080, height: 1080, durationSec, verified: true, preview: null });
const version = (n: number, outputs: OutputFileInfo[], request = `change ${n}`): VersionEntry =>
  ({ n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request, outputs, problems: [], tools: [], renderCommand: null, basedOn: null });
const state = (id: string, history: number[], star: number, over: Partial<FormatState> = {}): FormatState => ({
  id, history, defaultVersion: history.at(-1) ?? null, exportVersion: star, starFileMissing: false, linkable: [], follows: null,
  star: { version: star, manual: star !== history.at(-1), newer: star !== history.at(-1) ? history.at(-1)! : null, follows: null } as FormatState['star'],
  ...over,
});

// v1: post + reel; v2: reel only changed; v3: post changed (reel carried). The reel's history is [1, 2], the post's [1, 3].
const versions = [
  version(1, [out(POST, 'post.png'), out(REEL, 'reel.mp4', 6), out(TIKTOK, 'reel.mp4', 6)]),
  version(2, [out(POST, 'post.png'), out(REEL, 'reel.mp4', 8), out(TIKTOK, 'reel.mp4', 8)]),
  version(3, [out(POST, 'post.png'), out(REEL, 'reel.mp4', 8), out(TIKTOK, 'reel.mp4', 8)]),
];
let states: Record<string, FormatState>;

function Harness({ format, initial }: { format: string; initial: [number, number] }) {
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const actions = useVersionActions({ slug: 'acme', creative: 'lancio', states, labelOf: (id) => id, resumeFrom: null, onChanged: () => {}, onError: setError });
  return (
    <>
      {error ? <p role="alert">{error}</p> : null}
      <CompareDialog open={open} onClose={() => setOpen(false)} slug="acme" creative="lancio" versions={versions} presets={DEFAULT_FORMATS}
        states={states} format={format} initial={initial} actions={actions} />
    </>
  );
}

let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  states = {
    [POST]: state(POST, [1, 3], 3),
    [REEL]: state(REEL, [1, 2], 2),
    [TIKTOK]: state(TIKTOK, [1, 2], 2, { follows: REEL }),
  };
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { value: play, configurable: true, writable: true });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { value: pause, configurable: true, writable: true });
});

const dialog = () => screen.findByRole('dialog', { name: 'Confronta le versioni' });

describe('CompareDialog · images', () => {
  it('opens on the slider over the two versions, with chips of the format’s history only', async () => {
    render(<Harness format={POST} initial={[1, 3]} />);
    const d = await dialog();
    expect(within(d).getByRole('radio', { name: 'Sovrapposte' }).getAttribute('aria-checked')).toBe('true');
    const slider = within(d).getByRole('slider', { name: 'Posizione del divisore' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider.getAttribute('aria-valuenow')).toBe('55');
    expect(within(d).getByRole('img', { name: /v1$/ }).getAttribute('src')).toBe('/f/acme/lancio/outputs/v1/post.png');
    expect(within(d).getByRole('img', { name: /v3$/ }).getAttribute('src')).toBe('/f/acme/lancio/outputs/v3/post.png');
    // v2 did not change the post: not offered. The ★ is marked on its chip.
    const left = within(d).getByRole('group', { name: 'Sinistra' });
    expect(within(left).getAllByRole('button').map((b) => b.textContent)).toEqual(['v1', 'v3 ★']);
    // No transport for images.
    expect(within(d).queryByRole('region', { name: 'Riproduzione' })).toBeNull();
  });

  it('clamps each request note to two lines and keeps the ★ actions outside the scrolling settings', async () => {
    render(<Harness format={POST} initial={[1, 3]} />);
    const d = await dialog();
    const note = within(d).getByText('change 3');
    expect(note.classList.contains('ms-clamp2')).toBe(true);
    expect(note.closest('.ms-reqnote')).not.toBeNull();
    const actions = d.querySelector('.ms-cmp-actions')!;
    expect(actions.closest('.ms-cmp-side-scroll')).toBeNull();
    expect(note.closest('.ms-cmp-side-scroll')).not.toBeNull();
    expect(actions.parentElement!.classList.contains('ms-cmp-side-col')).toBe(true);
  });

  it('"Side by side" shows both pictures without the slider', async () => {
    render(<Harness format={POST} initial={[1, 3]} />);
    const d = await dialog();
    await userEvent.click(within(d).getByRole('radio', { name: 'Affiancate' }));
    expect(within(d).queryByRole('slider', { name: 'Posizione del divisore' })).toBeNull();
    expect(within(d).getAllByRole('img').length).toBe(2);
  });

  it('marks the ★ side (Auto or your pick) and stars the other with “★ Use vN for export”', async () => {
    render(<Harness format={POST} initial={[1, 3]} />);
    const d = await dialog();
    expect(within(d).getByText('★ Auto')).toBeTruthy();
    expect((within(d).getByRole('button', { name: '★ Si esporta la v3' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(d).getByRole('button', { name: '★ Usa la v1 per l’export' }));
    await waitFor(() => expect(api.setExportPick).toHaveBeenCalledWith('acme', 'lancio', POST, 1));
  });

  it('closes only once the ★ is saved; a refusal stays in the dialog', async () => {
    api.setExportPick.mockRejectedValueOnce(new Error('disco pieno'));
    render(<Harness format={POST} initial={[1, 3]} />);
    const d = await dialog();
    await userEvent.click(within(d).getByRole('button', { name: '★ Usa la v1 per l’export' }));
    expect((await within(d).findByRole('alert')).textContent).toContain('disco pieno');
    expect(screen.getByRole('dialog', { name: 'Confronta le versioni' })).toBe(d);
    // Nothing went to the page behind it.
    expect(screen.getAllByRole('alert').every((el) => d.contains(el))).toBe(true);
    await userEvent.click(within(d).getByRole('button', { name: '★ Usa la v1 per l’export' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Confronta le versioni' })).toBeNull());
    expect(api.setExportPick).toHaveBeenCalledTimes(2);
  });

  it('a refusal clears when another version chip is chosen (M5)', async () => {
    api.setExportPick.mockRejectedValueOnce(new Error('disco pieno'));
    render(<Harness format={POST} initial={[1, 3]} />);
    const d = await dialog();
    await userEvent.click(within(d).getByRole('button', { name: '★ Usa la v1 per l’export' }));
    expect((await within(d).findByRole('alert')).textContent).toContain('disco pieno');
    const [sideA] = within(d).getAllByRole('group').filter((g) => g.classList.contains('ms-cmp-chips'));
    await userEvent.click(within(sideA!).getByRole('button', { name: /^v3/ }));
    expect(within(d).queryByRole('alert')).toBeNull();
  });

  it('a manual ★ says so, and the default version keeps its Auto mark', async () => {
    states[POST] = state(POST, [1, 3], 1);
    render(<Harness format={POST} initial={[1, 3]} />);
    const d = await dialog();
    expect(within(d).getByText('★ Scelta tua')).toBeTruthy();
    expect(within(d).getByText('Auto')).toBeTruthy();
    await userEvent.click(within(d).getByRole('button', { name: '★ Usa la v3 per l’export' }));
    await waitFor(() => expect(api.setExportPick).toHaveBeenCalledWith('acme', 'lancio', POST, 3));
  });
});

const videos = (d: HTMLElement) => [
  within(d).getByLabelText(/v1$/, { selector: 'video' }) as HTMLVideoElement,
  within(d).getByLabelText(/v2$/, { selector: 'video' }) as HTMLVideoElement,
];
/** The transport is enabled once the dialog's media are attached: wait for that, never for time. */
const transportReady = async (d: HTMLElement) => {
  await waitFor(() => expect((within(d).getByRole('button', { name: 'Riproduci (Spazio)' }) as HTMLButtonElement).disabled).toBe(false));
};

describe('CompareDialog · videos', () => {
  it('opens side by side: two labelled players, one transport over the longer duration', async () => {
    render(<Harness format={REEL} initial={[1, 2]} />);
    const d = await dialog();
    expect(within(d).getByRole('radio', { name: 'Affiancate' }).getAttribute('aria-checked')).toBe('true');
    const [a, b] = videos(d);
    expect(a!.getAttribute('src')).toBe('/f/acme/lancio/outputs/v1/reel.mp4');
    expect(b!.getAttribute('src')).toBe('/f/acme/lancio/outputs/v2/reel.mp4');
    expect(within(d).getAllByRole('region', { name: 'Riproduzione' }).length).toBe(1);
    // v1 is 6 s, v2 8 s: the bar spans 8 s.
    expect(within(d).getByRole('slider', { name: 'Posizione' }).getAttribute('aria-valuemax')).toBe('8');
  });

  it('Space plays and pauses both; ← → step both one frame', async () => {
    render(<Harness format={REEL} initial={[1, 2]} />);
    const d = await dialog();
    await transportReady(d);
    const [a, b] = videos(d);
    fireEvent.keyDown(d, { key: ' ', code: 'Space' });
    expect(play.mock.contexts).toEqual(expect.arrayContaining([a, b]));
    expect(within(d).getByRole('button', { name: /^Pausa/ })).toBeTruthy();
    fireEvent.keyDown(d, { key: ' ', code: 'Space' });
    expect(within(d).getByRole('button', { name: 'Riproduci (Spazio)' })).toBeTruthy();
    fireEvent.keyDown(d, { key: 'ArrowRight' });
    expect(a!.currentTime).toBeCloseTo(1 / 30, 6);
    expect(b!.currentTime).toBeCloseTo(1 / 30, 6);
    fireEvent.keyDown(d, { key: 'ArrowLeft' });
    expect(a!.currentTime).toBe(0);
    expect(b!.currentTime).toBe(0);
  });

  it('a video that fails shows an error on its side; the other keeps playing', async () => {
    render(<Harness format={REEL} initial={[1, 2]} />);
    const d = await dialog();
    await transportReady(d);
    const [a, b] = videos(d);
    fireEvent.error(b!);
    const alert = await within(d).findByRole('alert');
    expect(alert.textContent).toBe('Impossibile riprodurre la v2. Il file potrebbe essere stato spostato.');
    expect(alert.closest('.ms-cmp-pane')?.contains(b!)).toBe(true);
    play.mockClear();
    await userEvent.click(within(d).getByRole('button', { name: 'Riproduci (Spazio)' }));
    expect(play.mock.contexts).toEqual([a]);
  });

  it('"Overlay" pauses on the frame and puts the slider over the two videos', async () => {
    render(<Harness format={REEL} initial={[1, 2]} />);
    const d = await dialog();
    await transportReady(d);
    fireEvent.keyDown(d, { key: ' ', code: 'Space' });
    await userEvent.click(within(d).getByRole('radio', { name: 'Sovrapposte' }));
    expect(within(d).getByRole('button', { name: 'Riproduci (Spazio)' })).toBeTruthy();
    expect(within(d).getByRole('slider', { name: 'Posizione del divisore' })).toBeTruthy();
    // Same players (no reload): still the two versions.
    expect(videos(d).map((v) => v.getAttribute('src'))).toEqual(['/f/acme/lancio/outputs/v1/reel.mp4', '/f/acme/lancio/outputs/v2/reel.mp4']);
  });

  it('in Overlay a failing side’s message sits above both panes, wherever the divider is', async () => {
    render(<Harness format={REEL} initial={[1, 2]} />);
    const d = await dialog();
    await transportReady(d);
    await userEvent.click(within(d).getByRole('radio', { name: 'Sovrapposte' }));
    fireEvent.error(videos(d)[1]!);
    const alert = await within(d).findByRole('alert');
    expect(alert.textContent).toBe('Impossibile riprodurre la v2. Il file potrebbe essere stato spostato.');
    expect(alert.closest('.ms-cmp-pane')).toBeNull();
    const slider = within(d).getByRole('slider', { name: 'Posizione del divisore' });
    fireEvent.keyDown(slider, { key: 'End' });
    expect(within(d).getByRole('alert')).toBe(alert);
  });

  it('on a follower it compares and stars its primary’s history', async () => {
    render(<Harness format={TIKTOK} initial={[1, 2]} />);
    const d = await dialog();
    expect(within(d).getByText(/Confronta .*Reel/)).toBeTruthy();
    await userEvent.click(within(d).getByRole('button', { name: '★ Usa la v1 per l’export' }));
    await waitFor(() => expect(api.setExportPick).toHaveBeenCalledWith('acme', 'lancio', REEL, 1));
  });

  it('Escape closes the dialog', async () => {
    render(<Harness format={REEL} initial={[1, 2]} />);
    await dialog();
    await act(async () => { await userEvent.keyboard('{Escape}'); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Confronta le versioni' })).toBeNull());
  });
});
