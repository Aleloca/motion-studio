import { messages, resolveLocale, type LanguageSetting, type Locale, type Messages } from '@motion-studio/shared';

let current: Locale = 'en';

/** The language of every message the core returns to the UI. Changes at runtime; agent runs already started are untouched. */
export function setLocale(l: Locale): void { current = l; }
export function currentLocale(): Locale { return current; }
export function t(): Messages { return messages(current); }

/** `it_IT.UTF-8` → `it-IT`; `C`, `POSIX` and empty values → null. */
function normalizePosixLocale(value: string | undefined): string | null {
  const base = (value ?? '').trim().split(/[.@]/)[0] ?? '';
  if (!base || base === 'C' || base === 'POSIX') return null;
  return base.replace(/_/g, '-');
}

/** The user's preferred languages, most specific first: LC_ALL, LC_MESSAGES, LANG, then the runtime's own locale. */
export function detectSystemLocales(env: Record<string, string | undefined> = process.env): string[] {
  const found = [env.LC_ALL, env.LC_MESSAGES, env.LANG].map(normalizePosixLocale).filter((l): l is string => l !== null);
  return [...found, Intl.DateTimeFormat().resolvedOptions().locale];
}

/** The language setting and the locale it resolves to; applying a change switches the process-wide locale and tells subscribers. */
export class LanguageController {
  private readonly listeners = new Set<(locale: Locale, setting: LanguageSetting) => void>();
  constructor(private current_: LanguageSetting, private readonly systemLocales: readonly string[]) {}

  get setting(): LanguageSetting { return this.current_; }
  get locale(): Locale { return currentLocale(); }

  /** Sets the process-wide locale from the current setting (startup). */
  apply(): void { setLocale(resolveLocale(this.current_, this.systemLocales)); }

  set(setting: LanguageSetting): void {
    this.current_ = setting;
    this.apply();
    for (const cb of this.listeners) cb(this.locale, setting);
  }

  onChange(cb: (locale: Locale, setting: LanguageSetting) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
}
