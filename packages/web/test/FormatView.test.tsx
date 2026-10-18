import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, renderJobKeyOf, type CreativeDetail, type OutputFileInfo, type VersionEntry } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Route } from '../src/routes.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';

// Load-robust (flaky under a busy machine): a per-file timeout, not a global one; what the tests check is unchanged.
vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });

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
  // UX feedback 1, Task 3: the render status.
  fileBytes: vi.fn(async (..._a: unknown[]): Promise<number | null> => 12_400_000),
  renderVersion: vi.fn(async (..._a: unknown[]) => ({ id: 'r1', key: 'k', kind: 'render', label: 'x', state: 'queued', createdAt: at })),
  // Decision 974: the dialog starts the export as a background job.
  exportPicksJob: vi.fn(async () => ({ job: { id: 'e1', key: 'export:/w:acme:lancio:0a1b2c3d', kind: 'export' as const, label: 'Export', state: 'queued' as const, createdAt: '2026-10-08T10:00:00.000Z' } })),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
  setExportPick: vi.fn(async (..._a: unknown[]) => detail),
  setFormatLink: vi.fn(async (..._a: unknown[]) => detail),
  // Task 8: v2 versions.
  revokePreview: vi.fn(async (..._a: unknown[]) => ({ revoked: true })),
  previewSession: vi.fn(async (_s: string, _c: string, n: number, format: string, _o: string) => ({
    url: `http://127.0.0.1:61234/tok-${format}-v${n}/runtime/index.html?mode=preview&parentOrigin=x`, token: `tok-${format}-v${n}`, origin: 'http://127.0.0.1:61234',
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), format, hash: 'b'.repeat(64), width: 1080, height: 1920, duration: 8, fps: 30,
  })),
  // UX feedback 1, Task 2: the Scenes column lists the composition's scenes at once (one named, one numbered).
  getEditorComposition: vi.fn(async (_s: string, _c: string, n: number, format: string) => ({
    n, format, primaryFormat: format, hash: 'b'.repeat(64), files: [], fonts: [],
    composition: {
      $schema: 'motion-studio/composition@1', width: 1080, height: 1920, fps: 30, duration: 8, background: '#000000', fonts: [],
      scenes: [{ id: 'offerta', start: 3.5, duration: 4.5 }, { id: 'intro', name: 'Intro', start: 0, duration: 3.5 }], tracks: [],
    },
  })),
  getStoryboard: vi.fn(async (_s: string, _c: string, n: number, format: string) => ({
    format, hash: 'b'.repeat(64), width: 270, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    frames: [
      { t: 0, kind: 'scene', scene: 'intro', width: 270, height: 480, url: `/sb/${format}/v${n}/f-0.jpg?s=1` },
      { t: 3.5, kind: 'scene', scene: 'offerta', width: 270, height: 480, url: `/sb/${format}/v${n}/f-1.jpg?s=1` },
      { t: 1, kind: 'poster', width: 270, height: 480, url: `/sb/${format}/v${n}/f-2.jpg?s=1` },
    ],
  })),
};
class ApiError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const flip = vi.fn(async () => undefined);
const chat = vi.hoisted(() => ({ renders: 0 }));
vi.mock('../src/components/Conversation.tsx', async (orig) => {
  const m = await orig<typeof import('../src/components/Conversation.tsx')>();
  return { ...m, Conversation: (p: Parameters<typeof m.Conversation>[0]) => { chat.renders += 1; return m.Conversation(p); } };
});
vi.mock('../src/motion/motion.ts', async (orig) => ({ ...(await orig<typeof import('../src/motion/motion.ts')>()), flip }));
const { FormatView } = await import('../src/screens/FormatView.tsx');
const { __resetPreviewSessions, RELEASE_GRACE_MS } = await import('../src/components/compositionPreview.ts');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { __resetPendingPins, pinsKey, usePendingPins } = await import('../src/screens/pendingPins.ts');
const { __resetToasts, getToasts } = await import('../src/ui/toast.tsx');
const { setFrameOrigin, setShownVersions, takeFrameOrigin, takeShownVersions } = await import('../src/shell/intents.ts');
const { D } = await import('../src/motion/motion.ts');
const { I18nProvider } = await import('../src/i18n.tsx');

