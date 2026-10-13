// The languages a creative can be localized into (Phase 12, spec §3.4): a curated list of left-to-right languages.

type Script = 'latin' | 'cyrillic' | 'greek' | 'han-sc' | 'han-tc' | 'jp' | 'kr' | 'devanagari' | 'thai';
const l = <T extends string>(tag: T, name: string, script: Script) => ({ tag, name, script, rtl: false as const });

/** `name` is the English name, used in agent prompts; the UI may show a localized one. */
export const SUPPORTED_LOCALES = [
  l('en', 'English', 'latin'), l('it', 'Italian', 'latin'), l('fr', 'French', 'latin'), l('de', 'German', 'latin'),
  l('es', 'Spanish', 'latin'), l('pt', 'Portuguese', 'latin'), l('nl', 'Dutch', 'latin'), l('sv', 'Swedish', 'latin'),
  l('da', 'Danish', 'latin'), l('nb', 'Norwegian', 'latin'), l('fi', 'Finnish', 'latin'), l('pl', 'Polish', 'latin'),
  l('cs', 'Czech', 'latin'), l('hu', 'Hungarian', 'latin'), l('ro', 'Romanian', 'latin'), l('ca', 'Catalan', 'latin'),
  l('el', 'Greek', 'greek'), l('ru', 'Russian', 'cyrillic'), l('uk', 'Ukrainian', 'cyrillic'), l('tr', 'Turkish', 'latin'),
  l('id', 'Indonesian', 'latin'), l('vi', 'Vietnamese', 'latin'),
  l('zh-Hans', 'Chinese (Simplified)', 'han-sc'), l('zh-Hant', 'Chinese (Traditional)', 'han-tc'),
  l('ja', 'Japanese', 'jp'), l('ko', 'Korean', 'kr'), l('hi', 'Hindi', 'devanagari'), l('th', 'Thai', 'thai'),
] as const;

export type LocaleTag = (typeof SUPPORTED_LOCALES)[number]['tag'];
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Right-to-left languages: not supported in this phase, listed only so the UI can show them disabled with the reason. */
export const RTL_LOCALES = ['ar', 'he', 'fa', 'ur'] as const;

/** The Noto Sans family added at the end of a text clip's font chain for a script (Latin, Cyrillic and Greek need none). */
export const FALLBACK_FONT_BY_SCRIPT: Record<string, string> = {
  'han-sc': 'Noto Sans SC', 'han-tc': 'Noto Sans TC', jp: 'Noto Sans JP', kr: 'Noto Sans KR',
  devanagari: 'Noto Sans Devanagari', thai: 'Noto Sans Thai',
};

const TAGS: ReadonlySet<string> = new Set(SUPPORTED_LOCALES.map((x) => x.tag));
export const isSupportedLocale = (tag: unknown): tag is LocaleTag => typeof tag === 'string' && TAGS.has(tag);
export const isRtlLocale = (tag: string): boolean => (RTL_LOCALES as readonly string[]).includes(tag.split('-')[0]!.toLowerCase());
/** The fallback font family for a locale's script, or null when the script needs none. */
export const fallbackFontFor = (tag: LocaleTag): string | null => FALLBACK_FONT_BY_SCRIPT[SUPPORTED_LOCALES.find((x) => x.tag === tag)!.script] ?? null;
