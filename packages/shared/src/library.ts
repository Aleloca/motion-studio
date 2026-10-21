import { z } from 'zod';

export const relativeFileSchema = z.string().min(1).max(300).refine(
  (f) => !f.startsWith('/') && !f.includes('\\') && !f.split('/').some((s) => s === '..' || s === '.' || s === '') && !f.includes('\0'),
  'issue.relativePath',
);

export const webUrlSchema = z.string().url().refine((u) => /^https?:\/\//i.test(u), 'issue.httpOnly');

export type AssetKind = 'image' | 'video' | 'svg' | 'font' | 'audio' | 'other';
export type AssetOrigin = 'upload' | 'website' | 'generated' | 'stock' | 'google-fonts' | 'codebase';

const EXT: Record<string, AssetKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', avif: 'image', heic: 'image',
  svg: 'svg', mp4: 'video', mov: 'video', webm: 'video', m4v: 'video',
  woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio',
};
export function assetKindOf(file: string): AssetKind {
  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  return (Object.hasOwn(EXT, ext) ? EXT[ext] : 'other') as AssetKind;
}

export const assetEntrySchema = z.object({
  file: relativeFileSchema,
  kind: z.enum(['image', 'video', 'svg', 'font', 'audio', 'other']),
  origin: z.enum(['upload', 'website', 'generated', 'stock', 'google-fonts', 'codebase']),
  sourceUrl: webUrlSchema.nullable(),
  description: z.string().max(2000),
  tags: z.array(z.string().min(1).max(40)).max(30),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  addedAt: z.iso.datetime(),
  attribution: z.string().max(500).nullable().default(null),
  provider: z.string().min(1).max(60).optional(),
  model: z.string().min(1).max(100).optional(),
  durationSec: z.number().nonnegative().nullable().optional(),
  bytes: z.number().int().nonnegative().optional(),
  loop: z.boolean().optional(),
  /**
   * Report 62: a file added from the computer in a brief as a reference for that creative only (absent: a library asset). It
   * holds the creatives it was added for; empty while its brief is not a creative yet. Such files stay in `assets/` (analysis,
   * prompt and composition copy work unchanged) but are left out of the library's lists, and go with their last creative.
   */
  referenceFor: z.array(z.string().min(1).max(200)).max(500).optional(),
});
export type AssetEntry = z.infer<typeof assetEntrySchema>;

const uniqueFiles = <T extends { file: string }>(items: T[]) => new Set(items.map((i) => i.file)).size === items.length;

export const assetsFileSchema = z.object({ schemaVersion: z.literal(1), assets: z.array(assetEntrySchema).default([]) })
  .refine((f) => uniqueFiles(f.assets), { message: 'issue.duplicateFiles', path: ['assets'] });
export type AssetsFile = z.infer<typeof assetsFileSchema>;

/** Report 62: whether the entry is a creative's reference only (hidden from the library). */
export const isCreativeReference = (a: Pick<AssetEntry, 'referenceFor'>): boolean => a.referenceFor !== undefined;
/** A creative reference as the Assets screen lists it: with the creatives whose brief holds it, or that it was added for. */
export interface CreativeReferenceEntry extends AssetEntry { usedBy: Array<{ slug: string; title: string }> }

export const referenceEntrySchema = z.object({
  file: relativeFileSchema, note: z.string().max(2000), useForBrand: z.boolean(), addedAt: z.iso.datetime(),
});
export type ReferenceEntry = z.infer<typeof referenceEntrySchema>;
export const referencesFileSchema = z.object({ schemaVersion: z.literal(1), references: z.array(referenceEntrySchema).default([]) })
  .refine((f) => uniqueFiles(f.references), { message: 'issue.duplicateFiles', path: ['references'] });
export type ReferencesFile = z.infer<typeof referencesFileSchema>;
