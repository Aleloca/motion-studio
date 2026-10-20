// Pure helpers of the creative canvas: what a board shows, its size on the canvas, where a click lands.
import { channelName, packInstancesOf, type FormatPreset, type Locale, type OutputFileInfo, type StorePack, type VersionEntry } from '@motion-studio/shared';
import { api } from '../api.ts';
import { isVideoFile } from '../media.ts';
import { instanceName, presetFor } from '../instances.ts';


/** A format of the creative on the canvas: its preset (null when the catalog no longer has it) and its output. */
export interface BoardModel { id: string; preset: FormatPreset | null; out: OutputFileInfo | null; /** The brief's labels of the instances (`brief.formatLabels`). */ labels?: Record<string, string> }

export interface Media { src: string; video: boolean }

/** The URL of a file of version `n`'s outputs. */
export const outputUrl = (slug: string, creative: string, n: number, file: string): string => api.fileUrl(slug, creative, `outputs/v${n}/${file}`);

/**
 * The picture of an output: images as they are; videos by their poster (`.previews/<file>.jpg`, made by the core with
 * ffmpeg) when there is one, otherwise the video itself paused on its first frame.
 */
export function outputMedia(slug: string, creative: string, n: number, out: OutputFileInfo): Media {
  const rel = (f: string) => outputUrl(slug, creative, n, f);
  if (!isVideoFile(out.file)) return { src: rel(out.file), video: false };
  return out.preview ? { src: rel(out.preview), video: false } : { src: rel(out.file), video: true };
}

/**
 * The boards of a creative with per-format versions (spec §3.1): the brief's formats in order, then outputs of the latest
 * version outside the brief. Each board shows the file of `source(id)` (a follower: its primary's) at that version.
 */
export function boardsWith(formats: string[], presets: FormatPreset[], versions: VersionEntry[], source: (id: string) => { format: string; n: number | null }, labels?: Record<string, string>):
  Array<BoardModel & { n: number | null }> {
  const latest = versions.at(-1) ?? null;
  const ids = [...formats, ...(latest?.outputs.map((o) => o.format).filter((f) => !formats.includes(f)) ?? [])];
  return [...new Set(ids)].map((id) => {
    const src = source(id);
    return {
      id,
      preset: presetFor(presets, id),
      ...(labels ? { labels } : {}),
      out: src.n === null ? null : versions.find((v) => v.n === src.n)?.outputs.find((o) => o.format === src.format) ?? null,
      n: src.n,
    };
  });
}

/**
 * Board size at 100% zoom (prototype layout): tall formats 540 px high (a 9:16 is 304×540), other portraits 300 px
 * wide, squares and landscapes 344–420 px wide, banners 520 px wide.
 */
export function boardSize(width: number, height: number): { width: number; height: number } {
  const r = width / height;
  const fit = (w: number) => ({ width: Math.round(w), height: Math.max(24, Math.round(w / r)) });
  if (r <= 0.75) return { width: Math.round(540 * r), height: 540 };
  if (r < 1) return fit(300);
  if (r <= 1.25) return fit(344);
  if (r <= 2.5) return fit(420);
  return fit(520);
}

/** A board's frame at 100% zoom: its preset in proportion, a square when the catalog no longer has the format. */
export function boardFrame(b: BoardModel): { width: number; height: number } {
  return b.preset ? boardSize(b.preset.width, b.preset.height) : { width: 300, height: 300 };
}

// The canvas world's layout at 100% (canvas.css: .ms-cv-world padding and gap, .ms-cv-stack gap; all scale with the
// zoom). The board label does not scale (CanvasBoard): always two 20 px lines (title, subtitle) 2 px apart + the 8 px board gap
// (BOARD_HEAD), and never narrower than LABEL_MIN (its max-width floor). Both lines ellipsize instead of wrapping.
const WORLD_PAD_X = 60;
const WORLD_PAD_TOP = 40;
const WORLD_PAD_BOTTOM = 140;
const WORLD_GAP = 40;
const STACK_GAP = 44;
const BOARD_HEAD = 50;
// 176: the channel mark, a common format name ("Story/Reel 9:16", ~100 px) and its "★ vN" badge fit on the first line
// (phase 9 live checks: 160 cut the name); a longer name is the last thing to give way (a follower's chip shrinks first).
export const LABEL_MIN = 176;
/** Phase 15: a board of a variant group also carries the ★ across variants (and, per format, the variant's letter): 40 px more. */
export const LABEL_MIN_GROUPED = 216;

