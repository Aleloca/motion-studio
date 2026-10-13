import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMATS, INSTANCE_ID_RE, briefSchema, briefWriteSchema, checkLink, creativeFileSchema, defaultLinks, formatDisplayName, formatLabel, instanceIndex, instanceLabel, instancePreset, linksAfterBriefSave, nextInstanceId, presetOf, versionsFileSchema } from '../src/index.ts';

const now = '2026-10-07T10:00:00.000Z';
const oldBrief = { goal: 'Far capire che prenotare è immediato', message: '', formats: ['instagram-post-1x1', 'instagram-reel-9x16'], durationSec: 15, assets: [], notes: '' };

describe('instance ids', () => {
  it('accepts bare ids and @2..@20, refuses @1 and @21', () => {
    for (const ok of ['x', 'appstore-iphone-69', 'x@2', 'x@9', 'x@10', 'x@19', 'x@20']) expect(INSTANCE_ID_RE.test(ok), ok).toBe(true);
    for (const bad of ['x@1', 'x@21', 'x@0', 'x@02', 'x@', 'x@2@3', '@2', 'X', 'x y', 'x@100', '']) expect(INSTANCE_ID_RE.test(bad), bad).toBe(false);
  });
  it('every catalog preset id is still a valid instance id', () => {
    for (const p of DEFAULT_FORMATS) expect(INSTANCE_ID_RE.test(p.id), p.id).toBe(true);
  });
  it('presetOf and instanceIndex', () => {
    expect(presetOf('appstore-iphone-69@3')).toBe('appstore-iphone-69');
    expect(presetOf('appstore-iphone-69')).toBe('appstore-iphone-69');
    expect(instanceIndex('appstore-iphone-69')).toBe(1);
    expect(instanceIndex('appstore-iphone-69@3')).toBe(3);
    expect(instanceIndex('x@20')).toBe(20);
  });
  it('nextInstanceId takes the first gap and gives null when 20 are taken', () => {
    expect(nextInstanceId('x', [])).toBe('x');
    expect(nextInstanceId('x', ['x'])).toBe('x@2');
    expect(nextInstanceId('x', ['x', 'x@2', 'x@4'])).toBe('x@3');
    expect(nextInstanceId('x', ['x@2'])).toBe('x');
    expect(nextInstanceId('x', ['x', 'y@2'])).toBe('x@2');
    const all = ['x', ...Array.from({ length: 19 }, (_, i) => `x@${i + 2}`)];
    expect(all).toHaveLength(20);
    expect(nextInstanceId('x', all)).toBeNull();
    expect(nextInstanceId('x', all.slice(1))).toBe('x');
  });
  it('instanceLabel: label, else "Name #k", else "Name"', () => {
    expect(instanceLabel('x', 'Story')).toBe('Story');
    expect(instanceLabel('x@3', 'Story')).toBe('Story #3');
    expect(instanceLabel('x@3', 'Story', { 'x@3': 'Promo estiva' })).toBe('Promo estiva');
    expect(instanceLabel('x', 'Story', { 'x@3': 'Promo estiva' })).toBe('Story');
  });
});

