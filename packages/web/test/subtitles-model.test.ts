import type { SubtitleCue } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import { cueAt, editorReducer, runtimeSubtitlesOf, initialEditorState, warningsOf, type EditorOp, type EditorState } from '../src/screens/subtitles/subtitlesModel.ts';

const cue = (id: string, start: number, end: number, text: string, extra: Partial<SubtitleCue> = {}): SubtitleCue => ({ id, start, end, text, ...extra });
const load = (cues: SubtitleCue[], durationMs = 20000): EditorState => editorReducer(initialEditorState(), { type: 'load', cues, durationMs, lang: 'it' });
const run = (s: EditorState, ...ops: EditorOp[]): EditorState => ops.reduce(editorReducer, s);

describe('subtitle editor model (decisions 1652-1655)', () => {
  it('a text edit marks edited and is undoable and redoable', () => {
    const s0 = load([cue('a', 0, 2000, 'Ciao')]);
    const s1 = run(s0, { type: 'text', id: 'a', text: 'Ciao a tutti' });
    expect(s1.cues[0]).toMatchObject({ text: 'Ciao a tutti', edited: true });
    expect(s1.dirty).toBe(true);
    const s2 = run(s1, { type: 'undo' });
    expect(s2.cues[0]).toEqual(s0.cues[0]);
    expect(run(s2, { type: 'redo' }).cues).toEqual(s1.cues);
  });

  it('normalises typed text: blank lines, spaces, more than two lines', () => {
    const s = load([cue('a', 0, 2000, 'x')]);
    expect(run(s, { type: 'text', id: 'a', text: 'a\n' }).cues[0]!.text).toBe('a');
    expect(run(s, { type: 'text', id: 'a', text: 'a\n  \n b' }).cues[0]!.text).toBe('a\nb');
    expect(run(s, { type: 'text', id: 'a', text: '  uno  \r\n due ' }).cues[0]!.text).toBe('uno\ndue');
    const three = run(s, { type: 'text', id: 'a', text: 'one two three\nfour five six\nseven eight nine' }).cues[0]!.text;
    expect(three.split('\n').length).toBeLessThanOrEqual(2);
    expect(three.split('\n').every((l) => l.trim() !== '')).toBe(true);
    const long = run(s, { type: 'text', id: 'a', text: 'abc '.repeat(100) }).cues[0]!.text;
    expect(Array.from(long).length).toBeLessThanOrEqual(200);
    expect(long.split('\n').length).toBeLessThanOrEqual(2);
    // Nothing left: the cue is unchanged.
    expect(run(s, { type: 'text', id: 'a', text: ' \n ' })).toBe(s);
  });

  it('an end dragged past the next start stops at the next start', () => {
    const s = load([cue('a', 0, 2000, 'a'), cue('b', 3000, 5000, 'b')]);
    expect(run(s, { type: 'times', id: 'a', end: 4000 }).cues[0]!.end).toBe(3000);
  });

  it('a start within 100 ms of the previous end snaps to it; the minimum length holds', () => {
    const s = load([cue('a', 0, 2000, 'a'), cue('b', 3000, 5000, 'b')]);
    expect(run(s, { type: 'times', id: 'b', start: 2050 }).cues[1]!.start).toBe(2000);
    expect(run(s, { type: 'times', id: 'b', start: 4900 }).cues[1]!.start).toBe(4800);
    expect(run(s, { type: 'times', id: 'a', start: -500 }).cues[0]!.start).toBe(0);
    expect(run(s, { type: 'times', id: 'b', end: 99999 }).cues[1]!.end).toBe(20000);
  });

  it('split uses the word time of the cut when there are words', () => {
    const words = [{ start: 0, end: 500, text: 'Ciao' }, { start: 700, end: 900, text: 'a' }, { start: 1500, end: 2000, text: 'tutti' }];
    const s = load([cue('a', 0, 2000, 'Ciao a tutti', { words })]);
    const r = run(s, { type: 'split', id: 'a', at: 6 });
    expect(r.cues.map((c) => [c.text, c.start, c.end])).toEqual([['Ciao a', 0, 900], ['tutti', 1500, 2000]]);
    expect(r.cues.every((c) => c.edited)).toBe(true);
    expect(new Set(r.cues.map((c) => c.id)).size).toBe(2);
  });

  it('split without words divides by characters', () => {
    const s = load([cue('a', 0, 2000, 'aaaa bbbb')]);
    const r = run(s, { type: 'split', id: 'a', at: 5 });
    expect(r.cues.map((c) => [c.text, c.start, c.end])).toEqual([['aaaa', 0, 1000], ['bbbb', 1000, 2000]]);
    expect(run(s, { type: 'split', id: 'a', at: 0 })).toBe(s);
  });

  it('merge joins with the next and rewraps to at most two lines', () => {
    const s = load([cue('a', 0, 2000, 'una frase abbastanza lunga\nche va a capo'), cue('b', 2000, 4000, 'e un\'altra frase altrettanto lunga\nanche lei')]);
    const r = run(s, { type: 'merge', id: 'a' });
    expect(r.cues).toHaveLength(1);
    expect(r.cues[0]).toMatchObject({ id: 'a', start: 0, end: 4000, edited: true });
    expect(r.cues[0]!.text.split('\n').length).toBeLessThanOrEqual(2);
    expect(r.cues[0]!.text.replace(/\s+/g, ' ')).toBe('una frase abbastanza lunga che va a capo e un\'altra frase altrettanto lunga anche lei');
    expect(run(r, { type: 'merge', id: 'a' })).toBe(r);
  });

  it('add fills the gap, shorter when the gap is shorter, and does nothing without a gap', () => {
    const s = load([cue('a', 0, 1000, 'a'), cue('b', 1600, 5000, 'b')]);
    const r = run(s, { type: 'add', at: 1200 });
    expect(r.cues[1]).toMatchObject({ start: 1000, end: 1600, edited: true });
    expect(r.selected).toBe(r.cues[1]!.id);
    expect(run(s, { type: 'add', at: 2000 })).toBe(s);
    const open = run(s, { type: 'add', at: 6000 });
    expect(open.cues[2]).toMatchObject({ start: 6000, end: 8000 });
    expect(open.cues[2]!.text).not.toBe('');
  });

  it('delete removes the cue and clears the selection', () => {
    const s = run(load([cue('a', 0, 1000, 'a'), cue('b', 1000, 2000, 'b')]), { type: 'select', id: 'a' });
    const r = run(s, { type: 'delete', id: 'a' });
    expect(r.cues.map((c) => c.id)).toEqual(['b']);
    expect(r.selected).toBeNull();
  });

  it('replace is case-insensitive when asked and marks only the matching cues', () => {
    const s = load([cue('a', 0, 1000, 'il motion studio'), cue('b', 1000, 2000, 'altro'), cue('c', 2000, 3000, 'Motion STUDIO qui')]);
    const r = run(s, { type: 'replace', find: 'motion studio', with: 'Motion Studio', caseSensitive: false });
    expect(r.cues.map((c) => c.text)).toEqual(['il Motion Studio', 'altro', 'Motion Studio qui']);
    expect(r.cues.map((c) => c.edited)).toEqual([true, undefined, true]);
    const sensitive = run(s, { type: 'replace', find: 'motion studio', with: 'X', caseSensitive: true });
    expect(sensitive.cues.map((c) => c.edited)).toEqual([true, undefined, undefined]);
    expect(run(s, { type: 'replace', find: 'a.b', with: 'X', caseSensitive: false })).toBe(s);
  });

  it('keeps at most 200 undo steps', () => {
    let s = load([cue('a', 0, 2000, 'x')]);
    for (let i = 0; i < 250; i++) s = run(s, { type: 'text', id: 'a', text: `t${i}` }, { type: 'endTyping' });
    expect(s.past).toHaveLength(200);
  });

  it('warningsOf flags a fast cue; cueAt finds the cue on screen', () => {
    const cues = [cue('a', 0, 1000, 'x'.repeat(30)), cue('b', 1000, 3000, 'ok')];
    expect(warningsOf(cues, 'it').get('a')).toContain('tooFast');
    expect(warningsOf(cues, 'it').has('b')).toBe(false);
    expect(cueAt(cues, 0)?.id).toBe('a');
    expect(cueAt(cues, 1000)?.id).toBe('b');
    expect(cueAt(cues, 3000)).toBeNull();
  });
  it('Task 22: cueAt follows the runtime\'s overlap rule: of the cues on screen, the one that started later shows', () => {
    const cues = [cue('long', 0, 5000, 'lunga'), cue('short', 1000, 2000, 'breve'), cue('next', 4000, 6000, 'dopo')];
    expect(cueAt(cues, 500)?.id).toBe('long');
    expect(cueAt(cues, 1500)?.id).toBe('short');
    // When the later one ends, the longer one under it shows again.
    expect(cueAt(cues, 2500)?.id).toBe('long');
    expect(cueAt(cues, 4500)?.id).toBe('next');
  });
  it('Task 22: runtimeSubtitlesOf: the cues as the runtime takes them, sorted, cut at the video\'s end, text bounded', () => {
    const cues = [
      { ...cue('b', 2000, 3000, 'due'), edited: true as const, words: [{ start: 2000, end: 2500, text: 'due' }] },
      cue('a', 0, 1000, 'uno'),
      cue('c', 5500, 7000, 'oltre la fine'),
      cue('d', 4000, 9000, 'x'.repeat(250)),
    ];
    expect(runtimeSubtitlesOf('it', cues, 6000)).toEqual({ lang: 'it', cues: [
      { start: 0, end: 1000, text: 'uno' },
      { start: 2000, end: 3000, text: 'due', words: [{ start: 2000, end: 2500, text: 'due' }] },
      { start: 4000, end: 6000, text: 'x'.repeat(200) },
      { start: 5500, end: 6000, text: 'oltre la fine' },
    ] });
    // No known duration: nothing is cut.
    expect(runtimeSubtitlesOf('it', [cue('a', 0, 9000, 'uno')], 0).cues).toEqual([{ start: 0, end: 9000, text: 'uno' }]);
  });
  it('the video\'s duration, known after the load, changes no cue, no history and nothing to save (Task 12)', () => {
    const s0 = load([cue('a', 0, 2000, 'Ciao')], 2000);
    const s1 = run(s0, { type: 'duration', ms: 9000 });
    expect(s1.durationMs).toBe(9000);
    expect(s1.cues).toBe(s0.cues);
    expect(s1.past).toEqual([]);
    expect(s1.dirty).toBe(false);
    expect(run(s1, { type: 'add', at: 5000 }).cues).toHaveLength(2);
    expect(run(s1, { type: 'duration', ms: 9000 })).toBe(s1);
  });
  it('a burst of typing in one cue is one undo step, ended by another op, a select or the end of typing (Task 12 fix 1)', () => {
    const s0 = load([cue('a', 0, 2000, 'Ciao'), cue('b', 3000, 5000, 'Mondo')]);
    const typed = run(s0, { type: 'text', id: 'a', text: 'Ciao a' }, { type: 'text', id: 'a', text: 'Ciao a t' }, { type: 'text', id: 'a', text: 'Ciao a tutti' });
    expect(typed.past).toHaveLength(1);
    expect(run(typed, { type: 'undo' }).cues[0]!.text).toBe('Ciao');
    expect(run(typed, { type: 'undo' }, { type: 'redo' }).cues[0]!.text).toBe('Ciao a tutti');
    // Another cue, or the same one after the end of typing, a select or another op: a new step.
    expect(run(typed, { type: 'text', id: 'b', text: 'Mondo!' }).past).toHaveLength(2);
    expect(run(typed, { type: 'endTyping' }, { type: 'text', id: 'a', text: 'Ciao a tutti!' }).past).toHaveLength(2);
    expect(run(typed, { type: 'select', id: 'a' }, { type: 'text', id: 'a', text: 'Ciao a tutti!' }).past).toHaveLength(2);
    expect(run(typed, { type: 'times', id: 'b', end: 4500 }, { type: 'text', id: 'a', text: 'Ciao a tutti!' }).past).toHaveLength(3);
    expect(run(typed, { type: 'undo' }, { type: 'redo' }, { type: 'text', id: 'a', text: 'Ciao a tutti!' }).past).toHaveLength(2);
  });
});

