// Pure helpers of the variant UI (Phase 15): defaults of the New creative field, the "Selezione finale" rows, the state of a
// member's row, which job belongs to which variant, and the width a grouped canvas needs. No React here.
import {
  activeMembers, canDiscard, hostOf, presetOf, sisterSlug, VARIANT_LETTERS,
  type CreativeDetail, type CreativeSummary, type JobSummary, type VariantGroup, type VariantLetter, type VariantMember,
} from '@motion-studio/shared';
import type { EventsState } from '../../eventsReducer.ts';
import { creativeJob } from '../creativeState.ts';
import { boardFrame, isTall, LABEL_MIN_GROUPED, type BoardModel } from '../canvasModel.ts';

/** Longest direction (the core's `MAX_DIRECTION_CHARS`). */
export const DIRECTION_MAX = 140;
/** The "Varianti" field's default when a logo is among the chosen formats (ruling: orchestrator, 2026-10-16). */
export const LOGO_VARIANTS = 3;

/**
 * The default of "Varianti": 3 only when `identity-logo` is among the chosen formats AND the logo is made from scratch (a logo
 * taken from the brand has nothing to vary); 1 otherwise. A format may be an instance (`identity-logo@2`).
 */
export function defaultVariantCount(formats: readonly string[], fromScratch: boolean): number {
  return fromScratch && formats.some((f) => presetOf(f) === 'identity-logo') ? LOGO_VARIANTS : 1;
}

/** Directions to send: one slot per variant, an empty or blank one is `null` (the directions turn fills it). */
export function directionsFor(count: number, typed: readonly string[]): Array<string | null> {
  return Array.from({ length: count }, (_, i) => typed[i]?.trim() || null);
}

export const upper = (l: VariantLetter): string => l.toUpperCase();
export const letterOfSlug = (slug: string): VariantLetter => (slug.includes('~') ? (slug.slice(-1) as VariantLetter) : 'a');

/** The creative slug of a letter in the group of `host`. */
export const slugOf = (host: string, letter: VariantLetter): string => sisterSlug(host, letter);

/** "B · direction", or just "B" without one. */
export const rowTitle = (m: Pick<VariantMember, 'letter' | 'direction'>): string => (m.direction ? `${upper(m.letter)} · ${m.direction}` : upper(m.letter));

/** The members to draw: the active ones, plus the discarded ones when asked for, in letter order. */
export function shownMembers(group: VariantGroup, showDiscarded: boolean): VariantMember[] {
  return group.members.filter((m) => m.status === 'active' || showDiscarded);
}

/** What the live state says about a member: a running or queued job, a pending approval. */
export interface MemberLive { job: JobSummary | null; needs: boolean }

export function memberLive(live: EventsState, project: string, slug: string): MemberLive {
  return {
    job: creativeJob(live, project, slug),
    needs: Object.values(live.approvals).some((a) => a.projectSlug === project && a.creativeSlug === slug),
  };
}

/** Whether a member's turn is in the way of discarding it: any active job, a queued (held) one included. */
export const isRunning = (l: MemberLive): boolean => l.job !== null;

/** Why a member cannot be discarded now (shared rule: running first, then the last active one), or null. */
export function discardBlock(group: VariantGroup, letter: VariantLetter, running: boolean): 'running' | 'last-active' | null {
  const r = canDiscard(group, letter, running);
  return r.ok || r.reason === 'unknown' ? null : r.reason;
}

export type RowState =
  | { kind: 'discarded' } | { kind: 'missing' } | { kind: 'needs' }
  | { kind: 'waiting'; reason: NonNullable<JobSummary['waitReason']> | null } | { kind: 'working' }
  | { kind: 'failed' } | { kind: 'stopped' } | { kind: 'ready' } | { kind: 'draft' } | { kind: 'incomplete' };

/** The state a variant's row header shows, in order of importance. `status`: the member's stored `creative.status`. */
export function rowState(m: VariantMember, missing: boolean, live: MemberLive, status: CreativeDetail['creative']['status'] | null): RowState {
  if (missing) return { kind: 'missing' };
  if (m.status === 'discarded') return { kind: 'discarded' };
  if (live.needs) return { kind: 'needs' };
  if (live.job?.state === 'queued') return { kind: 'waiting', reason: live.job.waitReason ?? null };
  if (live.job) return { kind: 'working' };
  switch (status) {
    case 'error': return { kind: 'failed' };
    case 'interrupted': return { kind: 'stopped' };
    case 'working': return { kind: 'working' };
    case 'ready': return { kind: 'ready' };
    case 'incomplete': return { kind: 'incomplete' };
    default: return { kind: 'draft' };
  }
}

