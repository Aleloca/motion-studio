import type { ApprovalRequest, JobSummary } from '@motion-studio/shared';
import { useEffect, useRef } from 'react';
import { useT } from '../i18n.tsx';
import { toast } from '../ui/index.ts';
import { APP_TITLE, appInBackground, notifyApprovalsEnabled, notifyReadyEnabled, setBadge, showNotification } from './notify.ts';

export interface AttentionOptions {
  /** "Review" on a toast. */
  onReview?(a: ApprovalRequest): void;
  /** Snapshots received so far (EventsState.snapshots). Without it every new id counts as an arrival. */
  snapshot?: number;
}

/**
 * Approval signals (spec §6.3, T8):
 * - the window title carries "(N) " and the Dock badge shows N, always;
 * - each arrival of a new request (an id not seen before) raises one native notification (the Dock bounces with it)
 *   and a sticky toast with "Review"; arrivals in the same update are summed into one; a repeated id never notifies
 *   again;
 * - startup policy: the requests already waiting in a snapshot when nothing was known yet (first connection, or a
 *   reconnection with nothing pending before) are only summed into one toast "N requests need you": no notification,
 *   no bounce.
 * Notifications and toasts follow the "notify about approvals" setting.
 */
export function useAttention(pendingCount: number, approvals: readonly ApprovalRequest[], options: AttentionOptions = {}): void {
  const t = useT();
  const reviewRef = useRef(options.onReview);
  reviewRef.current = options.onReview;
  const snapshot = options.snapshot;

  useEffect(() => {
    document.title = pendingCount > 0 ? `(${pendingCount}) ${APP_TITLE}` : APP_TITLE;
    setBadge(pendingCount);
  }, [pendingCount]);
  useEffect(() => () => { document.title = APP_TITLE; setBadge(0); }, []);

  /** Pending ids already signalled → the toast shown for them (if any). Only pending ids are kept. */
  const seen = useRef(new Map<string, number | null>());
  const lastSnapshot = useRef(snapshot);
  useEffect(() => {
    const viaSnapshot = snapshot !== undefined && snapshot !== lastSnapshot.current;
    lastSnapshot.current = snapshot;
    const pending = new Set(approvals.map((a) => a.id));
    for (const [id, toastId] of seen.current) {
      if (pending.has(id)) continue;
      // Handled elsewhere (or expired): its toast has nothing left to review.
      if (toastId !== null) toast.dismiss(toastId);
      seen.current.delete(id);
    }
    const restoring = viaSnapshot && seen.current.size === 0;
    const fresh = approvals.filter((a) => !seen.current.has(a.id));
    if (fresh.length === 0) return;
    const enabled = notifyApprovalsEnabled();
    const first = fresh[0]!;
    const review = { label: t.web.shell.attention.review, run: () => reviewRef.current?.(first) };
    let toastId: number | null = null;
    if (restoring) {
      if (enabled) toastId = toast.show(t.web.shell.attention.waiting({ count: fresh.length }), { sticky: true, action: review });
    } else {
      const body = fresh.length === 1 ? first.title : t.web.shell.attention.many({ count: fresh.length });
      if (enabled) {
        showNotification({ title: t.web.app.approvalNotificationTitle, body });
        toastId = toast.show(body, { sticky: true, action: review });
      }
    }
    for (const a of fresh) seen.current.set(a.id, a === first ? toastId : null);
  }, [approvals, snapshot, t]);
}

/**
 * "When a creative is ready" (Settings → Notifications): a creative job this window saw queued or running that ends
 * successfully raises one notification, only while Motion Studio is in the background (in the foreground the canvas
 * shows "vN is ready" itself).
 */
export function useReadyNotice(jobs: Readonly<Record<string, JobSummary>>): void {
  const t = useT();
  const active = useRef(new Set<string>());
  useEffect(() => {
    for (const job of Object.values(jobs)) {
      if (job.kind !== 'creative') continue;
      if (job.state === 'queued' || job.state === 'running') { active.current.add(job.id); continue; }
      if (!active.current.delete(job.id)) continue;
      if (job.state === 'succeeded' && notifyReadyEnabled() && appInBackground()) {
        showNotification({ title: t.web.app.readyNotificationTitle, body: job.label });
      }
    }
  }, [jobs, t]);
}