/** The lowest zoom the canvas opens at (report 40: a store pack's 19 boards all in view); the user can zoom down to it too. */
export const FIT_MIN = 0.1;
/**
 * Report 60: the lowest zoom a canvas opens at to show all its boards (a 16:9 is 168×94 px). Below it the canvas opens at this
 * zoom, its rows filling the width, and scrolls down (`canvasFit`); a store pack keeps opening with all of it in view (report 40).
 */
export const READABLE_ZOOM = 0.4;
/** The narrowest label below 50% (review B): about the channel mark and a screenshot's number. */
const LABEL_SMALL = 40;
/** Between the lines of boards: the stack's gap. */
const LINE_GAP = STACK_GAP;

/**
 * The width a board's label keeps at zoom `z`: LABEL_MIN (LABEL_MIN_GROUPED in a variant group) from 50% up, as before.
 * Below 50%, only reached by a canvas with many boards, the label follows the board (review B of report 40: a 96 px floor made
 * a store pack's thumbnails tiny); it never goes under 40 px, and shows a short name (CanvasBoard).
 */
export function labelMin(z: number, grouped = false): number {
  if (z >= 0.5) return grouped ? LABEL_MIN_GROUPED : LABEL_MIN;
  return LABEL_SMALL;
}

/** A group of boards on the canvas: a group of the formats column. `alone`: its lines take no other group (a store of a pack). */
export interface BoardGroup<B extends BoardModel = BoardModel> { boards: B[]; alone?: boolean }
/**
 * A place on a line of the canvas: a tall board, or the group's other boards in a grid (`stack`) of `cols` columns, in reading
 * order (report 60; one column: the stack of report 40).
 */
export interface CanvasItem<B extends BoardModel = BoardModel> { stack: boolean; boards: B[]; cols: number }

/** The key of the store pack's group in the formats column (no channel is called this). */
export const PACK_GROUP = '\u0000store-pack';

/** The formats column's groups, in the order of first appearance; `pack`: the ids of the store pack, which form one group. */
export function groupByChannel<B extends BoardModel>(boards: B[], pack: ReadonlySet<string>): Array<[string, B[]]> {
  const m = new Map<string, B[]>();
  for (const b of boards) {
    const ch = pack.has(b.id) ? PACK_GROUP : b.preset?.channel ?? '';
    m.set(ch, [...(m.get(ch) ?? []), b]);
  }
  return [...m.entries()];
}

/** The formats column's groups with a store pack split into its stores (the column's sub-groups), each with its channel. */
export function formatSections<B extends BoardModel>(boards: B[], pack: ReadonlySet<string>): Array<{ channel: string; pack: boolean; boards: B[] }> {
  type Section = { channel: string; pack: boolean; boards: B[] };
  return groupByChannel(boards, pack).flatMap(([ch, list]): Section[] => (ch === PACK_GROUP
    ? groupByChannel(list, new Set()).map(([c, l]) => ({ channel: c, pack: true, boards: l }))
    : [{ channel: ch, pack: false, boards: list }]));
}

/**
 * The canvas's groups (report 40): the formats column's, so the two always match. A store pack's group splits into its
 * stores (App Store, Play Store: the column's sub-groups), each on lines of its own.
 */
export function canvasGroups<B extends BoardModel>(boards: B[], pack: ReadonlySet<string>): Array<BoardGroup<B>> {
  return formatSections(boards, pack).map((s) => (s.pack ? { boards: s.boards, alone: true } : { boards: s.boards }));
}

/**
 * The groups of the composer's "Applies to" menu (report 42): the formats `ids` grouped as in the formats column (a store pack by
 * store), each group by its channel's name (`other` without one) and each format by its short name.
 */
export function appliesGroups(ids: string[], presets: FormatPreset[], brief: { storePack?: StorePack | null; formatLabels?: Record<string, string> }, locale: Locale, other: string):
  Array<{ label: string; items: Array<{ id: string; name: string }> }> {
  const pack = new Set(brief.storePack ? packInstancesOf(brief.storePack) : []);
  const boards: BoardModel[] = ids.map((id) => ({ id, preset: presetFor(presets, id), out: null }));
  return formatSections(boards, pack).map((s) => ({
    label: s.channel !== '' ? channelName(s.channel, locale) : other,
    items: s.boards.map((b) => ({ id: b.id, name: instanceName(b.preset, b.id, locale, brief.formatLabels) })),
  }));
}

/**
 * A group's places: its tall boards one by one, then its other boards in a grid of at most `cols` columns (the layout of the
 * canvas before report 40, with report 60's columns).
 */
