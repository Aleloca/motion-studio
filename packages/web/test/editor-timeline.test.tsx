import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_FORMATS, type Composition, type EditorCompositionView } from '@motion-studio/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import spikeJson from '../../shared/test/fixtures/spike-composition.json';

// jsdom has no PointerEvent: a MouseEvent carries the coordinates, button and modifiers the timeline reads.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  }
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventPolyfill, configurable: true });
}
// No layout in jsdom: the scroller is 768 px wide, 168 of them the lane headers, so the composition fits 600 px (100 px per second at zoom 1).
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.classList?.contains('ms-tl-scroll') ? 768 : 0; } });

const REEL = 'instagram-reel-9x16';
const spike = spikeJson as unknown as Composition;

const api = vi.hoisted(() => ({
  getStoryboard: vi.fn(async (..._a: unknown[]) => ({
    format: 'instagram-reel-9x16', hash: 'h', width: 320, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    frames: [{ t: 0.5, kind: 'scene', scene: 'intro', width: 90, height: 160, url: 'https://sb.example/intro.jpg' }],
  })),
}));
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));

const { EditorContext } = await import('../src/screens/editor/editorContext.ts');
const { __resetDrafts, draftKey, peekDraft, useDraft } = await import('../src/screens/editor/draftStore.ts');
const { Timeline, SCRUB_RESEND_MS } = await import('../src/screens/editor/Timeline.tsx');
const { useEditorKeys } = await import('../src/screens/editor/useEditorKeys.ts');
const { I18nProvider } = await import('../src/i18n.tsx');
const { createClock } = await import('../src/ui/clock.ts');
type EditorState = import('../src/screens/editor/editorContext.ts').EditorState;

const KEY = draftKey('acme', 'lancio', REEL);
const preset = DEFAULT_FORMATS.find((p) => p.id === REEL)!;

let clock = createClock();
const controls = { pause: vi.fn(), seek: vi.fn(), toggle: vi.fn(), step: vi.fn() };
let snapState = false;
let selectSpy = vi.fn();
let playing = false;

function view(c: Composition): EditorCompositionView {
  return { n: 1, format: REEL, primaryFormat: REEL, hash: 'h'.repeat(64), composition: structuredClone(c), files: [], fonts: [] };
}

