import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/api.ts', () => ({ api: { fileUrl: (s: string, c: string, r: string) => `/f/${s}/${c}/${r}` } }));
const { mediaKindOf, isVideoFile } = await import('../src/media.ts');
const { outputMedia } = await import('../src/screens/canvasModel.ts');

describe('mediaKindOf', () => {
  it('knows videos, animated images and images', () => {
    for (const f of ['a.mp4', 'b.MOV', 'c.webm', 'd.m4v', '/f/x/clip.mp4?v=2']) expect(mediaKindOf(f)).toBe('video');
    expect(mediaKindOf('loop.gif')).toBe('animated');
    expect(mediaKindOf('loop.GIF')).toBe('animated');
    for (const f of ['p.png', 'p.jpg', 'logo.svg', 'x.webp', 'noext']) expect(mediaKindOf(f)).toBe('image');
    expect(isVideoFile('loop.gif')).toBe(false);
  });

  it('a GIF output is shown as an image (no poster, no transport)', () => {
    const out = { format: 'f', file: 'loop.gif', width: 1, height: 1 } as never;
    expect(outputMedia('acme', 'c', 2, out)).toEqual({ src: '/f/acme/c/outputs/v2/loop.gif', video: false });
    const clip = { format: 'f', file: 'clip.mp4', width: 1, height: 1 } as never;
    expect(outputMedia('acme', 'c', 2, clip)).toEqual({ src: '/f/acme/c/outputs/v2/clip.mp4', video: true });
  });
});
