import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canFollow, type FollowCheck, type FormatPreset, type OutputFileInfo } from '@motion-studio/shared';
import { hashConfinedFile } from '../brand/agent-guard.ts';
import { noteCoreChange } from '../core-changes.ts';

/**
 * Carry-over and linked formats (spec §2.3–2.5): the core, not the agent, puts the files of the formats a turn does not
 * target into the new version folder. Every file is a byte copy (never a hard link: the confined reads refuse `nlink > 1`),
 * verified by sha256 after the copy.
 */

/**
 * Why a follower cannot take its primary's file: a `canFollow` reason, `fileSize` (the file is over the follower's
 * `maxFileMB`) or `unknown` (a format no longer in the catalog).
 */
export type FollowFailure = Extract<FollowCheck, { ok: false }>['reason'] | 'fileSize' | 'unknown';

/**
 * The target formats of a turn (spec §2.5): `requested` without formats outside the brief, each follower replaced by its
 * primary, no duplicates, in the brief's order; empty or absent means every primary.
 */
export function normalizeTargets(requested: readonly string[] | undefined, formats: readonly string[], links: Readonly<Record<string, string>>): string[] {
  const primaries = formats.filter((f) => !Object.hasOwn(links, f));
  const wanted = new Set((requested ?? []).filter((f) => formats.includes(f)).map((f) => (Object.hasOwn(links, f) ? links[f]! : f)));
  return wanted.size === 0 ? primaries : primaries.filter((f) => wanted.has(f));
}

/**
 * Whether `follower` can take the bytes of `primaryOut` (spec §2.3), checked on the real file: `canFollow` with the
 * primary's actual duration (null, i.e. unknown, is strict) and the follower's `maxFileMB` against the file's size.
 */
export function followCheck(primary: FormatPreset, follower: FormatPreset, primaryOut: Pick<OutputFileInfo, 'durationSec'>, sizeBytes: number): { ok: true } | { ok: false; reason: FollowFailure } {
  const c = canFollow(primary, follower, primaryOut.durationSec);
  if (!c.ok) return c;
  if (follower.maxFileMB !== undefined && sizeBytes / 1e6 > follower.maxFileMB) return { ok: false, reason: 'fileSize' };
  return { ok: true };
}

/** `creativeDir`/`rel` is a regular, single-linked file whose real path is exactly that path (no symlinked folder on the way). */
export async function isConfinedFile(creativeDir: string, rel: string): Promise<{ size: number } | null> {
  const abs = join(creativeDir, ...rel.split('/'));
  if (rel.split('/').includes('..')) return null;
  const [info, real, realBase] = await Promise.all([lstat(abs).catch(() => null), realpath(abs).catch(() => null), realpath(creativeDir).catch(() => null)]);
  if (!info?.isFile() || info.nlink !== 1 || !real || !realBase || real !== join(realBase, ...rel.split('/'))) return null;
  return { size: info.size };
}

/**
 * Makes `outputs/v<n>` a real folder of the creative: an entry the agent left there that is not a folder (a symlink, a file)
 * is removed as an entry, never followed (returns true then). Throws when the folder resolves elsewhere (e.g. `outputs`
 * itself is a link).
 */
export async function versionDirReady(creativeDir: string, n: number): Promise<boolean> {
  const dir = join(creativeDir, 'outputs', `v${n}`);
  const info = await lstat(dir).catch(() => null);
  const replaced = info !== null && !info.isDirectory();
  if (replaced) await rm(dir, { force: true });
  if (!info || replaced) {
    await mkdir(dir, { recursive: true });
    await noteCoreChange(creativeDir);
    await noteCoreChange(join(creativeDir, 'outputs'));
  }
  const [real, realBase] = await Promise.all([realpath(dir).catch(() => null), realpath(creativeDir).catch(() => null)]);
  if (!real || !realBase || real !== join(realBase, 'outputs', `v${n}`)) throw new Error(`outputs/v${n} is not a folder of the creative`);
  return replaced;
}

/**
 * Copies `fromRel` to `toRel` (both under `creativeDir`; `toRel` must not exist) and proves the copy is the expected
 * content: its sha256 must equal `expected`, taken by the caller from a trusted reference (the hash recorded for the base
 * version, or one computed before the agent ran). The source's current bytes are never trusted: on a mismatch the copy is
 * removed. The source must be a confined regular file. Returns the copy's sha256, or null (nothing left at `toRel`).
 * A clone (copy-on-write) where the volume supports it, a full copy otherwise: never a hard link.
 */
export async function copyVerified(creativeDir: string, fromRel: string, toRel: string, expected: string): Promise<string | null> {
  if (!(await isConfinedFile(creativeDir, fromRel))) return null;
  const dest = join(creativeDir, ...toRel.split('/'));
  try {
    await copyFile(join(creativeDir, ...fromRel.split('/')), dest, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  } catch (err) {
    console.warn(`Motion Studio: cannot copy ${fromRel} to ${toRel}: ${(err as Error).message}`);
    return null;
  }
  const copy = await hashConfinedFile(creativeDir, toRel);
  if (copy === null || 'skipped' in copy || copy.sha256 !== expected) {
    console.warn(`Motion Studio: the copy of ${fromRel} to ${toRel} does not match the expected content; it was removed`);
    await rm(dest, { force: true });
    return null;
  }
  return copy.sha256;
}

/** sha256 of a confined regular file, or null (missing, a link, unreadable). */
export async function confinedSha(creativeDir: string, rel: string): Promise<string | null> {
  const h = await hashConfinedFile(creativeDir, rel);
  return h && !('skipped' in h) ? h.sha256 : null;
}

/** The creative's `outputs/v<k>` folders other than `v<n>` (real folders only, a link is not one), as `v<k>` names. */
export async function earlierOutputDirs(creativeDir: string, n: number): Promise<string[]> {
  const names = await readdir(join(creativeDir, 'outputs')).catch(() => [] as string[]);
  const out: string[] = [];
  for (const name of names) {
    if (!/^v\d+$/.test(name) || name === `v${n}`) continue;
    if ((await lstat(join(creativeDir, 'outputs', name)).catch(() => null))?.isDirectory()) out.push(name);
  }
  return out.sort();
}

/**
 * A cheap fingerprint of every entry under the given `outputs/v<k>` folders (path → type, size, mtime, inode), to tell
 * afterwards which earlier files the turn changed, added or removed. Output folders are not versioned in git, so this
 * is how the core notices writes into earlier versions.
 */
export async function snapshotOutputs(creativeDir: string, dirs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string, depth: number) => {
    const entries = await readdir(join(creativeDir, ...rel.split('/'))).catch(() => [] as string[]);
    for (const name of entries) {
      const child = `${rel}/${name}`;
      const info = await lstat(join(creativeDir, ...child.split('/'))).catch(() => null);
      if (!info) continue;
      out.set(child, `${info.isDirectory() ? 'd' : info.isSymbolicLink() ? 'l' : 'f'}:${info.size}:${info.mtimeMs}:${info.ino}`);
      if (info.isDirectory() && depth < 4) await walk(child, depth + 1);
    }
  };
  for (const d of dirs) await walk(`outputs/${d}`, 0);
  return out;
}

/** The paths that differ between two snapshots (changed, added or removed), sorted. */
export function snapshotChanges(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((k) => before.get(k) !== after.get(k)).sort();
}
