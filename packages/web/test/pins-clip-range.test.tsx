import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_FORMATS, pinSchema, type Composition, type ConversationEntry, type CreativeDetail, type EditorCompositionView, type Pin, type StagedAsset, type VersionEntry,
} from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import spikeJson from '../../shared/test/fixtures/spike-composition.json';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Route } from '../src/routes.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';

// Comments on clips and time ranges (Phase 10b, Task 10): creation in the editor (key, button, Shift + drag on the ruler) and in
// the format view, the chips of the conversation (en / it), the spans on the timeline and the transport, and old pins.

// jsdom has no PointerEvent: a MouseEvent carries the coordinates, button and modifiers the gestures read.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  }
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventPolyfill, configurable: true });
}
// No layout: the timeline scroller is 768 px wide, 168 of them the lane headers, so the 6 s composition fits 600 px (100 px per second).
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.classList?.contains('ms-tl-scroll') ? 768 : 0; } });

const at = '2026-10-08T10:00:00.000Z';
const spike = spikeJson as unknown as Composition;
const REEL = 'instagram-reel-9x16';
const hashOf = (n: number) => String(n).repeat(64).slice(0, 64);
const FILES = ['composition.json', 'assets/bg.mp4', 'assets/photo.jpg', 'assets/spikefont.ttf', 'assets/logo.svg', 'assets/music.wav', 'assets/voice.wav', 'assets/sfx.wav', 'layers/outro.html'];
const v2 = (n: number): VersionEntry => ({
  n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: '', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null,
  compositions: [{ format: REEL, dir: `compositions/${REEL}`, hash: hashOf(n) }],
});
const makeDetail = (versions: VersionEntry[]): CreativeDetail => ({
  slug: 'lancio', jobKey: 'creative:/w:acme:lancio', versions,
  creative: {
    schemaVersion: 1, title: 'Lancio estivo', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'g', message: 'm', formats: [REEL], durationSec: 6, assets: [], notes: '' },
  },
});
const view = (n: number): EditorCompositionView => ({
  n, format: REEL, primaryFormat: REEL, hash: hashOf(n), composition: structuredClone(spike), files: FILES.map((path) => ({ path, size: 1000 })), fonts: [],
});

let detail = makeDetail([v2(1), v2(2)]);
let conversation: ConversationEntry[] = [];
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async () => detail),
  getConversation: vi.fn(async () => conversation),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  getEditorComposition: vi.fn(async (_s: string, _c: string, n: number, _f: string) => view(n)),
  saveEdits: vi.fn(async (..._a: unknown[]) => ({ version: 3 })),
  stageEditorAsset: vi.fn(async (..._a: unknown[]): Promise<StagedAsset> => ({ path: 'assets/lib/ab12cd34-clip.mp4', size: 99, kind: 'video' })),
  sendCreativeTurn: vi.fn(async (..._a: unknown[]) => ({ id: 'j9', key: 'k', kind: 'creative', label: 'x', state: 'queued', createdAt: at })),
  revokePreview: vi.fn(async (..._a: unknown[]) => ({ revoked: true })),
  getPinFrames: vi.fn(async () => ({ n: 1, expiresAt: null, frames: [] })),
  getStoryboard: vi.fn(async (_s: string, _c: string, n: number, format: string) => ({
    format, hash: hashOf(n), width: 90, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), frames: [],
  })),
  previewSession: vi.fn(async (_s: string, _c: string, n: number, format: string, _o: string, _renew?: string) => ({
    url: `http://127.0.0.1:61234/tok-${format}-v${n}/runtime/index.html?mode=preview&parentOrigin=x`, token: `tok-${format}-v${n}`, origin: 'http://127.0.0.1:61234',
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), format, hash: hashOf(n), width: 1080, height: 1920, duration: 6, fps: 30,
  })),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
};
class ApiError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));

