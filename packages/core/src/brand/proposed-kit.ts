import { BRAND_KIT_LIMITS, issueText, messages, brandColorSchema, brandFontSchema, brandKitIssues, brandKitSchema, brandLogoSchema, brandNoteSchema, type BrandKit, type Locale, type SourceRef } from '@motion-studio/shared';
import type { z } from 'zod';
import { currentLocale, t } from '../i18n.ts';

type ListField = keyof typeof BRAND_KIT_LIMITS;
type NoteField = 'tone' | 'photoStyle';
const ITEM_SCHEMAS: Record<ListField, z.ZodType> = { colors: brandColorSchema, fonts: brandFontSchema, logos: brandLogoSchema, dos: brandNoteSchema, donts: brandNoteSchema };
const NOTE_FIELDS = new Set<string>(['dos', 'donts', 'tone', 'photoStyle']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const kebab = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');

/** Light coercions of shapes agents commonly write: a note as a plain string, font weights as strings. Enum values are never guessed. */
function coerce(field: string, raw: unknown, source: SourceRef, takenIds: Set<string>): unknown {
  if (NOTE_FIELDS.has(field)) {
    const note = typeof raw === 'string' ? { text: raw } : raw;
    if (!isObject(note) || typeof note.text !== 'string') return raw;
    let id = note.id;
    if (id === undefined) {
      const base = kebab(note.text) || kebab(field);
      id = base;
      for (let n = 2; takenIds.has(id as string); n++) id = `${base}-${n}`;
    }
    return { ...note, id, source: note.source ?? source };
  }
  if (field === 'fonts' && isObject(raw)) {
    const w = raw.weights;
    const parts = typeof w === 'string' ? w.split(/[\s,;]+/).filter(Boolean) : typeof w === 'number' ? [w] : Array.isArray(w) ? w : null;
    if (parts) return { ...raw, weights: parts.map((p) => (typeof p === 'string' && /^\d+$/.test(p.trim()) ? Number(p) : p)) };
  }
  return raw;
}

const itemName = (raw: unknown, index: number): string => {
  if (isObject(raw)) for (const k of ['name', 'family', 'id', 'file']) { const v = raw[k]; if (typeof v === 'string' && v.trim()) return `«${v.trim().slice(0, 60)}»`; }
  return String(index + 1);
};
/** Issues of one item in `locale`, deduplicated ("invalid role, invalid weights …"); a missing or mistyped field is worded by its name. */
const itemIssues = (error: z.ZodError, locale: Locale) => [...new Set(error.issues.map((i) => issueText(i, locale, { fieldHints: true })))].join(', ');
const own = (o: Record<string, unknown>, key: string) => (Object.hasOwn(o, key) ? o[key] : undefined);

/**
 * Reads the kit the agent proposed item by item: invalid items are dropped and described in `dropped`, an invalid
 * version of an item already in `current` keeps the current one (so manual items are never lost to a bad rewrite).
 * `dropped` is written in `locale` (the job's language). Throws, in the current language, only when the file is not a kit at all.
 */
export function parseProposedKit(json: unknown, current: BrandKit, source: SourceRef, locale: Locale = currentLocale()): { kit: BrandKit; dropped: string[] } {
  const m = messages(locale);
  if (!isObject(json)) throw new Error(t().errors.proposalNotObject);
  const dropped: string[] = [];
  const kit: BrandKit = { schemaVersion: 1, colors: [], fonts: [], logos: [], tone: null, dos: [], donts: [], photoStyle: null };

  for (const field of Object.keys(BRAND_KIT_LIMITS) as ListField[]) {
    const label = (m.brandFields as Record<string, string>)[field]!;
    const raw = own(json, field);
    const currentItems = current[field] as Array<{ id: string }>;
    const out: Array<{ id: string }> = [];
    const ids = new Set<string>();
    const limit = BRAND_KIT_LIMITS[field];
    const fallback = (rawItem: unknown, name: string) => {
      const id = isObject(rawItem) && typeof rawItem.id === 'string' ? rawItem.id : null;
      const kept = id !== null && !ids.has(id) ? currentItems.find((c) => c.id === id) : undefined;
      if (!kept) return;
      if (out.length >= limit) { dropped.push(m.brand.droppedKeepFailed({ name, limit })); return; }
      out.push(kept); ids.add(kept.id);
    };
    // Only an explicit list (even empty) replaces the current items: an omitted key keeps them.
    if (raw === undefined) out.push(...currentItems);
    else if (!Array.isArray(raw)) {
      dropped.push(m.brand.droppedNotList({ label }));
      out.push(...currentItems);
    } else {
      raw.forEach((rawItem, index) => {
        const name = `${label} ${itemName(rawItem, index)}`;
        const parsed = ITEM_SCHEMAS[field].safeParse(coerce(field, rawItem, source, ids));
        if (!parsed.success) { dropped.push(`${name}: ${itemIssues(parsed.error, locale)}`); fallback(rawItem, name); return; }
        const item = parsed.data as { id: string };
        if (ids.has(item.id)) { dropped.push(m.brand.droppedDuplicateId({ name })); return; }
        if (out.length >= limit) { dropped.push(m.brand.droppedTooMany({ name, limit })); return; }
        out.push(item); ids.add(item.id);
      });
    }
    (kit as Record<ListField, unknown>)[field] = out;
  }

  for (const field of ['tone', 'photoStyle'] as NoteField[]) {
    const raw = own(json, field);
    // Omitted keeps the current note, an explicit null removes it.
    if (raw === undefined) { kit[field] = current[field]; continue; }
    if (raw === null) continue;
    const parsed = brandNoteSchema.safeParse(coerce(field, raw, source, new Set()));
    if (parsed.success) kit[field] = parsed.data;
    else { dropped.push(`${(m.brandFields as Record<string, string>)[field]}: ${itemIssues(parsed.error, locale)}`); kit[field] = current[field]; }
  }

  const whole = brandKitSchema.safeParse(kit);
  if (!whole.success) throw new Error(t().errors.proposalInvalid({ detail: brandKitIssues(whole.error, currentLocale()) }));
  return { kit: whole.data, dropped };
}
