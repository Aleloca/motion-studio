// The home story's boards: Motion Studio's own launch video as the agent would make it, one composition per board state.
// Three directions (Night launch, Paper, Signal), Signal's versions (v2 bigger and louder, v3 edited by hand), the brand
// applied (v4) in three formats and three more languages, and v4 with subtitles. Every board shares one script: the brief
// typed (0-2.4 s), the title (2.4-6 s), the end card (6-8 s).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeComp, A, EASE, writeComposition, tw } from './lib.mjs';
import * as S from './story-assets.mjs';

const D = 8;
const SC = [
  { id: 'brief', name: 'Brief', start: 0, duration: 2.4 },
  { id: 'title', name: 'Title', start: 2.4, duration: 3.6 },
  { id: 'endcard', name: 'End card', start: 6, duration: 2 },
];
const POSTER = 4.6;

/** The words of each language. */
export const TEXT = {
  en: { brief: 'a launch video for Motion Studio', l1: 'Brief in.', l2: 'Motion out.', tag: 'Local. Open source. On top of Claude Code.' },
  it: { brief: 'un video di lancio per Motion Studio', l1: 'Entra il brief.', l2: 'Esce il motion.', tag: 'Locale. Open source. Sopra Claude Code.' },
  de: { brief: 'ein Launch-Video für Motion Studio', l1: 'Briefing rein.', l2: 'Motion raus.', tag: 'Lokal. Open Source. Auf Claude Code.' },
  es: { brief: 'un vídeo de lanzamiento para Motion Studio', l1: 'Entra el brief.', l2: 'Sale el motion.', tag: 'Local. Código abierto. Sobre Claude Code.' },
};

/**
 * `story-subs` speaks the launch film's subtitles line (site/scripts/audio-gen: the file, its length and its words' times,
 * in media.json) from `VOICE_AT`, and its subtitle set is that line in two cues, each word timed as spoken (milliseconds,
 * as the app writes a set from the voice-over).
 */
export const SUBS_LINE = 8;
export const VOICE_AT = 2.8;
const MEDIA_FILE = new URL('../audio-gen/media.json', import.meta.url);
const VOICE = existsSync(MEDIA_FILE) ? JSON.parse(readFileSync(MEDIA_FILE, 'utf8')).vo?.[SUBS_LINE] ?? null : null;
export const SUBTITLES = (() => {
  const words = (VOICE?.words ?? 'Subtitles stay in sync with the voice.'.split(' ').map((w, i) => ({ text: w, start: 0.1 + i * 0.32, end: 0.4 + i * 0.32 })))
    .map((w) => ({ start: Math.round((VOICE_AT + w.start) * 1000), end: Math.round((VOICE_AT + w.end) * 1000), text: w.text }));
  const half = Math.ceil(words.length / 2);
  const cues = [words.slice(0, half), words.slice(half)].map((ws, i, all) => ({
    start: i === 0 ? ws[0].start - 100 : ws[0].start, end: i === 0 ? all[1][0].start : ws.at(-1).end + 700, text: ws.map((w) => w.text).join(' '), words: ws,
  }));
  return { lang: 'en', cues };
})();

/** Types a line word by word: one short text clip per prefix, the last one held to `end`. */
function typed(c, t, name, start, end, text, p, step = 0.12, outro = []) {
  const words = text.split(' ');
  words.forEach((_, i) => {
    const s = start + i * step;
    const last = i === words.length - 1;
    c.text(t, name, s, last ? end - s : step, { ...p, text: words.slice(0, i + 1).join(' ') }, last ? outro : []);
  });
}

const exit = (len, d = 0.35) => [A.tw('blur', 0, 14, len - d, d, EASE.in), A.fadeOut(d)];

/* ---------------------------------------------------------------- the three directions (16:9) */

