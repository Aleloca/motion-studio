// SVG inner editor, Task 4: the selected svg clip's checked SVG drawn inline over the stage, inside a shadow root, so its
// elements can be picked with a click (synced with the inspector's list) and outlined. Never for a text the core refused,
// never while playing.
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { DEFAULT_FORMATS, type Composition, type EditorCompositionView } from '@motion-studio/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom has no PointerEvent: a MouseEvent carries the coordinates and button the stage reads.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  }
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventPolyfill, configurable: true });
}

vi.mock('../src/api.ts', () => ({ api: {}, ApiError: class extends Error {} }));

const { EditorContext, useEditor } = await import('../src/screens/editor/editorContext.ts');
const { __resetDrafts, draftKey, useDraft } = await import('../src/screens/editor/draftStore.ts');
const { Stage } = await import('../src/screens/editor/Stage.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { createClock } = await import('../src/ui/clock.ts');
type EditorState = import('../src/screens/editor/editorContext.ts').EditorState;

const LOGO = 'identity-logo';
const KEY = draftKey('acme', 'marchio', LOGO);
const preset = DEFAULT_FORMATS.find((p) => p.id === LOGO)!;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>.leak { color: rgb(1, 2, 3); } rect { fill: #ff0000; }</style>'
  + '<g id="mark"><rect width="50" height="50"/><path d="M0 0L10 10" fill="#00ff00"/></g><text x="1" y="90"><tspan>Acme</tspan></text></svg>';

function fakePlayer() {
  const events = new EventTarget();
  const m = {
    clipBounds: null as null | { clipId: string | null; bounds: { x: number; y: number; width: number; height: number } | null; scale: number },
    select: vi.fn(),
    addEventListener: (t: string, l: EventListener) => events.addEventListener(t, l),
    removeEventListener: (t: string, l: EventListener) => events.removeEventListener(t, l),
    report(clipId: string, bounds: { x: number; y: number; width: number; height: number }, scale: number) {
      m.clipBounds = { clipId, bounds, scale };
      act(() => { events.dispatchEvent(new Event('clipbounds')); });
    },
  };
  return m;
}

let player = fakePlayer();
let playing = false;
let texts: Record<string, string> = {};
let picked: string | null = null;
const clock = createClock();

function comp(): Composition {
  return {
    $schema: 'motion-studio/composition@1', width: 1024, height: 1024, fps: 30, duration: 0, background: '#ffffff', fonts: [], scenes: [],
    tracks: [{ id: 't', kind: 'visual', clips: [{ id: 'logo', type: 'svg', src: 'assets/logo.svg', start: 0, duration: 0, props: { fit: 'contain' } }] }],
  } as unknown as Composition;
}
function view(c: Composition): EditorCompositionView {
  return { n: 1, format: LOGO, primaryFormat: LOGO, hash: 'h'.repeat(64), composition: structuredClone(c), files: [{ path: 'assets/logo.svg', size: 300 }], fonts: [] };
}

/** Shows the picked element and picks one from outside the stage (the inspector's list does the same). */
function Probe() {
  const { svgElement, selectSvgElement } = useEditor();
  picked = svgElement;
  return <button type="button" data-testid="pick-path" onClick={() => selectSvgElement('1')}>pick</button>;
}

function Harness({ children }: { children: ReactNode }) {
  const [draft, actions] = useDraft(KEY);
  const [selection, setSelection] = useState<string | null>('logo');
  const [svgElement, selectSvgElement] = useState<string | null>(null);
  useEffect(() => {
    actions.open(view(comp()), preset);
    for (const [path, text] of Object.entries(texts)) actions.svgText(path, text);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!draft) return null;
  const ctx = {
    slug: 'acme', creative: 'marchio', format: LOGO, primary: LOGO, draft, actions, player, selection, select: setSelection,
    snap: false, setSnap: () => {}, token: 't', stageAsset: async () => null, staging: false, readOnly: null, svgElement, selectSvgElement,
    controls: { clock, playing, ready: true, duration: 0, pause: vi.fn(), seek: vi.fn(), toggle: vi.fn(), step: vi.fn() },
  } as unknown as EditorState;
  return <I18nProvider locale="en"><EditorContext.Provider value={ctx}>{children}</EditorContext.Provider></I18nProvider>;
}

async function mount() {
  const r = render(<Harness><Stage /><Probe /></Harness>);
  await waitFor(() => expect(document.querySelector('[data-slot="stage-layer"]')).toBeTruthy());
  player.report('logo', { x: 0, y: 0, width: 200, height: 200 }, 200 / 1024);
  return r;
}
const host = () => document.querySelector<HTMLElement>('[data-slot="svg-overlay"]');
const drawn = () => host()!.shadowRoot!.querySelector('svg')!;

beforeEach(() => {
  __resetDrafts();
  player = fakePlayer();
  playing = false;
  picked = null;
  texts = { 'assets/logo.svg': SVG };
});
afterEach(() => { cleanup(); });

describe('the SVG overlay on the stage', () => {
  it('draws the checked SVG inside a shadow root over the clip, never in the page itself', async () => {
    await mount();
    await waitFor(() => expect(host()).toBeTruthy());
    expect(host()!.shadowRoot).toBeTruthy();
    expect(drawn().getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    expect(drawn().querySelector('rect')).toBeTruthy();
    expect(document.querySelector('[data-slot="stage-layer"] rect')).toBeNull();
    expect(document.querySelector<HTMLElement>('[data-slot="svg-overlay-box"]')!.style.width).toBe('200px');
  });

  it('keeps the SVG <style> inside the shadow root: it does not style the page', async () => {
    const outside = document.createElement('p');
    outside.className = 'leak';
    document.body.append(outside);
    try {
      await mount();
      await waitFor(() => expect(host()).toBeTruthy());
      expect(host()!.shadowRoot!.innerHTML).toContain('.leak');
      for (const s of document.querySelectorAll('style')) expect(s.textContent ?? '').not.toContain('.leak');
      expect(getComputedStyle(outside).color).not.toBe('rgb(1, 2, 3)');
    } finally {
      outside.remove();
    }
  });

  it('a <style> with a shadow-tree selector is not drawn (the core refuses it too)', async () => {
    texts = { 'assets/logo.svg': SVG.replace('<style>', '<style>:host { position: fixed !important; } ') };
    await mount();
    await waitFor(() => expect(host()).toBeTruthy());
    expect(host()!.shadowRoot!.innerHTML).not.toContain(':host { position');
    expect(drawn().querySelector('style')).toBeNull();
    expect(drawn().querySelector('rect')).toBeTruthy();
  });

  it('a click on a shape picks its element; a click on a tspan picks its text', async () => {
    await mount();
    await waitFor(() => expect(host()).toBeTruthy());
    const root = host()!.shadowRoot! as ShadowRoot & { elementsFromPoint?: (x: number, y: number) => Element[] };
    const box = document.querySelector<HTMLElement>('.ms-stage-box')!;
    const click = (under: Element) => {
      root.elementsFromPoint = () => [box, under, drawn()];
      fireEvent.pointerDown(box, { button: 0, clientX: 20, clientY: 20 });
      fireEvent.pointerUp(window, { button: 0, clientX: 20, clientY: 20 });
      fireEvent.click(box, { button: 0, clientX: 20, clientY: 20 });
    };
    click(drawn().querySelector('path')!);
    await waitFor(() => expect(picked).toBe('1/1'));
    click(drawn().querySelector('tspan')!);
    await waitFor(() => expect(picked).toBe('2'));
    // The picked element is outlined.
    expect(drawn().querySelector('[data-ms-picked]')).toBe(drawn().querySelector('text'));
  });

  it('a choice made in the list outlines that element', async () => {
    await mount();
    await waitFor(() => expect(host()).toBeTruthy());
    fireEvent.click(document.querySelector('[data-testid="pick-path"]')!);
    await waitFor(() => expect(drawn().querySelector('[data-ms-picked]')).toBe(drawn().children[1]));
  });

  it('nothing is drawn for a text the core did not check, nor while playing', async () => {
    texts = {};
    const r = await mount();
    expect(host()).toBeNull();
    r.unmount();
    texts = { 'assets/logo.svg': SVG };
    playing = true;
    await mount();
    expect(host()).toBeNull();
  });
});
