// Pure helpers of the variant UI (Phase 15): defaults of the New creative field, the "Selezione finale" rows, the state of a
// member's card, which job belongs to which variant, and the sizes of the variant cards. No React here.
import {
  canDiscard, letterOfSlug, presetOf,
  type CreativeDetail, type CreativeSummary, type JobSummary, type VariantGroup, type VariantId, type VariantMember,
} from '@motion-studio/shared';
import type { EventsState } from '../../eventsReducer.ts';
import { creativeJob } from '../creativeState.ts';
import { boardFrame, canvasGroups, type BoardLayout, type BoardModel, type CanvasSection } from '../canvasModel.ts';

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

export const upper = (l: VariantId): string => l.toUpperCase();

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
export function discardBlock(group: VariantGroup, letter: VariantId, running: boolean): 'running' | 'last-active' | null {
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
  | { format: string; source: 'pick'; variant: VariantId; n: number }
  | { format: string; source: 'default'; variant: VariantId | null; n: number | null };

/**
 * The rows of "Selezione finale" (final wave I1): the core's group export plan (`GET …/export-group`), which is the selection
 * the export copies, one row per format of the brief in its order. Nothing is recomputed here: a format the plan does not
 * have (nothing to export) is the default rule with no variant.
 */
export function selectionRows(formats: readonly string[], plan: ReadonlyArray<{ format: string; letter: VariantId; version: number; source: 'pick' | 'default' }>): SelectionRow[] {
  return formats.map((format): SelectionRow => {
    const p = plan.find((x) => x.format === format);
    if (!p) return { format, source: 'default', variant: null, n: null };
    return p.source === 'pick' ? { format, source: 'pick', variant: p.letter, n: p.version } : { format, source: 'default', variant: p.letter, n: p.version };
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
export const missingList = (letters: readonly VariantId[]): string => letters.map(upper).join(', ');

/**
 * The variant letter of a job for the Activity center: a sister's from its slug; the host's "A" when the creative lists a
 * group (`creatives`: the project's summaries). Null for a creative outside any group.
 */
export function jobVariantLetter(creativeSlug: string | null, summaries: readonly CreativeSummary[] | undefined): VariantId | null {
  if (!creativeSlug) return null;
  if (creativeSlug.includes('~')) return letterOfSlug(creativeSlug);
  return summaries?.find((c) => c.slug === creativeSlug)?.variants ? 'a' : null;
}

// ---- Decision 973: the variant cards ---------------------------------------------------------------------------------------

/** Longest short name of a variant, its ellipsis included. */
const SHORT_NAME_MAX = 32;

/**
 * The short name of a variant (decision 1041): the first clause of its direction (up to `:`, `,`, `;`, a spaced dash or a
 * sentence end), cut at a word with "…" when still long. The group stores no name of its own; the full direction stays the
 * card's second line and tooltip. Null without a direction.
 */
export function shortName(direction: string | null): string | null {
  const text = direction?.trim();
  if (!text) return null;
  const first = text.split(/\s+[—–-]\s+|[:;,]\s*|[.!?](?:\s+|$)/)[0]!.trim() || text;
  if (first.length <= SHORT_NAME_MAX) return first;
  const words = first.split(/\s+/);
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > SHORT_NAME_MAX - 1) break;
    out = next;
  }
  return `${out || first.slice(0, SHORT_NAME_MAX - 1)}…`;
}

/**
 * A card's width at 100% zoom, its narrowest (the header: letter, name and menu, then the state) and the grid's gap and side
 * padding. CARD_MIN (decision 1056): with the chat panel open, three cards side by side from a 1440 px window, two at 1024–1280.
 */
export const CARD_W = 360;
export const CARD_MIN = 210;
export const CARD_GAP = 24;
export const CARDS_PAD = 16;
/** The card's inner padding (its formats sit inside it). */
export const CARD_PAD = 12;

/**
 * A card's width on screen at zoom `z`: never narrower than its header needs, never wider than the viewport. When the `count`
 * cards do not all fit on one line, the cards of a line share its whole width (no empty strip at the right of the grid).
 */
export function cardWidth(z: number, viewWidth: number, count: number): number {
  const base = Math.max(CARD_W * z, CARD_MIN);
  if (viewWidth <= 0) return base;
  const avail = viewWidth - 2 * CARDS_PAD;
  if (base >= avail) return avail;
  const cols = Math.floor((avail + CARD_GAP) / (base + CARD_GAP));
  return count <= cols ? base : (avail - (cols - 1) * CARD_GAP) / cols;
}

/** A format's column in a card: the narrowest one (its name and "★ Scegli" under the picture) and the gap between them. */
export const CELL_MIN = 104;
export const CELL_GAP = 12;

/** The columns of a card's formats: as many as fit (at most one per format), sharing the card's inner width. */
export function cardColumns(inner: number, count: number): { cols: number; width: number } {
  const cols = Math.max(1, Math.min(count, Math.floor((inner + CELL_GAP) / (CELL_MIN + CELL_GAP))));
  return { cols, width: (inner - (cols - 1) * CELL_GAP) / cols };
}

/** The tallest thumbnail: the hero of a card, and one among several (a wide card would make a 9:16 a poster). */
const HERO_MAX_H = 440;
const THUMB_MAX_H = 320;

/**
 * The zoom of a format's thumbnail in a column `width` px wide: as wide as the column, never cropped. Alone it is the card's hero
 * (a tall format at most 1.25 × the width high); among several, at most 16:9 of the width high (a 9:16 fills its column). Never
 * taller than HERO_MAX_H / THUMB_MAX_H.
 */
export function thumbZoom(b: BoardModel, width: number, hero: boolean): number {
  const f = boardFrame(b);
  const high = hero ? Math.min(width * 1.25, HERO_MAX_H) : Math.min((width * 16) / 9, THUMB_MAX_H);
  return Math.min(width / f.width, high / f.height);
}

/** The zoom that puts `count` cards side by side in the viewport: rounded down to 5%, within 50%–100%. Null without either. */
export function fitCards(count: number, viewWidth: number, min = 0.5): number | null {
  if (count <= 0 || viewWidth <= 0) return null;
  const z = (viewWidth - 2 * CARDS_PAD - (count - 1) * CARD_GAP) / (count * CARD_W);
  return Math.max(min, Math.min(1, Math.floor(z * 20 + 1e-9) / 20));
}

/**
 * How many variants the "choose the final one" banner counts: every active variant is ready (none missing), there are at least
 * two to compare, and nothing is chosen yet (no ★ in the group). Null when the banner does not show.
 */
export function readyToChoose(group: VariantGroup, missing: readonly VariantId[], stateOf: (letter: VariantId) => RowState['kind']): number | null {
  const active = group.members.filter((m) => m.status === 'active');
  if (active.length < 2 || Object.keys(group.picks).length > 0) return null;
  if (active.some((m) => missing.includes(m.letter) || stateOf(m.letter) !== 'ready')) return null;
  return active.length;
}

// ---- Report 49: the "Scelte" view ------------------------------------------------------------------------------------------

/** A format in the "Scelte" view: the variant and version it shows (null: no variant has it yet). */
export interface ChosenCell { format: string; letter: VariantId | null; slug: string | null; n: number | null }

/**
 * The "Scelte" view of `formats` (the group's, in order): `chosen`, the formats with a pick (the group's ★: the plan's variant and
 * version, the same source as "Selezione finale"); `open`, the others, with the variant and version the default rule takes (what
 * the export copies), or none. Until the plan is read the stored picks stand in.
 */
export function chosenView(formats: readonly string[], group: VariantGroup, plan: ReadonlyArray<{ format: string; slug: string; letter: VariantId; version: number; source: 'pick' | 'default' }> | null): { chosen: ChosenCell[]; open: ChosenCell[] } {
  const chosen: ChosenCell[] = [];
  const open: ChosenCell[] = [];
  for (const format of formats) {
    if (plan) {
      const p = plan.find((x) => x.format === format);
      const cell = p ? { format, letter: p.letter, slug: p.slug, n: p.version } : { format, letter: null, slug: null, n: null };
      (p?.source === 'pick' ? chosen : open).push(cell);
      continue;
    }
    const pick = Object.hasOwn(group.picks, format) ? group.picks[format] : undefined;
    const m = pick ? group.members.find((x) => x.slug === pick.slug && x.status === 'active') : undefined;
    if (pick && m) chosen.push({ format, letter: m.letter, slug: m.slug, n: pick.version });
    else open.push({ format, letter: null, slug: null, n: null });
  }
  return { chosen, open };
}

export type VariantView = 'chosen' | 'all';
/** Where the view of a group's page is remembered: per group, under its host's slug, whichever member is open (decision 1336). */
export const variantViewKey = (project: string, host: string): string => `ms.variantView.${project}/${host}`;

/** The view the page opens on: the remembered one, else "Scelte" when the group has a pick; never "Scelte" without one. */
export function readVariantView(project: string, host: string, hasPicks: boolean): VariantView {
  if (!hasPicks) return 'all';
  try { return localStorage.getItem(variantViewKey(project, host)) === 'all' ? 'all' : 'chosen'; } catch { return 'chosen'; }
}
export function writeVariantView(project: string, host: string, view: VariantView): void {
  try { localStorage.setItem(variantViewKey(project, host), view); } catch { /* private mode */ }
}

/** Report 52: the headings of the "Scelte" view on the canvas, screen px (variants.css: `.ms-vchosen-head`, `.ms-vchosen-hint`). */
export const CHOSEN_HEAD = 32;
export const CHOSEN_HINT = 20;
/** Report 52: a chosen board's header has the variant's line above the usual two (`.ms-cv-board-from`: 20 px + 2), and a group's label floor. */
export const CHOSEN_LAYOUT: BoardLayout = { head: 22, grouped: true };

/**
 * Report 52: the "Scelte" view is a canvas, laid out as the plain one: "Scelte" (its heading), then "Senza scelta" (its heading and
 * hint) when some format has no choice, each with its boards in the canvas's groups and lines (`canvasGroups`: a store pack by store).
 */
export function chosenSections<B extends BoardModel>(chosen: B[], open: B[], pack: ReadonlySet<string>): Array<CanvasSection<B>> {
  return [
    { groups: canvasGroups(chosen, pack), head: CHOSEN_HEAD },
    ...(open.length ? [{ groups: canvasGroups(open, pack), head: CHOSEN_HEAD + CHOSEN_HINT }] : []),
  ];
}