function night() {
  const C = { bg: '#120D2B', text: '#F3EEFF', soft: '#B9A6FF', muted: '#9C92C8' };
  const c = makeComp({ width: 1920, height: 1080, duration: D, background: C.bg, scenes: SC });
  const bg = c.track('backdrop'); const type = c.track('type', 'text');
  c.svg(bg, 'stars', 0, D, 'stars.svg', { x: 0, y: 0, w: 1920, h: 1080, fit: 'cover', kenBurns: { from: { scale: 1 }, to: { scale: 1.08 } } }, [A.fadeIn(0, 1.2)]);
  c.svg(bg, 'glow', 0, D, 'glow.svg', { x: 360, y: -140, w: 1200, h: 1200 }, [A.fadeIn(0, 1.4, EASE.sine), A.kf('scale', [[0, 0.9], [0.5, 1.06, EASE.sine], [1, 0.9, EASE.sine]], 0, D)]);
  const t = TEXT.en;
  const bw = tw(t.brief, 34, 'mono', 400);
  typed(c, type, 'brief', 0.3, 2.4, t.brief, { font: 'mono', weight: 400, size: 34, color: C.muted, x: (1920 - bw) / 2, y: 500, w: bw + 40 }, 0.14, exit(2.4 - 0.3 - 5 * 0.14));
  c.text(type, 'brief-in', 2.5, 3.5, { weight: 300, size: 168, color: C.text, text: t.l1, align: 'center', x: 0, y: 320, w: 1920 }, [A.fadeIn(0, 0.8), A.tw('y', 40, 0, 0, 1.2), A.tw('blur', 24, 0, 0, 1), ...exit(3.5)]);
  c.text(type, 'motion-out', 2.9, 3.1, { weight: 300, size: 168, color: C.soft, text: t.l2, align: 'center', x: 0, y: 520, w: 1920 }, [A.fadeIn(0, 0.8), A.tw('y', 40, 0, 0, 1.2), A.tw('blur', 24, 0, 0, 1), ...exit(3.1)]);
  c.text(type, 'name', 6.1, 1.9, { weight: 300, size: 132, color: C.text, text: 'Motion Studio', align: 'center', x: 0, y: 390, w: 1920 }, [A.fadeIn(0, 0.7), A.tw('blur', 20, 0, 0, 0.8)]);
  c.text(type, 'tag', 6.4, 1.6, { font: 'body', weight: 400, size: 40, color: C.muted, text: t.tag, align: 'center', x: 0, y: 590, w: 1920 }, [A.fadeIn(0, 0.6), A.tw('y', 16, 0, 0, 0.8)]);
  return { comp: c.build(), assets: { 'stars.svg': S.stars(C.soft), 'glow.svg': S.glow('#7B5CFF') } };
}

function paper() {
  const C = { bg: '#F3EFE6', ink: '#161616', blue: '#2B4CFF', muted: '#6B655A' };
  const c = makeComp({ width: 1920, height: 1080, duration: D, background: C.bg, scenes: SC });
  const bg = c.track('marks'); const type = c.track('type', 'text');
  for (const [x, y] of [[60, 60], [1740, 60], [60, 900], [1740, 900]]) c.svg(bg, 'register', 0.1, D - 0.1, 'register.svg', { x, y, w: 120, h: 120 }, [A.fadeIn(0, 0.5), A.tw('rotation', -90, 0, 0, 1.2)]);
  c.shape(bg, 'rule', 0.2, D - 0.2, { x: 150, y: 290, w: 1620, h: 4, fill: C.ink }, [A.wipe(0, 1.1, EASE.inOut)]);
  const t = TEXT.en;
  typed(c, type, 'brief', 0.4, 2.4, t.brief, { font: 'mono', weight: 400, size: 30, color: C.muted, x: 150, y: 210, w: 1200 }, 0.14, exit(2.4 - 0.4 - 5 * 0.14));
  c.text(type, 'brief-in', 2.5, 3.5, { font: 'body', weight: 600, size: 184, color: C.ink, text: t.l1, x: 140, y: 340, w: 1640 }, [A.wipe(0, 0.8, EASE.quint), ...exit(3.5)]);
  c.text(type, 'motion-out', 2.85, 3.15, { font: 'body', weight: 600, size: 184, color: C.blue, text: t.l2, x: 140, y: 560, w: 1640 }, [A.wipe(0, 0.8, EASE.quint), ...exit(3.15)]);
  c.text(type, 'name', 6.1, 1.9, { font: 'body', weight: 600, size: 150, color: C.ink, text: 'Motion Studio', x: 140, y: 380, w: 1640 }, [A.wipe(0, 0.7, EASE.quint)]);
  c.text(type, 'tag', 6.4, 1.6, { font: 'body', weight: 400, size: 42, color: C.muted, text: t.tag, x: 150, y: 600, w: 1640 }, [A.fadeIn(0, 0.6), A.tw('x', -20, 0, 0, 0.8)]);
  return { comp: c.build(), assets: { 'register.svg': S.register(C.ink) } };
}