function itemsOf<B extends BoardModel>(g: BoardGroup<B>, cols: number): Array<CanvasItem<B>> {
  const rest = g.boards.filter((b) => !isTall(b));
  return [...g.boards.filter(isTall).map((b) => ({ stack: false, boards: [b], cols: 1 })),
    ...(rest.length ? [{ stack: true, boards: rest, cols: Math.max(1, Math.min(cols, rest.length)) }] : [])];
}

/**
 * Report 52: how the boards of a canvas are drawn, when not as the plain canvas's: `head`, screen px of header above the usual two
 * lines (the "Scelte" view's line with the variant); `grouped`, the label floor of a variant group's board (LABEL_MIN_GROUPED).
 */
export interface BoardLayout { head?: number; grouped?: boolean }

/**
 * A place's size on screen at zoom `z`, labels at their real size. A grid's columns are as wide as their widest board, its rows
 * as tall as their tallest; the world's gap between columns, the stack's between rows (canvas.css .ms-cv-stack).
 */
function itemSize(it: CanvasItem, z: number, layout: BoardLayout = {}): { width: number; height: number } {
  const head = BOARD_HEAD + (layout.head ?? 0);
  const sizes = it.boards.map(boardFrame).map((f) => ({ width: Math.max(f.width * z, labelMin(z, layout.grouped)), height: head + f.height * z }));
  const cols = Math.max(1, Math.min(it.cols, sizes.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...sizes.filter((_, i) => i % cols === c).map((s) => s.width)));
  const rows = Math.ceil(sizes.length / cols);
  const heights = Array.from({ length: rows }, (_, r) => Math.max(...sizes.slice(r * cols, r * cols + cols).map((s) => s.height)));
  return {
    width: widths.reduce((w, x) => w + x, 0) + WORLD_GAP * z * (cols - 1),
    height: heights.reduce((h, x) => h + x, 0) + STACK_GAP * z * (rows - 1),
  };
}

const lineWidth = (line: CanvasItem[], z: number, layout?: BoardLayout) => line.reduce((w, it) => w + itemSize(it, z, layout).width, 0) + WORLD_GAP * z * Math.max(0, line.length - 1);
const linesHeight = (lines: CanvasItem[][], z: number, layout?: BoardLayout) =>
  lines.reduce((sum, l) => sum + Math.max(...l.map((it) => itemSize(it, z, layout).height)), 0) + LINE_GAP * z * Math.max(0, lines.length - 1);

/**
 * The lines of the canvas at zoom `z` in a viewport `width` px wide (null: not laid out, nothing wraps). Report 40: each group
 * starts a line unless it fits whole after the previous one; a group too long for a line wraps, and its last line takes no other
 * group; a store of a store pack has its lines to itself. Report 60: a group's grid has at most `cols` columns (`canvasFit`).
 */
export function canvasLines<B extends BoardModel>(groups: Array<BoardGroup<B>>, z: number, width: number | null, layout?: BoardLayout, cols = 1): Array<Array<CanvasItem<B>>> {
  const room = width === null ? Infinity : width - 2 * WORLD_PAD_X * z;
  const gap = WORLD_GAP * z;
  const lines: Array<Array<CanvasItem<B>>> = [];
  let open = false; // the last line can take another group
  for (const g of groups) {
    const items = itemsOf(g, cols);
    if (!items.length) continue;
    const last = lines.at(-1);
    if (open && !g.alone && last && lineWidth(last, z, layout) + gap + lineWidth(items, z, layout) <= room + 1e-6) {
      last.push(...items);
      continue;
    }
    const start = lines.length;
    let line: Array<CanvasItem<B>> = [];
    lines.push(line);
    for (const it of items) {
      if (line.length && lineWidth(line, z, layout) + gap + itemSize(it, z, layout).width > room + 1e-6) { line = []; lines.push(line); }
      line.push(it);
    }
    open = !g.alone && lines.length - start === 1;
  }
  return lines;
}

/** Report 52: a section of a canvas: its groups' lines (`canvasLines`) under a heading `head` screen px high (0: none). */
export interface CanvasSection<B extends BoardModel = BoardModel> { groups: Array<BoardGroup<B>>; head: number }

/**
 * Report 52: a canvas of sections one above the other (the "Scelte" view: "Scelte", then "Senza scelta"), on screen at zoom `z` in
 * a viewport `width` px wide, with the world's padding. Each section is its heading and its own lines; between two sections the
 * lines' gap. One section without a heading is the plain canvas (`worldAt`). `wrapAt`: the zoom the lines were wrapped at (the
 * user's zoom scales the lines drawn at the opening zoom, it does not wrap them again).
 */
