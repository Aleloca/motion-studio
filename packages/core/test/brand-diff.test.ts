import { EMPTY_BRAND_KIT, type BrandKit } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import { applyBrandChanges, diffBrandKits } from '../src/brand/brand-diff.ts';

const manual = { kind: 'manual' as const, ref: null };
const site = { kind: 'website' as const, ref: 'https://acme.example' };
const kit = (p: Partial<BrandKit>): BrandKit => ({ ...EMPTY_BRAND_KIT, ...p });

const current = kit({
  colors: [
    { id: 'blu', name: 'Blu', hex: '#1E3A5F', role: 'primary', source: manual },
    { id: 'grigio', name: 'Grigio', hex: '#888888', role: 'other', source: site },
    { id: 'rosso', name: 'Rosso', hex: '#FF0000', role: 'accent', source: manual },
  ],
  tone: { id: 'tone', text: 'Amichevole', source: manual },
});
const proposed = kit({
  colors: [
    { id: 'blu', name: 'Blu', hex: '#1E3A5F', role: 'primary', source: site },     // same apart from source → nothing
    { id: 'arancio', name: 'Arancio', hex: '#FF7A45', role: 'accent', source: site }, // add
  ],
  tone: { id: 'tone', text: 'Energico e diretto', source: site },                  // update
  photoStyle: null,
});

describe('diffBrandKits', () => {
  it('adds, updates, removes non-manual items and never removes manual ones', () => {
    const changes = diffBrandKits(current, proposed);
    expect(changes.map((c) => c.id)).toEqual(['colors:add:arancio', 'colors:remove:grigio', 'tone:update:-']);
    expect(changes[2]).toMatchObject({ field: 'tone', before: { text: 'Amichevole' }, after: { text: 'Energico e diretto' } });
  });
  it('returns nothing for identical kits', () => {
    expect(diffBrandKits(current, current)).toEqual([]);
  });
});

describe('applyBrandChanges', () => {
  it('applies only accepted changes and keeps the rest', () => {
    const changes = diffBrandKits(current, proposed);
    const next = applyBrandChanges(current, changes, ['colors:add:arancio', 'unknown:id']);
    expect(next.colors.map((c) => c.id)).toEqual(['blu', 'grigio', 'rosso', 'arancio']);
    expect(next.tone?.text).toBe('Amichevole');
  });
  it('applies updates and removals', () => {
    const changes = diffBrandKits(current, proposed);
    const next = applyBrandChanges(current, changes, changes.map((c) => c.id));
    expect(next.colors.map((c) => c.id)).toEqual(['blu', 'rosso', 'arancio']);
    expect(next.tone).toMatchObject({ text: 'Energico e diretto', source: site });
  });
});
