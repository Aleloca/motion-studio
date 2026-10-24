// The page choreography (GSAP, ScrollTrigger, SplitText). Every element starts from the hidden state set in CSS under
// html.js-motion and ends in its normal state, so stopping anywhere leaves a readable page.
import { CycleTimer } from './cycle-timer.js';

const EASE = 'expo.out';

export function startMotion({ reducedMotion, players = [] }) {
  if (reducedMotion) return;
  const { gsap, ScrollTrigger, SplitText } = window;
  gsap.registerPlugin(ScrollTrigger, SplitText);
  hero(gsap, SplitText, players);
  heroScroll(gsap);
  features(gsap);
  showcase(gsap);
  install(gsap);
}

/**
 * Seconds after a creative starts (from its first frame) before the next brief is erased and typed: that, Generate and
 * the logo take about 4.5 s and every hero creative lasts 12 s, so the switch lands on its end card, before it loops.
 */
const NEXT_BRIEF_AT = 7;
/** How long a new set may take to load its runtimes before it is shown anyway (on its posters). */
const READY_WAIT_MS = 4000;

function hero(gsap, SplitText, players) {
  const title = SplitText.create('.hero__title .line', { type: 'chars', mask: 'lines' });
  // Words keep the typed brief from wrapping inside a word.
  const typed = SplitText.create('.brief__typed', { type: 'words,chars' });
  const sets = [...document.querySelectorAll('.hero__set')];
  holdHeight(sets, document.querySelector('.hero__formats'));
  gsap.set(typed.chars, { opacity: 0 });
  gsap.set('.hero__title', { opacity: 1 });
  // SVG parts: GSAP owns their transforms (as attributes), so their starting states are set here, then the SVG is shown.
  framesStart(gsap);
  gsap.set('.frames', { opacity: 1 });

  const tl = gsap.timeline({ defaults: { ease: EASE } });
  tl.from(title.chars, { yPercent: 110, duration: 1.1, stagger: 0.025 }, 0.15)
    .to('.hero__lede, .hero__actions', { opacity: 1, y: 0, duration: 0.9, stagger: 0.1 }, 0.7)
    .to('.hero__top > .eyebrow, .brief', { opacity: 1, y: 0, duration: 0.8, stagger: 0.1 }, 0.3)
    .to(typed.chars, { opacity: 1, duration: 0.01, stagger: 0.035, ease: 'none' }, 0.9);
  generate(tl);
  tl.call(() => { restart(sets[0]); if (sets.length > 1) cycle(); }, [], '>-0.1')
    .to(sets[0].querySelectorAll('.comp'), { opacity: 1, y: 0, scale: 1, duration: 1, stagger: 0.14 }, '<');
  tl.call(() => document.querySelector('.brief__caret')?.classList.add('is-done'));

  /** Shows a set's creatives from their first frame (a runtime still loading starts from its poster frame instead). */
  function restart(set) {
    for (const p of players) if (set.contains(p.figure)) p.restart();
  }
  function whenReady(set) {
    const mine = players.filter((p) => set.contains(p.figure));
    const t0 = performance.now();
    return new Promise((resolve) => {
      const check = () => (mine.every((p) => p.ready || p.failed) || performance.now() - t0 > READY_WAIT_MS ? resolve() : setTimeout(check, 100));
      check();
    });
  }

  /**
   * The cycle: over the end card of a creative the brief is erased and the next one typed, with its own format chips;
   * the next set is mounted meanwhile, transparent under the current one, so its runtimes load; then the sets cross-fade
   * and every frame of the new one starts from its first frame.
   */
  function cycle() {
    let current = 0;
    let onScreen = true;
    // Off screen or in a hidden tab the players pause, and so does the cycle's clock: back on screen, the next brief
    // still comes when the creative reaches its end card.
    const timer = new CycleTimer({ now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) });
    const sync = () => (onScreen && !document.hidden ? timer.resume() : timer.pause());
    new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; sync(); }).observe(document.querySelector('.hero__formats'));
    document.addEventListener('visibilitychange', sync);
    const typedEl = document.querySelector('.brief__typed');
    const chipsEl = document.querySelector('.brief__chips');
    let split = typed;

    const step = () => {
      const from = sets[current];
      current = (current + 1) % sets.length;
      const to = sets[current];
      const figures = to.querySelectorAll('.comp');
      gsap.set(figures, { opacity: 0, y: 60, scale: 0.96 });
      gsap.set(to, { opacity: 1, zIndex: 0 });
      gsap.set(from, { zIndex: 1 });
      to.hidden = false;
      const ready = whenReady(to);

      const erase = gsap.timeline({ defaults: { ease: EASE }, onComplete: type });
      erase.to(split.chars, { opacity: 0, duration: 0.01, stagger: { each: 0.008, from: 'end' }, ease: 'none' }, 0)
        .to(chipsEl.children, { opacity: 0, scale: 0.8, duration: 0.25, stagger: 0.04, ease: 'power2.in' }, 0)
        .to('.brief__generate', { opacity: 0, scale: 0.8, duration: 0.25, ease: 'power2.in' }, 0)
        .to('.frames', { opacity: 0, duration: 0.3, ease: 'power2.in' }, 0);

      function type() {
        split.revert();
        typedEl.textContent = to.dataset.brief;
        split = SplitText.create(typedEl, { type: 'words,chars' });
        gsap.set(split.chars, { opacity: 0 });
        chipsEl.replaceChildren(...to.dataset.chips.split('|').map((c) => Object.assign(document.createElement('li'), { textContent: c })));
        gsap.set(chipsEl.children, { opacity: 0, scale: 0.8 });
        framesStart(gsap);
        gsap.set('.frames', { opacity: 1 });
        document.querySelector('.brief__caret')?.classList.remove('is-done');
        const tl = gsap.timeline({ defaults: { ease: EASE } });
        tl.to(split.chars, { opacity: 1, duration: 0.01, stagger: 0.022, ease: 'none' }, 0.1);
        generate(tl);
        tl.call(() => { tl.pause(); ready.then(() => tl.resume()); });
        tl.call(() => { restart(to); timer.after(NEXT_BRIEF_AT, step); })
          .to(from, { opacity: 0, duration: 0.5, ease: 'power2.in' })
          .to(figures, { opacity: 1, y: 0, scale: 1, duration: 1, stagger: 0.12 }, '<0.1')
          .call(() => {
            from.hidden = true;
            gsap.set(from, { clearProps: 'opacity,zIndex' });
            document.querySelector('.brief__caret')?.classList.add('is-done');
          });
      }
    };
    timer.after(NEXT_BRIEF_AT, step);
  }
}

