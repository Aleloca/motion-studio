import { languageName, messages, resolveLocale, type LanguageSetting, type Locale, type Messages } from '@motion-studio/shared';

export { isLocale, resolveLocale } from '@motion-studio/shared';

let current: Locale = 'en';

/** The language of every message the core returns to the UI. Changes at runtime; agent runs already started are untouched. */
export function setLocale(l: Locale): void { current = l; }
export function currentLocale(): Locale { return current; }
export function t(): Messages { return messages(current); }

/** The closing instruction of every agent prompt: reply and write user-facing texts in the user's language. */
export const replyInstruction = (locale: Locale): string =>
  `Always reply to the user in ${languageName(locale)}. Write every text meant for the user (conversation messages, brand guidelines, asset descriptions, problem reports) in ${languageName(locale)}.`;

/**
 * Report 70: the closing instruction of a chat with the user (the brief chat, a creative's chat, the group's coordinator, the
 * console): the agent replies in the language the user writes in, whatever the app's language. A message that shows no
 * language keeps the conversation's (round 1, I2); the app's language only before the user wrote any. `others`: what else is
 * written, and in which language (default: the other user-facing texts in the app's language).
 */
export const chatReplyInstruction = (locale: Locale, others = `Write every other text meant for the user (brand guidelines, asset descriptions, problem reports) in ${languageName(locale)}.`): string =>
  `Reply to the user in the language they write in (your messages and your AskUserQuestion questions alike), whatever the app's language. When their latest message shows no language (only "ok", a name, a number or a file), keep the language they have been writing in during this conversation; only when they have not written anything in a language yet, reply in ${languageName(locale)}. ${others}`;

/** `it_IT.UTF-8` → `it-IT`; `C`, `POSIX` and empty values → null. */
function normalizePosixLocale(value: string | undefined): string | null {
  const base = (value ?? '').trim().split(/[.@]/)[0] ?? '';
  if (!base || base === 'C' || base === 'POSIX') return null;
  return base.replace(/_/g, '-');
}

/** The user's preferred languages, most specific first: LC_ALL, LC_MESSAGES, LANG, then the runtime's own locale. */
export function detectSystemLocales(env: Record<string, string | undefined> = process.env): string[] {
  // POSIX precedence: the first variable that is set decides (a "C" there means no preference), the others are ignored.
  const first = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((v) => v !== undefined && v.trim() !== '');
  const found = normalizePosixLocale(first);
  return [...(found ? [found] : []), Intl.DateTimeFormat().resolvedOptions().locale];
}

/** The language setting and the locale it resolves to; applying a change switches the process-wide locale and tells subscribers. */
export class LanguageController {
  private readonly listeners = new Set<(locale: Locale, setting: LanguageSetting) => void>();
  constructor(private current_: LanguageSetting, private readonly systemLocales: readonly string[]) {}

  get setting(): LanguageSetting { return this.current_; }
  get locale(): Locale { return currentLocale(); }
  /** What 'system' resolves to (shown as "System (…)" in Settings). */
  get systemLocale(): Locale { return resolveLocale('system', this.systemLocales); }

  /** Sets the process-wide locale from the current setting (startup). */
  apply(): void { setLocale(resolveLocale(this.current_, this.systemLocales)); }

  set(setting: LanguageSetting): void {
    this.current_ = setting;
    this.apply();
    // One failing subscriber must not abort the switch nor the others.
    for (const cb of this.listeners) {
      try { cb(this.locale, setting); } catch (err) { console.error('language listener failed:', err); }
    }
  }

  onChange(cb: (locale: Locale, setting: LanguageSetting) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
}
