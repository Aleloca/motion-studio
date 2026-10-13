import { useEffect, useState } from 'react';

/** How long before a signed preview URL expires the list is asked again. */
export const REFRESH_LEAD_MS = 60_000;
/** Never sooner than this, so an already short-lived URL cannot make a request loop. */
const MIN_WAIT_MS = 5_000;

/**
 * A counter that goes up shortly before the signed preview URLs of the current list expire (`expiresAt`, epoch ms; 0 or
 * absent: they never do). A search effect that depends on it asks the core again, so previews keep working in a picker left open.
 */
export function useRefreshBefore(expiresAt: number | null | undefined, now: () => number = Date.now): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!expiresAt) return;
    const wait = Math.max(MIN_WAIT_MS, expiresAt - now() - REFRESH_LEAD_MS);
    const timer = setTimeout(() => setTick((n) => n + 1), wait);
    return () => clearTimeout(timer);
  }, [expiresAt, now]);
  return tick;
}