/** One line of "Selezione finale". `variant`/`n`: where the format comes from; `source`: a ★ or the default rule. */
export type SelectionRow =
  | { format: string; source: 'pick'; variant: VariantLetter; n: number }
  | { format: string; source: 'default'; variant: VariantLetter | null; n: number | null };

/**
 * The summary of the group's final selection, one row per format of the brief. A ★ that points to a member that is gone,
 * discarded or missing (or to a format the brief no longer has) is not shown as a pick: the format falls back to the default
 * rule, which is the host's own ★ (`defaultOf`). Nothing here throws on a stale entry.
 */
export function finalSelection(group: VariantGroup, formats: readonly string[], missing: readonly VariantLetter[], defaultOf: (format: string) => number | null): SelectionRow[] {
  const active = new Map(activeMembers(group).filter((m) => !missing.includes(m.letter)).map((m) => [m.slug, m.letter] as const));
  return formats.map((format): SelectionRow => {
    const pick = Object.hasOwn(group.picks, format) ? group.picks[format] : undefined;
    const letter = pick ? active.get(pick.slug) : undefined;
    if (pick && letter) return { format, source: 'pick', variant: letter, n: pick.version };
    const n = defaultOf(format);
    return { format, source: 'default', variant: n === null ? null : 'a', n };
  });
}

/**
 * Final wave I2 (decisions log 837 extended): whether the open creative is a discarded member of its group. A discarded variant
 * is read-only until it is restored (the core refuses every write with `variant-discarded`); its brief too, except A's (`host`
 * true): the host always carries the group's brief, so editing it from A never rolls the group back (decisions log 830).
 */
export function discardedSelf(variants: CreativeDetail['variants'] | undefined): { discarded: boolean; host: boolean } {
  if (!variants || variants.orphan) return { discarded: false, host: false };
  const self = variants.group.members.find((m) => m.letter === variants.letter);
  return { discarded: self?.status === 'discarded', host: variants.letter === 'a' };
}

/** The letters of members whose folder is missing, as a display list ("C, D"). */
export const missingList = (letters: readonly VariantLetter[]): string => letters.map(upper).join(', ');

/**
 * The variant letter of a job for the Activity center: a sister's from its slug; the host's "A" when the creative lists a
 * group (`creatives`: the project's summaries). Null for a creative outside any group.
 */
export function jobVariantLetter(creativeSlug: string | null, summaries: readonly CreativeSummary[] | undefined): VariantLetter | null {
  if (!creativeSlug) return null;
  if (creativeSlug.includes('~')) return letterOfSlug(creativeSlug);
  return summaries?.find((c) => c.slug === creativeSlug)?.variants ? 'a' : null;
}

/**
 * The zoom a grouped canvas opens at: the widest row must fit the viewport's width (rows grow downward and scroll), never
 * above 100% nor below `min`, rounded down to 5%. `rows`: the boards that sit side by side in each row.
 */
export function fitGrouped(rows: BoardModel[][], rowKind: 'world' | 'line', viewWidth: number, min: number): number | null {
  if (viewWidth <= 0 || rows.length === 0) return null;
  const wide = (b: BoardModel, z: number) => Math.max(boardFrame(b).width * z, LABEL_MIN_GROUPED);
  // 'world': a variant's row (tall boards in a line, the others stacked in one column); 'line': one format's boards side by side.
  const widthAt = (boards: BoardModel[], z: number) => {
    const columns = rowKind === 'world'
      ? [...boards.filter(isTall).map((b) => wide(b, z)), ...(boards.some((b) => !isTall(b)) ? [Math.max(...boards.filter((b) => !isTall(b)).map((b) => wide(b, z)))] : [])]
      : boards.map((b) => wide(b, z));
    return columns.reduce((w, c) => w + c, 0) + 40 * z * Math.max(0, columns.length - 1) + 120 * z;
  };
  let z = 1;
  while (z > min + 1e-9 && rows.some((r) => widthAt(r, z) > viewWidth + 1e-6)) z = Math.max(min, Math.round((z - 0.05) * 20) / 20);
  return z;
}

/** Letters in order, for the selector. */
export const LETTERS = VARIANT_LETTERS;
export { hostOf };