let jobsNow: Record<string, unknown> = {};
let ticksNow = 0;
const emptyLive = (): EventsState => ({ approvals: {}, jobs: jobsNow, events: {}, creativeTicks: { 'acme/lancio': ticksNow }, projectTicks: {} } as unknown as EventsState);
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
/**
 * The video and a ready view: the keyboard shortcuts only act once the creative has loaded (the transport is enabled),
 * so a key pressed earlier is ignored by design. Wait for that, never for time.
 */
const player = async (label = 'TikTok · Video 9:16 v1') => {
  const video = (await screen.findByLabelText(label, { selector: 'video' })) as HTMLVideoElement;
  await waitFor(() => {
    const btn = document.querySelector('.ms-fv-play') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(false);
  });
  return video;
};
const seed = (pin: { x: number; y: number; timeSec: number | null; note: string; format?: string }, v = 1) => {
  const { result } = renderHook(() => usePendingPins(pinsKey('acme', 'lancio')));
  act(() => result.current[1]((ps) => [...ps, { pin: { format: VIDEO, ...pin }, version: v }]));
};

let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;
let platform: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => {
  __resetPreviewSessions();
  vi.clearAllMocks();
  detail = makeDetail([version(1)]);
  jobsNow = {};
  ticksNow = 0;
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
    await player('TikTok · Video 9:16 v2');
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
    await userEvent.click(within(document.querySelector('.ms-topbar') as HTMLElement).getByRole('button', { name: 'Tutti i formati' }));
    expect(location.hash).toBe('#/p/acme/c/lancio');
    expect(takeFrameOrigin('canvas:acme/lancio/tiktok-9x16')).not.toBeNull();
  });

  it('says discreetly when the duration is far from the brief, and that a direct edit chose it (decisions log 262)', async () => {
    detail = makeDetail([version(1)], { brief: { goal: 'g', message: 'm', formats: ['instagram-post-1x1', 'tiktok-9x16'], durationSec: 6, assets: [], notes: '' } });
    const { unmount } = render(<Harness format={VIDEO} />);
    await player();
    const bar = () => document.querySelector('.ms-topbar') as HTMLElement;
    expect(within(bar()).getByText('1080×1920 · 9:16 · 8 s · brief 6 s')).toBeTruthy();
    unmount();
    __resetPreviewSessions();
    detail = makeDetail([{ ...version(1), origin: 'editor' }], { brief: { goal: 'g', message: 'm', formats: ['instagram-post-1x1', 'tiktok-9x16'], durationSec: 6, assets: [], notes: '' } });
    render(<Harness format={VIDEO} />);
    await player();
    expect(within(bar()).getByText('1080×1920 · 9:16 · 8 s · brief 6 s (modifica diretta)')).toBeTruthy();
  });

  it('no note when the duration is within the brief', async () => {
    detail = makeDetail([version(1)], { brief: { goal: 'g', message: 'm', formats: ['instagram-post-1x1', 'tiktok-9x16'], durationSec: 7.5, assets: [], notes: '' } });
    render(<Harness format={VIDEO} />);
    await player();
    expect(within(document.querySelector('.ms-topbar') as HTMLElement).getByText('1080×1920 · 9:16 · 8 s')).toBeTruthy();
  });

  it('puts the format, its ★ badge, the Versions timeline and Export in the bar', async () => {
    render(<Harness format={VIDEO} />);
    await player();
    const bar = document.querySelector('.ms-topbar') as HTMLElement;
    expect(within(bar).getByText('Video 9:16')).toBeTruthy();
    expect(within(bar).getByText(/1080×1920 · 9:16 · 8 s/)).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'TikTok · Video 9:16: si esporta la v1. Apri le sue versioni' }).textContent).toContain('★ v1');
    expect(within(bar).getByRole('button', { name: 'Versioni (1): apri la cronologia della creatività' })).toBeTruthy();
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

  it('zoom resizes the picture, never the comment bubble or the markers (screen-sized at any zoom)', async () => {
    render(<Harness format={IMAGE} />);
    await screen.findByRole('img', { name: 'Instagram · Post 1:1 v1' });
    const zoom = screen.getByRole('toolbar', { name: 'Zoom' });
    await userEvent.click(within(zoom).getByRole('button', { name: 'Dimensione reale (100%)' }));
    await userEvent.click(within(zoom).getByRole('button', { name: 'Riduci' }));
    expect(within(zoom).getByRole('status').textContent).toBe('75%');
    await userEvent.click(screen.getByRole('button', { name: 'Commenta Instagram · Post 1:1' }));
    const bubble = screen.getByRole('group', { name: 'Commento 1' });
    const frame = bubble.closest('.ms-fv-frame') as HTMLElement;
    expect(frame.style.width).toBe(`${Math.round(1080 * 0.75)}px`);
    // No zoom or scale() between the bubble and the document.
    for (let e: HTMLElement | null = bubble.parentElement; e; e = e.parentElement) {
      expect(!e.style.zoom || e.style.zoom === '1').toBe(true);
      expect(/scale\(/.test(e.style.transform)).toBe(false);
    }
  });

  it('a format outside the creative explains itself and goes back', async () => {
    render(<Harness format="youtube-shorts-9x16" />);
    expect(await screen.findByText(/non è un formato di questa creatività/)).toBeTruthy();
  });
});

