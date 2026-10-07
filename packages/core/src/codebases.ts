import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { LinkedCodebase } from '@motion-studio/shared';

// Defined next to WorkspaceStore (which needs it) to avoid an import cycle.
export { normalizeCodebasePath, normalizeCodebaseList } from './workspace-store.ts';

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
/** Glob metacharacters in the path are escaped so a folder like `cb [x]` is matched literally. */
const escapeGlob = (p: string) => p.replace(/[\\[\]*?]/g, '\\$&');
export const readOnlyRules = (paths: string[]) => paths.map((p) => `Edit(/${escapeGlob(p)}/**)`);

export type Snapshot = { value: string } | { unavailable: 'not-git' | 'failed' };
export interface HashedRun { code: number; hash: string; stderr: string; timedOut: boolean }
export type HashedExec = (args: string[]) => Promise<HashedRun>;

/** Runs git without a shell, streaming stdout into a sha256 (no size limit); killed after the timeout. */
export const gitHashed = (path: string, timeoutMs = 30_000): HashedExec => (args) => new Promise((resolve) => {
  const hash = createHash('sha256');
  let stderr = '';
  let timedOut = false;
  let settled = false;
  const child = spawn('git', ['-C', path, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const done = (code: number) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, hash: hash.digest('hex'), stderr, timedOut }); } };
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  child.stdout.on('data', (d: Buffer) => hash.update(d));
  child.stderr.on('data', (d: Buffer) => { if (stderr.length < 2000) stderr += d.toString(); });
  child.on('error', () => done(-1));
  child.on('close', (code) => done(code ?? -1));
});

/**
 * Fingerprint of a git working tree: hash of the status (untracked files listed, ignored directories collapsed)
 * and of the content diff against HEAD, so editing an already-modified file changes it.
 */
export async function codebaseSnapshot(path: string, run: HashedExec = gitHashed(path)): Promise<Snapshot> {
  const status = await run(['status', '--porcelain=v1', '-uall', '--ignored=traditional']);
  if (status.timedOut) return { unavailable: 'failed' };
  if (status.code !== 0) return { unavailable: /not a git repository/i.test(status.stderr) ? 'not-git' : 'failed' };
  let diff = await run(['diff', 'HEAD', '--binary']);
  if (!diff.timedOut && diff.code !== 0) diff = await run(['diff', '--binary']); // repository without commits
  if (diff.timedOut || diff.code !== 0) return { unavailable: 'failed' };
  return { value: `${status.hash}:${diff.hash}` };
}
