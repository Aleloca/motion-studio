import type { JobState } from '@motion-studio/shared';
import type { JobQueue } from './job-queue.ts';

/**
 * Phase 13 Stop (POST /api/jobs/:id/stop), for every kind of job: the job's open approvals are cancelled first (no
 * spending after a stop: a pending paid confirmation resolves as cancelled before anything else), then the job is cancelled
 * as `/cancel` does. Its signal ends the agent run (the runner kills the process group even when the CLI never sends a
 * result) and the core tools it started. null: no such job. `stopping`: it was running and is being stopped now.
 */
export function stopJob(deps: { queue: JobQueue; approvals: { cancelJob(jobId: string): void } }, id: string): { status: JobState | 'stopping' } | null {
  const job = deps.queue.list().find((j) => j.id === id);
  if (!job) return null;
  if (job.state !== 'queued' && job.state !== 'running') return { status: job.state };
  deps.approvals.cancelJob(id);
  deps.queue.cancel(id);
  return { status: job.state === 'queued' ? 'cancelled' : 'stopping' };
}
