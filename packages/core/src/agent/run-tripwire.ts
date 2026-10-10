import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { lastCoreChange, type DirStamp } from '../core-changes.ts';
import { PROPOSAL_LOG } from './protected-links.ts';

interface DirMark { ino: number; mtimeMs: number; ctimeMs: number }
interface FileMark { ino: number; size: number; sha: string }
interface LogMark { ino: number; size: number; ctimeMs: number; sha: string }
export interface TripwireResult {
  /** Protected files the core never writes during a run whose content changed: an unambiguous tamper. The job fails and the repo is quarantined. */
  tampered: string[];
  /** Record folders (`creatives/`, a creative, `outputs/`, `brand/proposals/`) whose identity changed unexplained: a warning. */
  moved: string[];
  /** Append-only logs whose bytes from the start of the run were rewritten or cut (glob roots only): a warning. */
  rewritten: string[];
}

const isRealDir = async (p: string) => (await lstat(p).catch(() => null))?.isDirectory() === true;
async function subdirs(parent: string): Promise<string[]> {
  if (!(await isRealDir(parent))) return [];
  const names = await readdir(parent).catch(() => [] as string[]);
  const checked = await Promise.all(names.map(async (n) => ((await isRealDir(join(parent, n))) ? join(parent, n) : null)));
  return checked.filter((n): n is string => n !== null);
}

/** Every regular file under the real folder `dir`, recursively; links never followed. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  if (await isRealDir(dir)) await walk(dir);
  return out;
}

async function sha256(file: string, end?: number): Promise<string | null> {
  if (end === 0) return createHash('sha256').digest('hex');
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(file, end === undefined ? {} : { start: 0, end: end - 1 })) hash.update(chunk as Buffer);
  } catch { return null; }
  return hash.digest('hex');
}

/** In-process cache of each log's prefix hash, keyed by path: re-hash only when ino/size/ctime changed (review item c). */
const logHashCache = new Map<string, LogMark>();
async function logMark(file: string): Promise<LogMark | null> {
  const st = await lstat(file).catch(() => null);
  if (!st?.isFile()) return null;
  const hit = logHashCache.get(file);
  if (hit && hit.ino === st.ino && hit.size === st.size && hit.ctimeMs === st.ctimeMs) return hit;
  const sha = await sha256(file, st.size);
  if (sha === null) return null;
  const mark: LogMark = { ino: st.ino, size: st.size, ctimeMs: st.ctimeMs, sha };
  logHashCache.set(file, mark);
  return mark;
}

/**
 * The project files the core never writes during any agent run, so a change to one is a tamper, not a core edit. These are
 * exactly the files that run or configure something OUTSIDE the sandbox (git config and hooks, the attributes that drive
 * filters, the agent's own CLAUDE/.claude/.mcp configuration). `.git/objects` is never walked.
 */
async function staticProtectedFiles(projectDir: string): Promise<string[]> {
  const out = [
    join(projectDir, 'CLAUDE.md'), join(projectDir, 'CLAUDE.local.md'), join(projectDir, '.mcp.json'),
    join(projectDir, '.gitattributes'),
    join(projectDir, '.git', 'config'), join(projectDir, '.git', 'HEAD'), join(projectDir, '.git', 'info', 'attributes'),
  ];
  out.push(...await filesUnder(join(projectDir, '.git', 'hooks')));
  out.push(...await filesUnder(join(projectDir, '.claude')));
  return out;
}

