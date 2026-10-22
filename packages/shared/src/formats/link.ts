import type { FormatPreset } from '../formats.ts';
import type { Brief, VersionEntry } from '../creative.ts';
import { instancePreset, presetOf } from '../format-instance.ts';

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
  // An identity format renders a whole file set of its own (Phase 14): it never shares another format's render.
  if (primary.identity !== undefined || follower.identity !== undefined) return { ok: false, reason: 'kind' };
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
 * primary it can follow, otherwise it becomes a primary itself. Followers never get followers (no chains). An instance never
 * follows another instance of its own preset by default (Phase 12: they are separate designs; a link can still be set).
 * `formats` carry their instance ids (`instancePreset`).
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
    // Two instances of one preset are separate designs (Phase 12): neither follows the other by default.
    const primary = primaries.find((p) => presetOf(p.id) !== presetOf(f.id) && check(p, f, durationSec ?? null, durationSec !== undefined).ok);
    if (primary) links[f.id] = primary.id;
    else primaries.push(f);
  }
  return links;
}

/**
 * The stored links after a brief save that sets the formats to `next` (core `CreativeTurnService.update`): links change only
 * through `setLink`, so the stored ones are kept; each format the save ADDS gets its default link against the primaries
 * already there and the other added formats (`defaultLinks`, the duration unknown: checked at materialization).
 */
export function linksAfterBriefSave(current: Pick<Brief, 'formats' | 'links'>, next: readonly string[], presets: readonly FormatPreset[]): Record<string, string> | undefined {
  const added = next.filter((f) => !current.formats.includes(f));
  if (added.length === 0) return current.links;
  const active = effectiveLinks(current.links, current.formats);
  const primaries = current.formats.filter((f) => next.includes(f) && !Object.hasOwn(active, f));
  const known = [...primaries, ...added].map((id) => instancePreset(presets, id)).filter((p): p is FormatPreset => p !== undefined);
  const defaults = defaultLinks(known, undefined);
  const out = { ...current.links };
  for (const f of added) {
    delete out[f];
    if (Object.hasOwn(defaults, f)) out[f] = defaults[f]!;
  }
  return out;
}

/** A phase 9 version: rendered media and no compositions (spec §7). */
export const isLegacyMediaVersion = (v: VersionEntry | undefined): v is VersionEntry => v !== undefined && v.compositions === undefined && v.outputs.length > 0;

/**
 * What a turn without a message or explicit formats does on base `base` with `brief` (final review I4, ruling A):
 * - `followers`: a legacy base and the brief only ADDS linked followers: the phase 9 path, no agent (copies of their
 *   primaries' files);
 * - `convert`: any other such turn on a legacy base converts every format to compositions with the agent (more tokens once);
 * - `normal`: no legacy base.
 * The core may still convert a `followers` turn when a primary's file cannot be carried.
 */