// A fake of the player: the real one needs a runtime frame. Only the contract the editor and the format view use.
const media = vi.hoisted(() => {
  const events = new EventTarget();
  const m = {
    seq: 0, applied: null as null | { seq: number; errors: Array<{ code: string; message: string }> }, currentTime: 0, duration: 6, loop: false, playbackRate: 1, defaultPlaybackRate: 1, paused: true,
    setComposition: vi.fn((_c: unknown) => { m.seq += 1; return m.seq; }),
    addSessionMedia: vi.fn((_src: string, _m: unknown) => true),
    clipBounds: null as unknown,
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

const { EditorScreen } = await import('../src/screens/editor/EditorScreen.tsx');
const { FormatView } = await import('../src/screens/FormatView.tsx');
const { Conversation } = await import('../src/components/Conversation.tsx');
const { __resetPreviewSessions } = await import('../src/components/compositionPreview.ts');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { __resetDrafts, peekDraft, draftKey } = await import('../src/screens/editor/draftStore.ts');
const { __resetPendingPins, pinsKey, usePendingPins } = await import('../src/screens/pendingPins.ts');
const { getToasts, __resetToasts } = await import('../src/ui/toast.tsx');
const { clipCentre, clipPin, rangePin, clipRangeChip } = await import('../src/screens/pinModel.ts');
const { sentComments } = await import('../src/screens/CreativeCanvas.tsx');

const KEY = draftKey('acme', 'lancio', REEL);
const emptyLive = (): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {}, snapshots: 0 } as unknown as EventsState);
const live = emptyLive();

function Page({ kind, locale = 'en' }: { kind: 'edit' | 'format'; locale?: 'en' | 'it' }) {
  const route: Route = kind === 'edit' ? { name: 'edit', slug: 'acme', creative: 'lancio', format: REEL } : { name: 'format', slug: 'acme', creative: 'lancio', format: REEL };
  const shell = {
    route, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} },
    openPalette: () => {},
  } as unknown as Shell;
  return (
    <I18nProvider locale={locale}>
      <ShellContext.Provider value={shell}>
        <header className="ms-topbar"><TopBar /></header>
        {kind === 'edit' ? <EditorScreen slug="acme" creative="lancio" format={REEL} live={live} /> : <FormatView slug="acme" creative="lancio" format={REEL} live={live} />}
      </ShellContext.Provider>
    </I18nProvider>
  );
}

const pending = () => {
  const h = renderHook(() => usePendingPins(pinsKey('acme', 'lancio')));
  const pins = h.result.current[0];
  h.unmount();
  return pins;
};

beforeEach(() => {
  __resetPreviewSessions();
  __resetDrafts();
  __resetToasts();
  __resetPendingPins();
  vi.clearAllMocks();
  media.currentTime = 0;
  media.duration = 6;
  media.paused = true;
  media.clipBounds = null;
  detail = makeDetail([v2(1), v2(2)]);
  conversation = [];
  location.hash = `#/p/acme/c/lancio/f/${REEL}/edit`;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const stubRect = (el: Element, width = 600) =>
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: width, bottom: 26, width, height: 26, x: 0, y: 0, toJSON() {} });
const key = (init: KeyboardEventInit, target: Window | Element = window) => fireEvent.keyDown(target, init);
const opened = async () => {
  await screen.findByTestId('player');
  await waitFor(() => expect(peekDraft(KEY)).not.toBeNull());
  const ruler = await screen.findByRole('slider', { name: /^Timeline ruler/ });
  // The gestures act only once the player reports itself ready.
  await waitFor(() => expect(ruler.getAttribute('aria-disabled')).toBeNull());
};
const dialog = () => screen.findByRole('dialog');
const pick = (name: string) => userEvent.click(within(screen.getByRole('region', { name: 'In this scene' })).getByRole('button', { name }));

