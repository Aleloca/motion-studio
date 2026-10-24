// The live story: the page is Motion Studio's canvas. One GSAP timeline, scrubbed by the scroll through the story section
// (CSS sticky, no scroll-jacking), moves the camera over a fixed world of boards and brings each step's change in place;
// a render pass reads the timeline's time for everything that is a state rather than a tween (the step, the chat, the
// composer's typing, the cursor, the inspector's values, the export's progress). The boards are real compositions: their
// players are driven here by step (only the boards of the step on screen play), never by their own observers.
import { cameraFit, framingAt, lerp, clamp, stepAt, typedAt, parseSteps, inSteps } from './story-logic.js';

export const STEPS = 10;
/** Timeline units after the last step, so the final state holds before the canvas scrolls away. */
const HOLD = 0.6;

/** Camera framings in world units, in the order of `FRAMES`; the phone's frame tighter in a portrait canvas. */
const FRAMES = ['intro', 'variants', 'choose', 'c', 'edit', 'brand', 'formats', 'langs', 'subs', 'identity', 'all'];
const WIDE = {
  intro: [-40, -70, 1640, 380], variants: [-40, -70, 1640, 400], choose: [-40, -70, 1640, 400], c: [930, -80, 780, 420],
  edit: [1040, -70, 850, 560], brand: [520, -70, 1080, 380], formats: [1040, -70, 1060, 380], langs: [1040, -70, 1220, 650],
  subs: [520, -70, 1080, 380], identity: [1040, 580, 940, 370], all: [1040, -90, 1240, 1040],
};
const NARROW = {
  intro: [-20, -60, 520, 330], variants: [1060, -60, 520, 330], choose: [1060, -60, 520, 330], c: [1060, -60, 520, 330],
  edit: [1060, -50, 520, 860], brand: [1060, -370, 520, 660], formats: [1060, -50, 520, 660], langs: [1060, 610, 520, 980],
  subs: [1060, -370, 520, 660], identity: [1060, 1590, 520, 640], all: [1060, -50, 520, 660],
};
/** Which boards play in each step (the others hold their poster or are unmounted). */
const LIVE = {
  1: ['a', 'b', 'c'], 2: ['a', 'b', 'c'], 3: ['c'], 4: ['c'], 5: ['c'], 6: ['c', 'f916', 'f11'], 7: ['c', 'f916', 'f11', 'it', 'de', 'es'],
  8: ['c'], 9: ['identity'], 10: ['c'],
};
/** Board C's version label over time, with the agent's render turns before each new version. */
const VERSIONS = [[0, 'v1'], [2.48, 'v2'], [3.93, 'v3'], [4.74, 'v4'], [7.58, 'v5']];
const RENDERING = [[2.06, 2.48], [4.22, 4.74], [7.12, 7.58]];

