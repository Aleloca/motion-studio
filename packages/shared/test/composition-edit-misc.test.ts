import { describe, expect, it } from 'vitest';
import {
  DESCRIBE_MAX_ITEMS, compositionSchema, describeEdits, editOpSchema, editProblemText, pinSchema, snapTargets, snapTime, versionEntrySchema,
  compositionJsonSchema, type EditOp,
} from '../src/index.ts';
import { readFileSync } from 'node:fs';
import { spike } from './composition-edit-helpers.ts';

describe('describeEdits', () => {
  const clipProps = (clipId: string, props: object): EditOp => ({ kind: 'clipProps', clipId, props });
  it('names the first three items, then counts the rest, in both languages', () => {
    const ops: EditOp[] = [
      clipProps('title', { text: 'x' }), { kind: 'sceneDuration', sceneId: 'photo', duration: 3 }, { kind: 'clipFlags', clipId: 'card', hidden: true },
      { kind: 'sceneOrder', order: [] }, { kind: 'clipTiming', clipId: 'caption', start: 0, duration: 1, ripple: false },
    ];
    expect(DESCRIBE_MAX_ITEMS).toBe(3);
    expect(describeEdits(ops, spike, 'en')).toBe('Direct edits: title text, scene 2 duration, card visibility and 2 more');
    expect(describeEdits(ops, spike, 'it')).toBe('Modifiche dirette: testo di title, durata della scena 2, visibilità di card e altre 2');
  });
  it('lists fewer items without a tail, without repeats', () => {
    expect(describeEdits([clipProps('title', { text: 'a' }), clipProps('title', { text: 'b' })], spike, 'en')).toBe('Direct edits: title text');
    expect(describeEdits([clipProps('title', { fill: 1, x: 2 })], spike, 'en')).toBe('Direct edits: title style, title position');
    expect(describeEdits([clipProps('a', {}), clipProps('title', { text: 'a' }), { kind: 'addFont', font: { family: 'F', src: 'assets/f.ttf' } }], spike, 'en')).toBe('Direct edits: title text, font F');
    expect(describeEdits([], spike, 'en')).toBe('Direct edits: ');
  });
  it('uses clip names and exactly three items is not cut', () => {
    const c = structuredClone(spike);
    (c.tracks[2]!.clips[0] as { name?: string }).name = 'Headline';
    const three: EditOp[] = [clipProps('title', { text: 'x' }), clipProps('card', { fill: '#fff' }), clipProps('caption', { x: 1 })];
    expect(describeEdits(three, c, 'en')).toBe('Direct edits: Headline text, card style, caption position');
  });
});

describe('editProblemText', () => {
  it('translates editor and composition problems', () => {
    expect(editProblemText({ key: 'editor.locked', params: { clip: 'a' } }, 'en')).toContain('locked');
    expect(editProblemText({ key: 'editor.locked', params: { clip: 'a' } }, 'it')).toContain('bloccata');
    expect(editProblemText({ key: 'composition.clipOutsideScene', params: { clip: 'a', scene: 's', start: 0, end: 1 } }, 'en')).toContain('outside its scene');
    expect(editProblemText({ key: 'editor.nothing', params: {} }, 'en')).toBe('editor.nothing');
  });
});

describe('snapTime', () => {
  const targets = [0, 2, 4];
  it('snaps within the threshold, inclusive, to the nearest', () => {
    expect(snapTime(2.1, targets, 0.1)).toEqual({ t: 2, snappedTo: 2 });
    expect(snapTime(1.9, targets, 0.1)).toEqual({ t: 2, snappedTo: 2 });
    expect(snapTime(2.1001, targets, 0.1)).toEqual({ t: 2.1001, snappedTo: null });
    expect(snapTime(3, [2.9, 3.2], 0.5)).toEqual({ t: 2.9, snappedTo: 2.9 });
    expect(snapTime(3, [2.8, 3.2], 0.5)).toEqual({ t: 2.8, snappedTo: 2.8 });
    expect(snapTime(5, [], 1)).toEqual({ t: 5, snappedTo: null });
    expect(snapTime(1, targets, 0)).toEqual({ t: 1, snappedTo: null });
    expect(snapTime(2, targets, 0)).toEqual({ t: 2, snappedTo: 2 });
  });
  it('lists scene bounds, clip edges, 0 and the duration, minus the dragged clip', () => {
    expect(snapTargets(spike)).toEqual([0, 0.2, 0.5, 0.6, 2, 2.15, 2.3, 4, 4.15, 4.5, 6]);
    expect(snapTargets(spike, 'title')).not.toContain(0.2);
    expect(snapTargets(spike, 'title')).toContain(0.6);
  });
});

