import { en } from './en.ts';
import { it } from './it.ts';

export type Locale = 'en' | 'it';
export const LOCALES: readonly Locale[] = ['en', 'it'];
export type LanguageSetting = 'system' | Locale;

/** Strings widen to `string` (so `it` can differ); function parameter shapes are kept. */
type DeepWiden<T> = T extends string
  ? string
  : T extends (...args: never[]) => unknown
    ? T
    : { -readonly [K in keyof T]: DeepWiden<T[K]> };
export type Messages = DeepWiden<typeof en>;

const CATALOGS: Record<Locale, Messages> = { en, it };

/** `it_IT.UTF-8`, `IT`, `it-it` → `it`; `C`, `POSIX`, empty and `*` → null. */
function primaryLanguage(tag: string): string | null {
  const primary = tag.trim().toLowerCase().replace(/_/g, '-').split(/[-.@]/)[0] ?? '';
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

export function resolveLocale(setting: LanguageSetting | undefined, systemLocales: readonly string[]): Locale {
  if (setting === 'en' || setting === 'it') return setting;
  for (const tag of systemLocales) {
    const lang = primaryLanguage(tag);
    if (lang === 'it') return 'it';
  }
  return 'en';
}

export function messages(locale: Locale): Messages {
  return CATALOGS[locale];
}

export function languageName(locale: Locale): string {
  return locale === 'it' ? 'Italian' : 'English';
}

export function plural(locale: Locale, n: number, forms: { one: string; other: string }): string {
  return new Intl.PluralRules(locale).select(n) === 'one' ? forms.one : forms.other;
}
