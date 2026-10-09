// Pure helpers of the creative canvas: what a board shows, its size on the canvas, where a click lands.
import type { FormatPreset, OutputFileInfo, VersionEntry } from '@motion-studio/shared';
import { api } from '../api.ts';
import { isVideoFile } from '../media.ts';


/** A format of the creative on the canvas: its preset (null when the catalog no longer has it) and its output. */
export interface BoardModel { id: string; preset: FormatPreset | null; out: OutputFileInfo | null }

export interface Media { src: string; video: boolean }

/**
 * The picture of an output: images as they are; videos by their poster (`.previews/<file>.jpg`, made by the core with
 * ffmpeg) when there is one, otherwise the video itself paused on its first frame.
 */
export function outputMedia(slug: string, creative: string, n: number, out: OutputFileInfo): Media {
  const rel = (f: string) => api.fileUrl(slug, creative, `outputs/v${n}/${f}`);
  if (!isVideoFile(out.file)) return { src: rel(out.file), video: false };
  return out.preview ? { src: rel(out.preview), video: false } : { src: rel(out.file), video: true };
}

/** The version's thumbnail (the core's cover rule: the first output, its poster when it has one). */
export function versionThumb(slug: string, creative: string, v: VersionEntry): Media | null {
  const first = v.outputs[0];
  return first ? outputMedia(slug, creative, v.n, first) : null;
}

/** The boards of a creative: the brief's formats in order, then outputs of the version outside the brief. */
export function boardsOf(formats: string[], presets: FormatPreset[], version: VersionEntry | null): BoardModel[] {
  const ids = [...formats, ...(version?.outputs.map((o) => o.format).filter((f) => !formats.includes(f)) ?? [])];
  return [...new Set(ids)].map((id) => ({
    id,
    preset: presets.find((p) => p.id === id) ?? null,
    out: version?.outputs.find((o) => o.format === id) ?? null,
  }));
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
// zoom). The board label does not scale (CanvasBoard): one 22 px line + the 8 px board gap, two lines (22 + 6 + 22)
// when its board is narrower than LABEL_ONE_LINE on screen, and never narrower than LABEL_MIN (its max-width floor).
const WORLD_PAD_X = 60;
const WORLD_PAD_TOP = 40;
const WORLD_PAD_BOTTOM = 140;
const WORLD_GAP = 40;
const STACK_GAP = 44;
const BOARD_HEAD = 30;
const BOARD_HEAD_WRAPPED = 58;
export const LABEL_MIN = 160;
const LABEL_ONE_LINE = 240;

/** The canvas world on screen at zoom `z`: tall boards in a row, the others stacked in a column next to them. */
export function worldAt(boards: BoardModel[], z: number): { width: number; height: number } {
  const board = (f: { width: number; height: number }) => {
    const w = f.width * z;
    return { width: Math.max(w, LABEL_MIN), height: (w < LABEL_ONE_LINE ? BOARD_HEAD_WRAPPED : BOARD_HEAD) + f.height * z };
  };
  const columns = boards.filter(isTall).map(boardFrame).map(board);
  const rest = boards.filter((b) => !isTall(b)).map(boardFrame).map(board);
  if (rest.length) {
    columns.push({
      width: Math.max(...rest.map((f) => f.width)),
      height: rest.reduce((h, f) => h + f.height, 0) + STACK_GAP * z * (rest.length - 1),
    });
  }
  const width = columns.reduce((w, c) => w + c.width, 0) + WORLD_GAP * z * Math.max(0, columns.length - 1);
  const height = Math.max(0, ...columns.map((c) => c.height));
  return { width: width + 2 * WORLD_PAD_X * z, height: height + (WORLD_PAD_TOP + WORLD_PAD_BOTTOM) * z };
}

/** The size of the canvas world at 100%. */
export function worldSize(boards: BoardModel[]): { width: number; height: number } {
  return worldAt(boards, 1);
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
 * The zoom the canvas opens at: every board visible, counting the labels at their real size (`worldAt`). The largest
 * 5% step from the linear estimate down that fits, never above 100% nor below `min`. Null without boards or before
 * the viewport is laid out.
 */
export function fitBoards(boards: BoardModel[], view: { width: number; height: number }, min: number): number | null {
  if (!boards.length) return null;
  let z = fitZoom(worldSize(boards), view, min);
  if (z === null) return null;
  while (z > min + 1e-9) {
    const w = worldAt(boards, z);
    if (w.width <= view.width + 1e-6 && w.height <= view.height + 1e-6) break;
    z = Math.max(min, Math.round((z - 0.05) * 20) / 20);
  }
  return z;
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

/** Tall boards sit in the first row, the others stack in a column next to them (prototype). */
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
