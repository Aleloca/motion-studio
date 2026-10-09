import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PART_MAX_AGE_MS = 3600_000;
const PART_RE = /^\..+\.part$/;
const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

/** Lines added to the project template after phase 2: appended to older projects' .gitignore (other lines are the user's call). */
const ADDED_IGNORES = ['.*.part', 'assets/.describe/', '.cache/', 'creatives/*/work/tmp/'];
/** Phase 8: the usage ledger merges by union (append-only JSONL). Older projects have no .gitattributes at all. */
const ADDED_ATTRIBUTES = ['.studio/usage.jsonl merge=union'];

/** Appends the missing lines to a text file; `createMissing` decides whether a missing file is created or left alone. */
async function appendMissingLines(path: string, lines: readonly string[], createMissing: boolean): Promise<boolean> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (e) {
    if (!isMissing(e)) throw e;
    if (!createMissing) return false;
    text = '';
  }
  const present = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = lines.filter((l) => !present.has(l));
  if (missing.length > 0) await writeFile(path, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`);
  return true;
}

/**
 * Appends the missing ADDED_IGNORES to an existing project's .gitignore and, only then, the ledger's union merge to its
 * .gitattributes (created when missing: projects older than phase 8 have none). Without a .gitignore nothing changes.
 */
export async function completeGitignore(projectDir: string): Promise<void> {
  if (!(await appendMissingLines(join(projectDir, '.gitignore'), ADDED_IGNORES, false))) return;
  await appendMissingLines(join(projectDir, '.gitattributes'), ADDED_ATTRIBUTES, true);
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
