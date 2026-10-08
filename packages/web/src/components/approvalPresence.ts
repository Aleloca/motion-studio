import type { ApprovalRequest } from '@motion-studio/shared';
import { useCallback, useReducer, useRef } from 'react';

export interface ShownApproval { approval: ApprovalRequest; /** No longer pending: its card is collapsing (T15). */ leaving: boolean }

/**
 * Keeps resolved approvals on screen through their exit. An approval that leaves `approvals` stays in the list with
 * `leaving: true` until its card reports the exit finished (`gone`); if it comes back meanwhile it is simply pending
 * again, in the same place, never twice. `gone` for an id that is pending again is ignored, so a late "finished" of
 * a cancelled exit cannot remove a revived card. New approvals are appended in the order given.
 */
export function useApprovalPresence(approvals: ApprovalRequest[]): { list: ShownApproval[]; gone(id: string): void } {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const shown = useRef<ApprovalRequest[]>([]);
  const finished = useRef(new Set<string>());
  const pending = useRef(new Set<string>());

  const current = new Map(approvals.map((a) => [a.id, a]));
  for (const id of current.keys()) finished.current.delete(id);
  const next: ApprovalRequest[] = [];
  const seen = new Set<string>();
  for (const a of shown.current) {
    const now = current.get(a.id);
    if (now) next.push(now);
    else if (finished.current.has(a.id)) finished.current.delete(a.id); // its exit finished: drop it
    else next.push(a);
    seen.add(a.id);
  }
  for (const a of approvals) if (!seen.has(a.id)) { next.push(a); seen.add(a.id); }
  // Idempotent for the same input, so a repeated render (StrictMode) computes the same list.
  shown.current = next;
  pending.current = new Set(current.keys());

  const gone = useCallback((id: string) => {
    if (pending.current.has(id) || finished.current.has(id) || !shown.current.some((a) => a.id === id)) return;
    finished.current.add(id);
    rerender();
  }, []);

  return { list: shown.current.map((approval) => ({ approval, leaving: !current.has(approval.id) })), gone };
}
