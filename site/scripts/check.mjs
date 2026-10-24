// Real-browser checks of the built site, served under /motion-studio/ like GitHub Pages:
// the home at 360, 768, 1440 and 2000 px, with motion on and with prefers-reduced-motion: no horizontal scroll, no console
// errors or failed requests, every composition either live or on its poster, no player told to play under reduced
// motion, no poster a near-blank frame, every link with its target or file. The story: with motion, each step comes on
// screen at its scroll position, only its boards are mounted, and the canvas's players stop once it has scrolled away;
// under reduced motion every step is a static block (its messages and its result's images loaded). The story's sound
// button turns the voice-over on and off. The gallery plays at most four boards at once and none under reduced motion. The final cut never starts by itself; its big Play starts it from 0:00 with sound. Then the guide (guide.html) at 360, 768 and 1440 px.
// Usage: node site/scripts/check.mjs [--out <folder for screenshots>]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../build.mjs';
import { serve } from './serve.mjs';
import { launchChrome } from './chrome.mjs';

const WIDTHS = [360, 768, 1440];
const HOME_WIDTHS = [...WIDTHS, 2000];
/** A poster whose luminance varies less than this (standard deviation, 0-255) is a near-blank frame. */
export const MIN_POSTER_DEVIATION = 12;
/** At most this many live runtimes on the canvas at once (a step's boards and the next step's). */
const MAX_STAGE_FRAMES = 9;
const wait = (page, ms) => page.eval(`new Promise(r => setTimeout(r, ${ms}))`);

