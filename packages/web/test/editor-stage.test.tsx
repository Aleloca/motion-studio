import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_FORMATS, type Composition, type EditorCompositionView } from '@motion-studio/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import spikeJson from '../../shared/test/fixtures/spike-composition.json';

// jsdom has no PointerEvent: a MouseEvent carries the coordinates, button and modifiers the handles read.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  }
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventPolyfill, configurable: true });
}

const REEL = 'instagram-reel-9x16';
const spike = spikeJson as unknown as Composition;
const at = '2026-10-13T10:00:00.000Z';

const api = vi.hoisted(() => ({
  getStoryboard: vi.fn(async (..._a: unknown[]) => ({
    format: 'instagram-reel-9x16', hash: 'h', width: 320, expiresAt: '2099-01-01T00:00:00.000Z',
    frames: [
      { t: 0.5, kind: 'scene', scene: 'intro', width: 90, height: 160, url: 'https://sb.example/intro.jpg' },
      { t: 2.5, kind: 'scene', scene: 'photo', width: 90, height: 160, url: 'https://sb.example/photo.jpg' },
    ],
  })),
}));
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));

const { EditorContext } = await import('../src/screens/editor/editorContext.ts');
const { __resetDrafts, draftKey, peekDraft, useDraft } = await import('../src/screens/editor/draftStore.ts');
const { Stage } = await import('../src/screens/editor/Stage.tsx');
const { ScenesColumn } = await import('../src/screens/editor/ScenesColumn.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { createClock } = await import('../src/ui/clock.ts');
type EditorState = import('../src/screens/editor/editorContext.ts').EditorState;

const KEY = draftKey('acme', 'lancio', REEL);
const preset = DEFAULT_FORMATS.find((p) => p.id === REEL)!;

/** The runtime's side of the player: what the editor sends and the bounds it gets back. */
function fakePlayer() {
  const events = new EventTarget();
  const m = {
    clipBounds: null as null | { clipId: string | null; bounds: { x: number; y: number; width: number; height: number } | null; scale: number },
    select: vi.fn((_id: string | null) => {}),
    addEventListener: (t: string, l: EventListener) => events.addEventListener(t, l),
    removeEventListener: (t: string, l: EventListener) => events.removeEventListener(t, l),
    report(clipId: string | null, bounds: { x: number; y: number; width: number; height: number } | null, scale: number) {
      m.clipBounds = { clipId, bounds, scale };
      act(() => { events.dispatchEvent(new Event('clipbounds')); });
    },
  };
  return m;
}

let player = fakePlayer();
let clock = createClock();
const controls = { pause: vi.fn(), seek: vi.fn(), toggle: vi.fn(), step: vi.fn() };
let snapState = true;
let selectSpy = vi.fn();

function view(c: Composition): EditorCompositionView {
  return { n: 1, format: REEL, primaryFormat: REEL, hash: 'h'.repeat(64), composition: structuredClone(c), files: [], fonts: [] };
}

function Harness({ children, comp = spike, initial = 'card' }: { children: ReactNode; comp?: Composition; initial?: string | null }) {
  const [draft, actions] = useDraft(KEY);
  const [selection, setSelection] = useState<string | null>(initial);
  const [snap, setSnap] = useState(snapState);
  useEffect(() => { actions.open(view(comp), preset); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!draft) return null;
  const ctx = {
    slug: 'acme', creative: 'lancio', format: REEL, primary: REEL, draft, actions, player, selection,
    select: (id: string | null) => { selectSpy(id); setSelection(id); },
    snap, setSnap, token: 't', stageAsset: async () => null, staging: false,
    controls: { clock, playing: false, ready: true, duration: 6, ...controls },
  } as unknown as EditorState;
  return (
    <I18nProvider locale="en">
      <EditorContext.Provider value={ctx}>{children}</EditorContext.Provider>
    </I18nProvider>
  );
}

beforeEach(() => {
  __resetDrafts();
  player = fakePlayer();
  clock = createClock();
  snapState = false;
  selectSpy = vi.fn();
  controls.pause.mockClear(); controls.seek.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); });

const clip = (id: string) => peekDraft(KEY)!.composition.tracks.flatMap((t) => t.clips).find((k) => k.id === id) as unknown as { props: Record<string, number> };
const stagePoint = (el: Element, x: number, y: number, extra: object = {}) => ({ clientX: x, clientY: y, pointerId: 1, button: 0, ...extra, target: el });

// The card clip: x 90, y 500, 900 x 700. At stage scale 0.5 its box is 450 x 350 at (45, 250); the frame is at client (0, 0).
const CARD_BOUNDS = { x: 45, y: 250, width: 450, height: 350 };
async function mountStage(opts: { comp?: Composition; scale?: number; bounds?: typeof CARD_BOUNDS; id?: string } = {}) {
  const r = render(<Harness comp={opts.comp} initial={opts.id ?? 'card'}><Stage /></Harness>);
  await waitFor(() => expect(peekDraft(KEY)).not.toBeNull());
  player.report(opts.id ?? 'card', opts.bounds ?? CARD_BOUNDS, opts.scale ?? 0.5);
  return r;
}
const box = () => document.querySelector<HTMLElement>('.ms-stage-box')!;
const drag = (el: Element, from: [number, number], to: [number, number], extra: object = {}) => {
  fireEvent.pointerDown(el, stagePoint(el, ...from));
  fireEvent.pointerMove(window, { clientX: to[0], clientY: to[1], pointerId: 1, ...extra });
  fireEvent.pointerUp(window, { clientX: to[0], clientY: to[1], pointerId: 1, ...extra });
};

describe('stage handles', () => {
  it('draw the box where the runtime reports the clip, and follow when it moves', async () => {
    await mountStage();
    expect(player.select).toHaveBeenCalledWith('card');
    expect(box().style.width).toBe('450px');
    expect(box().style.height).toBe('350px');
    expect(box().style.transform).toBe('translate(45px, 250px) rotate(0deg)');
    expect([...box().querySelectorAll('[data-handle]')].map((b) => b.getAttribute('data-handle')).sort()).toEqual(['ne', 'nw', 'rotate', 'se', 'sw']);
    // Not focusable controls: hidden from assistive tech, not buttons; the box is named by the clip's name.
    expect(within(box()).queryAllByRole('button')).toHaveLength(0);
    expect([...box().querySelectorAll('[data-handle]')].every((b) => b.getAttribute('aria-hidden') === 'true' && !b.hasAttribute('role'))).toBe(true);
    expect(box().getAttribute('aria-label')).toBe('Selected: card');
    player.report('card', { x: 100, y: 120, width: 450, height: 350 }, 0.5);
    expect(box().style.transform).toBe('translate(100px, 120px) rotate(0deg)');
    // The label is in composition pixels.
    expect(screen.getByRole('status').textContent).toBe('90 · 500 · 900 × 700');
  });

  it('draw the rotated, scaled box from the clip props around the reported centre', async () => {
    const c = structuredClone(spike);
    Object.assign(c.tracks.find((t) => t.id === 'visual')!.clips.find((k) => k.id === 'card')!, {});
    const card = c.tracks.find((t) => t.id === 'visual')!.clips.find((k) => k.id === 'card') as unknown as { props: Record<string, number> };
    card.props.rotation = 90; card.props.scale = 1.5;
    await mountStage({ comp: c, bounds: { x: 0, y: 0, width: 525, height: 675 }, scale: 0.5 });
    expect(box().style.width).toBe('675px');
    expect(box().style.height).toBe('525px');
    expect(box().style.transform).toBe('translate(-75px, 75px) rotate(90deg)');
  });

  it('show nothing without a selection or while the clip is not visible, and clicking the empty stage deselects', async () => {
    render(<Harness initial={null}><Stage /></Harness>);
    await waitFor(() => expect(peekDraft(KEY)).not.toBeNull());
    expect(document.querySelector('.ms-stage-box')).toBeNull();
    cleanupAll();
    await mountStage();
    player.report('card', null, 0.5);
    expect(document.querySelector('.ms-stage-box')).toBeNull();
    player.report('card', CARD_BOUNDS, 0.5);
    expect(document.querySelector('.ms-stage-box')).not.toBeNull();
    fireEvent.pointerDown(document.querySelector('.ms-stage-layer')!, { button: 0 });
    expect(selectSpy).toHaveBeenCalledWith(null);
    expect(player.select).toHaveBeenLastCalledWith(null);
  });

  it('move: one drag is one undo step, by the pointer delta in composition pixels, with the playhead paused', async () => {
    await mountStage();
    const el = box();
    fireEvent.pointerDown(el, stagePoint(el, 200, 300));
    fireEvent.pointerMove(window, { clientX: 210, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 230, clientY: 310, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 250, clientY: 330, pointerId: 1 });
    expect(controls.pause).toHaveBeenCalled();
    // 50 and 30 stage pixels at scale 0.5 are 100 and 60 composition pixels.
    expect(clip('card').props.x).toBe(190);
    expect(clip('card').props.y).toBe(560);
    const d = peekDraft(KEY)!;
    expect(d.ops).toHaveLength(1);
    expect(d.past).toHaveLength(1);
    // The box does not jump back while the runtime's bounds trail behind.
    expect(box().style.transform).toBe('translate(95px, 280px) rotate(0deg)');
    act(() => { /* a re-render */ });
    player.report('card', { x: 95, y: 280, width: 450, height: 350 }, 0.5);
    expect(box().style.transform).toBe('translate(95px, 280px) rotate(0deg)');
  });

  it('a click without movement is not an edit', async () => {
    await mountStage();
    const el = box();
    fireEvent.pointerDown(el, stagePoint(el, 200, 300));
    fireEvent.pointerUp(window, { clientX: 200, clientY: 300, pointerId: 1 });
    expect(peekDraft(KEY)!.ops).toHaveLength(0);
  });

  it('resize from a corner keeps the opposite corner; Shift keeps the aspect', async () => {
    await mountStage();
    drag(within(box()).getByLabelText('Resize from the bottom right corner'), [495, 600], [545, 650]);
    expect(clip('card').props).toMatchObject({ x: 90, y: 500, width: 1000, height: 800 });
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
    // Shift: the ratio of the box as it is now (1000 x 800) stays.
    player.report('card', { x: 45, y: 250, width: 500, height: 400 }, 0.5);
    drag(within(box()).getByLabelText('Resize from the bottom right corner'), [545, 650], [595, 660], { shiftKey: true });
    const p = clip('card').props;
    expect(p.width! / p.height!).toBeCloseTo(1000 / 800, 2);
    expect(p).toMatchObject({ x: 90, y: 500 });
    expect(p.width).toBeGreaterThan(1000);
  });

  it('rotates about the box centre; Shift snaps to 15 degrees', async () => {
    await mountStage();
    // The centre is (270, 425) in the frame. From straight above to straight right: +90 degrees.
    drag(within(box()).getByLabelText('Rotate (Shift snaps to 15°)'), [270, 200], [500, 425]);
    expect(clip('card').props.rotation).toBe(90);
    expect(clip('card').props).toMatchObject({ x: 90, y: 500, width: 900, height: 700 });
    // 22 degrees past straight up, with Shift: 15.
    const a = (22 * Math.PI) / 180;
    drag(within(box()).getByLabelText('Rotate (Shift snaps to 15°)'), [270, 200], [270 + 225 * Math.sin(a), 425 - 225 * Math.cos(a)], { shiftKey: true });
    expect(clip('card').props.rotation! % 15).toBe(0);
    expect(clip('card').props.rotation).toBe(105);
  });

  it('the box label shows the clip name, not its id', async () => {
    const c = structuredClone(spike);
    (c.tracks.find((t) => t.id === 'visual')!.clips.find((k) => k.id === 'card') as { name?: string }).name = 'Main card';
    await mountStage({ comp: c });
    expect(box().getAttribute('aria-label')).toBe('Selected: Main card');
  });

  it('a click on the rotate handle is not an edit, with Shift or a base rotation beyond 180', async () => {
    const c = structuredClone(spike);
    (c.tracks.find((t) => t.id === 'visual')!.clips.find((k) => k.id === 'card') as unknown as { props: Record<string, number> }).props.rotation = 270;
    await mountStage({ comp: c, bounds: { x: 95, y: 200, width: 350, height: 450 } });
    const rot = within(box()).getByLabelText('Rotate (Shift snaps to 15°)');
    fireEvent.pointerDown(rot, stagePoint(rot, 270, 200));
    fireEvent.pointerUp(window, { clientX: 270, clientY: 200, pointerId: 1, shiftKey: true });
    fireEvent.pointerDown(rot, stagePoint(rot, 270, 200));
    fireEvent.pointerUp(window, { clientX: 270, clientY: 200, pointerId: 1 });
    expect(peekDraft(KEY)!.ops).toHaveLength(0);
  });

  it('refuses to drag a locked clip: dashed handles, "Locked", no edit, no pause', async () => {
    const c = structuredClone(spike);
    (c.tracks.find((t) => t.id === 'visual')!.clips.find((k) => k.id === 'card') as { locked?: boolean }).locked = true;
    await mountStage({ comp: c });
    const el = box();
    expect(el.className).toContain('ms-locked');
    expect(el.title).toBe('Locked');
    expect(within(el).getByLabelText('Resize from the top left corner').getAttribute('title')).toBe('Locked');
    drag(el, [200, 300], [260, 330]);
    drag(within(el).getByLabelText('Resize from the bottom right corner'), [495, 600], [545, 650]);
    drag(within(el).getByLabelText('Rotate (Shift snaps to 15°)'), [270, 200], [500, 425]);
    expect(peekDraft(KEY)!.ops).toHaveLength(0);
    expect(controls.pause).not.toHaveBeenCalled();
    expect(clip('card').props.x).toBe(90);
  });

  it('a clip on a locked track is locked too', async () => {
    const c = structuredClone(spike);
    c.tracks.find((t) => t.id === 'visual')!.locked = true;
    await mountStage({ comp: c });
    drag(box(), [200, 300], [260, 330]);
    expect(box().className).toContain('ms-locked');
    expect(peekDraft(KEY)!.ops).toHaveLength(0);
  });

  it('snaps to the frame centre within 6 px, shows the guide, and not with the magnet off', async () => {
    // logo1: x 860, w 160, so its centre is 940; at scale 0.5 the box is 80 x 80 at (430, 850), centre (470, 890) on the stage.
    const bounds = { x: 430, y: 850, width: 80, height: 80 };
    snapState = true;
    await mountStage({ id: 'logo1', bounds });
    const el = box();
    // To bring the centre to 540 (composition) it must go 400 composition px = 200 stage px left; 3 px short of it.
    fireEvent.pointerDown(el, stagePoint(el, 470, 890));
    fireEvent.pointerMove(window, { clientX: 470 - 197, clientY: 890, pointerId: 1 });
    await waitFor(() => expect(document.querySelector('.ms-stage-guide.ms-gx')).not.toBeNull());
    expect((document.querySelector('.ms-stage-guide.ms-gx') as HTMLElement).style.left).toBe('270px');
    fireEvent.pointerUp(window, { clientX: 470 - 197, clientY: 890, pointerId: 1 });
    expect(clip('logo1').props.x! + 80).toBeCloseTo(540, 3);
    expect(document.querySelector('.ms-stage-guide')).toBeNull();
    // 7 px short is out of reach.
    cleanupAll();
    __resetDrafts();
    snapState = true;
    await mountStage({ id: 'logo1', bounds });
    drag(box(), [470, 890], [470 - 193, 890]);
    expect(clip('logo1').props.x).toBe(860 - 386);
    // Magnet off: no snap at 3 px either.
    cleanupAll();
    __resetDrafts();
    snapState = false;
    await mountStage({ id: 'logo1', bounds });
    drag(box(), [470, 890], [470 - 197, 890]);
    expect(clip('logo1').props.x).toBe(860 - 394);
  });

  it('snaps to the safe area of the format', async () => {
    // Reels safe zone left margin 60... use the preset's own numbers.
    const safe = (preset as unknown as { safeZone?: { left: number; top: number } }).safeZone!;
    expect(safe).toBeTruthy();
    const bounds = { x: 430, y: 850, width: 80, height: 80 };
    snapState = true;
    await mountStage({ id: 'logo1', bounds });
    // Left edge of the logo (860) to the safe left: dx composition = safe.left - 860, three stage px short.
    const need = (safe.left - 860) * 0.5;
    drag(box(), [470, 890], [470 + need + 2, 890]);
    expect(clip('logo1').props.x).toBeCloseTo(safe.left, 3);
  });

  it('ten drags with different grips add up with no drift and undo restores the original exactly', async () => {
    await mountStage();
    const original = structuredClone(peekDraft(KEY)!.composition);
    for (let i = 0; i < 10; i++) {
      player.report('card', CARD_BOUNDS, 0.5);
      const grip = i % 3 === 0 ? box() : i % 3 === 1 ? within(box()).getByLabelText('Resize from the bottom right corner') : within(box()).getByLabelText('Rotate (Shift snaps to 15°)');
      drag(grip, [270, 200], [281 + i, 205 + i]);
    }
    expect(peekDraft(KEY)!.ops).toHaveLength(10);
    // Undo is the store's: ten steps back to the exact original.
    const store = renderHook(() => useDraft(KEY));
    for (let i = 0; i < 10; i++) act(() => store.result.current[1].undo());
    expect(peekDraft(KEY)!.composition).toEqual(original);
    expect(peekDraft(KEY)!.past).toHaveLength(0);
  });

  it('ten moves of one clip, one after the other, are ten steps and ten times the delta', async () => {
    await mountStage();
    const x0 = clip('card').props.x!;
    for (let i = 0; i < 10; i++) {
      const el = box();
      drag(el, [200, 300], [213, 297]);
    }
    expect(peekDraft(KEY)!.ops).toHaveLength(10);
    expect(clip('card').props.x).toBeCloseTo(x0 + 10 * 26, 2);
    expect(clip('card').props.y).toBeCloseTo(500 - 10 * 6, 2);
  });

  it('an animated clip: the box is drawn where the runtime puts it, the drag writes the base props only', async () => {
    // The runtime draws the card 40 stage px lower (an entry animation): the base props are the same.
    await mountStage({ bounds: { ...CARD_BOUNDS, y: CARD_BOUNDS.y + 40 } });
    expect(box().style.transform).toBe('translate(45px, 290px) rotate(0deg)');
    drag(box(), [200, 300], [210, 300]);
    expect(clip('card').props).toMatchObject({ x: 110, y: 500, width: 900, height: 700 });
    // During and right after the drag the offset of the animation is kept: the box does not jump.
    expect(box().style.transform).toBe('translate(55px, 290px) rotate(0deg)');
  });
});

function cleanupAll() {
  document.body.innerHTML = '';
}

describe('scenes column', () => {
  const reorderable = (): Composition => {
    const c = structuredClone(spike);
    c.tracks = c.tracks.filter((t) => t.id !== 'bg' && t.id !== 'logo');
    return c;
  };
  const mountScenes = async (comp: Composition = spike) => {
    const r = render(<Harness comp={comp} initial={null}><ScenesColumn /></Harness>);
    await waitFor(() => expect(screen.getByRole('list', { name: 'Scenes of this composition' })).toBeTruthy());
    return r;
  };
  const names = () => within(screen.getByRole('list', { name: 'Scenes of this composition' })).getAllByRole('listitem').map((li) => li.getAttribute('data-scene'));

  it('lists a card per scene with the storyboard thumbnail, the name and the duration; a click seeks to the scene start', async () => {
    await mountScenes();
    expect(names()).toEqual(['intro', 'photo', 'outro']);
    await waitFor(() => expect(document.querySelector('img[src="https://sb.example/intro.jpg"]')).not.toBeNull());
    expect(document.querySelector('img[src="https://sb.example/photo.jpg"]')).not.toBeNull();
    const photo = document.querySelector('[data-scene="photo"]') as HTMLElement;
    expect(within(photo).getByText('2 s')).toBeTruthy();
    fireEvent.click(within(photo).getByRole('button', { name: /Foto, at/ }));
    expect(controls.seek).toHaveBeenCalledWith(2);
  });

  it('"In this scene" lists the clips overlapping the scene under the playhead; a click selects', async () => {
    await mountScenes();
    const section = screen.getByRole('region', { name: 'In this scene' });
    const inIntro = within(section).getAllByRole('button').map((b) => b.textContent);
    expect(inIntro).toEqual(expect.arrayContaining(['bgv', 'card', 'title', 'subtitle', 'logo1', 'music', 'vo']));
    expect(inIntro).not.toContain('photo1');
    expect(inIntro).not.toContain('caption');
    fireEvent.click(within(section).getByRole('button', { name: 'title' }));
    expect(selectSpy).toHaveBeenCalledWith('title');
    // The playhead moves into the second scene.
    act(() => clock.set(2.4, true));
    const next = within(screen.getByRole('region', { name: 'In this scene' })).getAllByRole('button').map((b) => b.textContent);
    expect(next).toEqual(expect.arrayContaining(['photo1', 'caption']));
    expect(next).not.toContain('card');
  });

  it('reorder is disabled, with the reason, when a clip is not inside one scene', async () => {
    await mountScenes(spike);
    const grips = screen.getAllByRole('button', { name: /^Reorder/ });
    expect(grips).toHaveLength(3);
    for (const g of grips) expect((g as HTMLButtonElement).disabled).toBe(true);
    // One sentence (live check, Task 11: the reason used to repeat "Scenes can't be reordered"), naming the clip as the editor does.
    expect(screen.getByRole('note').textContent).toBe('Scenes cannot be reordered: clip bgv is not inside a single scene');
    fireEvent.keyDown(grips[0]!, { key: 'ArrowDown' });
    expect(peekDraft(KEY)!.ops).toHaveLength(0);
  });

  it('the reason names the clip by its name when it has one', async () => {
    const named = structuredClone(spike);
    for (const t of named.tracks) for (const c of t.clips) if (c.id === 'bgv') c.name = 'Background video';
    await mountScenes(named);
    expect(screen.getByRole('note').textContent).toBe('Scenes cannot be reordered: clip Background video is not inside a single scene');
  });

  it('reorders with the keyboard and with the pointer when every clip lies in one scene', async () => {
    await mountScenes(reorderable());
    const grip = (id: string) => within(document.querySelector(`[data-scene="${id}"]`) as HTMLElement).getByRole('button', { name: /^Reorder/ }) as HTMLButtonElement;
    expect(grip('intro').disabled).toBe(false);
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.keyDown(grip('intro'), { key: 'ArrowDown' });
    expect(names()).toEqual(['photo', 'intro', 'outro']);
    expect(peekDraft(KEY)!.ops).toEqual([{ kind: 'sceneOrder', order: ['photo', 'intro', 'outro'] }]);
    expect(screen.getByRole('status', { hidden: true, name: '' })).toBeTruthy();
    // The pointer: the cards are 100 px tall; dropping the last one above the first card's middle puts it first.
    const items = [...document.querySelectorAll('.ms-sc-card')] as HTMLElement[];
    items.forEach((el, i) => { el.getBoundingClientRect = () => ({ top: i * 100, height: 100, bottom: i * 100 + 100, left: 0, right: 100, width: 100, x: 0, y: i * 100, toJSON() {} }); });
    fireEvent.pointerDown(grip('outro'), { button: 0, pointerId: 1, clientY: 250 });
    fireEvent.pointerMove(window, { clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(window, { clientY: 20, pointerId: 1 });
    expect(names()).toEqual(['outro', 'photo', 'intro']);
    expect(peekDraft(KEY)!.ops).toHaveLength(2);
    // The first scene cannot go up.
    fireEvent.keyDown(grip('outro'), { key: 'ArrowUp' });
    expect(peekDraft(KEY)!.ops).toHaveLength(2);
  });
});
