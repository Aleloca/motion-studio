import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { checkLink, effectiveLinks, formatHistory, starOf, type CreativeFile, type FormatPreset, type FormatSummary, type VersionEntry } from '@motion-studio/shared';

/**
 * The output file of `formatId` in version `n` is usable: a regular, single-linked file on disk (a symlink or a hard link is
 * refused, as by the hashing and the export).
 */
export async function outputFileExists(creativeDir: string, versions: VersionEntry[], n: number, formatId: string): Promise<boolean> {
  const file = versions.find((v) => v.n === n)?.outputs.find((o) => o.format === formatId)?.file;
  if (!file) return false;
  const info = await lstat(join(creativeDir, 'outputs', `v${n}`, file)).catch(() => null);
  return Boolean(info?.isFile() && info.nlink === 1);
}

/**
 * One summary per brief format, in the brief's order (spec §2.1–2.3): history, ★ (effective links) and linkable primaries.
 * `starFileMissing`: the file export would copy is unusable (a follower: its own file in its primary's ★ version).
 */
export async function formatSummaries(creativeDir: string, creative: CreativeFile, versions: VersionEntry[], presets: FormatPreset[]): Promise<FormatSummary[]> {
  const { brief } = creative;
  const links = effectiveLinks(brief.links, brief.formats);
  return Promise.all(brief.formats.map(async (id) => {
    const star = starOf(versions, id, creative.exportPicks, links);
    // A follower is exported as its own file in its primary's ★ version: that is the file that must be usable.
    const exported = star.follows !== null ? starOf(versions, star.follows, creative.exportPicks, links).version : star.version;
    return {
      id,
      history: formatHistory(versions, id),
      star,
      starFileMissing: exported !== null && !(await outputFileExists(creativeDir, versions, exported, id)),
      linkable: brief.formats.filter((p) => p !== id).map((primary) => {
        const c = checkLink(brief, versions, presets, id, primary);
        return c.ok ? { primary, ok: true } : { primary, ok: false, reason: c.reason };
      }),
    };
  }));
}