/**
 * The after-run integrity tripwire (decisions log 141). The sandbox denies writes to the protected records by path, so the
 * one way the agent reaches them is by moving a folder out of the sandbox and back (possible for a creative created during
 * the job, and under a workspace path with `[ ] * ?` or by moving the whole project folder). This arms before the run and
 * is checked after it (after the leftover processes are killed, for the kinds that kill).
 *
 * Two tiers:
 * - **Static files** (`staticProtectedFiles`): content + inode. The core never writes them during a run, so any change is a
 *   tamper → the job fails and the repo is quarantined. These carry the real risk (a `filter` driver in `.git/config`, a
 *   hook, the agent's own config).
 * - **Record folders** (`creatives/`, each creative, `outputs/`, `brand/proposals/`): inode and ctime, compared against the
 *   core's own recorded changes (`noteCoreChange`, exact values, no clock). A change the core did not make is a move → a
 *   warning (console agents reshape creatives through legitimate git operations, so it is not a hard fail). The logs' prefix
 *   bytes are checked too for glob roots.
 *
 * The whole-project-folder move is not watched by folder ctime (any top-level write in the project root changes it, so it
 * would false-positive): instead its dangerous payloads are caught by the static-file content check (a project move that
 * edits `.git/config`, a hook, `.claude/**`, `.mcp.json` or `CLAUDE*.md` fails the job), and `git-safety.ts` independently
 * refuses to run git with a config or attributes the core did not write. A project move that only rewrites a record file
 * (versions.json, a log) without touching a config/exec file is a documented residual on `[ ] * ?` roots.
 */
export async function armTripwire(projectDir: string, opts: { logs: boolean }): Promise<{ check(): Promise<TripwireResult> }> {
  const creatives = join(projectDir, 'creatives');
  const proposals = join(projectDir, 'brand', 'proposals');
  const slugs = await subdirs(creatives);

  // `outputs/` is not tracked: the core/agent create the new version folder `outputs/vN` inside it every turn, which would
  // false-positive. Changes to earlier `outputs/vK` are caught separately by the creative turn's output snapshot.
  const dirs = new Map<string, DirMark>();
  const markDir = async (d: string) => { const st = await lstat(d).catch(() => null); if (st?.isDirectory()) dirs.set(d, { ino: st.ino, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs }); };
  for (const d of [creatives, proposals, ...slugs]) await markDir(d);

  const files = new Map<string, FileMark>();
  for (const f of await staticProtectedFiles(projectDir)) {
    const st = await lstat(f).catch(() => null);
    if (!st?.isFile()) continue;
    const sha = await sha256(f);
    if (sha !== null) files.set(f, { ino: st.ino, size: st.size, sha });
  }

  const logs = new Map<string, LogMark>();
  if (opts.logs) {
    for (const f of [...slugs.map((s) => join(s, 'conversation.jsonl')), ...(await subdirs(proposals)).map((p) => join(p, PROPOSAL_LOG))]) {
      const mark = await logMark(f);
      if (mark) logs.set(f, mark);
    }
  }

  // A tracked folder changed since arm, and the core did not record a change to that same identity: a move.
  const explained = (cur: { ino: number; ctimeMs: number }, core: DirStamp | undefined) => core !== undefined && core.ino === cur.ino && core.ctimeMs === cur.ctimeMs;

  return {
    async check() {
      const tampered: string[] = [];
      for (const [f, mark] of files) {
        const st = await lstat(f).catch(() => null);
        const sha = st?.isFile() ? await sha256(f) : null;
        if (!st?.isFile() || st.ino !== mark.ino || st.size !== mark.size || sha !== mark.sha) tampered.push(relative(projectDir, f));
      }

      const moved: string[] = [];
      for (const [d, mark] of dirs) {
        const st = await lstat(d).catch(() => null);
        if (!st?.isDirectory() || st.ino !== mark.ino) {
          if (!explained({ ino: st?.ino ?? -1, ctimeMs: st?.ctimeMs ?? -1 }, lastCoreChange(d))) moved.push(relative(projectDir, d));
          continue;
        }
        if (st.mtimeMs === mark.mtimeMs && st.ctimeMs === mark.ctimeMs) continue;
        if (!explained({ ino: st.ino, ctimeMs: st.ctimeMs }, lastCoreChange(d))) moved.push(relative(projectDir, d));
      }

      const rewritten: string[] = [];
      for (const [f, mark] of logs) {
        const st = await lstat(f).catch(() => null);
        const ok = st?.isFile() && st.size >= mark.size && (await sha256(f, mark.size)) === mark.sha;
        if (!ok) rewritten.push(relative(projectDir, f));
      }
      return { tampered, moved, rewritten };
    },
  };
}

export function clearLogHashCacheForTests(): void { logHashCache.clear(); }
