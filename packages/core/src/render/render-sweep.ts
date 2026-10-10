import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteCoreChange } from '../core-changes.ts';
import { MEDIA_TEMP_RE, mediaCacheDir } from './media-normalize.ts';
import { RENDER_OWNER_FILE, RENDER_TEMP_RE } from './renderer.ts';
import { listProcesses } from './watchdog.ts';

/**
 * The startup sweep of render leftovers (Task 5): what a render or a normalisation leaves when the app is killed (a clean
 * quit cancels them and removes their files: the job queue's cancel on close). Only names the core makes, only in the
 * core's own folders, only when older than `minAgeMs` (default 10 min):
 * - in a project: hidden render temp outputs `outputs/vN/.<name>.render-<hex>.tmp` (also in `.previews/`) and media temp
 *   files `.studio/cache/media/.<key>.<hex>.tmp`;
 * - in the OS temp folder: render work folders and browser profiles `ms-render-*`, unless a live process still names the
 *   folder on its command line, or its `owner.pid` is a live process.
 */

export const SWEEP_MIN_AGE_MS = 10 * 60 * 1000;
const CREATIVE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const VERSION_RE = /^v\d{1,6}$/;
const TEMP_DIR_RE = /^ms-render-[A-Za-z0-9_-]{6,}$/;

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
export async function sweepProjectRenders(projectDir: string, o: { minAgeMs?: number; now?: number } = {}): Promise<string[]> {
  const minAgeMs = o.minAgeMs ?? SWEEP_MIN_AGE_MS;
  const now = o.now ?? Date.now();
  const removed: string[] = [];
  const creatives = join(projectDir, 'creatives');
  for (const slug of await readdir(creatives).catch(() => [] as string[])) {
    if (!CREATIVE_SLUG_RE.test(slug)) continue;
    const outputs = join(creatives, slug, 'outputs');
    if (!(await lstat(outputs).catch(() => null))?.isDirectory()) continue;
    for (const v of await readdir(outputs).catch(() => [] as string[])) {
      if (!VERSION_RE.test(v)) continue;
      const dir = join(outputs, v);
      if (!(await lstat(dir).catch(() => null))?.isDirectory()) continue;
      removed.push(...await sweepFiles(dir, RENDER_TEMP_RE, minAgeMs, now));
      const previews = join(dir, '.previews');
      if ((await lstat(previews).catch(() => null))?.isDirectory()) removed.push(...await sweepFiles(previews, RENDER_TEMP_RE, minAgeMs, now));
    }
  }
  const media = mediaCacheDir(projectDir);
  if ((await lstat(media).catch(() => null))?.isDirectory()) removed.push(...await sweepFiles(media, MEDIA_TEMP_RE, minAgeMs, now));
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
    if (!TEMP_DIR_RE.test(name)) continue;
    const p = join(root, name);
    const st = await oldEnough(p, minAgeMs, now);
    if (st?.isDirectory()) candidates.push(p);
  }
  if (candidates.length === 0) return [];
  const commands = (await listProcesses()).filter((r) => r.pid !== process.pid).map((r) => r.command);
  const removed: string[] = [];
  for (const p of candidates) {
    if (commands.some((c) => c.includes(p))) continue;
    const owner = Number((await readFile(join(p, RENDER_OWNER_FILE), 'utf8').catch(() => '')).trim());
    if (owner && alive(owner)) continue;
    await rm(p, { recursive: true, force: true, maxRetries: 2 }).then(() => removed.push(p), () => {});
  }
  return removed;
}
