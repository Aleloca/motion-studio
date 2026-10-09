import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoverMedia, SafeImg } from '../src/components/MediaThumb.tsx';
import { I18nProvider } from '../src/i18n.tsx';
import { coverVideo } from '../src/media.ts';

const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);
const reduce = (on: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }));
let play: ReturnType<typeof vi.fn>;
beforeEach(() => {
  play = vi.fn(async () => {});
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: play });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: vi.fn() });
  reduce(false);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('coverVideo', () => {
  it('finds the video behind the core poster, and nothing for images or GIFs', () => {
    expect(coverVideo('outputs/v2/.previews/reel.mp4.jpg')).toBe('outputs/v2/reel.mp4');
    expect(coverVideo('outputs/v2/reel.webm')).toBe('outputs/v2/reel.webm');
    expect(coverVideo('outputs/v2/square.png')).toBeNull();
    expect(coverVideo('outputs/v2/.previews/still.png.jpg')).toBeNull();
    expect(coverVideo('outputs/v2/loop.gif')).toBeNull();
  });
});

describe('CoverMedia · hover playback (visual test point 31)', () => {
  const card = () => en(
    <a href="#/x" data-hover-play data-testid="card">
      <span><CoverMedia src="/f/poster.jpg" video="/f/reel.mp4" /></span>
    </a>,
  );

  it('plays the video muted and looping while the card is hovered, and stops on leave', () => {
    const { container } = card();
    expect(container.querySelector('video')).toBeNull();
    fireEvent.pointerEnter(screen.getByTestId('card'));
    const v = container.querySelector('video')!;
    expect(v.getAttribute('src')).toBe('/f/reel.mp4');
    expect(v.muted).toBe(true);
    expect(v.loop).toBe(true);
    expect(play).toHaveBeenCalled();
    fireEvent.pointerLeave(screen.getByTestId('card'));
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('img')!.getAttribute('src')).toBe('/f/poster.jpg');
  });

  it('plays on keyboard focus too', () => {
    const { container } = card();
    act(() => { screen.getByTestId('card').focus(); });
    expect(container.querySelector('video')).toBeTruthy();
  });

  it('never plays with reduced motion', () => {
    reduce(true);
    const { container } = card();
    fireEvent.pointerEnter(screen.getByTestId('card'));
    expect(container.querySelector('video')).toBeNull();
    expect(play).not.toHaveBeenCalled();
  });

  it('a cover without a video stays still', () => {
    const { container } = en(<div data-hover-play data-testid="c"><CoverMedia src="/f/square.png" video={null} /></div>);
    fireEvent.pointerEnter(screen.getByTestId('c'));
    expect(container.querySelector('video')).toBeNull();
  });
});

describe('SafeImg · can\'t preview', () => {
  it('shows the designed state instead of the broken-image glyph', () => {
    const { container } = en(<SafeImg src="/f/broken.png" alt="" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('img', { name: 'Can’t preview this file' })).toBeTruthy();
    expect(screen.getByText('Can’t preview this file')).toBeTruthy();
  });
});
