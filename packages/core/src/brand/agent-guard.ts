import { randomBytes } from 'node:crypto';
import { lstat, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileDenyRules } from '../codebases.ts';
import { fileLock } from '../file-locks.ts';

/** The project's live metadata: brand jobs' agents work on copies and must never write these. */
export const GUARDED_FILES = ['brand/brand-kit.json', 'brand/guidelines.md', 'brand/sources.json', 'assets/assets.json', 'references/references.json'] as const;
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

const absOf = (projectDir: string, rel: string) => join(projectDir, ...rel.split('/'));

/** Deny rules on the guarded files for every file-editing tool (also under the project's real path when it differs). */
export async function guardRules(projectDir: string): Promise<string[]> {
  const real = await realpath(projectDir).catch(() => projectDir);
  const roots = real === projectDir ? [projectDir] : [projectDir, real];
  return fileDenyRules(EDIT_TOOLS, roots.flatMap((r) => GUARDED_FILES.map((f) => absOf(r, f))));
}

interface GuardedFile { rel: string; abs: string; bytes: Buffer | null | undefined; writes: number }
export type GuardSnapshot = GuardedFile[];

/** Bytes (null = missing, undefined = unreadable, never restored) and app-write counter of each guarded file, read under its lock. */
export function snapshotGuarded(projectDir: string): Promise<GuardSnapshot> {
  return Promise.all(GUARDED_FILES.map((rel) => {
    const abs = absOf(projectDir, rel);
    return fileLock.run(abs, async () => ({
      rel, abs, writes: fileLock.writeCount(abs),
      bytes: await readFile(abs).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : undefined)),
    }));
  }));
}

async function sameContent(abs: string, bytes: Buffer | null): Promise<boolean> {
  const info = await lstat(abs).catch(() => null);
  if (!info) return bytes === null;
  if (!info.isFile() || bytes === null) return false;
  return (await readFile(abs)).equals(bytes);
}

/**
 * Puts back the pre-turn bytes of every guarded file the agent changed (an interpreter can bypass the deny rules).
 * Under each file's lock, and only when the app did not write the file meanwhile: an app write is the user's,
 * built on what was on disk at that moment, and wins. Returns the project-relative paths restored.
 */
export async function restoreGuarded(snapshot: GuardSnapshot): Promise<string[]> {
  const restored: string[] = [];
  for (const g of snapshot) {
    if (g.bytes === undefined) continue;
    const bytes = g.bytes;
    await fileLock.run(g.abs, async () => {
      if (fileLock.writeCount(g.abs) !== g.writes || await sameContent(g.abs, bytes)) return;
      const info = await lstat(g.abs).catch(() => null);
      if (info && !info.isFile() && !info.isSymbolicLink()) await rm(g.abs, { recursive: true, force: true });
      if (bytes === null) await rm(g.abs, { force: true });
      else {
        // A symlink in its place is replaced, never followed.
        const tmp = `${g.abs}.${randomBytes(6).toString('hex')}.tmp`;
        try { await writeFile(tmp, bytes, { flag: 'wx' }); await rename(tmp, g.abs); }
        catch (err) { await unlink(tmp).catch(() => {}); throw err; }
      }
      restored.push(g.rel);
    });
  }
  return restored;
}

export const tamperNote = (rel: string) => `L'agente ha provato a modificare direttamente ${rel}: modifica annullata`;

export const MAX_AGENT_FILE_BYTES = 1024 * 1024;
export type AgentFile = { text: string } | { skipped: string } | null;

/** A file the agent wrote: only a regular file (no symlink) up to the size limit is read; null when missing. */
export async function readAgentFile(path: string, maxBytes = MAX_AGENT_FILE_BYTES): Promise<AgentFile> {
  const info = await lstat(path).catch(() => null);
  if (!info) return null;
  if (!info.isFile()) return { skipped: 'non è un file regolare' };
  if (info.size > maxBytes) return { skipped: 'file troppo grande' };
  return { text: await readFile(path, 'utf8') };
}
