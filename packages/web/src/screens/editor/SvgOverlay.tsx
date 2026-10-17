// The SVG of the selected svg clip drawn inline over the stage (SVG inner editor, Task 4), so its elements can be pointed at:
// hover outlines the element under the pointer, a click picks it (the same choice as the inspector's list of elements).
//
// - **Only checked text:** the text is the one the draft keeps for the clip's `src` (`Draft.svgTexts`), which the core
//   either read and checked or staged itself; anything else (a file it refused, changes not staged yet) is never drawn.
// - **Confined:** the drawing lives in a shadow root (`attachShadow`): the SVG's own `<style>` applies only inside it. It is
//   parsed with DOMParser and its root imported with `importNode`; no markup string is ever assigned to the page.
// - **Boxed in:** a shadow `:host` rule with `!important` beats any style the page gives the host (decision 896). The core
//   refuses such selectors, and the copy drawn here drops any `<style>` that has one; besides, the host sits inside a box
//   of the page (`.ms-svg-overlay`: size and transform, `contain: strict`, `overflow: clip`), so whatever the host became,
//   nothing of it is drawn or hit outside the clip's box, and it stacks below the selection box.
// - **Invisible but for the outline:** the drawing is `visibility: hidden` (the player's frame shows the clip) while its
//   shapes stay hit-testable (`pointer-events: painted`); the picked and hovered elements are shown with an accent stroke.
// - **Under the handles:** the overlay sits below the selection box, which keeps moving and resizing the clip; a click that
//   did not move (Stage) asks `hit` which listed element is under the pointer (`elementsFromPoint` of the shadow root).
// - Not shown while playing, and never part of the render.
import { listElements, parseSvg, pathOf, type Clip } from '@motion-studio/shared';
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type Ref } from 'react';

/** What Stage asks of the overlay: the path of the listed element under a client point, or null. */
export interface SvgOverlayHandle { hit(clientX: number, clientY: number): string | null }

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The overlay's own style, inside the shadow root (the theme's custom properties inherit into it). */
const OVERLAY_CSS = `
svg.ms-svg-ov { display: block; width: 100%; height: 100%; overflow: hidden; visibility: hidden; pointer-events: none; }
svg.ms-svg-ov * { pointer-events: painted; }
[data-ms-hover], [data-ms-hover] * { visibility: visible !important; fill-opacity: 0 !important; stroke: var(--accent, currentColor) !important;
  stroke-opacity: .8 !important; stroke-width: 1.5px !important; stroke-dasharray: 4 3 !important; vector-effect: non-scaling-stroke; }
[data-ms-picked], [data-ms-picked] * { visibility: visible !important; fill: var(--accent, currentColor) !important; fill-opacity: .14 !important;
  stroke: var(--accent, currentColor) !important; stroke-opacity: 1 !important; stroke-width: 2px !important; stroke-dasharray: none !important; vector-effect: non-scaling-stroke; }
`;

/** A selector that reaches out of a shadow tree (the core refuses them too: `checkVectorSvg`). Comments and escapes are refused by the core. */
const SHADOW_SELECTOR_RE = /::?(?:host-context|host|slotted|part)(?![a-z0-9_-])/i;

const ASPECT: Record<'cover' | 'contain' | 'fill', string> = { contain: 'xMidYMid meet', cover: 'xMidYMid slice', fill: 'none' };

interface Props {
  clip: Extract<Clip, { type: 'svg' }>;
  /** The checked SVG text of the clip's file. */
  text: string;
  /** Where the clip is drawn, in pixels of the stage layer: the box's size, centre and rotation (as the handles draw it). */
  box: { width: number; height: number; cx: number; cy: number; rotation: number };
  picked: string | null;
  hover: string | null;
  handle: Ref<SvgOverlayHandle>;
}

export function SvgOverlay({ clip, text, box, picked, hover, handle }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const drawn = useRef<SVGSVGElement | null>(null);
  const listed = useMemo(() => {
    const p = parseSvg(text);
    return p.ok ? new Set(listElements(p.doc).map((x) => x.path)) : new Set<string>();
  }, [text]);

  // The drawing: a fresh import of the checked text into the shadow root, with the overlay's own style.
  const fit = clip.props.fit ?? 'cover';
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    const parsed = parseSvg(text);
    if (!parsed.ok) { root.replaceChildren(style); drawn.current = null; return; }
    const svg = document.importNode(parsed.doc.documentElement, true) as unknown as SVGSVGElement;
    if (svg.namespaceURI !== SVG_NS) { root.replaceChildren(style); drawn.current = null; return; }
    // As the runtime's <img> draws it: scaled to the box by its viewBox (or its own size), placed by the clip's fit.
    if (!svg.hasAttribute('viewBox')) {
      const w = parseFloat(svg.getAttribute('width') ?? '');
      const h = parseFloat(svg.getAttribute('height') ?? '');
      if (w > 0 && h > 0) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('preserveAspectRatio', ASPECT[fit]);
    svg.setAttribute('class', 'ms-svg-ov');
    svg.setAttribute('aria-hidden', 'true');
    // Shadow-tree selectors (`:host` and the like) would style the host: such a `<style>` is not drawn here.
    for (const st of [...svg.getElementsByTagNameNS(SVG_NS, 'style')]) if (SHADOW_SELECTOR_RE.test(st.textContent ?? '')) st.remove();
    root.replaceChildren(style, svg);
    drawn.current = svg;
  }, [text, fit]);

  // The outlines: a mark on the picked and the hovered element of the drawing.
  useEffect(() => {
    const svg = drawn.current;
    if (!svg) return;
    for (const [attr, path] of [['data-ms-picked', picked], ['data-ms-hover', hover !== picked ? hover : null]] as const) {
      for (const old of svg.querySelectorAll(`[${attr}]`)) old.removeAttribute(attr);
      const target = path !== null ? elementAtPath(svg, path) : null;
      if (target) target.setAttribute(attr, '');
    }
  }, [picked, hover, text, fit]);

  useImperativeHandle(handle, () => ({
    hit(x: number, y: number): string | null {
      const svg = drawn.current;
      const root = host.current?.shadowRoot as (ShadowRoot & { elementsFromPoint?: (x: number, y: number) => Element[] }) | null | undefined;
      if (!svg || !root?.elementsFromPoint) return null;
      const under = root.elementsFromPoint(x, y).find((el) => el !== svg && svg.contains(el));
      // The nearest listed element (a tspan belongs to its text, a shape in <defs> to nothing).
      for (let el: Element | null = under ?? null; el && el !== svg; el = el.parentElement) {
        const path = pathOf(svg, el);
        if (path !== null && listed.has(path)) return path;
      }
      return null;
    },
  }), [listed]);

  return (
    <div className="ms-svg-overlay" data-slot="svg-overlay-box" data-clip={clip.id} aria-hidden="true"
      style={{ width: box.width, height: box.height, transform: `translate(${box.cx - box.width / 2}px, ${box.cy - box.height / 2}px) rotate(${box.rotation}deg)` }}>
      <div ref={host} className="ms-svg-host" data-slot="svg-overlay" />
    </div>
  );
}

/** The element at `path` (child indexes from the root, as the SVG-edit model counts them) under `svg`. */
function elementAtPath(svg: Element, path: string): Element | null {
  let el: Element | null = svg;
  if (path === '') return el;
  for (const part of path.split('/')) {
    if (!/^\d{1,6}$/.test(part) || !el) return null;
    el = el.children[Number(part)] ?? null;
  }
  return el;
}
