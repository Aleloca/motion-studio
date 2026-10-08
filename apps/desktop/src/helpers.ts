import { isAbsolute, join } from 'node:path';
import { AppConfigStore, isLocale, resolveLocale, type currentLocale, type LoginShellPath, type t } from '@motion-studio/core';

type Locale = ReturnType<typeof currentLocale>;
type Messages = ReturnType<typeof t>;

/** The UI token travels only in the URL fragment (`#t=<token>`). */
export function tokenFromAppUrl(appUrl: string): string | null {
  try { return new URLSearchParams(new URL(appUrl).hash.slice(1)).get('t'); } catch { return null; }
}

/** Validated payload of `ms:pick-folder`, or null when it is malformed. */
export function pickFolderArgs(arg: unknown): { title: string; defaultPath?: string } | null {
  if (typeof arg !== 'object' || arg === null) return null;
  const { title, defaultPath } = arg as Record<string, unknown>;
  if (typeof title !== 'string') return null;
  if (defaultPath === undefined) return { title };
  return typeof defaultPath === 'string' ? { title, defaultPath } : null;
}

/** Validated payload of `ms:reveal`: an absolute path, nothing else. */
export function absolutePathArg(arg: unknown): string | null {
  return typeof arg === 'string' && arg !== '' && !arg.includes('\0') && isAbsolute(arg) ? arg : null;
}

/** A slow rc file (nvm, conda…) is common on real Macs: 15 s before falling back to the fixed folders. */
export const loginShellOptions = () => ({ timeoutMs: 15_000 });

/** startServer options of the desktop app: port 4318 (or a free one), bundled UI and MCP server, PATH origin for the Doctor. */
export function serverOptions(opts: { resources: { webDir: string; mcpServerPath: string }; configDir?: string; shellPath: LoginShellPath }) {
  const { source, error } = opts.shellPath;
  return {
    port: 'auto' as const,
    ...(opts.configDir ? { configDir: opts.configDir } : {}),
    ...opts.resources,
    mcpEnv: { ELECTRON_RUN_AS_NODE: '1' },
    shellPath: error === undefined ? { source } : { source, error },
  };
}

/** Electron's own data (cache, local storage, single-instance lock): beside, never inside, the Motion Studio config folder. */
export const userDataDir = (appData: string) => join(appData, 'Motion Studio Electron');

export interface FocusableWindow { isMinimized(): boolean; restore(): void; focus(): void }

/** Focus requests from a second launch: served at once when the window is ready, else remembered until it is. */
export function focusOnReady() {
  let win: FocusableWindow | null = null;
  let pending = false;
  const focus = (w: FocusableWindow) => { if (w.isMinimized()) w.restore(); w.focus(); };
  return {
    request() { if (win) focus(win); else pending = true; },
    ready(w: FocusableWindow) {
      win = w;
      if (pending) { pending = false; focus(w); }
    },
  };
}

/** Prompt shown when the instance the window is attached to (a CLI or another core) goes away. */
export const attachedGone = (m: Messages['desktop']) => ({ message: m.attachedGoneMessage, buttons: [m.attachedGoneRestart, m.attachedGoneQuit] });
/** Button index of the ATTACHED_GONE prompt → what to do (Escape / anything else closes). */
export const attachedGoneAction = (response: number): 'relaunch' | 'quit' => (response === 0 ? 'relaunch' : 'quit');

/**
 * Watches the instance an attached window depends on: `check` every `intervalMs` (one at a time), `failed()` for a failed
 * page load. `onGone` fires once, on the first failure; then the watch stops.
 */
export function watchAttached(opts: { check: () => Promise<boolean>; onGone: () => void; intervalMs?: number }) {
  let stopped = false;
  let pending = false;
  const stop = () => { stopped = true; clearInterval(timer); };
  const gone = () => { if (stopped) return; stop(); opts.onGone(); };
  const timer = setInterval(() => {
    if (pending || stopped) return;
    pending = true;
    opts.check().catch(() => false).then((ok) => { pending = false; if (!ok) gone(); });
  }, opts.intervalMs ?? 5000);
  return { stop, failed: gone };
}

/**
 * Language of an attached window (no in-process core): the live instance's own language from `/api/settings/language`,
 * else the system-resolved one. It is read once at attach time; later changes in the other instance are not followed.
 */
export async function attachedLocale(opts: { origin: string; token: string | null; fallback: Locale; fetchFn?: typeof fetch }): Promise<Locale> {
  try {
    const res = await (opts.fetchFn ?? fetch)(`${opts.origin}/api/settings/language`, { headers: { 'x-motion-studio-ui': opts.token ?? '' }, signal: AbortSignal.timeout(2000) });
    if (!res.ok) return opts.fallback;
    const { locale } = (await res.json()) as { locale?: unknown };
    return isLocale(locale) ? locale : opts.fallback;
  } catch { return opts.fallback; }
}

/** The saved language setting, read without creating or rewriting the config; undefined when the file cannot be read. */
export function readSavedLanguage(configDir: string): Promise<unknown> {
  return new AppConfigStore(configDir).read().then((c) => c.language, () => undefined);
}

/** Language before the core starts (early error boxes): the saved setting, else the system languages. */
export function bootLocale(saved: unknown, systemLanguages: readonly string[]): Locale {
  return resolveLocale(saved === 'system' || isLocale(saved) ? saved : 'system', systemLanguages);
}
