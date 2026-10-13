import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { AudioPlayer, VideoPlayer, clockText } from '../src/ui/index.ts';

if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  }
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventPolyfill, configurable: true });
}

// jsdom has no media pipeline: a tiny fake of play, pause, time and duration on the prototype.
type Fake = HTMLMediaElement & { __paused?: boolean; __time?: number; __duration?: number };
const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
const saved: Record<string, PropertyDescriptor | undefined> = {};
beforeEach(() => {
  for (const k of ['paused', 'currentTime', 'duration', 'play', 'pause']) saved[k] = Object.getOwnPropertyDescriptor(proto, k);
  Object.defineProperty(proto, 'paused', { configurable: true, get(this: Fake) { return this.__paused ?? true; } });
  Object.defineProperty(proto, 'currentTime', { configurable: true, get(this: Fake) { return this.__time ?? 0; }, set(this: Fake, v: number) { this.__time = v; } });
  Object.defineProperty(proto, 'duration', { configurable: true, get(this: Fake) { return this.__duration ?? NaN; } });
  Object.defineProperty(proto, 'play', { configurable: true, value(this: Fake) { this.__paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); } });
  Object.defineProperty(proto, 'pause', { configurable: true, value(this: Fake) { this.__paused = true; this.dispatchEvent(new Event('pause')); } });
});
afterEach(() => { for (const k of Object.keys(saved)) { if (saved[k]) Object.defineProperty(proto, k, saved[k]!); else delete proto[k]; } });

const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);
const mediaOf = (container: HTMLElement) => container.querySelector('audio, video') as Fake;
const loaded = (el: Fake, duration: number) => act(() => { el.__duration = duration; el.dispatchEvent(new Event('loadedmetadata')); });

describe('clockText', () => {
  it('is m:ss, with hours when needed', () => {
    expect([clockText(0), clockText(5.9), clockText(65), clockText(3725)]).toEqual(['0:00', '0:05', '1:05', '1:02:05']);
  });
});

describe('AudioPlayer', () => {
  it('has no native controls and plays and pauses from its own button', () => {
    const { container } = en(<AudioPlayer src="/a.mp3" name="a.mp3" durationSec={30} />);
    const el = mediaOf(container);
    expect(el.hasAttribute('controls')).toBe(false);
    expect(screen.getByRole('region', { name: 'Audio player: a.mp3' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(el.paused).toBe(false);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(el.paused).toBe(true);
  });

  it('shows the known duration at once and the real one after the metadata', () => {
    const { container } = en(<AudioPlayer src="/a.mp3" name="a.mp3" durationSec={30} />);
    expect(screen.getByText(/0:30/)).toBeTruthy();
    loaded(mediaOf(container), 45);
    expect(screen.getByText(/0:45/)).toBeTruthy();
  });

  it('scrubs from the keyboard: arrows 5 s, PageUp/Down 10 s, Home/End, Space plays', () => {
    const { container } = en(<AudioPlayer src="/a.mp3" name="a.mp3" durationSec={60} />);
    const el = mediaOf(container);
    loaded(el, 60);
    const bar = screen.getByRole('slider', { name: 'Position' });
    expect(bar.getAttribute('aria-valuemax')).toBe('60');
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(el.currentTime).toBe(5);
    fireEvent.keyDown(bar, { key: 'PageUp' });
    expect(el.currentTime).toBe(15);
    fireEvent.keyDown(bar, { key: 'ArrowLeft' });
    expect(el.currentTime).toBe(10);
    fireEvent.keyDown(bar, { key: 'End' });
    expect(el.currentTime).toBe(60);
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(el.currentTime).toBe(60);
    fireEvent.keyDown(bar, { key: 'Home' });
    expect(el.currentTime).toBe(0);
    fireEvent.keyDown(bar, { key: ' ' });
    expect(el.paused).toBe(false);
    expect(bar.getAttribute('aria-valuetext')).toBe('0:00 of 1:00');
  });

  it('scrubs with the pointer', () => {
    const { container } = en(<AudioPlayer src="/a.mp3" name="a.mp3" durationSec={100} />);
    const el = mediaOf(container);
    loaded(el, 100);
    const bar = screen.getByRole('slider', { name: 'Position' });
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 200, bottom: 20, width: 200, height: 20, x: 0, y: 0, toJSON() {} });
    fireEvent.pointerDown(bar, { clientX: 50, button: 0, pointerId: 1 });
    expect(el.currentTime).toBeCloseTo(25, 1);
    fireEvent.pointerMove(bar, { clientX: 150, pointerId: 1 });
    expect(el.currentTime).toBeCloseTo(75, 1);
    fireEvent.pointerUp(bar, { pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: 10, pointerId: 1 });
    expect(el.currentTime).toBeCloseTo(75, 1);
  });

  it('follows the playback time and draws the waveform behind the bar', () => {
    const peaks = Array.from({ length: 40 }, (_, i) => (i % 10) / 10);
    const { container } = en(<AudioPlayer src="/a.mp3" name="a.mp3" durationSec={10} peaks={peaks} />);
    const el = mediaOf(container);
    loaded(el, 10);
    expect(container.querySelectorAll('.ms-player-wave').length).toBe(2);
    expect(container.querySelectorAll('.ms-player-wave')[0]!.querySelectorAll('rect')).toHaveLength(40);
    act(() => { el.__time = 4; el.dispatchEvent(new Event('timeupdate')); });
    expect(screen.getByRole('slider', { name: 'Position' }).getAttribute('aria-valuenow')).toBe('4');
    expect((container.querySelector('.ms-player-played') as HTMLElement).style.clipPath).toBe('inset(0 60% 0 0)');
  });

  it('says so when the file cannot be played, and disables the controls', () => {
    const { container } = en(<AudioPlayer src="/a.mp3" name="a.mp3" />);
    act(() => { mediaOf(container).dispatchEvent(new Event('error')); });
    expect(screen.getByText('This file can’t be played here')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Play' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('VideoPlayer', () => {
  it('has no native controls; the picture and the button both play and pause', () => {
    const { container } = en(<VideoPlayer src="/v.mp4" name="v.mp4" durationSec={12} />);
    const el = mediaOf(container);
    expect(el.tagName).toBe('VIDEO');
    expect(el.hasAttribute('controls')).toBe(false);
    fireEvent.click(el);
    expect(el.paused).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(el.paused).toBe(true);
    loaded(el, 12);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Position' }), { key: 'ArrowRight' });
    expect(el.currentTime).toBe(5);
  });
});
