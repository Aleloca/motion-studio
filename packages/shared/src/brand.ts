import { z } from 'zod';
import { messages, type Locale } from './i18n/index.ts';
import { issueText, type IssueLike } from './issues.ts';
import { relativeFileSchema, webUrlSchema } from './library.ts';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'issue.id');

export const sourceRefSchema = z.object({ kind: z.enum(['manual', 'website', 'image']), ref: z.string().nullable() })
  .superRefine((s, ctx) => {
    if (s.kind === 'manual' && s.ref !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'issue.manualRef', path: ['ref'] });
    }
    if (s.kind === 'website') {
      if (s.ref === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'issue.websiteRefRequired', path: ['ref'] });
      } else {
        const urlResult = webUrlSchema.safeParse(s.ref);
        if (!urlResult.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'issue.websiteRefInvalid', path: ['ref'] });
      }
    }
    if (s.kind === 'image') {
      if (s.ref === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'issue.imageRefRequired', path: ['ref'] });
      } else {
        const fileResult = relativeFileSchema.safeParse(s.ref);
        if (!fileResult.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'issue.imageRefInvalid', path: ['ref'] });
      }
    }
  });
export type SourceKind = 'manual' | 'website' | 'image';
export type SourceRef = z.infer<typeof sourceRefSchema>;

const WEIGHTS = 'issue.weights';
export const brandColorSchema = z.object({
  id, name: z.string().trim().min(1, 'issue.nameRequired').max(60, 'issue.nameTooLong'),
  hex: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'issue.hex').transform((h) => h.toUpperCase()),
  role: z.enum(['primary', 'secondary', 'accent', 'background', 'text', 'other'], { message: 'issue.role' }), source: sourceRefSchema,
});
export const brandFontSchema = z.object({
  id, family: z.string().trim().min(1, 'issue.familyRequired').max(80, 'issue.familyTooLong'),
  role: z.enum(['heading', 'body', 'accent', 'other'], { message: 'issue.role' }),
  weights: z.array(z.number({ message: WEIGHTS }).int(WEIGHTS).min(100, WEIGHTS).max(900, WEIGHTS)).max(9, 'issue.maxWeights'),
  file: relativeFileSchema.nullable(), source: sourceRefSchema,
});
export const brandLogoSchema = z.object({
  id, file: relativeFileSchema, variant: z.enum(['primary', 'secondary', 'mono', 'icon', 'other'], { message: 'issue.variant' }),
  background: z.enum(['light', 'dark', 'any'], { message: 'issue.background' }), source: sourceRefSchema,
});
export const brandNoteSchema = z.object({ id, text: z.string().trim().min(1, 'issue.textRequired').max(2000, 'issue.textTooLong'), source: sourceRefSchema });

/** Maximum number of items per list in a brand kit. */
export const BRAND_KIT_LIMITS = { colors: 40, fonts: 20, logos: 30, dos: 50, donts: 50 } as const;

const uniqueIds = (items: Array<{ id: string }>) => new Set(items.map((i) => i.id)).size === items.length;

export const brandKitSchema = z.object({
  schemaVersion: z.literal(1),
  colors: z.array(brandColorSchema).max(BRAND_KIT_LIMITS.colors).default([]),
  fonts: z.array(brandFontSchema).max(BRAND_KIT_LIMITS.fonts).default([]),
  logos: z.array(brandLogoSchema).max(BRAND_KIT_LIMITS.logos).default([]),
  tone: brandNoteSchema.nullable().default(null),
  dos: z.array(brandNoteSchema).max(BRAND_KIT_LIMITS.dos).default([]),
  donts: z.array(brandNoteSchema).max(BRAND_KIT_LIMITS.donts).default([]),
  photoStyle: brandNoteSchema.nullable().default(null),
}).refine((k) => [k.colors, k.fonts, k.logos, k.dos, k.donts].every(uniqueIds), { message: 'issue.duplicateIds' });
export type BrandKit = z.infer<typeof brandKitSchema>;

/** Brand kit validation issues in `locale`, naming the item ("colore 2: hex non valido (usa #RRGGBB)"). */
export function brandKitIssues(error: { issues: IssueLike[] }, locale: Locale): string {
  const labels = messages(locale).brandFields as Record<string, string>;
  return error.issues.map((i) => {
    const [field, index] = i.path ?? [];
    const label = typeof field === 'string' && Object.hasOwn(labels, field) ? labels[field] : undefined;
    const text = issueText(i, locale);
    if (!label) return text;
    return `${typeof index === 'number' ? `${label} ${index + 1}` : label}: ${text}`;
  }).join('; ');
}
export type BrandColor = BrandKit['colors'][number];
export type BrandFont = BrandKit['fonts'][number];
export type BrandLogo = BrandKit['logos'][number];
export type BrandNote = BrandKit['dos'][number];
export const EMPTY_BRAND_KIT: BrandKit = { schemaVersion: 1, colors: [], fonts: [], logos: [], tone: null, dos: [], donts: [], photoStyle: null };

export const brandSourceSchema = z.object({
  id, kind: z.enum(['website', 'image']), url: webUrlSchema.nullable(), file: relativeFileSchema.nullable(),
  addedAt: z.iso.datetime(), lastAnalyzedAt: z.iso.datetime().nullable(),
}).superRefine((s, ctx) => {
  if (s.kind === 'website') {
    if (s.url === null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'issue.siteSourceUrl', path: ['url'] });
    if (s.file !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'issue.siteSourceFile', path: ['file'] });
  }
  if (s.kind === 'image') {
    if (s.file === null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'issue.imageSourceFile', path: ['file'] });
    if (s.url !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'issue.imageSourceUrl', path: ['url'] });
  }
});
export type BrandSource = z.infer<typeof brandSourceSchema>;
export const brandSourcesFileSchema = z.object({ schemaVersion: z.literal(1), sources: z.array(brandSourceSchema).default([]) })
  .refine((f) => uniqueIds(f.sources), { message: 'issue.duplicateSourceIds', path: ['sources'] });
export type BrandSourcesFile = z.infer<typeof brandSourcesFileSchema>;

export const brandFieldSchema = z.enum(['colors', 'fonts', 'logos', 'dos', 'donts', 'tone', 'photoStyle']);
export type BrandField = z.infer<typeof brandFieldSchema>;
export const brandChangeSchema = z.object({
  id: z.string().min(1), field: brandFieldSchema, op: z.enum(['add', 'update', 'remove']),
  itemId: z.string().nullable(), before: z.unknown(), after: z.unknown(),
});
export type BrandChange = z.infer<typeof brandChangeSchema>;
export const brandProposalSchema = z.object({
  schemaVersion: z.literal(1), id, createdAt: z.iso.datetime(), sourceIds: z.array(id).max(100),
  status: z.enum(['open', 'applied', 'discarded']), summary: z.string().max(5000),
  changes: z.array(brandChangeSchema).max(500), guidelines: z.object({ current: z.string().max(200_000), proposed: z.string().max(200_000) }).nullable(),
  assetsAdded: z.array(relativeFileSchema).max(1000),
});
export type BrandProposal = z.infer<typeof brandProposalSchema>;

export interface BrandOverview {
  kit: BrandKit; kitError: string | null; guidelines: string; sources: BrandSource[]; sourcesError: string | null;
  proposals: BrandProposal[]; jobKey: string;
}
