import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type Composition, type CreativeDetail, type EditorCompositionView, type StagedAsset, type VersionEntry } from '@motion-studio/shared';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import spikeJson from '../../shared/test/fixtures/spike-composition.json';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Route } from '../src/routes.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';

const at = '2026-10-08T10:00:00.000Z';
const spike = spikeJson as unknown as Composition;
const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff0000"/></svg>';
const REEL = 'instagram-reel-9x16';
const TIKTOK = 'tiktok-9x16';
const hashOf = (n: number) => String(n).repeat(64).slice(0, 64);
const FILES = ['composition.json', 'assets/bg.mp4', 'assets/photo.jpg', 'assets/spikefont.ttf', 'assets/logo.svg', 'assets/music.wav', 'assets/voice.wav', 'assets/sfx.wav', 'layers/outro.html'];
const v2 = (n: number): VersionEntry => ({
  n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: '', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null,
  compositions: [{ format: REEL, dir: `compositions/${REEL}`, hash: hashOf(n) }],
});
const legacy = (n: number): VersionEntry => ({ ...v2(n), compositions: undefined });
const makeDetail = (versions: VersionEntry[], over: Partial<CreativeDetail['creative']['brief']> = {}): CreativeDetail => ({
  slug: 'lancio', jobKey: 'creative:/w:acme:lancio', versions,
  creative: {
    schemaVersion: 1, title: 'Lancio estivo', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'g', message: 'm', formats: [REEL], durationSec: 6, assets: [], notes: '', ...over },
  },
});
const view = (n: number, over: Partial<EditorCompositionView> = {}): EditorCompositionView => ({
  n, format: REEL, primaryFormat: REEL, hash: hashOf(n), composition: structuredClone(spike), files: FILES.map((path) => ({ path, size: 1000 })), fonts: [], ...over,
});

let detail = makeDetail([v2(1), v2(2)]);
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async () => detail),
  getConversation: vi.fn(async () => []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  getEditorComposition: vi.fn(async (_s: string, _c: string, n: number, _f: string) => view(n)),
  saveEdits: vi.fn(async (..._a: unknown[]) => ({ version: 3 })),
  stageEditorAsset: vi.fn(async (..._a: unknown[]): Promise<StagedAsset> => ({ path: 'assets/lib/ab12cd34-clip.mp4', size: 99, kind: 'video' })),
  sendCreativeTurn: vi.fn(async () => ({ id: 'j9', key: 'k', kind: 'creative', label: 'x', state: 'queued', createdAt: at })),
  revokePreview: vi.fn(async (..._a: unknown[]) => ({ revoked: true })),
  previewSession: vi.fn(async (_s: string, _c: string, n: number, format: string, _o: string, _renew?: string) => ({
    url: `http://127.0.0.1:61234/tok-${format}-v${n}/runtime/index.html?mode=preview&parentOrigin=x`, token: `tok-${format}-v${n}`, origin: 'http://127.0.0.1:61234',
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), format, hash: hashOf(n), width: 1080, height: 1920, duration: 6, fps: 30,
  })),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
  // SVG inner editor: the logo clip's checked text, and the staging of an edit.
  getEditorSvg: vi.fn(async (_s: string, _c: string, _t: string, path: string) => ({ path, content: LOGO_SVG, warnings: [] })),
  stageSvgEdit: vi.fn(async (_s: string, _c: string, _b: { from: { content: string } }) => ({ path: 'assets/lib/logo-e12345678.svg', size: 10, kind: 'svg', svgEdit: true, warnings: [] }) as StagedAsset),
  getBrand: vi.fn(async () => ({ kit: { colors: [], fonts: [] } })),
  listAssets: vi.fn(async () => ({ assets: [], error: null, unregistered: [] })),
};
class ApiError extends Error {
  problems?: string[];
  constructor(public status: number, message: string, public code?: string, _retry?: number, problems?: string[]) { super(message); this.problems = problems; }
}
vi.mock('../src/api.ts', () => ({ api, ApiError }));

// A fake of the player: the real one needs a runtime frame. Only the contract the editor uses.
const media = vi.hoisted(() => {
  const events = new EventTarget();
  const m = {
    seq: 0, applied: null as null | { seq: number; errors: Array<{ code: string; message: string }> }, currentTime: 0, duration: 6, loop: false, playbackRate: 1, paused: true,
    setComposition: vi.fn((_c: unknown) => { m.seq += 1; return m.seq; }),
    addSessionMedia: vi.fn((_src: string, _m: unknown) => true),
    clipBounds: null as unknown,
    error: null as unknown,
    select: vi.fn((_id: string | null) => {}),
    play: vi.fn(async () => { m.paused = false; events.dispatchEvent(new Event('play')); }),
    pause: vi.fn(() => { m.paused = true; events.dispatchEvent(new Event('pause')); }),
    addEventListener: (t: string, l: EventListener) => events.addEventListener(t, l),
    removeEventListener: (t: string, l: EventListener) => events.removeEventListener(t, l),
    emit: (t: string) => events.dispatchEvent(new Event(t)),
  };
  return m;
});
vi.mock('../src/components/CompositionPlayer.tsx', async () => {
  const React = await import('react');
  return {
    CompositionMedia: class {},
    CompositionPlayer: (p: { session: { token: string }; onMedia?(m: unknown): void; onShowing?(t: string | null): void }) => {
      const props = React.useRef(p);
      props.current = p;
      React.useEffect(() => { props.current.onMedia?.(media); return () => props.current.onMedia?.(null); }, []);
      React.useEffect(() => {
        const id = setTimeout(() => props.current.onShowing?.(p.session.token), 0);
        return () => clearTimeout(id);
      }, [p.session.token]);
      return React.createElement('div', { 'data-testid': 'player', 'data-token': p.session.token });
    },
  };
});
// The timeline slot reports the editor context (what Tasks 6 to 9 get); `probe.real` renders the real timeline in it.
const probe = vi.hoisted(() => ({ real: false, ctx: null as null | { stageAsset(from: unknown): Promise<unknown>; token: string | null; staging: boolean; selection: string | null; select(id: string | null): void } }));
vi.mock('../src/screens/editor/Timeline.tsx', async (orig) => {
  const m = await orig<typeof import('../src/screens/editor/Timeline.tsx')>();
  const ed = await import('../src/screens/editor/editorContext.ts');
  const React = await import('react');
  return { ...m, Timeline: (p: React.ComponentProps<typeof m.Timeline>) => { probe.ctx = React.useContext(ed.EditorContext) as never; return probe.real ? React.createElement(m.Timeline, p) : null; } };
});

const { EditorScreen } = await import('../src/screens/editor/EditorScreen.tsx');
const { __resetPreviewSessions } = await import('../src/components/compositionPreview.ts');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { __resetDrafts, draftKey, peekDraft, useDraft, useUnsavedDrafts } = await import('../src/screens/editor/draftStore.ts');
const { leaveRefused } = await import('../src/screens/editor/leaveGuard.ts');
const { useDraftCloseGuard } = await import('../src/shell/useAttention.ts');
const { useHashRoute } = await import('../src/App.tsx');
const { getToasts, __resetToasts } = await import('../src/ui/toast.tsx');
const { useEditorKeys } = await import('../src/screens/editor/useEditorKeys.ts');
const { SAVED_MS } = await import('../src/screens/editor/DraftPill.tsx');
const { __resetPendingPins, pinsKey, usePendingPins } = await import('../src/screens/pendingPins.ts');

const KEY = draftKey('acme', 'lancio', REEL);
const emptyLive = (): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {}, snapshots: 0 } as unknown as EventsState);
let live = emptyLive();

function Harness({ format = REEL }: { format?: string }) {
  const route: Route = { name: 'format', slug: 'acme', creative: 'lancio', format };
  const shell = {
    route, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} },
    openPalette: () => {},
  } as unknown as Shell;
  return (
    <I18nProvider locale="en">
      <ShellContext.Provider value={shell}>
        <header className="ms-topbar"><TopBar /></header>
        <EditorScreen slug="acme" creative="lancio" format={format} live={live} />
      </ShellContext.Provider>
    </I18nProvider>
  );
}

/** The store, from outside the screen: how the stage handles and the inspector will apply their edits. */
function store() {
  const h = renderHook(() => useDraft(KEY));
  return {
    apply: (op: Parameters<ReturnType<typeof useDraft>[1]['apply']>[0], o?: { coalesce?: string }) => { let r; act(() => { r = h.result.current[1].apply(op, o); }); return r; },
    stage: (a: StagedAsset) => act(() => h.result.current[1].stage(a)),
    get draft() { return h.result.current[0]; },
  };
}
const move = (x: number) => ({ kind: 'clipProps', clipId: 'title', props: { x } }) as const;
const opened = async (o: { probe?: boolean } = {}) => {
  await screen.findByTestId('player');
  await waitFor(() => expect(peekDraft(KEY)).not.toBeNull());
  // The timeline slot (video) reports the editor context.
  if (o.probe !== false) await waitFor(() => expect(probe.ctx).not.toBeNull());
};

