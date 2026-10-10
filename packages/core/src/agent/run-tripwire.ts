import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { lastCoreChange } from '../core-changes.ts';
import { PROPOSAL_LOG } from './protected-links.ts';

/** Seconds-resolution clocks and float ms: a folder time this close after the core's own change is that change. */
const CORE_SLACK_MS = 5;

interface DirMark { ino: number; mtimeMs: number; ctimeMs: number }
interface LogMark { size: number; sha: string }
export interface TripwireResult {
  /** Folders (relative to the project) whose entries or identity changed in a way the core did not make. */
  moved: string[];
  /** Append-only logs whose bytes from the start of the run were rewritten or cut. */
  rewritten: string[];
}

const isRealDir = async (p: string) => (await lstat(p).catch(() => null))?.isDirectory() === true;
async function subdirs(parent: string): Promise<string[]> {
  if (!(await isRealDir(parent))) return [];
  const names = await readdir(parent).catch(() => [] as string[]);
  const checked = await Promise.all(names.map(async (n) => ((await isRealDir(join(parent, n))) ? join(parent, n) : null)));
  return checked.filter((n): n is string => n !== null);
}

async function prefixSha(file: string, size: number): Promise<string | null> {
  if (size === 0) return createHash('sha256').digest('hex');
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(file, { start: 0, end: size - 1 })) hash.update(chunk as Buffer);
  } catch { return null; }
  return hash.digest('hex');
}

/**
 * A tripwire for moves around the sandbox (decisions log 141). The sandbox denies writes to the protected records by path,
 * so moving their folder elsewhere, editing and moving it back escapes it wherever the folder itself is not pinned: a
 * creative created during the job (glob-only cover) and, under a workspace path with `[ ] * ?`, every creative,
 * `creatives/` and `outputs/` (Claude Code pins ancestors only up to the first glob character).
 *
 * Armed before the run, checked after it (after its leftover processes are killed):
 * - folders: `creatives/`, `brand/proposals/` and each `creatives/<slug>/` (inode, mtime, ctime). A move out and back
 *   changes the moved folder's ctime and its parent's mtime. Changes the core made itself are left out: each core change
 *   to a folder's entries is recorded (`noteCoreChange`) and a folder whose times are not later than that is explained.
 *   A move done before a later core change to the same folder is not seen (documented limit).
 * - logs (`logs: true`, used for workspace paths with glob characters): size and sha256 of each conversation and proposal
 *   log at the start; at the end the same byte range must be unchanged (the core only appends). New forged lines after
 *   that range are not detected, rewritten history is.
 */
export async function armTripwire(projectDir: string, opts: { logs: boolean }): Promise<{ check(): Promise<TripwireResult> }> {
  const startedAt = Date.now();
  const creatives = join(projectDir, 'creatives');
  const proposals = join(projectDir, 'brand', 'proposals');
  const slugs = await subdirs(creatives);
  const dirs = new Map<string, DirMark>();
  for (const d of [creatives, proposals, ...slugs]) {
    const st = await lstat(d).catch(() => null);
    if (st?.isDirectory()) dirs.set(d, { ino: st.ino, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
  }
  const logs = new Map<string, LogMark>();
  if (opts.logs) {
    const files = [...slugs.map((s) => join(s, 'conversation.jsonl')), ...(await subdirs(proposals)).map((p) => join(p, PROPOSAL_LOG))];
    for (const f of files) {
      const st = await lstat(f).catch(() => null);
      if (!st?.isFile()) continue;
      const sha = await prefixSha(f, st.size);
      if (sha) logs.set(f, { size: st.size, sha });
    }
  }
  const coreSince = (dir: string) => { const t = lastCoreChange(dir); return t !== undefined && t >= startedAt ? t : undefined; };
  return {
    async check() {
      const moved: string[] = [];
      for (const [d, mark] of dirs) {
        const st = await lstat(d).catch(() => null);
        if (!st?.isDirectory() || st.ino !== mark.ino) {
          // Removed or replaced: only the core's own change to the parent explains it.
          if (coreSince(dirname(d)) === undefined) moved.push(relative(projectDir, d));
          continue;
        }
        if (st.mtimeMs === mark.mtimeMs && st.ctimeMs === mark.ctimeMs) continue;
        const t = coreSince(d);
        if (t === undefined || Math.max(st.mtimeMs, st.ctimeMs) > t + CORE_SLACK_MS) moved.push(relative(projectDir, d));
      }
      const rewritten: string[] = [];
      for (const [f, mark] of logs) {
        const st = await lstat(f).catch(() => null);
        const ok = st?.isFile() && st.size >= mark.size && (await prefixSha(f, mark.size)) === mark.sha;
        if (!ok) rewritten.push(relative(projectDir, f));
      }
      return { moved, rewritten };
    },
  };
}