describe('FormatView · English', () => {
  it('speaks English: transport, Scenes note, frame comments', async () => {
    render(<I18nProvider locale="en"><Harness format={VIDEO} /></I18nProvider>);
    const video = await player();
    setTime(video, 5);
    expect(screen.getByRole('button', { name: 'Play (Space)' })).toBeTruthy();
    expect(screen.getByText('Edit scenes, text and timing directly — coming with the timeline')).toBeTruthy();
    expect(await screen.findByText('Click the spot of the frame at 00:05.00')).toBeTruthy();
    expect(within(document.querySelector('.ms-topbar') as HTMLElement).getByRole('button', { name: 'All formats' })).toBeTruthy();
  });
});

describe('FormatView · loop and speed (visual test point 39)', () => {
  const en = () => render(<I18nProvider locale="en"><Harness format={VIDEO} /></I18nProvider>);
  const video = () => player();

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
    const v2 = await player('TikTok · Video 9:16 v2');
    setTime(v2, 5);
    expect(screen.queryByRole('button', { name: 'Modifica il commento 1' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Commento 1 a/ })).toBeNull();
    expect(screen.getByText('Spazio riproduce · ← → un fotogramma')).toBeTruthy();
    // The chip (comments go out on v1) still opens: the view switches to v1 with the bubble.
    await userEvent.click(screen.getByRole('button', { name: /Modifica il commento 1 · Logo/ }));
    await player();
    expect(within(await screen.findByRole('group', { name: 'Commento 1' })).getByRole('textbox')).toBeTruthy();
  });

  it('the version on screen travels with T3 and T4', async () => {
    detail = makeDetail([version(1), version(2)]);
    setShownVersions('acme/lancio', { [VIDEO]: 1 });
    render(<Harness format={VIDEO} />);
    await player();
    expect(await screen.findByText('stai guardando la v1')).toBeTruthy();
    await userEvent.click(within(document.querySelector('.ms-topbar') as HTMLElement).getByRole('button', { name: 'Tutti i formati' }));
    expect(takeShownVersions('acme/lancio')).toEqual({ [VIDEO]: 1 });
  });

  it('Export opens on the latest version (snapshot taken on open)', async () => {
    render(<Harness format={VIDEO} />);
    await player();
    await userEvent.click(within(document.querySelector('.ms-topbar') as HTMLElement).getByRole('button', { name: 'Esporta' }));
    expect(await screen.findByRole('dialog', { name: /Esporta/ })).toBeTruthy();
    expect(screen.getAllByText(/v1/).length).toBeGreaterThan(0);
  });
});

