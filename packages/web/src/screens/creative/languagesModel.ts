// The model of the Languages UI (Phase 12, Task 5): names of languages, the status of a translation, why a voice cannot be
// translated, which problems belong to which clip. Pure functions, no React.
import {
  effectiveServices, isRtlLocale, missingCapability, RTL_LOCALES, SUPPORTED_LOCALES,
  messages, type Brief, type KeyCheckResult, type Locale, type LocaleTag, type LocalizationIssue, type LocalizationRow, type Messages, type ProviderId,
} from '@motion-studio/shared';

/** The languages a creative has (`brief.locales`), or null for a creative that is not localized (old briefs). */
export function creativeLocales(brief: Pick<Brief, 'locales'>): { primary: LocaleTag; extra: LocaleTag[]; all: LocaleTag[] } | null {
  const l = brief.locales;
  if (!l) return null;
  return { primary: l.primary, extra: l.extra, all: [l.primary, ...l.extra] };
}

/** The name of a language in the UI language (Intl); the English name of the curated list when Intl does not know the tag. */
export function localeName(tag: string, ui: Locale): string {
  try {
    const name = new Intl.DisplayNames([ui], { type: 'language' }).of(tag);
    if (name && name !== tag) return name.charAt(0).toLocaleUpperCase(ui) + name.slice(1);
  } catch { /* an unknown tag: the list's name below */ }
  return SUPPORTED_LOCALES.find((x) => x.tag === tag)?.name ?? tag;
}

/** The right-to-left languages the picker shows disabled (name, tag): not supported in this phase. */
export const RTL_CHOICES: readonly string[] = RTL_LOCALES;
export { isRtlLocale };

export type RowStatus = { kind: 'none' } | { kind: 'ok' } | { kind: 'stale'; count: number } | { kind: 'problems'; count: number } | { kind: 'both'; stale: number; problems: number };

/** The state of one translation (a row of a version): not translated, up to date, n outdated, n problems. */
export function rowStatus(row: Pick<LocalizationRow, 'stale' | 'problems'> | undefined): RowStatus {
  if (!row) return { kind: 'none' };
  const stale = row.stale.length;
  const problems = row.problems?.length ?? 0;
  if (stale && problems) return { kind: 'both', stale, problems };
  if (stale) return { kind: 'stale', count: stale };
  if (problems) return { kind: 'problems', count: problems };
  return { kind: 'ok' };
}

export function statusText(s: RowStatus, t: Messages): string {
  const l = t.web.languages;
  switch (s.kind) {
    case 'none': return l.statusNone;
    case 'ok': return l.statusOk;
    case 'stale': return l.statusStale({ count: s.count });
    case 'problems': return l.statusProblems({ count: s.count });
    case 'both': return `${l.statusStale({ count: s.stale })} · ${l.statusProblems({ count: s.problems })}`;
  }
}

export type VoiceReason = 'off' | 'noKey' | 'missingPermission' | 'declined' | 'failed';

const VOICE_PROVIDERS: Record<'auto' | 'openai' | 'elevenlabs', ProviderId[]> = { auto: ['openai', 'elevenlabs'], openai: ['openai'], elevenlabs: ['elevenlabs'] };

/**
 * Why the voices of a language cannot be translated right now, or null when they can (as far as the UI knows): the brief's
 * voice service is `none`; no key for the providers the choice allows; or the keys are checked and lack text-to-speech (F5).
 * `configured` / `checks` null (still loading, or unreadable): nothing is claimed. The core decides in the end.
 */
export function voiceUnavailable(brief: Pick<Brief, 'services'>, configured: ReadonlySet<ProviderId> | null, checks: Partial<Record<ProviderId, KeyCheckResult | null>> | null): VoiceReason | null {
  const choice = effectiveServices(brief).voice;
  if (choice === 'none') return 'off';
  const providers = VOICE_PROVIDERS[choice];
  const withKey = configured ? providers.filter((p) => configured.has(p)) : providers;
  if (withKey.length === 0) return 'noKey';
  if (checks && withKey.every((p) => missingCapability(checks[p], 'tts') !== null)) return 'missingPermission';
  return null;
}

/** The reason a language fell back last time (`voiceFallback` of its rows), when no reason holds now. */
export function fallbackReason(rows: ReadonlyArray<Pick<LocalizationRow, 'voiceFallback'>>): VoiceReason | null {
  return rows.find((r) => r.voiceFallback !== undefined)?.voiceFallback ?? null;
}

export function reasonText(r: VoiceReason, t: Messages): string {
  return t.web.languages.voiceReason[r];
}

const OVERFLOW_CODES: ReadonlySet<LocalizationIssue['code']> = new Set(['textOverflow', 'textOverflowMeasured', 'sourceTextOverflow']);
const VOICE_CODES: ReadonlySet<LocalizationIssue['code']> = new Set(['voiceTooLong', 'voiceFailed', 'voiceDurationUnknown', 'voiceFileInvalid']);

