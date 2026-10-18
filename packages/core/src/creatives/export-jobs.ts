import { randomBytes } from 'node:crypto';
import { exportJobKey, renderJobsPct, type ExportJobInfo, type JobSummary } from '@motion-studio/shared';
import { t } from '../i18n.ts';
import type { JobQueue } from '../jobs/job-queue.ts';
import type { CreativeRef } from './creative-turns.ts';
import type { RenderWait } from './render-jobs.ts';

/**
 * Export jobs (decision 974, user report 20): "render what is missing, then copy into the folder" runs on the core as a job,
 * so the dialog may close and the export finishes on its own. One job per export, key `export:<root>:<project>:<creative>:<id>`,
 * kind `export`, in its own lane (`export`): it never takes an agent turn's slot, and it waits for its renders in the render
 * lane without holding it. While it waits, `export.pct` is the progress of the render jobs it waits for; then `copying`;
 * once done, `export` lists the files written. A cancel aborts the wait and cancels the render jobs the export started (never
 * one another request started and shares); a failure is the job's error, in the language of the request.
 */

/** What an export run gets: its cancel, how it waits for renders, and how it tells its stage. */
export interface ExportRun {
  signal: AbortSignal;
  /** Pass to `renderAndWait` and the other waits: the jobs are tracked for the progress, and cancelled with the export. */
  wait: RenderWait;
  /** The renders are done: the files are being written. */
  copying(): void;
}

/** What an export wrote: the destination and the files, and what it left out. */
export interface ExportOutcome { destination: string; files: string[]; skipped?: string[]; excluded?: string[] }

/** How often a running export reports the progress of its renders (ms). */
const TICK_MS = 500;

export class ExportJobService {
  constructor(private readonly deps: { queue: JobQueue; tickMs?: number }) {}

  /** Enqueues an export of `ref` into `destination` (already checked by the caller); `run` does it. */
  start(ref: CreativeRef, title: string, destination: string, run: (r: ExportRun) => Promise<ExportOutcome>): JobSummary {
    const queue = this.deps.queue;
    return queue.enqueue({
      key: exportJobKey(ref.root, ref.projectSlug, ref.creativeSlug, randomBytes(4).toString('hex')),
      kind: 'export',
      lane: 'export',
      label: t().export.jobLabel({ title }),
      run: async (signal, jobId) => {
        const renders: string[] = [];
        let stage: ExportJobInfo['stage'] = 'rendering';
        const progress = (): ExportJobInfo => {
          const jobs = queue.list();
          const pct = stage === 'rendering' ? renderJobsPct(renders.map((id) => jobs.find((j) => j.id === id))) : null;
          return { stage, pct, destination, ...(renders.length ? { renders: [...renders] } : {}) };
        };
        const report = () => queue.patch(jobId, { export: progress() });
        report();
        const timer = setInterval(report, this.deps.tickMs ?? TICK_MS);
        timer.unref?.();
        try {
          const out = await run({
            signal,
            wait: { signal, onJobs: (ids) => { for (const id of ids) if (!renders.includes(id)) renders.push(id); report(); } },
            copying: () => { stage = 'copying'; report(); },
          });
          queue.patch(jobId, { export: {
            stage: 'done', pct: 100, destination: out.destination, files: out.files, ...(renders.length ? { renders: [...renders] } : {}),
            ...(out.skipped?.length ? { skipped: out.skipped } : {}), ...(out.excluded?.length ? { excluded: out.excluded } : {}),
          } });
        } finally {
          clearInterval(timer);
        }
      },
    });
  }
}
