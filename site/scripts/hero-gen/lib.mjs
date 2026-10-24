// The hero creatives' generator (site/scripts/hero-gen): small builders for Motion Studio compositions. The output is
// plain composition.json, meta.json and SVG assets, checked in under site/compositions/; a site test regenerates them and
// requires byte-identical files, so change this generator, not the JSON.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';


export const EASE = {
  expo: 'cubic-bezier(.16,1,.3,1)',
  quint: 'cubic-bezier(.22,1,.36,1)',
  back: 'cubic-bezier(.34,1.56,.64,1)',
  backSoft: 'cubic-bezier(.3,1.35,.6,1)',
  inOut: 'cubic-bezier(.83,0,.17,1)',
  in: 'cubic-bezier(.7,0,.84,0)',
  sine: 'cubic-bezier(.37,0,.63,1)',
  lin: 'linear',
};

// The site's own faces, and three display faces the gallery's creatives use (site/src/assets/fonts, SIL OFL).
export const FAM = { display: 'Bricolage Grotesque', body: 'Instrument Sans', mono: 'JetBrains Mono', serif: 'Fraunces', condensed: 'Anton', hand: 'Caveat' };
export const FILE = { display: 'BricolageGrotesque', body: 'InstrumentSans', mono: 'JetBrainsMono', serif: 'Fraunces', condensed: 'Anton', hand: 'Caveat' };

const r = (v) => Math.round(v * 1000) / 1000;

export function makeComp({ width, height, duration, background, scenes, fonts }) {
  const tracks = [];
  let seq = 0;
  const used = new Set();
  const uid = (p) => { let id; do id = `${p}-${++seq}`; while (used.has(id)); used.add(id); return id; };
  const track = (id, kind = 'visual') => { const t = { id, kind, clips: [] }; tracks.push(t); return t; };

  const sceneOf = (start, dur) => scenes.find((s) => start >= s.start - 1e-9 && start + dur <= s.start + s.duration + 1e-9)?.id;
  const base = (t, prefix, type, start, dur, props, anims, extra = {}) => {
    const clip = { id: uid(prefix), type, ...extra };
    const sc = sceneOf(start, dur);
    if (sc) clip.scene = sc;
    Object.assign(clip, { start: r(start), duration: r(dur), props: clean(props) });
    if (anims?.length) clip.animations = anims.map(cleanAnim);
    t.clips.push(clip);
    return clip;
  };
  return {
    track,
    text(t, name, start, dur, p, anims) {
      const fam = p.font ?? 'display';
      const lines = String(p.text).split('\n').length;
      return base(t, name, 'text', start, dur, {
        text: p.text, fontFamily: FAM[fam], fontWeight: p.weight ?? 800, color: p.color, fontSize: p.size,
        ...(p.align ? { align: p.align } : {}),
        x: p.x, y: p.y, width: p.w, height: p.h ?? r(lines * p.size * (fam === 'condensed' ? 1.5 : 1.32)),
        ...(p.rotation ? { rotation: p.rotation } : {}), ...(p.opacity !== undefined ? { opacity: p.opacity } : {}), ...(p.scale !== undefined ? { scale: p.scale } : {}),
      }, anims);
    },
    shape(t, name, start, dur, p, anims) {
      return base(t, name, 'shape', start, dur, {
        x: p.x, y: p.y, width: p.w, height: p.h, fill: p.fill, ...(p.radius ? { radius: p.radius } : {}),
        ...(p.rotation ? { rotation: p.rotation } : {}), ...(p.opacity !== undefined ? { opacity: p.opacity } : {}), ...(p.scale !== undefined ? { scale: p.scale } : {}),
      }, anims);
    },
    svg(t, name, start, dur, src, p, anims) {
      return base(t, name, 'svg', start, dur, {
        fit: p.fit ?? 'contain', x: p.x, y: p.y, width: p.w, height: p.h,
        ...(p.rotation ? { rotation: p.rotation } : {}), ...(p.opacity !== undefined ? { opacity: p.opacity } : {}), ...(p.scale !== undefined ? { scale: p.scale } : {}),
        ...(p.kenBurns ? { kenBurns: p.kenBurns } : {}),
      }, anims, { src: `assets/${src}` });
    },
    image(t, name, start, dur, src, p, anims) {
      return base(t, name, 'image', start, dur, {
        fit: p.fit ?? 'cover', x: p.x, y: p.y, width: p.w, height: p.h,
        ...(p.opacity !== undefined ? { opacity: p.opacity } : {}), ...(p.scale !== undefined ? { scale: p.scale } : {}),
      }, anims, { src: `assets/${src}` });
    },
    /** An audio clip (no props): `o` = { volume, fadeIn, fadeOut, trimStart, role, script }. */
    audio(t, name, start, dur, src, o = {}) {
      const clip = { id: uid(name), type: 'audio' };
      const sc = sceneOf(start, dur);
      if (sc) clip.scene = sc;
      Object.assign(clip, { start: r(start), duration: r(dur), src: `assets/${src}` });
      for (const k of ['trimStart', 'volume', 'fadeIn', 'fadeOut']) if (o[k] !== undefined) clip[k] = r(o[k]);
      if (o.role) clip.role = o.role;
      if (o.script) clip.script = o.script;
      t.clips.push(clip);
      return clip;
    },
    /** A number that counts up: one short text clip per value, the last one held to `end`. */
    counter(t, name, start, end, values, step, p, lastAnims = []) {
      values.forEach((v, i) => {
        const s = start + i * step;
        const last = i === values.length - 1;
        this.text(t, name, s, last ? end - s : step, { ...p, text: String(v) }, last ? lastAnims : []);
      });
    },
    build() {
      const families = new Map();
      for (const t of tracks) for (const c of t.clips) if (c.type === 'text' || c.type === 'subtitles') {
        const key = `${c.props.fontFamily}|${c.props.fontWeight}`;
        families.set(key, { family: c.props.fontFamily, weight: c.props.fontWeight });
      }
      const fontList = [...families.values()].sort((a, b) => (a.family + a.weight).localeCompare(b.family + b.weight)).map((f) => ({
        family: f.family, src: `assets/fonts/${Object.entries(FAM).map(([k, v]) => v === f.family ? FILE[k] : null).find(Boolean)}.woff2`, weight: f.weight,
      }));
      return {
        $schema: 'motion-studio/composition@1', width, height, fps: 30, duration, background,
        fonts: fonts ?? fontList,
        scenes: scenes.map((s) => ({ id: s.id, name: s.name, start: r(s.start), duration: r(s.duration) })),
        tracks: tracks.filter((t) => t.clips.length),
      };
    },
  };
}

