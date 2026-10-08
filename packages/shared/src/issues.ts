import { messages, type Locale } from './i18n/index.ts';

export interface IssueLike { code?: string; message: string; path?: PropertyKey[] }

/** Schemas carry `issue.<key>` codes as messages; the user-facing text comes from the catalog of the requested language. */
const CODE_PREFIX = 'issue.';
/** The code a zod "wrong type or missing" issue stands for, by the name of the field it is about. */
const FIELD_CODES: Record<string, string> = {
  id: 'id', name: 'nameRequired', hex: 'hex', role: 'role', family: 'familyRequired', weights: 'weights',
  file: 'fileInvalid', variant: 'variant', background: 'background', text: 'textRequired', source: 'sourceInvalid',
};
const ZOD_DEFAULT = /^Invalid input/;

/**
 * Text of one validation issue in `locale`. A message that is not a known code (zod's own wording) is returned as is,
 * unless `fieldHints` asks to word a missing or mistyped field by its name.
 */
export function issueText(issue: IssueLike, locale: Locale, opts: { fieldHints?: boolean } = {}): string {
  const table = messages(locale).issues as Record<string, string>;
  if (issue.message.startsWith(CODE_PREFIX)) {
    const key = issue.message.slice(CODE_PREFIX.length);
    if (Object.hasOwn(table, key)) return table[key]!;
  }
  if (opts.fieldHints && issue.code === 'invalid_type' && ZOD_DEFAULT.test(issue.message)) {
    const field = issue.path?.[0];
    const key = typeof field === 'string' && Object.hasOwn(FIELD_CODES, field) ? FIELD_CODES[field]! : 'missingValue';
    return table[key]!;
  }
  return issue.message;
}

/** `path: text` for every issue, joined with "; ". */
export const issuesText = (error: { issues: IssueLike[] }, locale: Locale, root = ''): string =>
  error.issues.map((i) => `${i.path?.length ? i.path.map(String).join('.') : root}: ${issueText(i, locale)}`).join('; ');