/** Signal and its versions. v1 the direction as made; v2 "bigger, more energy"; v3 moved, resized and recoloured by hand. */
export const SIGNAL = {
  v1: { x: 160, y1: 380, y2: 530, size: 120, accent: '#2DD4BF', slam: false },
  v2: { x: 160, y1: 300, y2: 480, size: 168, accent: '#2DD4BF', slam: true },
  v3: { x: 120, y1: 470, y2: 650, size: 150, accent: '#FACC15', slam: true },
};

function signal(v) {
  const L = SIGNAL[v];
  const C = { bg: '#0B1D2A', text: '#E8F1F2', teal: '#2DD4BF', muted: '#7FA9B5' };
  const c = makeComp({ width: 1920, height: 1080, duration: D, background: C.bg, scenes: SC });
  const bg = c.track('backdrop'); const fx = c.track('signal'); const type = c.track('type', 'text');
  c.svg(bg, 'grid', 0, D, 'grid.svg', { x: 0, y: 0, w: 1920, h: 1080, fit: 'cover', opacity: 0.6, kenBurns: { from: { scale: 1.06 }, to: { scale: 1 } } }, [A.fadeIn(0, 0.8)]);
  c.shape(fx, 'scan', 0, 2.4, { x: 0, y: 0, w: 1920, h: 3, fill: C.teal, opacity: 0.8 }, [A.tw('y', 0, 1077, 0, 2.4, EASE.lin), A.fadeOut(0.3)]);
  const quick = L.slam ? 0.55 : 1;
  for (const [i, s] of [2.2, 2.2 + 0.9 * quick, 2.2 + 1.8 * quick, 2.2 + 2.7 * quick].entries()) {
    c.svg(fx, 'ring', s, 1.8, 'rings.svg', { x: 1180, y: 220, w: 640, h: 640 }, [A.tw('scale', 0.2, 1.15 + (i % 2) * 0.1, 0, 1.8, EASE.quint), A.kf('opacity', [[0, 0], [0.12, 0.9], [1, 0, EASE.sine]], 0, 1.8)]);
  }
  const t = TEXT.en;
  typed(c, type, 'brief', 0.25, 2.4, `> ${t.brief}`, { font: 'mono', weight: 500, size: 32, color: C.teal, x: 160, y: 190, w: 1400 }, 0.12, exit(2.4 - 0.25 - 6 * 0.12));
  const w2 = tw(t.l2, L.size, 'mono', 800);
  if (L.slam) {
    c.shape(fx, 'flash', 2.4, 0.5, { x: 0, y: 0, w: 1920, h: 1080, fill: L.accent }, [A.kf('opacity', [[0, 0], [0.15, 0.35], [1, 0, EASE.expo]], 0, 0.5)]);
    c.shape(fx, 'bar', 2.75, 3.25, { x: L.x - 24, y: L.y2 + L.size * 0.12, w: w2 + 48, h: L.size * 1.1, fill: `${L.accent}2E` }, [A.wipe(0, 0.3, EASE.expo), ...exit(3.25)]);
  }
  const enter = L.slam
    ? [A.fadeIn(0, 0.12), A.tw('scale', 1.35, 1, 0, 0.45, EASE.back), A.tw('blur', 20, 0, 0, 0.3)]
    : [A.fadeIn(0, 0.5), A.tw('x', -40, 0, 0, 0.9), A.tw('blur', 12, 0, 0, 0.6)];
  c.text(type, 'brief-in', 2.5, 3.5, { font: 'mono', weight: 800, size: L.size, color: C.text, text: t.l1, x: L.x, y: L.y1, w: w2 + 40 }, [...enter, ...exit(3.5)]);
  c.text(type, 'motion-out', 2.5 + 0.4 * quick, 3.5 - 0.4 * quick, { font: 'mono', weight: 800, size: L.size, color: L.accent, text: t.l2, x: L.x, y: L.y2, w: w2 + 40 }, [...enter, ...exit(3.5 - 0.4 * quick)]);
  c.text(type, 'name', 6.1, 1.9, { font: 'mono', weight: 800, size: 104, color: C.text, text: 'MOTION STUDIO', x: 160, y: 400, w: 1600 }, [A.fadeIn(0, 0.3), A.tw('x', -30, 0, 0, 0.7)]);
  c.text(type, 'tag', 6.35, 1.65, { font: 'mono', weight: 500, size: 34, color: C.muted, text: t.tag, x: 164, y: 560, w: 1600 }, [A.wipe(0, 0.8)]);
  return { comp: c.build(), assets: { 'grid.svg': S.grid('#15364A'), 'rings.svg': S.rings(L.accent) } };
}

