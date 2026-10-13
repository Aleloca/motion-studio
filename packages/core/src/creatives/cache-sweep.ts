import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { noteCoreChange } from '../core-changes.ts';

/**
 * Garbage collection of the core's derived caches under `<project>/.studio/cache/<name>/<creative>/v<N>/…` (final wave
 * C3, C11): storyboards, pin frames, the agent's original composition.json files and the legacy conversion's reference
 * frames. All of them are rebuilt on demand (or only informative), so the policy is the media cache's: a `v<N>` folder
 * whose newest file is older than `maxAgeMs` goes; then the oldest ones go until the cache fits its size cap. Never a
 * folder used in the last `graceMs`, nor one of a creative `skipCreative` names (a turn that may be reading it). Links are
 * never followed (a link is removed as an entry, its target is not touched), only real folders are walked.
 */
export const DERIVED_CACHES: ReadonlyArray<{ name: string; maxBytes: number }> = [
  { name: 'storyboards', maxBytes: 1024 ** 3 },
  { name: 'pin-frames', maxBytes: 512 * 1024 ** 2 },
  { name: 'reference-frames', maxBytes: 1024 ** 3 },
  { name: 'agent-originals', maxBytes: 128 * 1024 ** 2 },
];
export const DERIVED_CACHE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
export const DERIVED_CACHE_GRACE_MS = 24 * 3600 * 1000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const VERSION_RE = /^v\d{1,6}$/;
/** Most entries one version folder is measured over (a folder bigger than this is measured as old only by its first entries). */
const MAX_ENTRIES = 20_000;

interface Measure { bytes: number; newestMs: number }

async function measure(dir: string, budget = { left: MAX_ENTRIES }): Promise<Measure> {
  const m: Measure = { bytes: 0, newestMs: 0 };
  const top = await lstat(dir).catch(() => null);
  if (!top) return m;
  m.newestMs = top.mtimeMs;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (budget.left-- <= 0) break;
    const st = await lstat(join(dir, name)).catch(() => null);
    if (!st) continue;
    m.newestMs = Math.max(m.newestMs, st.mtimeMs);
    if (st.isDirectory()) { const sub = await measure(join(dir, name), budget); m.bytes += sub.bytes; m.newestMs = Math.max(m.newestMs, sub.newestMs); } else m.bytes += st.size;
  }
  return m;
}

export async function sweepDerivedCaches(projectDir: string, o: { now?: number; maxAgeMs?: number; graceMs?: number; skipCreative?: (slug: string) => boolean; caches?: ReadonlyArray<{ name: string; maxBytes: number }> } = {}): Promise<string[]> {
  const now = o.now ?? Date.now();
  const maxAge = o.maxAgeMs ?? DERIVED_CACHE_MAX_AGE_MS;
  const grace = o.graceMs ?? DERIVED_CACHE_GRACE_MS;
  const removed: string[] = [];
  const base = join(projectDir, '.studio', 'cache');
  for (const cache of o.caches ?? DERIVED_CACHES) {
    const root = join(base, cache.name);
    if (!(await lstat(root).catch(() => null))?.isDirectory()) continue;
    const found: Array<{ dir: string; parent: string; m: Measure; skip: boolean }> = [];
    for (const creative of await readdir(root).catch(() => [] as string[])) {
      const cdir = join(root, creative);
      if (!(await lstat(cdir).catch(() => null))?.isDirectory()) continue;
      const skip = !SLUG_RE.test(creative) || (o.skipCreative?.(creative) ?? false);
      for (const v of await readdir(cdir).catch(() => [] as string[])) {
        if (!VERSION_RE.test(v)) continue;
        const vdir = join(cdir, v);
        if (!(await lstat(vdir).catch(() => null))?.isDirectory()) continue;
        found.push({ dir: vdir, parent: cdir, m: await measure(vdir), skip });
      }
    }
    const drop = async (f: (typeof found)[number]) => {
      await rm(f.dir, { recursive: true, force: true }).then(() => { removed.push(f.dir); f.m.bytes = 0; }, () => {});
      await noteCoreChange(f.parent).catch(() => {});
    };
    const kept: typeof found = [];
    for (const f of found) {
      if (!f.skip && now - f.m.newestMs > Math.max(maxAge, grace)) await drop(f); else kept.push(f);
    }
    let total = kept.reduce((a, f) => a + f.m.bytes, 0);
    for (const f of kept.sort((a, b) => a.m.newestMs - b.m.newestMs)) {
      if (total <= cache.maxBytes) break;
      if (f.skip || now - f.m.newestMs < grace) continue;
      const before = f.m.bytes;
      await drop(f);
      if (f.m.bytes === 0) total -= before;
    }
  }
  return removed;
}

/**
 * The editor's staging folders (`.studio/cache/editor-staging/<creative>/<id>`, editor-staging.ts) whose newest file is
 * older than `maxAgeMs` (default 24 h), never one a live preview session uses (`inUse`, by its path). A session's folder is
 * also removed when the session ends; this catches the ones a crash or a quit left behind. Links are never followed.
 */
export async function sweepEditorStaging(projectDir: string, o: { now?: number; maxAgeMs?: number; inUse?: (dir: string) => boolean } = {}): Promise<string[]> {
  const now = o.now ?? Date.now();
  const maxAge = o.maxAgeMs ?? 24 * 3600 * 1000;
  const root = join(projectDir, '.studio', 'cache', 'editor-staging');
  const removed: string[] = [];
  if (!(await lstat(root).catch(() => null))?.isDirectory()) return removed;
  for (const creative of await readdir(root).catch(() => [] as string[])) {
    const cdir = join(root, creative);
    if (!(await lstat(cdir).catch(() => null))?.isDirectory()) continue;
    let any = false;
    for (const id of await readdir(cdir).catch(() => [] as string[])) {
      const dir = join(cdir, id);
      if (o.inUse?.(dir)) continue;
      const st = await lstat(dir).catch(() => null);
      if (!st) continue;
      // A link (or any other non-folder) is judged by its own entry and removed as an entry: nothing is read through it.
      const newest = st.isDirectory() ? (await measure(dir)).newestMs : st.mtimeMs;
      if (now - newest <= maxAge) continue;
      await rm(dir, { recursive: true, force: true }).then(() => { removed.push(dir); any = true; }, () => {});
    }
    if (any) await noteCoreChange(cdir).catch(() => {});
  }
  return removed;
}
