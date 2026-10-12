import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteCoreChange } from '../core-changes.ts';
import { MEDIA_TEMP_RE, mediaCacheDir, pruneMediaCache, type PruneOptions } from './media-normalize.ts';
import { RENDER_OWNER_FILE, RENDER_TEMP_DIR_RE } from './owner.ts';
import { RENDER_TEMP_RE } from './renderer.ts';
import { listProcesses } from './watchdog.ts';

/**
 * The startup sweep of render leftovers (Task 5): what a render or a normalisation leaves when the app is killed (a clean
 * quit cancels them and removes their files: the job queue's cancel on close). Only names the core makes, only in the
 * core's own folders, only when older than `minAgeMs` (default 10 min):
 * - in a project: hidden render temp outputs `outputs/vN/.<name>.render-<hex>.tmp` (also in `.previews/`), media temp
 *   files `.studio/cache/media/.<key>.<hex>.tmp`, and the atomic JSON writes' temps (`manifest.json`, `versions.json`,
 *   `creative.json`, `source-hashes.json` + `.<12 hex>.tmp`) in their own folders; never through a linked creative or version folder. Then the media
 *   cache is pruned (`pruneMediaCache`: older recipes, unused for 30 days, the size cap), never a file in use;
 * - in the OS temp folder: exactly the renderer's temp folder names (`RENDER_TEMP_DIR_RE`) that hold its owner marker
 *   (`owner.pid`) whose pid is gone, and that no live process names on its command line.
 * The project part runs at startup AND on a workspace switch (`recoverWorkspace`), when renders may be running: the age
 * gate, `skipCreative` (a creative with an active render job) and `inUse` keep their files.
 */

export const SWEEP_MIN_AGE_MS = 10 * 60 * 1000;
const CREATIVE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const VERSION_RE = /^v\d{1,6}$/;
/** A `writeJsonFileAtomic` temp of `name` (`<name>.<12 hex>.tmp`), left by a killed app. */
const jsonTemp = (name: string) => new RegExp(`^${name.replace(/\./g, '\\.')}\\.[0-9a-f]{12}\\.tmp$`);
const STAMP_TEMP_RE = /^v\d{1,6}\.json\.[0-9a-f]{12}\.tmp$/;
const JSON_TEMPS_CREATIVE = /^(?:versions|creative)\.json\.[0-9a-f]{12}\.tmp$/;

const oldEnough = async (p: string, minAgeMs: number, now: number) => {
  const st = await lstat(p).catch(() => null);
  return st !== null && now - st.mtimeMs >= minAgeMs ? st : null;
};

async function sweepFiles(dir: string, re: RegExp, minAgeMs: number, now: number): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const removed: string[] = [];
  for (const name of names) {
    if (!re.test(name)) continue;
    const p = join(dir, name);
    const st = await oldEnough(p, minAgeMs, now);
    if (!st || !st.isFile()) continue;
    await rm(p, { force: true }).then(() => removed.push(p), () => {});
  }
  if (removed.length > 0) await noteCoreChange(dir);
  return removed;
}

/** Removes old render and media temp files of one project (see the module comment). Returns the paths removed. */
export async function sweepProjectRenders(projectDir: string, o: { minAgeMs?: number; now?: number; skipCreative?: (slug: string) => boolean; media?: PruneOptions } = {}): Promise<string[]> {
  const minAgeMs = o.minAgeMs ?? SWEEP_MIN_AGE_MS;
  const now = o.now ?? Date.now();
  const removed: string[] = [];
  const creatives = join(projectDir, 'creatives');
  for (const slug of await readdir(creatives).catch(() => [] as string[])) {
    if (!CREATIVE_SLUG_RE.test(slug) || o.skipCreative?.(slug)) continue;
    // A creative folder reached through a link is not ours to clean (M6).
    if (!(await lstat(join(creatives, slug)).catch(() => null))?.isDirectory()) continue;
    removed.push(...await sweepFiles(join(creatives, slug), JSON_TEMPS_CREATIVE, minAgeMs, now));
    const outputs = join(creatives, slug, 'outputs');
    if (!(await lstat(outputs).catch(() => null))?.isDirectory()) continue;
    for (const v of await readdir(outputs).catch(() => [] as string[])) {
      if (!VERSION_RE.test(v)) continue;
      const dir = join(outputs, v);
      if (!(await lstat(dir).catch(() => null))?.isDirectory()) continue;
      removed.push(...await sweepFiles(dir, RENDER_TEMP_RE, minAgeMs, now));
      removed.push(...await sweepFiles(dir, jsonTemp('manifest.json'), minAgeMs, now));
      const previews = join(dir, '.previews');
      if ((await lstat(previews).catch(() => null))?.isDirectory()) removed.push(...await sweepFiles(previews, RENDER_TEMP_RE, minAgeMs, now));
    }
  }
  const cache = join(projectDir, '.studio', 'cache');
  if ((await lstat(cache).catch(() => null))?.isDirectory()) removed.push(...await sweepFiles(cache, jsonTemp('source-hashes.json'), minAgeMs, now));
  // The render stamps' atomic-write temps: `.studio/cache/renders/<creative>/v<N>.json.<12 hex>.tmp` (C10).
  const stamps = join(cache, 'renders');
  if ((await lstat(stamps).catch(() => null))?.isDirectory()) {
    for (const slug of await readdir(stamps).catch(() => [] as string[])) {
      const sdir = join(stamps, slug);
      if (CREATIVE_SLUG_RE.test(slug) && (await lstat(sdir).catch(() => null))?.isDirectory()) removed.push(...await sweepFiles(sdir, STAMP_TEMP_RE, minAgeMs, now));
    }
  }
  const media = mediaCacheDir(projectDir);
  if ((await lstat(media).catch(() => null))?.isDirectory()) {
    removed.push(...await sweepFiles(media, MEDIA_TEMP_RE, minAgeMs, now));
    removed.push(...await pruneMediaCache(media, { now, ...o.media }));
  }
  return removed;
}

const alive = (pid: number) => {
  if (pid === process.pid) return true;
  if (!(pid > 1)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Removes old `ms-render-*` folders of the OS temp folder that nothing uses any more (see the module comment). */
export async function sweepRenderTempDirs(o: { root?: string; minAgeMs?: number; now?: number } = {}): Promise<string[]> {
  const root = o.root ?? tmpdir();
  const minAgeMs = o.minAgeMs ?? SWEEP_MIN_AGE_MS;
  const now = o.now ?? Date.now();
  const candidates: string[] = [];
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!RENDER_TEMP_DIR_RE.test(name)) continue;
    const p = join(root, name);
    const st = await oldEnough(p, minAgeMs, now);
    if (st?.isDirectory()) candidates.push(p);
  }
  if (candidates.length === 0) return [];
  const commands = (await listProcesses()).filter((r) => r.pid !== process.pid).map((r) => r.command);
  const removed: string[] = [];
  for (const p of candidates) {
    if (commands.some((c) => c.includes(p))) continue;
    // Only a folder the renderer marked as its own, whose owner is gone; or one still empty (made, never marked: a crash
    // between the two).
    const entries = await readdir(p).catch(() => null);
    if (entries === null) continue;
    if (entries.length > 0) {
      const owner = Number((await readFile(join(p, RENDER_OWNER_FILE), 'utf8').catch(() => '')).trim());
      if (!(owner > 1) || alive(owner)) continue;
    }
    await rm(p, { recursive: true, force: true, maxRetries: 2 }).then(() => removed.push(p), () => {});
  }
  return removed;
}