/* ---------------------------------------------------------------- the brand applied (v4): formats, languages, subtitles */

const B = { bg: '#0F0F0F', text: '#F5F1EC', orange: '#FF5A1F', muted: '#A3A3A3', dot: '#262626' };
const LOGO_RATIO = 1720 / 322;
const MARK_RATIO = 360 / 320;

/** Per-format layout of the branded film. The 16:9 keeps v3's hand-made position. */
export const BRAND = {
  '16x9': { w: 1920, h: 1080, format: 'youtube-16x9', mark: { x: 1340, y: 300, w: 440 }, brief: { x: 120, y: 196, size: 34 }, title: { x: 120, y1: 470, gap: 1.06, size: 184, box: 1680 }, logo: { w: 1100, y: 330 }, tag: { y: 720, size: 44 } },
  '9x16': { w: 1080, h: 1920, format: 'instagram-reel-9x16', mark: { x: 100, y: 400, w: 340 }, brief: { x: 100, y: 800, size: 32, w: 860 }, title: { x: 100, y1: 980, gap: 1.06, size: 172, box: 860 }, logo: { w: 860, y: 820 }, tag: { y: 1060, size: 34 } },
  '1x1': { w: 1080, h: 1080, format: 'instagram-post-1x1', mark: { x: 90, y: 90, w: 230 }, brief: { x: 90, y: 360, size: 30, w: 900 }, title: { x: 90, y1: 520, gap: 1.06, size: 172, box: 900 }, logo: { w: 880, y: 380 }, tag: { y: 650, size: 36 } },
};

/** The title's font size in a format: the layout's size, smaller only where a line would leave its box. */
export function titleSize(key, lang = 'en') {
  const T = BRAND[key].title; const t = TEXT[lang];
  const widest = Math.max(tw(t.l1, 1000), tw(t.l2, 1000));
  return Math.min(T.size, Math.floor((T.box / widest) * 1000));
}

/** The title card's backdrop, generated in the story's Generate step (site/scripts/audio-gen), in its small copy. */
const BACKDROP = 'generated-backdrop-960.jpg';
const BACKDROP_FILE = new URL(`../../compositions/launch-16x9/assets/${BACKDROP}`, import.meta.url);