function clean(o) { const out = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = typeof v === 'number' ? r(v) : v; return out; }
function cleanAnim(a) {
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined) continue;
    if (k === 'keyframes') out.keyframes = v.map((kf) => clean(kf));
    else out[k] = typeof v === 'number' ? r(v) : v;
  }
  return out;
}

// Animations (times relative to the clip start)
export const A = {
  fadeIn: (start = 0, duration = 0.4, ease) => ({ preset: 'fadeIn', start, duration, ease }),
  fadeOut: (duration = 0.4, ease) => ({ preset: 'fadeOut', duration, ease }),
  fadeOutAt: (start, duration = 0.4, ease) => ({ preset: 'fadeOut', start, duration, ease }),
  pop: (start = 0, duration = 0.5, ease) => ({ preset: 'popIn', start, duration, ease }),
  scaleIn: (start = 0, duration = 0.5, ease = EASE.back) => ({ preset: 'scaleIn', start, duration, ease }),
  wipe: (start = 0, duration = 0.6, ease = EASE.expo) => ({ preset: 'wipe', start, duration, ease }),
  tw: (prop, from, to, start = 0, duration = 0.6, ease = EASE.expo) => ({ prop, from, to, start, duration, ease }),
  /** keyframes: [[t, v, ease?], …] with t in 0..1 of `duration` */
  kf: (prop, frames, start = 0, duration = 1) => ({ prop, start, duration, keyframes: frames.map(([t, v, ease]) => (ease ? { t, v, ease } : { t, v })) }),
};

/** Writes one composition folder under `out` (site/compositions by default, see build.mjs). */
export function writeComposition(out, id, comp, meta, assets = {}) {
  const dir = join(out, id);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'composition.json'), `${JSON.stringify(comp, null, 2)}\n`);
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  // SVG text, or a file's bytes (a generated picture) copied as they are.
  for (const [name, data] of Object.entries(assets)) writeFileSync(join(dir, 'assets', name), typeof data === 'string' ? `${data.trim()}\n` : data);
}

// Text widths (px at 1000 px) measured in Chrome with the site's fonts (measure.mjs), kept in widths.json so the generator
// runs with plain node. A string not measured yet is queued in MISSING and estimated meanwhile.
import { readFileSync } from 'node:fs';
export const WIDTHS_FILE = new URL('widths.json', import.meta.url).pathname;
export const WIDTHS = JSON.parse(readFileSync(WIDTHS_FILE, 'utf8'));
export const MISSING = new Set();
// Fraunces has an optical-size axis: the browser draws it wider at small sizes, so its widths are measured at their size.
const OPTICAL = new Set(['serif']);
export function tw(text, size, font = 'display', weight = 800) {
  const key = `${FAM[font]}|${weight}${OPTICAL.has(font) ? `@${Math.round(size)}` : ''}|${text}`;
  if (key in WIDTHS) return (WIDTHS[key] * size) / 1000;
  MISSING.add(key);
  return text.length * size * 0.58;
}
