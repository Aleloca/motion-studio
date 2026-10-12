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
};
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { CompositionPlayer, CompositionMedia, READY_TIMEOUT_MS } = await import('../src/components/CompositionPlayer.tsx');
const { usePreviewSession, useStoryboard, REFRESH_BEFORE_MS } = await import('../src/components/compositionPreview.ts');
const { I18nProvider } = await import('../src/i18n.tsx');

const ORIGIN = 'http://127.0.0.1:61234';
const session = (token = 'tok1', over: Partial<PreviewSessionInfo> = {}): PreviewSessionInfo => ({
  url: `${ORIGIN}/${token}/runtime/index.html?mode=preview&parentOrigin=${encodeURIComponent('http://localhost:3000')}`,
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

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

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
  it('a new session remounts the frame (never a new src on the same frame) and keeps the media and its time', () => {
    const p = mount();
    const m = p.media();
    fromRuntime(READY);
    fromRuntime({ type: 'time', t: 5, playing: false });
    const first = frame();
    p.rerender(<I18nProvider locale="en"><CompositionPlayer session={session('tok2')} title="Reel v2" onMedia={() => {}} /></I18nProvider>);
    const second = frame();
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expect(second.getAttribute('src')).toContain('/tok2/');
    const posted = vi.spyOn(second.contentWindow!, 'postMessage');
    // The old frame's messages no longer count.
    const stale = new MessageEvent('message', { data: { type: 'time', t: 1, playing: false }, origin: 'null' });
    Object.defineProperty(stale, 'source', { value: null });
    act(() => { window.dispatchEvent(stale); });
    fromRuntime(READY);
    expect(m.currentTime).toBe(5);
    expect(posted.mock.calls.map((c) => c[0])).toEqual([{ type: 'seek', t: 5 }]);
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
