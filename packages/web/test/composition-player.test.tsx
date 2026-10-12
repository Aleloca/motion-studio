import { act, render, renderHook, screen } from '@testing-library/react';
import type { PreviewSessionInfo, StoryboardView } from '@motion-studio/shared';
import { parseIncoming } from '@motion-studio/composition-runtime/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The live player (Task 8): an iframe on the composition server's origin, `sandbox="allow-scripts"` only, driven by
// validated postMessage; plus its session and storyboard hooks (legacy 404, busy 429 with backoff, refresh before expiry).

class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public retryAfterSec?: number) { super(message); }
}
const api = {
  previewSession: vi.fn(),
  getStoryboard: vi.fn(),
  revokePreview: vi.fn(async (..._a: unknown[]) => ({ revoked: true })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { CompositionPlayer, CompositionMedia, READY_TIMEOUT_MS } = await import('../src/components/CompositionPlayer.tsx');
const { usePreviewSession, useStoryboard, REFRESH_BEFORE_MS, RELEASE_GRACE_MS, MAX_REFRESH_RETRIES, __resetPreviewSessions } = await import('../src/components/compositionPreview.ts');
const { I18nProvider } = await import('../src/i18n.tsx');

const ORIGIN = 'http://127.0.0.1:61234';
const session = (token = 'tok1', over: Partial<PreviewSessionInfo> = {}): PreviewSessionInfo => ({
  url: `${ORIGIN}/${token}/runtime/index.html?mode=preview&parentOrigin=${encodeURIComponent('http://localhost:3000')}`, token,
  origin: ORIGIN, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  format: 'tiktok-9x16', hash: 'a'.repeat(64), width: 1080, height: 1920, duration: 8, fps: 30, ...over,
});
const READY = { type: 'ready', version: 1, duration: 8, fps: 30, width: 1080, height: 1920, scenes: [{ id: 's1', start: 0, duration: 4 }], errors: [] };

function frame(): HTMLIFrameElement {
  return document.querySelector('iframe')!;
}
/** A message as the browser delivers it from the sandboxed frame: opaque origin "null", source = its window. */
function fromRuntime(data: unknown, o: { origin?: string; source?: unknown } = {}) {
  const ev = new MessageEvent('message', { data, origin: o.origin ?? 'null' });
  Object.defineProperty(ev, 'source', { value: o.source === undefined ? frame().contentWindow : o.source });
  act(() => { window.dispatchEvent(ev); });
}
function mount(over: Partial<Parameters<typeof CompositionPlayer>[0]> = {}) {
  let media: InstanceType<typeof CompositionMedia> | null = null;
  const onStall = vi.fn();
  const r = render(
    <I18nProvider locale="en">
      <CompositionPlayer session={session()} title="Reel v2" onMedia={(m) => { media = m; }} onStall={onStall} {...over} />
    </I18nProvider>,
  );
  const posted = vi.spyOn(frame().contentWindow!, 'postMessage');
  return { ...r, media: () => media!, posted, onStall };
}

afterEach(() => { __resetPreviewSessions(); vi.useRealTimers(); vi.clearAllMocks(); api.previewSession.mockReset(); api.getStoryboard.mockReset(); });

describe('CompositionPlayer', () => {
  it('is a sandboxed frame on the composition server: allow-scripts only, no referrer', () => {
    mount();
    const f = frame();
    expect(f.getAttribute('src')).toBe(session().url);
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(f.getAttribute('title')).toBe('Reel v2');
  });
  it('refuses a session whose URL is not on its own origin (no frame at all)', () => {
    render(<I18nProvider locale="en"><CompositionPlayer session={session('t', { origin: 'http://127.0.0.1:1' })} title="x" /></I18nProvider>);
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
  it('accepts messages only from its own frame, as the opaque origin or the server origin', () => {
    const p = mount();
    const m = p.media();
    // Not its frame: the top window, another window.
    fromRuntime(READY, { source: window });
    fromRuntime(READY, { source: null });
    // Its frame, but a foreign origin.
    fromRuntime(READY, { origin: 'http://evil.example' });
    fromRuntime(READY, { origin: 'http://127.0.0.1:4317' });
    expect(Number.isNaN(m.duration)).toBe(true);
    // Malformed.
    fromRuntime({ ...READY, version: 2 });
    fromRuntime({ type: 'time', t: 'x', playing: false });
    expect(Number.isNaN(m.duration)).toBe(true);
    fromRuntime(READY);
    expect(m.duration).toBe(8);
    fromRuntime({ type: 'time', t: 2.5, playing: false });
    expect(m.currentTime).toBe(2.5);
  });
  it('posts only valid commands, to the frame alone', () => {
    const p = mount();
    const m = p.media();
    fromRuntime(READY);
    p.posted.mockClear();
    m.playbackRate = 9; // clamped to the runtime's range
    void m.play();
    m.currentTime = 3;
    m.pause();
    m.currentTime = -2;
    m.currentTime = Number.NaN;
    const sent = p.posted.mock.calls.map((c) => c[0]);
    expect(sent).toEqual([
      { type: 'play', loop: false, rate: 4 },
      { type: 'seek', t: 3 }, { type: 'play', loop: false, rate: 4 },
      { type: 'pause' },
      { type: 'seek', t: 0 },
    ]);
    for (const c of p.posted.mock.calls) {
      expect(parseIncoming(c[0])).toEqual(c[0]);
      // The frame's origin is opaque: '*' is the only target that reaches it (the commands carry no secrets).
      expect(c[1]).toBe('*');
    }
  });
  it('waits for ready before sending anything, then restores the time it had', () => {
    const p = mount();
    const m = p.media();
    m.currentTime = 2;
    void m.play();
    expect(p.posted).not.toHaveBeenCalled();
    fromRuntime(READY);
    expect(p.posted.mock.calls.map((c) => c[0])).toEqual([{ type: 'seek', t: 2 }, { type: 'play', loop: false, rate: 1 }]);
  });
  it('behaves as a media element: events, paused, ended at the end', () => {
    const p = mount();
    const m = p.media();
    const seen: string[] = [];
    for (const type of ['loadedmetadata', 'timeupdate', 'play', 'pause', 'ended']) m.addEventListener(type, () => seen.push(type));
    fromRuntime(READY);
    void m.play();
    expect(m.paused).toBe(false);
    fromRuntime({ type: 'time', t: 4, playing: true });
    fromRuntime({ type: 'time', t: 8, playing: false });
    expect(m.paused).toBe(true);
    expect(seen).toEqual(['loadedmetadata', 'play', 'timeupdate', 'timeupdate', 'pause', 'ended']);
  });
  it('muted: sent as a mute command once ready, and again to a new frame', () => {
    const p = mount({ muted: true });
    expect(p.posted).not.toHaveBeenCalled();
    fromRuntime(READY);
    expect(p.posted.mock.calls.map((c) => c[0])).toEqual([{ type: 'mute', muted: true }]);
    expect(p.media().muted).toBe(true);
    p.media().muted = false;
    expect(p.posted).toHaveBeenLastCalledWith({ type: 'mute', muted: false }, '*');
  });
  it('shows the runtime errors inline', () => {
    mount();
    fromRuntime({ ...READY, errors: [{ code: 'fontMissing', message: 'Inter', clipId: 'title' }] });
    fromRuntime({ type: 'error', error: { code: 'assetLoadFailed', message: 'assets/a.png' } });
    const list = screen.getByRole('status', { name: 'Preview problems' });
    expect(list.textContent).toContain('A font is missing (title)');
    expect(list.textContent).toContain('A file could not be loaded');
  });
  it('a fatal error before ready fails the media', () => {
    const p = mount();
    const m = p.media();
    const failed = vi.fn();
    m.addEventListener('error', failed);
    fromRuntime({ type: 'error', error: { code: 'compositionInvalid', message: 'x' } });
    expect(failed).toHaveBeenCalled();
    expect(m.error).toBeTruthy();
  });
  it('no ready in time: tells the caller (a new session is minted)', () => {
    vi.useFakeTimers();
    const p = mount();
    act(() => { vi.advanceTimersByTime(READY_TIMEOUT_MS - 1); });
    expect(p.onStall).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2); });
    expect(p.onStall).toHaveBeenCalledTimes(1);
  });
  it('a new session mounts a new frame below the one shown; it takes over only once ready, keeping the media and its time (A5)', () => {
    const p = mount();
    const m = p.media();
    fromRuntime(READY);
    fromRuntime({ type: 'time', t: 5, playing: false });
    const first = frame();
    p.rerender(<I18nProvider locale="en"><CompositionPlayer session={session('tok2')} title="Reel v2" onMedia={() => {}} /></I18nProvider>);
    const [old, second] = [...document.querySelectorAll('iframe')];
    expect(old).toBe(first);
    expect(second!.getAttribute('src')).toContain('/tok2/');
    expect(second!.className).toContain('ms-next');
    const posted = vi.spyOn(second!.contentWindow!, 'postMessage');
    // Until the new frame is ready, the old one is still the media's: its time counts, the new one's does not.
    fromRuntime({ type: 'time', t: 5.5, playing: false }, { source: first.contentWindow });
    expect(m.currentTime).toBe(5.5);
    fromRuntime({ type: 'time', t: 1, playing: false }, { source: second!.contentWindow });
    expect(m.currentTime).toBe(5.5);
    fromRuntime(READY, { source: second!.contentWindow });
    expect(first.isConnected).toBe(false);
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
    expect(m.currentTime).toBe(5.5);
    expect(posted.mock.calls.map((c) => c[0])).toEqual([{ type: 'seek', t: 5.5 }]);
  });
  it('a renewal while playing never stops the playback: the old frame plays until the new one is ready, then seek and play (D1)', () => {
    const p = mount();
    const m = p.media();
    m.loop = true;
    fromRuntime(READY);
    void m.play();
    fromRuntime({ type: 'time', t: 7.99, playing: true });
    const first = frame();
    const oldPosted = vi.spyOn(first.contentWindow!, 'postMessage');
    p.rerender(<I18nProvider locale="en"><CompositionPlayer session={session('tok2')} title="Reel v2" onMedia={() => {}} /></I18nProvider>);
    const second = document.querySelectorAll('iframe')[1]!;
    const posted = vi.spyOn(second.contentWindow!, 'postMessage');
    fromRuntime(READY, { source: second.contentWindow });
    expect(posted.mock.calls.map((c) => c[0])).toEqual([{ type: 'seek', t: 7.99 }, { type: 'play', loop: true, rate: 1 }]);
    // The old frame is told to stop (it is being removed).
    expect(oldPosted).toHaveBeenLastCalledWith({ type: 'pause' }, '*');
    // The restoring seek ends at the very end of the loop before the runtime reports playing again: not the end.
    fromRuntime({ type: 'time', t: 7.99, playing: false }, { source: second.contentWindow });
    expect(m.paused).toBe(false);
    fromRuntime({ type: 'time', t: 0.1, playing: true }, { source: second.contentWindow });
    expect(m.paused).toBe(false);
    expect(m.currentTime).toBe(0.1);
  });
  it('a new frame that never gets ready leaves the shown one playing, and is reported stalled (A5)', () => {
    vi.useFakeTimers();
    const p = mount();
    const m = p.media();
    fromRuntime(READY);
    void m.play();
    p.rerender(<I18nProvider locale="en"><CompositionPlayer session={session('tok2')} title="Reel v2" onMedia={() => {}} onStall={p.onStall} /></I18nProvider>);
    act(() => { vi.advanceTimersByTime(READY_TIMEOUT_MS + 1); });
    expect(p.onStall).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('iframe')).toHaveLength(2);
    expect(m.paused).toBe(false);
    fromRuntime({ type: 'time', t: 3, playing: true });
    expect(m.currentTime).toBe(3);
  });
});