export async function check({ out } = {}) {
  await build();
  if (out) mkdirSync(out, { recursive: true });
  const server = await serve();
  const chrome = await launchChrome();
  const failures = [];
  try {
    for (const reduced of [false, true]) {
      for (const width of HOME_WIDTHS) {
        const tag = `${width}${reduced ? ' reduced' : ''}`;
        const page = await chrome.newPage();
        const problems = [];
        page.on('Runtime.exceptionThrown', (p) => problems.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`));
        page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') problems.push(`console.error: ${p.args.map((a) => a.value ?? a.description).join(' ')}`); });
        page.on('Network.loadingFailed', (p) => { if (!p.canceled) problems.push(`request failed: ${p.errorText}`); });
        page.on('Network.responseReceived', (p) => { if (p.response.status >= 400) problems.push(`HTTP ${p.response.status} ${p.response.url}`); });
        await page.send('Runtime.enable'); await page.send('Network.enable'); await page.send('Page.enable');
        await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
        await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
        await page.goto(`${server.url}?debug`);
        await wait(page, 2500);
        if (!reduced) problems.push(...await liveStory(page));
        await page.eval(`(async () => { const h = document.documentElement.scrollHeight; for (let y = 0; y < h; y += 500) { scrollTo({ top: y, behavior: 'instant' }); await new Promise(r => setTimeout(r, 250)); } })()`);
        await wait(page, 4000);
        const s = await page.eval(`(() => {
          const live = document.documentElement.classList.contains('js-motion');
          const figs = [...document.querySelectorAll('.comp')].filter((f) => f.getClientRects().length > 0);
          const stage = [...window.__siteDebug.players].filter((p) => p.figure.closest('[data-stage]'));
          return {
            live, scrollWidth: document.documentElement.scrollWidth, innerWidth,
            figures: figs.length,
            settled: figs.filter((f) => f.classList.contains('is-ready') || f.classList.contains('is-failed') || f.querySelector('.poster').complete).length,
            ready: figs.filter((f) => f.classList.contains('is-ready')).length,
            errored: figs.filter((f) => f.dataset.fail === 'error').map((f) => f.dataset.composition),
            timedOut: figs.filter((f) => f.dataset.fail === 'timeout').map((f) => f.dataset.composition),
            blank: figs.filter((f) => f.classList.contains('is-ready') && !f.querySelector('iframe')).length,
            played: window.__siteDebug.commands.filter((c) => c.type === 'play').length,
            // The live story's canvas fades its own parts in and out; everything else must be readable once scrolled past.
            hidden: [...document.querySelectorAll('h1, h2, h3, p, .btn, .way')].filter((e) => !(live && e.closest('.story__pin')) && getComputedStyle(e).opacity < 0.5).length,
            stagePlaying: stage.filter((p) => p.playing).map((p) => p.id),
            finalCut: Boolean(document.querySelector('figure[data-final-cut][data-composition] .player-bar .player-bar__play')),
            soundButton: !document.querySelector('.story__sound').hidden && document.querySelector('.story__sound').getClientRects().length > 0,
            steps: [...document.querySelectorAll('.step')].map((st) => ({
              n: st.dataset.step,
              shown: st.getClientRects().length > 0 && st.offsetHeight > 0 && getComputedStyle(st).visibility !== 'hidden',
              messages: st.querySelectorAll('.msg').length,
              images: [...st.querySelectorAll('.step__result img')].map((i) => i.complete && i.naturalWidth > 0),
              files: st.querySelectorAll('.files li').length,
            })),
          };
        })()`);
        if (s.scrollWidth > s.innerWidth) problems.push(`horizontal scroll: ${s.scrollWidth} > ${s.innerWidth}`);
        if (s.settled < s.figures) problems.push(`${s.figures - s.settled} figures neither live nor on their poster`);
        if (s.errored.length) problems.push(`compositions refused by the runtime: ${s.errored.join(', ')}`);
        if (s.blank) problems.push(`${s.blank} figures hide their poster with no live frame`);
        if (reduced && s.played > 0) problems.push(`${s.played} play commands under reduced motion`);
        if (s.hidden > 0) problems.push(`${s.hidden} text elements still hidden after scrolling`);
        if (s.live === reduced) problems.push(`the story is ${s.live ? 'live' : 'static'} ${reduced ? 'under' : 'without'} reduced motion`);
        if (s.stagePlaying.length) problems.push(`canvas boards still playing off screen: ${s.stagePlaying.join(', ')}`);
        if (!s.finalCut) problems.push('the final cut\'s slot or controls are missing');
        if (s.steps.length !== 11) problems.push(`${s.steps.length} steps, not 11`);
        if (s.soundButton !== !reduced) problems.push(`the story's sound button is ${s.soundButton ? 'shown' : 'hidden'} ${reduced ? 'under' : 'without'} reduced motion`);
        if (reduced) {
          for (const st of s.steps) {
            if (!st.shown) problems.push(`step ${st.n} is not shown as a static block`);
            if (!st.messages) problems.push(`step ${st.n} has no message`);
            if (!st.images.length && !st.files) problems.push(`step ${st.n} has no result`);
            if (st.images.some((ok) => !ok)) problems.push(`step ${st.n}: an image of its result did not load`);
          }
        }
        problems.push(...await galleryBoards(page, reduced));
        problems.push(...await links(page));
        problems.push(...await finalCutStart(page));
        if (!reduced && width === WIDTHS[0]) {
          problems.push(...await blankPosters(page));
          console.log(`poster luminance deviation: ${JSON.stringify(await page.eval('window.__posterDeviation'))}`);
        }
        const note = s.timedOut.length ? ` (on poster after a slow load: ${s.timedOut.join(', ')})` : '';
        console.log(`${tag}: ${s.ready}/${s.figures} live${note}, ${problems.length ? problems.length + ' problem(s)' : 'ok'}`);
        failures.push(...problems.map((p) => `${tag}: ${p}`));
        if (out) {
          await page.eval(`scrollTo({ top: 0, behavior: 'instant' })`);
          await wait(page, 600);
          const h = await page.eval('document.documentElement.scrollHeight');
          const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.min(h, 2400), scale: 1 } });
          writeFileSync(join(out, `site-${width}${reduced ? '-reduced' : ''}.png`), Buffer.from(data, 'base64'));
        }
        await page.close();
      }
    }
    // The guide: no sideways scroll, every screenshot loads (after scrolling past the lazy ones), every in-page link has its
    // target, and the contents are collapsed below 1000 px and open from there.
    for (const width of WIDTHS) {
      const tag = `guide ${width}`;
      const page = await chrome.newPage();
      const problems = [];
      page.on('Runtime.exceptionThrown', (p) => problems.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`));
      page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') problems.push(`console.error: ${p.args.map((a) => a.value ?? a.description).join(' ')}`); });
      page.on('Network.loadingFailed', (p) => { if (!p.canceled) problems.push(`request failed: ${p.errorText}`); });
      page.on('Network.responseReceived', (p) => { if (p.response.status >= 400) problems.push(`HTTP ${p.response.status} ${p.response.url}`); });
      await page.send('Runtime.enable'); await page.send('Network.enable'); await page.send('Page.enable');
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
      await page.goto(`${server.url}guide.html`);
      await wait(page, 800);
      await page.eval(`(async () => { const h = document.documentElement.scrollHeight; for (let y = 0; y < h; y += 700) { scrollTo({ top: y, behavior: 'instant' }); await new Promise(r => setTimeout(r, 120)); } })()`);
      await wait(page, 1500);
      const s = await page.eval(`(() => {
        const imgs = [...document.images];
        return {
          scrollWidth: document.documentElement.scrollWidth, innerWidth,
          images: imgs.length,
          broken: imgs.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute('src')),
          noAlt: imgs.filter((i) => !i.alt.trim()).map((i) => i.getAttribute('src')),
          deadLinks: [...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href').slice(1)).filter((id) => !document.getElementById(id)),
          tocOpen: document.querySelector('.toc details').open,
          wider: [...document.querySelectorAll('main *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('pre, .table-wrap')).map((e) => e.tagName + '.' + e.className).slice(0, 5),
        };
      })()`);
      if (s.scrollWidth > s.innerWidth) problems.push(`horizontal scroll: ${s.scrollWidth} > ${s.innerWidth}`);
      if (s.wider.length) problems.push(`elements past the right edge: ${s.wider.join(', ')}`);
      if (s.broken.length) problems.push(`images not loaded: ${s.broken.join(', ')}`);
      if (s.noAlt.length) problems.push(`images without alt: ${s.noAlt.join(', ')}`);
      if (s.deadLinks.length) problems.push(`links without a target: ${s.deadLinks.join(', ')}`);
      if (s.tocOpen !== (width >= 1000)) problems.push(`contents ${s.tocOpen ? 'open' : 'closed'} at ${width} px`);
      console.log(`${tag}: ${s.images} images, ${problems.length ? problems.length + ' problem(s)' : 'ok'}`);
      failures.push(...problems.map((p) => `${tag}: ${p}`));
      if (out) {
        await page.eval(`scrollTo({ top: 0, behavior: 'instant' })`);
        await wait(page, 600);
        const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height: 900, scale: 1 } });
        writeFileSync(join(out, `guide-${width}.png`), Buffer.from(data, 'base64'));
      }
      await page.close();
    }
  } finally {
    await chrome.close();
    await server.close();
  }
  if (failures.length) throw new Error(failures.join('\n'));
}

/**
 * The live story, step by step: scrolled to the middle of each step, the story says it is on that step, every board it plays
 * has a runtime mounted, and no more than MAX_STAGE_FRAMES runtimes are on the canvas. With the sound turned on (a real
 * click on the story's button), step 6 says its line and step 9 lets its board speak; turned off, everything is silent.
 */
async function liveStory(page) {
  const problems = [];
  const scrollToStep = (n) => page.eval(`(() => { const s = document.querySelector('.story'); scrollTo({ top: s.offsetTop + (s.offsetHeight - innerHeight) * (${n - 0.45} / 11.6), behavior: 'instant' }); })()`);
  const clickSound = async () => {
    const [x, y] = await page.eval(`(() => { const r = document.querySelector('.story__sound').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  };
  const voice = () => page.eval(`(() => { const st = window.__siteDebug.story; const subs = window.__siteDebug.players.find((p) => p.id === 'story-subs'); return { sound: window.__siteDebug.sound.on, line: st.speaking, subsMuted: subs.muted }; })()`);
  for (let n = 1; n <= 11; n++) {
    await scrollToStep(n);
    await wait(page, 1200);
    const r = await page.eval(`(() => {
      const stage = window.__siteDebug.players.filter((p) => p.figure.closest('[data-stage]'));
      return {
        step: window.__siteDebug.story?.step,
        frames: document.querySelectorAll('[data-stage] iframe').length,
        unmounted: stage.filter((p) => p.state.visible && !p.frame && !p.failed).map((p) => p.id),
      };
    })()`);
    if (r.step !== n) problems.push(`scrolled to step ${n}, the story shows step ${r.step}`);
    if (r.frames > MAX_STAGE_FRAMES) problems.push(`step ${n}: ${r.frames} runtimes on the canvas`);
    if (r.unmounted.length) problems.push(`step ${n}: boards to play with no runtime: ${r.unmounted.join(', ')}`);
  }
  await scrollToStep(6);
  await wait(page, 1200);
  await clickSound();
  await wait(page, 1500);
  let v = await voice();
  if (!v.sound) problems.push('the story\'s sound button did not turn the sound on');
  if (!v.line?.src.endsWith('/vo-06.mp3') || v.line.paused) problems.push(`step 6 with sound: ${JSON.stringify(v.line)}, not its line playing`);
  await scrollToStep(9);
  await wait(page, 2500);
  v = await voice();
  if (v.subsMuted || v.line) problems.push(`step 9 with sound: the board ${v.subsMuted ? 'is muted' : 'speaks'}, a line ${v.line ? 'plays' : 'is silent'}`);
  await clickSound();
  await wait(page, 400);
  v = await voice();
  if (v.sound || v.line || !v.subsMuted) problems.push(`sound off: still ${JSON.stringify(v)}`);
  // With the sound off, a click on the Generate step's music tile still plays it (the click is the viewer's gesture).
  await scrollToStep(6);
  await wait(page, 1500);
  // On a phone the bottom sheet never covers the Generate step's tiles (the camera frames above it, as tall as it is).
  const covered = await page.eval(`(() => {
    if (!matchMedia('(max-width: 959px)').matches) return [];
    const top = document.querySelector('.chat').getBoundingClientRect().top;
    return [...document.querySelectorAll('[data-board^="gen"] .board__frame')].filter((f) => f.getBoundingClientRect().bottom > top + 1).map((f) => f.closest('[data-board]').dataset.board);
  })()`);
  if (covered.length) problems.push(`step 6: the bottom sheet covers ${covered.join(', ')}`);
  const at = await page.eval(`(() => { const r = document.querySelector('[data-board="genmusic"] [data-play]').getBoundingClientRect(); return r.width ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`);
  if (!at) problems.push('step 6: the music tile\'s play button is not on screen');
  else {
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: at[0], y: at[1], button: 'left', clickCount: 1 });
    await wait(page, 1200);
    v = await voice();
    if (!v.line?.src.endsWith('/music.mp3') || v.line.paused) problems.push(`step 6: a click on the music tile plays ${JSON.stringify(v.line)}`);
    await scrollToStep(8);
    await wait(page, 1200);
    v = await voice();
    if (v.line) problems.push(`the music tile still plays after the step scrolled away: ${JSON.stringify(v.line)}`);
  }
  return problems;
}

/**
 * The gallery, scrolled through: with motion at most four boards play and at most six runtimes are mounted at any point,
 * and none plays once it has scrolled away; under reduced motion none mounts. Every board ends live or on its loaded poster.
 */
async function galleryBoards(page, reduced) {
  const problems = [];
  const state = () => page.eval(`(() => {
    const boards = [...document.querySelectorAll('.gallery figure[data-gallery]')];
    return {
      count: boards.length,
      frames: document.querySelectorAll('.gallery iframe').length,
      playing: window.__siteDebug.gallery.playing,
      shown: boards.filter((f) => f.classList.contains('is-ready') || (f.querySelector('.poster').complete && f.querySelector('.poster').naturalWidth > 0)).length,
    };
  })()`);
  const top = await page.eval(`document.querySelector('.gallery').offsetTop`);
  const height = await page.eval(`document.querySelector('.gallery').offsetHeight`);
  let most = { playing: 0, frames: 0 };
  for (let y = top - 900; y < top + height; y += 400) {
    await page.eval(`scrollTo({ top: ${y}, behavior: 'instant' })`);
    await wait(page, 900);
    const s = await state();
    most = { playing: Math.max(most.playing, s.playing.length), frames: Math.max(most.frames, s.frames) };
  }
  await wait(page, 3000);
  const s = await state();
  if (s.count !== 12) problems.push(`gallery: ${s.count} boards, not 12`);
  if (s.shown < s.count) problems.push(`gallery: ${s.count - s.shown} boards neither live nor on their poster`);
  if (reduced && (most.frames || most.playing)) problems.push(`gallery under reduced motion: ${most.frames} runtimes, ${most.playing} playing`);
  if (!reduced && most.playing > 4) problems.push(`gallery: ${most.playing} boards playing at once`);
  if (!reduced && most.frames > 6) problems.push(`gallery: ${most.frames} runtimes mounted at once`);
  if (!reduced && !most.playing) problems.push('gallery: no board played');
  await page.eval(`scrollTo({ top: 0, behavior: 'instant' })`);
  await wait(page, 800);
  const away = await state();
  if (away.playing.length) problems.push(`gallery boards still playing off screen: ${away.playing.join(', ')}`);
  return problems;
}

/**
 * The final cut never starts by itself: scrolled onto it, it holds its poster with the big Play. A real click on that Play
 * starts it from 0:00 with the sound on.
 */
async function finalCutStart(page) {
  const problems = [];
  await page.eval(`(() => { const f = document.querySelector('#final-cut'); scrollTo({ top: f.offsetTop, behavior: 'instant' }); })()`);
  await wait(page, 5000);
  const state = () => page.eval(`(() => { const p = window.__siteDebug.players.find((x) => x.figure.hasAttribute('data-final-cut'));
    const b = document.querySelector('.final__start').getBoundingClientRect();
    return { playing: p.playing, started: p.started, ready: p.ready, time: p.time, muted: p.muted, sound: window.__siteDebug.sound.on, at: [b.left + b.width / 2, b.top + b.height / 2], shown: b.width > 0 }; })()`);
  let s = await state();
  if (s.playing || s.started) problems.push(`the final cut started by itself (at ${s.time.toFixed(1)} s)`);
  if (!s.shown) problems.push('the final cut has no big Play');
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: s.at[0], y: s.at[1], button: 'left', clickCount: 1 });
  await wait(page, 1500);
  s = await state();
  if (!s.playing || s.time > 3 || s.muted || !s.sound) problems.push(`after Play: ${JSON.stringify({ playing: s.playing, time: s.time, muted: s.muted, sound: s.sound })}, not playing from 0:00 with sound`);
  await page.eval(`(() => { const p = window.__siteDebug.players.find((x) => x.figure.hasAttribute('data-final-cut')); p.update({ intent: 'pause' }); window.__siteDebug.sound.set(false); })()`);
  return problems;
}