describe('brief formats and labels', () => {
  it('accepts instance ids', () => {
    expect(briefSchema.safeParse({ ...oldBrief, formats: ['instagram-post-1x1', 'instagram-post-1x1@2'] }).success).toBe(true);
  });
  it('refuses duplicates and bad ids', () => {
    expect(briefWriteSchema.safeParse({ ...oldBrief, formats: ['a', 'a'] }).success).toBe(false);
    expect(briefWriteSchema.safeParse({ ...oldBrief, formats: ['a@1'] }).success).toBe(false);
    expect(briefWriteSchema.safeParse({ ...oldBrief, formats: ['a@21'] }).success).toBe(false);
  });
  it('formatLabels: keys must be in formats, values 1..60 chars', () => {
    const f = ['a', 'a@2'];
    expect(briefSchema.safeParse({ ...oldBrief, formats: f, formatLabels: { 'a@2': 'Story · promo' } }).success).toBe(true);
    expect(briefSchema.safeParse({ ...oldBrief, formats: f, formatLabels: { 'a@3': 'x' } }).success).toBe(false);
    expect(briefSchema.safeParse({ ...oldBrief, formats: f, formatLabels: { a: '' } }).success).toBe(false);
    expect(briefSchema.safeParse({ ...oldBrief, formats: f, formatLabels: { a: 'x'.repeat(61) } }).success).toBe(false);
    expect(briefSchema.safeParse({ ...oldBrief, formats: f, formatLabels: { a: 'x'.repeat(60) } }).success).toBe(true);
  });
  it('locales: extra max 10, no duplicates, primary not in extra, curated tags only', () => {
    const ok = { primary: 'en', extra: ['it', 'de'] };
    expect(briefSchema.safeParse({ ...oldBrief, locales: ok }).success).toBe(true);
    expect(briefSchema.safeParse({ ...oldBrief, locales: { primary: 'en', extra: ['it', 'it'] } }).success).toBe(false);
    expect(briefSchema.safeParse({ ...oldBrief, locales: { primary: 'en', extra: ['en'] } }).success).toBe(false);
    expect(briefSchema.safeParse({ ...oldBrief, locales: { primary: 'en', extra: ['ar'] } }).success).toBe(false);
    const eleven = ['it', 'fr', 'de', 'es', 'pt', 'nl', 'sv', 'da', 'nb', 'fi', 'pl'];
    expect(briefSchema.safeParse({ ...oldBrief, locales: { primary: 'en', extra: eleven } }).success).toBe(false);
    expect(briefSchema.safeParse({ ...oldBrief, locales: { primary: 'en', extra: eleven.slice(0, 10) } }).success).toBe(true);
  });
});

describe('reading old briefs (Ruling F)', () => {
  it('drops duplicate formats on read, keeping the first; writes refuse them', () => {
    const dup = { ...oldBrief, formats: ['b', 'a', 'b', 'a'] };
    expect(briefSchema.parse(dup).formats).toEqual(['b', 'a']);
    expect(briefWriteSchema.safeParse(dup).success).toBe(false);
    expect(briefWriteSchema.safeParse({ ...oldBrief, formats: ['b', 'a'] }).success).toBe(true);
  });
  it('keeps a legacy id outside the instance pattern loadable; writes refuse it', () => {
    const legacy = { ...oldBrief, formats: ['My_Custom Format', 'instagram-post-1x1'] };
    expect(briefSchema.parse(legacy).formats).toEqual(['My_Custom Format', 'instagram-post-1x1']);
    expect(briefWriteSchema.safeParse(legacy).success).toBe(false);
    expect(briefWriteSchema.safeParse({ ...oldBrief, formats: ['a@21'] }).success).toBe(false);
  });
  it('a whole creative file with duplicate formats still loads', () => {
    const file = { schemaVersion: 1, title: 'T', status: 'ready', error: null, createdAt: now, updatedAt: now, resumeFrom: null, linkedCodebases: [], brief: { ...oldBrief, formats: ['a', 'a'] } };
    expect(creativeFileSchema.parse(file).brief.formats).toEqual(['a']);
  });
});

