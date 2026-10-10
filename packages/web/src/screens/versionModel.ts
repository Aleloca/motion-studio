// Per-format versions on the web side (spec §2.1–2.5): the history, ★ and links of each format (from the core's summary,
// or computed with the shared rules when an older core sends none), what a board shows, which boards a running job
// renders, and the default "Applies to" of a change.
import { checkLink, effectiveLinks, followerVersion, formatHistory, starOf, type CreativeDetail, type FormatPreset, type FormatSummary, type JobSummary, type Star, type VersionEntry } from '@motion-studio/shared';

export interface FormatState {
  id: string;
  /** Creative versions where this format's file is new or changed, ascending. */
  history: number[];
  star: Star;
  /** The version the default rule stars (spec §2.2: the newest without problems), whatever the manual pick; null for a follower. */
  defaultVersion: number | null;
  /**
   * The version whose own file of this format the export copies: the ★ for a primary; for a follower the latest version
   * whose own file is byte-identical to the primary's ★ file (`followerVersion`, decisions log 140). null when none.
   */
  exportVersion: number | null;
  starFileMissing: boolean;
  linkable: FormatSummary['linkable'];
  /** The primary this format follows (it then has no ★ and no history of its own to pick from). */
  follows: string | null;
}

/**
 * One state per format of the creative: the brief's formats from `detail.formats` (computed with the shared rules when it
 * is missing), then formats only found in versions (no longer in the brief), without links or picks.
 */
export function formatStates(detail: CreativeDetail, presets: FormatPreset[]): Record<string, FormatState> {
  const { brief, exportPicks } = detail.creative;
  const links = effectiveLinks(brief.links, brief.formats);
  const out: Record<string, FormatState> = {};
  const summaries = new Map((detail.formats ?? []).map((s) => [s.id, s]));
  const starOfId = (id: string) => summaries.get(id)?.star ?? starOf(detail.versions, id, exportPicks, links);
  for (const id of brief.formats) {
    const s = summaries.get(id);
    const star = starOfId(id);
    // Older cores send no `exportVersion`: the same shared rule, on the hashes the versions carry.
    const primaryStar = star.follows !== null ? starOfId(star.follows).version : null;
    const exportVersion = s?.exportVersion !== undefined ? s.exportVersion
      : star.follows !== null ? followerVersion(detail.versions, id, primaryStar, links) : star.version;
    out[id] = {
      id,
      history: s?.history ?? formatHistory(detail.versions, id),
      star,
      defaultVersion: starOf(detail.versions, id, undefined, links).version,
      exportVersion,
      starFileMissing: s?.starFileMissing ?? (star.follows !== null && primaryStar !== null && exportVersion === null),
      linkable: s?.linkable ?? brief.formats.filter((p) => p !== id).map((primary) => {
        const c = checkLink(brief, detail.versions, presets, id, primary);
        return c.ok ? { primary, ok: true } : { primary, ok: false, reason: c.reason };
      }),
      follows: star.follows,
    };
  }
  for (const v of detail.versions) {
    for (const o of v.outputs) {
      if (out[o.format]) continue;
      const star = starOf(detail.versions, o.format, undefined, undefined);
      out[o.format] = { id: o.format, history: formatHistory(detail.versions, o.format), star, defaultVersion: star.version, exportVersion: star.version, starFileMissing: false, linkable: [], follows: null };
    }
  }
  return out;
}

/** The formats following `primary`, in the order of `states`. */
export function followersOf(states: Record<string, FormatState>, primary: string): string[] {
  return Object.values(states).filter((s) => s.follows === primary).map((s) => s.id);
}

/**
 * The version whose file of the format shows: the one being viewed (when it is in the history), else the ★, else the
 * latest of the history; null before the format has any.
 */
export function shownOf(state: FormatState | undefined, viewing: number | undefined): number | null {
  if (!state) return null;
  if (viewing !== undefined && state.history.includes(viewing)) return viewing;
  return state.star.version ?? state.history.at(-1) ?? null;
}

/**
 * The history entry holding the file version `n` has for the format: the last history version ≤ n; null when version `n`
 * has no file for it.
 */
export function entryAt(versions: VersionEntry[], state: FormatState | undefined, n: number | null): number | null {
  if (!state || n === null) return null;
  if (!versions.find((v) => v.n === n)?.outputs.some((o) => o.format === state.id)) return null;
  return [...state.history].reverse().find((h) => h <= n) ?? null;
}

/** What a board shows: the format it takes its file from (a follower: its primary) and that file's version. */
export function boardSource(states: Record<string, FormatState>, id: string, viewing: Record<string, number>): { format: string; n: number | null } {
  const s = states[id];
  const format = s?.follows && states[s.follows] ? s.follows : id;
  return { format, n: shownOf(states[format], viewing[format]) };
}

const activeJob = (j: JobSummary | undefined) => j !== undefined && (j.state === 'queued' || j.state === 'running');

/**
 * Which boards a job renders: none when it is not queued or running; its target formats and their followers when it names
 * them; otherwise every board (`'all'`).
 */
export function renderingOf(job: JobSummary | undefined, states: Record<string, FormatState>): Set<string> | 'all' {
  if (!activeJob(job)) return new Set();
  if (!job!.formats?.length) return 'all';
  const targets = new Set(job!.formats);
  for (const s of Object.values(states)) if (s.follows && targets.has(s.follows)) targets.add(s.id);
  return targets;
}

export const isRendering = (r: Set<string> | 'all', id: string) => r === 'all' || r.has(id);

/**
 * The default "Applies to" of a change (spec §2.5): the formats of the attached comments (a follower stands for its
 * primary, through `primaryOf`), in the order of `primaries`; null ("All formats") without comments, or when they cover
 * every primary.
 */
export function defaultTargets(pinFormats: string[], primaryOf: (id: string) => string, primaries: string[]): string[] | null {
  const wanted = new Set(pinFormats.map(primaryOf));
  const chosen = primaries.filter((p) => wanted.has(p));
  return chosen.length === 0 || chosen.length === primaries.length ? null : chosen;
}