describe('schema additions', () => {
  it('the checked-in JSON schema equals the generated one and knows the clip flags', () => {
    const file = JSON.parse(readFileSync(new URL('../src/composition/composition.schema.json', import.meta.url), 'utf8'));
    expect(file).toEqual(JSON.parse(JSON.stringify(compositionJsonSchema())));
    expect(JSON.stringify(file)).toContain('"locked"');
  });
  it('clip flags parse, strangers do not', () => {
    const c = structuredClone(spike) as unknown as { tracks: Array<{ clips: Array<Record<string, unknown>> }> };
    c.tracks[1]!.clips[0]!.hidden = true; c.tracks[1]!.clips[0]!.locked = false;
    expect(compositionSchema.safeParse(c).success).toBe(true);
    c.tracks[1]!.clips[0]!.hidden = 'yes';
    expect(compositionSchema.safeParse(c).success).toBe(false);
  });
  it('pins: old pins still parse, clip and range are checked', () => {
    const base = { format: 'f', x: 0.5, y: 0.5, timeSec: 1 };
    expect(pinSchema.safeParse(base).success).toBe(true);
    expect(pinSchema.safeParse({ ...base, clipId: 'title', range: { start: 0, end: 1.5 } }).success).toBe(true);
    expect(pinSchema.safeParse({ ...base, clipId: 'x'.repeat(65) }).success).toBe(false);
    expect(pinSchema.safeParse({ ...base, clipId: 'x'.repeat(64), clipName: 'n'.repeat(200) }).success).toBe(true);
    expect(pinSchema.safeParse({ ...base, clipName: 'n'.repeat(201) }).success).toBe(false);
    expect(pinSchema.safeParse({ ...base, clipId: 'tit"le', clipName: 'Il "titolo" — ok' }).success).toBe(true);
    for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a\u2028b', 'a\u2029b']) {
      expect(pinSchema.safeParse({ ...base, clipId: bad }).success).toBe(false);
      expect(pinSchema.safeParse({ ...base, clipName: bad }).success).toBe(false);
    }
    expect(pinSchema.safeParse({ ...base, range: { start: 1, end: 1 } }).success).toBe(false);
    expect(pinSchema.safeParse({ ...base, range: { start: 2, end: 1 } }).success).toBe(false);
    expect(pinSchema.safeParse({ ...base, range: { start: -1, end: 1 } }).success).toBe(false);
  });
  it('version entries take an optional origin', () => {
    const entry = { n: 1, commit: null, sessionId: null, status: 'complete', createdAt: '2026-10-13T10:00:00.000Z', request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null };
    expect(versionEntrySchema.safeParse(entry).success).toBe(true);
    expect(versionEntrySchema.safeParse({ ...entry, origin: 'editor' }).success).toBe(true);
    expect(versionEntrySchema.safeParse({ ...entry, origin: 'bot' }).success).toBe(false);
  });
});

describe('editOpSchema', () => {
  it('accepts well formed ops and bounds the rest', () => {
    expect(editOpSchema.safeParse({ kind: 'clipTiming', clipId: 'a', start: 1, duration: 2, ripple: false }).success).toBe(true);
    expect(editOpSchema.safeParse({ kind: 'clipProps', clipId: 'a', props: { text: 'x', fill: '#fff' } }).success).toBe(true);
    expect(editOpSchema.safeParse({ kind: 'animationPreset', clipId: 'a', slot: 'in', preset: null, duration: 1 }).success).toBe(true);
    expect(editOpSchema.safeParse({ kind: 'addFont', font: { family: 'F', src: 'assets/f.ttf' } }).success).toBe(true);
    for (const bad of [
      { kind: 'clipTiming', clipId: 'a'.repeat(65), start: 1, duration: 2, ripple: false },
      { kind: 'clipTiming', clipId: 'a', start: Number.NaN, duration: 2, ripple: false },
      { kind: 'clipTiming', clipId: 'a', start: 1, duration: Number.POSITIVE_INFINITY, ripple: false },
      { kind: 'clipProps', clipId: 'a', props: { text: 'x'.repeat(2001) } },
      { kind: 'clipProps', clipId: 'a', props: { evil: 1 } },
      { kind: 'htmlParam', clipId: 'a', key: 'k', value: 'x'.repeat(2001) },
      { kind: 'animationPreset', clipId: 'a', slot: 'mid', preset: null, duration: 1 },
      { kind: 'nope' },
    ]) expect(editOpSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
  });
});
