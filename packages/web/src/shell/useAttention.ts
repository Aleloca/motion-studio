import type { ApprovalRequest, JobSummary } from '@motion-studio/shared';
import { useEffect, useRef } from 'react';
import { useT } from '../i18n.tsx';
import { toast } from '../ui/index.ts';
import { desktop, showExported } from '../desktop.ts';
import { message } from '../errors.ts';
import { exportRegistry } from '../screens/exportModel.ts';
import { jobHref } from './ActivityCenter.tsx';
import { go } from './ShellContext.tsx';
import { isMac } from '../platform.ts';
import { APP_TITLE, appInBackground, notifyApprovalsEnabled, notifyReadyEnabled, onNotificationClick, setBadge, setDraftsUnsaved, setRendersRunning, showNotification } from './notify.ts';

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

  // A click on the desktop notification runs the same Review as the toast: the request it announced if still
  // pending, else the oldest pending one (the window has already been brought forward by the main process).
  const notified = useRef<string | null>(null);
  const pendingRef = useRef(approvals);
  pendingRef.current = approvals;
  useEffect(() => onNotificationClick(() => {
    const list = pendingRef.current;
    const target = list.find((a) => a.id === notified.current) ?? [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (target) reviewRef.current?.(target);
  }), []);

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
        notified.current = first.id;
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

/**
 * Decision 974 (user report 20): an export this window saw queued or running tells when it ends. Done: a toast "3 files
 * exported to …" with Show in Finder (desktop) and, while the app is in the background, a notification; failed: a toast
 * with the reason. A cancelled export says nothing (the user cancelled it). The activity center's Done list (the bell)
 * keeps it either way.
 */
export function useExportNotice(jobs: Readonly<Record<string, JobSummary>>): void {
  const t = useT();
  const active = useRef(new Set<string>());
  useEffect(() => {
    const x = t.web.exportUi;
    for (const job of Object.values(jobs)) {
      if (job.kind !== 'export') continue;
      if (job.state === 'queued' || job.state === 'running') { active.current.add(job.id); continue; }
      if (!active.current.delete(job.id)) continue;
      const info = job.export;
      const retry = job.state === 'failed' ? exportRegistry.takeRetry(job.id) : (exportRegistry.forget(job.id), null);
      if (job.state === 'succeeded' && info) {
        const files = info.files ?? [];
        // Review #9: what was left out is said with what to do (the dialog, if it is closed, is where the reasons are).
        const leftOut = (info.skipped?.length ?? 0) + (info.excluded?.length ?? 0);
        const done = x.doneToast({ count: files.length, folder: info.destination });
        const body = leftOut > 0 ? `${done}. ${x.doneLeftOut({ count: leftOut })}` : done;
        const bridge = desktop();
        const action = bridge ? { label: isMac() ? x.showInFinder : x.showInFolder, run: () => { void showExported(bridge, info.destination, files).catch(() => {}); } } : undefined;
        toast.show(body, { tone: leftOut > 0 ? 'neutral' : 'ok', ...(leftOut > 0 ? { sticky: true } : {}), ...(action ? { action } : {}) });
        if (appInBackground()) showNotification({ title: x.doneNotification, body });
      } else if (job.state === 'failed' && info?.refusal?.code === 'localization-needs-force') {
        // The dialog that started it is open: it shows the list and "Render anyway" itself.
        if (exportRegistry.watched(job.id)) continue;
        const body = x.needsForceToast({ list: (info.refusal.problems ?? []).join(', ') });
        const where = jobHref(job);
        const action = retry ? { label: t.web.languages.renderAnyway, run: () => { void retry().catch((e: unknown) => toast.show(x.failed({ detail: message(e) }))); } }
          : where ? { label: t.web.shell.activity.open, run: () => go(where) } : undefined;
        toast.show(body, { sticky: true, ...(action ? { action } : {}) });
        if (appInBackground()) showNotification({ title: x.doneNotification, body });
      } else if (job.state === 'failed') {
        toast.show(x.failed({ detail: job.error ?? t.web.jobState.failed }));
      }
    }
  }, [jobs, t]);
}

/**
 * The desktop app learns how many renders (and exports, decision 974) are queued or running (its close confirmation,
 * Task 8); 0 when the page goes.
 */
export function useRenderCloseGuard(jobs: Record<string, JobSummary>): void {
  const count = Object.values(jobs).filter((j) => (j.kind === 'render' || j.kind === 'export') && (j.state === 'queued' || j.state === 'running')).length;
  useEffect(() => { setRendersRunning(count); }, [count]);
  useEffect(() => () => setRendersRunning(0), []);
}

/**
 * Unsaved editor drafts (Phase 10b): the desktop app learns the count (its close confirmation is the render guard's, with
 * a draft question), and `beforeunload` holds back a reload or a tab close: a browser asks itself, the desktop app answers
 * through its `will-prevent-unload` handler with the same "Discard / Keep editing" dialog (final review I3). 0 when the page goes.
 */
export function useDraftCloseGuard(count: number): void {
  useEffect(() => { setDraftsUnsaved(count); }, [count]);
  useEffect(() => () => setDraftsUnsaved(0), []);
  useEffect(() => {
    if (count === 0) return;
    const on = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    addEventListener('beforeunload', on);
    return () => removeEventListener('beforeunload', on);
  }, [count]);
}
