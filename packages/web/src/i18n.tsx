import { messages, resolveLocale, type LanguageSetting, type Locale, type Messages } from '@motion-studio/shared';
import { createContext, useContext, useEffect, type ReactNode } from 'react';

/** Language used outside a provider and before the first snapshot: the browser's preferred languages. */
const systemLocale = (): Locale => resolveLocale('system', typeof navigator === 'undefined' ? [] : navigator.languages);
/** `systemLocale` is what 'system' resolves to on the core's machine. */
export interface LanguageState { locale: Locale; setting: LanguageSetting; systemLocale: Locale }

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

/** The browser's own language: the "System (…)" label before the first snapshot tells the core's. */
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

/**
 * A shared "when" for lists and details (spec boards: "today 14:28"): today with the time, "yesterday", then the date
 * (with the year when it is not this year). Calendar days in the user's time zone; words from Intl, no catalog strings.
 */
export function formatWhen(locale: Locale, iso: string, now: number = Date.now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(now);
  const days = Math.round((day(today) - day(date)) / 86_400_000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (days <= 0) return `${rtf.format(0, 'day')} ${new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)}`;
  if (days === 1) return rtf.format(-1, 'day');
  return formatDate(locale, iso, date.getFullYear() === today.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [['second', 60], ['minute', 60], ['hour', 24], ['day', 7]];

/**
 * "5 min ago", "yesterday", "2 hours ago" in `locale` (Intl, no catalog strings); after a week the date. Future times
 * (clock skew) read as now.
 */
export function relativeTime(locale: Locale, iso: string, now: number = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  let value = Math.max(0, (now - at) / 1000);
  if (value < 45) return rtf.format(0, 'second');
  for (const [unit, size] of RELATIVE_STEPS) {
    if (value < size) return rtf.format(-Math.round(value), unit);
    value /= size;
  }
  return formatDate(locale, iso);
}
