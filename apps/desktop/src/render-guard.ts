// Closing the UI window (or quitting) while a render runs asks first (Task 8, carry 11). The quit itself cancels the renders
// cleanly (render-window.ts `shutdownForQuit`: the core cancels its jobs, each render kills its groups and removes its temp
// files); this is only the confirmation. The page reports how many renders are queued or running (ms:renders-running);
// only the app's own page is believed, and only a whole count.
import type { IpcMainInvokeEvent } from 'electron';
import type { t } from '@motion-studio/core';

type Messages = ReturnType<typeof t>;

export const RENDERS_RUNNING = 'ms:renders-running';

/** A whole count from 0 to 1000, else null. */
export function rendersArg(arg: unknown): number | null {
  return typeof arg === 'number' && Number.isInteger(arg) && arg >= 0 && arg <= 1000 ? arg : null;
}

export interface RenderGuard {
  set(n: number): void;
  running(): number;
  /** The user already agreed to stop the renders (the quit goes on). */
  confirmed(): boolean;
  /** Whether the window may close now: true without renders, else the user's answer (a yes holds for the rest of the quit). */
  mayClose(): Promise<boolean>;
}

export function createRenderGuard(o: { ask(count: number): Promise<boolean> }): RenderGuard {
  let count = 0;
  let confirmed = false;
  let asking: Promise<boolean> | null = null;
  return {
    set: (n) => { count = n; },
    running: () => count,
    confirmed: () => confirmed,
    mayClose() {
      if (confirmed || count === 0) return Promise.resolve(true);
      asking ??= o.ask(count).then((yes) => { confirmed = yes; return yes; }, () => false).finally(() => { asking = null; });
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
}

/** The dialog: "Stop and quit" (0) or "Keep rendering" (1, the default and Escape). */
export function renderRunningPrompt(m: Messages['desktop'], count: number) {
  return { message: m.renderRunningMessage({ count }), detail: m.renderRunningDetail, buttons: [m.renderRunningQuit, m.renderRunningKeep], defaultId: 1, cancelId: 1 };
}
