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
export const readOnlyRules = (paths: string[]) => paths.map((p) => `Edit(/${p}/**)`);

export async function codebaseSnapshot(path: string, exec: CommandExec = execCommand): Promise<string | null> {
  const r = await exec('git', ['-C', path, 'status', '--porcelain=v1', '-uall'], { timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}