export function startStory({ gsap, ScrollTrigger, players }) {
  const story = document.querySelector('.story');
  const pin = story.querySelector('.story__pin');
  const stage = story.querySelector('[data-stage]');
  const world = stage.querySelector('.world');
  const intro = story.querySelector('.intro');
  const narrowQuery = matchMedia('(max-width: 959px)');
  const $ = (sel, root = stage) => root.querySelector(sel);
  const $$ = (sel, root = stage) => [...root.querySelectorAll(sel)];
  const board = (id) => $(`[data-board="${id}"]`);

  const steps = [...story.querySelectorAll('.step')].map(readStep);
  const chat = buildChat(steps, story.querySelector('.story__note')?.textContent ?? '');
  pin.append(chat.el);

  /* ---------------------------------------------------------------- the camera */
  const cam = { k: 0 };
  let size = { w: 0, h: 0, introH: 0, sheet: 0 };
  const measure = () => {
    const r = stage.getBoundingClientRect();
    const narrow = narrowQuery.matches;
    size = {
      w: r.width, h: r.height, narrow,
      introH: intro.offsetHeight,
      // The bottom sheet covers the canvas: frame above it.
      sheet: narrow ? Math.max(0, r.bottom - chat.el.getBoundingClientRect().top) : 0,
    };
  };
  let scale = 1;
  const applyCamera = () => {
    const table = size.narrow ? NARROW : WIDE;
    const rect = framingAt(FRAMES.map((f) => table[f]), cam.k);
    const top = size.introH * clamp(1 - cam.k, 0, 1);
    // Under the intro the tool bar and the caption are not shown yet: the boards take the room.
    const pad = size.narrow ? { t: 26, r: 16, b: 18, l: 16 } : { t: 44, r: 40, b: lerp(28, 92, clamp(cam.k, 0, 1)), l: 40 };
    const fit = cameraFit(rect, { w: size.w, h: size.h }, { top: top + pad.t, right: pad.r, bottom: size.sheet + pad.b, left: pad.l });
    scale = fit.s;
    world.style.transform = `translate(${fit.tx}px, ${fit.ty}px) scale(${fit.s})`;
    world.style.setProperty('--inv', String(1 / fit.s));
    // Labels keep their size down to 80% zoom, then shrink with the canvas (never wider than their board).
    world.style.setProperty('--lab', String(clamp(fit.s, 0.8, 1) / fit.s));
    stage.style.setProperty('--zoom', String(fit.s));
    stage.style.setProperty('--pan', `${fit.tx}px ${fit.ty}px`);
    zoomLabel.textContent = `${Math.round(fit.s * 100)}%`;
  };
  const zoomLabel = $('.toolbar__zoom');

  /* ---------------------------------------------------------------- the timeline (scrubbed) */
  const tl = gsap.timeline({ paused: true, defaults: { ease: 'power2.inOut' } });
  const cFigs = $$('.comp', board('c'));
  const [v1, v2, v3, v4, v5] = cFigs;
  const wipeFrom = { clipPath: 'inset(0% 100% 0% 0%)' };
  gsap.set([v2, v3, v4, v5], wipeFrom);
  const hidden = { autoAlpha: 0 };
  const panels = ['.inspector', '.timeline', '.brandkit', '.lines', '.edit', '.fit'].flatMap((s) => $$(s));
  gsap.set(panels, hidden);
  const fromC = (id) => {
    const c = boxOf(board('c')); const b = boxOf(board(id));
    return { x: c.cx - b.cx, y: c.cy - b.cy };
  };
  const enterFromC = (ids, at) => ids.forEach((id, i) => {
    const d = fromC(id);
    gsap.set(board(id), { autoAlpha: 0, x: d.x, y: d.y, scale: 0.45 });
    tl.to(board(id), { autoAlpha: 1, x: 0, y: 0, scale: 1, duration: 0.4, ease: 'expo.out' }, at + i * 0.07);
  });
  const exportBox = $('.export');
  gsap.set(exportBox, { autoAlpha: 0, scale: 0.96 });
  const cursor = $('.cursor', stage);
  gsap.set(cursor, { autoAlpha: 0 });

  // 1. Brief: the intro steps aside, the camera settles on the three variants (on a phone it pans across them).
  const furniture = [$('.toolbar'), $('.caption')];
  gsap.set(furniture, { autoAlpha: 0, y: 12 });
  tl.to(intro, { autoAlpha: 0, y: -40, duration: 0.45, ease: 'power2.in' }, 0.1)
    .to(cam, { k: 1, duration: 0.7 }, 0.12)
    .to(furniture, { autoAlpha: 1, y: 0, duration: 0.3, ease: 'power2.out' }, 0.5);
  // 2. Choose: C is chosen (the cursor clicks it); A and B dim.
  tl.to(cam, { k: 2, duration: 0.3 }, 1)
    .to([board('a'), board('b')], { opacity: 0.32, duration: 0.2 }, 1.36);
  // 3. Ask: A and B set aside, the camera closes on C, v2 renders over v1.
  tl.to([board('a'), board('b')], { autoAlpha: 0, scale: 0.94, duration: 0.3 }, 2)
    .to(cam, { k: 3, duration: 0.45 }, 2)
    .to(v2, { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.28, ease: 'power3.inOut' }, 2.2);
  // 4. Edit by hand: the editor opens around C; the title is dragged (see render) and saved as v3.
  tl.to(cam, { k: 4, duration: 0.4 }, 3)
    .fromTo($('.inspector'), { autoAlpha: 0, x: 40 }, { autoAlpha: 1, x: 0, duration: 0.3, ease: 'expo.out' }, 3.12)
    .fromTo($('.timeline'), { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: 'expo.out' }, 3.18)
    .to($('.edit'), { autoAlpha: 1, duration: 0.08 }, 3.34)
    .to(v3, { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.07, ease: 'power3.inOut' }, 3.86)
    .to($('.edit'), { autoAlpha: 0, duration: 0.06 }, 3.9)
    .to([$('.inspector'), $('.timeline')], { autoAlpha: 0, duration: 0.18 }, 4);
  // 5. Brand: the brand kit read from the site lands beside C; v4 wears it.
  tl.to(cam, { k: 5, duration: 0.4 }, 4)
    .fromTo($('.brandkit'), { autoAlpha: 0, y: 30 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: 'expo.out' }, 4.14)
    .fromTo($$('.brandkit__colors li'), { y: 16, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.2, stagger: 0.05, ease: 'expo.out' }, 4.24)
    .to(v4, { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.26, ease: 'power3.inOut' }, 4.5)
    .to($('.brandkit'), { autoAlpha: 0, x: -30, duration: 0.2 }, 5);
  // 6. Formats: the 16:9 multiplies into a 9:16 and a 1:1.
  tl.to(cam, { k: 6, duration: 0.4 }, 5);
  enterFromC(['f916', 'f11'], 5.16);
  // 7. Languages: three translations fan out under the formats; the German one shows its box.
  tl.to(cam, { k: 7, duration: 0.4 }, 6);
  enterFromC(['it', 'de', 'es'], 6.14);
  tl.to($('.fit'), { autoAlpha: 1, duration: 0.1 }, 6.62).to($('.fit'), { autoAlpha: 0, duration: 0.1 }, 7);
  // 8. Subtitles: the subtitle set beside C; v5 draws it.
  tl.to(cam, { k: 8, duration: 0.4 }, 7)
    .fromTo($('.lines'), { autoAlpha: 0, x: -30 }, { autoAlpha: 1, x: 0, duration: 0.3, ease: 'expo.out' }, 7.12)
    .to(v5, { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.24, ease: 'power3.inOut' }, 7.34)
    .to($('.lines'), { autoAlpha: 0, duration: 0.2 }, 8);
  // 9. Identity: the logo's file sets appear in a new corner of the canvas.
  const idBoards = ['identity', 'appicon', 'favicon', 'social'].map(board);
  gsap.set(idBoards, { autoAlpha: 0, y: 60, scale: 0.9 });
  tl.to(cam, { k: 9, duration: 0.42 }, 8)
    .to(idBoards, { autoAlpha: 1, y: 0, scale: 1, duration: 0.35, stagger: 0.07, ease: 'expo.out' }, 8.2);
  // 10. Export: the dialog opens over the canvas, every file fills, then the whole canvas shows.
  tl.to(exportBox, { autoAlpha: 1, scale: 1, duration: 0.1, ease: 'expo.out' }, 9.24)
    .to(exportBox, { autoAlpha: 0, scale: 0.98, duration: 0.1, ease: 'power2.in' }, 9.82)
    .to(cam, { k: 10, duration: 0.45 }, 9.5)
    .to({}, { duration: HOLD }, 10);

  /* ---------------------------------------------------------------- states read from the time */
  const cBoard = board('c');
  const cVer = $('.board__ver', cBoard);
  const chooseText = $('.board__choose-text', cBoard);
  const editBox = $('.edit__box'); const editGhost = $('.edit__ghost');
  const BOX2 = [8.33, 29.64, 57.75, 33.47]; const BOX3 = [6.25, 45.19, 51.56, 31.67];
  const fields = $$('.inspector__fields dd[data-from]');
  const swatch = $('.swatch'); const hex = $('.inspector__hex'); const save = $('.inspector__save');
  const exportRows = $$('.export__rows li');
  const exportBtn = $('.toolbar__export');
  const caption = { n: $('.caption__n'), name: $('.caption__name'), what: $('.caption__what'), bar: $('.caption__bar') };
  editGhost.style.cssText = boxCss(BOX2);

  /** Where the cursor is (stage pixels) and whether it presses, as a function of the time. */
  const center = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect(); const s = stage.getBoundingClientRect();
    return [r.left - s.left + r.width / 2, r.top - s.top + r.height / 2];
  };
  const cursorPath = [
    // [from, to, target at the end, pressed]
    [1.02, 1.26, () => center($('.board__choose', cBoard)), false], [1.26, 1.4, () => center($('.board__choose', cBoard)), true], [1.4, 1.6, () => center($('.board__choose', cBoard)), false],
    [3.3, 3.42, () => center(editBox), false], [3.42, 3.7, () => center(editBox), true], [3.7, 3.82, () => center(save), false], [3.82, 3.9, () => center(save), true], [3.9, 3.98, () => center(save), false],
    [9.02, 9.16, () => center(exportBtn), false], [9.16, 9.24, () => center(exportBtn), true], [9.24, 9.32, () => center(exportBtn), false],
  ];
  const renderCursor = (t) => {
    const i = cursorPath.findIndex(([a, b]) => t >= a && t < b);
    if (i < 0 || (size.narrow && t > 9)) { cursor.style.opacity = '0'; cursor.style.visibility = 'hidden'; return; }
    const [a, b, target, pressed] = cursorPath[i];
    const to = target();
    const prev = i > 0 && cursorPath[i - 1][1] === a ? cursorPath[i - 1][2]() : null;
    const from = prev ?? (to ? [to[0] + 90, to[1] + 70] : null);
    if (!to || !from) return;
    const p = easeInOut(clamp((t - a) / (b - a), 0, 1));
    const fade = clamp((t - a) / 0.05, 0, 1) * (cursorPath[i + 1]?.[0] === b ? 1 : clamp((b - t) / 0.05, 0, 1));
    cursor.style.visibility = 'visible';
    cursor.style.opacity = String(prev ? 1 : fade);
    cursor.style.transform = `translate(${lerp(from[0], to[0], p)}px, ${lerp(from[1], to[1], p)}px) scale(${pressed ? 0.86 : 1})`;
  };

  let step = 0;
  const render = () => {
    const t = tl.time();
    applyCamera();
    // The step, the chat and the players change only at a step's start.
    const now = stepAt(t, STEPS);
    if (now !== step) setStep(now, step);
    // Board C: chosen, ring, version label.
    cBoard.classList.toggle('is-chosen', t >= 1.3);
    cBoard.classList.toggle('is-ring', t >= 1.3 && t < 2.15);
    chooseText.textContent = t >= 1.3 ? 'Chosen' : 'Choose';
    const rendering = RENDERING.some(([a, b]) => t >= a && t < b);
    const ver = VERSIONS.filter(([at]) => t >= at).at(-1)[1];
    cVer.textContent = rendering ? 'Rendering…' : ver;
    cVer.classList.toggle('is-rendering', rendering);
    cVer.classList.toggle('is-new', !rendering && VERSIONS.some(([at]) => at > 0 && t >= at && t < at + 0.3));
    // Step 4: the drag (3.42-3.7), the colour (from 3.72), Save as v3 pressed (3.82-3.9).
    const drag = easeInOut(clamp((t - 3.42) / 0.28, 0, 1));
    editBox.style.cssText = boxCss(BOX2.map((v, i) => lerp(v, BOX3[i], drag)));
    editGhost.style.opacity = drag > 0 ? '1' : '0';
    for (const dd of fields) dd.textContent = String(Math.round(lerp(Number(dd.dataset.from), Number(dd.dataset.to), drag)));
    const yellow = t >= 3.72;
    swatch.style.setProperty('--swatch', yellow ? '#FACC15' : '#2DD4BF');
    hex.textContent = yellow ? '#FACC15' : '#2DD4BF';
    save.classList.toggle('is-pressed', t >= 3.82 && t < 3.92);
    // Step 10: Export pressed, each row fills, then done.
    exportBtn.classList.toggle('is-pressed', t >= 9.16 && t < 9.3);
    exportRows.forEach((row, i) => {
      const p = clamp((t - 9.32 - i * 0.04) / 0.16, 0, 1);
      row.style.setProperty('--p', String(p));
      row.classList.toggle('is-done', p >= 1);
    });
    // The composer types the next request in the tail of the step before it.
    const typed = typedAt(t, steps.map((s) => s.request));
    chat.type(typed);
    caption.bar.style.setProperty('--progress', String(clamp(t / STEPS, 0, 1)));
    renderCursor(t);
  };
  tl.eventCallback('onUpdate', render);

  /* ---------------------------------------------------------------- steps: chat, caption, players */
  const stagePlayers = players.filter((p) => stage.contains(p.figure));
  let onScreen = true;
  const syncPlayers = () => {
    const live = new Set(LIVE[step] ?? []);
    const next = new Set(size.narrow ? [] : LIVE[step + 1] ?? []);
    for (const p of stagePlayers) {
      const f = p.figure;
      const id = f.closest('[data-board]').dataset.board;
      const own = f.dataset.steps ? parseSteps(f.dataset.steps) : null;
      const plays = onScreen && live.has(id) && (!own || inSteps(own, step));
      const soon = onScreen && next.has(id) && (!own || inSteps(own, step + 1));
      const still = f.dataset.still ? inSteps(parseSteps(f.dataset.still), step) : false;
      p.update({ near: plays || soon, visible: plays, still });
    }
  };
  // The players follow once the step settles: a fast scroll (or the jump to the final cut) passes steps without
  // mounting every board on the way.
  let settle = null;
  // Out of its steps (and the one before, so its poster is there when it enters) a board is not laid out: its lazy poster
  // waits, and the first load fetches only the first steps' posters.
  const ranged = $$('[data-steps]');
  const layOut = (n) => {
    for (const el of ranged) el.hidden = !parseSteps(el.dataset.steps).some(([a, b]) => n >= a - 1 && n <= b + 1);
  };
  function setStep(n, before) {
    step = n;
    layOut(n);
    const s = steps[n - 1];
    chat.show(n, before);
    caption.n.textContent = String(n).padStart(2, '0');
    caption.name.textContent = s.name;
    caption.what.textContent = s.what;
    clearTimeout(settle);
    settle = setTimeout(syncPlayers, before === 0 ? 0 : 140);
  }

  // Subtitle lines follow the time of the board that draws them.
  const subsPlayer = stagePlayers.find((p) => p.figure === v5);
  const lineItems = $$('.lines__list li');
  subsPlayer?.onChange((p) => {
    for (const li of lineItems) li.classList.toggle('is-on', p.time >= Number(li.dataset.start) && p.time < Number(li.dataset.end));
  });

  /* ---------------------------------------------------------------- scroll */
  measure();
  render();
  ScrollTrigger.create({
    trigger: story, start: 'top top', end: 'bottom bottom', scrub: 0.5,
    animation: tl,
  });
  ScrollTrigger.create({
    trigger: story, start: 'top bottom', end: 'bottom top',
    onToggle: (self) => { onScreen = self.isActive; syncPlayers(); },
  });
  const onResize = () => { measure(); render(); };
  new ResizeObserver(onResize).observe(stage);
  narrowQuery.addEventListener('change', () => { onResize(); syncPlayers(); });
  stage.classList.add('is-live');
  return { timeline: tl, get step() { return step; } };
}

