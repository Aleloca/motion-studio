// The launch film's layout engine, on top of the hero generator's builders (../hero-gen/lib.mjs). A composition has no
// groups, and two animations of one property on a clip do not add up (the later one wins), so this engine keeps the
// moves of a group (a board, a panel) and the moves of each element apart, then writes one animation per property and
// clip whose keyframes are their sum: x = (cx − pivot) · (s − 1) + tx + dx · s, scale = s · ls, opacity = o · lo,
// blur = gblur + lblur. Within a clip, the segments that move one property must not overlap in time (the build fails
// otherwise), so each keyframe interval keeps the easing of the one segment that moves it, exactly.
import { makeComp } from '../hero-gen/lib.mjs';

const EPS = 1e-6;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** One animated value: an initial value and non-overlapping segments { t0, t1, to, ease } on the composition timeline. */
function lane(init) {
  const l = {
    init, segs: [],
    seg(t0, d, to, ease) {
      const s = { t0, t1: t0 + d, to, ease, lane: l };
      for (const o of l.segs) if (s.t0 < o.t1 - EPS && o.t0 < s.t1 - EPS) throw new Error(`overlapping segments on ${l.name}: ${o.t0}–${o.t1} and ${s.t0}–${s.t1}`);
      l.segs.push(s);
      l.segs.sort((a, b) => a.t0 - b.t0);
    },
    /** The value at `t`, which must not be inside one of this lane's segments. */
    at(t) { let v = l.init; for (const s of l.segs) if (s.t1 <= t + EPS) v = s.to; return v; },
  };
  return l;
}

