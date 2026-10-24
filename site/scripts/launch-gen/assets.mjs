// The launch film's SVG assets, drawn by hand: the app's canvas ground, the boards' backgrounds (the film in its first
// look and in the Motion Studio brand), interface glyphs (cursor, outlines, folders, files) and the waveform. The
// directions' art comes from the hero creatives' own generators (KOVA, TIDEFALL, Fernwise).
import * as KOVA from '../hero-gen/kova-assets.mjs';
import * as TIDE from '../hero-gen/tidefall-assets.mjs';
import * as FERN from '../hero-gen/fernwise-assets.mjs';

export const C = {
  stage: '#0F0F0F', surface: '#171717', raised: '#1F1F1F', line: '#262626', dash: '#6B6B6B', text: '#F5F1EC', muted: '#A3A3A3',
  orange: '#FF5A1F', orangeDeep: '#C2410C', formats: '#2DD4BF', store: '#A78BFA', lang: '#60A5FA', agent: '#FACC15',
  ok: '#4ADE80', okBg: '#12301E',
  // The film's first look (the KOVA direction).
  night: '#06070B', cyan: '#7CF5FF', steel: '#8A93A6',
};

/** The app's dotted canvas, full frame. */
export const canvas = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
<defs><pattern id="p" width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="16" cy="16" r="1.5" fill="#2E2E2E"/></pattern>
<radialGradient id="v" cx=".5" cy=".45" r=".75"><stop offset=".55" stop-color="#0F0F0F" stop-opacity="0"/><stop offset="1" stop-color="#0F0F0F" stop-opacity=".9"/></radialGradient></defs>
<rect width="1920" height="1080" fill="url(#p)"/><rect width="1920" height="1080" fill="url(#v)"/>
</svg>`;

/** A soft light for the end card. */
export const ember = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
<defs><radialGradient id="g" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#FF5A1F" stop-opacity=".28"/><stop offset=".45" stop-color="#C2410C" stop-opacity=".1"/><stop offset="1" stop-color="#C2410C" stop-opacity="0"/></radialGradient></defs>
<rect width="1000" height="1000" fill="url(#g)"/>
</svg>`;

/**
 * A board's background: the frame of one format (w × h), rounded, with a radial light at (gx, gy) and a dot grid.
 * `look`: 'night' (the film's first look, cyan) or 'brand' (Motion Studio: stage black, orange light).
 */
export function filmBg(w, h, gx, gy, look) {
  const base = look === 'night' ? C.night : '#0C0C0C';
  const [c1, c2] = look === 'night' ? ['#38E1FF', '#2C5BFF'] : ['#FF5A1F', '#C2410C'];
  const dot = look === 'night' ? '#8A93A6' : '#6B6B6B';
  const r = Math.max(w, h) * 0.62;
  const rad = Math.round(Math.min(w, h) * 0.034);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
<defs><clipPath id="c"><rect width="${w}" height="${h}" rx="${rad}"/></clipPath>
<radialGradient id="g" gradientUnits="userSpaceOnUse" cx="${gx}" cy="${gy}" r="${r}"><stop offset="0" stop-color="${c1}" stop-opacity=".42"/><stop offset=".38" stop-color="${c2}" stop-opacity=".16"/><stop offset="1" stop-color="${c2}" stop-opacity="0"/></radialGradient>
<pattern id="p" width="48" height="48" patternUnits="userSpaceOnUse"><circle cx="24" cy="24" r="1.7" fill="${dot}" fill-opacity=".32"/></pattern></defs>
<g clip-path="url(#c)"><rect width="${w}" height="${h}" fill="${base}"/><rect width="${w}" height="${h}" fill="url(#p)"/><rect width="${w}" height="${h}" fill="url(#g)"/></g>
<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="${rad}" fill="none" stroke="#FFFFFF" stroke-opacity=".08" stroke-width="2"/>
</svg>`;
}

/** A ring of light (the KOVA ring, in cyan or orange). */
export const ringCyan = KOVA.ring;
export const ringOrange = KOVA.ring.replaceAll('#7CF5FF', C.orange);

/** TIDEFALL direction: blue poster ground with its sun and waves. */
export function posterBg(w, h) {
  const rad = Math.round(Math.min(w, h) * 0.034);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="${rad}" fill="${TIDE.P.blue}"/></svg>`;
}
export const sun = TIDE.sun();
export const waves = TIDE.waves();
export const halftone = TIDE.halftone(TIDE.P.cream);
export const TP = TIDE.P;