beforeEach(() => {
  __resetPreviewSessions();
  __resetDrafts();
  __resetPendingPins();
  __resetToasts();
  vi.clearAllMocks();
  // A test that queued a one-off answer it never used must not leak it into the next.
  api.getConversation.mockReset().mockImplementation(async () => []);
  api.saveEdits.mockReset().mockImplementation(async () => ({ version: 3 }));
  api.getEditorComposition.mockReset().mockImplementation(async (_s, _c, n) => view(n));
  api.stageEditorAsset.mockReset().mockImplementation(async () => ({ path: 'assets/lib/ab12cd34-clip.mp4', size: 99, kind: 'video' }));
  api.previewSession.mockReset().mockImplementation(async (_s, _c, n, format) => ({
    url: `http://127.0.0.1:61234/tok-${format}-v${n}/runtime/index.html?mode=preview&parentOrigin=x`, token: `tok-${format}-v${n}`, origin: 'http://127.0.0.1:61234',
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), format, hash: hashOf(n), width: 1080, height: 1920, duration: 6, fps: 30,
  }));
  probe.ctx = null;
  probe.real = false;
  media.seq = 0;
  media.currentTime = 0;
  media.paused = true;
  media.applied = null;
  detail = makeDetail([v2(1), v2(2)]);
  live = emptyLive();
  location.hash = `#/p/acme/c/lancio/f/${REEL}`;
});
afterEach(() => { vi.useRealTimers(); });

describe('EditorScreen · the player while it loads (report 73)', () => {
  it('loading: a visible "Loading the video…" over the stage and a disabled, explained play; ready: the label goes and play works', async () => {
    probe.real = true;
    media.duration = Number.NaN;
    try {
      render(<Harness />);
      await opened();
      const timeline = screen.getByRole('region', { name: 'Timeline' });
      const play = within(timeline).getByRole('button', { name: 'Play (Space)' }) as HTMLButtonElement;
      await screen.findByText('Loading the video…');
      expect(play.disabled).toBe(true);
      expect(play.title).toBe('Loading the video…');
      // A press during loading does nothing (a disabled button), and no playback is queued.
      await userEvent.click(play);
      expect(media.play).not.toHaveBeenCalled();
      // The frame reports its media: the label goes, play is available and works.
      media.duration = 6;
      act(() => media.emit('durationchange'));
      await waitFor(() => expect(screen.queryByText('Loading the video…')).toBeNull());
      expect(play.disabled).toBe(false);
      expect(play.title).toBe('');
      await userEvent.click(play);
      expect(media.play).toHaveBeenCalledTimes(1);
    } finally { media.duration = 6; }
  });

  it('loading to fatal error: the runtime reports an error instead of a duration: the label goes, play says nothing about loading', async () => {
    probe.real = true;
    media.duration = Number.NaN;
    try {
      render(<Harness />);
      await opened();
      await screen.findByText('Loading the video…');
      media.error = { code: 'compositionMissing' };
      act(() => media.emit('error'));
      await waitFor(() => expect(screen.queryByText('Loading the video…')).toBeNull());
      const play = within(screen.getByRole('region', { name: 'Timeline' })).getByRole('button', { name: 'Play (Space)' }) as HTMLButtonElement;
      expect(play.title).toBe('');
    } finally { media.duration = 6; media.error = null; }
  });

  it('an unusable session URL never shows the loading label', async () => {
    probe.real = true;
    media.duration = Number.NaN;
    api.previewSession.mockReset().mockImplementation(async (_s, _c, n, format) => ({
      url: 'javascript:alert(1)', token: `tok-${format}-v${n}`, origin: 'http://127.0.0.1:61234',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), format, hash: hashOf(n), width: 1080, height: 1920, duration: 6, fps: 30,
    }));
    try {
      render(<Harness />);
      await opened();
      // `opened` waited for the (stand-in) player, so the session is in and the preview is ready: the state is settled.
      expect(screen.getByTestId('player')).toBeTruthy();
      expect(screen.queryByText('Loading the video…')).toBeNull();
    } finally { media.duration = 6; }
  });

  it('play shows no "loading" tooltip while the preview has failed', async () => {
    probe.real = true;
    api.previewSession.mockReset().mockImplementation(async () => { throw new Error('gone'); });
    render(<Harness />);
    await screen.findByRole('alert');
    const play = within(screen.getByRole('region', { name: 'Timeline' })).getByRole('button', { name: 'Play (Space)' }) as HTMLButtonElement;
    expect(play.title).toBe('');
  });

  it('loading to error: a failed preview shows the existing error and Retry, never the loading label', async () => {
    probe.real = true;
    api.previewSession.mockReset().mockImplementation(async () => { throw new Error('the core went away'); });
    render(<Harness />);
    expect((await screen.findByRole('alert')).textContent).toContain('the core went away');
    expect(screen.getByRole('button', { name: /Try again/ })).toBeTruthy();
    expect(screen.queryByText('Loading the video…')).toBeNull();
  });
});

