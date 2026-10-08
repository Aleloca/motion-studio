// Attention signals outside the page (spec §6.3): desktop notification and Dock badge through the preload bridge,
// with the web Notification API as the fallback.
import { desktop } from '../desktop.ts';

/** localStorage key of the "Notify me about approvals" setting (Settings → Notifications, Task 15). Default on. */
export const NOTIFY_APPROVALS_KEY = 'motion-studio.notifyApprovals';
export const APP_TITLE = 'Motion Studio';
/** The Dock badge (and the IPC validation in the main process) stop at 99. */
export const MAX_BADGE = 99;

export function notifyApprovalsEnabled(): boolean {
  try { return localStorage.getItem(NOTIFY_APPROVALS_KEY) !== 'false'; } catch { return true; }
}
export function setNotifyApprovals(on: boolean): void {
  try { localStorage.setItem(NOTIFY_APPROVALS_KEY, String(on)); } catch { /* storage unavailable: keep the default */ }
}

/** A failing bridge call must never break the page: errors are swallowed (sync throw or rejected promise). */
function quietly(call: () => unknown): void {
  try { void Promise.resolve(call()).catch(() => {}); } catch { /* ignored */ }
}

/**
 * Desktop: native notification from the main process, also with the window visible. Web: the Notification API when
 * the user granted it and the page is hidden (on a visible page the toast is enough).
 */
export function showNotification(p: { title: string; body: string }): void {
  const d = desktop();
  if (typeof d?.notify === 'function') { quietly(() => d.notify!(p)); return; }
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState === 'hidden') {
      new Notification(p.title, { body: p.body });
    }
  } catch { /* some browsers only allow notifications from a service worker */ }
}

/** Dock badge on desktop (0 clears it); nothing on the web, where the window title carries the count. */
export function setBadge(n: number): void {
  const d = desktop();
  if (typeof d?.setBadge === 'function') quietly(() => d.setBadge!(Math.max(0, Math.min(MAX_BADGE, Math.trunc(n)))));
}

/** Whether to offer "Turn on notifications" (web only: the desktop app notifies from the main process). */
export function canAskNotifications(): boolean {
  return !desktop() && typeof Notification !== 'undefined' && Notification.permission === 'default';
}