function brand(key, lang = 'en', { subtitles = false, backdrop = false } = {}) {
  const L = BRAND[key]; const { w, h } = L; const t = TEXT[lang];
  const c = makeComp({ width: w, height: h, duration: D, background: B.bg, scenes: SC });
  const bg = c.track('backdrop'); const mark = c.track('mark'); const type = c.track('type', 'text');
  // From the Generate step on, the generated backdrop sits under the dot grid, dimmed so the title reads over it.
  if (backdrop) c.image(bg, 'backdrop', 0, D, BACKDROP, { x: 0, y: 0, w, h, fit: 'cover', opacity: 0.55 }, [A.fadeIn(0, 0.8)]);
  c.svg(bg, 'dots', 0, D, 'dots.svg', { x: 0, y: 0, w, h, fit: 'cover', opacity: 0.9, kenBurns: { from: { scale: 1 }, to: { scale: 1.05 } } }, [A.fadeIn(0, 0.8)]);
  // The logo's three frames, drawn in the order the product works: draft, composition, video.
  const M = L.mark; const mh = M.w / MARK_RATIO;
  const out = (s) => [A.tw('blur', 0, 14, 6 - s - 0.35, 0.35, EASE.in), A.fadeOut(0.35)];
  c.svg(mark, 'draft', 0.2, 5.8, 'frame-draft.svg', { x: M.x, y: M.y, w: M.w, h: mh }, [A.fadeIn(0, 0.4), A.tw('scale', 0.7, 1, 0, 0.7), ...out(0.2)]);
  c.svg(mark, 'composition', 0.8, 5.2, 'frame-comp.svg', { x: M.x, y: M.y, w: M.w, h: mh }, [A.wipe(0, 0.6, EASE.inOut), ...out(0.8)]);
  c.svg(mark, 'video', 1.4, 4.6, 'frame-video.svg', { x: M.x, y: M.y, w: M.w, h: mh }, [A.pop(0, 0.5, EASE.back), ...out(1.4)]);
  const bp = L.brief;
  typed(c, type, 'brief', 0.3, 2.4, t.brief, { font: 'mono', weight: 400, size: bp.size, color: B.muted, x: bp.x, y: bp.y, w: bp.w ?? w - bp.x - 80 }, 0.13, exit(2.4 - 0.3 - (t.brief.split(' ').length - 1) * 0.13));
  const T = L.title; const size = titleSize(key, lang);
  const lineIn = [A.fadeIn(0, 0.2), A.tw('y', size * 0.5, 0, 0, 0.7, EASE.expo), A.tw('blur', 16, 0, 0, 0.45)];
  c.text(type, 'brief-in', 2.5, 3.5, { size, color: B.text, text: t.l1, x: T.x, y: T.y1, w: T.box }, [...lineIn, ...exit(3.5)]);
  c.text(type, 'motion-out', 2.8, 3.2, { size, color: B.orange, text: t.l2, x: T.x, y: T.y1 + size * T.gap, w: T.box }, [...lineIn, ...exit(3.2)]);
  const lw = L.logo.w; const lh = lw / LOGO_RATIO;
  c.svg(mark, 'logo', 6.05, 1.95, 'logo.svg', { x: (w - lw) / 2, y: L.logo.y, w: lw, h: lh }, [A.fadeIn(0, 0.4), A.tw('scale', 0.92, 1, 0, 0.8), A.tw('blur', 16, 0, 0, 0.5)]);
  c.text(type, 'tag', 6.35, 1.65, { font: 'body', weight: 400, size: L.tag.size, color: B.muted, text: t.tag, align: 'center', x: 0, y: L.tag.y, w }, [A.fadeIn(0, 0.5), A.tw('y', 16, 0, 0, 0.8)]);
  if (subtitles && VOICE) {
    c.audio(c.track('voice', 'audio'), 'voice', VOICE_AT, VOICE.duration, `audio/${VOICE.file}`, { role: 'voice', script: VOICE.text });
  }
  if (subtitles) {
    const sub = c.track('subtitles', 'subtitles');
    sub.clips.push({ id: 'lines', type: 'subtitles', start: 0, duration: D, props: {
      fontFamily: 'Instrument Sans', fontSize: 62, fontWeight: 600, color: B.text, align: 'center', position: 'bottom', margin: 40, maxWidth: 0.7,
      background: '#0F0F0FD9', boxPadding: 16, boxRadius: 12, highlight: { color: B.orange }, entrance: 'fade', entranceSec: 0.15,
    } });
  }
  return {
    comp: c.build(),
    assets: {
      'dots.svg': S.dots(w, h, B.dot), 'frame-draft.svg': S.frameDraft, 'frame-comp.svg': S.frameComp, 'frame-video.svg': S.frameVideo, 'logo.svg': S.logo,
      ...(backdrop ? { [BACKDROP]: readFileSync(BACKDROP_FILE) } : {}),
    },
  };
}

