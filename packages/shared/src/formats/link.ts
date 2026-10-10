import type { FormatPreset } from '../formats.ts';
import type { Brief, VersionEntry } from '../creative.ts';

export type FollowCheck = { ok: true } | { ok: false; reason: 'kind' | 'size' | 'extension' | 'duration' | 'safeZone' };

/**
 * Whether `follower` can take a byte-identical copy of `primary`'s file (spec §2.3). Checked in this order:
 * - `kind`: same kind (video or image);
 * - `size`: same width and height;
 * - `extension`: the follower accepts every extension the primary may deliver, so any primary file is valid for it;
 * - `duration` (video followers with a `maxDurationSec` only): the primary's duration fits the follower's limit. An unknown
 *   duration (`null`) is ok only when the follower has no limit; otherwise it is `duration`, since it cannot be proven to fit.
 *   `undefined` skips this check (the duration is not known yet, e.g. no render: it is re-checked at materialization);
 * - `safeZone`: the follower's safe area contains the primary's, so content placed safely for the primary is safe on the
 *   follower too. The safe zones are insets from the edges and the sizes are equal, so this means every follower inset is
 *   <= the primary's. A primary without `safeZone` has a safe area as large as the frame (insets 0), so a follower with a
 *   `safeZone` fails unless all its insets are 0. A follower without `safeZone` in the catalog: the size check alone decides
 *   (no data to compare).
 */
export function canFollow(primary: FormatPreset, follower: FormatPreset, primaryDurationSec: number | null | undefined): FollowCheck {
  return check(primary, follower, primaryDurationSec ?? null, primaryDurationSec !== undefined);
}

function check(primary: FormatPreset, follower: FormatPreset, durationSec: number | null, checkDuration: boolean): FollowCheck {
  if (primary.kind !== follower.kind) return { ok: false, reason: 'kind' };
  if (primary.width !== follower.width || primary.height !== follower.height) return { ok: false, reason: 'size' };
  if (!primary.extensions.every((e) => follower.extensions.includes(e))) return { ok: false, reason: 'extension' };
  if (checkDuration && follower.kind === 'video' && follower.maxDurationSec !== undefined
    && (durationSec === null || durationSec > follower.maxDurationSec)) return { ok: false, reason: 'duration' };
  const p = primary.safeZone ?? { top: 0, bottom: 0, left: 0, right: 0 };
  const f = follower.safeZone;
  if (f && (f.top > p.top || f.bottom > p.bottom || f.left > p.left || f.right > p.right)) return { ok: false, reason: 'safeZone' };
  return { ok: true };
}

/**
 * Default links for a new brief, follower → primary, in the order of `formats`: each format follows the first earlier
 * primary it can follow, otherwise it becomes a primary itself. Followers never get followers (no chains).
 * `durationSec` is the brief's duration:
 * - omitted (`undefined`): only the catalog data is compared and the duration is left to the check at materialization.
 *   Callers that do not know the duration yet MUST pass `undefined`, not `null`;
 * - a number: checked as in `canFollow`;
 * - `null`: strict, as in `canFollow`: "unknown" never fits a follower with a max duration, so e.g. TikTok and Shorts do NOT
 *   follow the Reel.
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

/**
 * The links that actually apply, follower → primary: drops self-links, links whose follower or primary is not in `formats`
 * (when given; e.g. `effectiveLinks(brief.links, brief.formats)`) and chains, i.e. a link whose primary is itself a follower
 * (in a cycle A→B, B→A both are dropped). Never throws on bad data: a stored brief stays readable.
 */
