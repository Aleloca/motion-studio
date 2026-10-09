import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canFollow, type FollowCheck, type FormatPreset, type OutputFileInfo } from '@motion-studio/shared';
import { hashConfinedFile } from '../brand/agent-guard.ts';

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
 * is removed as an entry, never followed. Throws when the folder resolves elsewhere (e.g. `outputs` itself is a link).
 */
export async function versionDirReady(creativeDir: string, n: number): Promise<void> {
  const dir = join(creativeDir, 'outputs', `v${n}`);
  const info = await lstat(dir).catch(() => null);
  if (info && !info.isDirectory()) await rm(dir, { force: true });
  if (!info || !info.isDirectory()) await mkdir(dir, { recursive: true });
  const [real, realBase] = await Promise.all([realpath(dir).catch(() => null), realpath(creativeDir).catch(() => null)]);
  if (!real || !realBase || real !== join(realBase, 'outputs', `v${n}`)) throw new Error(`outputs/v${n} is not a folder of the creative`);
}

/**
 * Copies `fromRel` to `toRel` (both under `creativeDir`; `toRel` must not exist) and proves the copy byte-identical: the
 * copy's sha256 must equal `expected` (the source's recorded hash) or, when there is none or it differs, the source's
 * current hash. The source must be a confined regular file. Returns the copy's sha256, or null (nothing left at `toRel`).
 * A clone (copy-on-write) where the volume supports it, a full copy otherwise: never a hard link.
 */
export async function copyVerified(creativeDir: string, fromRel: string, toRel: string, expected?: string): Promise<string | null> {
  if (!(await isConfinedFile(creativeDir, fromRel))) return null;
  const dest = join(creativeDir, ...toRel.split('/'));
  try {
    await copyFile(join(creativeDir, ...fromRel.split('/')), dest, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  } catch (err) {
    console.warn(`Motion Studio: cannot copy ${fromRel} to ${toRel}: ${(err as Error).message}`);
    return null;
  }
  const copy = await hashConfinedFile(creativeDir, toRel);
  let ok = copy !== null && !('skipped' in copy) && copy.sha256 === expected;
  if (!ok && copy && !('skipped' in copy)) {
    const source = await hashConfinedFile(creativeDir, fromRel);
    ok = source !== null && !('skipped' in source) && source.sha256 === copy.sha256;
    if (ok && expected !== undefined) console.warn(`Motion Studio: ${fromRel} changed since it was recorded; its current content was carried`);
  }
  if (!ok || !copy || 'skipped' in copy) {
    console.warn(`Motion Studio: the copy of ${fromRel} to ${toRel} could not be verified; it was removed`);
    await rm(dest, { force: true });
    return null;
  }
  return copy.sha256;
}
