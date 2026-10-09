import type { AgentEvent } from '@motion-studio/shared';

/** Latest step the job reported (agent progress), if any. */
export function lastStep(events: AgentEvent[] | undefined): string | null {
  if (!events) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'progress' && e.text.trim()) return e.text.trim();
  }
  return null;
}