/* ---------------------------------------------------------------- the chat panel, built from the steps */

function readStep(li) {
  const text = (sel) => li.querySelector(sel)?.textContent.trim() ?? null;
  const title = li.querySelector('.step__title');
  return {
    n: Number(li.dataset.step),
    name: [...title.childNodes].filter((n) => !(n instanceof Element && n.classList.contains('step__n'))).map((n) => n.textContent).join('').trim(),
    what: text('.step__what'),
    you: text('.msg--you'),
    agent: text('.msg--agent'),
    event: text('.msg--event'),
    get request() { return this.you; },
  };
}

const VERSION_CARD = { 1: 'A · B · C v1', 3: 'v2', 5: 'v4', 6: '9:16 · 1:1 v1', 7: 'IT · DE · ES', 8: 'v5' };

function buildChat(steps, note) {
  const el = h('aside', { class: 'chat', 'aria-hidden': 'true' });
  const tabs = h('p', { class: 'chat__tabs' }, [h('span', { class: 'is-on' }, 'Chat'), h('span', {}, ['Comments', h('i', {}, '0')]), h('span', {}, 'Brief')]);
  const mark = h('p', { class: 'chat__mark' });
  const log = h('div', { class: 'chat__log' });
  const exchanges = steps.map((s) => {
    const ex = h('div', { class: 'ex', 'data-step': String(s.n) });
    ex.hidden = true;
    if (s.you) ex.append(h('p', { class: 'who who--you' }, [h('b', {}, 'You')]), h('p', { class: 'msg msg--you' }, s.you));
    if (s.event) ex.append(h('p', { class: 'msg msg--event' }, s.event));
    if (s.agent) {
      const agent = [h('p', { class: 'who' }, [h('span', { class: 'avatar' }), h('b', {}, 'Agent'), h('span', { class: 'tag' }, 'Summary')]), h('p', { class: 'msg msg--agent' }, s.agent)];
      if (VERSION_CARD[s.n]) agent.push(h('div', { class: 'version' }, [h('span', { class: 'tag' }, `${VERSION_CARD[s.n]} · Ready`), h('span', {}, 'View')]));
      const wrap = h('div', { class: 'ex__agent' }, agent);
      wrap.style.display = 'contents';
      ex.append(wrap);
    }
    log.append(ex);
    return ex;
  });
  const typedEl = h('span', { class: 'chat__typed' });
  const ph = h('span', { class: 'chat__ph' }, 'Describe what to change · ⌘↵ to send');
  const caret = h('span', { class: 'chat__caret' });
  const composer = h('div', { class: 'chat__composer' }, [
    h('p', { class: 'chat__applies' }, ['Applies to: ', h('b', {}, 'All formats')]),
    h('p', { class: 'chat__field' }, [typedEl, caret, ph]),
    h('div', { class: 'chat__row' }, [icon('i-plus'), h('span', {}, 'Services'), h('span', { class: 'chat__send' }, [icon('i-send'), '⌘↵'])]),
  ]);
  el.append(tabs, mark, log, composer, h('p', { class: 'chat__note' }, note));

  let pending = null;
  let lastTyped = null;
  // Like the app's chat: the newest message stays in view; older ones scroll up under a fade.
  const follow = () => requestAnimationFrame(() => {
    const top = Math.max(0, log.scrollHeight - log.clientHeight);
    log.classList.toggle('is-scrolled', top > 0);
    log.scrollTo({ top, behavior: 'smooth' });
  });
  return {
    el,
    /** Shows the exchanges up to step `n`; one step forward plays the agent's turn (working, then the answer). */
    show(n, before) {
      clearTimeout(pending);
      exchanges.forEach((ex, i) => {
        const k = i + 1;
        ex.hidden = k > n;
        ex.classList.toggle('is-current', k === n);
        const agent = ex.querySelector('.ex__agent');
        ex.querySelector('.working')?.remove();
        if (agent) agent.style.display = 'contents';
      });
      const s = steps[n - 1];
      mark.textContent = `${String(n).padStart(2, '0')} · ${s.name}`;
      const ex = exchanges[n - 1];
      const agent = ex.querySelector('.ex__agent');
      if (n === before + 1 && before > 0) {
        animateIn(ex.firstElementChild);
        if (agent) {
          agent.style.display = 'none';
          const working = h('p', { class: 'working' }, 'Working…');
          ex.append(working);
          pending = setTimeout(() => {
            working.remove();
            agent.style.display = 'contents';
            for (const c of agent.children) animateIn(c);
            follow();
          }, 750);
        }
      }
      follow();
    },
    type(text) {
      if (text === lastTyped) return;
      lastTyped = text;
      typedEl.textContent = text;
      ph.hidden = text.length > 0;
      composer.classList.toggle('is-typing', text.length > 0);
    },
  };
}

function animateIn(el) {
  el?.animate?.([{ opacity: 0, transform: 'translateY(12px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' });
}

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of [].concat(children)) el.append(c);
  return el;
}

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

/** A board's box in world units, from its CSS variables. */
function boxOf(el) {
  const v = (n) => Number(getComputedStyle(el).getPropertyValue(n));
  const x = v('--X'); const y = v('--Y'); const w = v('--W'); const hgt = v('--H');
  return { x, y, w, h: hgt, cx: x + w / 2, cy: y + hgt / 2 };
}

const boxCss = ([l, t, w, hh]) => `left:${l}%;top:${t}%;width:${w}%;height:${hh}%`;
const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
