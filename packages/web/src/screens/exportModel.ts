// What an export job says about itself (decision 974): shared by the export dialog, the activity center and the toasts.
import type { JobSummary, Messages } from '@motion-studio/shared';

/** What an export job is doing: its renders (with their progress), the copy, or waiting to start. */
export function stageText(job: JobSummary | undefined, x: Messages['web']['exportUi']): string {
  const info = job?.export;
  if (info?.stage === 'copying') return x.copying;
  if (info?.stage === 'rendering' && info.renders?.length) return x.renderingFirst({ pct: info.pct ?? 0 });
  return x.running;
}
