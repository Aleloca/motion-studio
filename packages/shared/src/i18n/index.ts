import { en } from './en.ts';
import { it } from './it.ts';

/** Supported UI languages; the first is the default and fallback. Adding one here requires its catalog and name below. */
export const LOCALES = ['en', 'it'] as const;
export type Locale = (typeof LOCALES)[number];
export type LanguageSetting = 'system' | Locale;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Strings widen to `string` (so `it` can differ); function parameter shapes are kept. */
type DeepWiden<T> = T extends string
  ? string
  : T extends (...args: never[]) => unknown
    ? T
    : { -readonly [K in keyof T]: DeepWiden<T[K]> };
export type Messages = DeepWiden<typeof en>;

const CATALOGS: Record<Locale, Messages> = { en, it };
/** English name of each language, used in agent prompts ("reply in Italian"). */
const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', it: 'Italian' };

/** `it_IT.UTF-8`, `IT`, `it-it` → `it`; `C`, `POSIX`, empty and `*` → null. */
function primaryLanguage(tag: string): string | null {
  const primary = tag.trim().toLowerCase().replace(/_/g, '-').split(/[-.@]/)[0] ?? '';
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

/** An explicit choice wins; otherwise the first system tag whose language is supported; otherwise English. */
export function resolveLocale(setting: LanguageSetting | undefined, systemLocales: readonly string[]): Locale {
  if (isLocale(setting)) return setting;
  for (const tag of systemLocales) {
    const lang = primaryLanguage(tag);
    if (isLocale(lang)) return lang;
  }
  return 'en';
}

export function messages(locale: Locale): Messages {
  return CATALOGS[locale];
}

export function languageName(locale: Locale): string {
  return LANGUAGE_NAMES[locale];
}
