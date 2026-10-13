import { z } from 'zod';
import { INSTANCE_ID_RE } from '../format-instance.ts';
import { COMPOSITION_LIMITS } from '../composition/schema.ts';
import { COMPOSITION_PATH_MAX, isCompositionPath } from '../composition/paths.ts';
import { SUPPORTED_LOCALES, type LocaleTag } from './locales.ts';

export const LOCALIZATION_SCHEMA_ID = 'motion-studio/localization@1';

/** A language tag of the curated list (`SUPPORTED_LOCALES`). */
export const localeTag = z.enum(SUPPORTED_LOCALES.map((x) => x.tag) as [LocaleTag, ...LocaleTag[]]);

const clipId = z.string().max(COMPOSITION_LIMITS.id).regex(/^[a-z0-9][a-z0-9-]*$/);
/** A file under `assets/` of the composition folder (a voice file or a font file): never `layers/`. */
export const assetFilePath = z.string().max(COMPOSITION_PATH_MAX).refine((p) => p.startsWith('assets/') && isCompositionPath(p), 'issue.badAssetPath');
const text = z.string().max(COMPOSITION_LIMITS.text);

/**
 * `outputs/vN/locales/<locale>/<instanceId>.json`: what a language changes, and nothing else (spec §3.1). Strict at every level:
 * a key that is not listed is refused, so an overlay cannot reach positions, times, animations, colours or images.
 * `params` keys are `<clipId>.<paramKey>`.
 */
export const localizationSchema = z.object({
  $schema: z.literal(LOCALIZATION_SCHEMA_ID),
  locale: localeTag,
  instanceId: z.string().regex(INSTANCE_ID_RE),
  texts: z.record(clipId, z.object({ source: text, text }).strict()),
  params: z.record(z.string().regex(/^[a-z0-9-]+\.[A-Za-z0-9_-]+$/), z.object({ source: text, text }).strict()),
  voices: z.record(clipId, z.object({ src: assetFilePath, sourceScript: z.string().max(5000), script: z.string().max(5000) }).strict()),
  fit: z.record(clipId, z.number().min(0.7).max(1)),
  fonts: z.array(z.object({ family: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/), files: z.array(assetFilePath).min(1).max(8) }).strict()).max(3),
}).strict();
export type Localization = z.infer<typeof localizationSchema>;
