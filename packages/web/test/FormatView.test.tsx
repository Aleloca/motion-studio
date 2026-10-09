import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type CreativeDetail, type OutputFileInfo, type VersionEntry } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Route } from '../src/routes.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';

const at = '2026-10-08T10:00:00.000Z';
const out = (format: string, file: string, durationSec: number | null = null): OutputFileInfo => ({ format, file, width: 1080, height: 1080, durationSec, verified: true, preview: null });
const version = (n: number): VersionEntry =>
  ({ n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: '', outputs: [out('instagram-post-1x1', 'post.png'), out('tiktok-9x16', 'tiktok.mp4', 8)], problems: [], tools: [], renderCommand: null, basedOn: null });
const makeDetail = (versions: VersionEntry[], over: Partial<CreativeDetail['creative']> = {}): CreativeDetail => ({
  slug: 'lancio', jobKey: 'creative:/w:acme:lancio', versions,
  creative: {
    schemaVersion: 1, title: 'Lancio estivo', status: versions.length ? 'ready' : 'draft', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'g', message: 'm', formats: ['instagram-post-1x1', 'tiktok-9x16'], durationSec: 8, assets: [], notes: '' },
    ...over,
  },
});

let detail = makeDetail([version(1)]);
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async () => detail),
  getConversation: vi.fn(async () => []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  sendCreativeTurn: vi.fn(async () => ({ id: 'j9', key: 'k', kind: 'creative', label: 'x', state: 'queued', createdAt: at })),
  restoreVersion: vi.fn(async () => detail.creative),
  revealVersion: vi.fn(async () => ({ ok: true })),
  exportVersion: vi.fn(async () => ({ destination: '/d', files: [], skipped: [] })),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const flip = vi.fn(async () => undefined);
const chat = vi.hoisted(() => ({ renders: 0 }));
vi.mock('../src/components/Conversation.tsx', async (orig) => {
  const m = await orig<typeof import('../src/components/Conversation.tsx')>();
  return { ...m, Conversation: (p: Parameters<typeof m.Conversation>[0]) => { chat.renders += 1; return m.Conversation(p); } };
});
vi.mock('../src/motion/motion.ts', async (orig) => ({ ...(await orig<typeof import('../src/motion/motion.ts')>()), flip }));
const { FormatView } = await import('../src/screens/FormatView.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { __resetPendingPins, pinsKey, usePendingPins } = await import('../src/screens/pendingPins.ts');
const { setFrameOrigin, setShownVersion, takeFrameOrigin, takeShownVersion } = await import('../src/shell/intents.ts');
const { D } = await import('../src/motion/motion.ts');
const { I18nProvider } = await import('../src/i18n.tsx');

const emptyLive = (): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState);
const VIDEO = 'tiktok-9x16';
const IMAGE = 'instagram-post-1x1';

function Harness({ format }: { format: string }) {
  const route: Route = { name: 'format', slug: 'acme', creative: 'lancio', format };
  const shell = {
    route, live: emptyLive(),
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} },
    openPalette: () => {},
  } as unknown as Shell;
  return (
    <ShellContext.Provider value={shell}>
      <header className="ms-topbar"><TopBar /></header>
      <FormatView slug="acme" creative="lancio" format={format} live={emptyLive()} />
    </ShellContext.Provider>
  );
}

/** jsdom has no media playback: a fake clock on the element. */
const setTime = (video: HTMLVideoElement, t: number) => {
  Object.defineProperty(video, 'currentTime', { value: t, writable: true, configurable: true });
  fireEvent.timeUpdate(video);
};
const player = async () => (await screen.findByLabelText('TikTok · Video 9:16 v1', { selector: 'video' })) as HTMLVideoElement;
const seed = (pin: { x: number; y: number; timeSec: number | null; note: string; format?: string }, v = 1) => {
  const { result } = renderHook(() => usePendingPins(pinsKey('acme', 'lancio')));
  act(() => result.current[1]((ps) => [...ps, { pin: { format: VIDEO, ...pin }, version: v }]));
};

let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;
let platform: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => {
  vi.clearAllMocks();
  detail = makeDetail([version(1)]);
  __resetPendingPins();
  location.hash = '#/p/acme/c/lancio/f/tiktok-9x16';
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { value: play, configurable: true, writable: true });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { value: pause, configurable: true, writable: true });
  platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
});
afterEach(() => {
  platform?.mockRestore();
  platform = null;
});

