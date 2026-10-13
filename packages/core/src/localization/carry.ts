import type { Locale, VersionEntry } from '@motion-studio/shared';
import { finishOverlay, readOverlay, rowAssetHashes, voiceRootsOf, writeOverlay, type InstanceComposition } from './store.ts';
import { voiceFileOk, withoutGone } from './validate.ts';

/** A version folder of a creative: the creative folder and the version (the previous one, recorded) or its number (the new one). */
export interface VersionDir { creativeDir: string; n: number; version?: VersionEntry }

/**
 * Carries the localization overlays of `prev` into the new version `next` (spec §3.3, Review Focus 2), whatever made it (a
 * turn, a direct edit, a duplicate): for each row of `prev` whose instance still has a composition in `next`:
 * - entries whose clip (or param) still exists, of the same kind, are kept; their `source` stays the one translated, so an
 *   entry whose source text changed is listed in `stale` (preview and render show the source text for it, never the old
 *   translation), and "Translate" redoes it;
 * - entries whose clip is gone are dropped (with their `fit`);
 * - a voice whose clip's script changed is `stale`, and so is one whose file the new version does not have;
 * - an overlay left with no entry, or whose file is unreadable or no longer the recorded one, is not carried.
 * The overlays are written into `next` (`writeOverlay`) and the rows returned for its `VersionEntry.localizations`, with
 * the problems of the localized composition checked again (`finishOverlay`). Nothing of `prev` is changed.
 */
export async function carryLocalizations(prev: VersionDir, next: VersionDir, nextCompositions: Map<string, InstanceComposition>,
  o: { projectDir: string; uiLocale: Locale }): Promise<VersionEntry['localizations']> {
  const rows = prev.version?.localizations ?? [];
  const out: NonNullable<VersionEntry['localizations']> = [];
  for (const row of rows) {
    const base = nextCompositions.get(row.instanceId);
    if (!base) continue;
    const read = await readOverlay(prev.creativeDir, prev.n, row.locale, row.instanceId);
    if (!read || read.hash !== row.hash) continue;
    const overlay = withoutGone(read.overlay, base.composition);
    if (Object.keys(overlay.texts).length + Object.keys(overlay.params).length + Object.keys(overlay.voices).length === 0) continue;
    const voiceRoots = voiceRootsOf(base, o.projectDir);
    const missingVoices: string[] = [];
    for (const [id, v] of Object.entries(overlay.voices)) if (!(await voiceFileOk(voiceRoots, v.src))) missingVoices.push(id);
    const done = await finishOverlay({
      overlay, base, voice: row.voice, chooseFit: new Set(), uiLocale: o.uiLocale, projectDir: o.projectDir, voiceRoots, extraStale: missingVoices,
    });
    const hash = await writeOverlay(next.creativeDir, next.n, done.overlay);
    // Ruling L: the hashes of the files the kept entries still use go along.
    // Verbatim from the previous row (never recomputed from the new composition folder, which the agent wrote).
    const assetHashes = rowAssetHashes({ overlay: done.overlay, ...(row.assetHashes ? { old: row.assetHashes } : {}) });
    out.push({
      locale: row.locale, instanceId: row.instanceId, hash, origin: row.origin, stale: done.stale, voice: row.voice,
      ...(row.voiceFallback ? { voiceFallback: row.voiceFallback } : {}), ...(row.noScript ? { noScript: row.noScript } : {}),
      ...(assetHashes ? { assetHashes } : {}),
      ...(done.problems.length ? { problems: done.problems } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