describe('usePreviewSession', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  const hook = (enabled = true) => renderHook(({ on }) => usePreviewSession({ slug: 'acme', creative: 'launch', n: 2, format: 'tiktok-9x16', enabled: on }), { initialProps: { on: enabled } });
  const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };

  it('mints nothing until enabled (a board starts it on hover or click)', async () => {
    const h = hook(false);
    await flush();
    expect(api.previewSession).not.toHaveBeenCalled();
    expect(h.result.current.state.kind).toBe('idle');
    api.previewSession.mockResolvedValueOnce(session());
    h.rerender({ on: true });
    await flush();
    expect(api.previewSession).toHaveBeenCalledWith('acme', 'launch', 2, 'tiktok-9x16', window.location.origin);
    expect(h.result.current.state).toMatchObject({ kind: 'ready', session: { origin: ORIGIN } });
  });
  it('a legacy version (404) shows its media, not an error', async () => {
    api.previewSession.mockRejectedValueOnce(new ApiError(404, 'no composition', 'composition-not-found'));
    const h = hook();
    await flush();
    expect(h.result.current.state.kind).toBe('legacy');
  });
  it('busy (429): a calm state, then tries again with a backoff', async () => {
    api.previewSession.mockRejectedValueOnce(new ApiError(429, 'busy', 'preview-busy')).mockRejectedValueOnce(new ApiError(429, 'busy', 'preview-busy')).mockResolvedValueOnce(session());
    const h = hook();
    await flush();
    expect(h.result.current.state.kind).toBe('busy');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(api.previewSession).toHaveBeenCalledTimes(2);
    expect(h.result.current.state.kind).toBe('busy');
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(api.previewSession).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(h.result.current.state.kind).toBe('ready');
  });
  it('a stalled frame mints again (the composition server moved)', async () => {
    api.previewSession.mockResolvedValueOnce(session('a')).mockResolvedValueOnce(session('b'));
    const h = hook();
    await flush();
    act(() => { h.result.current.stalled(); });
    expect(h.result.current.state.kind).toBe('busy');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(h.result.current.state).toMatchObject({ kind: 'ready', session: { url: expect.stringContaining('/b/') } });
  });
  it('renews the session before it expires', async () => {
    api.previewSession.mockResolvedValueOnce(session('a', { expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() })).mockResolvedValueOnce(session('b'));
    const h = hook();
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000 - REFRESH_BEFORE_MS - 10); });
    expect(api.previewSession).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(api.previewSession).toHaveBeenCalledTimes(2);
    expect(h.result.current.state).toMatchObject({ kind: 'ready', session: { url: expect.stringContaining('/b/') } });
  });
  it('other refusals are an error with their message', async () => {
    api.previewSession.mockRejectedValueOnce(new ApiError(409, 'The composition changed'));
    const h = hook();
    await flush();
    expect(h.result.current.state).toEqual({ kind: 'failed', message: 'The composition changed' });
  });
});

