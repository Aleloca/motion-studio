import { customPreset, DEFAULT_FORMATS, EMPTY_BRIEF_FORM, type BriefField } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import { applyFill, fillLine, listFormats, mergeClientForm, reclaimLine, sameSizeCustom, sourceFormatSize } from '../src/brief/brief-tools.ts';
import { setLocale } from '../src/i18n.ts';

const session = (o: Partial<Parameters<typeof applyFill>[0]> = {}) => ({
  form: { ...EMPTY_BRIEF_FORM, assets: ['assets/logo.svg'] },
  userEdited: [] as BriefField[],
  agentFields: [] as BriefField[],
  context: { codebases: [{ path: '/c/app' }], assets: ['assets/hero.png'] },
  ...o,
});
const refusal = (fn: () => unknown) => { try { fn(); } catch (e) { return e as { status: number; message: string }; } throw new Error('not refused'); };

describe('listFormats', () => {
  it('lists the catalog the user can pick, without identity formats', () => {
    const { formats } = listFormats(DEFAULT_FORMATS, 'it');
    const post = formats.find((f) => f.id === 'instagram-post-1x1');
    expect(post).toMatchObject({ label: 'Instagram · Post 1:1', kind: 'video', width: 1080, height: 1080, maxDurationSec: 60 });
    expect(formats.some((f) => f.id === 'identity-logo')).toBe(false);
    expect(formats.map((f) => f.id)).toEqual(DEFAULT_FORMATS.filter((p) => !p.identity).map((p) => p.id));
  });
});

describe('applyFill', () => {
  it('writes what it is given', () => {
    const r = applyFill(session(), { goal: 'Lancio', formats: ['instagram-post-1x1'] }, DEFAULT_FORMATS);
    expect(r.written).toEqual(['goal', 'formats']);
    expect(r.agentFields).toEqual(['goal', 'formats']);
    expect(r.kept).toEqual([]);
    expect(r.form).toMatchObject({ goal: 'Lancio', formats: ['instagram-post-1x1'], assets: ['assets/logo.svg'] });
  });
  it('never changes a field the user edited', () => {
    const r = applyFill(session({ form: { ...EMPTY_BRIEF_FORM, goal: 'Mio' }, userEdited: ['goal'] }), { goal: 'Lancio', message: 'Prenota' }, DEFAULT_FORMATS);
    expect(r.form.goal).toBe('Mio');
    expect(r.form.message).toBe('Prenota');
    expect(r.kept).toEqual([{ field: 'goal', reason: 'user-edited' }]);
    expect(r.written).toEqual(['message']);
  });
  it('a field the user asked to rewrite is taken back (reclaim) and is no longer theirs', () => {
    const r = applyFill(session({ form: { ...EMPTY_BRIEF_FORM, goal: 'Mio', message: 'Mio' }, userEdited: ['goal', 'message'] }), { goal: 'Lancio', message: 'Prenota', reclaim: ['goal'] }, DEFAULT_FORMATS);
    expect(r.form.goal).toBe('Lancio');
    expect(r.form.message).toBe('Mio');
    expect(r.written).toEqual(['goal']);
    expect(r.reclaimed).toEqual(['goal']);
    expect(r.userEdited).toEqual(['message']);
    expect(r.kept).toEqual([{ field: 'message', reason: 'user-edited' }]);
  });
  it('a reclaim of a field that is not the user\'s is an ordinary write', () => {
    const r = applyFill(session(), { goal: 'Lancio', reclaim: ['goal', 'notes'] }, DEFAULT_FORMATS);
    expect(r.form.goal).toBe('Lancio');
    expect(r.written).toEqual(['goal']);
    expect(r.reclaimed).toEqual([]);
    expect(r.userEdited).toEqual([]);
  });
  it('a reclaim alone writes nothing and is refused', () => {
    expect(refusal(() => applyFill(session(), { reclaim: ['goal'] }, DEFAULT_FORMATS))).toMatchObject({ status: 400 });
  });
  it('a list the user changed stays whole', () => {
    const r = applyFill(session({ userEdited: ['assets'] }), { assets: ['assets/hero.png'] }, DEFAULT_FORMATS);
    expect(r.form.assets).toEqual(['assets/logo.svg']);
    expect(r.kept).toEqual([{ field: 'assets', reason: 'user-edited' }]);
  });
  it('takes assets and folders of the session, and its own', () => {
    const r = applyFill(session(), { assets: ['assets/hero.png', 'assets/logo.svg'], linkedCodebases: [{ path: '/c/app', note: 'App iOS' }] }, DEFAULT_FORMATS);
    expect(r.form.assets).toEqual(['assets/hero.png', 'assets/logo.svg']);
    expect(r.form.linkedCodebases).toEqual([{ path: '/c/app', note: 'App iOS' }]);
  });
  it('refuses what is outside the catalog or the session, changing nothing', () => {
    const s = session();
    const before = JSON.stringify(s);
    expect(refusal(() => applyFill(s, { goal: 'x', formats: ['nope-1x1'] }, DEFAULT_FORMATS))).toMatchObject({ status: 400, message: 'nope-1x1 non è un formato del catalogo: usa un id di list_formats.' });
    expect(refusal(() => applyFill(s, { formats: ['identity-logo'] }, DEFAULT_FORMATS)).message).toContain('identità');
    expect(refusal(() => applyFill(s, { assets: ['assets/other.png'] }, DEFAULT_FORMATS)).message).toContain('assets/other.png');
    expect(refusal(() => applyFill(s, { linkedCodebases: [{ path: '/x' }] }, DEFAULT_FORMATS)).message).toContain('/x');
    expect(refusal(() => applyFill(s, { goal: ' ' }, DEFAULT_FORMATS))).toMatchObject({ status: 400 });
    expect(refusal(() => applyFill(s, { variants: 9 }, DEFAULT_FORMATS)).message).toContain('variants');
    expect(JSON.stringify(s)).toBe(before);
  });
  it('takes copies of a format as its instance ids, in the order given (report 58)', () => {
    const formats = ['instagram-image-1x1', 'instagram-image-1x1@2', 'tiktok-9x16', 'instagram-image-1x1@3'];
    const r = applyFill(session(), { formats }, DEFAULT_FORMATS);
    expect(r.form.formats).toEqual(formats);
    expect(r.written).toEqual(['formats']);
  });
  it('refuses copies with a gap, a copy without its format, more than 20, a repeat, an unknown or an identity base', () => {
    const s = session();
    setLocale('it');
    expect(refusal(() => applyFill(s, { formats: ['instagram-image-1x1@2'] }, DEFAULT_FORMATS))).toMatchObject({ status: 400, message: expect.stringContaining('instagram-image-1x1@2') });
    expect(refusal(() => applyFill(s, { formats: ['instagram-image-1x1', 'instagram-image-1x1@3'] }, DEFAULT_FORMATS)).message).toContain('instagram-image-1x1@2');
    expect(refusal(() => applyFill(s, { formats: ['instagram-image-1x1', 'instagram-image-1x1@21'] }, DEFAULT_FORMATS))).toMatchObject({ status: 400 });
    expect(refusal(() => applyFill(s, { formats: ['instagram-image-1x1', 'instagram-image-1x1'] }, DEFAULT_FORMATS))).toMatchObject({ status: 400 });
    expect(refusal(() => applyFill(s, { formats: ['nope-1x1', 'nope-1x1@2'] }, DEFAULT_FORMATS)).message).toContain('nope-1x1');
    expect(refusal(() => applyFill(s, { formats: ['identity-logo@2'] }, DEFAULT_FORMATS)).message).toContain('identità');
    const twenty = Array.from({ length: 20 }, (_, k) => (k === 0 ? 'instagram-image-1x1' : `instagram-image-1x1@${k + 1}`));
    expect(applyFill(s, { formats: twenty }, DEFAULT_FORMATS).form.formats).toHaveLength(20);
  });
});

