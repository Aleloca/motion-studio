// The subtitle set of a creative in one language (decisions 1636-1643): data kept apart from the picture, edited by the user.
import { z } from 'zod';
import { sha256Hex } from '../composition/hash.ts';
import { SUPPORTED_LOCALES, type LocaleTag } from '../localization/locales.ts';
import { localeTag } from '../localization/schema.ts';
import { transcriptKindSchema } from '../video-analysis.ts';

export const SUBTITLES_SCHEMA_ID = 'motion-studio/subtitles@1';
export const SUBTITLE_LIMITS = { cues: 2000, words: 60, text: 200, fileBytes: 1_048_576 } as const;
/** Folder of the sets, inside the creative's folder: `subtitles/<lang>.json`. */
export const SUBTITLES_DIR = 'subtitles';

const ms = z.number().int().min(0);

export const subtitleWordSchema = z.object({
  start: ms,
  end: ms,
  text: z.string().min(1).max(100),
}).strict().refine((w) => w.end >= w.start, { message: 'word end before its start' });
export type SubtitleWord = z.infer<typeof subtitleWordSchema>;

const cueText = z.string().min(1).max(SUBTITLE_LIMITS.text).refine((t) => t.split('\n').length <= 2, { message: 'at most two lines' });

export const subtitleCueSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  start: ms,
  end: ms,
  text: cueText,
  words: z.array(subtitleWordSchema).max(SUBTITLE_LIMITS.words).optional(),
  edited: z.literal(true).optional(),
  source: z.object({ text: z.string().min(1).max(SUBTITLE_LIMITS.text) }).strict().optional(),
}).strict().refine((c) => c.end > c.start, { message: 'cue end must be after its start', path: ['end'] });
export type SubtitleCue = z.infer<typeof subtitleCueSchema>;

export const subtitleSetSchema = z.object({
  $schema: z.literal(SUBTITLES_SCHEMA_ID),
  lang: localeTag,
  origin: z.enum(['speech', 'translation']),
  sourceLang: localeTag.optional(),
  transcript: transcriptKindSchema.nullable(),
  detected: z.string().nullable(),
  timing: z.object({
    version: z.number().int().min(1),
    format: z.string(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  cues: z.array(subtitleCueSchema).max(SUBTITLE_LIMITS.cues),
}).strict().superRefine((s, ctx) => {
  if ((s.origin === 'translation') !== (s.sourceLang !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['sourceLang'], message: 'sourceLang is required for a translation, and only then' });
  }
  const ids = new Set<string>();
  s.cues.forEach((c, i) => {
    if (ids.has(c.id)) ctx.addIssue({ code: 'custom', path: ['cues', i, 'id'], message: 'duplicate cue id' });
    ids.add(c.id);
    if (i > 0 && c.start < s.cues[i - 1]!.start) ctx.addIssue({ code: 'custom', path: ['cues', i, 'start'], message: 'cues must be sorted by start' });
  });
});
export type SubtitleSet = z.infer<typeof subtitleSetSchema>;

/** The set in a file, or null when it is not valid. */
export function parseSubtitleSet(text: string): SubtitleSet | null {
  try {
    const r = subtitleSetSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch { return null; }
}

/** The exact file text: 2-space JSON and a final newline. */
export const subtitleSetText = (s: SubtitleSet): string => `${JSON.stringify(s, null, 2)}\n`;

export const subtitleSetHash = (s: SubtitleSet): string => sha256Hex(new TextEncoder().encode(subtitleSetText(s)));

export const subtitlesJobKey = (root: string, projectSlug: string, creativeSlug: string): string => `subtitles:${root}:${projectSlug}:${creativeSlug}`;

/** ISO 639-2/T codes, for the language tag of a soft MP4 track. */
export const ISO639_2: Record<LocaleTag, string> = {
  en: 'eng', it: 'ita', fr: 'fra', de: 'deu', es: 'spa', pt: 'por', nl: 'nld', sv: 'swe', da: 'dan', nb: 'nob', fi: 'fin', pl: 'pol',
  cs: 'ces', hu: 'hun', ro: 'ron', ca: 'cat', el: 'ell', ru: 'rus', uk: 'ukr', tr: 'tur', id: 'ind', vi: 'vie',
  'zh-Hans': 'zho', 'zh-Hant': 'zho', ja: 'jpn', ko: 'kor', hi: 'hin', th: 'tha',
};

/**
 * The codes the transcribers answer with, besides the tags themselves (lowercase): whisper.cpp's and OpenAI's ISO 639-1 (`zh`,
 * `no`), ElevenLabs Scribe's ISO 639-3 (`ita`, `cmn`) and the 639-2/B forms (`fre`, `ger`).
 */
const LANG_CODES: Record<string, LocaleTag> = {
  ...Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l.tag.toLowerCase(), l.tag])),
  ...Object.fromEntries(Object.entries(ISO639_2).filter(([tag]) => tag !== 'zh-Hant').map(([tag, code]) => [code, tag as LocaleTag])),
  zh: 'zh-Hans', no: 'nb', nn: 'nb', nor: 'nb', nno: 'nb', fre: 'fr', ger: 'de', dut: 'nl', cze: 'cs', rum: 'ro', gre: 'el', chi: 'zh-Hans', cmn: 'zh-Hans',
};

/** The supported tag for a language the transcriber detected (any case), or null (the set then keeps `detected` as it is). */
export function subtitleLangOf(detected: string | null): LocaleTag | null {
  if (detected === null) return null;
  return Object.hasOwn(LANG_CODES, detected.toLowerCase()) ? LANG_CODES[detected.toLowerCase()]! : null;
}
