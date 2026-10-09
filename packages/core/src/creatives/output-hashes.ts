import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { OutputFileInfo, VersionEntry } from '@motion-studio/shared';
import { hashConfinedFile, type SkipReason } from '../brand/agent-guard.ts';
import { readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { KeyedMutex } from '../keyed-mutex.ts';

/**
 * sha256 of the creatives' output files (spec §2.1), the identity of the per-format history.
 *
 * - New versions: `hashVersionOutputs` hashes the files right after the turn, before the version is recorded; the hashes
 *   go into versions.json. Nothing the agent wrote (manifest, sidecars, an incoming `sha256`) is ever trusted for them.
 *   These run in the limiter's priority lane, so a backlog of lazy hashes never delays finalizing a turn.
 * - Old versions (no `sha256`): `withLazyHashes` fills them when a creative is read. The results are cached in memory and in
 *   `<project>/.studio/cache/hashes/<creative>/v<N>.json` (`.studio` is out of the agent's reach, `.studio/cache/` is never
 *   versioned), keyed by file name, size and mtime: any mismatch recomputes. versions.json is never rewritten.
 *   Concurrent requests for the same file share one hashing run.
 * - A missing file, a symlink or a hard-linked file gets no hash (it counts as "changed"); the last two are logged once per
 *   file state (path, size, mtime).
 * - Hashing streams the files, at most HASH_PARALLELISM at a time in the whole process.
 */
export const HASH_PARALLELISM = 2;
/**
 * How long a creative GET waits for lazy hashes. Small creatives finish well within it; whatever is left keeps going in
 * the background, the response leaves those hashes absent (the history then shows the versions as changed) and the caller
 * is told when the work is done (the routes broadcast a `creative` change, so the UI reloads with the full history).
 */
export const LAZY_HASH_BUDGET_MS = 1500;

/** At most `max` tasks at once; waiting `priority` tasks always start before the others. */
function limiter(max: number) {
  let active = 0;
  const high: Array<() => void> = [];
  const low: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>, priority = false): Promise<T> => {
    // A released slot is handed straight to the next waiter, so `active` never exceeds `max`.
    if (active < max) active++;
    else await new Promise<void>((resolve) => (priority ? high : low).push(resolve));
    try { return await fn(); } finally {
      const next = high.shift() ?? low.shift();
      if (next) next(); else active--;
    }
  };
}
const limit = limiter(HASH_PARALLELISM);

type HashResult = { sha256: string; size: number; mtimeMs: number } | { skipped: SkipReason } | null;
let hashFile: (base: string, rel: string) => Promise<HashResult> = hashConfinedFile;

