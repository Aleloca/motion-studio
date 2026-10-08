import type { ApprovalRequest } from '@motion-studio/shared';
import { useEffect, useRef } from 'react';
import { useT } from '../i18n.tsx';
import { toast } from '../ui/index.ts';
import { APP_TITLE, notifyApprovalsEnabled, setBadge, showNotification } from './notify.ts';

/**
 * Approval signals (spec §6.3, T8): the window title carries "(N) ", the Dock badge shows N, and each arrival of a
 * new request (an id not seen before) raises one notification and a sticky toast with "Review". Arrivals in the same
 * update are summed into one. A repeated event with a known id never notifies again. The notification and the toast
 * follow the "notify about approvals" setting; title and badge always reflect the count.
 */
export function useAttention(pendingCount: number, approvals: readonly ApprovalRequest[], onReview?: (a: ApprovalRequest) => void): void {
  const t = useT();
  const reviewRef = useRef(onReview);
  reviewRef.current = onReview;

  useEffect(() => {
    document.title = pendingCount > 0 ? `(${pendingCount}) ${APP_TITLE}` : APP_TITLE;
    setBadge(pendingCount);
  }, [pendingCount]);
  useEffect(() => () => { document.title = APP_TITLE; setBadge(0); }, []);

  /** Pending ids already signalled → the toast shown for them (if any). Only pending ids are kept. */
  const seen = useRef(new Map<string, number | null>());
  useEffect(() => {
    const pending = new Set(approvals.map((a) => a.id));
    for (const [id, toastId] of seen.current) {
      if (pending.has(id)) continue;
      // Handled elsewhere (or expired): its toast has nothing left to review.
      if (toastId !== null) toast.dismiss(toastId);
      seen.current.delete(id);
    }
    const fresh = approvals.filter((a) => !seen.current.has(a.id));
    if (fresh.length === 0) return;
    const enabled = notifyApprovalsEnabled();
    const first = fresh[0]!;
    const body = fresh.length === 1 ? first.title : t.web.shell.attention.many({ count: fresh.length });
    let toastId: number | null = null;
    if (enabled) {
      showNotification({ title: t.web.app.approvalNotificationTitle, body });
      toastId = toast.show(body, { sticky: true, action: { label: t.web.shell.attention.review, run: () => reviewRef.current?.(first) } });
    }
    for (const a of fresh) seen.current.set(a.id, a === first ? toastId : null);
  }, [approvals, t]);
}
