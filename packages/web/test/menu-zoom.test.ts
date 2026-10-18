// Decision 1055: the desktop View menu's zoom reaches the page. The creative canvas takes it while it is the page shown;
// anywhere else the window zooms as before (through the bridge). In a plain browser there is no bridge: nothing to install.
import { afterEach, describe, expect, it, vi } from 'vitest';
const { installMenuZoom, setMenuZoomHandler } = await import('../src/shell/menuZoom.ts');

type Kind = 'in' | 'out' | 'reset';
function bridge() {
  let listener: ((kind: Kind) => void) | null = null;
  const b = {
    isDesktop: true, platform: 'darwin', pickFolder: vi.fn(), revealPath: vi.fn(),
    onZoom: vi.fn((cb: (kind: Kind) => void) => { listener = cb; return () => { listener = null; }; }),
    zoomWindow: vi.fn(async () => {}),
  };
  (window as unknown as { motionStudio?: unknown }).motionStudio = b;
  return { b, menu: (kind: Kind) => listener?.(kind), subscribed: () => listener !== null };
}
afterEach(() => { delete (window as unknown as { motionStudio?: unknown }).motionStudio; });

describe('the View menu zoom', () => {
  it('zooms the window when no canvas takes it', () => {
    const { b, menu } = bridge();
    const off = installMenuZoom();
    menu('in');
    expect(b.zoomWindow).toHaveBeenCalledWith('in');
    off();
  });
  it('goes to the canvas while it is registered, and back to the window after', () => {
    const { b, menu, subscribed } = bridge();
    const off = installMenuZoom();
    const canvas = vi.fn();
    const release = setMenuZoomHandler(canvas);
    menu('reset');
    menu('out');
    expect(canvas.mock.calls.map((c) => c[0])).toEqual(['reset', 'out']);
    expect(b.zoomWindow).not.toHaveBeenCalled();
    release();
    menu('in');
    expect(b.zoomWindow).toHaveBeenCalledWith('in');
    off();
    expect(subscribed()).toBe(false);
  });
  it('a stale release never drops the newer handler', () => {
    const { menu } = bridge();
    const off = installMenuZoom();
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = setMenuZoomHandler(first);
    const releaseSecond = setMenuZoomHandler(second);
    releaseFirst();
    menu('in');
    expect(second).toHaveBeenCalledWith('in');
    expect(first).not.toHaveBeenCalled();
    releaseSecond(); off();
  });
  it('does nothing in a plain browser (no bridge) or with an older desktop build (no onZoom)', () => {
    expect(() => installMenuZoom()()).not.toThrow();
    (window as unknown as { motionStudio?: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: vi.fn(), revealPath: vi.fn() };
    expect(() => installMenuZoom()()).not.toThrow();
  });
});
