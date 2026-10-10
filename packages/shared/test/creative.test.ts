import { describe, expect, it } from 'vitest';
import { creativeFileSchema, manifestSchema, pinSchema, versionsFileSchema } from '../src/index.ts';

const now = '2026-10-07T10:00:00.000Z';
const creative = {
  schemaVersion: 1, title: 'Lancio app', status: 'draft', error: null, createdAt: now, updatedAt: now, resumeFrom: null, linkedCodebases: [],
  brief: { goal: 'Far capire che prenotare è immediato', message: '', formats: ['instagram-post-1x1'], durationSec: 15, assets: [], notes: '' },
};

describe('creativeFileSchema', () => {
  it('accepts a valid creative', () => { expect(creativeFileSchema.parse(creative)).toEqual(creative); });
  it('requires at least one format and a non-empty goal', () => {
    expect(creativeFileSchema.safeParse({ ...creative, brief: { ...creative.brief, formats: [] } }).success).toBe(false);
    expect(creativeFileSchema.safeParse({ ...creative, brief: { ...creative.brief, goal: ' ' } }).success).toBe(false);
  });
  it('rejects a duration outside 1..600', () => {
    expect(creativeFileSchema.safeParse({ ...creative, brief: { ...creative.brief, durationSec: 0 } }).success).toBe(false);
  });
  it('requires ISO datetimes', () => {
    expect(creativeFileSchema.safeParse({ ...creative, createdAt: '7 ottobre' }).success).toBe(false);
  });
});

describe('manifestSchema', () => {
  it('accepts a manifest and rejects file names with path separators', () => {
    const m = { schemaVersion: 1, files: [{ format: 'instagram-post-1x1', file: 'instagram-post-1x1.png', width: 1080, height: 1080 }], tools: ['remotion'] };
    expect(manifestSchema.parse(m)).toEqual(m);
    expect(manifestSchema.safeParse({ ...m, files: [{ ...m.files[0], file: '../x.png' }] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...m, files: [{ ...m.files[0], file: 'a/b.png' }] }).success).toBe(false);
  });
  it('accepts null durationSec and renderCommand', () => {
    const m = { schemaVersion: 1, files: [{ format: 'b', file: 'b.png', width: 300, height: 250, durationSec: null }], tools: [], renderCommand: null };
    expect(manifestSchema.safeParse(m).success).toBe(true);
    expect(manifestSchema.safeParse({ ...m, files: [{ ...m.files[0], durationSec: 0 }] }).success).toBe(false);
  });
});

describe('pinSchema', () => {
  it('keeps coordinates in 0..1', () => {
    expect(pinSchema.safeParse({ format: 'a', x: 0.5, y: 1, timeSec: null }).success).toBe(true);
    expect(pinSchema.safeParse({ format: 'a', x: 1.2, y: 0, timeSec: null }).success).toBe(false);
  });
});

describe('versionsFileSchema', () => {
  it('defaults to an empty list', () => {
    expect(versionsFileSchema.parse({ schemaVersion: 1 })).toEqual({ schemaVersion: 1, versions: [] });
  });
});

describe('phase 9 optional fields', () => {
  it('old creative, versions and manifest files still parse without the new fields', () => {
    const c = creativeFileSchema.parse(creative);
    expect(c.exportPicks).toBeUndefined();
    expect(c.brief.links).toBeUndefined();
    const v = versionsFileSchema.parse({ schemaVersion: 1, versions: [{ n: 1, commit: null, sessionId: null, status: 'complete', createdAt: now, request: 'x',
      outputs: [{ format: 'a', file: 'a.png', width: 1, height: 1, durationSec: null, verified: true, preview: null }], problems: [], tools: [], renderCommand: null, basedOn: null }] });
    expect(v.versions[0]!.outputs[0]!.sha256).toBeUndefined();
    expect(manifestSchema.parse({ schemaVersion: 1, files: [{ format: 'a', file: 'a.png', width: 1, height: 1 }] }).files[0]!.followsFormat).toBeUndefined();
  });
  it('accepts exportPicks, brief links, sha256, per-file problems and followsFormat', () => {
    const c = { ...creative, exportPicks: { 'instagram-post-1x1': 2 }, brief: { ...creative.brief, links: { 'tiktok-9x16': 'instagram-reel-9x16' } } };
    expect(creativeFileSchema.parse(c)).toEqual(c);
    expect(creativeFileSchema.safeParse({ ...c, exportPicks: { a: 0 } }).success).toBe(false);
    const sha = 'ab'.repeat(32);
    const out = { format: 'a', file: 'a.png', width: 1, height: 1, durationSec: null, verified: true, preview: null, sha256: sha, problems: [] };
    const entry = { n: 1, commit: null, sessionId: null, status: 'complete', createdAt: now, request: 'x', outputs: [out], problems: [], tools: [], renderCommand: null, basedOn: null };
    expect(versionsFileSchema.parse({ schemaVersion: 1, versions: [entry] }).versions[0]!.outputs[0]).toEqual(out);
    expect(versionsFileSchema.safeParse({ schemaVersion: 1, versions: [{ ...entry, outputs: [{ ...out, sha256: 'xyz' }] }] }).success).toBe(false);
    const m = { schemaVersion: 1, files: [{ format: 'b', file: 'b.mp4', width: 1, height: 1, followsFormat: 'a' }], tools: [] };
    expect(manifestSchema.parse(m)).toEqual(m);
  });
});
