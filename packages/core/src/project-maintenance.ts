import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PART_MAX_AGE_MS = 3600_000;
const PART_RE = /^\..+\.part$/;
const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

/** Lines added to the project template after phase 2: appended to older projects' .gitignore (other lines are the user's call). */
const ADDED_IGNORES = ['.*.part', 'assets/.describe/', '.cache/'];

/** Appends the missing ADDED_IGNORES to an existing project's .gitignore (a missing file is left alone). */
export async function completeGitignore(projectDir: string): Promise<void> {
  const path = join(projectDir, '.gitignore');
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (e) { if (isMissing(e)) return; throw e; }
  const present = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = ADDED_IGNORES.filter((l) => !present.has(l));
  if (missing.length === 0) return;
  await writeFile(path, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`);
}

/**
 * Removes what interrupted work left behind. Upload temp files (`.<random>.part`) only when older than an hour, since
 * uploads are not jobs; proposal folders without proposal.json and describe output files only when `brandJobIdle`
 * (a running brand job owns them).
 */
export async function sweepProject(projectDir: string, brandJobIdle: boolean): Promise<void> {
  const entries = async (dir: string) => readdir(dir, { withFileTypes: true }).catch((e) => { if (isMissing(e)) return []; throw e; });
  for (const kind of ['assets', 'references']) {
    for (const e of await entries(join(projectDir, kind))) {
      if (!e.isFile() || !PART_RE.test(e.name)) continue;
      const info = await lstat(join(projectDir, kind, e.name)).catch(() => null);
      if (info && Date.now() - info.mtimeMs > PART_MAX_AGE_MS) await rm(join(projectDir, kind, e.name), { force: true });
    }
  }
  if (!brandJobIdle) return;
  for (const e of await entries(join(projectDir, 'brand', 'proposals'))) {
    if (!e.isDirectory()) continue;
    const dir = join(projectDir, 'brand', 'proposals', e.name);
    if (!(await lstat(join(dir, 'proposal.json')).catch(() => null))) await rm(dir, { recursive: true, force: true });
  }
  for (const e of await entries(join(projectDir, 'assets', '.describe'))) {
    await rm(join(projectDir, 'assets', '.describe', e.name), { recursive: true, force: true });
  }
}