const cacheEntrySchema = z.object({ size: z.number(), mtimeMs: z.number(), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
type CacheEntry = z.infer<typeof cacheEntrySchema>;
const cacheFileSchema = z.object({ schemaVersion: z.literal(1), files: z.record(z.string(), cacheEntrySchema) });

/** Parsed cache files by path, and file states already reported as not hashable; each bounded, oldest dropped first. */
let memoryMax = 500;
const memory = new Map<string, Record<string, CacheEntry>>();
const reported = new Map<string, true>();
const bounded = <V>(map: Map<string, V>, key: string, value: V) => {
  map.delete(key);
  map.set(key, value);
  while (map.size > memoryMax) map.delete(map.keys().next().value!);
};
const inflight = new Map<string, Promise<CacheEntry | null>>();
const cacheLock = new KeyedMutex();

/** Forgets the in-memory caches (tests; the files on disk stay). */
export function clearHashMemory(): void { memory.clear(); reported.clear(); }

/** Test hooks: replace the file hasher (null restores it), change the memory bound, read the memory size. */
export const hashTesting = {
  setHasher(fn: ((base: string, rel: string) => Promise<HashResult>) | null) { hashFile = fn ?? hashConfinedFile; },
  setMemoryMax(n: number) { memoryMax = n; },
  memorySize: () => memory.size,
};

export const hashCachePath = (projectDir: string, creativeSlug: string, n: number) =>
  join(projectDir, '.studio', 'cache', 'hashes', creativeSlug, `v${n}.json`);

const warnSkip = (rel: string, reason: string) => console.warn(`Motion Studio: not hashing ${rel} (${reason}); it counts as changed`);

/** Hash of one output file of version `n`, confined to the creative folder; `{ skipped }` / null (missing) otherwise. */
async function hashOutput(creativeDir: string, n: number, file: string, priority: boolean): Promise<HashResult> {
  const rel = `outputs/v${n}/${file}`;
  return limit(() => hashFile(creativeDir, rel), priority).catch((err: Error) => {
    console.warn(`Motion Studio: cannot hash ${rel}: ${err.message}`);
    return { skipped: 'unreadable' as const };
  });
}

/** The outputs of a version being recorded, each with the sha256 of its file (absent when not hashable). Priority lane. */
export function hashVersionOutputs(creativeDir: string, n: number, outputs: OutputFileInfo[]): Promise<OutputFileInfo[]> {
  return Promise.all(outputs.map(async ({ sha256: _ignored, ...o }) => {
    const h = await hashOutput(creativeDir, n, o.file, true);
    if (h && 'skipped' in h) warnSkip(`outputs/v${n}/${o.file}`, h.skipped);
    return h && !('skipped' in h) ? { ...o, sha256: h.sha256 } : o;
  }));
}

async function readCache(path: string): Promise<Record<string, CacheEntry>> {
  const known = memory.get(path);
  if (known) return { ...known };
  try { return (await readJsonFile(path, cacheFileSchema)).files; } catch { return {}; } // missing or corrupt: recompute
}

/** The cache entry of one file: from the caches when name, size and mtime match, else computed (one run per file at a time). */
async function entryFor(cachePath: string, creativeDir: string, n: number, file: string, cached: CacheEntry | undefined): Promise<CacheEntry | null> {
  const rel = `outputs/v${n}/${file}`;
  const info = await lstat(join(creativeDir, 'outputs', `v${n}`, file)).catch(() => null);
  if (!info) return null; // missing on disk: no hash
  const state = `${cachePath}\0${file}\0${info.size}\0${info.mtimeMs}`;
  if (reported.has(state)) return null;
  const skip = (reason: string) => { warnSkip(rel, reason); bounded(reported, state, true); return null; };
  if (info.isSymbolicLink()) return skip('not-regular');
  if (!info.isFile() || info.nlink > 1) return skip(info.isFile() ? 'linked' : 'not-regular');
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached;
  const key = `${cachePath}\0${file}`;
  const running = inflight.get(key);
  if (running) return running;
  const run = hashOutput(creativeDir, n, file, false).then((h) => {
    if (h && 'skipped' in h) return skip(h.skipped);
    return h ? { size: h.size, mtimeMs: h.mtimeMs, sha256: h.sha256 } : null;
  }).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

/** Hashes of the outputs of `v` that have none (only `formats`' when given), file → sha256; updates the caches. */
async function fillVersion(projectDir: string, creativeSlug: string, creativeDir: string, v: VersionEntry, formats?: readonly string[]): Promise<Record<string, string>> {
  const path = hashCachePath(projectDir, creativeSlug, v.n);
  const cache = await readCache(path);
  const wanted = v.outputs.filter((o) => o.sha256 === undefined && (!formats || formats.includes(o.format)));
  const entries = await Promise.all(wanted.map(async (o) => [o.file, await entryFor(path, creativeDir, v.n, o.file, cache[o.file])] as const));
  const found: Record<string, string> = {};
  for (const [file, e] of entries) if (e) found[file] = e.sha256;
  // Merged under a lock on a fresh read: concurrent fills of other files of the same version must not drop each other's entries.
  await cacheLock.run(path, async () => {
    const current = await readCache(path);
    let dirty = false;
    for (const [file, e] of entries) {
      const before = current[file];
      if (e && (before?.sha256 !== e.sha256 || before.size !== e.size || before.mtimeMs !== e.mtimeMs)) { current[file] = e; dirty = true; }
      else if (!e && before) { delete current[file]; dirty = true; }
    }
    bounded(memory, path, current);
    if (dirty) {
      await writeJsonFileAtomic(path, { schemaVersion: 1, files: current }).catch((err: Error) => {
        console.warn(`Motion Studio: cannot write the hash cache ${path}: ${err.message}`);
      });
    }
  });
  return found;
}

export interface LazyHashInput {
  projectDir: string; creativeSlug: string; creativeDir: string; versions: VersionEntry[];
  /** Only the outputs of these formats (default: all). */
  formats?: readonly string[];
  /** How long to wait (default LAZY_HASH_BUDGET_MS; 0 = not at all, Infinity = until done); the rest goes on in the background. */
  budgetMs?: number;
  /** Called once when work that outlived the budget is done (not called when everything finished in time). */
  onBackgroundDone?: () => void;
}

/** `versions` with the missing hashes filled from the caches or computed within the budget; never throws. */
export async function withLazyHashes(input: LazyHashInput): Promise<VersionEntry[]> {
  const pending = input.versions.filter((v) => v.outputs.some((o) => o.sha256 === undefined && (!input.formats || input.formats.includes(o.format))));
  if (pending.length === 0) return input.versions;
  const results = new Map<number, Record<string, string>>();
  const work = Promise.all(pending.map((v) => fillVersion(input.projectDir, input.creativeSlug, input.creativeDir, v, input.formats)
    .then((r) => { results.set(v.n, r); }, (err: Error) => { console.warn(`Motion Studio: lazy hashes failed: ${err.message}`); })));
  const budget = input.budgetMs ?? LAZY_HASH_BUDGET_MS;
  let timer: NodeJS.Timeout | undefined;
  // A budget of 0 does not wait at all; an infinite one waits for everything.
  const inTime = budget > 0 && await Promise.race([
    work.then(() => true),
    ...(Number.isFinite(budget) ? [new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), budget); })] : []),
  ]);
  clearTimeout(timer);
  if (!inTime) void work.then(() => input.onBackgroundDone?.());
  return input.versions.map((v) => {
    const found = results.get(v.n);
    if (!found) return v;
    return { ...v, outputs: v.outputs.map((o) => (o.sha256 === undefined && found[o.file] ? { ...o, sha256: found[o.file] } : o)) };
  });
}
