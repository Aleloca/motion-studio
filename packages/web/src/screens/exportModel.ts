// What an export job says about itself (decision 974): shared by the export dialog, the activity center and the toasts.
import type { JobSummary, Messages } from '@motion-studio/shared';

/** What an export job is doing: its renders (with their progress), the copy, or waiting to start. */
export function stageText(job: JobSummary | undefined, x: Messages['web']['exportUi']): string {
  const info = job?.export;
  if (info?.stage === 'copying') return x.copying;
  if (info?.stage === 'rendering' && info.renders?.length) return x.renderingFirst({ pct: info.pct ?? 0 });
  return x.running;
}

/**
 * Review #9: what the export dialog leaves behind for its job. `setRetry`: sends the same export again with "Render anyway"
 * (the dialog's own request, kept for when it is closed); `watch`: the dialog is open on the job and shows its end itself.
 */
const retries = new Map<string, () => Promise<unknown>>();
const watching = new Map<string, number>();
export const exportRegistry = {
  setRetry(id: string, run: () => Promise<unknown>): void { retries.set(id, run); },
  /** The retry of `id`, used once (the retry starts a job of its own). */
  takeRetry(id: string): (() => Promise<unknown>) | null { const r = retries.get(id) ?? null; retries.delete(id); return r; },
  forget(id: string): void { retries.delete(id); },
  watch(id: string): () => void {
    watching.set(id, (watching.get(id) ?? 0) + 1);
    return () => { const n = (watching.get(id) ?? 1) - 1; if (n > 0) watching.set(id, n); else watching.delete(id); };
  },
  watched(id: string): boolean { return watching.has(id); },
};
