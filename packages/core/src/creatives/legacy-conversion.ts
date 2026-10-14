import { rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { hasFormat, type FormatPreset, type VersionEntry } from '@motion-studio/shared';
import { noteCoreChange } from '../core-changes.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { findPreset } from '../formats/format-catalog.ts';
import { isConfinedFile } from './carry-over.ts';
import { realDirChain, writeThroughTemp } from './core-files.ts';

/**
 * Converting a legacy creative (Task 6, spec §7). A legacy version has rendered files and a v1 manifest, no compositions.
 * The next change turn rebuilds each of its formats as a composition and applies the user's request; the agent looks at
 * reference frames of the old media, which the core extracts into the protected cache (the agent can read `.studio`, never
 * write it), through real directories and a fresh temp file renamed into place (the same helpers as the pin frames).
 */

/**
 * The version whose media a target `format` is converted from, or null when the format has nothing legacy to convert.
 * Decided per format (review of Task 6): the base itself when it has the format as media; when the base has neither a
 * composition nor media for it (an incomplete or partial conversion, or a format added since), the latest earlier version
 * that has it as legacy media. A format with a composition anywhere on the way is already converted: null.
 */
export function legacySourceFor(versions: readonly VersionEntry[], base: VersionEntry | undefined, format: string): VersionEntry | null {
  if (!base || base.compositions?.some((c) => c.format === format)) return null;
  if (base.compositions === undefined && base.outputs.some((o) => o.format === format)) return base;
  if (base.compositions !== undefined && base.outputs.some((o) => o.format === format)) return null;
  for (const v of [...versions].filter((x) => x.n < base.n).sort((a, b) => b.n - a.n)) {
    if (v.compositions?.some((c) => c.format === format)) return null;
    if (v.outputs.some((o) => o.format === format)) return v;
  }
  return null;
}

/** Targets of a conversion: format → the legacy version it is converted from; `created`: targets the base does not have at all. */
export function conversionPlan(versions: readonly VersionEntry[], base: VersionEntry | undefined, targets: readonly string[]): { sources: Array<{ format: string; version: VersionEntry }>; created: string[] } {
  const sources: Array<{ format: string; version: VersionEntry }> = [];
  const created: string[] = [];
  for (const format of targets) {
    const version = legacySourceFor(versions, base, format);
    if (version) sources.push({ format, version });
    else if (base && !hasFormat(base, format)) created.push(format);
  }
  return { sources, created };
}

export const REFERENCE_FRAME_WIDTH = 540;
export const REFERENCE_FRAME_MAX = 12;

/** A version with rendered media to convert: no compositions (v1 manifest) and at least one output file. */
export function isLegacyVersion(v: VersionEntry | undefined): v is VersionEntry {
  return v !== undefined && v.compositions === undefined && v.outputs.length > 0;
}

/** Times (seconds) of the reference frames: one per second, at most 12 (spread over the clip when it is longer); a still has one. */
export function referenceTimes(kind: 'video' | 'image', durationSec: number | null | undefined): number[] {
  if (kind === 'image' || !(typeof durationSec === 'number' && durationSec > 0)) return [0];
  const count = Math.min(REFERENCE_FRAME_MAX, Math.max(1, Math.ceil(durationSec)));
  // Up to 12 s: 0, 1, 2…; longer: evenly spread (still starting at 0, never past the end).
  const step = durationSec <= REFERENCE_FRAME_MAX ? 1 : durationSec / REFERENCE_FRAME_MAX;
  return Array.from({ length: count }, (_, i) => Math.min(Math.round(i * step * 100) / 100, Math.max(0, durationSec - 0.05)));
}

export interface LegacyFormatReference {
  format: string;
  /** The legacy version this format is converted from. */
  version: number;
  /** The old media, relative to the project (the agent may read it for assets). */
  source: string;
  kind: 'video' | 'image';
  durationSec: number | null;
  /** Reference frames, relative to the project, in time order (empty when none could be made). */
  frames: Array<{ file: string; t: number }>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Removes the reference frames of version `n` (`.studio/cache/reference-frames/<creative>/v<n>`), as an entry, never
 * followed. A turn that is no longer a conversion calls it too, so a folder left by an earlier try does not stay (C11).
 */
export async function clearReferenceFrames(projectDir: string, creativeSlug: string, n: number): Promise<void> {
  try {
    const parent = await realDirChain(projectDir, ['.studio', 'cache', 'reference-frames', creativeSlug]);
    if (parent) { await rm(join(parent, `v${n}`), { recursive: true, force: true }); await noteCoreChange(parent); }
  } catch { /* optional help */ }
}

/**
 * Reference frames of every `formats` entry the base delivers, into
 * `.studio/cache/reference-frames/<creative>/v<n>/<format>/<i>.jpg` (540 px wide, 1 per second, at most 12). The media is read
 * through the confined helpers (regular file, one link, real path inside the version's outputs). A format whose media cannot
 * be read or has no frames is listed without frames; nothing here throws.
 */
export async function extractReferenceFrames(o: {
  projectDir: string; creativeDir: string; creativeSlug: string; n: number; sources: ReadonlyArray<{ format: string; version: VersionEntry }>;
  presets: readonly FormatPreset[]; media: MediaTools;
}): Promise<LegacyFormatReference[]> {
  const out: LegacyFormatReference[] = [];
  // The whole folder of this version goes first (also formats no longer converted): removed as an entry, never followed.
  await clearReferenceFrames(o.projectDir, o.creativeSlug, o.n);
  for (const { format, version: src } of o.sources) {
    const output = src.outputs.find((x) => x.format === format);
    if (!output) continue;
    const kind = findPreset(o.presets, format)?.kind ?? (/\.(png|jpe?g|webp|gif)$/i.test(output.file) && output.durationSec == null ? 'image' : 'video');
    const rel = `outputs/v${src.n}/${output.file}`;
    const ref: LegacyFormatReference = { format, version: src.n, source: relative(o.projectDir, join(o.creativeDir, ...rel.split('/'))).split(sep).join('/'), kind, durationSec: output.durationSec ?? null, frames: [] };
    out.push(ref);
    try {
      if (!o.media.available || !SAFE_ID.test(format) || !(await isConfinedFile(o.creativeDir, rel))) continue;
      const dir = await realDirChain(o.projectDir, ['.studio', 'cache', 'reference-frames', o.creativeSlug, `v${o.n}`, format]);
      if (!dir) continue;
      const abs = join(o.creativeDir, ...rel.split('/'));
      for (const [i, t] of referenceTimes(kind, output.durationSec).entries()) {
        const name = `${String(i + 1).padStart(2, '0')}.jpg`;
        const made = await writeThroughTemp(dir, name, (temp) => o.media.frame(abs, temp, t, { width: REFERENCE_FRAME_WIDTH })).catch(() => false);
        if (made) ref.frames.push({ file: relative(o.projectDir, join(dir, name)).split(sep).join('/'), t });
      }
    } catch {
      // Reference frames are optional help: the conversion goes on with what was made.
    }
  }
  return out;
}
