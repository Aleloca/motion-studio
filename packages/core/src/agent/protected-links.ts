import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { noteCoreChange } from '../core-changes.ts';

/** Per creative: the conversation log plus the metadata the core owns (the agent only writes outputs/vN/ and work/). */
export const CREATIVE_CORE_FILES = ['conversation.jsonl', 'versions.json', 'creative.json'];
/** Per brand proposal: its activity log. */
export const PROPOSAL_LOG = 'log.jsonl';
/** Project files the core or the next agent turn loads (also protected by the launcher). */
const PROJECT_CONFIG_FILES = ['CLAUDE.md', 'CLAUDE.local.md', '.mcp.json'];

/** The temp name of a detach in progress: `.<name>.detach-<12 hex>`; one left by a crash is removed on the next pass. */
const TEMP_RE = /^\..+\.detach-[0-9a-f]{12}$/;
/** From this size the copy is an APFS/btrfs clone (by path, then checked against the open handle); below, read from the handle. */
const CLONE_MIN = 1024 * 1024;
const ATTEMPTS = 3;

/**
 * Hard links and protected files (decisions log 141). The macOS sandbox refuses `ln` onto a write-denied file, and a write
 * through a symlink is checked on its target (both verified live), so the agent cannot make a second name for a protected
 * file during a job. A hard link made while the file was still writable is different: an `outputs/vN/` file linked from
 * `work/` during its own turn stays a writable second name in later turns, when `outputs/vN/` is protected (also verified
 * live). Detaching gives the protected name a fresh inode with the same bytes and mode; the other name keeps the old inode,
 * so writes through it no longer reach the protected file.
 *
 * The bytes kept are the file's current content: the core never trusts it more than before (versions keep their recorded
 * sha256, logs are what they are), it only stops further writes through the other name.
 *
 * Races: the source is opened with O_NOFOLLOW and must be the inode that was lstat-ed; before the rename the name is
 * lstat-ed again (inode, size, mtime) and the copy is redone if anything changed (a core append or atomic write meanwhile),
 * so a concurrent write is never overwritten by a stale copy. Large files are cloned by path (Node has no clone from a
 * handle), then the open handle and the name are checked to still be that same, unchanged inode.
 */
export async function detachHardLink(file: string): Promise<boolean> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const st = await lstat(file).catch(() => null);
    if (!st?.isFile() || st.nlink <= 1) return false;
    const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    if (!fh) return false;
    const tmp = join(dirname(file), `.${basename(file)}.detach-${randomBytes(6).toString('hex')}`);
    try {
      const src = await fh.stat();
      if (!src.isFile() || src.ino !== st.ino || src.dev !== st.dev) continue; // swapped between lstat and open
      if (src.size >= CLONE_MIN) await copyFile(file, tmp, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      else await writeFile(tmp, await fh.readFile(), { flag: 'wx' });
      await chmod(tmp, src.mode & 0o7777);
      const [again, held, copy] = await Promise.all([lstat(file).catch(() => null), fh.stat(), lstat(tmp)]);
      const same = (s: { ino: number; size: number; mtimeMs: number }) => s.ino === st.ino && s.size === st.size && s.mtimeMs === st.mtimeMs;
      if (!again || !same(again) || !same(held) || copy.size !== st.size) {
        await rm(tmp, { force: true });
        continue;
      }
      await rename(tmp, file);
      noteCoreChange(dirname(file));
      return true;
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    } finally {
      await fh.close().catch(() => {});
    }
  }
  return false;
}

/** True when `p` is a real folder (not a link to one). */
async function isRealDir(p: string): Promise<boolean> {
  return (await lstat(p).catch(() => null))?.isDirectory() === true;
}

/** Removes the temp files of detaches a crash left in `dir`. */
async function sweepTemps(dir: string): Promise<void> {
  let swept = false;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile() && TEMP_RE.test(e.name)) { await rm(join(dir, e.name), { force: true }).catch(() => {}); swept = true; }
  }
  if (swept) noteCoreChange(dir);
}

/** Real folders directly under `parent`, which must itself be a real folder (links are never followed). */
async function subdirs(parent: string): Promise<string[]> {
  if (!(await isRealDir(parent))) return [];
  const names = await readdir(parent).catch(() => [] as string[]);
  const checked = await Promise.all(names.map(async (n) => ((await isRealDir(join(parent, n))) ? n : null)));
  return checked.filter((n): n is string => n !== null);
}

/** Every regular file under the real folder `dir`, recursively (links never followed); crash leftovers are swept on the way. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    await sweepTemps(d);
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  if (await isRealDir(dir)) await walk(dir);
  return out;
}

/** True when every folder from `base` (excluded) down to `dir` (included) is a real folder. */
async function realChain(base: string, dir: string): Promise<boolean> {
  const rel = relative(base, dir);
  if (rel.startsWith('..')) return false;
  let p = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    p = join(p, part);
    if (!(await isRealDir(p))) return false;
  }
  return true;
}

/** Detaches every regular file under `dir` that has more than one link; returns them relative to `base`. `dir` must be reached from `base` through real folders only. */
export async function detachLinksUnder(dir: string, base: string): Promise<string[]> {
  if (!(await realChain(base, dir))) return [];
  const out: string[] = [];
  for (const f of await filesUnder(dir)) if (await detachHardLink(f).catch(() => false)) out.push(relative(base, f));
  return out;
}

/**
 * The files of a project the agent may never write and the core (or the next turn) trusts: each creative's conversation,
 * versions and metadata; each brand proposal's log; everything under `.studio/` (usage ledger, permissions, hash cache)
 * and `.claude/`; `CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json`; `.git/config` and `.git/hooks/`. `.git/objects` is left out:
 * `git clone --local` hard-links objects on purpose. Those with extra links are detached; the result lists them relative to
 * the project. Cheap (one lstat per file), run before and after every agent run: the sandbox already refuses the link, this
 * only catches one made some other way (an unsandboxed job, another program, a link made before the file was protected).
 * Parent folders must be real folders (`creatives/`, `brand/`, `brand/proposals/`, each creative and proposal).
 */
export async function detachProtectedLinks(projectDir: string): Promise<string[]> {
  const files: string[] = PROJECT_CONFIG_FILES.map((n) => join(projectDir, n));
  const sweep = [projectDir];
  const creatives = join(projectDir, 'creatives');
  for (const s of await subdirs(creatives)) {
    sweep.push(join(creatives, s));
    for (const n of CREATIVE_CORE_FILES) files.push(join(creatives, s, n));
  }
  if (await isRealDir(join(projectDir, 'brand'))) {
    const proposals = join(projectDir, 'brand', 'proposals');
    for (const id of await subdirs(proposals)) {
      sweep.push(join(proposals, id));
      files.push(join(proposals, id, PROPOSAL_LOG));
    }
  }
  files.push(...await filesUnder(join(projectDir, '.studio')), ...await filesUnder(join(projectDir, '.claude')));
  const git = join(projectDir, '.git');
  if (await isRealDir(git)) {
    sweep.push(git);
    files.push(join(git, 'config'), ...await filesUnder(join(git, 'hooks')));
  }
  await Promise.all(sweep.map((d) => sweepTemps(d)));
  const out: string[] = [];
  for (const f of files) if (await detachHardLink(f).catch(() => false)) out.push(relative(projectDir, f));
  return out;
}