function Harness({ children, comp = spike }: { children: ReactNode; comp?: Composition }) {
  const [draft, actions] = useDraft(KEY);
  const [selection, setSelection] = useState<string | null>(null);
  const [snap, setSnap] = useState(snapState);
  useEffect(() => { actions.open(view(comp), preset); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!draft) return null;
  const ctx = {
    slug: 'acme', creative: 'lancio', format: REEL, primary: REEL, draft, actions, player: null, selection,
    select: (id: string | null) => { selectSpy(id); setSelection(id); },
    snap, setSnap, token: 't', stageAsset: async () => null, staging: false,
    controls: { clock, playing, ready: true, duration: 6, ...controls },
  } as unknown as EditorState;
  return (
    <I18nProvider locale="en">
      <EditorContext.Provider value={ctx}>{children}</EditorContext.Provider>
    </I18nProvider>
  );
}

beforeEach(() => {
  __resetDrafts();
  clock = createClock();
  snapState = false;
  playing = false;
  selectSpy = vi.fn();
  for (const f of Object.values(controls)) f.mockClear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const tl = (props: Partial<Parameters<typeof Timeline>[0]> = {}) => <Timeline loop={false} onLoop={() => {}} speed="1" onSpeed={() => {}} {...props} />;
async function mount(opts: { comp?: Composition; props?: Partial<Parameters<typeof Timeline>[0]> } = {}) {
  const r = render(<Harness comp={opts.comp}>{tl(opts.props)}</Harness>);
  await waitFor(() => expect(peekDraft(KEY)).not.toBeNull());
  return r;
}
const comp = () => peekDraft(KEY)!.composition;
const clipData = (id: string) => comp().tracks.flatMap((t) => t.clips).find((k) => k.id === id)!;
const bar = (id: string) => document.querySelector<HTMLElement>(`[data-clip="${id}"]`)!;
const edge = (id: string, which: 'start' | 'end') => bar(id).querySelector<HTMLElement>(`[data-edge="${which}"]`)!;
const ops = () => peekDraft(KEY)!.ops;

/** A pointer gesture: down on `el` at x, move to each of `to`, up at the last (the same modifiers throughout). */
function drag(el: Element, x: number, to: number[], extra: object = {}) {
  fireEvent.pointerDown(el, { clientX: x, pointerId: 1, button: 0, ...extra });
  for (const p of to) fireEvent.pointerMove(window, { clientX: p, pointerId: 1, ...extra });
  fireEvent.pointerUp(window, { clientX: to.at(-1)!, pointerId: 1, ...extra });
}
const near = (n: number) => expect.closeTo(n, 5);

describe('lanes', () => {
  it('list the tracks top-down in stacking order (the last track on top), each with a kind icon and a name', async () => {
    await mount();
    const heads = [...document.querySelectorAll('[data-track-head]')].map((h) => h.getAttribute('data-track-head'));
    expect(heads).toEqual([...spike.tracks].reverse().map((t) => t.id));
    expect(within(document.querySelector('[data-track-head="audio"]') as HTMLElement).getByRole('button', { name: 'Mute Audio 1' })).toBeTruthy();
    // Mute only on audio tracks.
    expect(within(document.querySelector('[data-track-head="text"]') as HTMLElement).queryByRole('button', { name: /^Mute/ })).toBeNull();
  });

  it('draw the clips where they are, named by clip, kind and times, and the scenes lane with the storyboard thumbnails', async () => {
    await mount();
    expect(bar('title').style.left).toBe('20px');
    expect(bar('title').style.width).toBe('180px');
    expect(bar('title').getAttribute('aria-label')).toBe('title, text, from 00:00.20 to 00:02.00');
    await waitFor(() => expect(document.querySelector('.ms-tl-scene img')?.getAttribute('src')).toBe('https://sb.example/intro.jpg'));
    expect(document.querySelectorAll('.ms-tl-scene')).toHaveLength(3);
    fireEvent.click(document.querySelector('[data-scene="photo"]')!);
    expect(controls.seek).toHaveBeenCalledWith(2);
  });

  it('hide, lock and mute produce the right trackFlags ops, and show the state in the label', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Hide Visual 1' }));
    expect(ops().at(-1)).toEqual({ kind: 'trackFlags', trackId: 'visual', hidden: true });
    expect(comp().tracks.find((t) => t.id === 'visual')!.hidden).toBe(true);
    expect(screen.getByRole('button', { name: 'Show Visual 1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lock Text 1' }));
    expect(ops().at(-1)).toEqual({ kind: 'trackFlags', trackId: 'text', locked: true });
    expect(screen.getByRole('button', { name: 'Unlock Text 1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mute Audio 1' }));
    expect(ops().at(-1)).toEqual({ kind: 'trackFlags', trackId: 'audio', muted: true });
    fireEvent.click(screen.getByRole('button', { name: 'Unmute Audio 1' }));
    expect(comp().tracks.find((t) => t.id === 'audio')!.muted).toBeUndefined();
    // Unlocking works on a locked track (the flag ops are the one exception).
    fireEvent.click(screen.getByRole('button', { name: 'Unlock Text 1' }));
    expect(comp().tracks.find((t) => t.id === 'text')!.locked).toBeUndefined();
  });
});

describe('selecting', () => {
  it('a click selects the clip and is no edit', async () => {
    await mount();
    fireEvent.pointerDown(bar('card'), { clientX: 50, button: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 50, pointerId: 1 });
    expect(selectSpy).toHaveBeenCalledWith('card');
    expect(ops()).toHaveLength(0);
    expect(bar('card').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('trimming', () => {
  it('drags the end edge, one drag one undo step, by the pointer delta at the current zoom', async () => {
    await mount();
    drag(edge('title', 'end'), 200, [190, 170, 150]);
    expect(clipData('title')).toMatchObject({ start: 0.2, duration: near(1.3) });
    expect(ops()).toHaveLength(1);
    expect(peekDraft(KEY)!.past).toHaveLength(1);
  });

  it('drags the start edge: the end stays', async () => {
    await mount();
    drag(edge('subtitle', 'start'), 60, [80, 100]);
    expect(clipData('subtitle')).toMatchObject({ start: near(1.0), duration: near(1.0) });
  });

  it('clamps at the scene and at the composition bounds', async () => {
    await mount();
    // The end edge dragged far to the right stays at the scene end (2 s): no change.
    drag(edge('title', 'end'), 200, [900]);
    expect(clipData('title')).toMatchObject({ start: 0.2, duration: 1.8 });
    // The start edge dragged far to the left stops at the scene start.
    drag(edge('caption', 'start'), 230, [-900]);
    expect(clipData('caption')).toMatchObject({ start: 2, duration: near(2) });
    // A clip with no scene is bounded by the composition: its end cannot pass 6 s, and the start edge cannot cross the end.
    drag(edge('bgv', 'end'), 600, [1500]);
    expect(clipData('bgv')).toMatchObject({ start: 0, duration: 6 });
    drag(edge('bgv', 'start'), 0, [5000]);
    const bgv = clipData('bgv');
    expect(bgv.start + bgv.duration).toBeCloseTo(6, 5);
    expect(bgv.duration).toBeGreaterThan(0.03);
    expect(bgv.duration).toBeLessThan(0.04);
  });

  it('with the ripple toggle on, growing past the scene end pushes the later scenes; with it off it is clamped', async () => {
    await mount();
    drag(edge('photo1', 'end'), 400, [500]);
    expect(clipData('photo1').duration).toBe(2);
    expect(comp().duration).toBe(6);
    const toggle = screen.getByRole('button', { name: /^Ripple/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    drag(edge('photo1', 'end'), 400, [500]);
    expect(ops().at(-1)).toMatchObject({ kind: 'clipTiming', clipId: 'photo1', ripple: true });
    expect(clipData('photo1').duration).toBeCloseTo(3, 5);
    const scenes = comp().scenes;
    expect(scenes.find((s) => s.id === 'photo')!.duration).toBeCloseTo(3, 5);
    expect(scenes.find((s) => s.id === 'outro')!.start).toBeCloseTo(5, 5);
    expect(comp().duration).toBeCloseTo(7, 5);
    expect(clipData('outro-html').start).toBeCloseTo(5, 5);
  });
});

describe('moving and snapping', () => {
  it('moves the body keeping the duration, inside the scene', async () => {
    await mount();
    drag(bar('subtitle'), 100, [90, 70]);
    expect(clipData('subtitle')).toMatchObject({ start: near(0.3), duration: near(1.4) });
    drag(bar('subtitle'), 100, [900]);
    const s = clipData('subtitle');
    expect(s.start + s.duration).toBeCloseTo(2, 5);
    expect(s.duration).toBeCloseTo(1.4, 5);
  });

  it('snaps to another clip edge within 8 px, not outside, and Alt disables it', async () => {
    snapState = true;
    await mount();
    // vo is 0.5..4.5 with no scene; subtitle starts at 0.6. 7 px right is 0.57: 3 px from 0.6, so it snaps.
    drag(bar('vo'), 100, [107]);
    expect(clipData('vo')).toMatchObject({ start: near(0.6), duration: near(4) });
    // 20 px right of that (0.8): 20 px from 0.6, outside the threshold.
    drag(bar('vo'), 100, [120]);
    expect(clipData('vo').start).toBeCloseTo(0.8, 5);
    // Alt: 3 px from 0.6 would snap, it does not.
    drag(bar('vo'), 100, [77], { altKey: true });
    expect(clipData('vo').start).toBeCloseTo(0.57, 5);
    // Without Alt the same gesture snaps.
    drag(bar('vo'), 100, [103]);
    expect(clipData('vo').start).toBeCloseTo(0.6, 5);
  });

  it('snaps to a scene boundary', async () => {
    snapState = true;
    await mount();
    // caption 2.3..4.0 in scene photo (2..4): 27 px left is 2.03, 3 px from the scene start (and 12 px from the whoosh edge at 2.15).
    drag(bar('caption'), 300, [273]);
    expect(clipData('caption')).toMatchObject({ start: 2, duration: near(1.7) });
  });

  it('with the magnet off nothing snaps', async () => {
    await mount();
    drag(bar('caption'), 300, [273]);
    expect(clipData('caption').start).toBeCloseTo(2.03, 5);
  });

  it('snapping follows the zoom: 8 px are fewer seconds when zoomed in', async () => {
    snapState = true;
    await mount();
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Zoom' }), { key: 'End' });
    expect(document.querySelector('.ms-tl-scroll')!.getAttribute('data-zoom')).toBe('20');
    // 2000 px/s. subtitle (0.6..2.0): 10 px to the left is 5 ms, but no target is within 8 px (4 ms) of either edge except none:
    // its end 1.995 is 5 ms (10 px) from the scene end at 2.0, outside the threshold at this zoom.
    drag(bar('subtitle'), 1200, [1190]);
    expect(clipData('subtitle').start).toBeCloseTo(0.595, 5);
    // 6 px (3 ms) from the scene end is within it: the end snaps to 2.0.
    drag(bar('subtitle'), 1200, [1206]);
    expect(clipData('subtitle').start + clipData('subtitle').duration).toBeCloseTo(2, 5);
  });

  it('refuses to move a clip on a locked track, with the translated reason and no edit', async () => {
    const c = structuredClone(spike);
    c.tracks.find((t) => t.id === 'visual')!.locked = true;
    await mount({ comp: c });
    drag(bar('card'), 100, [150]);
    expect(clipData('card').start).toBe(0);
    expect(ops()).toHaveLength(0);
    expect(screen.getByRole('alert').textContent?.length).toBeGreaterThan(5);
    expect(bar('card').getAttribute('aria-label')).toContain('locked');
    drag(edge('card', 'end'), 200, [150]);
    expect(ops()).toHaveLength(0);
  });
});

describe('keyboard on a focused clip', () => {
  const key = (el: Element, k: string, extra: object = {}) => fireEvent.keyDown(el, { key: k, ...extra });

  it('←/→ move by one frame, Shift by one second, and the key is consumed', async () => {
    await mount();
    expect(key(bar('vo'), 'ArrowRight')).toBe(false);
    expect(clipData('vo').start).toBeCloseTo(0.5 + 1 / 30, 5);
    key(bar('vo'), 'ArrowLeft');
    key(bar('vo'), 'ArrowLeft');
    expect(clipData('vo').start).toBeCloseTo(0.5 - 1 / 30, 5);
    key(bar('vo'), 'ArrowRight', { shiftKey: true });
    expect(clipData('vo').start).toBeCloseTo(0.5 - 1 / 30 + 1, 5);
    // title 0.2..2.0 in an intro of 2 s: one second to the right does not fit, it stops at the end of the scene.
    key(bar('title'), 'ArrowRight', { shiftKey: true });
    expect(clipData('title').start).toBeCloseTo(0.2, 5);
    key(bar('caption'), 'ArrowLeft', { shiftKey: true });
    expect(clipData('caption').start).toBe(2);
  });

  it('[ and ] trim the start and the end to the playhead', async () => {
    await mount();
    act(() => { clock.set(1.0, true); });
    key(bar('title'), '[');
    expect(clipData('title')).toMatchObject({ start: 1, duration: near(1) });
    act(() => { clock.set(1.5, true); });
    key(bar('title'), ']');
    expect(clipData('title')).toMatchObject({ start: 1, duration: near(0.5) });
    // A playhead outside the scene clamps.
    act(() => { clock.set(5, true); });
    key(bar('title'), ']');
    expect(clipData('title').start + clipData('title').duration).toBeCloseTo(2, 5);
  });

  it('Enter and Space select', async () => {
    await mount();
    key(bar('card'), 'Enter');
    expect(selectSpy).toHaveBeenCalledWith('card');
    key(bar('title'), ' ');
    expect(selectSpy).toHaveBeenLastCalledWith('title');
  });

  it('a locked clip refuses the keys with its reason', async () => {
    const c = structuredClone(spike);
    c.tracks.find((t) => t.id === 'text')!.locked = true;
    await mount({ comp: c });
    key(bar('title'), 'ArrowRight');
    expect(ops()).toHaveLength(0);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('with a clip focused ←/→ do not also step the frame; elsewhere the editor map steps', async () => {
    const step = vi.fn();
    function Keys() {
      const root = useRef<HTMLDivElement>(null);
      useEditorKeys(root, true, { undo: vi.fn(), redo: vi.fn(), toggle: vi.fn(), step, deselect: vi.fn(), remove: vi.fn() });
      return <div ref={root}>{tl()}</div>;
    }
    render(<Harness><Keys /></Harness>);
    await waitFor(() => expect(peekDraft(KEY)).not.toBeNull());
    fireEvent.keyDown(bar('card'), { key: 'ArrowRight' });
    expect(step).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(step).toHaveBeenCalledWith(1);
  });
});

describe('transport and zoom', () => {
  it('keeps play, the timecode and the frame step', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Play (Space)' }));
    expect(controls.toggle).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Next frame/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Previous frame/ }));
    expect(controls.step.mock.calls).toEqual([[1], [-1]]);
    expect(document.querySelector('.ms-fv-tc')!.textContent).toBe('00:00.00 / 00:06.00');
    act(() => { clock.set(1.5, true); });
    expect(document.querySelector('.ms-fv-tc')!.textContent).toBe('00:01.50 / 00:06.00');
  });

  it('zooms between 1× and 20× with the slider and widens the lanes; ⌘+wheel zooms at the pointer and stops the page zoom', async () => {
    await mount();
    const scroller = document.querySelector<HTMLElement>('.ms-tl-scroll')!;
    expect(bar('title').style.left).toBe('20px');
    const slider = screen.getByRole('slider', { name: 'Zoom' });
    expect(slider.getAttribute('aria-valuetext')).toBe('1×');
    fireEvent.keyDown(slider, { key: 'End' });
    expect(slider.getAttribute('aria-valuetext')).toBe('20×');
    expect(bar('title').style.left).toBe('400px');
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(scroller.dataset.zoom).toBe('1');
    // Plain wheel does not zoom; ⌘+wheel does and is consumed.
    fireEvent.wheel(scroller, { deltaY: -200, clientX: 300 });
    expect(scroller.dataset.zoom).toBe('1');
    expect(fireEvent.wheel(scroller, { deltaY: -400, metaKey: true, clientX: 300 })).toBe(false);
    expect(Number(scroller.dataset.zoom)).toBeGreaterThan(1.5);
    for (let i = 0; i < 30; i += 1) fireEvent.wheel(scroller, { deltaY: -400, ctrlKey: true, clientX: 300 });
    expect(scroller.dataset.zoom).toBe('20');
  });

  it('shows frame ticks only when zoomed in', async () => {
    await mount();
    expect(document.querySelectorAll('.ms-tl-tick.ms-f')).toHaveLength(0);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Zoom' }), { key: 'End' });
    expect(document.querySelectorAll('.ms-tl-tick.ms-f').length).toBeGreaterThan(0);
  });

  it('shows the pins as markers on the ruler and a marker seeks', async () => {
    const pin = { format: REEL, timeSec: 2.5, x: 0.5, y: 0.5, note: 'logo bigger' } as never;
    await mount({ props: { marks: [{ pin, number: 1 }] } });
    const mark = screen.getByRole('button', { name: 'Comment 1 at 00:02.50' });
    expect(mark.style.left).toBe('250px');
    fireEvent.click(mark);
    expect(controls.seek).toHaveBeenCalledWith(2.5);
  });

  it('draws the overlay hook (range comments, Task 10) in the time area', async () => {
    await mount({ props: { overlay: ({ pps }) => <span data-testid="range" style={{ left: 2 * pps }} /> } });
    expect(screen.getByTestId('range').style.left).toBe('200px');
  });
});

describe('scrubbing the ruler', () => {
  const ruler = () => screen.getByRole('slider', { name: /^Timeline ruler/ });
  function stubRect(el: HTMLElement) {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 600, bottom: 26, width: 600, height: 26, x: 0, y: 0, toJSON() {} });
  }

  it('seeks to the pointer, coalesced per frame, and ALWAYS sends the last position when the scrub ends', async () => {
    await mount();
    stubRect(ruler());
    fireEvent.pointerDown(ruler(), { clientX: 100, pointerId: 1, button: 0 });
    expect(controls.seek.mock.calls).toEqual([[1]]);
    // Many moves before the next animation frame: none of them is sent on its own.
    for (const x of [120, 160, 220, 260, 300, 331]) fireEvent.pointerMove(window, { clientX: x, pointerId: 1 });
    expect(controls.seek).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(window, { clientX: 340, pointerId: 1 });
    expect(controls.seek.mock.lastCall).toEqual([3.4]);
    expect(controls.seek).toHaveBeenCalledTimes(2);
    // And once more shortly after, in case the runtime dropped the first.
    await waitFor(() => expect(controls.seek).toHaveBeenCalledTimes(3), { timeout: SCRUB_RESEND_MS * 10 });
    expect(controls.seek.mock.lastCall).toEqual([3.4]);
  });

  it('sends the final position even when it equals the one already sent', async () => {
    await mount();
    stubRect(ruler());
    fireEvent.pointerDown(ruler(), { clientX: 200, pointerId: 1, button: 0 });
    fireEvent.pointerUp(window, { clientX: 200, pointerId: 1 });
    expect(controls.seek.mock.calls.slice(0, 2)).toEqual([[2], [2]]);
  });

  it('coalesces the moves of a frame into one seek (the frame callback sends the latest)', async () => {
    await mount();
    stubRect(ruler());
    fireEvent.pointerDown(ruler(), { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(window, { clientX: 150, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 250, pointerId: 1 });
    await waitFor(() => expect(controls.seek).toHaveBeenCalledTimes(2));
    expect(controls.seek.mock.lastCall).toEqual([2.5]);
    fireEvent.pointerUp(window, { clientX: 250, pointerId: 1 });
  });

  it('pauses a playing player while scrubbing and resumes it afterwards', async () => {
    playing = true;
    await mount();
    stubRect(ruler());
    fireEvent.pointerDown(ruler(), { clientX: 100, pointerId: 1, button: 0 });
    expect(controls.pause).toHaveBeenCalled();
    fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    expect(controls.toggle).toHaveBeenCalledTimes(1);
  });
});
