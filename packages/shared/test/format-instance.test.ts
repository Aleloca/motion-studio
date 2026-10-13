import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMATS, INSTANCE_ID_RE, briefSchema, creativeFileSchema, instanceIndex, instanceLabel, nextInstanceId, presetOf, versionsFileSchema } from '../src/index.ts';

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
    expect(briefSchema.safeParse({ ...oldBrief, formats: ['a', 'a'] }).success).toBe(false);
    expect(briefSchema.safeParse({ ...oldBrief, formats: ['a@1'] }).success).toBe(false);
    expect(briefSchema.safeParse({ ...oldBrief, formats: ['a@21'] }).success).toBe(false);
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