export function sectionsAt(sections: CanvasSection[], z: number, width: number | null = null, layout?: BoardLayout, cols = 1, wrapAt = z): { width: number; height: number } {
  let w = 0;
  let h = LINE_GAP * z * Math.max(0, sections.length - 1);
  for (const s of sections) {
    const lines = canvasLines(s.groups, wrapAt, width, layout, cols);
    w = Math.max(w, ...lines.map((l) => lineWidth(l, z, layout)));
    h += s.head + linesHeight(lines, z, layout);
  }
  return { width: w + 2 * WORLD_PAD_X * z, height: h + (WORLD_PAD_TOP + WORLD_PAD_BOTTOM) * z };
}

/** The canvas world on screen at zoom `z` in a viewport `width` px wide (`canvasLines`), with its padding. */
export function worldAt(groups: BoardGroup[], z: number, width: number | null = null): { width: number; height: number } {
  return sectionsAt([{ groups, head: 0 }], z, width);
}

/** The size of the canvas world at 100%, nothing wrapped. */
export function worldSize(groups: BoardGroup[]): { width: number; height: number } {
  return worldAt(groups, 1);
}

/**
 * The zoom that shows a world in the viewport as if all of it scaled, rounded down to 5%, never above 100% and kept
 * within `min`. Null when the viewport has no size yet (not laid out). `fitBoards` refines it for the canvas.
 */
export function fitZoom(world: { width: number; height: number }, view: { width: number; height: number }, min: number): number | null {
  if (view.width <= 0 || view.height <= 0 || world.width <= 0 || world.height <= 0) return null;
  const z = Math.min(1, view.width / world.width, view.height / world.height);
  return Math.max(min, Math.floor(z * 20 + 1e-9) / 20);
}

/**
 * The zoom the canvas opens at: every board visible, the lines wrapped to the viewport and the labels at their real size
 * (`worldAt`). The largest zoom that fits, from 100% down (5% steps, 1% below 50%: the wrapping changes with the zoom, so
 * the search tries each layout and keeps the one with the biggest boards that fits width and height), never below `min`. Null without boards or before the viewport is
 * laid out.
 */
export function fitBoards(groups: BoardGroup[], view: { width: number; height: number }, min: number): number | null {
  return fitSections([{ groups, head: 0 }], view, min);
}

/** Report 52: `fitBoards` for a canvas of sections (`sectionsAt`): the same search, the headings at their real size. */
export function fitSections(sections: CanvasSection[], view: { width: number; height: number }, min: number, layout?: BoardLayout): number | null {
  return fitAll(sections, view, min, layout)?.zoom ?? null;
}

// 5% steps down to 50%, then 1% (review B: at a store pack's 20–30% a 5% step is a fifth of the boards' size).
const stepDown = (z: number, min: number) => (z > 0.5 + 1e-9 ? Math.max(min, Math.round((z - 0.05) * 20) / 20) : Math.max(min, Math.round((z - 0.01) * 100) / 100));
const hasBoards = (sections: CanvasSection[]) => sections.some((s) => s.groups.some((g) => g.boards.length));
/** The most boards of a grid of the canvas: its columns are tried up to this. */
const gridMax = (sections: CanvasSection[]) => Math.max(1, ...sections.flatMap((s) => s.groups.map((g) => g.boards.filter((b) => !isTall(b)).length)));

/**
 * The largest zoom (from 100%, the steps of `stepDown`, never below `min`) at which the canvas with grids of `cols` columns fits
 * the viewport; with `above`, only a zoom above it counts (null: none).
 */
function fitAt(sections: CanvasSection[], view: { width: number; height: number }, min: number, layout: BoardLayout | undefined, cols: number, above = -1, from = 1, wrapAt?: number): number | null {
  let z = from;
  for (;;) {
    if (z <= above + 1e-9) return null;
    const w = sectionsAt(sections, z, view.width, layout, cols, wrapAt ?? z);
    if ((w.width <= view.width + 1e-6 && w.height <= view.height + 1e-6) || z <= min + 1e-9) return z;
    z = stepDown(z, min);
  }
}

/**
 * Report 60: the zoom that shows every board and the grids' columns that give it: each column count is tried and the largest
 * zoom kept (a tie keeps the fewer columns, the layout closest to the old stack). Null without boards or before the viewport is
 * laid out.
 */
