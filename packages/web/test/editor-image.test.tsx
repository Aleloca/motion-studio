import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type Composition, type CreativeDetail, type EditorCompositionView, type VersionEntry } from '@motion-studio/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import spikeJson from '../../shared/test/fixtures/spike-composition.json';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Route } from '../src/routes.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';

// jsdom has no PointerEvent: a MouseEvent carries the button the stage reads.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  }
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventPolyfill, configurable: true });
}

const at = '2026-10-13T10:00:00.000Z';
const IMG = 'instagram-image-1x1';
const spike = spikeJson as unknown as Composition;
const hashOf = (n: number) => String(n).repeat(64).slice(0, 64);

/** A still: no duration, no scenes, one clip per track except "words" (two clips); the last track is on top. */
function still(): Composition {
  const c = structuredClone(spike) as unknown as Composition & { tracks: Array<{ id: string; kind: string; clips: Array<Record<string, unknown>> }> };
  const pick = (id: string) => {
    const clip = structuredClone(c.tracks.flatMap((t) => t.clips).find((k) => k.id === id)!) as Record<string, unknown>;
    Object.assign(clip, { start: 0, duration: 0 });
    delete clip.animations; delete clip.scene;
    return clip;
  };
  c.width = 1080; c.height = 1080; c.duration = 0; c.scenes = [];
  c.tracks = [
    { id: 'back', kind: 'visual', clips: [pick('photo1')] },
    { id: 'panel', kind: 'visual', clips: [pick('card')] },
    { id: 'words', kind: 'text', name: 'Words', clips: [pick('title'), pick('subtitle')] },
    { id: 'mark', kind: 'visual', clips: [pick('logo1')] },
  ] as never;
  return c as Composition;
}

const v2 = (n: number): VersionEntry => ({
  n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: '', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null,
  compositions: [{ format: IMG, dir: `compositions/${IMG}`, hash: hashOf(n) }],
});
const makeDetail = (versions: VersionEntry[]): CreativeDetail => ({
  slug: 'post', jobKey: 'creative:/w:acme:post', versions,
  creative: {
    schemaVersion: 1, title: 'Post', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'g', message: 'm', formats: [IMG], durationSec: 0, assets: [], notes: '' },
  },
});
const FILES = ['composition.json', 'assets/photo.jpg', 'assets/spikefont.ttf', 'assets/logo.svg'];
const view = (n: number, over: Partial<EditorCompositionView> = {}): EditorCompositionView => ({
  n, format: IMG, primaryFormat: IMG, hash: hashOf(n), composition: still(), files: FILES.map((path) => ({ path, size: 1000 })), fonts: [], ...over,
});