describe('fillLine', () => {
  const form = { ...EMPTY_BRIEF_FORM, assets: ['assets/a.png', 'assets/b.png', 'assets/c.png'], linkedCodebases: [{ path: '/a' }, { path: '/b' }], formats: ['a', 'b', 'c', 'd'] };
  it('says what the agent filled, in the prototype words', () => {
    setLocale('it');
    expect(fillLine(['goal', 'message', 'durationSec', 'assets', 'linkedCodebases', 'formats'], [], form)).toBe('Compilato il brief: testi, durata, 3 asset, 2 codebase, 4 formati');
    expect(fillLine(['message'], ['goal'], form)).toBe('Compilato il brief: testi · tenuti i tuoi: Cosa vuoi realizzare');
    expect(fillLine([], ['goal'], form)).toBe('Nessun campo del brief è cambiato · tenuti i tuoi: Cosa vuoi realizzare');
    expect(reclaimLine(['goal', 'formats'])).toBe("L'agente ha riscritto Cosa vuoi realizzare, Formati su tua richiesta");
    setLocale('en');
    expect(fillLine(['variants'], [], { ...form, variants: 3 })).toBe('Filled in the brief: 3 variants');
  });
});

describe('mergeClientForm (decision 1422)', () => {
  const server = (o: Partial<Parameters<typeof mergeClientForm>[0]> = {}) => ({
    form: { ...EMPTY_BRIEF_FORM, goal: 'Agente', message: 'Agente' }, userEdited: [] as BriefField[], revision: 5, reclaimedAt: {} as Record<string, number>, ...o,
  });
  it('takes only the fields the user owns from the client', () => {
    const r = mergeClientForm(server(), { form: { ...EMPTY_BRIEF_FORM, goal: 'Mio', message: 'vecchio' }, userEdited: ['goal'], baseRevision: 3 });
    expect(r.form).toMatchObject({ goal: 'Mio', message: 'Agente' });
    expect(r.userEdited).toEqual(['goal']);
    expect(r.revision).toBe(6);
  });
  it('an older save never reverts what the agent wrote', () => {
    const r = mergeClientForm(server(), { form: EMPTY_BRIEF_FORM, userEdited: [], baseRevision: 2 });
    expect(r.form).toMatchObject({ goal: 'Agente', message: 'Agente' });
    expect(r.revision).toBe(5);
  });
  it('a field taken back stays the agent\'s against a save based on an older revision, not against a newer edit', () => {
    const s = server({ reclaimedAt: { goal: 5 } });
    const stale = mergeClientForm(s, { form: { ...EMPTY_BRIEF_FORM, goal: 'Vecchio mio' }, userEdited: ['goal'], baseRevision: 4 });
    expect(stale.form.goal).toBe('Agente');
    expect(stale.userEdited).toEqual([]);
    const newer = mergeClientForm(s, { form: { ...EMPTY_BRIEF_FORM, goal: 'Nuovo mio' }, userEdited: ['goal'], baseRevision: 5 });
    expect(newer.form.goal).toBe('Nuovo mio');
    expect(newer.userEdited).toEqual(['goal']);
  });
  it('a field the user owns follows the client, ownership included', () => {
    const r = mergeClientForm(server({ form: { ...EMPTY_BRIEF_FORM, goal: 'Mio' }, userEdited: ['goal'] }), { form: { ...EMPTY_BRIEF_FORM, goal: '' }, userEdited: [], baseRevision: 0 });
    expect(r.form.goal).toBe('');
    expect(r.userEdited).toEqual([]);
  });
});