export function stage(spec) {
  const c = makeComp(spec);
  const nodes = [];

  /** A group: local coordinates (w × h) drawn at (x, y) with scale k; it moves (tx, ty), scales (s, about `pivot`), fades and blurs as one. */
  function group({ x = 0, y = 0, k = 1, w = spec.width, h = spec.height, pivot } = {}) {
    const g = {
      x, y, k, w, h, pivot: pivot ?? [x + (w * k) / 2, y + (h * k) / 2],
      v: { tx: lane(0), ty: lane(0), s: lane(1), o: lane(1), blur: lane(0) },
      /** Animates to absolute values of tx, ty, s, o, blur. */
      to(t, d, vals, ease) { for (const [key, val] of Object.entries(vals)) g.v[key].seg(t, d, val, ease); return g; },
      set(vals) { for (const [key, val] of Object.entries(vals)) g.v[key].init = val; return g; },
      gx: (lx) => x + lx * k, gy: (ly) => y + ly * k,
    };
    for (const [n, l] of Object.entries(g.v)) l.name = `group.${n}`;
    return g;
  }
  const ROOT = group();

  function node(kind, track, name, start, dur, g, p, src) {
    g ??= ROOT;
    const k = g.k;
    const P = { ...p, x: g.gx(p.x ?? 0), y: g.gy(p.y ?? 0), w: (p.w ?? 0) * k };
    if (p.h !== undefined) P.h = p.h * k;
    if (kind === 'text') {
      P.size = p.size * k;
      if (P.h === undefined) P.h = String(p.text).split('\n').length * P.size * 1.32;
    }
    if (p.radius !== undefined) P.radius = p.radius * k;
    const n = {
      kind, track, name, start, end: start + dur, g, P, src, k, raw: [],
      l: { dx: lane(0), dy: lane(0), s: lane(1), o: lane(1), blur: lane(0) },
      /** Initial local values: dx, dy in the group's local units; s, o, blur. */
      init(vals) { for (const [key, val] of Object.entries(vals)) n.l[key].init = key === 'dx' || key === 'dy' ? val * k : val; return n; },
      /** Animates to absolute local values (dx, dy in local units). */
      to(t, d, vals, ease) { for (const [key, val] of Object.entries(vals)) n.l[key].seg(t, d, key === 'dx' || key === 'dy' ? val * k : val, ease); return n; },
      /** A raw animation (wipe preset, color or rotation tween) with an absolute start. */
      anim(a) {
        if (a.prop && !['color', 'rotation'].includes(a.prop)) throw new Error(`${name}: raw animation of ${a.prop}`);
        if (a.preset && a.preset !== 'wipe') throw new Error(`${name}: raw preset ${a.preset}`);
        n.raw.push(a); return n;
      },
      fadeIn(t, d = 0.4, ease) { n.l.o.init = 0; return n.to(t, d, { o: 1 }, ease); },
      fadeOut(d = 0.35, ease, at) { return n.to(at ?? n.end - d, d, { o: 0 }, ease); },
    };
    for (const [m, l] of Object.entries(n.l)) l.name = `${name}.${m}`;
    n.cx = P.x + P.w / 2;
    n.cy = P.y + (P.h ?? 0) / 2;
    nodes.push(n);
    return n;
  }

  /** Writes every node's clip, in creation order (the stacking order within a track). */
  function build() {
    for (const n of nodes) {
      const g = n.g; const [px, py] = g.pivot;
      const val = (lane, t) => lane.at(t);
      const props = {
        x: { deps: [g.v.s, g.v.tx, n.l.dx], f: (t) => (n.cx - px) * (val(g.v.s, t) - 1) + val(g.v.tx, t) + val(n.l.dx, t) * val(g.v.s, t), neutral: 0 },
        y: { deps: [g.v.s, g.v.ty, n.l.dy], f: (t) => (n.cy - py) * (val(g.v.s, t) - 1) + val(g.v.ty, t) + val(n.l.dy, t) * val(g.v.s, t), neutral: 0 },
        scale: { deps: [g.v.s, n.l.s], f: (t) => val(g.v.s, t) * val(n.l.s, t), neutral: 1 },
        opacity: { deps: [g.v.o, n.l.o], f: (t) => val(g.v.o, t) * val(n.l.o, t), neutral: 1 },
        blur: { deps: [g.v.blur, n.l.blur], f: (t) => val(g.v.blur, t) + val(n.l.blur, t), neutral: 0 },
      };
      const anims = [];
      for (const [prop, { deps, f, neutral }] of Object.entries(props)) {
        const all = deps.flatMap((l) => l.segs).filter((s) => s.t1 > n.start + EPS && s.t0 < n.end - EPS).sort((a, b) => a.t0 - b.t0);
        for (const s of all) if (s.t0 < n.start - EPS || s.t1 > n.end + 1 / 60) throw new Error(`${n.name} [${n.start}–${n.end}]: ${s.lane.name} segment ${s.t0}–${s.t1} crosses the clip`);
        // Segments of one side (all group, or all the clip's own) with the same times and easing move the property as one:
        // the value is affine in each of them, so their sum follows the same easing.
        const segs = [];
        for (const s of all) {
          const same = segs.find((o) => Math.abs(o.t0 - s.t0) < EPS && Math.abs(o.t1 - s.t1) < EPS && o.ease === s.ease && o.group === s.lane.name.startsWith('group.'));
          if (same) same.lanes.push(s.lane);
          else segs.push({ t0: s.t0, t1: s.t1, ease: s.ease, lane: s.lane, lanes: [s.lane], group: s.lane.name.startsWith('group.') });
        }
        for (let i = 1; i < segs.length; i++) if (segs[i].t0 < segs[i - 1].t1 - EPS) throw new Error(`${n.name}.${prop}: ${segs[i - 1].lane.name} ${segs[i - 1].t0}–${segs[i - 1].t1} overlaps ${segs[i].lane.name} ${segs[i].t0}–${segs[i].t1}`);
        if (!segs.length) {
          const v = f(n.start);
          if (Math.abs(v - neutral) > 1e-4) anims.push({ prop, from: v, to: v, start: 0, duration: n.end - n.start });
          continue;
        }
        const pts = [];
        for (const s of segs) {
          const t1 = Math.min(s.t1, n.end);
          const a = { t: s.t0, v: f(s.t0), ease: s.ease ?? 'linear' };
          if (pts.length && Math.abs(pts.at(-1).t - a.t) < EPS) pts[pts.length - 1].ease = a.ease; else pts.push(a);
          pts.push({ t: t1, v: f(s.t1), ease: 'linear' });
        }
        const t0 = pts[0].t; const span = pts.at(-1).t - t0;
        if (pts.length === 2) anims.push({ prop, from: pts[0].v, to: pts[1].v, start: t0 - n.start, duration: span, ease: pts[0].ease });
        else {
          if (pts.length > 64) throw new Error(`${n.name}.${prop}: ${pts.length} keyframes`);
          let last = 0;
          const keyframes = pts.map((p, i) => {
            let t = i === pts.length - 1 ? 1 : r3((p.t - t0) / span);
            if (t < last) t = last; last = t;
            return [t, p.v, p.ease === 'linear' ? undefined : p.ease];
          });
          anims.push({ prop, start: t0 - n.start, duration: span, keyframes: keyframes.map(([t, v, ease]) => (ease ? { t, v, ease } : { t, v })) });
        }
      }
      for (const a of n.raw) anims.push({ ...a, start: (a.start ?? n.start) - n.start });
      anims.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
      if (anims.length > 32) throw new Error(`${n.name}: ${anims.length} animations`);
      const dur = n.end - n.start;
      if (n.kind === 'text') c.text(n.track, n.name, n.start, dur, n.P, anims);
      else if (n.kind === 'shape') c.shape(n.track, n.name, n.start, dur, n.P, anims);
      else c.svg(n.track, n.name, n.start, dur, n.src, n.P, anims);
    }
    return c.build();
  }

  return {
    c, ROOT, group, build,
    text: (track, name, start, dur, g, p) => node('text', track, name, start, dur, g, p),
    shape: (track, name, start, dur, g, p) => node('shape', track, name, start, dur, g, p),
    svg: (track, name, start, dur, g, src, p) => node('svg', track, name, start, dur, g, p, src),
  };
}
