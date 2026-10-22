// Task 13: the subtitle timeline under the editor's player and list: the waveform, a block per line, its edges and body
// dragged with the pointer (one `times` op per move, the model snapping and clamping), the edges as sliders (← → 100 ms,
// ⇧ 1 s), a click on empty space seeking, ⌘-wheel zooming.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useReducer } from 'react';
import type { SubtitleCue } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { CueTimeline, NUDGE_PAUSE_MS } from '../src/screens/subtitles/CueTimeline.tsx';
import { editorReducer, initialEditorState, type EditorOp } from '../src/screens/subtitles/subtitlesModel.ts';

// jsdom has no PointerEvent: a MouseEvent carries the coordinates, button and modifiers the timeline reads.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  }
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventPolyfill, configurable: true });
}

const CUES: SubtitleCue[] = [
  { id: 'a', start: 1000, end: 3000, text: 'Ciao a tutti' },
  { id: 'b', start: 5000, end: 7000, text: 'Prenota in tre tocchi' },
];
// The track is 1000 px wide for 10 s: 1 px is 10 ms.
const rect = { left: 0, top: 0, right: 1000, bottom: 80, width: 1000, height: 80, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
beforeEach(() => {
  // jsdom draws no canvas (it would log "not implemented"): the waveform is measured in Chrome (subtitles-layout).
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('ms-subtl-track') ? rect : ({ ...rect, width: 0, right: 0 } as DOMRect);
  });
});
afterEach(() => vi.restoreAllMocks());

const mount = (o: { selected?: string | null; peaks?: number[] | null } = {}) => {
  const dispatch = vi.fn();
  const onSeek = vi.fn();
  render(
    <I18nProvider locale="it">
      <CueTimeline cues={CUES} durationMs={10_000} peaks={o.peaks === undefined ? [0.2, 0.8, 0.5] : o.peaks} time={0} selected={o.selected ?? null} dispatch={dispatch} onSeek={onSeek} />
    </I18nProvider>);
  return { dispatch, onSeek };
};
const block = (id: string) => document.querySelector<HTMLElement>(`.ms-subtl-cue[data-cue="${id}"]`)!;