describe('preview sessions are shared and released (fix round 1, I2)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
  const use = (n: number, format = 'tiktok-9x16', on = true) => renderHook(({ e }) => usePreviewSession({ slug: 'acme', creative: 'launch', n, format, enabled: e }), { initialProps: { e: on } });
  let minted = 0;
  beforeEach(() => { minted = 0; api.previewSession.mockImplementation(async () => session(`t${++minted}`)); });

  it('one session per version and format, shared by every player of it', async () => {
    const a = use(2);
    const b = use(2);
    await flush();
    expect(api.previewSession).toHaveBeenCalledTimes(1);
    expect(a.result.current.state).toMatchObject({ kind: 'ready', session: { token: 't1' } });
    expect(b.result.current.state).toMatchObject({ kind: 'ready', session: { token: 't1' } });
  });

  it('a hover that ends lets the session go: ended on the core after the grace, reused if the pointer comes back first', async () => {
    const h = use(2);
    await flush();
    h.rerender({ e: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS - 100); });
    h.rerender({ e: true });
    await flush();
    expect(api.previewSession).toHaveBeenCalledTimes(1);
    expect(api.revokePreview).not.toHaveBeenCalled();
    h.rerender({ e: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS + 10); });
    expect(api.revokePreview).toHaveBeenCalledWith('acme', 'launch', 2, 't1');
    h.unmount();
  });

  it('a new session ends the unused ones at once, never one still in use (a pinned or playing player)', async () => {
    const pinned = use(1, 'instagram-post-1x1');
    await flush();
    const hover = use(2);
    await flush();
    hover.rerender({ e: false });
    // The pointer moves on to a third board: the idle hover session goes now, the pinned one stays.
    const next = use(3);
    await flush();
    expect(api.revokePreview.mock.calls.map((c) => c[3])).toEqual(['t2']);
    expect(pinned.result.current.state).toMatchObject({ kind: 'ready', session: { token: 't1' } });
    expect(next.result.current.state).toMatchObject({ kind: 'ready', session: { token: 't3' } });
    // Unmounting the last user of a session ends it after the grace.
    pinned.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS + 10); });
    expect(api.revokePreview.mock.calls.map((c) => c[3])).toEqual(['t2', 't1']);
  });

  it('a stalled player never ends the session another player shows (A5, T8 drop)', async () => {
    const view = use(2);
    const hover = use(2);
    await flush();
    act(() => { view.result.current.showing('t1'); });
    // The hover's frame of t1 stalls: t1 is not handed out again, but the format view still shows it.
    act(() => { hover.result.current.stalled(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(api.revokePreview).not.toHaveBeenCalled();
    expect(hover.result.current.state).toMatchObject({ kind: 'ready', session: { token: 't2' } });
    // Once the view moves to the new session's frame, t1 is ended.
    act(() => { view.result.current.showing('t2'); });
    await flush();
    expect(api.revokePreview.mock.calls.map((c) => c[3])).toEqual(['t1']);
  });

  it('a stall while a frame is shown keeps the state ready (the shown frame plays on) and mints quietly', async () => {
    const h = use(2);
    await flush();
    act(() => { h.result.current.showing('t1'); });
    act(() => { h.result.current.stalled(); });
    expect(h.result.current.state).toMatchObject({ kind: 'ready', session: { token: 't1' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(h.result.current.state).toMatchObject({ kind: 'ready', session: { token: 't2' } });
    expect(api.revokePreview).not.toHaveBeenCalled();
    act(() => { h.result.current.showing('t2'); });
    await flush();
    expect(api.revokePreview.mock.calls.map((c) => c[3])).toEqual(['t1']);
  });

  it('a renewal ends the old session only once the player shows the new one (D1)', async () => {
    api.previewSession.mockReset();
    api.previewSession.mockResolvedValueOnce(session('a', { expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() })).mockResolvedValueOnce(session('b'));
    const h = use(2);
    await flush();
    act(() => { h.result.current.showing('a'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000 - REFRESH_BEFORE_MS + 10); });
    expect(h.result.current.state).toMatchObject({ kind: 'ready', session: { token: 'b' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS * 4); });
    expect(api.revokePreview).not.toHaveBeenCalled();
    act(() => { h.result.current.showing('b'); });
    await flush();
    expect(api.revokePreview.mock.calls.map((c) => c[3])).toEqual(['a']);
  });

  it('retry() mints again at once; a new key starts fresh (no leftover backoff)', async () => {
    api.previewSession.mockReset();
    api.previewSession.mockRejectedValueOnce(new ApiError(500, 'boom')).mockResolvedValueOnce(session('ok'));
    const h = renderHook(({ n }) => usePreviewSession({ slug: 'acme', creative: 'launch', n, format: 'tiktok-9x16', enabled: true }), { initialProps: { n: 2 } });
    await flush();
    expect(h.result.current.state.kind).toBe('failed');
    act(() => { h.result.current.retry(); });
    await flush();
    expect(h.result.current.state).toMatchObject({ kind: 'ready', session: { token: 'ok' } });
    // A stall, then another version: its first session comes without waiting a backoff.
    api.previewSession.mockResolvedValueOnce(session('v3'));
    act(() => { h.result.current.stalled(); });
    expect(h.result.current.state.kind).toBe('busy');
    h.rerender({ n: 3 });
    await flush();
    expect(h.result.current.state).toMatchObject({ kind: 'ready', session: { token: 'v3' } });
  });
});

describe('useStoryboard', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  const board = (exp: number): StoryboardView => ({
    format: 'tiktok-9x16', hash: 'a'.repeat(64), width: 270, expiresAt: new Date(Date.now() + exp).toISOString(),
    frames: [{ t: 1, kind: 'poster', width: 270, height: 480, url: `/sb/f-0.jpg?s=${exp}` }],
  });
  const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };

  it('refetches the signed URLs before they expire (pages left open for long)', async () => {
    api.getStoryboard.mockResolvedValueOnce(board(10 * 60_000)).mockResolvedValueOnce(board(20 * 60_000));
    const h = renderHook(() => useStoryboard({ slug: 'acme', creative: 'launch', n: 2, format: 'tiktok-9x16', hash: 'h', enabled: true }));
    await flush();
    expect(h.result.current.storyboard?.frames[0]!.url).toBe('/sb/f-0.jpg?s=600000');
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000 - REFRESH_BEFORE_MS + 10); });
    expect(api.getStoryboard).toHaveBeenCalledTimes(2);
    expect(h.result.current.storyboard?.frames[0]!.url).toBe('/sb/f-0.jpg?s=1200000');
  });
  it('busy (429): tries again later; unavailable (404): none', async () => {
    api.getStoryboard.mockRejectedValueOnce(new ApiError(429, 'busy', 'preview-busy')).mockResolvedValueOnce(board(600_000));
    const h = renderHook(() => useStoryboard({ slug: 'acme', creative: 'launch', n: 2, format: 'tiktok-9x16', hash: 'h', enabled: true }));
    await flush();
    expect(h.result.current.state).toBe('busy');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(h.result.current.state).toBe('ready');
    api.getStoryboard.mockRejectedValueOnce(new ApiError(404, 'no', 'storyboard-unavailable'));
    const g = renderHook(() => useStoryboard({ slug: 'acme', creative: 'launch', n: 3, format: 'tiktok-9x16', hash: 'h', enabled: true }));
    await flush();
    expect(g.result.current.state).toBe('none');
    expect(g.result.current.storyboard).toBeNull();
  });
});