describe('pin model', () => {
  const comp = spike;
  const title = comp.tracks.flatMap((t) => t.clips).find((c) => c.id === 'title')!;

  it('the clip centre comes from the box the runtime drew, else from the clip itself, else the middle', () => {
    // 1080x1920 composition shown at 0.5: a drawn box at (100, 200) 200x100 is centred at (200, 250) frame px = (400, 500) comp px.
    const c = clipCentre(comp, title, { bounds: { x: 100, y: 200, width: 200, height: 100 }, scale: 0.5 });
    expect(c.x).toBeCloseTo(400 / 1080, 6);
    expect(c.y).toBeCloseTo(500 / 1920, 6);
    const own = clipCentre(comp, title, null);
    expect(own.x).toBeGreaterThanOrEqual(0);
    expect(own.x).toBeLessThanOrEqual(1);
    const audio = comp.tracks.flatMap((t) => t.clips).find((k) => k.type === 'audio')!;
    expect(clipCentre(comp, audio, null)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('a clip pin carries the clip id and name, the time and the centre; a range pin its range', () => {
    const p = clipPin({ format: REEL, comp, clip: title, time: 1.23456, drawn: { bounds: { x: 100, y: 200, width: 200, height: 100 }, scale: 0.5 } });
    expect(p).toMatchObject({ format: REEL, timeSec: 1.235, clipId: 'title', clipName: 'title' });
    expect(pinSchema.safeParse(p).success).toBe(true);
    const r = rangePin({ format: REEL, start: 3.5, end: 1, duration: 6, note: 'qui' });
    expect(r).toEqual({ format: REEL, x: 0.5, y: 0.5, timeSec: 1, range: { start: 1, end: 3.5 }, note: 'qui' });
    expect(pinSchema.safeParse(r).success).toBe(true);
    // A click is not a range; the range stays inside the composition.
    expect(rangePin({ format: REEL, start: 2, end: 2.05, duration: 6 })).toBeNull();
    expect(rangePin({ format: REEL, start: 5, end: 9, duration: 6 })!.range).toEqual({ start: 5, end: 6 });
  });

  it('pins written before Phase 10b still parse and read as before', () => {
    const old = { format: REEL, x: 0.25, y: 0.5, timeSec: 4.2, note: 'qui' };
    expect(pinSchema.parse(old)).toEqual(old);
    expect(pinSchema.safeParse({ ...old, range: { start: 3, end: 2 } }).success).toBe(false);
    expect(pinSchema.safeParse({ ...old, clipId: 'x'.repeat(65) }).success).toBe(false);
    const { applied } = sentComments([{ type: 'user', at, text: 'x', pins: [old, { ...old, timeSec: 2, range: { start: 2, end: 3 } }], attachments: [] }, { type: 'version', at, n: 3, status: 'complete' }]);
    expect(applied[0]!.items.map((k) => [k.frame, k.frameEnd])).toEqual([['3-1.jpg', undefined], ['3-2.jpg', '3-2e.jpg']]);
  });
});

describe('chips in the conversation', () => {
  const pins: Pin[] = [
    { format: REEL, x: 0.5, y: 0.5, timeSec: 1, clipId: 'title', clipName: 'Headline' },
    { format: REEL, x: 0.5, y: 0.5, timeSec: 2, range: { start: 2, end: 3.5 } },
    { format: REEL, x: 0.5, y: 0.5, timeSec: 4.2, note: 'plain' },
  ];
  const chat = (locale: 'en' | 'it') => render(
    <I18nProvider locale={locale}>
      <Conversation slug="acme" creative="lancio" entries={[]} approvals={[]} job={undefined} live={[]} pins={pins} onRemovePin={() => {}} onEditPin={() => {}} formatName={() => 'Reel'} canGenerate={false} />
    </I18nProvider>,
  );
  const labels = () => [...document.querySelectorAll('.ms-composer-pin .ms-pin-ref')].map((n) => n.textContent);

  it('read Reel · "Title" clip and Reel · 2.0–3.5 s in English', () => {
    chat('en');
    expect(labels()).toEqual(['Reel · "Headline" clip', 'Reel · 2.0–3.5 s', '3 · Reel @ 4.2s']);
  });
  it('read the same in Italian', () => {
    chat('it');
    expect(labels()).toEqual(['Reel · clip "Headline"', 'Reel · 2,0–3,5 s', '3 · Reel @ 4,2s']);
  });
  it('a sent message shows them too', () => {
    const entries: ConversationEntry[] = [{ type: 'user', at, text: 'fai così', pins, attachments: [] }];
    render(<I18nProvider locale="en"><Conversation slug="acme" creative="lancio" entries={entries} approvals={[]} job={undefined} live={[]} formatName={() => 'Reel'} canGenerate={false} /></I18nProvider>);
    expect(screen.getByText('Reel · "Headline" clip')).toBeTruthy();
    expect(screen.getByText('Reel · 2.0–3.5 s')).toBeTruthy();
  });
  it('clipRangeChip is null for any other pin', () => {
    expect(clipRangeChip(pins[2]!, 'Reel', { web: { conversation: {} } } as never, 'en')).toBeNull();
  });
});

describe('the editor', () => {
  it('C on a selected clip asks for a note and makes a clip pin at the clip centre and the current time', async () => {
    render(<Page kind="edit" />);
    await opened();
    media.clipBounds = { clipId: 'title', bounds: { x: 100, y: 200, width: 200, height: 100 }, scale: 0.5 };
    media.currentTime = 1;
    media.emit('timeupdate');
    await pick('title');
    key({ key: 'c' });
    const d = await dialog();
    expect(within(d).getByRole('heading', { name: 'Comment on "title"' })).toBeTruthy();
    await userEvent.type(within(d).getByLabelText('Your comment'), 'più grande');
    await userEvent.click(within(d).getByRole('button', { name: 'Add comment' }));
    const [p] = pending();
    expect(p!.version).toBe(2);
    expect(p!.pin).toMatchObject({ format: REEL, clipId: 'title', clipName: 'title', note: 'più grande' });
    expect(p!.pin.x).toBeCloseTo(400 / 1080, 5);
    expect(p!.pin.y).toBeCloseTo(500 / 1920, 5);
    expect(typeof p!.pin.timeSec).toBe('number');
    expect(pinSchema.safeParse(p!.pin).success).toBe(true);
    // It is a chip in the chat now, and the editor stays untouched: no edit, no save.
    await screen.findByLabelText('Request a change');
    expect(document.querySelector('.ms-composer-pin .ms-pin-ref')?.textContent).toMatch(/· "title" clip$/);
    expect(peekDraft(KEY)!.ops).toHaveLength(0);
    expect(api.saveEdits).not.toHaveBeenCalled();
    // The comment goes out with the next message.
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalled());
    expect((api.sendCreativeTurn.mock.calls[0]![2] as { pins: Pin[] }).pins[0]).toMatchObject({ clipId: 'title' });
  });

  it('the Comment on clip button does the same and is disabled with no clip selected', async () => {
    render(<Page kind="edit" />);
    await opened();
    const button = screen.getByRole('button', { name: 'Comment on clip' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await pick('title');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(button);
    const d = await dialog();
    await userEvent.click(within(d).getByRole('button', { name: 'Add comment' }));
    // A note is optional: the clip is the comment.
    expect(pending()[0]!.pin).toMatchObject({ clipId: 'title' });
    expect(pending()[0]!.pin.note).toBeUndefined();
  });

  it('C with no clip selected explains, and never fires while typing or with a modifier', async () => {
    render(<Page kind="edit" />);
    await opened();
    key({ key: 'c' });
    expect(getToasts().map((t) => t.text)).toContain('Select a clip to comment on it');
    await pick('title');
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    key({ key: 'c' }, input);
    key({ key: 'c', ctrlKey: true });
    key({ key: 'c', metaKey: true });
    key({ key: 'C', shiftKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(pending()).toHaveLength(0);
    input.remove();
  });

  it('Shift + drag on the ruler picks a range, asks for a note, draws a span and a chip; a plain drag still scrubs', async () => {
    render(<Page kind="edit" />);
    await opened();
    const ruler = screen.getByRole('slider', { name: /^Timeline ruler/ });
    stubRect(ruler);
    // 100 px per second: 100 → 1.0 s, 350 → 3.5 s. Nothing seeks while the range is picked.
    fireEvent.pointerDown(ruler, { clientX: 100, pointerId: 1, button: 0, shiftKey: true });
    act(() => { fireEvent.pointerMove(window, { clientX: 350, pointerId: 1, shiftKey: true }); });
    await waitFor(() => expect(document.querySelector('.ms-tl-picking')).not.toBeNull());
    act(() => { fireEvent.pointerUp(window, { clientX: 350, pointerId: 1, shiftKey: true }); });
    expect(document.querySelector('.ms-tl-picking')).toBeNull();
    const d = await dialog();
    expect(within(d).getByRole('heading', { name: 'Comment on 1.0–3.5 s' })).toBeTruthy();
    await userEvent.type(within(d).getByLabelText('Your comment'), 'troppo lento');
    await userEvent.click(within(d).getByRole('button', { name: 'Add comment' }));
    const [p] = pending();
    expect(p!.pin).toMatchObject({ format: REEL, timeSec: 1, range: { start: 1, end: 3.5 }, note: 'troppo lento', x: 0.5, y: 0.5 });
    expect(p!.pin.clipId).toBeUndefined();
    // The span on the timeline, 100 px per second.
    const span = screen.getByRole('img', { name: 'Comment on 1.0–3.5 s: troppo lento' });
    expect(span.style.left).toBe('100px');
    expect(span.style.width).toBe('250px');
    expect(document.querySelector('.ms-composer-pin .ms-pin-ref')?.textContent).toMatch(/· 1\.0–3\.5 s$/);
    expect(peekDraft(KEY)!.ops).toHaveLength(0);
  });

  it('a click with Shift (no drag) makes no range, and a plain drag seeks', async () => {
    render(<Page kind="edit" />);
    await opened();
    const ruler = screen.getByRole('slider', { name: /^Timeline ruler/ });
    stubRect(ruler);
    fireEvent.pointerDown(ruler, { clientX: 200, pointerId: 1, button: 0, shiftKey: true });
    fireEvent.pointerUp(window, { clientX: 203, pointerId: 1, shiftKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(pending()).toHaveLength(0);
    fireEvent.pointerDown(ruler, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    expect(media.currentTime).toBeCloseTo(1, 2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a version other than the one the agent resumes from cannot be commented', async () => {
    detail = makeDetail([v2(1), v2(2)]);
    detail.creative.resumeFrom = { version: 1, sessionId: 's' };
    render(<Page kind="edit" />);
    await opened();
    await pick('title');
    key({ key: 'c' });
    expect(getToasts().map((t) => t.text)).toContain('Comments apply to v1: open that version to comment.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(pending()).toHaveLength(0);
  });

  it('editing a chip re-opens its note; cancelling makes no pin', async () => {
    render(<Page kind="edit" />);
    await opened();
    await pick('title');
    key({ key: 'c' });
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));
    expect(pending()).toHaveLength(0);
    key({ key: 'c' });
    await userEvent.type(within(await dialog()).getByLabelText('Your comment'), 'uno');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add comment' }));
    await userEvent.click(await screen.findByRole('button', { name: /^Edit comment 1/ }));
    const d = await dialog();
    expect((within(d).getByLabelText('Your comment') as HTMLTextAreaElement).value).toBe('uno');
    await userEvent.type(within(d).getByLabelText('Your comment'), ' due');
    await userEvent.click(within(d).getByRole('button', { name: 'Save comment' }));
    expect(pending()).toHaveLength(1);
    expect(pending()[0]!.pin.note).toBe('uno due');
    expect(pending()[0]!.pin.clipId).toBe('title');
  });
});

describe('the format view', () => {
  const FORMAT = REEL;
  const ready = async () => {
    await screen.findByTestId('player');
    await waitFor(() => expect((document.querySelector('.ms-fv-play') as HTMLButtonElement | null)?.disabled).toBe(false));
  };
  beforeEach(() => { location.hash = `#/p/acme/c/lancio/f/${FORMAT}`; });

  it('"Comment on a clip" lists the clips playing now and starts a comment on the chosen one', async () => {
    render(<Page kind="format" />);
    await ready();
    media.currentTime = 1;
    media.emit('timeupdate');
    const picker = await screen.findByRole('button', { name: /Comment on a clip/ });
    await userEvent.click(picker);
    const options = within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(['title', 'subtitle', 'card']));
    expect(options).not.toContain('caption');
    await userEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'title' }));
    const bubble = await screen.findByRole('group', { name: /Comment 1/ });
    expect(within(bubble).getByText(/Comment on "title"/)).toBeTruthy();
    await userEvent.type(within(bubble).getByRole('textbox'), 'colore');
    await userEvent.click(within(bubble).getByRole('button', { name: 'Comment' }));
    const [p] = pending();
    expect(p!.pin).toMatchObject({ format: FORMAT, clipId: 'title', clipName: 'title', timeSec: 1, note: 'colore' });
  });

  it('C comments on the topmost clip at the playhead, and not while typing', async () => {
    render(<Page kind="format" />);
    await ready();
    media.currentTime = 1;
    media.emit('timeupdate');
    await screen.findByRole('button', { name: /Comment on a clip/ });
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    key({ key: 'c' }, input);
    expect(screen.queryByRole('group', { name: /Comment 1/ })).toBeNull();
    input.remove();
    key({ key: 'c' });
    const bubble = await screen.findByRole('group', { name: /Comment 1/ });
    // The topmost clip with a picture at 1 s: the logo track is above the text one, and audio is never on top.
    await userEvent.type(within(bubble).getByRole('textbox'), 'ok');
    await userEvent.click(within(bubble).getByRole('button', { name: 'Comment' }));
    expect(pending()[0]!.pin).toMatchObject({ clipId: 'logo1', timeSec: 1 });
  });

  it('Shift + drag on the transport makes a range comment with a span; a plain drag only seeks', async () => {
    render(<Page kind="format" />);
    await ready();
    const scrub = document.querySelector('.ms-fv-scrub') as HTMLElement;
    stubRect(scrub);
    fireEvent.pointerDown(scrub, { clientX: 100, pointerId: 1, button: 0, shiftKey: true });
    fireEvent.pointerMove(scrub, { clientX: 350, pointerId: 1, shiftKey: true });
    expect(document.querySelector('.ms-fv-span.ms-picking')).not.toBeNull();
    fireEvent.pointerUp(scrub, { clientX: 350, pointerId: 1, shiftKey: true });
    const bubble = await screen.findByRole('group', { name: /Comment 1/ });
    expect(within(bubble).getByText('Comment on 1.0–3.5 s')).toBeTruthy();
    await userEvent.type(within(bubble).getByRole('textbox'), 'ritmo');
    await userEvent.click(within(bubble).getByRole('button', { name: 'Comment' }));
    expect(pending()[0]!.pin).toMatchObject({ timeSec: 1, range: { start: 1, end: 3.5 }, note: 'ritmo' });
    const span = await screen.findByRole('img', { name: 'Comment on 1.0–3.5 s: ritmo' });
    expect(span.style.left).toBeTruthy();
    // The marker on the picture shows through the whole range.
    media.currentTime = 3;
    media.emit('timeupdate');
    await waitFor(() => expect(document.querySelector('.ms-cv-pin')).not.toBeNull());
  });
});