/* ---------------------------------------------------------------- the boards */

export const STORY = [
  { id: 'story-night', make: night, format: 'youtube-16x9', label: 'Variant A, Night launch: “Brief in. Motion out.” in light violet type over a starfield, a 16:9 draft of the Motion Studio launch video.' },
  { id: 'story-paper', make: paper, format: 'youtube-16x9', label: 'Variant B, Paper: the launch title set in ink and blue on warm paper with printer’s marks, 16:9.' },
  { id: 'story-signal-v1', make: () => signal('v1'), format: 'youtube-16x9', label: 'Variant C, Signal: the launch title in teal monospace over a navy grid with broadcast rings, 16:9.' },
  { id: 'story-signal-v2', make: () => signal('v2'), format: 'youtube-16x9', label: 'Signal v2: the same title 40% larger, slammed in over a teal flash.' },
  { id: 'story-signal-v3', make: () => signal('v3'), format: 'youtube-16x9', label: 'Signal v3, edited by hand: the title moved lower, resized, “Motion out.” recoloured yellow.' },
  { id: 'story-brand-16x9', make: () => brand('16x9'), format: 'youtube-16x9', label: 'v4 with the Motion Studio brand: the logo’s three frames, “Brief in.” in cream and “Motion out.” in orange on the dark dot grid, 16:9.' },
  { id: 'story-backdrop-16x9', make: () => brand('16x9', 'en', { backdrop: true }), format: 'youtube-16x9', label: 'v5: the generated backdrop, warm light through haze and floating frames, behind “Brief in. Motion out.”, 16:9.' },
  { id: 'story-brand-9x16', make: () => brand('9x16', 'en', { backdrop: true }), format: 'instagram-reel-9x16', label: 'The launch title with its backdrop recomposed for a 9:16 Reel: the mark on top, the title stacked below.' },
  { id: 'story-brand-1x1', make: () => brand('1x1', 'en', { backdrop: true }), format: 'instagram-post-1x1', label: 'The launch title with its backdrop recomposed for a 1:1 post.' },
  { id: 'story-it', make: () => brand('16x9', 'it', { backdrop: true }), format: 'youtube-16x9', label: 'The 16:9 in Italian: “Entra il brief. Esce il motion.”, same layout, timing and colours.' },
  { id: 'story-de', make: () => brand('16x9', 'de', { backdrop: true }), format: 'youtube-16x9', label: 'The 16:9 in German: “Briefing rein. Motion raus.”, inside the same box.' },
  { id: 'story-es', make: () => brand('16x9', 'es', { backdrop: true }), format: 'youtube-16x9', label: 'The 16:9 in Spanish: “Entra el brief. Sale el motion.”, inside the same box.' },
  { id: 'story-subs', make: () => brand('16x9', 'en', { subtitles: true, backdrop: true }), format: 'youtube-16x9', label: 'v6: the 16:9 with its voice-over and the subtitles drawn from it, each word lit in orange as it is spoken.' },
];
export const STORY_IDS = STORY.map((s) => s.id);

export function writeStory(out) {
  for (const s of STORY) {
    const { comp, assets } = s.make();
    writeComposition(out, s.id, comp, { format: s.format, posterTime: POSTER, label: s.label }, assets);
    // The subtitle set lives beside the composition, as in a creative; the site build inlines it in the runtime page.
    if (comp.tracks.some((t) => t.kind === 'subtitles')) writeFileSync(join(out, s.id, 'subtitles.json'), `${JSON.stringify(SUBTITLES, null, 2)}\n`);
  }
}
