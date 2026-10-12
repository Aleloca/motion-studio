import { mkdir, mkdtemp, rm, symlink, utimes, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sweepDerivedCaches } from '../src/creatives/cache-sweep.ts';

const cleanup: string[] = [];
afterEach(async () => { for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true }); });
const DAY = 24 * 3600 * 1000;

async function project() {
  const p = await mkdtemp(join(tmpdir(), 'ms-test-cache-sweep-'));
  cleanup.push(p);
  return p;
}
/** A version folder of a cache with one file of `size` bytes whose mtime is `ageMs` ago. */
async function version(p: string, cache: string, creative: string, n: number, size: number, ageMs: number, now: number) {
  const dir = join(p, '.studio', 'cache', cache, creative, `v${n}`, 'fmt');
  await mkdir(dir, { recursive: true });
  const f = join(dir, 'f.jpg');
  await writeFile(f, Buffer.alloc(size, 1));
  const t = new Date(now - ageMs);
  await utimes(f, t, t); await utimes(dir, t, t); await utimes(join(dir, '..'), t, t);
  return join(p, '.studio', 'cache', cache, creative, `v${n}`);
}

describe('sweepDerivedCaches (C3, C11)', () => {
  it('removes version folders of every derived cache not used for 30 days; recent ones stay', async () => {
    const p = await project();
    const now = Date.now();
    const old: string[] = [], fresh: string[] = [];
    for (const c of ['storyboards', 'pin-frames', 'reference-frames', 'agent-originals']) {
      old.push(await version(p, c, 'promo', 1, 100, 40 * DAY, now));
      fresh.push(await version(p, c, 'promo', 2, 100, 1 * DAY, now));
    }
    const removed = await sweepDerivedCaches(p, { now });
    expect(removed.sort()).toEqual([...old].sort());
    for (const d of fresh) expect(existsSync(d)).toBe(true);
    for (const d of old) expect(existsSync(d)).toBe(false);
  });
  it('over the size cap the oldest go first, but never inside the grace period nor a skipped creative', async () => {
    const p = await project();
    const now = Date.now();
    const a = await version(p, 'storyboards', 'promo', 1, 1000, 5 * DAY, now);
    const b = await version(p, 'storyboards', 'promo', 2, 1000, 3 * DAY, now);
    const c = await version(p, 'storyboards', 'promo', 3, 1000, 1000, now);
    const s = await version(p, 'storyboards', 'busy', 1, 1000, 9 * DAY, now);
    await sweepDerivedCaches(p, { now, caches: [{ name: 'storyboards', maxBytes: 2500 }], skipCreative: (x) => x === 'busy' });
    expect([a, b, c, s].map((d) => existsSync(d))).toEqual([false, false, true, true]);
    await sweepDerivedCaches(p, { now, caches: [{ name: 'storyboards', maxBytes: 100 }], skipCreative: (x) => x === 'busy' });
    expect([c, s].map((d) => existsSync(d))).toEqual([true, true]);
  });
  it('a link is never followed: its target is untouched', async () => {
    const p = await project();
    const now = Date.now();
    const outside = await mkdtemp(join(tmpdir(), 'ms-test-cache-outside-'));
    cleanup.push(outside);
    await writeFile(join(outside, 'keep.txt'), 'x');
    const old = new Date(now - 60 * DAY);
    await utimes(outside, old, old);
    await mkdir(join(p, '.studio', 'cache', 'pin-frames', 'promo'), { recursive: true });
    await symlink(outside, join(p, '.studio', 'cache', 'pin-frames', 'promo', 'v1'));
    await sweepDerivedCaches(p, { now });
    expect(await readdir(outside)).toEqual(['keep.txt']);
  });
});