describe('EditorScreen · shell', () => {
  it('report 72: a creative with a subtitle set has "Subtitles" in the editor tools, opening the original speech set; without one there is none', async () => {
    const set = { cues: 3, edited: 0, hash: 'a'.repeat(64), timing: { version: 1, format: REEL, fingerprint: 'f'.repeat(64) }, timingChanged: false, staleCues: 0 };
    detail = { ...makeDetail([v2(1), v2(2)]), subtitles: [{ ...set, lang: 'en', origin: 'translation', sourceLang: 'it' }, { ...set, lang: 'it', origin: 'speech' }] } as CreativeDetail;
    const first = render(<Harness />);
    await opened();
    const tools = document.querySelector('.ms-ed-tools') as HTMLElement;
    await userEvent.click(within(tools).getByRole('button', { name: 'Subtitles' }));
    expect(location.hash).toBe('#/p/acme/c/lancio/subtitles/it');
    first.unmount();
    // A member of a variant group has none (the rule the canvas had: outside variant groups only).
    detail = { ...(detail as object), variants: { orphan: false, letter: 'a', host: 'lancio', group: { members: [{ letter: 'a', slug: 'lancio', status: 'active' }, { letter: 'b', slug: 'lancio~b', status: 'active' }], picks: {} }, missing: [] } } as unknown as CreativeDetail;
    const second = render(<Harness />);
    await opened();
    expect(within(document.querySelector('.ms-ed-tools') as HTMLElement).queryByRole('button', { name: 'Subtitles' })).toBeNull();
    second.unmount();
    detail = makeDetail([v2(1), v2(2)]);
    render(<Harness />);
    await opened();
    expect(within(document.querySelector('.ms-ed-tools') as HTMLElement).queryByRole('button', { name: 'Subtitles' })).toBeNull();
  });

  it('opens the latest version: the layout slots, the format crumb and the stage player, no pill without edits', async () => {
    render(<Harness />);
    await opened();
    expect(api.getEditorComposition).toHaveBeenCalledWith('acme', 'lancio', 2, REEL);
    expect(api.previewSession).toHaveBeenCalledWith('acme', 'lancio', 2, REEL, location.origin);
    expect(screen.getByRole('complementary', { name: 'Scenes' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Timeline' })).toBeTruthy();
    // One screen (decision 916): the chat is the default tab, the inspector is next to it.
    expect(screen.getByRole('tab', { name: /^Chat/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Inspector' })).toBeTruthy();
    expect(screen.queryByText(/Draft ·/)).toBeNull();
    // Nothing is sent to the player until there is a draft to show.
    expect(media.setComposition).not.toHaveBeenCalled();
    // The bar: the format, the facts of the composition, the ★ badge of the version, and the way back to the canvas.
    const bar = document.querySelector('.ms-topbar') as HTMLElement;
    expect(within(bar).getByText('1080×1920 · 6 s · 30 fps')).toBeTruthy();
    expect(within(bar).getByRole('button', { name: /v2 is used for export/ }).textContent).toContain('v2');
    // The way back is the creative's crumb (user report 23), by its title.
    expect(within(bar).getByRole('link', { name: 'Lancio estivo' }).getAttribute('href')).toBe('#/p/acme/c/lancio');
    // No "Edit" button: the page is the editor.
    expect(within(bar).queryByRole('button', { name: /directly$/ })).toBeNull();
  });

  it('the stage and the scenes column are wired: the selection reaches the runtime; a video has no magnet on the stage (the timeline has it)', async () => {
    render(<Harness />);
    await opened();
    expect(document.querySelector('.ms-stage-layer')).not.toBeNull();
    expect(screen.getByRole('list', { name: 'Scenes of this composition' })).toBeTruthy();
    // The magnet is on by default (the context the stage and the timeline read); the stage's tools do not repeat it (item 15).
    expect((probe.ctx as unknown as { snap: boolean }).snap).toBe(true);
    expect(document.querySelector('.ms-ed-tools .ms-ed-snap')).toBeNull();
    // Picking a clip in "In this scene" selects it and tells the runtime.
    await userEvent.click(within(screen.getByRole('region', { name: 'In this scene' })).getByRole('button', { name: 'title' }));
    expect(media.select).toHaveBeenLastCalledWith('title');
    expect(probe.ctx?.selection).toBe('title');
    // ...and shows it (user test item 8): the playhead goes to its start when it is outside the clip.
    expect(media.currentTime).toBeCloseTo(0.2, 5);
    await userEvent.click(within(screen.getByRole('region', { name: 'In this scene' })).getByRole('button', { name: 'card' }));
    expect(media.currentTime).toBeCloseTo(0.2, 5);
  });

  it('the real timeline fills the slot: play, frame step and a clip bar work against the editor context', async () => {
    probe.real = true;
    render(<Harness />);
    await opened();
    const timeline = screen.getByRole('region', { name: 'Timeline' });
    await userEvent.click(within(timeline).getByRole('button', { name: 'Play (Space)' }));
    expect(media.play).toHaveBeenCalled();
    await userEvent.click(within(timeline).getByRole('button', { name: /^Next frame/ }));
    expect(media.currentTime).toBeCloseTo(1 / 30, 4);
    // A clip bar selects through the shared context (and the runtime hears it); a lane flag is an edit of the draft.
    await userEvent.click(within(timeline).getByRole('button', { name: /^title, text,/ }));
    expect(probe.ctx?.selection).toBe('title');
    expect(media.select).toHaveBeenLastCalledWith('title');
    await userEvent.click(within(timeline).getByRole('button', { name: 'Lock Text 1' }));
    expect(peekDraft(KEY)!.ops.at(-1)).toEqual({ kind: 'trackFlags', trackId: 'text', locked: true });
    // One magnet, the timeline's: the state the stage's guides read too (user test item 15).
    const magnets = screen.getAllByRole('button', { name: 'Snap to guides and edges' });
    expect(magnets).toHaveLength(1);
    await userEvent.click(magnets[0]!);
    expect((probe.ctx as unknown as { snap: boolean }).snap).toBe(false);
    expect(magnets[0]!.getAttribute('aria-pressed')).toBe('false');
  });

  it('an image format has the layers panel and no timeline', async () => {
    detail = makeDetail([v2(1)]);
    api.getEditorComposition.mockResolvedValueOnce(view(1, { composition: { ...structuredClone(spike), duration: 0, scenes: [], tracks: [] } as Composition }));
    render(<Harness />);
    await opened({ probe: false });
    expect(screen.getByRole('complementary', { name: 'Layers' })).toBeTruthy();
    expect(document.querySelector('.ms-ed-image')).not.toBeNull();
  });

  it('a legacy version (no composition) shows the viewer in the same page, without an Edit button', async () => {
    detail = makeDetail([legacy(1)]);
    render(<Harness />);
    await waitFor(() => expect(document.querySelector('.ms-fv')).not.toBeNull());
    expect(document.querySelector('.ms-ed')).toBeNull();
    const bar = document.querySelector('.ms-topbar') as HTMLElement;
    await waitFor(() => expect(within(bar).getByRole('link', { name: 'Lancio estivo' })).toBeTruthy());
    expect(within(bar).queryByRole('button', { name: /directly$/ })).toBeNull();
    expect(api.getEditorComposition).not.toHaveBeenCalled();
  });

  it('a follower opens its primary composition and says so, with the formats that share it', async () => {
    detail = makeDetail([v2(1)], { formats: [REEL, TIKTOK], links: { [TIKTOK]: REEL } });
    render(<Harness format={TIKTOK} />);
    await opened();
    expect(api.getEditorComposition).toHaveBeenCalledWith('acme', 'lancio', 1, REEL);
    const note = await screen.findByText(/^Editing .* · also used by /);
    expect(note.textContent).toContain('TikTok');
    // The bar has the follower's chip (what it follows, Unlink), as the format view had.
    expect((document.querySelector('.ms-topbar .ms-fv-follows') as HTMLElement).textContent).toMatch(/Reel/);
    // The draft belongs to the primary.
    expect(peekDraft(draftKey('acme', 'lancio', REEL))).not.toBeNull();
  });
});

describe('EditorScreen · draft pill and the live preview', () => {
  it('an edit shows the pill, goes to the player, and undo / redo go back and forth', async () => {
    render(<Harness />);
    await opened();
    const s = store();
    s.apply(move(111));
    expect(await screen.findByText('Draft · 1 edit')).toBeTruthy();
    await waitFor(() => expect(media.setComposition).toHaveBeenCalledTimes(1));
    const sentX = (call: number) => ((media.setComposition.mock.calls[call]![0] as Composition).tracks.flatMap((t) => t.clips).find((k) => k.id === 'title') as unknown as { props: { x: number } }).props.x;
    expect(sentX(0)).toBe(111);
    expect(screen.getByRole('button', { name: 'Save as v3' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(media.setComposition).toHaveBeenCalledTimes(2));
    expect(sentX(1)).toBe(90);
    expect(screen.queryByText(/Draft ·/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(media.setComposition).toHaveBeenCalledTimes(3));
    expect(sentX(2)).toBe(111);
  });

  it('Save is disabled with the first problem as its description while the draft has problems', async () => {
    api.getEditorComposition.mockResolvedValueOnce(view(2, { files: FILES.filter((f) => f !== 'assets/photo.jpg').map((path) => ({ path, size: 1 })) }));
    render(<Harness />);
    await opened();
    const s = store();
    s.apply(move(5));
    const save = await screen.findByRole('button', { name: 'Save as v3' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    const why = document.getElementById(save.getAttribute('aria-describedby')!)!;
    expect(why.textContent).toMatch(/photo\.jpg/);
    expect(api.saveEdits).not.toHaveBeenCalled();
  });

  it('Save is disabled while an agent turn or a render works on the creative', async () => {
    live = { ...emptyLive(), jobs: { j1: { id: 'j1', key: 'creative:/w:acme:lancio', kind: 'creative', label: 'x', state: 'running', createdAt: at } } } as unknown as EventsState;
    render(<Harness />);
    await opened();
    store().apply(move(5));
    const save = await screen.findByRole('button', { name: 'Save as v3' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById(save.getAttribute('aria-describedby')!)!.textContent).toMatch(/agent or a render/);
  });

  it('Save is disabled while a render of any version of the creative runs, and available again when it ends (final review M2)', async () => {
    const renderJob = (state: string) => ({ ...emptyLive(), jobs: { r1: { id: 'r1', key: 'render:/w:acme:lancio:v1', kind: 'render', label: 'x', state, createdAt: at } } }) as unknown as EventsState;
    live = renderJob('running');
    const ui = render(<Harness />);
    await opened();
    store().apply(move(5));
    const save = await screen.findByRole('button', { name: 'Save as v3' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    live = renderJob('done');
    ui.rerender(<Harness />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save as v3' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('a draft the runtime refuses is shown, not ignored', async () => {
    render(<Harness />);
    await opened();
    store().apply(move(5));
    await waitFor(() => expect(media.setComposition).toHaveBeenCalled());
    media.applied = { seq: media.seq, errors: [{ code: 'compositionInvalid', message: 'x' }] };
    act(() => media.emit('compositionapplied'));
    expect(await screen.findByText(/The preview can't show this draft/)).toBeTruthy();
    // A fixed draft clears it.
    store().apply(move(6));
    await waitFor(() => expect(media.setComposition).toHaveBeenCalledTimes(2));
    media.applied = { seq: media.seq, errors: [] };
    act(() => media.emit('compositionapplied'));
    await waitFor(() => expect(screen.queryByText(/The preview can't show this draft/)).toBeNull());
  });

  it('Discard asks, then tells the player the BASE composition again and starts a fresh draft', async () => {
    render(<Harness />);
    await opened();
    store().apply(move(111));
    await waitFor(() => expect(media.setComposition).toHaveBeenCalledTimes(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard the draft?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Discard the draft?' })).getByRole('button', { name: 'Discard edits' }));
    await waitFor(() => expect(media.setComposition).toHaveBeenCalledTimes(2));
    expect(media.setComposition.mock.calls[1]![0]).toEqual(spike);
    expect(peekDraft(KEY)!.ops).toHaveLength(0);
    expect(screen.queryByText(/Draft ·/)).toBeNull();
  });
});

describe('EditorScreen · save', () => {
  it('sends the primary, the base, the composition, the staged paths, the ops and the session token; reopens on the new version', async () => {
    api.saveEdits.mockImplementationOnce(async () => { detail = makeDetail([v2(1), v2(2), v2(3)]); return { version: 3 }; });
    render(<Harness />);
    await opened();
    const s = store();
    s.apply(move(111));
    await userEvent.click(await screen.findByRole('button', { name: 'Save as v3' }));
    await waitFor(() => expect(api.saveEdits).toHaveBeenCalledTimes(1));
    const [slug, creative, body] = api.saveEdits.mock.calls[0]! as [string, string, Record<string, unknown>];
    expect([slug, creative]).toEqual(['acme', 'lancio']);
    expect(body).toMatchObject({ baseVersion: 2, format: REEL, baseHash: hashOf(2), staged: [], ops: [move(111)], token: `tok-${REEL}-v2` });
    expect((body.composition as Composition).tracks.flatMap((t) => t.clips).find((k) => k.id === 'title')).toMatchObject({ props: { x: 111 } });
    expect(await screen.findByText(/^✓ Saved as .* v3$/)).toBeTruthy();
    // The editor reopens on the new version and the draft is gone.
    await waitFor(() => expect(api.getEditorComposition).toHaveBeenCalledWith('acme', 'lancio', 3, REEL));
    await waitFor(() => expect(within(document.querySelector('.ms-topbar') as HTMLElement).getByRole('button', { name: /v3 is used for export/ })).toBeTruthy());
    // Still the editor (the new version is the editable one), not a read-only view.
    expect(document.querySelector('.ms-ed-readonly')).toBeNull();
    expect(peekDraft(KEY)!.ops).toHaveLength(0);
    // ...and the confirmation goes after 1.8 s.
    expect(SAVED_MS).toBe(1800);
    await waitFor(() => expect(screen.queryByText(/Saved as/)).toBeNull(), { timeout: 4000 });
    expect(api.sendCreativeTurn).not.toHaveBeenCalled();
  });

  it('after an editor save the chat shows the edit summary on the version card, and an agent version shows none (D1)', async () => {
    api.saveEdits.mockImplementationOnce(async () => {
      detail = makeDetail([v2(1), v2(2), { ...v2(3), origin: 'editor', request: 'Edited title text' }]);
      return { version: 3 };
    });
    api.getConversation.mockResolvedValue([
      { type: 'version', at, n: 2, status: 'complete' }, { type: 'version', at, n: 3, status: 'complete' },
    ] as never);
    render(<Harness />);
    await opened();
    store().apply(move(111));
    await userEvent.click(await screen.findByRole('button', { name: 'Save as v3' }));
    await waitFor(() => expect(api.saveEdits).toHaveBeenCalledTimes(1));
    await userEvent.click(await screen.findByRole('tab', { name: /^Chat/ }));
    expect(await screen.findByText('Edited title text')).toBeTruthy();
    expect(document.querySelectorAll('.ms-convo-version-summary')).toHaveLength(1);
  });

  it('comments not sent yet move to the new version on a save, and stay chips in the chat (I4)', async () => {
    api.saveEdits.mockImplementationOnce(async () => { detail = makeDetail([v2(1), v2(2), v2(3)]); return { version: 3 }; });
    const pins = renderHook(() => usePendingPins(pinsKey('acme', 'lancio')));
    act(() => pins.result.current[1](() => [{ version: 2, pin: { format: REEL, clipId: 'title', clipName: 'Title', timeSec: 1, note: 'bigger' } as never }]));
    render(<Harness />);
    await opened();
    await userEvent.click(await screen.findByRole('tab', { name: /^Chat/ }));
    expect(await screen.findByText(/bigger/)).toBeTruthy();
    store().apply(move(111));
    await userEvent.click(await screen.findByRole('button', { name: 'Save as v3' }));
    await waitFor(() => expect(pins.result.current[0]).toMatchObject([{ version: 3, pin: { clipId: 'title', note: 'bigger' } }]));
    expect(await screen.findByText(/bigger/)).toBeTruthy();
  });

  it('a staged file the composition does not use is not sent; a used one is', async () => {
    render(<Harness />);
    await opened();
    const s = store();
    s.stage({ path: 'assets/lib/aaaaaaaa-unused.png', size: 5, kind: 'image' });
    s.stage({ path: 'assets/lib/bbbbbbbb-used.png', size: 5, kind: 'image' });
    s.apply({ kind: 'clipMedia', clipId: 'photo1', src: 'assets/lib/bbbbbbbb-used.png' });
    await userEvent.click(await screen.findByRole('button', { name: 'Save as v3' }));
    await waitFor(() => expect(api.saveEdits).toHaveBeenCalled());
    expect((api.saveEdits.mock.calls[0]![2] as { staged: string[] }).staged).toEqual(['assets/lib/bbbbbbbb-used.png']);
  });

  it('a 409 base-changed keeps the draft and offers to reopen on the latest version, discarding only after a confirmation', async () => {
    api.saveEdits.mockRejectedValueOnce(new ApiError(409, 'The format changed in v4 while you were editing', 'editor-base-changed'));
    render(<Harness />);
    await opened();
    store().apply(move(111));
    await userEvent.click(await screen.findByRole('button', { name: 'Save as v3' }));
    const dialog = await screen.findByRole('dialog', { name: 'This format changed while you were editing' });
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'This format changed while you were editing' })).toBeNull());
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
    // The version list is asked again at the 409, so the reopen can really land on the latest version.
    await waitFor(() => expect(api.getCreative.mock.calls.length).toBeGreaterThan(1));
    // The note stays, with Save off; Reopen asks first and only then discards.
    expect((screen.getByRole('button', { name: 'Save as v3' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Reopen on the latest version' }));
    const confirm = await screen.findByRole('dialog', { name: 'Discard the draft and reopen?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard the draft and reopen?' })).toBeNull());
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
    api.getEditorComposition.mockClear();
    api.getCreative.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'Reopen on the latest version' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Discard the draft and reopen?' })).getByRole('button', { name: 'Discard and reopen' }));
    await waitFor(() => expect(api.getEditorComposition).toHaveBeenCalledWith('acme', 'lancio', 2, REEL));
    await waitFor(() => expect(peekDraft(KEY)?.ops).toHaveLength(0));
    expect(screen.queryByText(/Draft ·/)).toBeNull();
  });

  it('hundreds of edits still save: the ops are compacted, one per object, last value winning', async () => {
    render(<Harness />);
    await opened();
    const s = store();
    for (let i = 0; i < 501; i += 1) s.apply(move(i));
    expect(peekDraft(KEY)!.ops).toHaveLength(501);
    api.saveEdits.mockImplementationOnce(async () => { detail = makeDetail([v2(1), v2(2), v2(3)]); return { version: 3 }; });
    // Under load the 501 applies and the compaction can take a beat longer than the 1 s/5 s defaults of the queries.
    await userEvent.click(await screen.findByRole('button', { name: 'Save as v3' }, { timeout: 15_000 }));
    await waitFor(() => expect(api.saveEdits).toHaveBeenCalledTimes(1), { timeout: 15_000 });
    const body = api.saveEdits.mock.calls[0]![2] as { ops: unknown[]; composition: Composition };
    expect(body.ops).toEqual([move(500)]);
    expect(await screen.findByText(/^✓ Saved as/, {}, { timeout: 15_000 })).toBeTruthy();
  }, 60_000);

  it('a newer version that changed only other formats does not move the base: no dialog, Save works on the old base', async () => {
    const r = render(<Harness />);
    await opened();
    store().apply(move(1));
    detail = makeDetail([v2(1), v2(2), { ...v2(3), compositions: [{ format: REEL, dir: `compositions/${REEL}`, hash: hashOf(2) }] }]);
    live = { ...emptyLive(), creativeTicks: { 'acme/lancio': 1 } } as unknown as EventsState;
    r.rerender(<Harness />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save as v4' })).toBeTruthy());
    expect(screen.queryByRole('dialog', { name: 'This format changed while you were editing' })).toBeNull();
    const save = screen.getByRole('button', { name: 'Save as v4' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect(peekDraft(KEY)!.base.n).toBe(2);
    await userEvent.click(save);
    await waitFor(() => expect(api.saveEdits).toHaveBeenCalledTimes(1));
    expect(api.saveEdits.mock.calls[0]![2]).toMatchObject({ baseVersion: 2, baseHash: hashOf(2) });
  });

  it('another version that changed the format while editing shows the same dialog, and keeps the draft', async () => {
    const r = render(<Harness />);
    await opened();
    store().apply(move(1));
    detail = makeDetail([v2(1), v2(2), v2(3)]);
    live = { ...emptyLive(), creativeTicks: { 'acme/lancio': 1 } } as unknown as EventsState;
    r.rerender(<Harness />);
    expect(await screen.findByRole('dialog', { name: 'This format changed while you were editing' })).toBeTruthy();
    expect(peekDraft(KEY)!.base.n).toBe(2);
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
    expect((screen.getByRole('button', { name: 'Save as v4' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('an untouched draft simply moves to the latest version', async () => {
    const r = render(<Harness />);
    await opened();
    detail = makeDetail([v2(1), v2(2), v2(3)]);
    live = { ...emptyLive(), creativeTicks: { 'acme/lancio': 1 } } as unknown as EventsState;
    r.rerender(<Harness />);
    await waitFor(() => expect(api.getEditorComposition).toHaveBeenCalledWith('acme', 'lancio', 3, REEL));
    await waitFor(() => expect(peekDraft(KEY)!.base.n).toBe(3));
  });

  it('shows a refused draft (422) with the core\'s translated problem and keeps it', async () => {
    api.saveEdits.mockRejectedValueOnce(new ApiError(422, 'The draft cannot be saved: clip title is outside its scene', 'editor-invalid', undefined, ['clip title is outside its scene']));
    render(<Harness />);
    await opened();
    store().apply(move(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Save as v3' }));
    expect(await screen.findByText('The draft cannot be saved: clip title is outside its scene')).toBeTruthy();
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
  });

  it('a busy core (agent or render) is said and the draft is kept', async () => {
    api.saveEdits.mockRejectedValueOnce(new ApiError(409, 'The agent or a render is working on this creative', 'editor-busy'));
    render(<Harness />);
    await opened();
    store().apply(move(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Save as v3' }));
    expect(await screen.findByText('The agent or a render is working on this creative')).toBeTruthy();
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
  });
});

describe('EditorScreen · SVG edits and save', () => {
  it('Save waits for an SVG change not applied yet; the saved composition has it', async () => {
    let finish: () => void = () => {};
    api.stageSvgEdit.mockImplementationOnce((_s, _c, b) => new Promise((r) => {
      finish = () => r({ path: 'assets/lib/logo-e12345678.svg', size: b.from.content.length, kind: 'svg', svgEdit: true, warnings: [] } as StagedAsset);
    }));
    render(<Harness />);
    await opened();
    store().apply(move(5));
    act(() => probe.ctx!.select('logo1'));
    const sec = await screen.findByRole('region', { name: 'SVG content' });
    fireEvent.click(await within(sec).findByRole('button', { name: /^#ff0000, used/ }));
    const field = within(sec).getByRole('textbox', { name: 'New colour for #ff0000' });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '#0000ff' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    // At once: the change is pending and Save waits with the reason.
    const save = await screen.findByRole('button', { name: 'Save as v3' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('title')).toBe('Wait for the file being added to be ready, then save.');
    expect(peekDraft(KEY)!.svgPending.has('logo1')).toBe(true);
    await waitFor(() => expect(api.stageSvgEdit).toHaveBeenCalledTimes(1));
    expect((screen.getByRole('button', { name: 'Save as v3' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish(); await Promise.resolve(); });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save as v3' }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole('button', { name: 'Save as v3' }));
    await waitFor(() => expect(api.saveEdits).toHaveBeenCalledTimes(1));
    const body = api.saveEdits.mock.calls[0]![2] as { composition: Composition; staged: string[] };
    const logo = body.composition.tracks.flatMap((t) => t.clips).find((k) => k.id === 'logo1') as unknown as { src: string };
    expect(logo.src).toBe('assets/lib/logo-e12345678.svg');
    expect(body.staged).toContain('assets/lib/logo-e12345678.svg');
  });
});

describe('EditorScreen · leave guard', () => {
  const OTHER = `#/p/acme/c/lancio/f/${TIKTOK}`;
  const dirty = async () => { render(<Harness />); await opened(); store().apply(move(111)); await screen.findByText('Draft · 1 edit'); };

  it('does not block a clean editor, nor the editor\'s own route', async () => {
    render(<Harness />);
    await opened();
    expect(leaveRefused(OTHER)).toBe(false);
    store().apply(move(1));
    expect(leaveRefused(`#/p/acme/c/lancio/f/${REEL}`)).toBe(false);
    // The old editor address is the same page.
    expect(leaveRefused(`#/p/acme/c/lancio/f/${REEL}/edit`)).toBe(false);
  });

  it('a move away with edits asks; Keep editing stays', async () => {
    await dirty();
    let blocked = false;
    act(() => { blocked = leaveRefused(OTHER); });
    expect(blocked).toBe(true);
    const dialog = await screen.findByRole('dialog', { name: 'Save your edits first?' });
    expect(within(dialog).getByText('You have 1 edit that is not saved as a version.')).toBeTruthy();
    location.hash = '#/stay';
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save your edits first?' })).toBeNull());
    expect(location.hash).toBe('#/stay');
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
  });

  it('Discard throws the draft away and goes where it was going', async () => {
    await dirty();
    act(() => { leaveRefused(OTHER); });
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Save your edits first?' })).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(location.hash).toBe(OTHER));
    expect(peekDraft(KEY)?.ops ?? []).toHaveLength(0);
    expect(api.saveEdits).not.toHaveBeenCalled();
  });

  it('Save as vN saves, then goes where it was going; a failed save stays here with the draft', async () => {
    await dirty();
    api.saveEdits.mockRejectedValueOnce(new ApiError(409, 'busy', 'editor-busy'));
    act(() => { leaveRefused(OTHER); });
    location.hash = '#/stay';
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Save your edits first?' })).getByRole('button', { name: 'Save as v3' }));
    await waitFor(() => expect(api.saveEdits).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save your edits first?' })).toBeNull());
    expect(location.hash).toBe('#/stay');
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
    // Again, this time it saves.
    api.saveEdits.mockImplementationOnce(async () => { detail = makeDetail([v2(1), v2(2), v2(3)]); return { version: 3 }; });
    act(() => { leaveRefused(OTHER); });
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Save your edits first?' })).getByRole('button', { name: 'Save as v3' }));
    await waitFor(() => expect(location.hash).toBe(OTHER));
  });

  it('the way back (the creative\'s crumb) goes through the same guard', async () => {
    await dirty();
    await userEvent.click(within(document.querySelector('.ms-topbar') as HTMLElement).getByRole('link', { name: 'Lancio estivo' }));
    // The router (App) would refuse the hash change and ask; here the move happened: ask as the router does.
    expect(location.hash).toBe('#/p/acme/c/lancio');
    act(() => { leaveRefused(location.hash); });
    expect(await screen.findByRole('dialog', { name: 'Save your edits first?' })).toBeTruthy();
  });

  it('sending a chat message asks first: Keep editing sends nothing, Discard sends it', async () => {
    await dirty();
    await userEvent.click(screen.getByRole('tab', { name: /^Chat/ }));
    const box = await screen.findByLabelText('Request a change');
    await userEvent.type(box, 'More rhythm');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    let dialog = await screen.findByRole('dialog', { name: 'Save your edits first?' });
    expect(within(dialog).getByText(/starts from the latest saved version/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save your edits first?' })).toBeNull());
    expect(api.sendCreativeTurn).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Request a change') as HTMLTextAreaElement).value).toBe('More rhythm');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    dialog = await screen.findByRole('dialog', { name: 'Save your edits first?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledTimes(1));
    expect(peekDraft(KEY)!.ops).toHaveLength(0);
  });

  it('sending a chat message with no edits goes straight out', async () => {
    render(<Harness />);
    await opened();
    await userEvent.click(screen.getByRole('tab', { name: /^Chat/ }));
    await userEvent.type(await screen.findByLabelText('Request a change'), 'Hi');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledTimes(1));
  });
});

describe('the router asks the guard (App useHashRoute)', () => {
  function Router() {
    const hash = useHashRoute();
    return <output data-testid="hash">{hash}</output>;
  }
  it('a refused move puts the address back and does not change the page; an allowed one does', async () => {
    // The old editor address is the format's page now (decision 916): it is replaced in place.
    location.hash = '#/p/acme/c/lancio/f/a/edit';
    const asked: string[] = [];
    const { registerLeaveGuard } = await import('../src/screens/editor/leaveGuard.ts');
    let blocking = true;
    const off = registerLeaveGuard({ blocks: () => blocking, ask: (h) => { asked.push(h); } });
    render(<Router />);
    expect(screen.getByTestId('hash').textContent).toBe('#/p/acme/c/lancio/f/a');
    expect(location.hash).toBe('#/p/acme/c/lancio/f/a');
    act(() => { location.hash = '#/settings'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(asked).toEqual(['#/settings']);
    expect(screen.getByTestId('hash').textContent).toBe('#/p/acme/c/lancio/f/a');
    expect(location.hash).toBe('#/p/acme/c/lancio/f/a');
    blocking = false;
    act(() => { location.hash = '#/settings'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(screen.getByTestId('hash').textContent).toBe('#/settings');
    off();
  });
});

describe('closing with an unsaved draft', () => {
  function Guard() {
    useDraftCloseGuard(useUnsavedDrafts());
    return null;
  }
  const unload = () => {
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  it('a browser asks before a reload only while a draft has edits', async () => {
    render(<Guard />);
    expect(unload()).toBe(false);
    render(<Harness />);
    await opened();
    expect(unload()).toBe(false);
    store().apply(move(1));
    await waitFor(() => expect(unload()).toBe(true));
    act(() => { peekDraft(KEY); });
    const h = renderHook(() => useDraft(KEY));
    act(() => h.result.current[1].undo());
    await waitFor(() => expect(unload()).toBe(false));
  });
  it('the desktop app is told the count (its close confirmation is the render guard\'s) and a reload is held back for its dialog', async () => {
    const setDraftsUnsaved = vi.fn(async () => {});
    (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => null, revealPath: async () => {}, setDraftsUnsaved };
    try {
      render(<Guard />);
      await waitFor(() => expect(setDraftsUnsaved).toHaveBeenLastCalledWith(0));
      render(<Harness />);
      await opened();
      store().apply(move(1));
      await waitFor(() => expect(setDraftsUnsaved).toHaveBeenLastCalledWith(1));
      // A reload holds back too (I3): the desktop app answers it with its own dialog (`will-prevent-unload`), never silently.
      expect(unload()).toBe(true);
    } finally {
      delete (window as unknown as { motionStudio?: unknown }).motionStudio;
    }
  });
});

describe('EditorScreen · keyboard', () => {
  const key = (init: KeyboardEventInit, target: Window | Element = window) => fireEvent.keyDown(target, init);
  it('undo / redo with Ctrl (Ctrl+Y too) and ⌘ on macOS, Space and the arrows drive the player, Delete explains', async () => {
    render(<Harness />);
    await opened();
    const s = store();
    s.apply(move(1));
    s.apply(move(2), { coalesce: undefined });
    expect(s.draft!.ops).toHaveLength(2);
    key({ key: 'z', ctrlKey: true });
    expect(s.draft!.ops).toHaveLength(1);
    key({ key: 'z', ctrlKey: true, shiftKey: true });
    expect(s.draft!.ops).toHaveLength(2);
    key({ key: 'z', ctrlKey: true });
    key({ key: 'y', ctrlKey: true });
    expect(s.draft!.ops).toHaveLength(2);
    // Space plays and pauses the stage player.
    await waitFor(() => expect(probe.ctx).not.toBeNull());
    key({ key: ' ', code: 'Space' });
    await waitFor(() => expect(media.play).toHaveBeenCalledTimes(1));
    key({ key: ' ', code: 'Space' });
    expect(media.pause).toHaveBeenCalled();
    // A frame at a time.
    media.paused = true;
    key({ key: 'ArrowRight' });
    expect(media.currentTime).toBeCloseTo(1 / 30, 5);
    key({ key: 'ArrowLeft' });
    expect(media.currentTime).toBeCloseTo(0, 5);
    // Delete: clips cannot be removed here.
    key({ key: 'Delete' });
    expect(getToasts().map((t) => t.text)).toContain('Ask the agent to remove clips');
    expect(s.draft!.ops).toHaveLength(2);
  });

  it('never while typing: a field keeps its own undo, Space and arrows', async () => {
    render(<Harness />);
    await opened();
    const s = store();
    s.apply(move(1));
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    key({ key: 'z', ctrlKey: true }, input);
    key({ key: ' ', code: 'Space' }, input);
    key({ key: 'ArrowRight' }, input);
    key({ key: 'Delete' }, input);
    expect(s.draft!.ops).toHaveLength(1);
    expect(media.play).not.toHaveBeenCalled();
    expect(media.currentTime).toBe(0);
    expect(getToasts()).toHaveLength(0);
    // The chat box too.
    await userEvent.click(screen.getByRole('tab', { name: /^Chat/ }));
    const box = await screen.findByLabelText('Request a change');
    key({ key: 'z', ctrlKey: true }, box);
    expect(s.draft!.ops).toHaveLength(1);
    input.remove();
  });

  it('⌘Z and ⇧⌘Z on macOS; Ctrl+Z does nothing there', async () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    try {
      render(<Harness />);
      await opened();
      const s = store();
      s.apply(move(1));
      key({ key: 'z', ctrlKey: true });
      expect(s.draft!.ops).toHaveLength(1);
      key({ key: 'z', metaKey: true });
      expect(s.draft!.ops).toHaveLength(0);
      key({ key: 'z', metaKey: true, shiftKey: true });
      expect(s.draft!.ops).toHaveLength(1);
    } finally { platform.mockRestore(); }
  });

  describe('useEditorKeys', () => {
    function Keys({ enabled = true, h }: { enabled?: boolean; h: Record<string, () => void> }) {
      const ref = useRef<HTMLDivElement>(null);
      useEditorKeys(ref, enabled, h as never);
      return <div ref={ref} />;
    }
    const handlers = () => ({ undo: vi.fn(), redo: vi.fn(), toggle: vi.fn(), step: vi.fn(), deselect: vi.fn(), remove: vi.fn() });
    it('Esc deselects, Backspace and Delete explain, a disabled map does nothing, a modal on top owns the keyboard', () => {
      const h = handlers();
      const { rerender } = render(<Keys h={h} />);
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.keyDown(window, { key: 'Delete' });
      fireEvent.keyDown(window, { key: 'Backspace' });
      expect(h.deselect).toHaveBeenCalledTimes(1);
      expect(h.remove).toHaveBeenCalledTimes(2);
      fireEvent.keyDown(window, { key: 'ArrowLeft' });
      fireEvent.keyDown(window, { key: 'ArrowRight' });
      expect(h.step.mock.calls).toEqual([[-1], [1]]);
      const modal = document.createElement('div');
      modal.className = 'ms-modal';
      const inner = document.createElement('button');
      modal.append(inner);
      document.body.append(modal);
      fireEvent.keyDown(inner, { key: 'Escape' });
      expect(h.deselect).toHaveBeenCalledTimes(1);
      modal.remove();
      const quiet = handlers();
      rerender(<Keys enabled={false} h={quiet} />);
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
      expect(quiet.deselect).not.toHaveBeenCalled();
      expect(quiet.undo).not.toHaveBeenCalled();
    });
    it('Space on a focused button is that button\'s click, not play', () => {
      const h = handlers();
      render(<><Keys h={h} /><button type="button">Other</button></>);
      const b = screen.getByRole('button', { name: 'Other' });
      b.focus();
      fireEvent.keyDown(b, { key: ' ', code: 'Space' });
      expect(h.toggle).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: ' ', code: 'Space' });
      expect(h.toggle).toHaveBeenCalledTimes(1);
    });
  });
});

describe('EditorScreen · staging and session renewal', () => {
  const asset: StagedAsset = { path: 'assets/lib/ab12cd34-clip.mp4', size: 99, kind: 'video', media: { index: 3, sourceFps: 30, sourceStart: 0, sourceVideoEnd: 4 } };

  it('stages with the session token, shows the busy note meanwhile, adds the video to the player, and keeps the draft', async () => {
    let finish: (a: StagedAsset) => void = () => {};
    api.stageEditorAsset.mockImplementationOnce(() => new Promise<StagedAsset>((r) => { finish = r; }));
    render(<Harness />);
    await opened();
    let result: Promise<unknown> = Promise.resolve();
    act(() => { result = probe.ctx!.stageAsset({ kind: 'library', file: 'assets/clip.mp4' }); });
    expect(api.stageEditorAsset).toHaveBeenCalledWith('acme', 'lancio', { token: `tok-${REEL}-v2`, from: { kind: 'library', file: 'assets/clip.mp4' } });
    expect(await screen.findByText(/Large videos are converted first/)).toBeTruthy();
    expect(probe.ctx!.staging).toBe(true);
    // The UI stays responsive meanwhile: an edit goes through.
    store().apply(move(7));
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
    await act(async () => { finish(asset); await result; });
    expect(media.addSessionMedia).toHaveBeenCalledWith(asset.path, asset.media);
    // Kept with where it came from (to stage it again in a new session) and the session it is in.
    expect(peekDraft(KEY)!.staged).toEqual([{ ...asset, from: { kind: 'library', file: 'assets/clip.mp4' } }]);
    expect(peekDraft(KEY)!.stagedIn).toBe(`tok-${REEL}-v2`);
    expect(screen.queryByText(/Large videos are converted first/)).toBeNull();
  });

  it('a new session without the staged files (the old one ended too long ago): each used file is staged again from where it came from, Save waits meanwhile (decisions log 264)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.previewSession.mockImplementationOnce(async (_s, _c, n, format) => ({
      url: `http://127.0.0.1:61234/tok-a/runtime/index.html?mode=preview&parentOrigin=x`, token: 'tok-a', origin: 'http://127.0.0.1:61234',
      expiresAt: new Date(Date.now() + 66_000).toISOString(), format, hash: hashOf(n), width: 1080, height: 1920, duration: 6, fps: 30,
    }));
    api.previewSession.mockImplementationOnce(async (_s, _c, n, format) => ({
      url: `http://127.0.0.1:61234/tok-b/runtime/index.html?mode=preview&parentOrigin=x`, token: 'tok-b', origin: 'http://127.0.0.1:61234',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), format, hash: hashOf(n), width: 1080, height: 1920, duration: 6, fps: 30,
    }));
    render(<Harness />);
    await opened();
    api.stageEditorAsset.mockResolvedValueOnce(asset);
    await act(async () => { await probe.ctx!.stageAsset({ kind: 'library', file: 'assets/clip.mp4' }); });
    store().apply({ kind: 'clipMedia', clipId: 'bgv', src: asset.path });
    let finish: (a: StagedAsset) => void = () => {};
    const again = { ...asset, media: { ...asset.media!, index: 0 } };
    api.stageEditorAsset.mockImplementationOnce(() => new Promise<StagedAsset>((r) => { finish = r; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    await waitFor(() => expect(api.stageEditorAsset).toHaveBeenCalledTimes(2));
    expect(api.stageEditorAsset).toHaveBeenLastCalledWith('acme', 'lancio', { token: 'tok-b', from: { kind: 'library', file: 'assets/clip.mp4' } });
    // Save waits for it, with the reason.
    const saveBtn = await screen.findByRole('button', { name: 'Save as v3' });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
    expect(saveBtn.getAttribute('title')).toBe('Wait for the file being added to be ready, then save.');
    await act(async () => { finish(again); await vi.advanceTimersByTimeAsync(10); });
    await waitFor(() => expect(peekDraft(KEY)!.stagedIn).toBe('tok-b'));
    expect(peekDraft(KEY)!.staged[0]!.media!.index).toBe(0);
    expect(media.addSessionMedia).toHaveBeenCalledWith(asset.path, again.media);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save as v3' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('a staged file the draft no longer uses is staged again too: an undo may bring it back (final review N4)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.previewSession.mockImplementationOnce(async (_s, _c, n, format) => ({
      url: `http://127.0.0.1:61234/tok-a/runtime/index.html?mode=preview&parentOrigin=x`, token: 'tok-a', origin: 'http://127.0.0.1:61234',
      expiresAt: new Date(Date.now() + 66_000).toISOString(), format, hash: hashOf(n), width: 1080, height: 1920, duration: 6, fps: 30,
    }));
    render(<Harness />);
    await opened();
    api.stageEditorAsset.mockResolvedValueOnce(asset);
    await act(async () => { await probe.ctx!.stageAsset({ kind: 'library', file: 'assets/clip.mp4' }); });
    // Staged, never used by the draft.
    api.stageEditorAsset.mockResolvedValueOnce(asset);
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    await waitFor(() => expect(api.stageEditorAsset).toHaveBeenCalledTimes(2));
    expect(api.stageEditorAsset).toHaveBeenLastCalledWith('acme', 'lancio', expect.objectContaining({ from: { kind: 'library', file: 'assets/clip.mp4' } }));
  });

  it('a file that cannot be staged again in the new session is named, never dropped silently', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.previewSession.mockImplementationOnce(async (_s, _c, n, format) => ({
      url: `http://127.0.0.1:61234/tok-a/runtime/index.html?mode=preview&parentOrigin=x`, token: 'tok-a', origin: 'http://127.0.0.1:61234',
      expiresAt: new Date(Date.now() + 66_000).toISOString(), format, hash: hashOf(n), width: 1080, height: 1920, duration: 6, fps: 30,
    }));
    render(<Harness />);
    await opened();
    api.stageEditorAsset.mockResolvedValueOnce(asset);
    await act(async () => { await probe.ctx!.stageAsset({ kind: 'library', file: 'assets/clip.mp4' }); });
    store().apply({ kind: 'clipMedia', clipId: 'bgv', src: asset.path });
    api.stageEditorAsset.mockRejectedValueOnce(new ApiError(400, 'not registered', 'editor-not-registered'));
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    expect(await screen.findByText(`A file added to the draft is no longer available (${asset.path}): choose it again.`)).toBeTruthy();
  });

  it('a renewal that arrives while a file is staged again (B then C) does not leave Save disabled (Q9)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sess = (tok: string, staged?: StagedAsset[]) => async (_s: string, _c: string, n: number, format: string) => ({
      url: `http://127.0.0.1:61234/${tok}/runtime/index.html?mode=preview&parentOrigin=x`, token: tok, origin: 'http://127.0.0.1:61234',
      expiresAt: new Date(Date.now() + 66_000).toISOString(), format, hash: hashOf(n), width: 1080, height: 1920, duration: 6, fps: 30, ...(staged ? { staged } : {}),
    });
    api.previewSession.mockImplementationOnce(sess('tok-a'));
    api.previewSession.mockImplementationOnce(sess('tok-b')); // did not take the staging along
    api.previewSession.mockImplementationOnce(sess('tok-c', [asset])); // took it along from B
    render(<Harness />);
    await opened();
    api.stageEditorAsset.mockResolvedValueOnce(asset);
    await act(async () => { await probe.ctx!.stageAsset({ kind: 'library', file: 'assets/clip.mp4' }); });
    store().apply({ kind: 'clipMedia', clipId: 'bgv', src: asset.path });
    // B: staged again, and never answers while C arrives.
    api.stageEditorAsset.mockImplementationOnce(() => new Promise<StagedAsset>(() => {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    await waitFor(() => expect(api.stageEditorAsset).toHaveBeenCalledTimes(2));
    expect((await screen.findByRole('button', { name: 'Save as v3' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    await waitFor(() => expect(peekDraft(KEY)!.stagedIn).toBe('tok-c'));
    // At once (a short wait): B's re-stage never answers, and its flag must not outlive it.
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save as v3' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 600 });
  });

  it('a staging failure shows the translated error and stages nothing', async () => {
    api.stageEditorAsset.mockRejectedValueOnce(new ApiError(400, 'clip.mp4 is not a readable media file', 'editor-not-media'));
    render(<Harness />);
    await opened();
    let r: unknown = 'x';
    await act(async () => { r = await probe.ctx!.stageAsset({ kind: 'library', file: 'assets/clip.mp4' }); });
    expect(r).toBeNull();
    expect(await screen.findByText(/Couldn't add the file: clip.mp4 is not a readable media file/)).toBeTruthy();
    expect(peekDraft(KEY)!.staged).toEqual([]);
  });

  it('a renewed session: no new staging; the staged videos go to the player again, the frame is replaced, the new token is used', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The first session is about to expire (renewed in ~6 s), the second one lives.
    api.previewSession.mockImplementationOnce(async (_s, _c, n, format) => ({
      url: `http://127.0.0.1:61234/tok-a/runtime/index.html?mode=preview&parentOrigin=x`, token: 'tok-a', origin: 'http://127.0.0.1:61234',
      expiresAt: new Date(Date.now() + 66_000).toISOString(), format, hash: hashOf(n), width: 1080, height: 1920, duration: 6, fps: 30,
    }));
    // The core moved the staging: the new session reports it with ITS media index (final review M1).
    const moved = { ...asset, media: { ...asset.media!, index: 7 } };
    api.previewSession.mockImplementationOnce(async (_s, _c, n, format) => ({
      url: `http://127.0.0.1:61234/tok-b/runtime/index.html?mode=preview&parentOrigin=x`, token: 'tok-b', origin: 'http://127.0.0.1:61234',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), format, hash: hashOf(n), width: 1080, height: 1920, duration: 6, fps: 30, staged: [moved],
    }));
    render(<Harness />);
    await opened();
    expect(screen.getByTestId('player').getAttribute('data-token')).toBe('tok-a');
    api.stageEditorAsset.mockResolvedValueOnce(asset);
    await act(async () => { await probe.ctx!.stageAsset({ kind: 'library', file: 'assets/clip.mp4' }); });
    store().apply({ kind: 'clipMedia', clipId: 'bgv', src: asset.path });
    expect(api.stageEditorAsset).toHaveBeenCalledTimes(1);
    media.addSessionMedia.mockClear();
    media.setComposition.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    await waitFor(() => expect(screen.getByTestId('player').getAttribute('data-token')).toBe('tok-b'));
    // Renewed from the first one; the core moved the staging, the web never stages again.
    expect(api.previewSession).toHaveBeenLastCalledWith('acme', 'lancio', 2, REEL, location.origin, 'tok-a');
    expect(api.stageEditorAsset).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(media.addSessionMedia).toHaveBeenCalledWith(asset.path, moved.media);
    expect(media.addSessionMedia).not.toHaveBeenCalledWith(asset.path, asset.media);
    expect(media.setComposition).toHaveBeenCalled();
    expect(peekDraft(KEY)!.staged[0]!.media!.index).toBe(7);
    // Staging and saving use the new token.
    await act(async () => { await probe.ctx!.stageAsset({ kind: 'library', file: 'assets/other.mp4' }); });
    expect(api.stageEditorAsset).toHaveBeenLastCalledWith('acme', 'lancio', expect.objectContaining({ token: 'tok-b' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save as v3' }));
    await waitFor(() => expect(api.saveEdits).toHaveBeenCalled());
    expect(api.saveEdits.mock.calls[0]![2]).toMatchObject({ token: 'tok-b', staged: [asset.path] });
  });
});

// One screen (decision 916): the format's page is the editor, with what the format view had and its read-only cases.
describe('EditorScreen · one screen with the format view (decision 916)', () => {
  const badge = async (n: number) => within(document.querySelector('.ms-topbar') as HTMLElement).findByRole('button', { name: new RegExp(`v${n} is used for export`) });
  const viewRow = async (n: number) => {
    await userEvent.click(await badge(2));
    await userEvent.click(await screen.findByRole('button', { name: new RegExp(`^View v${n} ·`) }));
  };

  it('the bar has the version badge, Export and "…" with Duplicate and the history (no Render, decision 974); the chat is next to the inspector', async () => {
    render(<Harness />);
    await opened();
    const bar = document.querySelector('.ms-topbar') as HTMLElement;
    await waitFor(() => expect(bar.querySelector('.ms-bar-more')).not.toBeNull());
    expect(bar.querySelector('.ms-fv-render')).toBeNull();
    expect(within(bar).queryByRole('button', { name: /^Render/ })).toBeNull();
    expect(bar.querySelector('.ms-cv-export')).not.toBeNull();
    await userEvent.click(within(bar).getByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu', { name: 'More actions' });
    expect(within(menu).getByRole('menuitem', { name: 'Duplicate format' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Version history' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    // Chat first; selecting a clip shows its inspector.
    expect(screen.getByLabelText('Request a change')).toBeTruthy();
    await userEvent.click(within(screen.getByRole('region', { name: 'In this scene' })).getByRole('button', { name: 'title' }));
    expect(screen.getByRole('tab', { name: 'Inspector' }).getAttribute('aria-selected')).toBe('true');
  });

  it('an older version from the ★ badge opens read-only with the reason; "Edit v2" goes back to the draft, kept', async () => {
    render(<Harness />);
    await opened();
    store().apply(move(111));
    await screen.findByText('Draft · 1 edit');
    await viewRow(1);
    await waitFor(() => expect(api.getEditorComposition).toHaveBeenCalledWith('acme', 'lancio', 1, REEL));
    const note = await screen.findByText(/You are looking at v1, an earlier version: only the latest one \(v2\) can be edited/);
    expect(note).toBeTruthy();
    // The editable draft is kept as it was; the older version has its own draft.
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
    await waitFor(() => expect(peekDraft(`${KEY}#v1`)).not.toBeNull());
    // Edits are refused at the source, the inspector says why and its fields are disabled.
    const ctx = probe.ctx as unknown as { readOnly: string | null; actions: { apply(op: unknown): { ok: boolean } } };
    await waitFor(() => expect((probe.ctx as unknown as { readOnly: string | null }).readOnly).toMatch(/v1/));
    expect((probe.ctx as unknown as typeof ctx).actions.apply(move(5)).ok).toBe(false);
    await userEvent.click(within(screen.getByRole('region', { name: 'In this scene' })).getByRole('button', { name: 'title' }));
    const fields = document.querySelector('.ms-insp-fieldset') as HTMLFieldSetElement;
    expect(fields.disabled).toBe(true);
    expect(within(screen.getByRole('tabpanel')).getByText(/You are looking at v1/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Edit v2' }));
    await waitFor(() => expect(screen.queryByText(/You are looking at v1/)).toBeNull());
    expect(await screen.findByText('Draft · 1 edit')).toBeTruthy();
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
    await waitFor(() => expect(peekDraft(`${KEY}#v1`)).toBeNull());
  });

  it('"View vN" on a chat version card opens that version read-only', async () => {
    api.getConversation.mockImplementation(async () => [
      { type: 'version', at, n: 1, status: 'complete' }, { type: 'version', at, n: 2, status: 'complete' },
    ] as never);
    render(<Harness />);
    await opened();
    await userEvent.click(await screen.findByRole('button', { name: 'View v1' }));
    expect(await screen.findByText(/You are looking at v1/)).toBeTruthy();
  });

  it('an agent turn at work makes the editor read-only with the reason; the draft is kept and Save waits', async () => {
    live = { ...emptyLive(), jobs: { j1: { id: 'j1', key: 'creative:/w:acme:lancio', kind: 'creative', label: 'x', state: 'running', createdAt: at } } } as unknown as EventsState;
    render(<Harness />);
    await opened();
    expect(await screen.findByText(/The agent or a render is working on this creative: direct edits are available again/)).toBeTruthy();
    expect((probe.ctx as unknown as { actions: { apply(op: unknown): { ok: boolean } } }).actions.apply(move(5)).ok).toBe(false);
  });

  it('a discarded variant is read-only and says so', async () => {
    detail = { ...makeDetail([v2(1), v2(2)]), variants: {
      orphan: false, letter: 'b', host: 'lancio',
      group: { members: [{ letter: 'a', slug: 'lancio', status: 'active' }, { letter: 'b', slug: 'lancio~b', status: 'discarded' }], picks: {} },
    } } as unknown as CreativeDetail;
    render(<Harness />);
    await opened();
    await waitFor(() => expect(document.querySelector('.ms-ed-readonly')?.textContent).toBe('Discarded variant: restore it to work on it'));
    expect((probe.ctx as unknown as { actions: { apply(op: unknown): { ok: boolean } } }).actions.apply(move(5)).ok).toBe(false);
  });

  it('"Comment a spot" (or P), then a click on the frame: the note dialog, then a chip with the time; its marker shows on the picture', async () => {
    render(<Harness />);
    await opened();
    const spot = screen.getByRole('button', { name: 'Comment a spot' });
    await userEvent.click(spot);
    expect(spot.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/Click the spot of the frame at/)).toBeTruthy();
    const hit = await screen.findByRole('button', { name: /^Comment on the frame at/ });
    vi.spyOn(hit, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 100, bottom: 200, width: 100, height: 200, x: 0, y: 0, toJSON() {} });
    fireEvent.click(hit, { clientX: 25, clientY: 50, detail: 1 });
    const dialog = await screen.findByRole('dialog', { name: /^Comment on the frame at/ });
    await userEvent.type(within(dialog).getByLabelText('Your comment'), 'Più grande');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add comment' }));
    const { result } = renderHook(() => usePendingPins(pinsKey('acme', 'lancio')));
    expect(result.current[0]).toEqual([{ version: 2, pin: { format: REEL, x: 0.25, y: 0.25, timeSec: 0, note: 'Più grande' } }]);
    expect(screen.getByRole('tab', { name: /^Chat/ }).getAttribute('aria-selected')).toBe('true');
    expect(document.querySelectorAll('.ms-ed-stage .ms-cv-pin')).toHaveLength(1);
    // P toggles the mode from the keyboard; Esc leaves it.
    fireEvent.keyDown(window, { key: 'p' });
    expect(screen.getByRole('button', { name: 'Comment a spot' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Comment a spot' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('"Ask the agent" on a custom animation works like a note: the dialog, a comment bound to the clip and the slot, the user stays (items 10, 18)', async () => {
    const custom = structuredClone(spike);
    (custom.tracks.flatMap((t) => t.clips).find((k) => k.id === 'title') as { animations?: unknown }).animations = [{ prop: 'opacity', from: 0, to: 1, duration: 0.5 }];
    api.getEditorComposition.mockImplementation(async (_s, _c, n) => view(n, { composition: structuredClone(custom) }));
    render(<Harness />);
    await opened();
    await userEvent.click(within(screen.getByRole('region', { name: 'In this scene' })).getByRole('button', { name: 'title' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Ask the agent' }));
    const dialog = await screen.findByRole('dialog', { name: 'Comment on the in animation of "title"' });
    await userEvent.type(within(dialog).getByLabelText('Your comment'), 'Più lenta');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add comment' }));
    const { result } = renderHook(() => usePendingPins(pinsKey('acme', 'lancio')));
    expect(result.current[0]).toEqual([{ version: 2, pin: expect.objectContaining({ format: REEL, clipId: 'title', clipName: 'title', timeSec: 0.2, animation: 'in', note: 'Più lenta' }) }]);
    // The user stays in the inspector; the Chat tab counts the comments waiting to be sent.
    expect(screen.getByRole('tab', { name: 'Inspector' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /^Chat/ }).textContent).toBe('Chat1');
    expect(screen.getByText('1 comment waiting to be sent')).toBeTruthy();
    // A second one piles up with it.
    await userEvent.click(screen.getByRole('button', { name: 'Ask the agent' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Add comment' }));
    expect(result.current[0]).toHaveLength(2);
    expect(screen.getByRole('tab', { name: /^Chat/ }).textContent).toBe('Chat2');
  });

  it('selecting a clip shows the inspector by itself, but not while the user is writing in the chat (item 16)', async () => {
    render(<Harness />);
    await opened();
    const composer = screen.getByLabelText('Request a change') as HTMLTextAreaElement;
    await userEvent.type(composer, 'Il titolo');
    await userEvent.click(within(screen.getByRole('region', { name: 'In this scene' })).getByRole('button', { name: 'title' }));
    expect(probe.ctx?.selection).toBe('title');
    expect(screen.getByRole('tab', { name: /^Chat/ }).getAttribute('aria-selected')).toBe('true');
    await userEvent.clear(screen.getByLabelText('Request a change'));
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.click(within(screen.getByRole('region', { name: 'In this scene' })).getByRole('button', { name: 'card' }));
    expect(screen.getByRole('tab', { name: 'Inspector' }).getAttribute('aria-selected')).toBe('true');
  });

  it('an identity format: the editor first, then the rendered logo on light and dark, and the sizes grid (identity bar)', async () => {
    const LOGO = 'identity-logo';
    const set = { dir: LOGO, files: [{ path: 'logo.svg', role: 'vector' }, { path: 'logo.png', width: 1024, height: 400, alpha: true, role: 'raster' }, { path: 'logo-dark.png', width: 1024, height: 400, alpha: true, role: 'raster-dark' }], warnings: [] };
    detail = makeDetail([{ ...v2(1), outputs: [{ format: LOGO, file: 'identity-logo.png', width: 1024, height: 1024, durationSec: null, verified: true, preview: null, identitySet: set }],
      compositions: [{ format: LOGO, dir: `compositions/${LOGO}`, hash: hashOf(1) }] } as unknown as VersionEntry], { formats: [LOGO] });
    api.getEditorComposition.mockImplementation(async (_s, _c, n) => view(n, { format: LOGO, primaryFormat: LOGO, composition: { ...structuredClone(spike), width: 1024, height: 1024, duration: 0, scenes: [], tracks: [] } as Composition }));
    render(<Harness format={LOGO} />);
    await screen.findByTestId('player');
    await waitFor(() => expect(peekDraft(draftKey('acme', 'lancio', LOGO))).not.toBeNull());
    const views = await screen.findByRole('radiogroup', { name: 'View' });
    expect(within(views).getByRole('radio', { name: 'Edit' }).getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('.ms-ed-stage')!.hasAttribute('hidden')).toBe(false);
    await userEvent.click(within(views).getByRole('radio', { name: 'Image' }));
    expect(screen.getByRole('img', { name: /on a light and on a dark background/ })).toBeTruthy();
    expect(document.querySelector('.ms-idn-dark img')!.getAttribute('src')).toContain('identity-logo/logo-dark.png');
    expect(document.querySelector('.ms-ed-stage')!.hasAttribute('hidden')).toBe(true);
    await userEvent.click(within(views).getByRole('radio', { name: 'Sizes' }));
    expect(screen.getByRole('region', { name: 'Sizes' })).toBeTruthy();
  });

  it('a legacy older version picked in the viewer is the viewer; a version with a composition picked there is the editor again', async () => {
    detail = makeDetail([{ ...legacy(1), outputs: [{ format: REEL, file: 'reel.mp4', width: 1080, height: 1920, durationSec: 6, verified: true, preview: null }] }, v2(2)]);
    render(<Harness />);
    await opened();
    await viewRow(1);
    await waitFor(() => expect(document.querySelector('.ms-fv')).not.toBeNull());
    expect(document.querySelector('.ms-ed')).toBeNull();
    // The viewer's own badge: back to v2, the editor.
    await userEvent.click(await within(document.querySelector('.ms-topbar') as HTMLElement).findByRole('button', { name: /v2 is used for export/ }));
    await userEvent.click(await screen.findByRole('button', { name: /^View v2 ·/ }));
    await waitFor(() => expect(document.querySelector('.ms-ed')).not.toBeNull());
    expect(screen.queryByText(/You are looking at/)).toBeNull();
  });
});
