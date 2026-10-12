import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  COMPOSITION_LIMITS, COMPOSITION_MAX_BYTES, compositionHash, compositionProblem, normalizeComposition, parseCompositionText, validateComposition,
  type Composition, type CompositionProblem, type FormatPreset,
} from '@motion-studio/shared';
import { withConfinedFile } from '../brand/agent-guard.ts';

/**
 * A composition folder as the core reads it (spec §3.1): every regular file, hashed through the confined-read checks, the
 * canonical `compositionHash`, and the parsed, normalised and validated `composition.json`. Shared by the render jobs (the
 * hash at render time is the render's `fromComposition`) and the turn's finalisation (Task 5b).
 *
 * The walk refuses what the server would refuse: a symlink, a hard-linked file (`nlink > 1`), anything but a regular file
 * or a folder; and it is bounded (files, depth, total size).
 */

export const MAX_COMPOSITION_FILES = 5000;
const MAX_DEPTH = 16;

export interface CompositionFile { path: string; sha256: string; size: number }

export interface CompositionFolder {
  files: CompositionFile[];
  /** `compositionHash` of `files`. */
  hash: string;
  /** For `validateComposition` (`ctx.files`). */
  sizes: ReadonlyMap<string, { size: number }>;
}

/**
 * Why a folder cannot be read as a composition: `link` (a symlink or hard link), `special` (not a file or folder), `limit`,
 * `unreadable`, `ambiguous` (two names equal once NFC-normalised: `compositionHash` refuses such a listing).
 */
export class CompositionFolderError extends Error {
  constructor(readonly reason: 'link' | 'special' | 'limit' | 'unreadable' | 'ambiguous', readonly path: string) {
    super(`composition folder: ${reason} at ${path || '.'}`);
    this.name = 'CompositionFolderError';
  }
}

/** Walks and hashes `compDir` (see the module comment). Throws `CompositionFolderError`. */
export async function readCompositionFolder(compDir: string, o: { maxBytes?: number } = {}): Promise<CompositionFolder> {
  const maxBytes = o.maxBytes ?? COMPOSITION_MAX_BYTES;
  const files: CompositionFile[] = [];
  let total = 0;
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new CompositionFolderError('limit', rel);
    const names = await readdir(rel ? join(compDir, ...rel.split('/')) : compDir).catch(() => { throw new CompositionFolderError('unreadable', rel); });
    for (const name of names.sort()) {
      const child = rel ? `${rel}/${name}` : name;
      const st = await lstat(join(compDir, ...child.split('/'))).catch(() => null);
      if (!st) continue; // gone meanwhile
      if (st.isSymbolicLink()) throw new CompositionFolderError('link', child);
      if (st.isDirectory()) { await walk(child, depth + 1); continue; }
      if (!st.isFile()) throw new CompositionFolderError('special', child);
      if (files.length >= MAX_COMPOSITION_FILES) throw new CompositionFolderError('limit', child);
      const r = await withConfinedFile(compDir, child, true, async (fh, info) => {
        const h = createHash('sha256');
        await pipeline(fh.createReadStream({ start: 0, autoClose: false }), h);
        return { sha256: h.digest('hex'), size: info.size };
      });
      if (r === null) continue;
      if ('skipped' in r) throw new CompositionFolderError(r.skipped === 'linked' || r.skipped === 'outside' ? 'link' : r.skipped === 'not-regular' ? 'special' : 'unreadable', child);
      total += r.size;
      if (total > maxBytes) throw new CompositionFolderError('limit', child);
      files.push({ path: child, ...r });
    }
  };
  await walk('', 0);
  let hash: string;
  try { hash = compositionHash(files); } catch {
    // Two names equal after NFC (e.g. one written in NFD by macOS, one in NFC): the listing has no single canonical form.
    const seen = new Set<string>();
    const dup = files.find((f) => { const k = f.path.normalize('NFC'); if (seen.has(k)) return true; seen.add(k); return false; });
    throw new CompositionFolderError('ambiguous', dup?.path ?? '');
  }
  return { files, hash, sizes: new Map(files.map((f) => [f.path.normalize('NFC'), { size: f.size }])) };
}

/** Reads `composition.json` of `compDir` (confined, bounded) and parses it. */
export async function readCompositionJson(compDir: string): Promise<{ ok: true; value: unknown } | { ok: false; problems: CompositionProblem[] }> {
  const r = await withConfinedFile(compDir, 'composition.json', true, async (fh, info) => {
    if (info.size > COMPOSITION_LIMITS.jsonBytes) return { bytes: null };
    const buf = Buffer.alloc(info.size + 1);
    let n = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
      if (n > info.size) return { bytes: null };
    }
    return { bytes: buf.subarray(0, n) };
  });
  if (r === null || 'skipped' in r) return { ok: false, problems: [compositionProblem('composition.jsonMissing')] };
  if (r.bytes === null) return { ok: false, problems: [compositionProblem('composition.jsonTooLarge', { sizeMB: 0, maxMB: COMPOSITION_LIMITS.jsonBytes / (1024 * 1024) })] };
  return parseCompositionText(r.bytes);
}

/** The problem of a folder `readCompositionFolder` refused. */
export function folderProblem(e: unknown): CompositionProblem {
  const path = e instanceof CompositionFolderError ? e.path : '';
  return e instanceof CompositionFolderError && e.reason === 'ambiguous'
    ? compositionProblem('composition.ambiguousNames', { path })
    : compositionProblem('composition.folderUnreadable', { path });
}

export type LoadedComposition =
  | { ok: true; composition: Composition; hash: string; folder: CompositionFolder; warnings: CompositionProblem[] }
  | { ok: false; problems: CompositionProblem[]; hash: string | null };

/**
 * A composition folder for one format, ready to render: hashed, then `composition.json` parsed, normalised
 * (`normalizeComposition`) and validated against the format. `ok: false` with the problems otherwise (a folder that
 * cannot be walked has `hash: null`).
 */
export async function loadComposition(compDir: string, format: FormatPreset): Promise<LoadedComposition> {
  let folder: CompositionFolder;
  try { folder = await readCompositionFolder(compDir); } catch (e) {
    return { ok: false, hash: null, problems: [folderProblem(e)] };
  }
  const parsed = await readCompositionJson(compDir);
  if (!parsed.ok) return { ok: false, hash: folder.hash, problems: parsed.problems };
  const composition = normalizeComposition(parsed.value);
  const v = validateComposition(composition, { format, files: folder.sizes });
  if (!v.ok) return { ok: false, hash: folder.hash, problems: v.problems };
  return { ok: true, composition: composition as Composition, hash: folder.hash, folder, warnings: v.warnings };
}
