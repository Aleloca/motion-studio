import { BRAND_KIT_LIMITS, brandKitSchema, EMPTY_BRAND_KIT, type BrandKit } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import { KIT_EXAMPLE } from '../src/brand/brand-prompt.ts';
import { parseProposedKit } from '../src/brand/proposed-kit.ts';

const SRC = { kind: 'website' as const, ref: 'https://acme.example' };
const manual = { kind: 'manual' as const, ref: null };
const color = (id: string, role = 'primary') => ({ id, name: id, hex: '#112233', role, source: SRC });
const CURRENT: BrandKit = {
  ...EMPTY_BRAND_KIT,
  colors: [{ id: 'blu', name: 'Blu', hex: '#1E3A5F', role: 'primary', source: manual }],
  dos: [{ id: 'chiaro', text: 'Sii chiaro', source: manual }],
  tone: { id: 'tono', text: 'Diretto', source: manual },
  photoStyle: { id: 'foto', text: 'Luminose', source: manual },
};

describe('parseProposedKit', () => {
  it('accepts the example kit shown to the agent', () => {
    expect(brandKitSchema.safeParse(JSON.parse(KIT_EXAMPLE)).success).toBe(true);
    expect(parseProposedKit(JSON.parse(KIT_EXAMPLE), EMPTY_BRAND_KIT, SRC).dropped).toEqual([]);
  });
  it('drops a second item with an explicit duplicate id', () => {
    const { kit, dropped } = parseProposedKit({ colors: [color('a'), { ...color('a'), name: 'Altro' }] }, EMPTY_BRAND_KIT, SRC);
    expect(kit.colors.map((c) => c.name)).toEqual(['a']);
    expect(dropped).toEqual(['colore «Altro»: id duplicato']);
  });
  it('never exceeds the list limit when keeping the current version of an invalid item', () => {
    const full = Array.from({ length: BRAND_KIT_LIMITS.colors }, (_, i) => color(`c-${i}`));
    const { kit, dropped } = parseProposedKit({ colors: [...full, { ...CURRENT.colors[0]!, role: 'principale' }] }, CURRENT, SRC);
    expect(kit.colors).toHaveLength(BRAND_KIT_LIMITS.colors);
    expect(dropped[0]).toBe('colore «Blu»: ruolo non valido');
    expect(dropped[1]).toMatch(/^colore «Blu»: versione attuale non mantenuta/);
  });
  it('keeps the current items of an omitted key; explicit empty list or null removes them', () => {
    const omitted = parseProposedKit({ colors: [] }, CURRENT, SRC);
    expect(omitted.kit).toMatchObject({ colors: [], dos: CURRENT.dos, tone: CURRENT.tone, photoStyle: CURRENT.photoStyle });
    expect(omitted.dropped).toEqual([]);
    const explicit = parseProposedKit({ colors: [], dos: [], tone: null, photoStyle: null }, CURRENT, SRC);
    expect(explicit.kit).toMatchObject({ dos: [], tone: null, photoStyle: null });
  });
  it('labels invalid_type issues in Italian and keeps the schema messages', () => {
    const { dropped } = parseProposedKit({
      fonts: [{ id: 'inter', family: 'Inter', role: 'body', weights: ['bold'], file: null, source: SRC }, { id: 'x', family: 'X', role: 'body', file: null, source: SRC }],
      dos: [{ id: 'nota', source: SRC }],
    }, EMPTY_BRAND_KIT, SRC);
    expect(dropped).toEqual([
      'font «Inter»: pesi non validi (numeri interi da 100 a 900)',
      'font «X»: pesi non validi (numeri interi da 100 a 900)',
      'cosa da fare «nota»: testo obbligatorio',
    ]);
  });
  it('is not affected by __proto__ keys', () => {
    const json = JSON.parse(`{"__proto__":{"polluted":true},"colors":[{"__proto__":{"polluted":true},"id":"a","name":"A","hex":"#112233","role":"primary","source":{"kind":"website","ref":"https://acme.example"}}],"tone":{"__proto__":{"x":1},"text":"Diretto"}}`);
    const { kit, dropped } = parseProposedKit(json, EMPTY_BRAND_KIT, SRC);
    expect(dropped).toEqual([]);
    expect(kit.colors).toEqual([{ id: 'a', name: 'A', hex: '#112233', role: 'primary', source: SRC }]);
    expect(kit.tone).toEqual({ id: 'diretto', text: 'Diretto', source: SRC });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(kit.colors[0])).toBe(Object.prototype);
  });
});