export function legacyTurnKind(base: VersionEntry | undefined, brief: Pick<Brief, 'formats' | 'links'>): 'followers' | 'convert' | 'normal' {
  if (!isLegacyMediaVersion(base)) return 'normal';
  const links = effectiveLinks(brief.links, brief.formats);
  const adding = brief.formats.filter((f) => !hasFormat(base, f));
  return adding.length > 0 && adding.every((f) => Object.hasOwn(links, f)) ? 'followers' : 'convert';
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
 * What identifies a format's content in a version:
 * - v2 (the version has a composition for the format): the composition hash;
 * - legacy (no composition): the file's `sha256`, which may be missing (not computed yet);
 * - null: the version does not have the format at all.
 */
type Identity = { kind: 'composition'; hash: string; followsFormat: string | undefined } | { kind: 'file'; sha256: string | undefined };

function identityOf(v: VersionEntry | undefined, formatId: string): Identity | null {
  if (!v) return null;
  const comp = v.compositions?.find((c) => c.format === formatId);
  if (comp) return { kind: 'composition', hash: comp.hash, followsFormat: comp.followsFormat };
  const out = v.outputs.find((o) => o.format === formatId);
  return out ? { kind: 'file', sha256: out.sha256 } : null;
}

/**
 * Whether two identities prove the same content: two compositions with the same hash, or two files with the same (present)
 * `sha256`. A composition against a file (the legacy → v2 boundary) is never the same: it counts as changed.
 */
function sameContent(a: Identity, b: Identity): boolean {
  if (a.kind === 'composition' && b.kind === 'composition') return a.hash === b.hash;
  if (a.kind === 'file' && b.kind === 'file') return a.sha256 !== undefined && a.sha256 === b.sha256;
  return false;
}

/** Whether version `v` delivers `formatId`: a composition for it (v2) or its file (legacy, or a v2 render). */
export function hasFormat(v: VersionEntry, formatId: string): boolean {
  return identityOf(v, formatId) !== null;
}

/**
 * Per-format history (spec §2.1): the creative versions `vN`, ascending, where the content of `formatId` is new or differs
 * from the previous version's. The first version with the format is included; a version without the format breaks the
 * chain (the next one that has it counts as new). Content is compared by composition hash when both versions have a
 * composition for the format (v2), by file `sha256` when neither has (legacy; a missing `sha256` on either side counts as
 * changed: equality must be proven), and a legacy version next to a v2 one always counts as changed.
 */
export function formatHistory(versions: VersionEntry[], formatId: string): number[] {
  const history: number[] = [];
  let previous: Identity | null = null; // null: the previous version does not have the format
  for (const v of byNumber(versions)) {
    const current = identityOf(v, formatId);
    if (!current) { previous = null; continue; }
    if (previous === null || !sameContent(previous, current)) history.push(v.n);
    previous = current;
  }
  return history;
}

/**
 * Decision 1061: the per-format history as runs: each history entry `n` and the `last` creative version that still holds its
 * content (the version just before the next change, or before a version without the format). A version that kept the
 * content (e.g. a turn that only changed the brief, made before decision 1060) is part of its entry's run.
 */
export function formatRuns(versions: VersionEntry[], formatId: string): Array<{ n: number; last: number }> {
  const runs: Array<{ n: number; last: number }> = [];
  let previous: Identity | null = null;
  for (const v of byNumber(versions)) {
    const current = identityOf(v, formatId);
    if (!current) { previous = null; continue; }
    if (previous === null || !sameContent(previous, current)) runs.push({ n: v.n, last: v.n });
    else runs.at(-1)!.last = v.n;
    previous = current;
  }
  return runs;
}

/**
 * Decision 1061: whether history entry `n` of `formatId` has problems, as the LATEST version holding the same content says
 * (its checks are the newest, e.g. against a brief whose duration changed since `n`): an entry checked again clean in a
 * later identical version is clean. Only a version that recorded this format's own problems (its composition's or its
 * file's) speaks for the entry: version-level problems of an old version are not this content's, so without such a later
 * version the entry is judged on its own (as is a version that is not a history entry).
 */
export function entryHasProblems(versions: VersionEntry[], formatId: string, n: number): boolean {
  const last = formatRuns(versions, formatId).find((r) => r.n === n)?.last ?? n;
  const own = (v: VersionEntry) => (v.compositions?.find((c) => c.format === formatId)?.problems ?? v.outputs.find((o) => o.format === formatId)?.problems) !== undefined;
  const later = byNumber(versions).filter((v) => v.n > n && v.n <= last && own(v)).at(-1);
  const entry = versions.find((x) => x.n === n);
  if (!entry) return false;
  // Decision 1066: the content's problems from the latest version that checked it; the render problems are the entry's own
  // (a ★ never lands on a version whose own render has problems, and a later version's render does not taint this one).
  return ownProblems(later ?? entry, formatId) || renderProblems(entry, formatId).length > 0;
}

/**
 * Decision 1060: whether a version about to be saved (`next`) delivers exactly what `latest` holds, so no version is made:
 * the same formats, each with the same content (`sameContent`: the composition hash, or a present and equal file `sha256`
 * for legacy files) and the same link (`followsFormat`), and the same localization overlays (language, instance, overlay
 * hash). Renders do not count (a v2 format is its composition). Anything unproven counts as a change, and so does a version
 * with no format at all.
 */
export function sameDelivery(latest: VersionEntry, next: Pick<VersionEntry, 'outputs' | 'compositions' | 'localizations'>): boolean {
  const formatsOf = (v: Pick<VersionEntry, 'outputs' | 'compositions'>) => new Set([...(v.compositions ?? []).map((c) => c.format), ...v.outputs.map((o) => o.format)]);
  const a = formatsOf(latest);
  const b = formatsOf(next);
  if (a.size === 0 || a.size !== b.size || [...a].some((f) => !b.has(f))) return false;
  const asEntry = next as VersionEntry;
  for (const f of a) {
    const x = identityOf(latest, f);
    const y = identityOf(asEntry, f);
    if (!x || !y || !sameContent(x, y)) return false;
    if (x.kind === 'composition' && y.kind === 'composition' && x.followsFormat !== y.followsFormat) return false;
  }
  const overlays = (v: Pick<VersionEntry, 'localizations'>) => (v.localizations ?? []).map((r) => `${r.locale}\0${r.instanceId}\0${r.hash}`).sort().join('\n');
  return overlays(latest) === overlays(next);
}

/**
 * Render state of `formatId` in version `v` (decisions R2):
 * - legacy (no composition for the format): `rendered` when the version has the file (the media is the result), else `none`;
 * - v2: `rendered` when an output with a `sha256` exists and its `fromComposition` equals the version's composition hash for
 *   the format; `stale` when such an output exists but was rendered from another composition; `none` otherwise.
 * Old renders are never deleted: an edit always makes a new version, so a render stays valid in its own version.
 */
export type RenderState = 'none' | 'rendered' | 'stale';
/**
 * `subtitleHashes` (subtitles Task 18): the hash of each subtitle set of the creative now, by language
 * (`CreativeDetail.subtitles`). With it, a v2 render whose subtitles are no longer the creative's (`subtitlesCurrent`) is also
 * `stale`. Absent: the composition hash alone, as before.
 */
export function renderState(v: VersionEntry, formatId: string, subtitleHashes?: Readonly<Record<string, string>>): RenderState {
  const comp = v.compositions?.find((c) => c.format === formatId);
  const out = v.outputs.find((o) => o.format === formatId);
  if (!comp) return out ? 'rendered' : 'none';
  if (!out || out.sha256 === undefined) return 'none';
  if (out.fromComposition !== comp.hash) return 'stale';
  return subtitlesCurrent(out.subtitles, subtitleHashes) ? 'rendered' : 'stale';
}

/**
 * Whether a render's subtitles (`OutputFileInfo.subtitles`, a localized row's `render.subtitles`) are still the creative's
 * (subtitles Task 18, review I1). A drawn set: its language's set still has that hash. A marker (`hash: null`, the composition
 * draws subtitles but no set was found): no set has appeared in the language looked for, or, when none was (`lang: null`),
 * no set in a language other than those it saw (`seen`). True without a record (nothing drawn) or without the map (`subtitleHashes`, the rule before Task 18).
 */
export function subtitlesCurrent(rec: { lang: string | null; hash: string | null; seen?: readonly string[] } | undefined, subtitleHashes: Readonly<Record<string, string>> | undefined): boolean {
  if (!rec || !subtitleHashes) return true;
  const now = (lang: string) => (Object.hasOwn(subtitleHashes, lang) ? subtitleHashes[lang] : undefined);
  if (rec.hash !== null) return rec.lang !== null && now(rec.lang) === rec.hash;
  if (rec.lang !== null) return now(rec.lang) === undefined;
  // No language could be paired with the sets it saw (review round 2): current while no other language has appeared, so a
  // render made again with the same sets is current; a set that may pair (a speech set, the brief's language) makes it stale.
  const seen = new Set(rec.seen ?? []);
  return Object.keys(subtitleHashes).every((lang) => seen.has(lang));
}

/**
 * The hash of what each subtitle set of a creative draws, by language (`renderState`'s map), from its detail's summaries: the
 * lines' hash (`cuesHash`, final review M3), the set's own from a core that does not send it.
 */
export function subtitleHashesOf(sets: ReadonlyArray<{ lang: string; hash: string; cuesHash?: string }> | undefined): Record<string, string> {
  return Object.fromEntries((sets ?? []).map((s) => [s.lang, s.cuesHash ?? s.hash]));
}

/**
 * The problems the core found in the CURRENT render of `formatId` in a v2 version `v` (final review I2): its output checks
 * (size over the channel's limit, duration off target, resolution, unreadable), a follower's copy carrying its primary's.
 * Empty for a legacy file, a version without a current render (`renderState` not `rendered`) or a clean render.
 */
export function renderProblems(v: VersionEntry, formatId: string): string[] {
  if (!v.compositions?.some((c) => c.format === formatId) || renderState(v, formatId) !== 'rendered') return [];
  return v.outputs.find((o) => o.format === formatId)?.problems ?? [];
}

/**
 * Whether `formatId` in version `v` has problems: the problems of its composition when recorded (v2), else those of its file
 * when recorded, else (old versions) the version-level `problems`, which then count for every format of that version. A v2
 * format whose current render has problems has problems too (I2: such a render is never a clean ★).
 */
function hasProblems(v: VersionEntry, formatId: string): boolean {
  return ownProblems(v, formatId) || renderProblems(v, formatId).length > 0;
}
/** `hasProblems` without the render's: the composition's (or file's) own problems, else the version-level ones. */
function ownProblems(v: VersionEntry, formatId: string): boolean {
  const own = v.compositions?.find((c) => c.format === formatId)?.problems ?? v.outputs.find((o) => o.format === formatId)?.problems;
  return own !== undefined ? own.length > 0 : v.problems.length > 0;
}

export interface Star { version: number | null; manual: boolean; newer: number | null; follows: string | null }

/**
 * The ★ (version to export) of `formatId` (spec §2.2):
 * - a follower (`links[formatId]` set) has no ★ of its own: `follows` names its primary, `version` is null;
 * - a manual pick (`picks[formatId]`) on a version that has the format (`hasFormat`) is kept, and `newer` is the latest version of
 *   the history when it is newer than the pick. A pick on a version without the file is ignored (default rule);
 * - otherwise the latest version of the history whose file has no problems (`entryHasProblems`: as the latest version with
 *   the same content says), or the latest one if none is clean;
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
  if (pick !== undefined && versions.some((v) => v.n === pick && hasFormat(v, formatId))) {
    return { version: pick, manual: true, newer: latest !== null && latest > pick ? latest : null, follows: null };
  }
  // Decision 1061: an entry is judged by the latest version that kept its content.
  const clean = [...history].reverse().find((n) => !entryHasProblems(versions, formatId, n));
  return { version: clean ?? latest, manual: false, newer: null, follows: null };
}

/**
 * The version whose own file a follower exports (decisions log 140): the LATEST creative version whose follower content is
 * identical to the primary's ★ content, i.e. the primary's content in `primaryVersion` (the primary's ★, or the primary
 * version an export picks). That file is then the ★ content under the follower's name. This covers followers added without
 * the agent (they exist only in a later version where the primary is an identical repeat) and never resolves to a dedicated
 * render of the follower (e.g. a render made before the link, or while it was unlinked).
 * - "Identical" is `followerMatches`: same file `sha256` for legacy versions, same composition hash for v2 ones.
 * - A missing `sha256` on either side counts as not identical (equality must be proven), in `primaryVersion` too.
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

/**
 * Whether a follower may be exported from version `n` while its primary is exported from `primaryVersion` (the rule of
 * `followerVersion`), comparing the follower's content in `n` with the primary's in `primaryVersion`:
 * - both legacy (files): `n` holds the follower's own file and its `sha256` equals the primary file's; both hashes must be
 *   present;
 * - both v2 (compositions): the follower's entry in `n` follows the primary (`followsFormat`) and its composition hash
 *   equals the primary's;
 * - one legacy and one v2: never (the content cannot be proven identical across the boundary).
 */
export function followerMatches(versions: VersionEntry[], follower: string, n: number, primaryVersion: number,
  links: Record<string, string> | undefined): boolean {
  const active = effectiveLinks(links);
  if (!Object.hasOwn(active, follower)) return false;
  const primary = active[follower]!;
  const at = (k: number) => versions.find((v) => v.n === k);
  const base = identityOf(at(primaryVersion), primary);
  const own = identityOf(at(n), follower);
  if (!base || !own) return false;
  if (own.kind === 'composition' && own.followsFormat !== primary) return false;
  return sameContent(base, own);
}

/**
 * Duration (seconds) of `formatId`'s file in the latest version that has the format, when known (a positive finite number);
 * `undefined` otherwise (no render yet, an image, or a duration the probe could not read). For a v2 version only a current
 * render counts (`renderState` is `rendered`): an unrendered or stale composition has no known duration.
 */
export function latestDurationOf(versions: VersionEntry[], formatId: string): number | undefined {
  for (const v of byNumber(versions).reverse()) {
    if (!hasFormat(v, formatId)) continue;
    const out = v.outputs.find((o) => o.format === formatId);
    if (!out || renderState(v, formatId) !== 'rendered') return undefined;
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
  const f = brief.formats.includes(follower) ? instancePreset(presets, follower) : undefined;
  const p = brief.formats.includes(primary) ? instancePreset(presets, primary) : undefined;
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
  /**
   * The file export would copy (`exportVersion`) is missing: no version qualifies for a follower, or a legacy file is missing
   * on disk (e.g. deleted by hand) or is a symlink/hard link: export refuses it. A v2 composition without a render is NOT
   * missing (see `starRender`).
   */
  starFileMissing: boolean;
  /**
   * The render state of what export would copy (`exportVersion`), Task 5b:
   * - `rendered`: a current render (v2) or a legacy file;
   * - `notRendered`: a v2 composition with no render yet, or whose render file is gone: export renders it first. This is
   *   never `starFileMissing` (the composition is the result; the media is made on demand);
   * - `stale`: a v2 render made from another composition: export renders it again first;
   * - `missing`: a legacy file that is gone or unusable (with `starFileMissing`): export refuses it;
   * - null: nothing to export (no ★, or a follower with no qualifying version).
   * Optional: older cores do not send it.
   */
  starRender?: 'rendered' | 'notRendered' | 'stale' | 'missing' | null;
  /**
   * Subtitles (final review I2): the composition export uses (`exportVersion`) is a video with the `subtitles` track, so it
   * can be exported with subtitles drawn into it (an unreadable composition counts as one with it, as in the export). False
   * for a still, a legacy file or no composition. Sent only when the creative has subtitle sets; absent: not known.
   */
  subtitlesTrack?: boolean;
  /** Each other format of the brief as a possible primary for this one (`checkLink`). */
  linkable: Array<{ primary: string; ok: boolean; reason?: LinkReason }>;
}
