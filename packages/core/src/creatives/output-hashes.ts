import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { OutputFileInfo, VersionEntry } from '@motion-studio/shared';
import { hashConfinedFile } from '../brand/agent-guard.ts';
import { readJsonFile, writeJsonFileAtomic } from '../json-file.ts';

/**
 * sha256 of the creatives' output files (spec §2.1), the identity of the per-format history.
 *
 * - New versions: `hashVersionOutputs` hashes the files right after the turn, before the version is recorded; the hashes
 *   go into versions.json. Nothing the agent wrote (manifest, sidecars) is ever trusted for them.
 * - Old versions (no `sha256`): `withLazyHashes` fills them when a creative is read. The results are cached in memory and in
 *   `<project>/.studio/cache/hashes/<creative>/v<N>.json` (`.studio` is out of the agent's reach, `.studio/cache/` is never
 *   versioned), keyed by file name, size and mtime: any mismatch recomputes. versions.json is never rewritten.
 * - A missing file, a symlink or a hard-linked file gets no hash (it counts as "changed"); the last two are logged.
 * - Hashing streams the files, at most HASH_PARALLELISM at a time in the whole process.
 */
export const HASH_PARALLELISM = 2;
/**
 * How long a creative GET waits for lazy hashes. Small creatives finish well within it; whatever is left keeps going in
 * the background, the response leaves those hashes absent (the history then shows the versions as changed) and the caller
 * is told when the work is done (the routes broadcast a `creative` change, so the UI reloads with the full history).
 */
export const LAZY_HASH_BUDGET_MS = 1500;

function limiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    // A released slot is handed straight to the next waiter, so `active` never exceeds `max`.
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try { return await fn(); } finally {
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  };
}
const limit = limiter(HASH_PARALLELISM);

const cacheEntrySchema = z.object({ size: z.number(), mtimeMs: z.number(), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
type CacheEntry = z.infer<typeof cacheEntrySchema>;
const cacheFileSchema = z.object({ schemaVersion: z.literal(1), files: z.record(z.string(), cacheEntrySchema) });

/** Parsed cache files by path; bounded, oldest dropped first. */
const MEMORY_MAX = 500;
const memory = new Map<string, Record<string, CacheEntry>>();
const inflight = new Map<string, Promise<Record<string, string>>>();
const remember = (path: string, files: Record<string, CacheEntry>) => {
  memory.delete(path);
  memory.set(path, files);
  if (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value!);
};

/** Forgets the in-memory cache (tests; the files on disk stay). */
export function clearHashMemory(): void { memory.clear(); }

export const hashCachePath = (projectDir: string, creativeSlug: string, n: number) =>
  join(projectDir, '.studio', 'cache', 'hashes', creativeSlug, `v${n}.json`);

/** sha256 of one output file of version `n`, confined to the creative folder; null (logged when refused) if not hashable. */
async function hashOutput(creativeDir: string, n: number, file: string): Promise<{ sha256: string; size: number; mtimeMs: number } | null> {
  const rel = `outputs/v${n}/${file}`;
  const r = await limit(() => hashConfinedFile(creativeDir, rel)).catch((err: Error) => {
    console.warn(`Motion Studio: cannot hash ${rel}: ${err.message}`);
    return null;
  });
  if (r && 'skipped' in r) {
    console.warn(`Motion Studio: not hashing ${rel} (${r.skipped}); it counts as changed`);
    return null;
  }
  return r;
}

/** The outputs of a version being recorded, each with the sha256 of its file (absent when not hashable). */
export function hashVersionOutputs(creativeDir: string, n: number, outputs: OutputFileInfo[]): Promise<OutputFileInfo[]> {
  return Promise.all(outputs.map(async ({ sha256: _ignored, ...o }) => {
    const h = await hashOutput(creativeDir, n, o.file);
    return h ? { ...o, sha256: h.sha256 } : o;
  }));
}

async function readCache(path: string): Promise<Record<string, CacheEntry>> {
  const known = memory.get(path);
  if (known) return { ...known };
  try { return (await readJsonFile(path, cacheFileSchema)).files; } catch { return {}; } // missing or corrupt: recompute
}

/** Hashes of the outputs of `v` that have none, file → sha256, from the caches or computed. One run per version at a time. */
function fillVersion(projectDir: string, creativeSlug: string, creativeDir: string, v: VersionEntry): Promise<Record<string, string>> {
  const path = hashCachePath(projectDir, creativeSlug, v.n);
  const running = inflight.get(path);
  if (running) return running;
  const run = (async () => {
    const cache = await readCache(path);
    const found: Record<string, string> = {};
    let dirty = false;
    await Promise.all(v.outputs.filter((o) => o.sha256 === undefined).map(async (o) => {
      const info = await lstat(join(creativeDir, 'outputs', `v${v.n}`, o.file)).catch(() => null);
      if (!info) return; // missing on disk: no hash
      const cached = cache[o.file];
      if (cached && info.isFile() && info.nlink === 1 && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
        found[o.file] = cached.sha256;
        return;
      }
      const h = await hashOutput(creativeDir, v.n, o.file);
      if (!h) { if (cached) { delete cache[o.file]; dirty = true; } return; }
      cache[o.file] = { size: h.size, mtimeMs: h.mtimeMs, sha256: h.sha256 };
      found[o.file] = h.sha256;
      dirty = true;
    }));
    remember(path, cache);
    if (dirty) {
      await writeJsonFileAtomic(path, { schemaVersion: 1, files: cache }).catch((err: Error) => {
        console.warn(`Motion Studio: cannot write the hash cache ${path}: ${err.message}`);
      });
    }
    return found;
  })().finally(() => inflight.delete(path));
  inflight.set(path, run);
  return run;
}

export interface LazyHashInput {
  projectDir: string; creativeSlug: string; creativeDir: string; versions: VersionEntry[];
  /** How long to wait (default LAZY_HASH_BUDGET_MS; 0 = not at all, Infinity = until done); the rest goes on in the background. */
  budgetMs?: number;
  /** Called once when work that outlived the budget is done (not called when everything finished in time). */
  onBackgroundDone?: () => void;
}

/** `versions` with the missing hashes filled from the caches or computed within the budget; never throws. */
export async function withLazyHashes(input: LazyHashInput): Promise<VersionEntry[]> {
  const pending = input.versions.filter((v) => v.outputs.some((o) => o.sha256 === undefined));
  if (pending.length === 0) return input.versions;
  const results = new Map<number, Record<string, string>>();
  const work = Promise.all(pending.map((v) => fillVersion(input.projectDir, input.creativeSlug, input.creativeDir, v)
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
