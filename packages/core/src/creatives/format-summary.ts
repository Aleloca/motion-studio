import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { checkLink, effectiveLinks, followerVersion, formatHistory, starOf, type CreativeFile, type FormatPreset, type FormatSummary, type VersionEntry } from '@motion-studio/shared';

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
 * `exportVersion`: the version whose file export copies (a follower: `followerVersion` of its primary's ★, decisions log 140).
 * `starFileMissing`: that file is unusable, or a follower has no qualifying version at all.
 */
export async function formatSummaries(creativeDir: string, creative: CreativeFile, versions: VersionEntry[], presets: FormatPreset[]): Promise<FormatSummary[]> {
  const { brief } = creative;
  const links = effectiveLinks(brief.links, brief.formats);
  return Promise.all(brief.formats.map(async (id) => {
    const star = starOf(versions, id, creative.exportPicks, links);
    // A follower is exported as its own file in the latest version where that file is byte-identical to the primary's ★ file.
    const primaryStar = star.follows !== null ? starOf(versions, star.follows, creative.exportPicks, links).version : null;
    const exported = star.follows !== null ? followerVersion(versions, id, primaryStar, links) : star.version;
    const missing = star.follows !== null
      ? primaryStar !== null && (exported === null || !(await outputFileExists(creativeDir, versions, exported, id)))
      : exported !== null && !(await outputFileExists(creativeDir, versions, exported, id));
    return {
      id,
      history: formatHistory(versions, id),
      star,
      exportVersion: exported,
      starFileMissing: missing,
      linkable: brief.formats.filter((p) => p !== id).map((primary) => {
        const c = checkLink(brief, versions, presets, id, primary);
        return c.ok ? { primary, ok: true } : { primary, ok: false, reason: c.reason };
      }),
    };
  }));
}
