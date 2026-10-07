import { z } from 'zod';

export const relativeFileSchema = z.string().min(1).max(300).refine(
  (f) => !f.startsWith('/') && !f.includes('\\') && !f.split('/').some((s) => s === '..' || s === '.' || s === '') && !f.includes('\0'),
  'percorso non valido (deve essere relativo, senza ".." o "\\")',
);

export type AssetKind = 'image' | 'video' | 'svg' | 'font' | 'audio' | 'other';
export type AssetOrigin = 'upload' | 'website' | 'generated' | 'stock';

const EXT: Record<string, AssetKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', avif: 'image', heic: 'image',
  svg: 'svg', mp4: 'video', mov: 'video', webm: 'video', m4v: 'video',
  woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio',
};
export function assetKindOf(file: string): AssetKind {
  return EXT[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'other';
}

export const assetEntrySchema = z.object({
  file: relativeFileSchema,
  kind: z.enum(['image', 'video', 'svg', 'font', 'audio', 'other']),
  origin: z.enum(['upload', 'website', 'generated', 'stock']),
  sourceUrl: z.string().url().nullable(),
  description: z.string().max(2000),
  tags: z.array(z.string().min(1).max(40)).max(30),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  addedAt: z.string().datetime(),
});
export type AssetEntry = z.infer<typeof assetEntrySchema>;

const uniqueFiles = <T extends { file: string }>(items: T[]) => new Set(items.map((i) => i.file)).size === items.length;

export const assetsFileSchema = z.object({ schemaVersion: z.literal(1), assets: z.array(assetEntrySchema).default([]) })
  .refine((f) => uniqueFiles(f.assets), { message: 'file duplicati', path: ['assets'] });
export type AssetsFile = z.infer<typeof assetsFileSchema>;

export const referenceEntrySchema = z.object({
  file: relativeFileSchema, note: z.string().max(2000), useForBrand: z.boolean(), addedAt: z.string().datetime(),
});
export type ReferenceEntry = z.infer<typeof referenceEntrySchema>;
export const referencesFileSchema = z.object({ schemaVersion: z.literal(1), references: z.array(referenceEntrySchema).default([]) })
  .refine((f) => uniqueFiles(f.references), { message: 'file duplicati', path: ['references'] });
export type ReferencesFile = z.infer<typeof referencesFileSchema>;