describe('a timeline drag is one undo step (Task 13)', () => {
  it('times ops marked `drag` join the first one until `endDrag`; the next drag is a new step', () => {
    const s0 = load([cue('a', 0, 2000, 'Ciao'), cue('b', 5000, 7000, 'Mondo')]);
    const s1 = run(s0, { type: 'times', id: 'a', end: 2100, drag: true }, { type: 'times', id: 'a', end: 2600, drag: true }, { type: 'times', id: 'a', end: 3000, drag: true });
    expect(s1.cues[0]).toMatchObject({ end: 3000, edited: true });
    expect(s1.past).toHaveLength(1);
    expect(s1.dirty).toBe(true);
    const s2 = run(s1, { type: 'endDrag' }, { type: 'times', id: 'a', end: 3500, drag: true }, { type: 'times', id: 'a', end: 4000, drag: true }, { type: 'endDrag' });
    expect(s2.past).toHaveLength(2);
    expect(run(s2, { type: 'undo' }).cues[0]!.end).toBe(3000);
    expect(run(s2, { type: 'undo' }, { type: 'undo' }).cues[0]).toEqual(s0.cues[0]);
    // A drag of another cue is a step of its own; a times op without `drag` always is.
    expect(run(s1, { type: 'times', id: 'b', start: 5500, drag: true }).past).toHaveLength(2);
    expect(run(s1, { type: 'times', id: 'a', end: 3200 }).past).toHaveLength(2);
  });
});