/**
 * The overflow sentences of an old row (written before `issues`) that name the clip `label`: matched by the exact sentence of
 * the overflow checks in both catalogs, never by the quotes alone. Only overflow: an old row's other sentences stay general.
 */
export function legacyOverflowOf(problems: readonly string[], label: string): string[] {
  const texts = new Set<string>();
  for (const l of ['en', 'it'] as const) {
    const v = messages(l).variants;
    texts.add(v.textOverflow({ clip: label }));
    for (let fit = 70; fit <= 100; fit++) texts.add(v.textOverflowMeasured({ clip: label, fit }));
  }
  return problems.filter((p) => texts.has(p));
}

/** The issues of a row that belong to a clip, by the clip's id (old rows without `issues`: overflow sentences by the clip's name). */
export function issuesOfClip(row: { issues?: readonly LocalizationIssue[]; problems?: readonly string[] }, clip: { clipId: string; name?: string }): LocalizationIssue[] {
  if (row.issues) return row.issues.filter((i) => i.clipId === clip.clipId && i.code !== 'stale');
  return legacyOverflowOf(row.problems ?? [], clipDisplay(clip)).map((message) => ({ code: 'textOverflow' as const, clipId: clip.clipId, message }));
}

/** The overflow issues of a clip (the sentences shown inline on its row of the review table). */
export const overflowOfClip = (row: { issues?: readonly LocalizationIssue[]; problems?: readonly string[] }, clip: { clipId: string; name?: string }): string[] =>
  issuesOfClip(row, clip).filter((i) => OVERFLOW_CODES.has(i.code)).map((i) => i.message);

/** The sentences of a row that no text row of the table shows: issues of other clips (voices) or of none, else the old row's unmatched ones. */
export function generalProblems(row: { issues?: readonly LocalizationIssue[]; problems?: readonly string[] }, texts: ReadonlyArray<{ clipId: string; name?: string }>): string[] {
  if (row.issues) {
    const ids = new Set(texts.map((t) => t.clipId));
    return [...new Set(row.issues.filter((i) => i.code !== 'stale' && !(i.clipId !== undefined && ids.has(i.clipId) && (OVERFLOW_CODES.has(i.code) || i.code === 'notTranslated'))).map((i) => i.message))];
  }
  const matched = new Set(texts.flatMap((t) => legacyOverflowOf(row.problems ?? [], clipDisplay(t))));
  return (row.problems ?? []).filter((p) => !matched.has(p));
}

/** What name a clip is called in the problems (the core names a clip by its name, else its id). */
export const clipDisplay = (e: { clipId: string; name?: string }): string => (e.name ?? e.clipId).slice(0, 100);

/** Whether `id` (a clip id or `clip.key` param) is outdated in `stale`. */
export const isStaleId = (stale: readonly string[], id: string): boolean => stale.includes(id);

/** The clips of a localized preview flagged by the core's issues, with the kind of the most important one. */
export type FlagKind = 'stale' | 'overflow' | 'notTranslated' | 'voice' | 'asset';
export interface FlaggedClip { clipId: string; label: string; kind: FlagKind; /** The core's sentences behind the flag. */ messages: string[] }
const PRIORITY: FlagKind[] = ['stale', 'overflow', 'notTranslated', 'voice', 'asset'];
const kindOf = (code: LocalizationIssue['code']): FlagKind | null =>
  code === 'stale' ? 'stale' : OVERFLOW_CODES.has(code) ? 'overflow' : code === 'notTranslated' ? 'notTranslated' : VOICE_CODES.has(code) ? 'voice' : code === 'assetChanged' ? 'asset' : null;

export function flaggedClips(o: { stale: readonly string[]; problems: readonly string[]; issues?: readonly LocalizationIssue[]; clips: ReadonlyArray<{ clipId: string; name?: string }> }): FlaggedClip[] {
  const out: FlaggedClip[] = [];
  for (const c of o.clips) {
    const kinds = new Map<FlagKind, string[]>();
    const add = (k: FlagKind, m: string) => kinds.set(k, [...(kinds.get(k) ?? []), m]);
    // The row's own list of outdated entries is authoritative; the issues add the rest.
    if (o.stale.includes(c.clipId) || o.stale.some((s) => s.startsWith(`${c.clipId}.`))) add('stale', '');
    for (const i of o.issues ?? []) { const k = i.clipId === c.clipId ? kindOf(i.code) : null; if (k && k !== 'stale') add(k, i.message); }
    if (!o.issues) for (const m of legacyOverflowOf(o.problems, clipDisplay(c))) add('overflow', m);
    const kind = PRIORITY.find((k) => kinds.has(k));
    if (kind) out.push({ clipId: c.clipId, label: clipDisplay(c), kind, messages: [...new Set(PRIORITY.flatMap((k) => kinds.get(k) ?? []).filter(Boolean))] });
  }
  return out;
}