describe('pre-phase-12 data still parses unchanged', () => {
  it('an old creative file', () => {
    const file = { schemaVersion: 1, title: 'Lancio', status: 'ready', error: null, createdAt: now, updatedAt: now, resumeFrom: null, linkedCodebases: [], brief: oldBrief };
    expect(creativeFileSchema.parse(file)).toEqual(file);
  });
  it('an old versions file with compositions', () => {
    const h = 'a'.repeat(64);
    const versions = { schemaVersion: 1, versions: [{
      n: 1, commit: null, sessionId: null, status: 'complete', createdAt: now, request: 'x', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null,
      compositions: [{ format: 'instagram-post-1x1', dir: 'compositions/instagram-post-1x1', hash: h }],
    }] };
    expect(versionsFileSchema.parse(versions)).toEqual(versions);
  });
  it('a version with instance compositions and localizations', () => {
    const h = 'b'.repeat(64);
    const v = { n: 2, commit: null, sessionId: null, status: 'complete', createdAt: now, request: 'x', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: 1,
      compositions: [{ format: 'x@2', dir: 'compositions/x@2', hash: h }],
      localizations: [{ locale: 'de', instanceId: 'x@2', hash: h, origin: 'agent', stale: ['title'], voice: 'original' }] };
    expect(versionsFileSchema.parse({ schemaVersion: 1, versions: [v] }).versions[0]).toEqual(v);
    expect(versionsFileSchema.safeParse({ schemaVersion: 1, versions: [{ ...v, compositions: [{ format: 'x@2', dir: 'compositions/x@1', hash: h }] }] }).success).toBe(false);
    expect(versionsFileSchema.safeParse({ schemaVersion: 1, versions: [{ ...v, localizations: [{ ...v.localizations[0], origin: 'bot' }] }] }).success).toBe(false);
  });
});

describe('instance presets, names and links (Phase 12, Task 1)', () => {
  const STORY = DEFAULT_FORMATS.find((p) => p.id === 'instagram-reel-9x16')!;
  it('instancePreset: a bare id is the catalog object itself, an instance a copy carrying its own id, anything else as before', () => {
    expect(instancePreset(DEFAULT_FORMATS, STORY.id)).toBe(STORY);
    expect(instancePreset(DEFAULT_FORMATS, `${STORY.id}@2`)).toEqual({ ...STORY, id: `${STORY.id}@2` });
    expect(instancePreset(DEFAULT_FORMATS, 'nope@2')).toBeUndefined();
    // Not an instance id (a legacy brief): looked up exactly, never through its preset part.
    expect(instancePreset(DEFAULT_FORMATS, `${STORY.id}@1`)).toBeUndefined();
    expect(instancePreset(DEFAULT_FORMATS, `${STORY.id}@x`)).toBeUndefined();
  });
  it('formatDisplayName: the label, else the localized preset name with #k; a bare id without a label is formatLabel', () => {
    for (const l of ['en', 'it'] as const) {
      expect(formatDisplayName(DEFAULT_FORMATS, STORY.id, l)).toBe(formatLabel(STORY, l));
      expect(formatDisplayName(DEFAULT_FORMATS, `${STORY.id}@3`, l)).toBe(`${formatLabel(STORY, l)} #3`);
    }
    expect(formatDisplayName(DEFAULT_FORMATS, `${STORY.id}@3`, 'en', { [`${STORY.id}@3`]: 'Promo' })).toBe('Promo');
    expect(formatDisplayName(DEFAULT_FORMATS, 'nope@2', 'en')).toBe('nope@2');
  });
  it('defaultLinks never links two instances of one preset; checkLink and linksAfterBriefSave resolve instances', () => {
    const at2 = `${STORY.id}@2`;
    const known = [STORY.id, at2].map((id) => instancePreset(DEFAULT_FORMATS, id)!);
    expect(defaultLinks(known, undefined)).toEqual({});
    const brief = { formats: [STORY.id, at2], links: {} };
    expect(checkLink(brief, [], DEFAULT_FORMATS, at2, STORY.id)).toEqual({ ok: true });
    expect(linksAfterBriefSave({ formats: [STORY.id], links: {} }, [STORY.id, at2], DEFAULT_FORMATS)).toEqual({});
    // Another preset of the same size still follows by default, as before.
    expect(linksAfterBriefSave({ formats: [STORY.id, at2], links: {} }, [STORY.id, at2, 'tiktok-9x16'], DEFAULT_FORMATS)).toEqual({ 'tiktok-9x16': STORY.id });
  });
});