function fitAll(sections: CanvasSection[], view: { width: number; height: number }, min: number, layout?: BoardLayout): { zoom: number; cols: number } | null {
  if (!hasBoards(sections) || view.width <= 0 || view.height <= 0) return null;
  let best = { zoom: fitAt(sections, view, min, layout, 1)!, cols: 1 };
  for (let c = 2; c <= gridMax(sections); c++) {
    // More columns only widen the canvas: once they no longer fit the width at the best zoom so far, none will do better.
    if (sectionsAt(sections, best.zoom, view.width, layout, c).width > view.width + 1e-6) break;
    const z = fitAt(sections, view, min, layout, c, best.zoom);
    if (z !== null) best = { zoom: z, cols: c };
  }
  return best;
}

/**
 * Report 60: how the canvas opens in a viewport: its zoom, its grids' columns (`canvasLines`) and `all`, the zoom at which that
 * layout is all in view (the lowest the user can zoom down to). Every board in view when that is at least READABLE_ZOOM;
 * otherwise READABLE_ZOOM, with as many columns as the width takes, the canvas scrolling down. A canvas with a store pack (its
 * stores' lines, `alone`) keeps fitting all of it as report 40 wants, below the floor too. Null without boards or before the
 * viewport is laid out.
 */
export function canvasFit(sections: CanvasSection[], view: { width: number; height: number }, min: number, layout?: BoardLayout): { zoom: number; cols: number; all: number } | null {
  // Review of report 60: the canvas asks on every render; the answer depends only on the boards' sizes, the viewport and the layout.
  const key = fitKeyOf(sections, view, min, layout);
  const known = fitMemo.get(key);
  if (known !== undefined) return known;
  const fit = computeFit(sections, view, min, layout);
  if (fitMemo.size >= 32) fitMemo.delete(fitMemo.keys().next().value!);
  fitMemo.set(key, fit);
  return fit;
}

const fitMemo = new Map<string, { zoom: number; cols: number; all: number } | null>();
const fitKeyOf = (sections: CanvasSection[], view: { width: number; height: number }, min: number, layout?: BoardLayout) =>
  `${view.width}x${view.height}:${min}:${layout?.head ?? 0}:${layout?.grouped ? 1 : 0}|${sections.map((s) => `${s.head}=${s.groups
    .map((g) => `${g.alone ? '!' : ''}${g.boards.map((b) => (b.preset ? `${b.preset.width}x${b.preset.height}` : '-')).join(',')}`).join(';')}`).join('|')}`;

function computeFit(sections: CanvasSection[], view: { width: number; height: number }, min: number, layout?: BoardLayout): { zoom: number; cols: number; all: number } | null {
  const fit = fitAll(sections, view, min, layout);
  if (!fit) return null;
  const pack = sections.some((s) => s.groups.some((g) => g.alone));
  if (fit.zoom >= READABLE_ZOOM - 1e-9 || pack || min >= READABLE_ZOOM) return { ...fit, all: fit.zoom };
  let cols = 1;
  while (cols < gridMax(sections) && sectionsAt(sections, READABLE_ZOOM, view.width, layout, cols + 1).width <= view.width + 1e-6) cols++;
  // `all`: the lines as drawn (wrapped at READABLE_ZOOM, never again) scaled down until they are all in view.
  return { zoom: READABLE_ZOOM, cols, all: fitAt(sections, view, min, layout, cols, -1, READABLE_ZOOM, READABLE_ZOOM)! };
}

/** A world point (canvas px at 100%) on screen: scaled by the zoom, moved by the pan (the anchor's screen origin). */
export function toScreen(pt: { x: number; y: number }, zoom: number, pan: { x: number; y: number } = { x: 0, y: 0 }): { x: number; y: number } {
  return { x: pt.x * zoom + pan.x, y: pt.y * zoom + pan.y };
}

/** `9:16`, or `W×H` when the reduced ratio is not a readable one. */
export function ratioText(p: { width: number; height: number }): string {
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(p.width, p.height);
  return p.width / d <= 21 && p.height / d <= 21 ? `${p.width / d}:${p.height / d}` : `${p.width}×${p.height}`;
}

/** In a group, tall boards sit one by one on its line, the others in a grid after them (prototype; report 60). */
export const isTall = (b: BoardModel) => (b.preset ? b.preset.width / b.preset.height <= 0.75 : false);

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Where a click lands on a frame, 0–1 on each axis. A click without a position (keyboard, or a frame not laid out)
 * lands in the middle.
 */
export function pointIn(rect: { left: number; top: number; width: number; height: number }, e: { clientX: number; clientY: number; detail: number }): { x: number; y: number } {
  if (!rect.width || !rect.height || e.detail === 0) return { x: 0.5, y: 0.5 };
  return { x: clamp01(round3((e.clientX - rect.left) / rect.width)), y: clamp01(round3((e.clientY - rect.top) / rect.height)) };
}
