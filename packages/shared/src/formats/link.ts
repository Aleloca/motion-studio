import type { FormatPreset } from '../formats.ts';
import type { VersionEntry } from '../creative.ts';

export type FollowCheck = { ok: true } | { ok: false; reason: 'kind' | 'size' | 'extension' | 'duration' | 'safeZone' };

/**
 * Whether `follower` can take a byte-identical copy of `primary`'s file (spec §2.3). Checked in this order:
 * - `kind`: same kind (video or image);
 * - `size`: same width and height;
 * - `extension`: the follower accepts every extension the primary may deliver, so any primary file is valid for it;
 * - `duration` (video followers with a `maxDurationSec` only): the primary's duration fits the follower's limit. An unknown
 *   duration (`null`) is ok only when the follower has no limit; otherwise it is `duration`, since it cannot be proven to fit;
 * - `safeZone`: the follower's safe area contains the primary's, so content placed safely for the primary is safe on the
 *   follower too. The safe zones are insets from the edges and the sizes are equal, so this means every follower inset is
 *   <= the primary's. When either preset has no `safeZone` in the catalog, the size check alone decides (no data to compare).
 */
export function canFollow(primary: FormatPreset, follower: FormatPreset, primaryDurationSec: number | null): FollowCheck {
  return check(primary, follower, primaryDurationSec, true);
}

function check(primary: FormatPreset, follower: FormatPreset, durationSec: number | null, checkDuration: boolean): FollowCheck {
  if (primary.kind !== follower.kind) return { ok: false, reason: 'kind' };
  if (primary.width !== follower.width || primary.height !== follower.height) return { ok: false, reason: 'size' };
  if (!primary.extensions.every((e) => follower.extensions.includes(e))) return { ok: false, reason: 'extension' };
  if (checkDuration && follower.kind === 'video' && follower.maxDurationSec !== undefined
    && (durationSec === null || durationSec > follower.maxDurationSec)) return { ok: false, reason: 'duration' };
  const p = primary.safeZone;
  const f = follower.safeZone;
  if (p && f && (f.top > p.top || f.bottom > p.bottom || f.left > p.left || f.right > p.right)) return { ok: false, reason: 'safeZone' };
  return { ok: true };
}

/**
 * Default links for a new brief, follower → primary, in the order of `formats`: each format follows the first earlier
 * primary it can follow, otherwise it becomes a primary itself. Followers never get followers (no chains).
 * `durationSec` is the brief's duration: when given (a number, or `null` for "unknown"), it is checked as in `canFollow`;
 * when omitted, only the catalog data is compared and the duration is left to the check at materialization.
 */
export function defaultLinks(formats: FormatPreset[], durationSec?: number | null): Record<string, string> {
  const links: Record<string, string> = {};
  const primaries: FormatPreset[] = [];
  for (const f of formats) {
    if (primaries.some((p) => p.id === f.id) || Object.hasOwn(links, f.id)) continue;
    const primary = primaries.find((p) => check(p, f, durationSec ?? null, durationSec !== undefined).ok);
    if (primary) links[f.id] = primary.id;
    else primaries.push(f);
  }
  return links;
}

const byNumber = (versions: VersionEntry[]) => [...versions].sort((a, b) => a.n - b.n);

/**
 * Per-format history (spec §2.1): the creative versions `vN`, ascending, where the file of `formatId` is new or differs from
 * the previous version's. The first version with the format is included; a version without the format breaks the chain
 * (the next one that has it counts as new). A missing `sha256` on either side counts as changed: equality must be proven.
 */
export function formatHistory(versions: VersionEntry[], formatId: string): number[] {
  const history: number[] = [];
  let previous: string | null | undefined = null; // null: no file in the previous version
  for (const v of byNumber(versions)) {
    const out = v.outputs.find((o) => o.format === formatId);
    if (!out) { previous = null; continue; }
    if (previous === null || previous === undefined || out.sha256 === undefined || out.sha256 !== previous) history.push(v.n);
    previous = out.sha256;
  }
  return history;
}

/**
 * Whether the file of `formatId` in version `v` has problems: its own `problems` when recorded, else (old versions) the
 * version-level `problems`, which then count for every file of the version.
 */
function hasProblems(v: VersionEntry, formatId: string): boolean {
  const own = v.outputs.find((o) => o.format === formatId)?.problems;
  return own !== undefined ? own.length > 0 : v.problems.length > 0;
}

export interface Star { version: number | null; manual: boolean; newer: number | null; follows: string | null }

/**
 * The ★ (version to export) of `formatId` (spec §2.2):
 * - a follower (`links[formatId]` set) has no ★ of its own: `follows` names its primary, `version` is null;
 * - a manual pick (`picks[formatId]`) on a version that has the format's file is kept, and `newer` is the latest version of
 *   the history when it is newer than the pick. A pick on a version without the file is ignored (default rule);
 * - otherwise the latest version of the history whose file has no problems, or the latest one if none is clean;
 * - no history: `version` null.
 * Picking the latest version clears the manual pick: that is the writer's job, this function reports what is stored.
 */
export function starOf(versions: VersionEntry[], formatId: string, picks: Record<string, number> | undefined,
  links: Record<string, string> | undefined): Star {
  const follows = links && Object.hasOwn(links, formatId) ? links[formatId]! : null;
  if (follows !== null) return { version: null, manual: false, newer: null, follows };
  const history = formatHistory(versions, formatId);
  const latest = history.at(-1) ?? null;
  const pick = picks && Object.hasOwn(picks, formatId) ? picks[formatId]! : undefined;
  if (pick !== undefined && versions.some((v) => v.n === pick && v.outputs.some((o) => o.format === formatId))) {
    return { version: pick, manual: true, newer: latest !== null && latest > pick ? latest : null, follows: null };
  }
  const clean = [...history].reverse().find((n) => !hasProblems(versions.find((v) => v.n === n)!, formatId));
  return { version: clean ?? latest, manual: false, newer: null, follows: null };
}
