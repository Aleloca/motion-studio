import { writeVideoAnalysisSchema, type VideoAnalysisWrite } from '@motion-studio/shared';
import type { BridgeHandler } from '../bridge/bridge-routes.ts';
import type { VideoAnalysisScope } from '../bridge/bridge.ts';
import { t } from '../i18n.ts';
import { CodedError } from '../workspace-store.ts';
import { formatTime } from './sidecar.ts';

/** Calls of `write_video_analysis` one run may make (the last valid one wins). */
export const MAX_ANALYSIS_WRITES = 5;
/** How far (s) a time may fall outside the run's span (frame times are not cut times). */
const SPAN_SLACK = 0.5;

const bad = (detail: string) => new CodedError(400, t().errors.analysisBadWrite({ detail }), 'analysis-bad-write');

/** The fields each pass writes (decision 1468): a chunk only its timeline, the final pass everything but the timeline. */
const NEEDED: Record<VideoAnalysisScope['pass'], ReadonlyArray<keyof VideoAnalysisWrite>> = {
  whole: ['summary', 'timeline', 'usableMoments', 'look', 'tags'],
  chunk: ['timeline'],
  final: ['summary', 'usableMoments', 'look', 'tags'],
};

/**
 * The agent's write, checked against the run's scope (agent input): the schema, the fields of the pass (no more, no fewer),
 * every `from < to` inside the span (half a second of slack), and frames among those the run was given. Errors name the item.
 */
export function validateWrite(scope: Pick<VideoAnalysisScope, 'pass' | 'from' | 'to' | 'frames'>, raw: unknown): VideoAnalysisWrite {
  const parsed = writeVideoAnalysisSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw bad(`${issue?.path.length ? issue.path.join('.') : 'write'}: ${issue?.message ?? 'invalid'}`);
  }
  const w = parsed.data;
  const needed = NEEDED[scope.pass];
  for (const k of Object.keys(w) as Array<keyof VideoAnalysisWrite>) if (!needed.includes(k)) throw bad(`${k}: not part of this run (write only ${needed.join(', ')})`);
  for (const k of needed) if (w[k] === undefined) throw bad(`${k}: missing (write ${needed.join(', ')})`);
  const lo = scope.from - SPAN_SLACK, hi = scope.to + SPAN_SLACK;
  const timed = (list: 'timeline' | 'usableMoments', items: ReadonlyArray<{ from: number; to: number }>) => items.forEach((x, n) => {
    if (!(x.from < x.to)) throw bad(`${list}[${n}]: from must be before to`);
    if (x.from < lo || x.to > hi) throw bad(`${list}[${n}]: ${formatTime(x.from)}–${formatTime(x.to)} is outside ${formatTime(scope.from)}–${formatTime(scope.to)} (${scope.from}–${scope.to} s)`);
  });
  timed('timeline', w.timeline ?? []);
  timed('usableMoments', w.usableMoments ?? []);
  (w.timeline ?? []).forEach((x, n) => {
    if (x.frame !== undefined && !scope.frames.includes(x.frame)) throw bad(`timeline[${n}]: frame ${JSON.stringify(x.frame)} is not one of the frames you were given`);
  });
  return w;
}

/**
 * The bridge handler of `write_video_analysis`: only a `video-analysis` job with its scope, at most five calls per run (one
 * job runs once per chunk, each run with its own scope); the validated write is handed to the scope (the last one wins).
 */
export function videoAnalysisTools(): Record<'write_video_analysis', BridgeHandler> {
  const calls = new WeakMap<object, number>();
  return {
    write_video_analysis: async (c, args) => {
      const scope = c.videoAnalysisScope;
      if (c.kind !== 'video-analysis' || !scope) throw new CodedError(403, t().errors.toolUnavailable, 'tool-unavailable');
      const n = (calls.get(scope) ?? 0) + 1;
      calls.set(scope, n);
      if (n > MAX_ANALYSIS_WRITES) throw new CodedError(429, t().errors.analysisWriteLimit, 'analysis-write-limit');
      scope.write(validateWrite(scope, args));
      return { ok: true };
    },
  };
}