/** Fernwise direction: cream ground, a white card with the savings chart. */
export function paperBg(w, h) {
  const rad = Math.round(Math.min(w, h) * 0.034);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="${rad}" fill="${FERN.F.bg}"/></svg>`;
}
export const chart = FERN.chart(860, 420);
export const FP = FERN.F;

/** A rounded outline of any size (the stroke keeps its width). */
export function outline(w, h, rx, color, width = 3) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><rect x="${width / 2}" y="${width / 2}" width="${w - width}" height="${h - width}" rx="${rx}" fill="none" stroke="${color}" stroke-width="${width}" vector-effect="non-scaling-stroke"/></svg>`;
}

/** The pointer: a white arrow with a dark edge. Its tip is at (4, 3) of a 40 × 48 box. */
export const cursor = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 48">
<path d="M4 3 L4 37 L13 29 L19 43 L25 40 L19 27 L31 27 Z" fill="#FFFFFF" stroke="#0F0F0F" stroke-width="2.5" stroke-linejoin="round"/>
</svg>`;

/** A ring for click ripples. */
export const ripple = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="none" stroke="#F5F1EC" stroke-width="4"/></svg>`;

/** The agent's avatar in the chat: the app's orange play tile. */
export const avatar = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="#FF5A1F"/><path d="M16 13.5Q16 11.5 17.7 12.5L27.3 18.3Q29 19.3 27.3 20.3L17.7 26.1Q16 27.1 16 25.1Z" fill="#FFFFFF"/></svg>`;

/** The format badge of a board label: a small rounded square with the frame's ratio drawn inside. */
export function ratioIcon(rw, rh, color) {
  const s = 36; const m = 0.62 * s; const k = m / Math.max(rw, rh);
  const w = rw * k; const h = rh * k;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}"><rect width="${s}" height="${s}" rx="9" fill="${color}" fill-opacity=".16"/><rect x="${((s - w) / 2).toFixed(2)}" y="${((s - h) / 2).toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="2.5" fill="none" stroke="${color}" stroke-width="2.4"/></svg>`;
}

/** A folder (back, front). */
export function folder(color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 220">
<path d="M14 30 Q14 14 30 14 L112 14 Q122 14 128 22 L140 38 L270 38 Q286 38 286 54 L286 196 Q286 210 272 210 L28 210 Q14 210 14 196 Z" fill="${color}" fill-opacity=".22"/>
<path d="M14 74 Q14 60 28 60 L272 60 Q286 60 286 74 L286 196 Q286 210 272 210 L28 210 Q14 210 14 196 Z" fill="#1F1F1F" stroke="${color}" stroke-opacity=".7" stroke-width="3"/>
</svg>`;
}

/** A file glyph with a coloured corner. */
export function fileGlyph(color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 36"><path d="M3 4 Q3 1 6 1 L19 1 L27 9 L27 32 Q27 35 24 35 L6 35 Q3 35 3 32 Z" fill="none" stroke="#A3A3A3" stroke-width="2"/><path d="M19 1 L19 9 L27 9" fill="none" stroke="#A3A3A3" stroke-width="2"/><rect x="8" y="20" width="14" height="8" rx="2" fill="${color}"/></svg>`;
}

/** A download arrow (the Export button). */
export const download = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 4 L12 15 M7 10.5 L12 15.5 L17 10.5 M5 19.5 L19 19.5" fill="none" stroke="#0F0F0F" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** A spoken line's waveform: seeded bars, w × h. */
export function waveform(w, h, color = '#6B6B6B') {
  let s = 11;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const bars = [];
  const step = 9;
  for (let x = 0, i = 0; x < w - 4; x += step, i++) {
    // Two phrases: speech between 4–34% and 40–96% of the width, silence around.
    const f = x / w;
    const speech = (f > 0.04 && f < 0.34) || (f > 0.4 && f < 0.96);
    const env = speech ? 0.35 + 0.65 * Math.abs(Math.sin(i / 3.1) * Math.cos(i / 8.7)) : 0.06;
    const bh = Math.max(3, Math.round(h * env * (0.45 + 0.55 * rnd())));
    bars.push(`<rect x="${x}" y="${((h - bh) / 2).toFixed(1)}" width="5" height="${bh}" rx="2.5"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><g fill="${color}">${bars.join('')}</g></svg>`;
}

/** A browser tab with the favicon: the favicon's place in the identity set. */
export function browserTab() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 200">
<rect x="0" y="0" width="440" height="200" rx="18" fill="#171717" stroke="#262626" stroke-width="2"/>
<circle cx="30" cy="30" r="7" fill="#3A3A3A"/><circle cx="54" cy="30" r="7" fill="#3A3A3A"/><circle cx="78" cy="30" r="7" fill="#3A3A3A"/>
<path d="M24 60 Q24 52 32 52 L292 52 Q300 52 302 60 L306 84 L20 84 Z" fill="#262626"/>
<rect x="20" y="84" width="400" height="96" rx="0" fill="#262626"/>
<rect x="36" y="104" width="368" height="56" rx="28" fill="#171717"/>
</svg>`;
}
