import { describe, expect, it } from 'vitest';
import { exportFileName } from '../src/exportName.ts';

// The same cases as the core's export naming (packages/core/src/creatives/export.ts, Task 8).
describe('exportFileName', () => {
  const name = (title: string, format = 'instagram-reel-9x16', file = 'reel.mp4', n = 3) => exportFileName({ title, creative: '2026-10-08-lancio', format, n, file });

  it('uses the slug of the title, the format and the version', () => {
    expect(name('Lancio estivo')).toBe('lancio-estivo-instagram-reel-9x16-v3.mp4');
  });
  it('cuts the title slug to 40 characters without a trailing dash', () => {
    const title = 'Promuovere il caso della settimana con un video breve e chiaro';
    const out = name(title);
    const base = out.replace('-instagram-reel-9x16-v3.mp4', '');
    expect(base.length).toBeLessThanOrEqual(40);
    expect(base.endsWith('-')).toBe(false);
    expect(base).toBe('promuovere-il-caso-della-settimana-con-u');
  });
  it('folds accents and falls back to the creative slug when the title has no letters or digits', () => {
    expect(name('Caffè è più buono')).toBe('caffe-e-piu-buono-instagram-reel-9x16-v3.mp4');
    expect(name('★★★')).toBe('2026-10-08-lancio-instagram-reel-9x16-v3.mp4');
  });
  it('lowercases the extension and keeps files without one', () => {
    expect(name('Post', 'instagram-post-1x1', 'cover.PNG', 1)).toBe('post-instagram-post-1x1-v1.png');
    expect(name('Post', 'instagram-post-1x1', 'cover', 1)).toBe('post-instagram-post-1x1-v1');
  });
});