/** Every in-page link has its target; every local link and image of the page answers 200. */
async function links(page) {
  return page.eval(`(async () => {
    const out = [];
    for (const a of document.querySelectorAll('a[href^="#"]')) if (a.getAttribute('href').length > 1 && !document.getElementById(a.getAttribute('href').slice(1))) out.push('no target for ' + a.getAttribute('href'));
    const refs = [...document.querySelectorAll('a[href], img[src], audio[src]')].map((e) => e.getAttribute('href') ?? e.getAttribute('src'))
      .concat([...document.querySelectorAll('[data-voice]')].map((e) => e.dataset.voice).filter((v) => v !== 'board'));
    const urls = new Set(refs.map((r) => new URL(r, location.href)).filter((u) => u.origin === location.origin).map((u) => u.href.split('#')[0]));
    for (const u of urls) { const r = await fetch(u, { method: 'HEAD' }); if (!r.ok) out.push('HTTP ' + r.status + ' ' + u); }
    return out;
  })()`);
}

/** Every poster of the page drawn small on a canvas: a near-uniform one (an empty frame) fails. */
async function blankPosters(page) {
  return page.eval(`(async () => {
    const out = [];
    for (const img of document.querySelectorAll('figure[data-composition] .poster')) {
      const probe = new Image();
      probe.src = img.src;
      await probe.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 96; canvas.height = 96;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(probe, 0, 0, 96, 96);
      const d = ctx.getImageData(0, 0, 96, 96).data;
      let sum = 0, sq = 0;
      for (let i = 0; i < d.length; i += 4) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; sum += l; sq += l * l; }
      const n = d.length / 4, sd = Math.sqrt(sq / n - (sum / n) ** 2);
      window.__posterDeviation = { ...window.__posterDeviation, [img.closest('figure').dataset.composition]: Math.round(sd) };
      if (sd < ${MIN_POSTER_DEVIATION}) out.push(\`poster of \${img.closest('figure').dataset.composition} is near blank (luminance deviation \${sd.toFixed(1)})\`);
    }
    return out;
  })()`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--out');
  check({ out: i > 0 ? process.argv[i + 1] : undefined }).then(() => console.log('site checks passed'), (e) => { console.error(e.message); process.exit(1); });
}
