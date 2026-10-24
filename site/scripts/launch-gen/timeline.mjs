// The launch film's timing. The film is written in authoring seconds (each beat a fixed length, `AUTHOR`); each beat is
// then stretched or tightened to its voice-over line: the line starts `LEAD` into the beat and the beat ends `TAIL` after
// the last word, never tighter than `MIN_FACTOR` of what it was written for (the motion stays readable). `W` maps an
// authoring time to the film's time (piecewise linear per beat), `U` back. Without voice-over data every beat keeps its
// authoring length.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BEATS = ['brief', 'variants', 'chat', 'edit', 'brand', 'generate', 'formats', 'langs', 'subs', 'identity', 'export', 'end'];
/** Authoring length of each beat (s). */
export const AUTHOR = { brief: 3.8, variants: 5.4, chat: 5.0, edit: 5.2, brand: 5.4, generate: 7.0, formats: 5.2, langs: 4.8, subs: 5.0, identity: 4.8, export: 5.2, end: 6.2 };
/** Seconds from the beat's start to its line (the subtitles beat waits for its waveform, the end card for its logo). */
const LEAD = { brief: 0.5, subs: 0.8, end: 0.7 };
const LEAD_DEFAULT = 0.35;
/** Breathing room after the last word, before the next beat. */
const TAIL = { end: 1.8 };
const TAIL_DEFAULT = 1.0;
export const MIN_FACTOR = 0.8;

export const MEDIA_FILE = fileURLToPath(new URL('../audio-gen/media.json', import.meta.url));
export const readMedia = () => (existsSync(MEDIA_FILE) ? JSON.parse(readFileSync(MEDIA_FILE, 'utf8')) : {});

const r3 = (v) => Math.round(v * 1000) / 1000;

export function timeline(media = readMedia()) {
  const A = {}; const T = {}; const len = {};
  let a = 0; let t = 0;
  BEATS.forEach((b, i) => {
    const vo = media.vo?.[i];
    const lead = LEAD[b] ?? LEAD_DEFAULT;
    len[b] = vo ? r3(Math.max(lead + vo.speechEnd + (TAIL[b] ?? TAIL_DEFAULT), AUTHOR[b] * MIN_FACTOR)) : AUTHOR[b];
    A[b] = r3(a); T[b] = r3(t);
    a += AUTHOR[b]; t += len[b];
  });
  const DA = r3(a); const D = r3(t);
  const knots = BEATS.map((b) => [A[b], T[b]]).concat([[DA, D]]);
  const interp = (x, from, to) => {
    for (let i = 0; i < knots.length - 1; i++) {
      const [x0, x1] = [knots[i][from], knots[i + 1][from]];
      if (x <= x1 + 1e-9 || i === knots.length - 2) return knots[i][to] + ((x - x0) * (knots[i + 1][to] - knots[i][to])) / (x1 - x0);
    }
    return x;
  };
  const W = (x) => (x <= 0 ? x : interp(x, 0, 1));
  const U = (x) => (x <= 0 ? x : interp(x, 1, 0));
  const vo = BEATS.map((b, i) => {
    const v = media.vo?.[i];
    return v ? { beat: b, file: v.file, text: v.text, start: r3(T[b] + (LEAD[b] ?? LEAD_DEFAULT)), duration: v.duration, speechEnd: v.speechEnd, words: v.words, peaks: v.peaks } : null;
  }).filter(Boolean);
  return { A, T, len, D, DA, W, U, vo };
}

/** Music level between the lines and under them (the bed is normalised to -18 LUFS, the voice to -16). */
export const MUSIC_LEVEL = { open: 0.55, duck: 0.2 };
const DUCK = { before: 0.25, after: 0.35, fade: 0.3 };

/**
 * The music bed, ducked under the voice: stretches of one level each, { from, to, level, fadeIn, fadeOut } in film time.
 * The renderer mixes clips as they are (a clip's volume is constant, with fades at its ends), so each stretch fades out
 * over the same span the next one fades in, from the same place in the same file (trimStart = from): their sum is a
 * linear ramp from one level to the other. The first fades in from silence, the last out to it.
 */
export function musicStretches(vo, D) {
  const under = [];
  for (const v of vo) {
    const a = v.start - DUCK.before; const b = v.start + v.speechEnd + DUCK.after;
    if (under.length && a <= under.at(-1)[1] + DUCK.fade * 2) under.at(-1)[1] = b; else under.push([a, b]);
  }
  const marks = [[0, MUSIC_LEVEL.open]];
  for (const [a, b] of under) { if (a > 0) marks.push([a, MUSIC_LEVEL.duck]); else marks[0][1] = MUSIC_LEVEL.duck; marks.push([b, MUSIC_LEVEL.open]); }
  const out = [];
  marks.forEach(([at, level], i) => {
    const from = i === 0 ? 0 : r3(at - DUCK.fade / 2);
    const next = marks[i + 1];
    const to = next ? r3(Math.min(next[0] + DUCK.fade / 2, D)) : r3(D);
    if (to > from) out.push({ from, to, level, fadeIn: i === 0 ? 1.2 : DUCK.fade, fadeOut: next ? DUCK.fade : 3 });
  });
  return out;
}