/**
 * The sets differ in height (a 4:5 frame is taller than a 1:1): the stack keeps the tallest one's, so the page below never
 * jumps when the cycle switches. Measured synchronously, so a waiting set is never laid out long enough to load.
 */
function holdHeight(sets, box) {
  const measure = () => {
    box.style.minHeight = '';
    let max = 0;
    for (const set of sets) {
      const was = set.hidden;
      set.hidden = false;
      max = Math.max(max, set.offsetHeight);
      set.hidden = was;
    }
    box.style.minHeight = `${max}px`;
  };
  measure();
  addEventListener('resize', measure);
}

/** The logo's three frames, back to their starting states. */
function framesStart(gsap) {
  gsap.set('.frames__draft', { opacity: 0, scale: 0.6, transformOrigin: '50% 50%' });
  gsap.set('.frames__comp', { strokeDasharray: 1, strokeDashoffset: 1 });
  gsap.set('.frames__video', { scale: 0, transformOrigin: '50% 50%' });
  gsap.set('.frames__play', { opacity: 0, scale: 0.4, transformOrigin: '50% 50%' });
}

/** After the typed brief: the chips, a press on Generate, then draft → composition → video (the logo's three frames). */
function generate(tl) {
  tl.to('.brief__chips li', { opacity: 1, scale: 1, duration: 0.5, stagger: 0.1, ease: 'back.out(2)' }, '>-0.1')
    .to('.brief__generate', { opacity: 1, scale: 1, duration: 0.4, ease: 'back.out(3)' }, '>')
    .to('.brief__generate', { scale: 0.9, duration: 0.12, yoyo: true, repeat: 1, ease: 'power2.inOut' }, '>0.15')
    .to('.frames__draft', { opacity: 1, scale: 1, duration: 0.5 }, '>-0.05')
    .to('.frames__comp', { strokeDashoffset: 0, duration: 0.7, ease: 'power2.inOut' }, '>-0.2')
    .to('.frames__video', { scale: 1, duration: 0.6, ease: 'back.out(1.8)' }, '>-0.2')
    .to('.frames__play', { opacity: 1, scale: 1, duration: 0.4, ease: 'back.out(3)' }, '>-0.15');
}

function heroScroll(gsap) {
  const scrub = { trigger: '.hero__title', start: 'top 70%', end: 'bottom top', scrub: 0.6 };
  gsap.to('.hero__title .line:first-child', { xPercent: -6, scrollTrigger: scrub });
  gsap.to('.hero__title .line--accent', { xPercent: 4, scrollTrigger: scrub });
  gsap.to('.hero__formats', { yPercent: -8, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
}

function features(gsap) {
  gsap.to('.features__head > *', { opacity: 1, y: 0, duration: 1, stagger: 0.1, ease: EASE, scrollTrigger: { trigger: '.features__head', start: 'top 85%' } });
  for (const block of document.querySelectorAll('.feature')) {
    const text = block.querySelectorAll('.feature__text > *');
    const figure = block.querySelector('.comp');
    const tl = gsap.timeline({ defaults: { ease: EASE }, scrollTrigger: { trigger: block, start: 'top 78%' } });
    tl.to(figure, { opacity: 1, clipPath: 'inset(0% 0% 0% 0% round 20px)', scale: 1, duration: 1.3 }, 0)
      .to(text, { opacity: 1, y: 0, duration: 0.9, stagger: 0.08 }, 0.15);
    gsap.fromTo(figure, { yPercent: 4 }, { yPercent: -4, ease: 'none', scrollTrigger: { trigger: block, start: 'top bottom', end: 'bottom top', scrub: true } });
  }
}

function showcase(gsap) {
  gsap.to('.showcase .wrap > :not(.showcase__grid)', { opacity: 1, y: 0, duration: 1, stagger: 0.1, ease: EASE, scrollTrigger: { trigger: '.showcase', start: 'top 80%' } });
  gsap.to('.card', { opacity: 1, y: 0, duration: 1.1, stagger: 0.1, ease: EASE, scrollTrigger: { trigger: '.showcase__grid', start: 'top 85%' } });
}

function install(gsap) {
  gsap.to('.install__head > *, .way', { opacity: 1, y: 0, duration: 0.9, stagger: 0.08, ease: EASE, scrollTrigger: { trigger: '.install', start: 'top 80%' } });
}