let detail = makeDetail([v2(1)]);
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async () => detail),
  getConversation: vi.fn(async () => []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  getEditorComposition: vi.fn(async (_s: string, _c: string, n: number, _f: string) => view(n)),
  saveEdits: vi.fn(async (..._a: unknown[]) => ({ version: 2 })),
  stageEditorAsset: vi.fn(),
  sendCreativeTurn: vi.fn(),
  revokePreview: vi.fn(async (..._a: unknown[]) => ({ revoked: true })),
  previewSession: vi.fn(async (_s: string, _c: string, n: number, format: string) => ({
    url: `http://127.0.0.1:61234/tok-${format}-v${n}/runtime/index.html?mode=preview&parentOrigin=x`, token: `tok-${format}-v${n}`, origin: 'http://127.0.0.1:61234',
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), format, hash: hashOf(n), width: 1080, height: 1080, duration: 0, fps: 30,
  })),
  cancelJob: vi.fn(),
  getStoryboard: vi.fn(),
  getEditorSvg: vi.fn(async (_s: string, _c: string, _t: string, path: string) => ({ path, content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff0000"/></svg>', warnings: [] })),
};
class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
vi.mock('../src/api.ts', () => ({ api, ApiError }));

const media = vi.hoisted(() => {
  const events = new EventTarget();
  const m = {
    seq: 0, applied: null as null | { seq: number; errors: Array<{ code: string; message: string }> }, currentTime: 0, duration: 0, loop: false, playbackRate: 1, paused: true,
    setComposition: vi.fn((_c: unknown) => { m.seq += 1; return m.seq; }),
    addSessionMedia: vi.fn((_src: string, _m: unknown) => true),
    clipBounds: null as null | { clipId: string | null; bounds: { x: number; y: number; width: number; height: number } | null; scale: number },
    select: vi.fn((_id: string | null) => {}),
    play: vi.fn(async () => {}),
    pause: vi.fn(() => {}),
    addEventListener: (t: string, l: EventListener) => events.addEventListener(t, l),
    removeEventListener: (t: string, l: EventListener) => events.removeEventListener(t, l),
    report(clipId: string | null, bounds: { x: number; y: number; width: number; height: number } | null, scale: number) {
      m.clipBounds = { clipId, bounds, scale };
      act(() => { events.dispatchEvent(new Event('clipbounds')); });
    },
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

const { EditorScreen } = await import('../src/screens/editor/EditorScreen.tsx');
const { __resetPreviewSessions } = await import('../src/components/compositionPreview.ts');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { __resetDrafts, draftKey, peekDraft } = await import('../src/screens/editor/draftStore.ts');
const { __resetToasts } = await import('../src/ui/toast.tsx');

const { __resetPendingPins, pinsKey, usePendingPins } = await import('../src/screens/pendingPins.ts');
const { renderHook } = await import('@testing-library/react');
const KEY = draftKey('acme', 'post', IMG);
const emptyLive = (): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {}, snapshots: 0 } as unknown as EventsState);
let live = emptyLive();

function Harness() {
  const route: Route = { name: 'format', slug: 'acme', creative: 'post', format: IMG };
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
        <EditorScreen slug="acme" creative="post" format={IMG} live={live} />
      </ShellContext.Provider>
    </I18nProvider>
  );
}
void (null as unknown as ReactNode); void useEffect; void useState; void fireEvent; void waitFor;

beforeEach(() => {
  __resetPreviewSessions();
  __resetDrafts();
  __resetToasts();
  vi.clearAllMocks();
  api.saveEdits.mockReset().mockImplementation(async () => ({ version: 2 }));
  api.getEditorComposition.mockReset().mockImplementation(async (_s, _c, n) => view(n));
  media.clipBounds = null;
  detail = makeDetail([v2(1)]);
  live = emptyLive();
  location.hash = `#/p/acme/c/post/f/${IMG}`;
});
afterEach(() => { vi.useRealTimers(); });

const opened = async () => {
  await screen.findByTestId('player');
  await waitFor(() => expect(peekDraft(KEY)).not.toBeNull());
  await screen.findByRole('list', { name: 'Layers of this image' });
};
const panel = () => screen.getByRole('complementary', { name: 'Layers' });
const rowOf = (name: string) => document.querySelector<HTMLElement>(`[data-layer-name="${name}"]`)!;
const clipOf = (id: string) => peekDraft(KEY)!.composition.tracks.flatMap((t) => t.clips).find((k) => k.id === id) as unknown as Record<string, unknown>;
const trackOf = (id: string) => peekDraft(KEY)!.composition.tracks.find((t) => t.id === id) as unknown as Record<string, unknown>;

describe('image editor · layers', () => {
  it('lists the layers in stacking order, the last track on top, 44 px rows with kind icon, name, kind and lock', async () => {
    render(<Harness />);
    await opened();
    const names = [...document.querySelectorAll('[data-layer-name]')].map((r) => r.getAttribute('data-layer-name'));
    // Tracks back, panel, words (title, subtitle), mark: the top of the stack first, and a later clip is above an earlier one.
    expect(names).toEqual(['logo1', 'Words', 'subtitle', 'title', 'card', 'photo1']);
    const logo = rowOf('logo1');
    expect(logo.textContent).toContain('logo1');
    expect(within(logo).getByText('vector image')).toBeTruthy();
    expect(logo.querySelector('svg')).not.toBeNull();
    expect(within(logo).getByRole('button', { name: 'Hide logo1' })).toBeTruthy();
    expect(within(logo).getByRole('button', { name: 'Lock logo1' })).toBeTruthy();
    expect(document.querySelector('.ms-layers-foot')!.textContent).toBe('Ask the agent to add layers');
    // No way to add a layer from here.
    expect(within(panel()).queryByRole('button', { name: /add|new|\+/i })).toBeNull();
  });

  it('hide and lock go through the draft: a track for a single-clip layer, the clip for a nested one', async () => {
    render(<Harness />);
    await opened();
    await userEvent.click(within(rowOf('card')).getByRole('button', { name: 'Hide card' }));
    expect(trackOf('panel')).toMatchObject({ hidden: true });
    expect(within(rowOf('card')).getByRole('button', { name: 'Show card' })).toBeTruthy();
    await userEvent.click(within(rowOf('card')).getByRole('button', { name: 'Show card' }));
    expect(trackOf('panel')).not.toHaveProperty('hidden');
    await userEvent.click(within(rowOf('card')).getByRole('button', { name: 'Lock card' }));
    expect(trackOf('panel')).toMatchObject({ locked: true });
    // Nested clips: their own flags, and the track row has its own.
    await userEvent.click(within(rowOf('subtitle')).getByRole('button', { name: 'Hide subtitle' }));
    expect(clipOf('subtitle')).toMatchObject({ hidden: true });
    expect(clipOf('title')).not.toHaveProperty('hidden');
    await userEvent.click(within(rowOf('Words')).getByRole('button', { name: 'Lock Words' }));
    expect(trackOf('words')).toMatchObject({ locked: true });
    expect(peekDraft(KEY)!.ops.map((o) => o.kind)).toEqual(['trackFlags', 'trackFlags', 'trackFlags', 'clipFlags', 'trackFlags']);
    // Locked and hidden layers can still be unlocked and shown again.
    await userEvent.click(within(rowOf('card')).getByRole('button', { name: 'Unlock card' }));
    expect(trackOf('panel')).not.toHaveProperty('locked');
  });

  it('a flag the agent wrote on the clip shows, and is cleared from the clip', async () => {
    api.getEditorComposition.mockImplementation(async (_s, _c, n) => {
      const v = view(n);
      (v.composition.tracks[0]!.clips[0] as { hidden?: boolean }).hidden = true;
      return v;
    });
    render(<Harness />);
    await opened();
    await userEvent.click(within(rowOf('photo1')).getByRole('button', { name: 'Show photo1' }));
    expect(clipOf('photo1')).not.toHaveProperty('hidden');
  });

  it('selecting a layer drives the handles and the inspector; the inspector has no timing or animation', async () => {
    render(<Harness />);
    await opened();
    await userEvent.click(screen.getByRole('tab', { name: 'Inspector' }));
    expect(screen.getByText('Select a clip')).toBeTruthy();
    await userEvent.click(within(rowOf('card')).getByRole('button', { name: /^card/ }));
    expect(media.select).toHaveBeenLastCalledWith('card');
    expect(rowOf('card').getAttribute('aria-current')).toBe('true');
    const insp = document.querySelector('[data-slot="inspector"]') as HTMLElement;
    await waitFor(() => expect(insp.querySelector('[data-clip-type="shape"]')).not.toBeNull());
    // The box section is there; timing and animation are not.
    expect(insp.querySelector('[data-section="box"]')).not.toBeNull();
    expect(insp.querySelector('[data-section="timing"]')).toBeNull();
    expect(insp.querySelector('[data-section="animation"]')).toBeNull();
    media.report('card', { x: 45, y: 250, width: 450, height: 350 }, 0.5);
    await waitFor(() => expect(document.querySelector('.ms-stage-box')).not.toBeNull());
    // Another layer replaces the selection; clicking the empty stage clears it.
    await userEvent.click(within(rowOf('title')).getByRole('button', { name: /^title/ }));
    expect(media.select).toHaveBeenLastCalledWith('title');
    expect(rowOf('card').getAttribute('aria-current')).toBeNull();
    fireEvent.pointerDown(document.querySelector('.ms-stage-layer')!, { button: 0 });
    expect(rowOf('title').getAttribute('aria-current')).toBeNull();
  });

  it('a locked layer can be selected: its handles say it is locked', async () => {
    render(<Harness />);
    await opened();
    await userEvent.click(within(rowOf('card')).getByRole('button', { name: 'Lock card' }));
    await userEvent.click(within(rowOf('card')).getByRole('button', { name: /^card/ }));
    media.report('card', { x: 45, y: 250, width: 450, height: 350 }, 0.5);
    await waitFor(() => expect(document.querySelector('.ms-stage-box.ms-locked')).not.toBeNull());
  });
});

describe('image editor · zoom', () => {
  it('fits by default; 50 to 400 % sets the frame size from the image width and Fit goes back', async () => {
    render(<Harness />);
    await opened();
    const frame = document.querySelector<HTMLElement>('[data-slot="stage"]')!;
    const fitWidth = frame.style.width;
    expect(fitWidth).toContain('cqw');
    const bar = screen.getByRole('group', { name: 'Zoom' });
    const fit = within(bar).getByRole('button', { name: 'Fit' });
    expect(fit.getAttribute('aria-pressed')).toBe('true');
    const slider = within(bar).getByRole('slider', { name: 'Zoom' });
    expect(slider.getAttribute('aria-valuemin')).toBe('50');
    expect(slider.getAttribute('aria-valuemax')).toBe('400');
    slider.focus();
    fireEvent.keyDown(slider, { key: 'End' });
    expect(frame.style.width).toBe('4320px');
    expect(fit.getAttribute('aria-pressed')).toBe('false');
    expect(within(bar).getByText('400%')).toBeTruthy();
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(frame.style.width).toBe('540px');
    await userEvent.click(fit);
    expect(frame.style.width).toBe(fitWidth);
  });
});

describe('image editor · save', () => {
  it('a png format saves a new version through the same flow, without the agent', async () => {
    api.saveEdits.mockImplementationOnce(async () => { detail = makeDetail([v2(1), v2(2)]); return { version: 2 }; });
    render(<Harness />);
    await opened();
    expect(screen.queryByText(/Draft ·/)).toBeNull();
    await userEvent.click(within(rowOf('card')).getByRole('button', { name: /^card/ }));
    const insp = document.querySelector('[data-slot="inspector"]') as HTMLElement;
    await waitFor(() => expect(insp.querySelector('[data-clip-type="shape"]')).not.toBeNull());
    await userEvent.click(within(rowOf('card')).getByRole('button', { name: 'Hide card' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save as v2' }));
    await waitFor(() => expect(api.saveEdits).toHaveBeenCalledTimes(1));
    const [slug, creative, body] = api.saveEdits.mock.calls[0]! as [string, string, Record<string, unknown>];
    expect([slug, creative]).toEqual(['acme', 'post']);
    expect(body).toMatchObject({ baseVersion: 1, format: IMG, baseHash: hashOf(1), staged: [], ops: [{ kind: 'trackFlags', trackId: 'panel', hidden: true }] });
    expect((body.composition as Composition).duration).toBe(0);
    expect(await screen.findByText(/^✓ Saved as .* v2$/)).toBeTruthy();
    await waitFor(() => expect(api.getEditorComposition).toHaveBeenCalledWith('acme', 'post', 2, IMG));
    await waitFor(() => expect(within(document.querySelector('.ms-topbar') as HTMLElement).getByRole('button', { name: /v2 is used for export/ })).toBeTruthy());
    expect(peekDraft(KEY)!.ops).toHaveLength(0);
    // No agent turn, no tokens.
    expect(api.sendCreativeTurn).not.toHaveBeenCalled();
  });
});

describe('image editor · stage tools and the svg layer tree (user test items 12, 13, 15)', () => {
  beforeEach(() => { __resetPendingPins(); });

  it('labelled comment tools with their tooltips, undo and redo with the shortcut, the magnet; a comment on an svg element names it', async () => {
    render(<Harness />);
    await screen.findByTestId('player');
    await waitFor(() => expect(peekDraft(KEY)).not.toBeNull());
    expect(screen.getByRole('button', { name: 'Undo' }).getAttribute('title')).toMatch(/^Undo \((⌘Z|Ctrl\+Z)\)$/);
    expect(screen.getByRole('button', { name: 'Redo' }).getAttribute('title')).toMatch(/^Redo \((⇧⌘Z|Ctrl\+Shift\+Z)\)$/);
    const spot = screen.getByRole('button', { name: 'Comment a spot' });
    expect(spot.textContent).toBe('Comment a spot');
    expect(spot.getAttribute('title')).toBe('Then click a spot of the picture and write a note for the agent (P)');
    // An image has no timeline: its magnet stays on the stage, with what it does.
    expect(screen.getByRole('button', { name: 'Snap to guides and edges' }).getAttribute('title')).toMatch(/^Snap to guides: /);
    const layerComment = screen.getByRole('button', { name: 'Comment on layer' });
    expect((layerComment as HTMLButtonElement).disabled).toBe(true);

    // The svg layer opens into its elements; one of them is picked: its inspector, and the comment is about it.
    await userEvent.click(screen.getByRole('button', { name: 'Show the elements of logo1' }));
    const tree = await screen.findByRole('list', { name: 'Elements of logo1' });
    await userEvent.click(within(tree).getByRole('button', { name: 'Rectangle 1' }));
    expect(screen.getByRole('tab', { name: 'Inspector' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('navigation', { name: 'Layer and element' }).textContent).toBe('logo1Rectangle 1');
    const elementComment = screen.getByRole('button', { name: 'Comment on element' });
    expect(elementComment.getAttribute('title')).toBe('Write a note for the agent about the selected element of the layer (C)');
    await userEvent.click(elementComment);
    const dialog = await screen.findByRole('dialog', { name: 'Comment on "Rectangle 1" in "logo1"' });
    await userEvent.type(within(dialog).getByLabelText('Your comment'), 'Più scuro');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add comment' }));
    const { result } = renderHook(() => usePendingPins(pinsKey('acme', 'post')));
    expect(result.current[0].map((p) => p.pin)).toEqual([expect.objectContaining({ clipId: 'logo1', element: { path: '0', name: 'Rectangle 1' }, note: 'Più scuro', timeSec: null })]);

    // "Ask the agent to change it" from the element's inspector: the same comment, and the user stays in the inspector.
    await userEvent.click(screen.getByRole('tab', { name: 'Inspector' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ask the agent to change it' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Comment on "Rectangle 1" in "logo1"' })).getByRole('button', { name: 'Add comment' }));
    expect(result.current[0]).toHaveLength(2);
    expect(screen.getByRole('tab', { name: 'Inspector' }).getAttribute('aria-selected')).toBe('true');
    // Back to the layer: its comment is about the layer again.
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Layer and element' })).getByRole('button', { name: 'logo1' }));
    expect(screen.getByRole('button', { name: 'Comment on layer' })).toBeTruthy();
  });
});
