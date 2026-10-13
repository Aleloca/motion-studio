import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { DEFAULT_FORMATS, validateComposition, type Clip, type Composition } from '../src/index.ts';

export const spike = JSON.parse(readFileSync(new URL('./fixtures/spike-composition.json', import.meta.url), 'utf8')) as Composition;
export const REEL = DEFAULT_FORMATS.find((f) => f.id === 'instagram-reel-9x16')!;
export const FILE_LIST = ['composition.json', 'assets/bg.mp4', 'assets/photo.jpg', 'assets/spikefont.ttf', 'assets/logo.svg', 'assets/music.wav', 'assets/voice.wav', 'assets/sfx.wav',
  'assets/other.jpg', 'assets/other.mp4', 'assets/other.ttf', 'layers/outro.html'];
export const FILES: ReadonlySet<string> = new Set(FILE_LIST);
export const fileMap = () => new Map(FILE_LIST.map((f) => [f, { size: 1000 }]));

export const copy = <T,>(v: T): T => structuredClone(v);
export const mutate = (fn: (c: Composition) => void): Composition => { const c = copy(spike); fn(c); return c; };
export const clipOf = (c: Composition, id: string): Clip => {
  for (const t of c.tracks) for (const k of t.clips) if (k.id === id) return k;
  throw new Error(`no clip ${id}`);
};
/** Spike plus an html clip with one parameter of each type. */
export const withParams = (): Composition => mutate((c) => {
  const html = clipOf(c, 'outro-html') as Extract<Clip, { type: 'html' }>;
  html.params = {
    headline: { type: 'text', value: 'Hello' }, tint: { type: 'color', value: '#ff0000' },
    speed: { type: 'number', value: 2 }, logo: { type: 'image', value: 'assets/photo.jpg' },
  };
});
/** Spike without the clips that span several scenes (the background video and the logo): scenes can be reordered. */
export const reorderable = (): Composition => mutate((c) => { c.tracks = c.tracks.filter((t) => t.id !== 'bg' && t.id !== 'logo'); });

export function expectValid(c: Composition, files = fileMap()): void {
  const r = validateComposition(c, { format: REEL, files });
  expect(r.problems).toEqual([]);
}
