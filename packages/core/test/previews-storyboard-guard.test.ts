// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadComposition } from '../src/compositions/composition-files.ts';
import { PreviewLane } from '../src/render/preview-lane.ts';
import { PreviewService } from '../src/creatives/previews.ts';

// Final wave C3: the storyboard cache is written through real folders only; a link planted under it steers nothing.
const PRESET = { id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 800 };
let base = '';
afterEach(() => { if (base) rmSync(base, { recursive: true, force: true }); base = ''; });

async function setup(o: { prepareMs?: number; laneMs?: number } = {}) {
  base = mkdtempSync(join(tmpdir(), 'ms-test-storyboard-guard-'));
  const projectDir = join(base, 'acme');
  const creativeDir = join(projectDir, 'creatives', 'promo');
  const comp = join(creativeDir, 'outputs', 'v1', 'compositions', 'test-wide');
  mkdirSync(comp, { recursive: true });
  mkdirSync(join(projectDir, '.studio', 'cache'), { recursive: true });
  writeFileSync(join(comp, 'composition.json'), JSON.stringify({ $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: 2, background: '#000000', fonts: [], scenes: [{ id: 's1', start: 0, duration: 2 }], tracks: [] }));
  const loaded = await loadComposition(comp, PRESET as never);
  if (!loaded.ok) throw new Error('fixture composition invalid');
  const engine = {
    info: async () => ({ kind: 'system' }),
    frames: async (o: { times: number[] }) => ({ frames: o.times.map((t) => ({ t, data: Buffer.from('jpg'), width: 320, height: 180 })), errors: [] }),
  };
  const normalizer = { prepare: async () => { await new Promise((r) => setTimeout(r, o.prepareMs ?? 0)); return { warnings: [], release() {}, media: { clips: new Map() } }; } };
  const svc = new PreviewService({ engine: engine as never, normalizer: normalizer as never, presets: async () => [PRESET as never], uiOrigins: () => [], distDir: base, ...(o.laneMs ? { lane: new PreviewLane({ timeLimitMs: o.laneMs }) } : {}) });
  (svc as unknown as { compositionServer: () => Promise<unknown> }).compositionServer = async () => ({ origin: 'http://127.0.0.1:1' });
  return { svc, projectDir, creativeDir, hash: loaded.hash };
}

describe('makeStoryboard writes through real folders only (C3)', () => {
  it('writes the storyboard under a real cache chain', async () => {
    const { svc, projectDir, creativeDir, hash } = await setup();
    const sb = await svc.makeStoryboard({ projectDir, creativeDir, creativeSlug: 'promo', n: 1 }, 'test-wide', hash);
    expect(sb?.frames.length).toBeGreaterThan(0);
    expect(existsSync(join(projectDir, '.studio', 'cache', 'storyboards', 'promo', 'v1', 'test-wide', 'storyboard.json'))).toBe(true);
    await svc.close();
  });
  it('a link planted in the cache chain writes nothing through it', async () => {
    const { svc, projectDir, creativeDir, hash } = await setup();
    const outside = join(base, 'outside');
    mkdirSync(outside);
    mkdirSync(join(projectDir, '.studio', 'cache', 'storyboards'), { recursive: true });
    symlinkSync(outside, join(projectDir, '.studio', 'cache', 'storyboards', 'promo'));
    await expect(svc.makeStoryboard({ projectDir, creativeDir, creativeSlug: 'promo', n: 1 }, 'test-wide', hash)).resolves.toBeNull();
    expect(readdirSync(outside)).toEqual([]);
    await svc.close();
  });
});

describe('the preview lane limit does not include media normalisation (C5)', () => {
  it('a preparation longer than the lane time limit still gives frames', async () => {
    const { svc, projectDir, creativeDir, hash } = await setup({ prepareMs: 400, laneMs: 150 });
    const sb = await svc.makeStoryboard({ projectDir, creativeDir, creativeSlug: 'promo', n: 1 }, 'test-wide', hash);
    expect(sb?.frames.length).toBeGreaterThan(0);
    await svc.close();
  });
});

describe('start/close origin race (C12)', () => {
  it('a server that finishes starting after close() is closed and its origin never announced; no server starts after close', async () => {
    const origins: Array<string | null> = [];
    base = mkdtempSync(join(tmpdir(), 'ms-test-origin-race-'));
    const svc = new PreviewService({ engine: undefined, normalizer: {} as never, presets: async () => [], uiOrigins: () => [], distDir: base, onServerOrigin: (o) => { origins.push(o); } });
    const starting = svc.compositionServer().catch(() => null);
    await svc.close();
    expect(await starting).toBeNull();
    await expect(svc.compositionServer()).rejects.toThrow('closed');
    expect(origins.filter((o) => o !== null)).toEqual([]);
    expect(origins.at(-1)).toBeNull();
  });
});
