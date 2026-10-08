/* Shared runtime: templating, store, motion system, icons, toasts. */
(function () {
  const { createElement, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useSyncExternalStore, Fragment } = React;
  const html = htm.bind(createElement);

  /* ---------- store ---------- */
  let state = {};
  const subs = new Set();
  const get = () => state;
  const set = (fn) => { const next = typeof fn === 'function' ? fn(state) : fn; state = { ...state, ...next }; subs.forEach((s) => s()); };
  const subscribe = (cb) => { subs.add(cb); return () => subs.delete(cb); };
  const useStore = (sel) => useSyncExternalStore(subscribe, () => sel(state));

  /* ---------- motion system ---------- */
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const D = { xs: 120, s: 200, m: 320, l: 480 };
  const E = { std: 'cubic-bezier(.2,0,0,1)', out: 'cubic-bezier(.16,1,.3,1)', in: 'cubic-bezier(.4,0,1,1)', spring: 'cubic-bezier(.34,1.56,.64,1)' };
  let SPEED = 1;
  function anim(el, frames, ms = D.m, ease = E.out, delay = 0) {
    if (!el) return Promise.resolve();
    if (reduce) return Promise.resolve();
    const a = el.animate(frames, { duration: ms * SPEED, easing: ease, delay: delay * SPEED, fill: 'backwards' });
    return a.finished.catch(() => {});
  }
  const motion = {
    D, E, anim,
    setSpeed: (s) => { SPEED = s; },
    speed: () => SPEED,
    enter: (el, { x = 0, y = 8, scale = 1, delay = 0, ms = D.m, ease = E.out } = {}) => (el && el.getAnimations && el.getAnimations().forEach((a) => a.cancel()), anim(el, [{ opacity: 0, transform: `translate(${x}px,${y}px) scale(${scale})` }, { opacity: 1, transform: 'none' }], ms, ease, delay)),
    exit: (el, { x = 0, y = 0, ms = D.s } = {}) => (reduce || !el ? Promise.resolve() : el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translate(${x}px,${y}px)` }], { duration: ms * SPEED, easing: E.in, fill: 'forwards' }).finished.catch(() => {})),
    stagger: (els, opts = {}, step = 30) => Promise.all([...els].map((el, i) => motion.enter(el, { ...opts, delay: (opts.delay || 0) + i * step }))),
    pop: (el) => anim(el, [{ transform: 'scale(.7)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], 520, E.spring),
    pulse: (el, color = 'rgba(255,90,31,.45)') => anim(el, [{ boxShadow: `0 0 0 0 ${color}` }, { boxShadow: '0 0 0 10px rgba(255,90,31,0)' }], 900, E.out),
    flash: (el) => anim(el, [{ boxShadow: 'inset 0 0 0 1px #FF5A1F, 0 0 0 3px rgba(255,90,31,.25)' }, { boxShadow: 'inset 0 0 0 1px transparent, 0 0 0 0 transparent' }], 800, E.std),
    rect: (el) => el.getBoundingClientRect(),
    flip: (el, from, ms = D.l) => {
      if (!el || !from || reduce) return Promise.resolve();
      const to = el.getBoundingClientRect();
      const dx = from.left - to.left, dy = from.top - to.top, sx = from.width / to.width, sy = from.height / to.height;
      el.style.transformOrigin = '0 0';
      return anim(el, [{ transform: `translate(${dx}px,${dy}px) scale(${sx},${sy})` }, { transform: 'none' }], ms, E.out);
    },
  };

  /* hook: animate children with data-enter when the component mounts */
  function useEnter(deps = []) {
    const ref = useRef(null);
    useLayoutEffect(() => {
      const root = ref.current; if (!root) return;
      const els = root.querySelectorAll('[data-enter]');
      els.forEach((el, i) => motion.enter(el, { y: Number(el.dataset.y || 8), x: Number(el.dataset.x || 0), delay: Number(el.dataset.delay || i * 30) }));
    }, deps);
    return ref;
  }

  /* ---------- icons ---------- */
  const P = {
    play: 'M5 3.5v9l7.5-4.5L5 3.5Z', back: 'M10 3.5 5.5 8l4.5 4.5', chevron: 'M4.5 6 8 9.5 11.5 6', plus: 'M8 3v10M3 8h10', close: 'm4 4 8 8M12 4l-8 8',
    check: 'm3.5 8.5 3 3 6-6.5', search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM11 11l3.5 3.5', bell: 'M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3L4 11ZM6.5 14h3',
    gear: 'M8 5.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4ZM8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3',
    folder: 'M2 4.5h4l1.5 1.5H14v6.5H2Z', upload: 'M8 11V3M5 6l3-3 3 3M3 13h10', download: 'M8 3v8M5 8l3 3 3-3M3 13h10', link: 'M7 9 9 7M6.5 7.5 4.6 9.4a2.1 2.1 0 0 0 3 3L9.5 10.5M9.5 8.5l1.9-1.9a2.1 2.1 0 0 0-3-3L6.5 5.5',
    globe: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12', video: 'M2 4h12v8H2ZM6.8 6.3v3.4L9.6 8Z', image: 'M2 3.5h12v9H2ZM3.5 11l3-3 2 2 1.5-1.5L12.5 11',
    comment: 'M3 3h10v7H7l-3 3v-3H3V3Z', hand: 'M5 8V4.5a1 1 0 0 1 2 0V8M7 7V3.5a1 1 0 0 1 2 0V7M9 7V4.5a1 1 0 0 1 2 0V10a4 4 0 0 1-4 4H6.5L3.5 10.5l1.2-1A1 1 0 0 1 6 9.6',
    cursor: 'M3 2.5 12.5 7 8 8.5 6.5 13 3 2.5Z', text: 'M3 3.5h10M8 3.5v9M6 12.5h4', crop: 'M4 1.5v10h10M1.5 4h10v10', drop: 'M10 2.5 13.5 6 6 13.5H2.5V10L10 2.5ZM8.5 4l3.5 3.5',
    eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8ZM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z', lock: 'M4.5 7.5h7v6h-7ZM6 7.5V5.5a2 2 0 0 1 4 0v2',
    refresh: 'M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3', trash: 'M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9', more: 'M4 8h.01M8 8h.01M12 8h.01',
    shield: 'M8 1.5 13.5 4v4c0 3.2-2.3 5.6-5.5 6.5C4.8 13.6 2.5 11.2 2.5 8V4L8 1.5ZM5.5 8l1.8 1.8L10.8 6.3', code: 'm5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5 14 8l-3.5 3.5',
    sparkle: 'M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2.1 2.1M10.5 10.5l2.1 2.1M12.6 3.4l-2.1 2.1M5.5 10.5l-2.1 2.1', chart: 'M2 13h12M4 10V7M8 10V3M12 10V5',
    grid: 'M2.5 2.5h4.5v4.5H2.5ZM9 2.5h4.5v4.5H9ZM2.5 9h4.5v4.5H2.5ZM9 9h4.5v4.5H9Z', list: 'M2.5 4h11M2.5 8h11M2.5 12h11', star: 'm8 2 1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5Z',
    alignL: 'M2.5 4h11M2.5 8h7M2.5 12h9', alignC: 'M2.5 4h11M4.5 8h7M3.5 12h9', alignR: 'M2.5 4h11M6.5 8h7M4.5 12h9', warn: 'M8 2 14.5 13.5h-13ZM8 6.5v3M8 11.5v.5',
    clock: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM8 4.5V8l2.5 1.5', terminal: 'M2.5 3.5h11v9h-11ZM5 6.5l2 1.5-2 1.5M8.5 10h2.5', key: 'M10 2.5a3.5 3.5 0 1 1-3.2 4.9L2.5 11.7v1.8h1.8l.7-.7v-1.3h1.3l1-1',
  };
  function Icon({ n, s = 15, w = 1.4, c = 'currentColor', fill }) {
    return html`<svg width=${s} height=${s} viewBox="0 0 16 16" fill=${fill || 'none'} stroke=${c} strokeWidth=${w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d=${P[n] || ''} /></svg>`;
  }
  const Logo = ({ onClick }) => html`<button className="logo" onClick=${onClick} aria-label="Motion Studio home"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 2.5v7l6-3.5-6-3.5Z" fill="#FF5A1F"/></svg></button>`;
  const CH = { IG: '#C13584', TT: '#111111', YT: '#E62117', FB: '#1877F2', LI: '#0A66C2', X: '#111111', PIN: '#E60023', AS: '#171717', GP: '#01875F' };
  const ChannelChip = ({ k, lg }) => html`<span className=${'ch' + (lg ? ' lg' : '')} style=${{ background: CH[k] || '#555' }}>${{ IG: 'IG', TT: 'TT', YT: 'YT', FB: 'f', LI: 'in', X: 'X', PIN: 'P', AS: 'A', GP: '▶' }[k] || k}</span>`;
  const Toggle = ({ on, onChange, sm, label }) => html`<button className=${'toggle' + (on ? ' on' : '') + (sm ? ' sm' : '')} role="switch" aria-checked=${on} aria-label=${label} onClick=${(e) => { e.stopPropagation(); onChange && onChange(!on); }}><i></i></button>`;
  const Check = ({ on, onChange, label }) => html`<button className=${'check' + (on ? ' on' : '')} role="checkbox" aria-checked=${on} aria-label=${label} onClick=${(e) => { e.stopPropagation(); onChange && onChange(!on); }}>${on ? html`<${Icon} n="check" s=${11} w=${2.2} c="#fff" />` : null}</button>`;
  const Spinner = ({ s = 14 }) => html`<svg className="spin" width=${s} height=${s} viewBox="0 0 16 16" fill="none" strokeWidth="2"><circle cx="8" cy="8" r="5.5" stroke="var(--line)"/><path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" stroke="#FF5A1F" strokeLinecap="round"/></svg>`;
  const Typing = () => html`<span className="typing"><i></i><i></i><i></i></span>`;

  /* ---------- toasts ---------- */
  let tid = 0;
  function toast(text, opts = {}) {
    const id = ++tid;
    set((s) => ({ toasts: [...(s.toasts || []), { id, text, ...opts }] }));
    if (!opts.sticky) setTimeout(() => dismissToast(id), (opts.ms || 3200) * Math.max(1, SPEED));
    return id;
  }
  function dismissToast(id) {
    const el = document.querySelector(`[data-toast="${id}"]`);
    const done = () => set((s) => ({ toasts: (s.toasts || []).filter((t) => t.id !== id) }));
    if (el) motion.exit(el, { y: -8, ms: D.s }).then(done); else done();
  }
  function Toasts() {
    const toasts = useStore((s) => s.toasts || []);
    return html`<div className="toasts">${toasts.map((t) => html`<${ToastItem} key=${t.id} t=${t} />`)}</div>`;
  }
  function ToastItem({ t }) {
    const ref = useRef(null);
    useLayoutEffect(() => { motion.enter(ref.current, { y: -16 }); }, []);
    return html`<div className="toast" ref=${ref} data-toast=${t.id} role="status">
      ${t.tone === 'ok' ? html`<span className="ok"><${Icon} n="check" s=${14} w=${2} /></span>` : html`<span className="dot" style=${{ color: '#FF5A1F' }}></span>`}
      <span>${t.text}</span>
      ${t.action ? html`<button className="btn sm accent" onClick=${() => { t.action.run(); dismissToast(t.id); }}>${t.action.label}</button>` : html`<span style=${{ width: 8 }}></span>`}
    </div>`;
  }

  /* ---------- timing helpers for the simulated agent ---------- */
  const wait = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));
  const now = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

  window.MS = { html, React, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, Fragment, get, set, useStore, motion, useEnter, Icon, Logo, ChannelChip, Toggle, Check, Spinner, Typing, toast, dismissToast, Toasts, wait, now };
})();