describe('CueTimeline', () => {
  it('a 50 px drag of a line\'s right edge moves its end by 500 ms, as one drag', () => {
    const { dispatch } = mount();
    const edge = block('a').querySelector<HTMLElement>('.ms-subtl-edge.ms-end')!;
    fireEvent.pointerDown(edge, { clientX: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 325, buttons: 1, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 350, buttons: 1, pointerId: 1 });
    fireEvent.pointerUp(edge, { clientX: 350, pointerId: 1 });
    const times = dispatch.mock.calls.map(([op]) => op).filter((op) => op.type === 'times');
    expect(times.at(-1)).toEqual({ type: 'times', id: 'a', end: 3500, drag: true });
    expect(times.every((op) => op.start === undefined && op.drag === true)).toBe(true);
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'endDrag' });
  });

  it('dragging the left edge moves the start; dragging the body moves both', () => {
    const { dispatch } = mount();
    const start = block('a').querySelector<HTMLElement>('.ms-subtl-edge.ms-start')!;
    fireEvent.pointerDown(start, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(start, { clientX: 80, buttons: 1, pointerId: 1 });
    fireEvent.pointerUp(start, { clientX: 80, pointerId: 1 });
    expect(dispatch).toHaveBeenCalledWith({ type: 'times', id: 'a', start: 800, drag: true });
    dispatch.mockClear();
    const body = block('b');
    fireEvent.pointerDown(body, { clientX: 600, button: 0, pointerId: 2 });
    fireEvent.pointerMove(body, { clientX: 630, buttons: 1, pointerId: 2 });
    fireEvent.pointerUp(body, { clientX: 630, pointerId: 2 });
    expect(dispatch).toHaveBeenCalledWith({ type: 'select', id: 'b' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'times', id: 'b', start: 5300, end: 7300, drag: true });
  });

  it('an edge is a slider: → moves it 100 ms, ⇧← 1 s', () => {
    const { dispatch } = mount({ selected: 'a' });
    const end = screen.getByRole('slider', { name: 'Fine della riga 1' });
    expect(end.getAttribute('aria-valuenow')).toBe('3000');
    fireEvent.keyDown(end, { key: 'ArrowRight' });
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'times', id: 'a', end: 3100, drag: true });
    const start = screen.getByRole('slider', { name: 'Inizio della riga 1' });
    fireEvent.keyDown(start, { key: 'ArrowLeft', shiftKey: true });
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'times', id: 'a', start: 0, drag: true });
  });

  it('a click on empty space seeks there and edits nothing', () => {
    const { dispatch, onSeek } = mount();
    const track = document.querySelector<HTMLElement>('.ms-subtl-track')!;
    fireEvent.pointerDown(track, { clientX: 420, button: 0, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 420, pointerId: 1 });
    expect(onSeek).toHaveBeenCalledWith(4200);
    expect(dispatch.mock.calls.filter(([op]) => op.type === 'times')).toEqual([]);
  });

  it('while the waveform loads it says so quietly, and the lines can still be dragged', () => {
    const { dispatch } = mount({ peaks: null });
    expect(screen.getByRole('status').textContent).toContain("Carico la forma d'onda");
    const edge = block('b').querySelector<HTMLElement>('.ms-subtl-edge.ms-end')!;
    fireEvent.pointerDown(edge, { clientX: 700, button: 0, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 720, buttons: 1, pointerId: 1 });
    expect(dispatch).toHaveBeenCalledWith({ type: 'times', id: 'b', end: 7200, drag: true });
  });

  it('⌘-wheel zooms between 1× and 20×; a plain wheel does not', () => {
    mount();
    const view = document.querySelector<HTMLElement>('.ms-subtl-view')!;
    const track = document.querySelector<HTMLElement>('.ms-subtl-track')!;
    fireEvent.wheel(view, { deltaY: -400 });
    expect(track.style.width).toBe('100%');
    fireEvent.wheel(view, { deltaY: -400, metaKey: true });
    expect(parseFloat(track.style.width)).toBeCloseTo(Math.exp(0.8) * 100, 1);
    for (let i = 0; i < 10; i++) fireEvent.wheel(view, { deltaY: -1000, ctrlKey: true });
    expect(track.style.width).toBe('2000%');
    for (let i = 0; i < 10; i++) fireEvent.wheel(view, { deltaY: 1000, metaKey: true });
    expect(track.style.width).toBe('100%');
  });

  it('a lost pointer capture ends the drag: later moves send nothing, one endDrag', () => {
    const { dispatch } = mount();
    const edge = block('a').querySelector<HTMLElement>('.ms-subtl-edge.ms-end')!;
    const track = document.querySelector<HTMLElement>('.ms-subtl-track')!;
    fireEvent.pointerDown(edge, { clientX: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 330, buttons: 1, pointerId: 1 });
    const times = () => dispatch.mock.calls.filter(([op]) => op.type === 'times').length;
    expect(times()).toBe(1);
    fireEvent.lostPointerCapture(track, { pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 360, buttons: 1, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 390, pointerId: 1 });
    expect(times()).toBe(1);
    expect(dispatch.mock.calls.filter(([op]) => op.type === 'endDrag')).toHaveLength(1);
  });

  it('a pointercancel after a moved drag sends one endDrag; a move with no button held ends the drag too', () => {
    const { dispatch } = mount();
    const edge = block('a').querySelector<HTMLElement>('.ms-subtl-edge.ms-end')!;
    const ends = () => dispatch.mock.calls.filter(([op]) => op.type === 'endDrag').length;
    fireEvent.pointerDown(edge, { clientX: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 330, buttons: 1, pointerId: 1 });
    fireEvent.pointerCancel(edge, { pointerId: 1 });
    fireEvent.pointerUp(edge, { clientX: 330, pointerId: 1 });
    expect(ends()).toBe(1);
    dispatch.mockClear();
    fireEvent.pointerDown(edge, { clientX: 300, button: 0, pointerId: 2 });
    fireEvent.pointerMove(edge, { clientX: 330, buttons: 1, pointerId: 2 });
    fireEvent.pointerMove(edge, { clientX: 360, buttons: 0, pointerId: 2 });
    fireEvent.pointerMove(edge, { clientX: 390, buttons: 0, pointerId: 2 });
    expect(dispatch.mock.calls.filter(([op]) => op.type === 'times')).toHaveLength(1);
    expect(ends()).toBe(1);
  });

  it('once the model let go of the drag (undo mid-drag), the rest of the gesture moves nothing', () => {
    const dispatch = vi.fn();
    const ui = (dragging: string | null) => (
      <I18nProvider locale="it">
        <CueTimeline cues={CUES} durationMs={10_000} peaks={[]} time={0} selected="a" dragging={dragging} dispatch={dispatch} onSeek={() => {}} />
      </I18nProvider>);
    const { rerender } = render(ui(null));
    const edge = block('a').querySelector<HTMLElement>('.ms-subtl-edge.ms-end')!;
    fireEvent.pointerDown(edge, { clientX: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 330, buttons: 1, pointerId: 1 });
    rerender(ui('a'));
    fireEvent.pointerMove(edge, { clientX: 340, buttons: 1, pointerId: 1 });
    rerender(ui(null));
    fireEvent.pointerMove(edge, { clientX: 360, buttons: 1, pointerId: 1 });
    fireEvent.pointerUp(edge, { clientX: 360, pointerId: 1 });
    expect(dispatch.mock.calls.filter(([op]) => op.type === 'times').map(([op]) => op.end)).toEqual([3300, 3400]);
  });
});

