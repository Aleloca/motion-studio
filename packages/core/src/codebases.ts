import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { LinkedCodebase } from '@motion-studio/shared';

// Defined next to WorkspaceStore (which needs it) to avoid an import cycle.
export { assertCodebasesOutside, CODEBASE_OVERLAP, codebaseOverlaps, normalizeCodebasePath, normalizeCodebaseList } from './workspace-store.ts';

export interface CodebaseCheck { path: string; note?: string; exists: boolean }

export async function checkCodebases(list: LinkedCodebase[]): Promise<CodebaseCheck[]> {
  const seen = new Set<string>();
  const out: CodebaseCheck[] = [];
  for (const c of list) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    const exists = Boolean((await stat(c.path).catch(() => null))?.isDirectory());
    out.push({ path: c.path, ...(c.note ? { note: c.note } : {}), exists });
  }
  return out;
}

/** Claude Code permission rule syntax: an absolute path is written with a leading '//'. */
/** Glob metacharacters in the path are escaped so a folder like `cb [x]` or `app {a,b}` is matched literally. */
export const escapeGlob = (p: string) => p.replace(/[\\[\]*?{}()!+@]/g, '\\$&');
export const dirDenyRules = (tools: string[], dirs: string[]) => dirs.flatMap((d) => tools.map((t) => `${t}(/${escapeGlob(d)}/**)`));
export const readOnlyRules = (paths: string[]) => dirDenyRules(['Edit'], paths);
/** Deny rules for each tool on each exact absolute file path (same escaping as readOnlyRules). */
export const fileDenyRules = (tools: string[], files: string[]) => files.flatMap((f) => tools.map((t) => `${t}(/${escapeGlob(f)})`));

export type Snapshot = { value: string } | { unavailable: 'not-git' | 'failed' };
export interface HashedRun { code: number; hash: string; stderr: string; timedOut: boolean }
export type HashedExec = (args: string[]) => Promise<HashedRun>;

/** Hooks and an fsmonitor command configured in a linked repository must never run from Motion Studio. */
const GIT_SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
// Stable, untranslated git output whatever the user's locale.
const GIT_ENV = () => ({ ...process.env, LC_ALL: 'C' });

/** Runs git without a shell, streaming stdout into a sha256 (no size limit); killed after the timeout. */
export const gitHashed = (path: string, timeoutMs = 30_000): HashedExec => (args) => new Promise((resolve) => {
  const hash = createHash('sha256');
  let stderr = '';
  let timedOut = false;
  let settled = false;
  const child = spawn('git', [...GIT_SAFE, '-C', path, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV() });
  const done = (code: number) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, hash: hash.digest('hex'), stderr, timedOut }); } };
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  child.stdout.on('data', (d: Buffer) => hash.update(d));
  child.stderr.on('data', (d: Buffer) => { if (stderr.length < 2000) stderr += d.toString(); });
  child.on('error', () => done(-1));
  child.on('close', (code) => done(code ?? -1));
});

/**
 * Hash of the contents of the untracked (not ignored) files under the folder: `git ls-files -o` streamed into
 * `git hash-object --stdin-paths`, so nothing is buffered whatever the number of files.
 */
export const untrackedContentHash = (path: string, timeoutMs = 30_000) => (): Promise<HashedRun> => new Promise((resolve) => {
  const hash = createHash('sha256');
  let stderr = '';
  let timedOut = false;
  let settled = false;
  const codes: Array<number | null> = [];
  const list = spawn('git', [...GIT_SAFE, '-C', path, 'ls-files', '-o', '--exclude-standard', '-z', '--', '.'], { stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV() });
  const hasher = spawn('git', [...GIT_SAFE, '-C', path, 'hash-object', '--stdin-paths'], { stdio: ['pipe', 'pipe', 'pipe'], env: GIT_ENV() });
  const finish = (code: number) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, hash: hash.digest('hex'), stderr, timedOut }); } };
  const timer = setTimeout(() => { timedOut = true; list.kill('SIGKILL'); hasher.kill('SIGKILL'); }, timeoutMs);
  const onClose = (code: number | null) => { codes.push(code); if (codes.length === 2) finish(codes.every((c) => c === 0) ? 0 : 1); };
  let pending = Buffer.alloc(0);
  list.stdout.on('data', (d: Buffer) => {
    pending = Buffer.concat([pending, d]); // split on NUL bytes first: a chunk may end inside a multi-byte character
    const parts: string[] = [];
    for (let i = pending.indexOf(0); i >= 0; i = pending.indexOf(0)) { parts.push(pending.subarray(0, i).toString('utf8')); pending = pending.subarray(i + 1); }
    // Nested repositories are listed as `dir/` (not hashable); hash-object reads one path per line.
    const paths = parts.filter((p) => p && !p.endsWith('/') && !p.includes('\n'));
    if (paths.length && !hasher.stdin.write(`${paths.join('\n')}\n`)) { list.stdout.pause(); hasher.stdin.once('drain', () => list.stdout.resume()); }
  });
  list.on('close', (code) => { hasher.stdin.end(); onClose(code); });
  hasher.stdin.on('error', () => { /* hasher died: its exit code reports it */ });
  hasher.stdout.on('data', (d: Buffer) => hash.update(d));
  for (const c of [list, hasher]) {
    c.stderr.on('data', (d: Buffer) => { if (stderr.length < 2000) stderr += d.toString(); });
    c.on('error', () => finish(-1));
  }
  hasher.on('close', onClose);
});

/**
 * Fingerprint of a git working tree, scoped to the linked folder (`-- .`): hash of the status (untracked files listed,
 * ignored directories collapsed), of the content diff against HEAD (editing an already-modified file changes it) and of
 * the untracked files' contents.
 */
export async function codebaseSnapshot(path: string, run: HashedExec = gitHashed(path), untracked: () => Promise<HashedRun> = untrackedContentHash(path)): Promise<Snapshot> {
  const status = await run(['status', '--porcelain=v1', '-uall', '--ignored=traditional', '--', '.']);
  if (status.timedOut) return { unavailable: 'failed' };
  if (status.code !== 0) return { unavailable: /not a git repository/i.test(status.stderr) ? 'not-git' : 'failed' };
  let diff = await run(['diff', 'HEAD', '--binary', '--', '.']);
  if (!diff.timedOut && diff.code !== 0) diff = await run(['diff', '--binary', '--', '.']); // repository without commits
  if (diff.timedOut || diff.code !== 0) return { unavailable: 'failed' };
  const extra = await untracked();
  if (extra.timedOut || extra.code !== 0) return { unavailable: 'failed' };
  return { value: `${status.hash}:${diff.hash}:${extra.hash}` };
}