export function effectiveLinks(links: Record<string, string> | undefined, formats?: readonly string[]): Record<string, string> {
  const inBrief = (id: string) => formats === undefined || formats.includes(id);
  const candidates = Object.entries(links ?? {}).filter(([f, p]) => f !== p && inBrief(f) && inBrief(p));
  const followers = new Set(candidates.map(([f]) => f));
  return Object.fromEntries(candidates.filter(([, p]) => !followers.has(p)));
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
 * `links` go through `effectiveLinks` here (self-links and chains dropped); pass the brief's formats via
 * `effectiveLinks(brief.links, brief.formats)` to also drop links to formats no longer in the brief.
 */
export function starOf(versions: VersionEntry[], formatId: string, picks: Record<string, number> | undefined,
  links: Record<string, string> | undefined): Star {
  const active = effectiveLinks(links);
  const follows = Object.hasOwn(active, formatId) ? active[formatId]! : null;
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

/**
 * The version whose own file a follower exports (decisions log 140): the LATEST creative version that (a) holds the
 * follower's own file and (b) whose primary file is byte-identical (same `sha256`) to the primary's file in
 * `primaryVersion` (the primary's ★, or the primary version an export picks). The follower's file there is a copy of the
 * primary's, so it is the ★ content under the follower's name. This covers followers added without the agent: they exist
 * only in a later version where the primary is an identical repeat, outside the primary's history.
 * - A missing `sha256` counts as not identical (equality must be proven); `primaryVersion` itself always matches its own
 *   primary file, so the old rule (the follower's file in the primary's version) still resolves without hashes.
 * - null when `follower` follows nothing (`effectiveLinks(links)`), `primaryVersion` is null or unknown, or no version
 *   qualifies (the follower is then "missing").
 */
export function followerVersion(versions: VersionEntry[], follower: string, primaryVersion: number | null,
  links: Record<string, string> | undefined): number | null {
  if (primaryVersion === null) return null;
  for (const v of byNumber(versions).reverse()) {
    if (followerMatches(versions, follower, v.n, primaryVersion, links)) return v.n;
  }
  return null;
}

/** Whether a follower may be exported from version `n` while its primary is exported from `primaryVersion` (the rule of `followerVersion`). */
export function followerMatches(versions: VersionEntry[], follower: string, n: number, primaryVersion: number,
  links: Record<string, string> | undefined): boolean {
  const active = effectiveLinks(links);
  if (!Object.hasOwn(active, follower)) return false;
  const primary = active[follower]!;
  const at = (k: number) => versions.find((v) => v.n === k);
  const base = at(primaryVersion)?.outputs.find((o) => o.format === primary);
  const v = at(n);
  if (!base || !v?.outputs.some((o) => o.format === follower)) return false;
  if (n === primaryVersion) return true;
  const p = v.outputs.find((o) => o.format === primary)?.sha256;
  return base.sha256 !== undefined && p !== undefined && base.sha256 === p;
}

/**
 * Duration (seconds) of `formatId`'s file in the latest version that has it, when known (a positive finite number);
 * `undefined` otherwise (no render yet, an image, or a duration the probe could not read).
 */
export function latestDurationOf(versions: VersionEntry[], formatId: string): number | undefined {
  for (const v of byNumber(versions).reverse()) {
    const out = v.outputs.find((o) => o.format === formatId);
    if (!out) continue;
    return typeof out.durationSec === 'number' && Number.isFinite(out.durationSec) && out.durationSec > 0 ? out.durationSec : undefined;
  }
  return undefined;
}

/** Why a link cannot be made: a `canFollow` reason, or `self`, `chain` (no chains of links), `unknown` (not in the brief or the catalog). */
export type LinkReason = Extract<FollowCheck, { ok: false }>['reason'] | 'self' | 'chain' | 'unknown';
export type LinkCheck = { ok: true } | { ok: false; reason: LinkReason };

/**
 * Whether `follower` may be linked to `primary` in this brief, given the links already in place (spec §2.3): both in the
 * brief and in the catalog, not the same format, no chain (the primary does not follow another format and the follower has no
 * followers of its own), and `canFollow` with the primary's latest known duration (`latestDurationOf`; unknown skips the
 * duration check, which is then done when the follower is materialized).
 */
export function checkLink(brief: Pick<Brief, 'formats' | 'links'>, versions: VersionEntry[], presets: FormatPreset[],
  follower: string, primary: string): LinkCheck {
  if (follower === primary) return { ok: false, reason: 'self' };
  const f = brief.formats.includes(follower) ? presets.find((p) => p.id === follower) : undefined;
  const p = brief.formats.includes(primary) ? presets.find((x) => x.id === primary) : undefined;
  if (!f || !p) return { ok: false, reason: 'unknown' };
  const links = effectiveLinks(brief.links, brief.formats);
  if (Object.hasOwn(links, primary) || Object.entries(links).some(([x, to]) => to === follower && x !== follower)) return { ok: false, reason: 'chain' };
  return canFollow(p, f, latestDurationOf(versions, primary));
}

/** Per-format summary of a creative, computed by the core for the creative GET (spec §2.1–2.3). */
export interface FormatSummary {
  id: string;
  /** `formatHistory`: the versions where this format's file is new or changed. */
  history: number[];
  star: Star;
  /**
   * The version whose own file of this format the export copies: the ★ for a primary; for a follower `followerVersion` of
   * its primary's ★ (decisions log 140), which may differ from the primary's ★ number (e.g. a follower added without the
   * agent lives only in a later, identical version). null when there is none (a follower is then missing). Optional: older
   * cores do not send it and clients compute it with `followerVersion`.
   */
  exportVersion?: number | null;
  /** The file export would copy (`exportVersion`) is missing: no version qualifies for a follower, or the file is missing on disk (e.g. deleted by hand) or is a symlink/hard link: export refuses it. */
  starFileMissing: boolean;
  /** Each other format of the brief as a possible primary for this one (`checkLink`). */
  linkable: Array<{ primary: string; ok: boolean; reason?: LinkReason }>;
}
