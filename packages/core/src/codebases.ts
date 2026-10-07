import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { LinkedCodebase } from '@motion-studio/shared';
import { execCommand, type CommandExec } from './exec.ts';

// Defined next to WorkspaceStore (which needs it) to avoid an import cycle.
export { normalizeCodebasePath } from './workspace-store.ts';

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

/**
 * Fingerprint of a git working tree: status (untracked and ignored files included) plus a hash of the
 * content diff against HEAD, so editing an already-modified file changes it. Null when it cannot be computed.
 */
export async function codebaseSnapshot(path: string, exec: CommandExec = execCommand): Promise<string | null> {
  const run = (...args: string[]) => exec('git', ['-C', path, ...args], { timeoutMs: 30_000 });
  const status = await run('status', '--porcelain=v1', '-uall', '--ignored');
  if (status.code !== 0) return null;
  let diff = await run('diff', 'HEAD', '--binary');
  if (diff.code !== 0) diff = await run('diff', '--binary'); // repository without commits
  if (diff.code !== 0) return null;
  return `${status.stdout.trim()}\n#diff ${createHash('sha256').update(diff.stdout).digest('hex')}`;
}