describe('FormatView · Compare', () => {
  it('Space and the arrows drive the Compare players, never the page’s video behind the dialog', async () => {
    detail = makeDetail([version(1), version(2)]);
    render(<Harness format={VIDEO} />);
    await screen.findByLabelText('TikTok · Video 9:16 v2', { selector: 'video' });
    const page = document.querySelector('.ms-fv-media video') as HTMLVideoElement;
    const bar = document.querySelector('.ms-topbar') as HTMLElement;
    await userEvent.click(within(bar).getByRole('button', { name: 'TikTok · Video 9:16: si esporta la v2. Apri le sue versioni' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Versioni di TikTok · Video 9:16' })).getByRole('button', { name: 'Confronta' }));
    const d = await screen.findByRole('dialog', { name: 'Confronta le versioni' });
    await waitFor(() => expect((within(d).getByRole('button', { name: 'Riproduci (Spazio)' }) as HTMLButtonElement).disabled).toBe(false));
    play.mockClear();
    fireEvent.keyDown(d, { key: ' ', code: 'Space' });
    expect(play.mock.contexts.length).toBe(2);
    expect(play.mock.contexts).not.toContain(page);
    fireEvent.keyDown(d, { key: 'ArrowRight' });
    expect(page.currentTime).toBe(0);
    // The page's own transport did not move.
    expect(document.querySelector('.ms-fv-main .ms-fv-play')?.getAttribute('aria-label')).toBe('Riproduci (Spazio)');
  });
});

describe('FormatView · per-format versions (Phase 9)', () => {
  const REEL = 'instagram-reel-9x16';
  const REEL_LABEL = 'Instagram · Story/Reel 9:16';
  const hx = (c: string) => c.repeat(64);
  const vout = (format: string, sha: string): OutputFileInfo => ({ format, file: `${format}.mp4`, width: 1080, height: 1920, durationSec: 8, verified: true, preview: null, sha256: hx(sha) });
  const pv = (n: number, request: string, outs: OutputFileInfo[]): VersionEntry =>
    ({ n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request, outputs: outs, problems: [], tools: [], renderCommand: null, basedOn: null });
  const linked = () => makeDetail([
    pv(1, 'Dal brief', [vout(REEL, 'a'), vout(VIDEO, 'a')]),
    pv(2, 'Più veloce', [vout(REEL, 'b'), vout(VIDEO, 'b')]),
  ], { brief: { goal: 'g', message: 'm', formats: [REEL, VIDEO], durationSec: 8, assets: [], notes: '', links: { [VIDEO]: REEL } } });

  it('the same badge and popover as the canvas: ★ calls the API, a row views that version', async () => {
    detail = linked();
    render(<Harness format={REEL} />);
    expect(await screen.findByLabelText(`${REEL_LABEL} v2`, { selector: 'video' })).toBeTruthy();
    const bar = document.querySelector('.ms-topbar') as HTMLElement;
    await userEvent.click(await within(bar).findByRole('button', { name: `${REEL_LABEL}: si esporta la v2. Apri le sue versioni` }));
    const pop = await screen.findByRole('dialog', { name: `Versioni di ${REEL_LABEL}` });
    await userEvent.click(within(pop).getByRole('button', { name: 'Usa la v1 per l’export' }));
    await waitFor(() => expect(api.setExportPick).toHaveBeenCalledWith('acme', 'lancio', REEL, 1));
    await userEvent.click(within(pop).getByRole('button', { name: /^Guarda la v1 / }));
    expect(await screen.findByLabelText(`${REEL_LABEL} v1`, { selector: 'video' })).toBeTruthy();
    expect(await within(bar).findByText('stai guardando la v1')).toBeTruthy();
  });

  it('a follower plays its primary’s file and offers Unlink from its chip', async () => {
    detail = linked();
    render(<Harness format={VIDEO} />);
    const video = await screen.findByLabelText('TikTok · Video 9:16 v2', { selector: 'video' });
    expect(video.getAttribute('src')).toBe(`/f/acme/lancio/outputs/v2/${REEL}.mp4`);
    const bar = document.querySelector('.ms-topbar') as HTMLElement;
    expect(await within(bar).findByText(`segue ${REEL_LABEL} ★ v2`)).toBeTruthy();
    expect(within(bar).queryByRole('button', { name: /si esporta la v/ })).toBeNull();
    await userEvent.click(await within(bar).findByRole('button', { name: `Collegato a ${REEL_LABEL}: apri il menu del collegamento` }));
    await userEvent.click(await screen.findByRole('button', { name: 'Scollega: crea una versione dedicata' }));
    await waitFor(() => expect(api.setFormatLink).toHaveBeenCalledWith('acme', 'lancio', VIDEO, null));
  });

  it('a change from the editor applies to its format by default', async () => {
    detail = makeDetail([version(1)]);
    render(<Harness format={VIDEO} />);
    await player();
    const group = screen.getByRole('group', { name: 'Si applica a' });
    expect(within(group).getByRole('button', { name: 'TikTok · Video 9:16' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(group).getByRole('button', { name: 'Tutti i formati' }).getAttribute('aria-pressed')).toBe('false');
    await userEvent.type(screen.getByLabelText('Chiedi una modifica'), 'Più ritmo');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'lancio', { text: 'Più ritmo', pins: [], formats: [VIDEO] }));
  });
});


describe('FormatView · live composition player (Task 8)', () => {
  const v2 = (n: number): VersionEntry => ({
    ...version(n), outputs: [out('instagram-post-1x1', 'post.png')],
    compositions: [{ format: VIDEO, dir: `compositions/${VIDEO}`, hash: 'b'.repeat(64) }],
  });
  const READY = { type: 'ready', version: 1, duration: 8, fps: 30, width: 1080, height: 1920, scenes: [], errors: [] };
  const frame = () => waitFor(() => { const f = document.querySelector('.ms-fv-media iframe') as HTMLIFrameElement | null; expect(f).not.toBeNull(); return f!; });
  const fromRuntime = (f: HTMLIFrameElement, data: unknown) => {
    const ev = new MessageEvent('message', { data, origin: 'null' });
    Object.defineProperty(ev, 'source', { value: f.contentWindow });
    act(() => { window.dispatchEvent(ev); });
  };
  /**
   * The runtime's ready, then Play enabled (final wave, decision 785). Condition-based: the frame can be in the DOM before its
   * passive effect has attached the message listener (the session arrives outside act), so a ready sent in that gap is lost;
   * a real runtime only sends it once the frame has loaded, after the effect. Until Play is enabled, the ready is sent again
   * to the frame shown now (a replaced frame gets a new spy).
   */
  const readyPlayer = async () => {
    let f = await frame();
    let posted = vi.spyOn(f.contentWindow!, 'postMessage');
    await waitFor(() => {
      const now = document.querySelector('.ms-fv-media iframe') as HTMLIFrameElement | null;
      expect(now).not.toBeNull();
      if (now !== f) { f = now!; posted = vi.spyOn(f.contentWindow!, 'postMessage'); }
      const play = document.querySelector('.ms-fv-play') as HTMLButtonElement;
      if (play.disabled) fromRuntime(f, READY);
      expect(play.disabled).toBe(false);
    }, { timeout: 10_000 });
    return { f, posted };
  };

  it('a v2 version plays in the sandboxed live player instead of a <video>', async () => {
    detail = makeDetail([v2(1)]);
    render(<Harness format={VIDEO} />);
    const f = await frame();
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.getAttribute('src')).toContain('/tok-tiktok-9x16-v1/');
    expect(document.querySelector('.ms-fv-media video')).toBeNull();
    expect(api.previewSession).toHaveBeenCalledWith('acme', 'lancio', 1, VIDEO, location.origin);
  });

  it('the phase 7 transport drives it: play, pause, frame step, speed', async () => {
    detail = makeDetail([v2(1)]);
    render(<Harness format={VIDEO} />);
    const { f, posted } = await readyPlayer();
    await userEvent.click(screen.getByRole('button', { name: 'Riproduci (Spazio)' }));
    expect(posted).toHaveBeenLastCalledWith({ type: 'play', loop: false, rate: 1 }, '*');
    fromRuntime(f, { type: 'time', t: 2, playing: true });
    await userEvent.click(screen.getByRole('button', { name: 'Pausa (Spazio)' }));
    expect(posted).toHaveBeenLastCalledWith({ type: 'pause' }, '*');
    fromRuntime(f, { type: 'time', t: 2, playing: false });
    await userEvent.click(screen.getByRole('button', { name: 'Fotogramma successivo (→)' }));
    const seek = posted.mock.calls.map((c) => c[0] as { type: string; t?: number }).filter((m) => m.type === 'seek').at(-1)!;
    expect(seek.t).toBeCloseTo(2 + 1 / 30, 5);
    await userEvent.click(screen.getByRole('button', { name: 'Ripeti' }));
    await userEvent.click(screen.getByRole('button', { name: 'Riproduci (Spazio)' }));
    expect(posted).toHaveBeenLastCalledWith({ type: 'play', loop: true, rate: 1 }, '*');
  });

  it('the storyboard strip lists the scenes; a click seeks there', async () => {
    detail = makeDetail([v2(1)]);
    render(<Harness format={VIDEO} />);
    const { posted } = await readyPlayer();
    const strip = await screen.findByRole('list', { name: 'Storyboard' }, { timeout: 20_000 });
    const scenes = within(strip).getAllByRole('button');
    // From the composition, in time order: a scene's name, else its number (UX feedback 1, Task 2).
    expect(scenes.map((b) => b.getAttribute('aria-label'))).toEqual(['Intro, a 00:00.00', 'Scena 2, a 00:03.50']);
    expect(scenes[1]!.textContent).toContain('4,5 s');
    await waitFor(() => expect(strip.querySelectorAll('img')).toHaveLength(2));
    await userEvent.click(scenes[1]!);
    expect(posted).toHaveBeenLastCalledWith({ type: 'seek', t: 3.5 }, '*');
  }, 60_000);

  it('the scenes never wait for the storyboard: a skeleton per row until it arrives, then the thumbnails', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const real = api.getStoryboard.getMockImplementation()!;
    api.getStoryboard.mockImplementationOnce(async (...a: Parameters<typeof real>) => { await gate; return real(...a); });
    detail = makeDetail([v2(1)]);
    render(<Harness format={VIDEO} />);
    const strip = await screen.findByRole('list', { name: 'Storyboard' });
    expect(within(strip).getAllByRole('listitem')).toHaveLength(2);
    expect([...strip.querySelectorAll('[data-thumb]')].map((x) => x.getAttribute('data-thumb'))).toEqual(['loading', 'loading']);
    expect(strip.querySelector('img')).toBeNull();
    expect(screen.getByText('Preparo lo storyboard…').className).toBe('ms-sr');
    await waitFor(() => expect(api.getStoryboard).toHaveBeenCalled());
    await act(async () => { release(); });
    await waitFor(() => expect([...strip.querySelectorAll('[data-thumb]')].map((x) => x.getAttribute('data-thumb'))).toEqual(['frame', 'frame']));
    await frame();
  });

  it('a composition that cannot be read says so (not "no storyboard")', async () => {
    api.getEditorComposition.mockRejectedValueOnce(new ApiError(500, 'broken'));
    detail = makeDetail([v2(1)]);
    render(<Harness format={VIDEO} />);
    expect(await screen.findByText('Non riesco a leggere le scene di questa versione')).toBeTruthy();
    expect(screen.queryByText('Nessuno storyboard per questa versione')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Storyboard' })).toBeNull();
    await frame();
  });

  it('another version never shows the previous version’s scenes while its own are read', async () => {
    const base = api.getEditorComposition.getMockImplementation()!;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    api.getEditorComposition.mockImplementation(async (...a: Parameters<typeof base>) => {
      const v = await base(...a);
      if (a[2] === 2) await gate;
      return { ...v, composition: { ...v.composition, scenes: [{ id: `only${a[2]}`, name: `Scena della v${a[2]}`, start: 0, duration: 8 }] } };
    });
    try {
      // v2 changed this format (another composition hash), so it is a version of it of its own.
      detail = makeDetail([v2(1), { ...v2(2), compositions: [{ format: VIDEO, dir: `compositions/${VIDEO}`, hash: 'c'.repeat(64) }] }]);
      setShownVersions('acme/lancio', { [VIDEO]: 1 });
      render(<Harness format={VIDEO} />);
      const strip = await screen.findByRole('list', { name: 'Storyboard' });
      expect(within(strip).getByText('Scena della v1')).toBeTruthy();
      const bar = document.querySelector('.ms-topbar') as HTMLElement;
      await userEvent.click(await within(bar).findByRole('button', { name: /Apri le sue versioni$/ }));
      const pop = await screen.findByRole('dialog', { name: /^Versioni di / });
      await userEvent.click(within(pop).getByRole('button', { name: /^Guarda la v2 / }));
      // Right after the switch (no waiting): v2's own scenes are still being read, v1's are gone.
      expect(screen.queryByText('Scena della v1')).toBeNull();
      expect(screen.getByText('Carico le scene…')).toBeTruthy();
      await act(async () => { release(); });
      expect(await screen.findByText('Scena della v2')).toBeTruthy();
    } finally {
      api.getEditorComposition.mockImplementation(base);
    }
  }, 60_000);

  it('no storyboard: the rows stay, each with a placeholder', async () => {
    api.getStoryboard.mockRejectedValueOnce(new ApiError(404, 'none', 'storyboard-unavailable'));
    detail = makeDetail([v2(1)]);
    render(<Harness format={VIDEO} />);
    const strip = await screen.findByRole('list', { name: 'Storyboard' });
    await waitFor(() => expect([...strip.querySelectorAll('[data-thumb]')].map((x) => x.getAttribute('data-thumb'))).toEqual(['none', 'none']));
    expect(within(strip).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Intro, a 00:00.00', 'Scena 2, a 00:03.50']);
    await frame();
  });

  it('a composition without scenes shows one "Whole video" row with the poster; a click goes to the start', async () => {
    const base = api.getEditorComposition.getMockImplementation()!;
    api.getEditorComposition.mockImplementation(async (...a: Parameters<typeof base>) => { const v = await base(...a); return { ...v, composition: { ...v.composition, scenes: [] } }; });
    try {
      detail = makeDetail([v2(1)]);
      render(<Harness format={VIDEO} />);
      const { posted } = await readyPlayer();
      const strip = await screen.findByRole('list', { name: 'Storyboard' });
      const rows = within(strip).getAllByRole('button');
      expect(rows.map((b) => b.getAttribute('aria-label'))).toEqual(['Tutto il video, a 00:00.00']);
      await waitFor(() => expect(strip.querySelector('img')?.getAttribute('src')).toBe('/sb/tiktok-9x16/v1/f-2.jpg?s=1'));
      await userEvent.click(rows[0]!);
      expect(posted).toHaveBeenLastCalledWith({ type: 'seek', t: 0 }, '*');
    } finally {
      api.getEditorComposition.mockImplementation(base);
    }
  }, 60_000);

  it('frame comments work on the paused live picture, at the current time', async () => {
    detail = makeDetail([v2(1)]);
    render(<Harness format={VIDEO} />);
    const { f } = await readyPlayer();
    fromRuntime(f, { type: 'time', t: 3.5, playing: false });
    await userEvent.click(await screen.findByRole('button', { name: 'Commenta il fotogramma a 00:03.50' }));
    expect(screen.getByRole('group', { name: /Commento 1/ })).toBeTruthy();
    expect(screen.getByText('A 00:03.50')).toBeTruthy();
  });

  it('a legacy answer (404) keeps the version\'s own media', async () => {
    api.previewSession.mockRejectedValueOnce(new ApiError(404, 'none', 'composition-not-found'));
    detail = makeDetail([{ ...v2(1), outputs: version(1).outputs }]);
    render(<Harness format={VIDEO} />);
    await player();
    expect(document.querySelector('.ms-fv-media iframe')).toBeNull();
  });

  it('busy (429): a calm "retrying" state, not an error', async () => {
    api.previewSession.mockRejectedValueOnce(new ApiError(429, 'busy', 'preview-busy'));
    detail = makeDetail([v2(1)]);
    render(<Harness format={VIDEO} />);
    expect(await screen.findByText('Le anteprime sono occupate: riprovo tra un momento…')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await frame();
  });
});

// The Edit button is gone (decision 916): the format's page is the editor, and this view is only its viewer.
describe('FormatView · no Edit button', () => {
  const comp = (n: number): VersionEntry => ({
    ...version(n), outputs: [out('instagram-post-1x1', 'post.png')],
    compositions: [{ format: VIDEO, dir: `compositions/${VIDEO}`, hash: 'b'.repeat(64) }],
  });
  const editButton = () => screen.queryByRole('button', { name: 'Modifica TikTok · Video 9:16 direttamente' });
  it('is not offered for a version with a composition either', async () => {
    detail = makeDetail([comp(1)]);
    render(<Harness format={VIDEO} />);
    await waitFor(() => expect(document.querySelector('.ms-topbar .ms-cv-export')).not.toBeNull());
    expect(editButton()).toBeNull();
    expect(document.querySelector('.ms-cv-edit')).toBeNull();
  });
  it('is not offered for a legacy version (no composition)', async () => {
    detail = makeDetail([version(1)]);
    render(<Harness format={VIDEO} />);
    await screen.findByLabelText('TikTok · Video 9:16 v1', { selector: 'video' });
    expect(editButton()).toBeNull();
  });
  it('is not offered while an agent turn or a render is at work', async () => {
    detail = makeDetail([comp(1)]);
    jobsNow = { j1: { id: 'j1', key: 'creative:/w:acme:lancio', kind: 'creative', label: 'x', state: 'running', createdAt: at } };
    render(<Harness format={VIDEO} />);
    await waitFor(() => expect(document.querySelector('.ms-cv-export')).not.toBeNull());
    expect(editButton()).toBeNull();
  });
});

describe('FormatView · the Export control (decision 974: no Render button; user report 19)', () => {
  const H1 = 'b'.repeat(64);
  const comp = (n: number, hash = H1, rendered: string | null = null): VersionEntry => ({
    ...version(n),
    outputs: [out('instagram-post-1x1', 'post.png'), ...(rendered ? [{ ...out(VIDEO, 'tiktok.mp4', 8), sha256: 'd'.repeat(64), fromComposition: rendered }] : [])],
    compositions: [{ format: VIDEO, dir: `compositions/${VIDEO}`, hash }],
  });
  const bar = () => document.querySelector('.ms-topbar') as HTMLElement;
  const renderJob = (over: Record<string, unknown>) => ({ id: 'r1', key: renderJobKeyOf('creative:/w:acme:lancio', 1)!, kind: 'render', label: 'x', state: 'running', createdAt: at, formats: [VIDEO], ...over });
  const exportJob = (key: string, pct: number) => ({ id: 'e1', key, kind: 'export', label: 'Export · Lancio', state: 'running', createdAt: at, export: { stage: 'rendering', pct, destination: '/d', renders: ['r1'] } });

  it('no render status and no Render button, rendered or not; Export is there', async () => {
    for (const d of [makeDetail([comp(1)]), makeDetail([comp(1, H1, H1)])]) {
      detail = d;
      const view = render(<Harness format={VIDEO} />);
      await waitFor(() => expect(within(bar()).getByRole('button', { name: 'Esporta' })).not.toBeNull());
      expect(within(bar()).queryByRole('button', { name: /render/i })).toBeNull();
      expect(bar().querySelector('.ms-fv-render')).toBeNull();
      view.unmount();
    }
  });

  it('while the format renders (the agent\'s render too): the percent inside Export, filled to it, no bar outside', async () => {
    detail = makeDetail([comp(1)]);
    jobsNow = { r1: renderJob({ progress: { format: VIDEO, phase: 'frames', done: 42, total: 100 } }) };
    render(<Harness format={VIDEO} />);
    const button = await waitFor(() => within(bar()).getByRole('button', { name: 'Render 42%' }));
    expect(button.classList.contains('ms-cv-export')).toBe(true);
    expect((button.querySelector('.ms-exp-ctl-fill') as HTMLElement).style.width).toBe('42%');
    expect(within(bar()).queryByRole('progressbar')).toBeNull();
  });

  it('while an export of this creative runs: "Esportazione 26%"; another creative\'s export does not show here', async () => {
    detail = makeDetail([comp(1, H1, H1)]);
    jobsNow = { e1: exportJob('export:/w:acme:lancio:0a1b2c3d', 26) };
    const view = render(<Harness format={VIDEO} />);
    await waitFor(() => expect(within(bar()).getByRole('button', { name: 'Esportazione 26%' })).not.toBeNull());
    view.unmount();
    jobsNow = { e1: exportJob('export:/w:acme:lancio~b:0a1b2c3d', 26) };
    render(<Harness format={VIDEO} />);
    await waitFor(() => expect(within(bar()).getByRole('button', { name: 'Esporta' })).not.toBeNull());
  });

  it('the control keeps one size: every text it may show sits in the same cell', async () => {
    detail = makeDetail([comp(1)]);
    render(<Harness format={VIDEO} />);
    const button = await waitFor(() => within(bar()).getByRole('button', { name: 'Esporta' }));
    const sizers = [...button.querySelectorAll('.ms-exp-ctl-sizer')].map((e) => e.textContent);
    expect(sizers).toEqual(expect.arrayContaining(['Esporta', 'Esportazione 100%', 'Render 100%']));
  });
});