describe('FormatView · video', () => {
  it('Space toggles playback, never while typing', async () => {
    render(<Harness format={VIDEO} />);
    await player();
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Pausa (Spazio)' })).toBeTruthy();
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(pause).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Riproduci (Spazio)' })).toBeTruthy();
    // In the composer a space is text.
    const field = screen.getByRole('textbox', { name: 'Chiedi una modifica' });
    fireEvent.keyDown(field, { key: ' ', code: 'Space' });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('steps one frame (1/30 s) with the arrows and shows the time', async () => {
    render(<Harness format={VIDEO} />);
    const video = await player();
    setTime(video, 1);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(video.currentTime).toBeCloseTo(1 + 1 / 30, 5);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(video.currentTime).toBeCloseTo(1 - 1 / 30, 5);
    await userEvent.click(screen.getByRole('button', { name: 'Fotogramma successivo (→)' }));
    expect(video.currentTime).toBeCloseTo(1, 5);
    const slider = screen.getByRole('slider', { name: 'Posizione' });
    expect(slider.getAttribute('aria-valuemax')).toBe('8');
  });

  it('a pin at 5 s is visible at 5.3 s and not at 6 s, and always marked on the bar', async () => {
    seed({ x: 0.4, y: 0.3, timeSec: 5, note: 'Logo più grande' });
    render(<Harness format={VIDEO} />);
    const video = await player();
    const stage = screen.getByRole('region', { name: 'Anteprima di TikTok · Video 9:16' });
    setTime(video, 5.3);
    expect(within(stage).getByRole('button', { name: 'Modifica il commento 1' })).toBeTruthy();
    setTime(video, 6);
    expect(within(stage).queryByRole('button', { name: 'Modifica il commento 1' })).toBeNull();
    // The bar marker seeks to the comment.
    await userEvent.click(screen.getByRole('button', { name: 'Commento 1 a 00:05.00' }));
    expect(video.currentTime).toBe(5);
  });

  it('a click on the paused frame places a comment at the current time; it becomes a chip of the composer', async () => {
    render(<Harness format={VIDEO} />);
    const video = await player();
    setTime(video, 2.5);
    expect(screen.getByText('Clicca il punto del fotogramma a 00:02.50')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Commenta il fotogramma a 00:02.50' }));
    const bubble = screen.getByRole('group', { name: 'Commento 1' });
    expect(within(bubble).getByText('A 00:02.50')).toBeTruthy();
    await userEvent.type(within(bubble).getByRole('textbox'), 'Testo più alto');
    await userEvent.click(within(bubble).getByRole('button', { name: 'Commenta' }));
    const { result } = renderHook(() => usePendingPins(pinsKey('acme', 'lancio')));
    expect(result.current[0]).toEqual([{ pin: { format: VIDEO, x: 0.5, y: 0.5, timeSec: 2.5, note: 'Testo più alto' }, version: 1 }]);
    expect(screen.getByRole('button', { name: /Modifica il commento 1 · Testo più alto/ })).toBeTruthy();
  });

  it('a click while playing pauses instead of commenting', async () => {
    render(<Harness format={VIDEO} />);
    const video = await player();
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    await userEvent.click(video);
    expect(pause).toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Commento 1' })).toBeNull();
  });

  it('comments only on the pin source version, and says why', async () => {
    detail = makeDetail([version(1), version(2)], { resumeFrom: { version: 1, sessionId: 's' } });
    render(<Harness format={VIDEO} />);
    await screen.findByLabelText('TikTok · Video 9:16 v2', { selector: 'video' });
    expect(screen.getByText('I commenti valgono per la v1: usa Riparti da qui per commentare questa versione.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Commenta il fotogramma/ })).toBeNull();
  });

  it('shows the Scenes column with the timeline note and no fake controls', async () => {
    render(<Harness format={VIDEO} />);
    await player();
    const scenes = screen.getByRole('complementary', { name: 'Scene' });
    expect(within(scenes).getByText('Modifica scene, testi e tempi direttamente — arriva con la timeline')).toBeTruthy();
    expect(within(scenes).queryByRole('button')).toBeNull();
    expect(within(scenes).queryByRole('textbox')).toBeNull();
  });
});

describe('FormatView · shared element and bar', () => {
  it('opening with the saved rect calls flip on the player', async () => {
    const rect = new DOMRect(10, 20, 300, 540);
    setFrameOrigin('format:acme/lancio/tiktok-9x16', rect);
    render(<Harness format={VIDEO} />);
    const video = await player();
    await waitFor(() => expect(flip).toHaveBeenCalledWith(video.closest('.ms-fv-frame'), rect, D.l));
    expect(takeFrameOrigin('format:acme/lancio/tiktok-9x16')).toBeNull();
  });

  it('"← All formats" goes back to the creative route, keeping the player rect for T4', async () => {
    render(<Harness format={VIDEO} />);
    await player();
    await userEvent.click(screen.getByRole('button', { name: 'Tutti i formati' }));
    expect(location.hash).toBe('#/p/acme/c/lancio');
    expect(takeFrameOrigin('canvas:acme/lancio/tiktok-9x16')).not.toBeNull();
  });

  it('puts the format, the version menu and Export in the bar', async () => {
    render(<Harness format={VIDEO} />);
    await player();
    const bar = document.querySelector('.ms-topbar') as HTMLElement;
    expect(within(bar).getByText('Video 9:16')).toBeTruthy();
    expect(within(bar).getByText(/1080×1920 · 9:16 · 8 s/)).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Versione 1 di 1, apri la cronologia' })).toBeTruthy();
    await userEvent.click(within(bar).getByRole('button', { name: 'Esporta' }));
    expect(await screen.findByRole('dialog', { name: /Esporta/ })).toBeTruthy();
  });
});

describe('FormatView · image', () => {
  it('zooms with Fit, +/- and 100%, and comments with a pin without time', async () => {
    render(<Harness format={IMAGE} />);
    await screen.findByRole('img', { name: 'Instagram · Post 1:1 v1' });
    const zoom = screen.getByRole('toolbar', { name: 'Zoom' });
    await userEvent.click(within(zoom).getByRole('button', { name: 'Dimensione reale (100%)' }));
    expect(within(zoom).getByRole('status').textContent).toBe('100%');
    await userEvent.click(within(zoom).getByRole('button', { name: 'Ingrandisci' }));
    expect(within(zoom).getByRole('status').textContent).toBe('125%');
    await userEvent.click(within(zoom).getByRole('button', { name: 'Adatta' }));
    expect(within(zoom).getByRole('button', { name: 'Adatta' }).getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'Commenta Instagram · Post 1:1' }));
    const bubble = screen.getByRole('group', { name: 'Commento 1' });
    await userEvent.type(within(bubble).getByRole('textbox'), 'Più contrasto');
    await userEvent.click(within(bubble).getByRole('button', { name: 'Commenta' }));
    const { result } = renderHook(() => usePendingPins(pinsKey('acme', 'lancio')));
    expect(result.current[0]).toEqual([{ pin: { format: IMAGE, x: 0.5, y: 0.5, timeSec: null, note: 'Più contrasto' }, version: 1 }]);
  });

  it('a format outside the creative explains itself and goes back', async () => {
    render(<Harness format="youtube-shorts-9x16" />);
    expect(await screen.findByText(/non è un formato di questa creatività/)).toBeTruthy();
  });
});

describe('FormatView · English', () => {
  it('speaks English: transport, Scenes note, frame comments', async () => {
    render(<I18nProvider locale="en"><Harness format={VIDEO} /></I18nProvider>);
    const video = (await screen.findByLabelText('TikTok · Video 9:16 v1', { selector: 'video' })) as HTMLVideoElement;
    setTime(video, 5);
    expect(screen.getByRole('button', { name: 'Play (Space)' })).toBeTruthy();
    expect(screen.getByText('Edit scenes, text and timing directly — coming with the timeline')).toBeTruthy();
    expect(screen.getByText('Click the spot of the frame at 00:05.00')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All formats' })).toBeTruthy();
  });
});

describe('FormatView · loop and speed (visual test point 39)', () => {
  const en = () => render(<I18nProvider locale="en"><Harness format={VIDEO} /></I18nProvider>);
  const video = async () => (await screen.findByLabelText('TikTok · Video 9:16 v1', { selector: 'video' })) as HTMLVideoElement;

  it('loop is a pressed/unpressed toggle that sets the video to loop', async () => {
    en();
    const v = await video();
    const loop = screen.getByRole('button', { name: 'Loop' });
    expect(loop.getAttribute('aria-pressed')).toBe('false');
    expect(v.loop).toBe(false);
    await userEvent.click(loop);
    expect(loop.getAttribute('aria-pressed')).toBe('true');
    expect(v.loop).toBe(true);
    await userEvent.click(loop);
    expect(v.loop).toBe(false);
  });

  it('plays at 0.5×, 1×, 1.5× or 2× from a ui Select (no native control)', async () => {
    const { container } = en();
    const v = await video();
    expect(v.playbackRate).toBe(1);
    expect(container.querySelector('select')).toBeNull();
    const speed = screen.getByRole('button', { name: /Playback speed/ });
    expect(speed.textContent).toContain('1×');
    await userEvent.click(speed);
    const list = screen.getByRole('listbox', { name: 'Playback speed' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['0.5×', '1×', '1.5×', '2×']);
    await userEvent.click(within(list).getByRole('option', { name: '2×' }));
    expect(v.playbackRate).toBe(2);
    expect(speed.textContent).toContain('2×');
  });

  it('keeps loop and speed when the video element is replaced (Try again after an error)', async () => {
    en();
    let v = await video();
    await userEvent.click(screen.getByRole('button', { name: 'Loop' }));
    await userEvent.click(screen.getByRole('button', { name: /Playback speed/ }));
    await userEvent.click(screen.getByRole('option', { name: '1.5×' }));
    fireEvent.error(v);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    v = await video();
    fireEvent.loadedMetadata(v);
    expect(v.loop).toBe(true);
    expect(v.playbackRate).toBe(1.5);
  });
});

describe('FormatView · fix round 1', () => {
  it('the playhead does not re-render the page: the chat stays put while the time moves', async () => {
    render(<Harness format={VIDEO} />);
    const video = await player();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Chiedi una modifica' })).toBeTruthy());
    const before = chat.renders;
    for (const s of [0.1, 0.2, 0.3, 0.4, 0.5]) setTime(video, s);
    expect(screen.getByText('00:00.50')).toBeTruthy();
    expect(chat.renders).toBe(before);
  });

  it('Space on another focused control leaves it alone; on the play button it plays once', async () => {
    render(<Harness format={VIDEO} />);
    await player();
    const exportButton = within(document.querySelector('.ms-topbar') as HTMLElement).getByRole('button', { name: 'Esporta' });
    exportButton.focus();
    fireEvent.keyDown(exportButton, { key: ' ', code: 'Space' });
    expect(play).not.toHaveBeenCalled();
    const playButton = screen.getByRole('button', { name: 'Riproduci (Spazio)' });
    playButton.focus();
    fireEvent.keyDown(playButton, { key: ' ', code: 'Space' });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('T3 starts before the data arrives: the frame is there from the first render', async () => {
    api.getCreative.mockImplementationOnce(() => new Promise(() => {}));
    const rect = new DOMRect(10, 20, 300, 540);
    setFrameOrigin('format:acme/lancio/tiktok-9x16', rect);
    render(<Harness format={VIDEO} />);
    const frame = document.querySelector('.ms-fv-frame');
    expect(frame).not.toBeNull();
    expect(flip).toHaveBeenCalledWith(frame, rect, D.l);
    expect(api.getCreative).toHaveBeenCalled();
  });

  it('pin window boundary: visible at 5.5 s, not at 5.51 s', async () => {
    seed({ x: 0.4, y: 0.3, timeSec: 5, note: 'n' });
    render(<Harness format={VIDEO} />);
    const video = await player();
    const stage = screen.getByRole('region', { name: 'Anteprima di TikTok · Video 9:16' });
    setTime(video, 5.5);
    expect(within(stage).getByRole('button', { name: 'Modifica il commento 1' })).toBeTruthy();
    setTime(video, 5.51);
    expect(within(stage).queryByRole('button', { name: 'Modifica il commento 1' })).toBeNull();
    setTime(video, 4.5);
    expect(within(stage).getByRole('button', { name: 'Modifica il commento 1' })).toBeTruthy();
  });

  it('frame steps stop at 0 and at the end', async () => {
    render(<Harness format={VIDEO} />);
    const video = await player();
    setTime(video, 0);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(video.currentTime).toBe(0);
    setTime(video, 8);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(video.currentTime).toBe(8);
  });

  it('on another version: no pins, no markers, the keys hint drops the comment part; a chip opens its version', async () => {
    detail = makeDetail([version(1), version(2)], { resumeFrom: { version: 1, sessionId: 's' } });
    seed({ x: 0.4, y: 0.3, timeSec: 5, note: 'Logo' });
    render(<Harness format={VIDEO} />);
    const v2 = (await screen.findByLabelText('TikTok · Video 9:16 v2', { selector: 'video' })) as HTMLVideoElement;
    setTime(v2, 5);
    expect(screen.queryByRole('button', { name: 'Modifica il commento 1' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Commento 1 a/ })).toBeNull();
    expect(screen.getByText('Spazio riproduce · ← → un fotogramma')).toBeTruthy();
    // The chip (comments go out on v1) still opens: the view switches to v1 with the bubble.
    await userEvent.click(screen.getByRole('button', { name: /Modifica il commento 1 · Logo/ }));
    expect(await screen.findByLabelText('TikTok · Video 9:16 v1', { selector: 'video' })).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Commento 1' })).getByRole('textbox')).toBeTruthy();
  });

  it('the version on screen travels with T3 and T4', async () => {
    detail = makeDetail([version(1), version(2)]);
    setShownVersion('acme/lancio', 1);
    render(<Harness format={VIDEO} />);
    expect(await screen.findByLabelText('TikTok · Video 9:16 v1', { selector: 'video' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Tutti i formati' }));
    expect(takeShownVersion('acme/lancio')).toBe(1);
  });

  it('Export opens on the version shown (snapshot taken on open)', async () => {
    render(<Harness format={VIDEO} />);
    await player();
    await userEvent.click(within(document.querySelector('.ms-topbar') as HTMLElement).getByRole('button', { name: 'Esporta' }));
    expect(await screen.findByRole('dialog', { name: /Esporta/ })).toBeTruthy();
    expect(screen.getAllByText(/v1/).length).toBeGreaterThan(0);
  });
});