describe('custom formats (report 59)', () => {
  const totem = customPreset({ name: 'Totem', kind: 'video', width: 1080, height: 1920 }, 'custom-totem');
  it('fill_brief takes a custom format and its copies like any other', () => {
    const r = applyFill(session(), { formats: ['custom-totem', 'custom-totem@2'] }, [...DEFAULT_FORMATS, totem]);
    expect(r.form.formats).toEqual(['custom-totem', 'custom-totem@2']);
  });
  it('a hidden one (deleted while in use) is not offered and not taken', () => {
    const presets = [...DEFAULT_FORMATS, { ...totem, hidden: true as const }];
    expect(listFormats(presets, 'it').formats.some((f) => f.id === 'custom-totem')).toBe(false);
    expect(() => applyFill(session(), { formats: ['custom-totem'] }, presets)).toThrow(/custom-totem/);
  });
});

describe('the source\'s own size (report 70)', () => {
  it('a video keeps its size, each odd side one pixel less; a larger one is scaled to 4096 on its longer side', () => {
    expect(sourceFormatSize({ kind: 'video', width: 1920, height: 1188 })).toEqual({ width: 1920, height: 1188 });
    expect(sourceFormatSize({ kind: 'video', width: 1081, height: 1921 })).toEqual({ width: 1080, height: 1920 });
    expect(sourceFormatSize({ kind: 'video', width: 7680, height: 4320 })).toEqual({ width: 4096, height: 2304 });
    expect(sourceFormatSize({ kind: 'video', width: 5000, height: 3001 })).toEqual({ width: 4096, height: 2458 });
  });
  it('an image keeps odd sides (up to 8192); a size below 16 px cannot be a format', () => {
    expect(sourceFormatSize({ kind: 'image', width: 1081, height: 1921 })).toEqual({ width: 1081, height: 1921 });
    expect(sourceFormatSize({ kind: 'image', width: 10000, height: 5000 })).toEqual({ width: 8192, height: 4096 });
    expect(sourceFormatSize({ kind: 'video', width: 12, height: 1080 })).toBeNull();
  });
  it('reuses only a visible custom format of the same kind and size (a shipped preset has a platform\'s limits)', () => {
    const own = customPreset({ name: 'Originale 1920×1188', kind: 'video', width: 1920, height: 1188 }, 'custom-originale-1920-1188');
    expect(sameSizeCustom([...DEFAULT_FORMATS, own], 'video', 1920, 1188)?.id).toBe('custom-originale-1920-1188');
    expect(sameSizeCustom([...DEFAULT_FORMATS, { ...own, hidden: true as const }], 'video', 1920, 1188)).toBeUndefined();
    expect(sameSizeCustom([...DEFAULT_FORMATS, own], 'image', 1920, 1188)).toBeUndefined();
    // youtube 1920×1080 exists in the catalog but is not a custom format.
    expect(sameSizeCustom(DEFAULT_FORMATS, 'video', 1920, 1080)).toBeUndefined();
  });
});