describe('CueTimeline nudges as undo steps (final review, M2)', () => {
  /** The timeline over the editor's real model; `undo` steps it back. */
  const live = () => {
    const ref: { dispatch?: (op: EditorOp) => void; end?: number; start?: number } = {};
    function Live() {
      const [state, dispatch] = useReducer(editorReducer, undefined, () => editorReducer(initialEditorState(), { type: 'load', cues: CUES, durationMs: 10_000, lang: 'it' }));
      ref.dispatch = dispatch;
      ref.start = state.cues[0]!.start;
      ref.end = state.cues[0]!.end;
      return <CueTimeline cues={state.cues} durationMs={state.durationMs} peaks={[]} time={0} selected="a" dragging={state.dragging} dispatch={dispatch} onSeek={() => {}} />;
    }
    render(<I18nProvider locale="it"><Live /></I18nProvider>);
    const undo = () => act(() => { ref.dispatch!({ type: 'undo' }); });
    return { ref, undo, end: () => screen.getByRole('slider', { name: 'Fine della riga 1' }), start: () => screen.getByRole('slider', { name: 'Inizio della riga 1' }) };
  };
  const press = (el: HTMLElement, key: string) => { fireEvent.keyDown(el, { key }); fireEvent.keyUp(el, { key }); };

  it('consecutive nudges of one edge are one undo step', () => {
    const { ref, undo, end } = live();
    press(end(), 'ArrowRight');
    press(end(), 'ArrowRight');
    press(end(), 'ArrowRight');
    expect(ref.end).toBe(3300);
    undo();
    expect(ref.end).toBe(3000);
  });

  it('another edge, a blur or a pause after the key goes up starts a new step', () => {
    vi.useFakeTimers();
    try {
      const { ref, undo, end, start } = live();
      press(end(), 'ArrowRight');
      press(start(), 'ArrowLeft');
      undo();
      expect([ref.start, ref.end]).toEqual([1000, 3100]);
      press(end(), 'ArrowRight');
      fireEvent.blur(end());
      press(end(), 'ArrowRight');
      undo();
      expect(ref.end).toBe(3200);
      press(end(), 'ArrowRight');
      act(() => { vi.advanceTimersByTime(NUDGE_PAUSE_MS); });
      press(end(), 'ArrowRight');
      undo();
      expect(ref.end).toBe(3300);
    } finally { vi.useRealTimers(); }
  });
});
