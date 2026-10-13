// Closing the UI window (or quitting) while a render runs asks first (Task 8, carry 11). The quit itself cancels the renders
// cleanly (render-window.ts `shutdownForQuit`: the core cancels its jobs, each render kills its groups and removes its temp
// files); this is only the confirmation. The page reports how many renders are queued or running (ms:renders-running);
// only the app's own page is believed, and only a whole count.
import type { IpcMainInvokeEvent } from 'electron';
import type { t } from '@motion-studio/core';

type Messages = ReturnType<typeof t>;

export const RENDERS_RUNNING = 'ms:renders-running';
/** The editor's drafts with edits not saved yet (Phase 10b): closing asks about them through the same guard. */
export const DRAFTS_UNSAVED = 'ms:drafts-unsaved';

/** A whole count from 0 to 1000, else null. */
export function rendersArg(arg: unknown): number | null {
  return typeof arg === 'number' && Number.isInteger(arg) && arg >= 0 && arg <= 1000 ? arg : null;
}

/** A "yes" holds this long: a quit that did not happen (aborted elsewhere) asks again on the next close. */
export const CONFIRM_TTL_MS = 60_000;

export interface RenderGuard {
  set(n: number): void;
  running(): number;
  /** The editor's unsaved drafts (a whole count), reported by the page. */
  setDrafts(n: number): void;
  drafts(): number;
  /** Renders running plus drafts unsaved: what a close has to ask about. */
  pending(): number;
  /** The user already agreed to stop the renders (the quit goes on). */
  confirmed(): boolean;
  /** Whether the window may close now: true without renders, else the user's answer (a yes holds for the rest of the quit). */
  mayClose(): Promise<boolean>;
}

/**
 * - It asks only while renders run; when the answer comes, a "no" given after every render already ended still closes.
 * - A "yes" holds for the rest of the quit, and is forgotten when the quit did not happen: after CONFIRM_TTL_MS, or as soon
 *   as a new render starts (the app is clearly still in use).
 */
export function createRenderGuard(o: { ask(count: number, drafts: number): Promise<boolean>; now?: () => number }): RenderGuard {
  const now = o.now ?? Date.now;
  let count = 0;
  let drafts = 0;
  let confirmedAt: number | null = null;
  let asking: Promise<boolean> | null = null;
  const confirmed = () => confirmedAt !== null && now() - confirmedAt < CONFIRM_TTL_MS;
  return {
    set: (n) => {
      if (n > count) confirmedAt = null;
      count = n;
    },
    running: () => count,
    setDrafts: (n) => {
      if (n > drafts) confirmedAt = null;
      drafts = n;
    },
    drafts: () => drafts,
    pending: () => count + drafts,
    confirmed,
    mayClose() {
      if (confirmed() || count + drafts === 0) return Promise.resolve(true);
      asking ??= o.ask(count, drafts).then((yes) => {
        if (yes) confirmedAt = now();
        return yes || count + drafts === 0;
      }, () => count + drafts === 0).finally(() => { asking = null; });
      return asking;
    },
  };
}

export function registerRenderGuard(ipc: { handle(channel: string, fn: (e: IpcMainInvokeEvent, arg: unknown) => unknown): void },
  d: { trusted(e: IpcMainInvokeEvent): boolean; guard: RenderGuard; invalid(): Error }): void {
  ipc.handle(RENDERS_RUNNING, (e, arg) => {
    const n = d.trusted(e) ? rendersArg(arg) : null;
    if (n === null) throw d.invalid();
    d.guard.set(n);
  });
  ipc.handle(DRAFTS_UNSAVED, (e, arg) => {
    const n = d.trusted(e) ? rendersArg(arg) : null;
    if (n === null) throw d.invalid();
    d.guard.setDrafts(n);
  });
}

/**
 * The dialog: "Stop and quit" (0) or "Keep rendering" (1, the default and Escape). With unsaved editor drafts only it asks
 * about them ("Discard and quit" / "Keep editing"); with both, the render question names the drafts in its detail.
 */
export function renderRunningPrompt(m: Messages['desktop'], count: number, drafts = 0) {
  if (count === 0 && drafts > 0) {
    return { message: m.draftUnsavedMessage({ count: drafts }), detail: m.draftUnsavedDetail, buttons: [m.draftUnsavedQuit, m.draftUnsavedKeep], defaultId: 1, cancelId: 1 };
  }
  const detail = drafts > 0 ? `${m.renderRunningDetail}\n\n${m.draftUnsavedMessage({ count: drafts })}. ${m.draftUnsavedDetail}` : m.renderRunningDetail;
  return { message: m.renderRunningMessage({ count }), detail, buttons: [m.renderRunningQuit, m.renderRunningKeep], defaultId: 1, cancelId: 1 };
}

/** The dialog of a reload (⌘R, View → Reload, a script's `location.reload()`) with unsaved drafts: discard (0) or keep editing (1, the default and Escape). */
export function reloadPrompt(m: Messages['desktop'], drafts: number) {
  return { message: m.draftUnsavedMessage({ count: drafts }), detail: m.draftReloadDetail, buttons: [m.draftReloadDiscard, m.draftUnsavedKeep], defaultId: 1, cancelId: 1 };
}

/**
 * Whether a page unload the editor's `beforeunload` held back (Electron's `will-prevent-unload`) may go on without asking:
 * the user already agreed to the quit or close, the app is quitting, or no draft is left (the page's count changed meanwhile).
 */
export function unloadWithoutAsking(g: Pick<RenderGuard, 'confirmed' | 'drafts'>, quitting: boolean): boolean {
  return quitting || g.confirmed() || g.drafts() === 0;
}