describe('useStoryboard (fix round 1)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
  const sb = (exp: number): StoryboardView => ({ format: 'f', hash: 'h', width: 270, expiresAt: new Date(Date.now() + exp).toISOString(), frames: [{ t: 1, kind: 'poster', width: 1, height: 1, url: `/u?${exp}` }] });

  it('busy on the first load stays busy until it works (no flicker back to loading)', async () => {
    const busy = () => new ApiError(429, 'busy', 'preview-busy');
    api.getStoryboard.mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy()).mockResolvedValueOnce(sb(600_000));
    const seen: string[] = [];
    renderHook(() => { const r = useStoryboard({ slug: 'a', creative: 'c', n: 1, format: 'f', hash: 'h', enabled: true }); seen.push(r.state); return r; });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    const after = seen.slice(seen.indexOf('busy'));
    expect(after.includes('loading')).toBe(false);
    expect(seen.at(-1)).toBe('ready');
  });

  it('a refresh that keeps failing is bounded, then the expiring images are dropped', async () => {
    api.getStoryboard.mockResolvedValueOnce(sb(2 * 60_000)).mockRejectedValue(new Error('offline'));
    const h = renderHook(() => useStoryboard({ slug: 'a', creative: 'c', n: 1, format: 'f', hash: 'h', enabled: true }));
    await flush();
    expect(h.result.current.state).toBe('ready');
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(api.getStoryboard).toHaveBeenCalledTimes(2 + MAX_REFRESH_RETRIES);
    expect(h.result.current.state).toBe('none');
    expect(h.result.current.storyboard).toBeNull();
  });
});
