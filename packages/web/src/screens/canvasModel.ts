// Pure helpers of the creative canvas: what a board shows, its size on the canvas, where a click lands.
import type { FormatPreset, OutputFileInfo, VersionEntry } from '@motion-studio/shared';
import { api } from '../api.ts';

export const VIDEO_FILE = /\.(mp4|webm|mov|m4v|gif)$/i;

/** A format of the creative on the canvas: its preset (null when the catalog no longer has it) and its output. */
export interface BoardModel { id: string; preset: FormatPreset | null; out: OutputFileInfo | null }

export interface Media { src: string; video: boolean }

/**
 * The picture of an output: images as they are; videos by their poster (`.previews/<file>.jpg`, made by the core with
 * ffmpeg) when there is one, otherwise the video itself paused on its first frame.
 */
export function outputMedia(slug: string, creative: string, n: number, out: OutputFileInfo): Media {
  const rel = (f: string) => api.fileUrl(slug, creative, `outputs/v${n}/${f}`);
  if (!VIDEO_FILE.test(out.file)) return { src: rel(out.file), video: false };
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
