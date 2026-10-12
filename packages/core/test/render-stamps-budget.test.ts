import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { reconcileRenders, renderStampPath } from '../src/creatives/render-stamps.ts';
import { sweepProjectRenders } from '../src/render/render-sweep.ts';

// Final wave C10: reconcile has a time/bytes budget; the stamps' atomic-write temps are swept.
let base = '';
afterEach(() => { if (base) rmSync(base, { recursive: true, force: true }); base = ''; });
const brief = { goal: 'g', message: '', formats: ['instagram-post-1x1'], durationSec: 3, assets: [], notes: '' };

async function setup() {
  base = mkdtempSync(join(tmpdir(), 'ms-test-stamps-'));
  const store = new CreativeStore(base);
  const { slug } = await store.create({ title: 'uno', brief });
  const vdir = store.outputsDir(slug, 1);
  mkdirSync(vdir, { recursive: true });
  writeFileSync(join(vdir, 'f.mp4'), 'real bytes');
  const hash = 'c'.repeat(64);
  await store.appendVersion(slug, {
    n: 1, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', problems: [], tools: [], renderCommand: null, basedOn: null,
    compositions: [{ format: 'f', dir: 'compositions/f', hash, problems: [] }],
    outputs: [{ format: 'f', file: 'f.mp4', width: 1, height: 1, durationSec: 1, verified: false, preview: null, sha256: 'a'.repeat(64), problems: [], fromComposition: hash }],
  } as never);
  return { store, slug };
}

describe('reconcileRenders budget (C10)', () => {
  it('an unstamped render beyond the byte budget is left for the next call; within it, it is hashed and corrected', async () => {
    const { store, slug } = await setup();
    expect(await reconcileRenders({ projectDir: base, store, creativeSlug: slug, budget: { bytes: 3 } })).toBe(false);
    expect(existsSync(renderStampPath(base, slug, 1))).toBe(false);
    expect(await reconcileRenders({ projectDir: base, store, creativeSlug: slug })).toBe(true);
    expect((await store.readVersions(slug))[0]!.outputs[0]!.sha256).not.toBe('a'.repeat(64));
  });
  it('a spent time budget skips hashing too', async () => {
    const { store, slug } = await setup();
    expect(await reconcileRenders({ projectDir: base, store, creativeSlug: slug, budget: { ms: -1 } })).toBe(false);
  });
});

describe('the sweep removes old render-stamp temps (C10)', () => {
  it('only the exact name, only when old', async () => {
    base = mkdtempSync(join(tmpdir(), 'ms-test-stamps-sweep-'));
    const dir = join(base, '.studio', 'cache', 'renders', 'uno');
    mkdirSync(dir, { recursive: true });
    const old = join(dir, 'v1.json.0123456789ab.tmp'), fresh = join(dir, 'v2.json.0123456789ab.tmp'), keep = join(dir, 'v1.json'), other = join(dir, 'x.tmp');
    for (const f of [old, fresh, keep, other]) writeFileSync(f, 'x');
    const t = new Date(Date.now() - 3600_000);
    for (const f of [old, keep, other]) utimesSync(f, t, t);
    await sweepProjectRenders(base);
    expect([old, fresh, keep, other].map((f) => existsSync(f))).toEqual([false, true, true, true]);
  });
});
