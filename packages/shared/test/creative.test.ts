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
