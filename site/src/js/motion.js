// The page choreography (GSAP, ScrollTrigger, SplitText). Every element starts from the hidden state set in CSS under
// html.js-motion and ends in its normal state, so stopping anywhere leaves a readable page.
const EASE = 'expo.out';

export function startMotion({ reducedMotion }) {
  if (reducedMotion) return;
  const { gsap, ScrollTrigger, SplitText } = window;
  gsap.registerPlugin(ScrollTrigger, SplitText);
  hero(gsap, SplitText);
  heroScroll(gsap);
  features(gsap);
  showcase(gsap);
  install(gsap);
}

function hero(gsap, SplitText) {
  const title = SplitText.create('.hero__title .line', { type: 'chars', mask: 'lines' });
  const typed = SplitText.create('.brief__typed', { type: 'chars' });
  gsap.set(typed.chars, { opacity: 0 });
  gsap.set('.hero__title', { opacity: 1 });
  // SVG parts: GSAP owns their transforms (as attributes), so their starting states are set here, then the SVG is shown.
  gsap.set('.frames__draft', { opacity: 0, scale: 0.6, transformOrigin: '50% 50%' });
  gsap.set('.frames__comp', { strokeDasharray: 1, strokeDashoffset: 1 });
  gsap.set('.frames__video', { scale: 0, transformOrigin: '50% 50%' });
  gsap.set('.frames__play', { opacity: 0, scale: 0.4, transformOrigin: '50% 50%' });
  gsap.set('.frames', { opacity: 1 });

  const tl = gsap.timeline({ defaults: { ease: EASE } });
  tl.from(title.chars, { yPercent: 110, duration: 1.1, stagger: 0.025 }, 0.15)
    .to('.hero__lede, .hero__actions', { opacity: 1, y: 0, duration: 0.9, stagger: 0.1 }, 0.7)
    .to('.hero__top > .eyebrow, .brief', { opacity: 1, y: 0, duration: 0.8, stagger: 0.1 }, 0.3)
    .to(typed.chars, { opacity: 1, duration: 0.01, stagger: 0.035, ease: 'none' }, 0.9)
    .to('.brief__chips li', { opacity: 1, scale: 1, duration: 0.5, stagger: 0.1, ease: 'back.out(2)' }, '>-0.1')
    .to('.brief__generate', { opacity: 1, scale: 1, duration: 0.4, ease: 'back.out(3)' }, '>')
    .to('.brief__generate', { scale: 0.9, duration: 0.12, yoyo: true, repeat: 1, ease: 'power2.inOut' }, '>0.15')
    // draft → composition → video: the logo's three frames
    .to('.frames__draft', { opacity: 1, scale: 1, duration: 0.5 }, '>-0.05')
    .to('.frames__comp', { strokeDashoffset: 0, duration: 0.7, ease: 'power2.inOut' }, '>-0.2')
    .to('.frames__video', { scale: 1, duration: 0.6, ease: 'back.out(1.8)' }, '>-0.2')
    .to('.frames__play', { opacity: 1, scale: 1, duration: 0.4, ease: 'back.out(3)' }, '>-0.15')
    .to('.hero__formats .comp', { opacity: 1, y: 0, scale: 1, duration: 1, stagger: 0.14 }, '>-0.1');
  tl.call(() => document.querySelector('.brief__caret')?.classList.add('is-done'));
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
  for (const card of document.querySelectorAll('.card .comp')) {
    gsap.fromTo(card, { y: 12 }, { y: -12, ease: 'none', scrollTrigger: { trigger: card, start: 'top bottom', end: 'bottom top', scrub: true } });
  }
}

function install(gsap) {
  gsap.to('.install__head > *, .way', { opacity: 1, y: 0, duration: 0.9, stagger: 0.08, ease: EASE, scrollTrigger: { trigger: '.install', start: 'top 80%' } });
}
