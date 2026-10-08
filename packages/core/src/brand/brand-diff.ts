import { brandKitIssues, brandKitSchema, type BrandChange, type BrandField, type BrandKit } from '@motion-studio/shared';
import { WorkspaceError } from '../workspace-store.ts';
import { t } from '../i18n.ts';

type ListField = 'colors' | 'fonts' | 'logos' | 'dos' | 'donts';
type ScalarField = 'tone' | 'photoStyle';
const ORDER: BrandField[] = ['colors', 'fonts', 'logos', 'tone', 'dos', 'donts', 'photoStyle'];
const SCALARS = new Set<BrandField>(['tone', 'photoStyle']);

const withoutSource = (v: unknown) => {
  if (!v || typeof v !== 'object') return v;
  const { source: _s, ...rest } = v as Record<string, unknown>;
  return JSON.stringify(rest);
};
const changeId = (field: BrandField, op: BrandChange['op'], itemId: string | null) => `${field}:${op}:${itemId ?? '-'}`;

export function diffBrandKits(current: BrandKit, proposed: BrandKit): BrandChange[] {
  const out: BrandChange[] = [];
  for (const field of ORDER) {
    if (SCALARS.has(field)) {
      const cur = current[field as ScalarField];
      const next = proposed[field as ScalarField];
      if (!next) continue;
      if (!cur) out.push({ id: changeId(field, 'add', null), field, op: 'add', itemId: null, before: null, after: next });
      else if (cur.text !== next.text) out.push({ id: changeId(field, 'update', null), field, op: 'update', itemId: null, before: cur, after: next });
      continue;
    }
    const cur = current[field as ListField] as Array<{ id: string; source: { kind: string } }>;
    const next = proposed[field as ListField] as Array<{ id: string }>;
    for (const item of next) {
      const existing = cur.find((c) => c.id === item.id);
      if (!existing) out.push({ id: changeId(field, 'add', item.id), field, op: 'add', itemId: item.id, before: null, after: item });
      else if (withoutSource(existing) !== withoutSource(item)) out.push({ id: changeId(field, 'update', item.id), field, op: 'update', itemId: item.id, before: existing, after: item });
    }
    for (const item of cur) {
      if (item.source.kind !== 'manual' && !next.some((n) => n.id === item.id)) {
        out.push({ id: changeId(field, 'remove', item.id), field, op: 'remove', itemId: item.id, before: item, after: null });
      }
    }
  }
  return out;
}

export function applyBrandChanges(current: BrandKit, changes: BrandChange[], acceptedIds: string[]): BrandKit {
  const accepted = new Set(acceptedIds);
  const next = structuredClone(current) as Record<string, unknown>;
  for (const c of changes) {
    if (!accepted.has(c.id)) continue;
    if (SCALARS.has(c.field)) { next[c.field] = c.op === 'remove' ? null : c.after; continue; }
    const arr = [...(next[c.field] as Array<{ id: string; source?: { kind: string } }>)];
    if (c.op === 'remove') {
      // Never remove manual items
      const itemToRemove = arr.find((i) => i.id === c.itemId);
      if (itemToRemove?.source?.kind !== 'manual') {
        next[c.field] = arr.filter((i) => i.id !== c.itemId);
      }
      continue;
    }
    const index = arr.findIndex((i) => i.id === c.itemId);
    if (index >= 0) arr[index] = c.after as { id: string }; else arr.push(c.after as { id: string });
    next[c.field] = arr;
  }
  const parsed = brandKitSchema.safeParse(next);
  if (!parsed.success) throw new WorkspaceError(400, t().errors.resultingBrandKitInvalid({ detail: brandKitIssues(parsed.error) }));
  return parsed.data;
}
