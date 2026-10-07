import { z } from 'zod';
import { relativeFileSchema } from './library.ts';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const webUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), 'solo indirizzi http(s)');

export const sourceRefSchema = z.object({ kind: z.enum(['manual', 'website', 'image']), ref: z.string().nullable() });
export type SourceKind = 'manual' | 'website' | 'image';
export type SourceRef = z.infer<typeof sourceRefSchema>;

const colorSchema = z.object({
  id, name: z.string().trim().min(1).max(60),
  hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).transform((h) => h.toUpperCase()),
  role: z.enum(['primary', 'secondary', 'accent', 'background', 'text', 'other']), source: sourceRefSchema,
});
const fontSchema = z.object({
  id, family: z.string().trim().min(1).max(80), role: z.enum(['heading', 'body', 'accent', 'other']),
  weights: z.array(z.number().int().min(100).max(900)).max(9), file: relativeFileSchema.nullable(), source: sourceRefSchema,
});
const logoSchema = z.object({
  id, file: relativeFileSchema, variant: z.enum(['primary', 'secondary', 'mono', 'icon', 'other']),
  background: z.enum(['light', 'dark', 'any']), source: sourceRefSchema,
});
const noteSchema = z.object({ id, text: z.string().trim().min(1).max(2000), source: sourceRefSchema });

const uniqueIds = (items: Array<{ id: string }>) => new Set(items.map((i) => i.id)).size === items.length;

export const brandKitSchema = z.object({
  schemaVersion: z.literal(1),
  colors: z.array(colorSchema).max(40).default([]),
  fonts: z.array(fontSchema).max(20).default([]),
  logos: z.array(logoSchema).max(30).default([]),
  tone: noteSchema.nullable().default(null),
  dos: z.array(noteSchema).max(50).default([]),
  donts: z.array(noteSchema).max(50).default([]),
  photoStyle: noteSchema.nullable().default(null),
}).refine((k) => [k.colors, k.fonts, k.logos, k.dos, k.donts].every(uniqueIds), { message: 'id duplicati' });
export type BrandKit = z.infer<typeof brandKitSchema>;
export type BrandColor = BrandKit['colors'][number];
export type BrandFont = BrandKit['fonts'][number];
export type BrandLogo = BrandKit['logos'][number];
export type BrandNote = BrandKit['dos'][number];
export const EMPTY_BRAND_KIT: BrandKit = { schemaVersion: 1, colors: [], fonts: [], logos: [], tone: null, dos: [], donts: [], photoStyle: null };

export const brandSourceSchema = z.object({
  id, kind: z.enum(['website', 'image']), url: webUrl.nullable(), file: relativeFileSchema.nullable(),
  addedAt: z.string().datetime(), lastAnalyzedAt: z.string().datetime().nullable(),
}).refine((s) => (s.kind === 'website' ? s.url !== null : s.file !== null), 'sorgente incompleta');
export type BrandSource = z.infer<typeof brandSourceSchema>;
export const brandSourcesFileSchema = z.object({ schemaVersion: z.literal(1), sources: z.array(brandSourceSchema).default([]) });
export type BrandSourcesFile = z.infer<typeof brandSourcesFileSchema>;

export const brandFieldSchema = z.enum(['colors', 'fonts', 'logos', 'dos', 'donts', 'tone', 'photoStyle']);
export type BrandField = z.infer<typeof brandFieldSchema>;
export const brandChangeSchema = z.object({
  id: z.string().min(1), field: brandFieldSchema, op: z.enum(['add', 'update', 'remove']),
  itemId: z.string().nullable(), before: z.unknown(), after: z.unknown(),
});
export type BrandChange = z.infer<typeof brandChangeSchema>;
export const brandProposalSchema = z.object({
  schemaVersion: z.literal(1), id, createdAt: z.string().datetime(), sourceIds: z.array(z.string()),
  status: z.enum(['open', 'applied', 'discarded']), summary: z.string(),
  changes: z.array(brandChangeSchema), guidelines: z.object({ current: z.string(), proposed: z.string() }).nullable(),
  assetsAdded: z.array(z.string()),
});
export type BrandProposal = z.infer<typeof brandProposalSchema>;
