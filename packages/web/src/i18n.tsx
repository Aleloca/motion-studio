import { messages, resolveLocale, type LanguageSetting, type Locale, type Messages } from '@motion-studio/shared';
import { createContext, useContext, useEffect, type ReactNode } from 'react';

/** Language used outside a provider and before the first snapshot: the browser's preferred languages. */
const systemLocale = (): Locale => resolveLocale('system', typeof navigator === 'undefined' ? [] : navigator.languages);
export interface LanguageState { locale: Locale; setting: LanguageSetting }

/** The language of the mounted provider, for code that runs outside React (API error texts). */
let active: Locale | null = null;

const LocaleContext = createContext<Locale | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  active = locale;
  useEffect(() => {
    document.documentElement.lang = locale;
    active = locale;
    return () => { active = null; };
  }, [locale]);
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext) ?? systemLocale();
}

export function useT(): Messages {
  return messages(useLocale());
}

/** Messages for code outside components. Prefer `useT`. */
export function currentMessages(): Messages {
  return messages(active ?? systemLocale());
}

/** The browser's own language (used for the "System (…)" label). */
export function detectedLocale(): Locale {
  return systemLocale();
}

const DATE_TIME: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' };
export const TIME_OF_DAY: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };

/** Date of an ISO timestamp in `locale`; without options only the day is shown. */
export function formatDate(locale: Locale, iso: string, opts?: Intl.DateTimeFormatOptions): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, opts).format(date);
}

export const formatDateTime = (locale: Locale, iso: string): string => formatDate(locale, iso, DATE_TIME);

export function formatNumber(locale: Locale, value: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, opts).format(value);
}
