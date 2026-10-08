import type { JobSummary, Messages } from '@motion-studio/shared';

/** Brand jobs share one key per project: the job kind tells an analysis from an asset description. */
export const isDescribeJob = (job: JobSummary) => job.kind === 'asset-description';
export const brandJobRunningText = (job: JobSummary, t: Messages) => (isDescribeJob(job) ? t.web.labels.describing : t.web.labels.analyzing);
export const brandJobFailedText = (job: JobSummary, t: Messages) =>
  (isDescribeJob(job) ? t.web.labels.describeFailed({ error: job.error ?? null }) : t.web.labels.analysisFailed({ error: job.error ?? null }));
export const isActiveJob = (job: JobSummary | undefined) => Boolean(job && (job.state === 'queued' || job.state === 'running'));
