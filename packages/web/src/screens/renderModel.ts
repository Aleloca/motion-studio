// Render state of the v2 (composition) versions on the web side (Task 8, spec §5.3): per board "Not rendered",
// "Queued · 2 renders ahead", "Rendering 42%", "Rendered", "Render failed · Retry", from the version's records and the live
// render jobs; and what "Render ★" renders.
import { renderState, type JobSummary, type VersionComposition, type VersionEntry } from '@motion-studio/shared';
import type { FormatState } from './versionModel.ts';

export type BoardRender =
  | { kind: 'none' }
  | { kind: 'queued'; ahead: number | null }
  | { kind: 'rendering'; pct: number }
  | { kind: 'rendered' }
  | { kind: 'failed'; error: string | null };

/** The composition of `format` in a version (v2); null for a legacy version or a format it lacks. */
export const compositionOf = (v: VersionEntry | null | undefined, format: string): VersionComposition | null =>
  v?.compositions?.find((c) => c.format === format) ?? null;

/** The render jobs' key of version n (core render-jobs `renderJobKey`), from the creative's job key `creative:<root>:<p>:<c>`. */
export function renderKeyOf(creativeJobKey: string, n: number): string | null {
  return creativeJobKey.startsWith('creative:') ? `render:${creativeJobKey.slice('creative:'.length)}:v${n}` : null;
}

export const isActiveJob = (j: JobSummary) => j.state === 'queued' || j.state === 'running';
const covers = (j: JobSummary, format: string) => !j.formats?.length || j.formats.includes(format);
const ended = (j: JobSummary) => j.finishedAt ?? j.startedAt ?? j.createdAt;

/** How far a running job is with `format`: its frames (a format not reached yet is at 0; finishing is 99). */
export function renderPct(job: JobSummary, format: string): number {
  const p = job.progress;
  if (!p || p.format !== format || p.phase === 'media') return 0;
  if (p.phase === 'finishing') return 99;
  return p.total > 0 ? Math.min(99, Math.floor((p.done / p.total) * 100)) : 0;
}

/**
 * The render state of `format` (a board's source format: a follower's is its primary's) in `version`; null for a legacy
 * version (its media is the result). A queued or running job of that version covering the format wins; then the records;
 * then the last finished job's failure.
 */
export function boardRender(version: VersionEntry | null | undefined, format: string, jobs: JobSummary[], creativeJobKey: string): BoardRender | null {
  if (!version || !compositionOf(version, format)) return null;
  const key = renderKeyOf(creativeJobKey, version.n);
  const mine = jobs.filter((j) => j.kind === 'render' && j.key === key && covers(j, format));
  const live = mine.find(isActiveJob);
  if (live) return live.state === 'queued' ? { kind: 'queued', ahead: live.queuePosition ?? null } : { kind: 'rendering', pct: renderPct(live, format) };
  if (renderState(version, format) === 'rendered') return { kind: 'rendered' };
  const last = mine.filter((j) => !isActiveJob(j)).sort((a, b) => ended(b).localeCompare(ended(a)))[0];
  return last?.state === 'failed' ? { kind: 'failed', error: last.error ?? null } : { kind: 'none' };
}

/**
 * "Render ★": every primary format whose ★ is a v2 version without a current render (and no render of it on the way),
 * grouped by version (one request each).
 */
export function starRenderPlan(states: Record<string, FormatState>, versions: VersionEntry[], jobs: JobSummary[], creativeJobKey: string): Map<number, string[]> {
  const plan = new Map<number, string[]>();
  for (const s of Object.values(states)) {
    if (s.follows || s.star.version === null) continue;
    const v = versions.find((x) => x.n === s.star.version);
    const r = boardRender(v, s.id, jobs, creativeJobKey);
    if (!v || !r || r.kind === 'rendered' || r.kind === 'queued' || r.kind === 'rendering') continue;
    plan.set(v.n, [...(plan.get(v.n) ?? []), s.id]);
  }
  return plan;
}
