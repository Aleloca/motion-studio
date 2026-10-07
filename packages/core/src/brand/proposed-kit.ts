import { BRAND_FIELD_LABELS, BRAND_KIT_LIMITS, brandColorSchema, brandFontSchema, brandKitIssues, brandKitSchema, brandLogoSchema, brandNoteSchema, type BrandKit, type SourceRef } from '@motion-studio/shared';
import type { z } from 'zod';

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
/** Italian issues of one item, deduplicated ("ruolo non valido; pesi non validi …"). */
const itemIssues = (error: z.ZodError) => [...new Set(error.issues.map((i) => (i.code === 'invalid_type' ? `${i.path.join('.') || 'valore'} mancante o non valido` : i.message)))].join(', ');

/**
 * Reads the kit the agent proposed item by item: invalid items are dropped and described in `dropped`, an invalid
 * version of an item already in `current` keeps the current one (so manual items are never lost to a bad rewrite).
 * Throws only when the file is not a kit at all.
 */
export function parseProposedKit(json: unknown, current: BrandKit, source: SourceRef): { kit: BrandKit; dropped: string[] } {
  if (!isObject(json)) throw new Error('Proposta non valida: brand-kit.json non contiene un oggetto JSON');
  const dropped: string[] = [];
  const kit: BrandKit = { schemaVersion: 1, colors: [], fonts: [], logos: [], tone: null, dos: [], donts: [], photoStyle: null };

  for (const field of Object.keys(BRAND_KIT_LIMITS) as ListField[]) {
    const label = BRAND_FIELD_LABELS[field]!;
    const raw = json[field] ?? [];
    const currentItems = current[field] as Array<{ id: string }>;
    const out: Array<{ id: string }> = [];
    const ids = new Set<string>();
    const fallback = (rawItem: unknown) => {
      const id = isObject(rawItem) && typeof rawItem.id === 'string' ? rawItem.id : null;
      const kept = id !== null && !ids.has(id) ? currentItems.find((c) => c.id === id) : undefined;
      if (kept) { out.push(kept); ids.add(kept.id); }
    };
    if (!Array.isArray(raw)) {
      dropped.push(`${label}: elenco non valido`);
      out.push(...currentItems);
    } else {
      raw.forEach((rawItem, index) => {
        const name = `${label} ${itemName(rawItem, index)}`;
        const parsed = ITEM_SCHEMAS[field].safeParse(coerce(field, rawItem, source, ids));
        if (!parsed.success) { dropped.push(`${name}: ${itemIssues(parsed.error)}`); fallback(rawItem); return; }
        const item = parsed.data as { id: string };
        if (ids.has(item.id)) { dropped.push(`${name}: id duplicato`); return; }
        if (out.length >= BRAND_KIT_LIMITS[field]) { dropped.push(`${name}: troppe voci (massimo ${BRAND_KIT_LIMITS[field]})`); return; }
        out.push(item); ids.add(item.id);
      });
    }
    (kit as Record<ListField, unknown>)[field] = out;
  }

  for (const field of ['tone', 'photoStyle'] as NoteField[]) {
    const raw = json[field];
    if (raw === undefined || raw === null) continue;
    const parsed = brandNoteSchema.safeParse(coerce(field, raw, source, new Set()));
    if (parsed.success) kit[field] = parsed.data;
    else { dropped.push(`${BRAND_FIELD_LABELS[field]}: ${itemIssues(parsed.error)}`); kit[field] = current[field]; }
  }

  const whole = brandKitSchema.safeParse(kit);
  if (!whole.success) throw new Error(`Proposta non valida: ${brandKitIssues(whole.error)}`);
  return { kit: whole.data, dropped };
}
