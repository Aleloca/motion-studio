import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

/** Per creative: the conversation log plus the metadata the core owns (the agent only writes outputs/vN/ and work/). */
export const CREATIVE_CORE_FILES = ['conversation.jsonl', 'versions.json', 'creative.json'];
/** Per brand proposal: its activity log. */
export const PROPOSAL_LOG = 'log.jsonl';

/**
 * Hard links and protected files (decisions log 141). The macOS sandbox refuses `ln` onto a write-denied file, and a write
 * through a symlink is checked on its target (both verified live), so the agent cannot make a second name for a protected
 * file during a job. A hard link made while the file was still writable is different: an `outputs/vN/` file linked from
 * `work/` during its own turn stays a writable second name in later turns, when `outputs/vN/` is protected (also verified
 * live). Detaching gives the protected name a fresh inode with the same bytes; the other name keeps the old inode, so writes
 * through it no longer reach the protected file.
 *
 * The bytes kept are the file's current content: the core never trusts it more than before (versions keep their recorded
 * sha256, logs are what they are), it only stops further writes through the other name.
 */
export async function detachHardLink(file: string): Promise<boolean> {
  const st = await lstat(file).catch(() => null);
  if (!st?.isFile() || st.nlink <= 1) return false;
  const tmp = join(dirname(file), `.${basename(file)}.detach-${randomBytes(6).toString('hex')}`);
  try {
    // A copy (or an APFS clone) is a new inode; libuv gives it the source's mode.
    await copyFile(file, tmp, constants.COPYFILE_EXCL);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return true;
}

/** Real folders directly under `parent` (links are not followed). */
async function subdirs(parent: string): Promise<string[]> {
  const names = await readdir(parent).catch(() => [] as string[]);
  const checked = await Promise.all(names.map(async (n) => ((await lstat(join(parent, n)).catch(() => null))?.isDirectory() ? n : null)));
  return checked.filter((n): n is string => n !== null);
}

/** Every regular file under `dir`, recursively; links are never followed. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  await walk(dir);
  return out;
}

/** Detaches every regular file under `dir` that has more than one link; returns them relative to `base`. */
export async function detachLinksUnder(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of await filesUnder(dir)) if (await detachHardLink(f).catch(() => false)) out.push(relative(base, f));
  return out;
}

/**
 * The core-owned files of a project the agent may never write: each creative's conversation, versions and metadata, each
 * brand proposal's log, everything under `.studio/` (usage ledger, permissions, hash cache). Those with extra links are
 * detached; the result lists them relative to the project. A cheap check (one lstat per file), run before and after every
 * agent run: the sandbox already refuses the link, this only catches one made some other way (an unsandboxed job, another
 * program).
 */
export async function detachProtectedLinks(projectDir: string): Promise<string[]> {
  const files: string[] = [];
  for (const s of await subdirs(join(projectDir, 'creatives'))) for (const n of CREATIVE_CORE_FILES) files.push(join(projectDir, 'creatives', s, n));
  for (const id of await subdirs(join(projectDir, 'brand', 'proposals'))) files.push(join(projectDir, 'brand', 'proposals', id, PROPOSAL_LOG));
  const studio = join(projectDir, '.studio');
  if ((await lstat(studio).catch(() => null))?.isDirectory()) files.push(...await filesUnder(studio));
  const out: string[] = [];
  for (const f of files) if (await detachHardLink(f).catch(() => false)) out.push(relative(projectDir, f));
  return out;
}
