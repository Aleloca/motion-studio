// SRT and VTT: written from the cues, read back for tests now and import later.
import type { SubtitleCue } from './schema.ts';

export type PlainCue = { start: number; end: number; text: string };

const pad = (n: number, w: number) => String(n).padStart(w, '0');
function stamp(t: number, sep: ',' | '.'): string {
  const h = Math.floor(t / 3_600_000);
  return `${pad(h, 2)}:${pad(Math.floor(t / 60_000) % 60, 2)}:${pad(Math.floor(t / 1000) % 60, 2)}${sep}${pad(t % 1000, 3)}`;
}

/** Cues that start before `durationMs`, ends clamped to it, text with no CR. */
function visible(cues: ReadonlyArray<SubtitleCue>, durationMs: number) {
  return cues.filter((c) => c.start < durationMs).map((c) => ({
    start: c.start, end: Math.min(c.end, durationMs), text: c.text.replace(/\r\n?/g, '\n'),
  }));
}

export function toSrt(cues: ReadonlyArray<SubtitleCue>, o: { durationMs: number }): string {
  return visible(cues, o.durationMs).map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}\n\n`).join('');
}

const escapeVtt = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function toVtt(cues: ReadonlyArray<SubtitleCue>, o: { durationMs: number }): string {
  return `WEBVTT\n\n${visible(cues, o.durationMs).map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${escapeVtt(c.text)}\n\n`).join('')}`;
}

const TIME = String.raw`(?:(\d{1,}):)?(\d{1,2}):(\d{2})[,.](\d{3})`;
const TIMING = new RegExp(`^\\s*${TIME}\\s+-->\\s+${TIME}`);

function parseTiming(line: string): [number, number] | null {
  const m = TIMING.exec(line);
  if (!m) return null;
  const at = (i: number) => (Number(m[i] ?? 0) * 3600 + Number(m[i + 1]) * 60 + Number(m[i + 2])) * 1000 + Number(m[i + 3]);
  return [at(1), at(5)];
}

function readBlocks(text: string, unescape: (t: string) => string): PlainCue[] | null {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const out: PlainCue[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = parseTiming(lines[i]!);
    if (!t) { i++; continue; }
    i++;
    const body: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '') body.push(lines[i++]!);
    out.push({ start: t[0], end: t[1], text: unescape(body.join('\n')) });
  }
  return out.length > 0 ? out : null;
}

export const fromSrt = (text: string): PlainCue[] | null => readBlocks(text, (t) => t);

export function fromVtt(text: string): PlainCue[] | null {
  if (!/^\uFEFF?WEBVTT/.test(text)) return null;
  return readBlocks(text, (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
}
