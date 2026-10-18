// Decision 1055: the View menu's zoom items go to the page first (the creative canvas zooms itself); the window zooms only
// when the page does not take them, or when the window does not show the app.
import { describe, expect, it, vi } from 'vitest';
import { applyWindowZoom, isZoomKind, nextZoomLevel, registerZoomWindow, sendZoom, ZOOM_MENU, ZOOM_WINDOW } from '../src/zoom.ts';

describe('zoom from the View menu', () => {
  it('reads only the three kinds', () => {
    expect(['in', 'out', 'reset'].every(isZoomKind)).toBe(true);
    expect([undefined, null, 'IN', 'fit', 1, {}].some(isZoomKind)).toBe(false);
  });
  it('steps the window zoom level as the Electron roles did (±0.5, reset to 0), within limits', () => {
    expect(nextZoomLevel(0, 'in')).toBe(0.5);
    expect(nextZoomLevel(0.5, 'out')).toBe(0);
    expect(nextZoomLevel(2.5, 'reset')).toBe(0);
    expect(nextZoomLevel(9, 'in')).toBe(9);
    expect(nextZoomLevel(-8, 'out')).toBe(-8);
  });
  it('applies it to a window', () => {
    let level = 1;
    const wc = { isDestroyed: () => false, getZoomLevel: () => level, setZoomLevel: vi.fn((l: number) => { level = l; }) };
    applyWindowZoom(wc, 'in');
    expect(level).toBe(1.5);
    applyWindowZoom(wc, 'reset');
    expect(level).toBe(0);
    applyWindowZoom({ ...wc, isDestroyed: () => true }, 'in');
    expect(level).toBe(0);
  });
  it('sends the kind to the page only while it shows the app; nothing else goes with it', () => {
    const send = vi.fn();
    const wc = (url: string, destroyed = false) => ({ isDestroyed: () => destroyed, getURL: () => url, send });
    const isApp = (u: string) => u.startsWith('http://127.0.0.1:4000/');
    expect(sendZoom(wc('http://127.0.0.1:4000/#/p'), 'in', isApp)).toBe(true);
    expect(send).toHaveBeenCalledWith(ZOOM_MENU, 'in');
    expect(sendZoom(wc('https://example.com/'), 'out', isApp)).toBe(false);
    expect(sendZoom(wc('http://127.0.0.1:4000/', true), 'out', isApp)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('the page asks the window zoom back for the rest of the app: only a trusted sender, only a valid kind', async () => {
    const handlers: Record<string, (e: unknown, arg: unknown) => unknown> = {};
    const apply = vi.fn();
    registerZoomWindow({ handle: (c, fn) => { handlers[c] = fn; } }, { trusted: (e) => e === 'app', apply });
    await handlers[ZOOM_WINDOW]!('app', 'out');
    expect(apply).toHaveBeenCalledWith('out');
    await handlers[ZOOM_WINDOW]!('frame', 'in');
    await handlers[ZOOM_WINDOW]!('app', 'huge');
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
