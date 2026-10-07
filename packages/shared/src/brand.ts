import { z } from 'zod';
import { relativeFileSchema, webUrlSchema } from './library.ts';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'identificativo non valido (minuscole, cifre e trattini)');

export const sourceRefSchema = z.object({ kind: z.enum(['manual', 'website', 'image']), ref: z.string().nullable() })
  .superRefine((s, ctx) => {
    if (s.kind === 'manual' && s.ref !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'le fonti manuali devono avere ref: null', path: ['ref'] });
    }
    if (s.kind === 'website') {
      if (s.ref === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'le fonti da sito richiedono un indirizzo http(s) come ref', path: ['ref'] });
      } else {
        const urlResult = webUrlSchema.safeParse(s.ref);
        if (!urlResult.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'le fonti da sito devono avere un indirizzo http(s) come ref', path: ['ref'] });
      }
    }
    if (s.kind === 'image') {
      if (s.ref === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'le fonti da immagine richiedono un percorso relativo come ref', path: ['ref'] });
      } else {
        const fileResult = relativeFileSchema.safeParse(s.ref);
        if (!fileResult.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'le fonti da immagine devono avere un percorso relativo come ref', path: ['ref'] });
      }
    }
  });
export type SourceKind = 'manual' | 'website' | 'image';
export type SourceRef = z.infer<typeof sourceRefSchema>;

const WEIGHTS = 'pesi non validi (numeri interi da 100 a 900)';
const colorSchema = z.object({
  id, name: z.string().trim().min(1, 'nome obbligatorio').max(60, 'nome troppo lungo (massimo 60 caratteri)'),
  hex: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'hex non valido (usa #RRGGBB)').transform((h) => h.toUpperCase()),
  role: z.enum(['primary', 'secondary', 'accent', 'background', 'text', 'other'], { message: 'ruolo non valido' }), source: sourceRefSchema,
});
const fontSchema = z.object({
  id, family: z.string().trim().min(1, 'famiglia obbligatoria').max(80, 'famiglia troppo lunga (massimo 80 caratteri)'),
  role: z.enum(['heading', 'body', 'accent', 'other'], { message: 'ruolo non valido' }),
  weights: z.array(z.number({ message: WEIGHTS }).int(WEIGHTS).min(100, WEIGHTS).max(900, WEIGHTS)).max(9, 'al massimo 9 pesi'),
  file: relativeFileSchema.nullable(), source: sourceRefSchema,
});
const logoSchema = z.object({
  id, file: relativeFileSchema, variant: z.enum(['primary', 'secondary', 'mono', 'icon', 'other'], { message: 'variante non valida' }),
  background: z.enum(['light', 'dark', 'any'], { message: 'sfondo non valido' }), source: sourceRefSchema,
});
const noteSchema = z.object({ id, text: z.string().trim().min(1, 'testo obbligatorio').max(2000, 'testo troppo lungo (massimo 2000 caratteri)'), source: sourceRefSchema });

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

const FIELD_LABELS: Record<string, string> = {
  colors: 'colore', fonts: 'font', logos: 'logo', dos: 'cosa da fare', donts: 'cosa da evitare', tone: 'tono di voce', photoStyle: 'stile fotografico',
};
/** Brand kit validation issues in Italian, naming the item ("colore 2: hex non valido (usa #RRGGBB)"). */
export function brandKitIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((i) => {
    const [field, index] = i.path;
    const label = typeof field === 'string' ? FIELD_LABELS[field] : undefined;
    if (!label) return i.message;
    return `${typeof index === 'number' ? `${label} ${index + 1}` : label}: ${i.message}`;
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
    if (s.url === null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'le sorgenti da sito richiedono un indirizzo', path: ['url'] });
    if (s.file !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'le sorgenti da sito devono avere file: null', path: ['file'] });
  }
  if (s.kind === 'image') {
    if (s.file === null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'le sorgenti immagine richiedono un file', path: ['file'] });
    if (s.url !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'le sorgenti immagine devono avere url: null', path: ['url'] });
  }
});
export type BrandSource = z.infer<typeof brandSourceSchema>;
export const brandSourcesFileSchema = z.object({ schemaVersion: z.literal(1), sources: z.array(brandSourceSchema).default([]) })
  .refine((f) => uniqueIds(f.sources), { message: 'id delle sorgenti duplicati', path: ['sources'] });
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
