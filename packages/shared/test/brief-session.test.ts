import { describe, expect, it } from 'vitest';
import { BRIEF_FIELDS, briefContextSchema, briefFillSchema, briefFormSaveSchema, briefFormSchema, briefJobKey, briefMessageSchema } from '../src/index.ts';

const form = { goal: '', message: '', notes: '', durationSec: null, assets: [], linkedCodebases: [], formats: [], variants: 1 };

describe('briefFillSchema', () => {
  it('takes the fields the user asked to rewrite', () => {
    expect(briefFillSchema.parse({ goal: 'Lancio', reclaim: ['goal'] })).toEqual({ goal: 'Lancio', reclaim: ['goal'] });
  });
  it('accepts a partial fill', () => {
    expect(briefFillSchema.parse({ goal: 'Lancio', formats: ['instagram-post-1x1'] })).toEqual({ goal: 'Lancio', formats: ['instagram-post-1x1'] });
  });
  it.each([
    ['empty', {}],
    ['blank goal', { goal: '  ' }],
    ['no formats', { formats: [] }],
    ['too many variants', { variants: 6 }],
    ['zero length', { durationSec: 0 }],
    ['duplicate formats', { formats: ['a', 'a'] }],
    ['unknown key', { extra: 1 }],
    ['a reclaim alone', { reclaim: ['goal'] }],
    ['an unknown field to reclaim', { goal: 'x', reclaim: ['nope'] }],
  ])('refuses %s', (_name, raw) => {
    expect(briefFillSchema.safeParse(raw).success).toBe(false);
  });
});

describe('briefFormSchema', () => {
  it('accepts an empty goal and no length', () => {
    expect(briefFormSchema.parse(form)).toEqual(form);
  });
  it('refuses an asset outside the library', () => {
    expect(briefFormSchema.safeParse({ ...form, assets: ['work/x.png'] }).success).toBe(false);
    expect(briefFormSchema.safeParse({ ...form, assets: ['assets/x.png'] }).success).toBe(true);
  });
});

describe('briefMessageSchema', () => {
  it('takes the text, the context, the form and the fields the user owns', () => {
    const m = { clientId: 'c1', text: 'Un video di lancio', context: { codebases: [{ path: '/c/app' }], assets: [] }, form, userEdited: ['goal'], baseRevision: 0 };
    expect(briefMessageSchema.parse(m)).toEqual(m);
    // The revision the form is based on is required (decision 1422).
    const { baseRevision: _b, ...noBase } = m;
    expect(briefMessageSchema.safeParse(noBase).success).toBe(false);
    expect(briefFormSaveSchema.safeParse({ form, userEdited: [] }).success).toBe(false);
    expect(briefFormSaveSchema.safeParse({ form, userEdited: [], baseRevision: 2 }).success).toBe(true);
    expect(briefMessageSchema.safeParse({ ...m, userEdited: ['nope'] }).success).toBe(false);
    expect(briefContextSchema.safeParse({ codebases: [], assets: ['x.png'] }).success).toBe(false);
  });
});

describe('briefJobKey', () => {
  it('keys the brief job by root and project', () => {
    expect(briefJobKey('/w', 'acme')).toBe('brief:/w:acme');
    expect(BRIEF_FIELDS).toContain('variants');
  });
});
