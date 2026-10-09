// Live token accounting for the UI (spec §5.4, plan Review Focus 4). Pure functions used by the events reducer.
//
// Facts the accounting rests on:
// - live `usage` events carry the SUM of the current `claude` run so far (throttled, latest wins); the final one
//   (`live: false`) carries the run's own total. A creative job's fix loop is several runs, each starting from 0.
// - the ledger (GET /api/usage) holds finished runs only: the run in progress is not in it.
//
// Per job: `done` sums the finals seen, `peak` is the highest job figure shown so far (finished runs + current live).
// Today's total = the ledger's figure at fetch time + the growth of each job since then. A job's contribution is
// `done + live - offset` (offset: what of it the ledger already held at the fetch), and only its increase over what
// was already added (`counted`) is added: repeated live events add nothing, a new run restarting from 0 adds nothing
// until it passes what was shown, and a final lower than the last live estimate does not take anything back (the
// shown number never goes down; the ledger fixes it on the next fetch, e.g. after a reconnect or at midnight).
//
// Races around a refetch (both corrected by the next fetch, neither ever lowers the shown number):
// - undercount: a final processed before the HTTP response although the ledger was read before it was written: its
//   run becomes part of the offset but is not in the base.
// - over-count: the HTTP response handled before the final's WS frame although the ledger already holds that run:
//   the run counts as live at the reset, then its final adds `final - live` on top of a base that already has it.
//
// A page that connects (or reconnects) while a job runs has not seen that job's earlier runs: the snapshot marks the
// job `partial`, and its figures are shown as "≥ N", never as a complete total.
import { shownTotal, type AgentEvent, type UsageBilling } from '@motion-studio/shared';

export type UsageEvent = Extract<AgentEvent, { kind: 'usage' }>;

/** A job's usage seen in this session. `runs`: finals received. */
export interface JobUsage { done: number; runs: number; peak: number }

export interface TodayUsage {
  /** Local day (YYYY-MM-DD) the total belongs to. */
  day: string;
  tokens: number;
  billing: UsageBilling;
  jobs: Record<string, { offset: number; counted: number }>;
}

/** The day total fetched from the ledger (dispatched by useServerEvents, never sent by the server). */
export interface UsageTodayAction { type: 'usage-today'; day: string; tokens: number; billing: UsageBilling }

interface UsageState { liveUsage?: Record<string, UsageEvent>; jobUsage?: Record<string, JobUsage>; partialUsage?: Record<string, true>; today?: TodayUsage }

const pad = (n: number) => String(n).padStart(2, '0');
export const localDay = (d: Date = new Date()): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const localMidnightIso = (d: Date = new Date()): string => new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
/** Milliseconds until the next local midnight. */
export const msToMidnight = (d: Date = new Date()): number => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - d.getTime();

const liveOf = (s: UsageState, jobId: string) => { const l = s.liveUsage?.[jobId]; return l ? shownTotal(l.tokens) : 0; };

/** Adds to today's total what job `jobId` grew by; call after `liveUsage`/`jobUsage` reflect the event. */
function account<S extends UsageState>(s: S, jobId: string): S {
  if (!s.today) return s;
  const rec = s.today.jobs[jobId] ?? { offset: 0, counted: 0 };
  const now = (s.jobUsage?.[jobId]?.done ?? 0) + liveOf(s, jobId) - rec.offset;
  if (now <= rec.counted) return s;
  return { ...s, today: { ...s.today, tokens: s.today.tokens + now - rec.counted, jobs: { ...s.today.jobs, [jobId]: { ...rec, counted: now } } } };
}

/** State after a usage event (the reducer already updated `liveUsage`: set for live, removed for final). */
export function applyUsage<S extends UsageState>(s: S, jobId: string, e: UsageEvent): S {
  const prev = s.jobUsage?.[jobId] ?? { done: 0, runs: 0, peak: 0 };
  const done = e.live ? prev.done : prev.done + shownTotal(e.tokens);
  const figure = done + (e.live ? shownTotal(e.tokens) : 0);
  const next: JobUsage = { done, runs: prev.runs + (e.live ? 0 : 1), peak: Math.max(prev.peak, figure) };
  return account({ ...s, jobUsage: { ...s.jobUsage, [jobId]: next } }, jobId);
}

/**
 * A new day total from the ledger. Finished runs are in it, so each job's offset is its `done`; the runs in progress
 * are not, so their live figure is added. The same day it never lowers what was shown; another day replaces it.
 */
export function applyToday<S extends UsageState>(s: S, a: UsageTodayAction): S {
  const ids = new Set([...Object.keys(s.jobUsage ?? {}), ...Object.keys(s.liveUsage ?? {})]);
  const jobs: TodayUsage['jobs'] = {};
  let tokens = a.tokens;
  for (const id of ids) {
    const counted = liveOf(s, id);
    jobs[id] = { offset: s.jobUsage?.[id]?.done ?? 0, counted };
    tokens += counted;
  }
  if (s.today && s.today.day === a.day) tokens = Math.max(tokens, s.today.tokens);
  return { ...s, today: { day: a.day, tokens, billing: a.billing, jobs } };
}

/** Keeps the usage of the jobs a snapshot still lists. Today's total stays: the refetch that follows resets it. */
export function keepJobUsage(all: Record<string, JobUsage> | undefined, ids: Set<string>): Record<string, JobUsage> | undefined {
  if (!all) return all;
  return Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id)));
}

/**
 * Jobs whose figures miss runs this page did not see: those still listed after a snapshot, plus every job the snapshot
 * lists as running (its earlier runs may have ended while the page was not connected).
 */
export function partialAfterSnapshot(prev: Record<string, true> | undefined, jobs: { id: string; state: string }[]): Record<string, true> {
  const out: Record<string, true> = {};
  for (const j of jobs) if (prev?.[j.id] || j.state === 'running') out[j.id] = true;
  return out;
}

/** True when the job's figures may miss earlier runs: show them as "≥ N". */
export const jobUsagePartial = (s: UsageState, jobId: string): boolean => s.partialUsage?.[jobId] === true;

/** Today's total, or null when unknown or still yesterday's (the midnight fetch failed). */
export function todayTokens(s: UsageState, now: Date = new Date()): number | null {
  return s.today && s.today.day === localDay(now) ? s.today.tokens : null;
}

/** A running job's figure (finished runs + the current one), never lower than shown before; null without data. */
export function jobLiveTokens(s: UsageState, jobId: string): number | null {
  const u = s.jobUsage?.[jobId];
  return u ? u.peak : null;
}

/** A job's total from its final usage events; null when none arrived (e.g. it ended before this page connected). */
export function jobFinalTokens(s: UsageState, jobId: string): number | null {
  const u = s.jobUsage?.[jobId];
  return u && u.runs > 0 ? u.done : null;
}
