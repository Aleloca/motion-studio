// Render state of the v2 (composition) versions on the web side (Task 8, spec §5.3): per board "Not rendered",
// "Queued · 2 renders ahead", "Rendering 42%", "Rendered", "Render problem · Render again", "Render failed · Retry", from the version's records and the live
// render jobs; and what "Render ★" renders.
import { renderJobKeyOf, renderProblems, renderState, type Locale, type Messages, type OutputIssue, type JobSummary, type VersionComposition, type VersionEntry } from '@motion-studio/shared';
import type { FormatState } from './versionModel.ts';

export type BoardRender =
  | { kind: 'none' }
  | { kind: 'queued'; ahead: number | null }
  | { kind: 'rendering'; pct: number }
  | { kind: 'rendered' }
  /** A current render whose output checks found problems (size, duration, resolution, unreadable): never "Rendered" (I2). */
  | { kind: 'problem'; problems: string[] }
  | { kind: 'failed'; error: string | null };

/** The composition of `format` in a version (v2); null for a legacy version or a format it lacks. */
export const compositionOf = (v: VersionEntry | null | undefined, format: string): VersionComposition | null =>
  v?.compositions?.find((c) => c.format === format) ?? null;

/** The render jobs' key of version n, from the creative's job key: the shared rule the core keys its jobs with. */
export const renderKeyOf = (creativeJobKey: string, n: number): string | null => renderJobKeyOf(creativeJobKey, n);

export const isActiveJob = (j: JobSummary) => j.state === 'queued' || j.state === 'running';
/** A render job of the version keyed `key`: the first one, or a follow-up queued behind it (`<key>:<k>`, core I3). */
export const isVersionJob = (j: JobSummary, key: string | null) => key !== null && (j.key === key || j.key.startsWith(`${key}:`));
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
  const mine = jobs.filter((j) => j.kind === 'render' && isVersionJob(j, key) && covers(j, format));
  const live = mine.find(isActiveJob);
  if (live) return live.state === 'queued' ? { kind: 'queued', ahead: live.queuePosition ?? null } : { kind: 'rendering', pct: renderPct(live, format) };
  if (renderState(version, format) === 'rendered') {
    const problems = renderProblems(version, format);
    return problems.length ? { kind: 'problem', problems } : { kind: 'rendered' };
  }
  const last = mine.filter((j) => !isActiveJob(j)).sort((a, b) => ended(b).localeCompare(ended(a)))[0];
  return last?.state === 'failed' ? { kind: 'failed', error: last.error ?? null } : { kind: 'none' };
}

/**
 * "Render ★": every primary format whose ★ is a v2 version without a current render (and no render of it on the way),
 * grouped by version (one request each). A current render with problems is not rendered again here (the board offers it).
 */
export function starRenderPlan(states: Record<string, FormatState>, versions: VersionEntry[], jobs: JobSummary[], creativeJobKey: string): Map<number, string[]> {
  const plan = new Map<number, string[]>();
  for (const s of Object.values(states)) {
    if (s.follows || s.star.version === null) continue;
    const v = versions.find((x) => x.n === s.star.version);
    const r = boardRender(v, s.id, jobs, creativeJobKey);
    if (!v || !r || r.kind === 'rendered' || r.kind === 'problem' || r.kind === 'queued' || r.kind === 'rendering') continue;
    plan.set(v.n, [...(plan.get(v.n) ?? []), s.id]);
  }
  return plan;
}

/** The short reasons of a render's problems in the UI's language (P2), e.g. "duration 4.8 s instead of 6 s"; the core's own
 * texts (without their file name) when the render recorded no codes. */
export function shortProblems(o: { problems?: string[]; issues?: OutputIssue[] } | null | undefined, m: Messages, locale: Locale): string[] {
  const s = m.web.exportUi.problemShort;
  const n = (v: unknown) => (typeof v === 'number' ? formatNumberIn(locale, v) : String(v ?? ''));
  if (o?.issues?.length) {
    return o.issues.map((i) => {
      const p = i.params;
      switch (i.code) {
        case 'tooLarge': return s.tooLarge({ size: n(p.size), max: n(p.max) });
        case 'durationOffTarget': return s.durationOffTarget({ duration: n(p.duration), target: n(p.target) });
        case 'durationOverMax': return s.durationOverMax({ duration: n(p.duration), max: n(p.max) });
        case 'badResolution': return s.badResolution({ size: `${n(p.width)}×${n(p.height)}`, expected: `${n(p.expectedWidth)}×${n(p.expectedHeight)}` });
        case 'notReadable': return s.notReadable;
        case 'badExtension': return s.badExtension({ ext: String(p.ext ?? '') });
        default: return '';
      }
    }).filter(Boolean);
  }
  return (o?.problems ?? []).map((p) => p.replace(/^[^:]{1,200}:\s*/, ''));
}
const formatNumberIn = (locale: Locale, v: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(v);
