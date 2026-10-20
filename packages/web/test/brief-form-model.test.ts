import { EMPTY_BRIEF_FORM, type BriefField } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import { fieldsToApply, formSnapshot, lengthOf, mergeView, type FormState } from '../src/screens/new-creative/briefSessionModel.ts';

const state = (over: Partial<FormState> = {}): FormState => ({
  goal: '', message: '', length: '6', customSec: '', picked: [], codebases: [], notes: '', selected: [], variantCount: 1, ...over,
});
const own = (u: BriefField[] = [], a: BriefField[] = []) => ({ userEdited: new Set(u), agentFields: new Set(a) });

describe('brief form model (decision 1422)', () => {
  it('maps a duration to the length control', () => {
    expect(lengthOf(30)).toEqual({ length: '30', customSec: '' });
    expect(lengthOf(45)).toEqual({ length: 'custom', customSec: '45' });
  });

  it('snapshots the form: an invalid length is null, the variants stay within the brief limit', () => {
    expect(formSnapshot(state({ length: 'custom', customSec: '' })).durationSec).toBeNull();
    expect(formSnapshot(state({ length: '15', selected: ['tiktok-9x16'], picked: ['assets/a.png'], variantCount: 9 }))).toEqual({
      ...EMPTY_BRIEF_FORM, durationSec: 15, formats: ['tiktok-9x16'], assets: ['assets/a.png'], variants: 5,
    });
  });

  it('a fill leaves out the fields the user owns', () => {
    expect(fieldsToApply(['goal', 'formats'], new Set(['goal']))).toEqual(['formats']);
  });

  it("merges a view: the session's values and owners, except the user's unsaved edits", () => {
    const local = { form: { ...EMPTY_BRIEF_FORM, goal: 'Il mio testo', message: 'Vecchio' }, ...own(['goal']) };
    const server = { form: { ...EMPTY_BRIEF_FORM, goal: "Testo dell'agente", message: 'Nuovo', formats: ['tiktok-9x16'] }, userEdited: [] as BriefField[], agentFields: ['goal', 'message', 'formats'] as BriefField[] };
    const m = mergeView(local, server);
    expect(m.form.goal).toBe('Il mio testo');
    expect(m.form.message).toBe('Nuovo');
    expect(m.form.formats).toEqual(['tiktok-9x16']);
    expect([...m.userEdited]).toEqual(['goal']);
    expect([...m.agentFields].sort()).toEqual(['formats', 'message']);
    expect(m.changed).toEqual(['message', 'formats']);
    // A field the user asked the agent to rewrite takes the agent's text.
    const r = mergeView(local, server, ['goal']);
    expect(r.form.goal).toBe("Testo dell'agente");
    expect(r.userEdited.has('goal')).toBe(false);
    expect(r.agentFields.has('goal')).toBe(true);
  });

  it('a saved field (same value) takes the session owner', () => {
    const local = { form: { ...EMPTY_BRIEF_FORM, goal: 'Uguale' }, ...own(['goal']) };
    const m = mergeView(local, { form: { ...EMPTY_BRIEF_FORM, goal: 'Uguale' }, userEdited: ['goal'], agentFields: [] });
    expect(m.taken).toContain('goal');
    expect(m.changed).toEqual([]);
    expect(m.userEdited.has('goal')).toBe(true);
  });
});
