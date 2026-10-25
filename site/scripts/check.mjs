// Real-browser checks of the built site, served under /motion-studio/ like GitHub Pages:
// the home at 360, 768, 1440 and 2000 px, with motion on and with prefers-reduced-motion: no horizontal scroll, no console
// errors or failed requests, every composition either live or on its poster, no player told to play under reduced
// motion, no poster a near-blank frame, every link with its target or file. The story: with motion, each step comes on
// screen at its scroll position, only its boards are mounted, and the canvas's players stop once it has scrolled away;
// under reduced motion every step is a static block (its messages and its result's images loaded). The story's sound
// button turns the voice-over on and off. The gallery plays at most four boards at once and none under reduced motion. The final cut never starts by itself; its big Play starts it from 0:00 with sound. On iPhone sizes the story fits between the bar and the sheet, the sheet sits on the visible bottom as the toolbar shows and hides (`phoneStory`), and memory comes back after scrolling the whole page twice with at most two live runtimes (`phoneMemory`). Then the guide (guide.html) at 360, 768 and 1440 px.
// Usage: node site/scripts/check.mjs [--out <folder for screenshots>]
import { mkdirSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../build.mjs';
import { serve } from './serve.mjs';
import { launchChrome } from './chrome.mjs';

const WIDTHS = [360, 768, 1440];
const HOME_WIDTHS = [...WIDTHS, 2000];
/** iPhone 12-15 and 15 Pro viewports; the toolbar's shown state is simulated by a shorter viewport. */
const PHONES = [[390, 844], [393, 852]];
const TOOLBAR = 84;
/** A poster whose luminance varies less than this (standard deviation, 0-255) is a near-blank frame. */
export const MIN_POSTER_DEVIATION = 12;
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
        if (!reduced && (width === 1440 || width === 360)) problems.push(...await storyFromAnywhere(page, server));
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
    // The story on a phone (iPhone sizes, at 3x): every step's content between the bar and the sheet, the sheet flush with
    // the bottom of the visible viewport as the toolbar hides and shows, its text never cut mid-line, the sound switch off
    // the boards; screenshots of every step, the final cut and the gallery.
    for (const [width, height] of PHONES) {
      const tag = `phone ${width}x${height}`;
      const page = await chrome.newPage();
      await page.send('Runtime.enable'); await page.send('Page.enable');
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: true });
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await page.goto(`${server.url}?debug`);
      await wait(page, 2500);
      const problems = await phoneStory(page, { width, height, out: width === 390 && out ? out : null });
      problems.push(...await phoneMemory(page, tag));
      console.log(`${tag}: ${problems.length ? problems.length + ' problem(s)' : 'ok'}`);
      failures.push(...problems.map((p) => `${tag}: ${p}`));
      await page.close();
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
 * has a runtime mounted (unless the page's budget of live runtimes is full), and the page never holds more runtimes than its budget. With the sound turned on (a real
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
        frames: document.querySelectorAll('iframe').length, limit: window.__siteDebug.budget.limit,
        unmounted: stage.filter((p) => p.state.visible && !p.frame && !p.failed).map((p) => p.id),
        // The page's budget of live runtimes: past it a board waits on its poster.
        full: window.__siteDebug.budget.live.size >= window.__siteDebug.budget.limit,
      };
    })()`);
    if (r.step !== n) problems.push(`scrolled to step ${n}, the story shows step ${r.step}`);
    if (r.frames > r.limit) problems.push(`step ${n}: ${r.frames} runtimes on the page, over its budget of ${r.limit}`);
    if (r.unmounted.length && !r.full) problems.push(`step ${n}: boards to play with no runtime: ${r.unmounted.join(', ')}`);
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
    return { mounted: Boolean(p.frame), playing: p.playing, started: p.started, ready: p.ready, time: p.time, muted: p.muted, sound: window.__siteDebug.sound.on, at: [b.left + b.width / 2, b.top + b.height / 2], shown: b.width > 0 }; })()`);
  let s = await state();
  if (s.mounted) problems.push('the final cut has a runtime before its Play');
  if (s.playing || s.started) problems.push(`the final cut started by itself (at ${s.time.toFixed(1)} s)`);
  if (!s.shown) problems.push('the final cut has no big Play');
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: s.at[0], y: s.at[1], button: 'left', clickCount: 1 });
  // Its runtime is mounted only now (none waits behind the poster): a little time to load.
  for (let i = 0; i < 40; i++) { await wait(page, 500); s = await state(); if (s.playing) break; }
  if (!s.playing || s.time > 3 || s.muted || !s.sound) problems.push(`after Play: ${JSON.stringify({ playing: s.playing, time: s.time, muted: s.muted, sound: s.sound })}, not playing from 0:00 with sound`);
  await page.eval(`(() => { const p = window.__siteDebug.players.find((x) => x.figure.hasAttribute('data-final-cut')); p.update({ intent: 'pause' }); window.__siteDebug.sound.set(false); })()`);
  return problems;
}

/**
 * The story follows the scroll both ways whatever the scroll position at load: loaded at #final-cut, reloaded at the
 * bottom (the browser restores the scroll) and reloaded mid-story, then scrolled up step by step and down again, each
 * step is the one on screen and the canvas (camera, board C's version or its Chosen mark) changes with it.
 */
export async function storyFromAnywhere(page, server) {
  const problems = [];
  const toStep = (n) => page.eval(`(() => { const s = document.querySelector('.story'); scrollTo({ top: s.offsetTop + (s.offsetHeight - innerHeight) * (${n - 0.45} / 11.6), behavior: 'instant' }); })()`);
  const state = () => page.eval(`(() => ({ step: window.__siteDebug.story?.step, world: document.querySelector('.world').style.transform, ver: document.querySelector('[data-board="c"] .board__ver').textContent, chosen: document.querySelector('[data-board="c"]').classList.contains('is-chosen'), caption: document.querySelector('.caption__n').textContent }))()`);
  const walk = async (label, order) => {
    let prev = null;
    for (const n of order) {
      await toStep(n);
      await wait(page, 900);
      const s = await state();
      if (s.step !== n || s.caption !== String(n).padStart(2, '0')) problems.push(`${label}: scrolled to step ${n}, the story shows step ${s.step} (caption ${s.caption})`);
      if (prev && s.world === prev.world && s.ver === prev.ver && s.chosen === prev.chosen) problems.push(`${label}: the canvas did not change from step ${prev.step} to step ${n}`);
      prev = s;
    }
  };
  const up = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]; const down = [...up].reverse();
  // A reload from the page itself never answers the evaluation: the protocol's reload, then a wait on this side.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reload = async () => { await page.send('Page.reload', {}); await sleep(4000); };
  const loads = [
    // A new query: the same URL with only a new hash would be a same-page jump, with no load to wait for.
    ['loaded at #final-cut', async () => { await page.goto(`${server.url}?debug&load=hash#final-cut`); await sleep(3000); }],
    ['reloaded at the bottom', async () => { await page.eval(`scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })`); await sleep(400); await reload(); }],
    ['reloaded mid-story', async () => { await toStep(6); await sleep(400); await reload(); }],
  ];
  for (const [label, load] of loads) {
    await load();
    const y = await page.eval('scrollY');
    if (label !== 'reloaded mid-story' && y < 1000) problems.push(`${label}: the page opened at ${y}, not scrolled down`);
    await walk(`${label}, up`, label === 'reloaded mid-story' ? [6, 5, 4, 3, 2, 1] : up);
    await walk(`${label}, down`, down);
  }
  return problems;
}

/**
 * The live story on a phone, step by step (at rest on each step, then with the toolbar shown and hidden again): the sheet's
 * bottom is the visible viewport's; every board, panel and dialog the step shows lies between the bar and the sheet; the
 * sheet clips nothing, and its clamped text ends on a whole line; the sound switch is in the bar, over no board. With
 * `out`, a screenshot of each step (iphone-step-NN.png), of the final cut and of the gallery.
 */
export async function phoneStory(page, { width, height, out }) {
  const problems = [];
  const toStep = (n) => page.eval(`(() => { const s = document.querySelector('.story'); scrollTo({ top: s.offsetTop + (s.offsetHeight - innerHeight) * (${n - 0.45} / 11.6), behavior: 'instant' }); })()`);
  const shot = async (name) => { const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(out, name), Buffer.from(data, 'base64')); };
  const measure = () => page.eval(`(() => {
    const out = [];
    const vv = visualViewport;
    const sheet = document.querySelector('.chat').getBoundingClientRect();
    const bar = document.querySelector('.topbar').getBoundingClientRect();
    if (Math.abs(sheet.bottom - (vv.offsetTop + vv.height)) > 1) out.push('the sheet ends at ' + Math.round(sheet.bottom) + ', the visible viewport at ' + Math.round(vv.offsetTop + vv.height));
    const shown = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.5) return false; const f = /opacity\\(([\\d.]+)\\)/.exec(e.style.filter); if (f && Number(f[1]) < 0.5) return false; } return el.getClientRects().length > 0; };
    // What the step shows: on screen (a board scrolled right off the canvas is not part of it), not faded out.
    const content = [...document.querySelectorAll('.world > .board, .world > .panel, [data-stage] .export')].filter(shown)
      .filter((el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; });
    const boxes = [];
    for (const el of content) {
      const r = el.getBoundingClientRect();
      const label = el.querySelector(':scope > .board__label');
      const top = label && shown(label) ? Math.min(r.top, label.getBoundingClientRect().top) : r.top;
      const name = el.dataset.board ?? el.className.split(' ').slice(-1)[0];
      boxes.push(r);
      if (top < bar.bottom - 1 || r.bottom > sheet.top + 1 || r.left < -1 || r.right > innerWidth + 1) out.push(name + ' is cut (' + [r.left, top, r.right, r.bottom].map(Math.round).join(', ') + '; room ' + Math.round(bar.bottom) + '-' + Math.round(sheet.top) + ')');
    }
    for (const el of [document.querySelector('.chat'), document.querySelector('.chat__log')]) if (el.scrollHeight > el.clientHeight + 1) out.push('the sheet clips its content (' + el.className + ': ' + el.scrollHeight + ' > ' + el.clientHeight + ')');
    // A clamped text (its content taller than its box) shows whole lines only, with no padding under them for the next
    // line to peek into.
    for (const el of document.querySelectorAll('.chat .ex.is-current .msg, .chat .ex.is-current .msg *')) {
      if (!shown(el) || el.scrollHeight <= el.clientHeight + 1) continue;
      const cs = getComputedStyle(el); const lh = parseFloat(cs.lineHeight); const inner = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const lines = inner / lh;
      if (Math.abs(lines - Math.round(lines)) > 0.05 || parseFloat(cs.paddingBottom) > 0) out.push('the sheet cuts a line of "' + el.textContent.slice(0, 30) + '…"');
    }
    const snd = document.querySelector('.story__sound');
    if (!snd.closest('.topbar')) out.push('the sound switch is not in the bar');
    const s = snd.getBoundingClientRect();
    if (!s.width) out.push('the sound switch is not shown');
    for (const r of boxes) if (s.left < r.right && s.right > r.left && s.top < r.bottom && s.bottom > r.top) out.push('the sound switch covers a board');
    for (const sel of ['.topbar__brand', '.topbar__get']) { const r = document.querySelector(sel)?.getBoundingClientRect(); if (!r?.width || (s.left < r.right && s.right > r.left)) out.push('the sound switch and ' + sel + ' overlap, or ' + sel + ' is missing'); }
    if (getComputedStyle(document.querySelector('.topbar__download')).display !== 'none') out.push('the bar still offers the macOS download');
    if (document.documentElement.scrollWidth > innerWidth) out.push('horizontal scroll');
    return out;
  })()`);
  const metrics = (h) => page.send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 3, mobile: true });
  // At rest on each step, and again late in it (step 11: once the export dialog has closed on the whole canvas).
  const stops = [...Array.from({ length: 11 }, (_, i) => i + 1), 11.4];
  for (const n of stops) {
    await toStep(n);
    // Just arrived, then settled: the step's boards are never a black frame, its end state is reached, and nothing of
    // another step is drawn over its content.
    await wait(page, 400);
    for (const p of await stepContent(page, n, { settled: false })) problems.push(`step ${n}, on arrival: ${p}`);
    await wait(page, 1100);
    for (const p of await measure()) problems.push(`step ${n}: ${p}`);
    for (const p of await stepContent(page, n)) problems.push(`step ${n}: ${p}`);
    if (out && Number.isInteger(n)) await shot(`iphone-step-${String(n).padStart(2, '0')}.png`);
  }
  // And back up, step by step: the transitions the other way leave no earlier board over the new step.
  for (let n = 10; n >= 1; n--) {
    await toStep(n);
    await wait(page, 1200);
    for (const p of await stepContent(page, n)) problems.push(`step ${n}, scrolled back: ${p}`);
  }
  // The toolbar shows (a shorter visible viewport), then hides again: the sheet follows the bottom each time. (Emulation
  // shrinks svh with the viewport, and the story's length with it: the step is found again at each height; on a phone svh
  // stays put.)
  for (const n of [4, 11]) {
    for (const h of [height - TOOLBAR, height]) {
      await metrics(h);
      await toStep(n);
      await wait(page, 1200);
      for (const p of await measure()) problems.push(`step ${n} at ${h} px: ${p}`);
    }
  }
  if (out) {
    await page.eval(`scrollTo({ top: document.querySelector('#final-cut').offsetTop - 60, behavior: 'instant' })`);
    await wait(page, 2500);
    await shot('iphone-final.png');
    await page.eval(`scrollTo({ top: document.querySelector('.gallery').offsetTop - 60, behavior: 'instant' })`);
    await wait(page, 3000);
    await shot('iphone-gallery.png');
  }
  return problems;
}

/**
 * The story's canvas on a phone at step `n`: what is drawn (boards, panels, the export dialog, by their effective opacity)
 * splits into the step's content (half opaque or more) and faded leftovers; no two pieces of content overlap and no
 * leftover lies over the content; board C wears the step's version (not "Rendering…"); and every board of the content shows
 * a picture, never a near-uniform black frame (sampled from a screenshot).
 */
export async function stepContent(page, n, { settled = true } = {}) {
  const s = await page.eval(`(() => {
    const alpha = (el) => {
      let a = 1;
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
        a *= Number(cs.opacity);
        const f = /opacity\\(([\\d.]+)\\)/.exec(e.style.filter); if (f) a *= Number(f[1]);
      }
      return el.getClientRects().length ? a : 0;
    };
    const room = { top: document.querySelector('.topbar').getBoundingClientRect().bottom, bottom: document.querySelector('.chat').getBoundingClientRect().top };
    const els = [...document.querySelectorAll('.world > .board, .world > .panel, [data-stage] .export')]
      .map((el) => ({ el, name: el.dataset.board ?? el.className.split(' ').at(-1), a: alpha(el), r: el.getBoundingClientRect() }))
      .filter((e) => e.a > 0.05 && e.r.bottom > room.top && e.r.top < room.bottom);
    const content = els.filter((e) => e.a >= 0.5); const faded = els.filter((e) => e.a < 0.5);
    const hit = (p, q) => p.r.left < q.r.right - 1 && p.r.right > q.r.left + 1 && p.r.top < q.r.bottom - 1 && p.r.bottom > q.r.top + 1;
    const out = [];
    content.forEach((p, i) => content.slice(i + 1).forEach((q) => { if (hit(p, q)) out.push(p.name + ' and ' + q.name + ' are drawn over each other'); }));
    for (const f of faded) for (const c of content) if (hit(f, c)) out.push(f.name + ' (another step\\'s, ' + f.a.toFixed(2) + ') lies over ' + c.name);
    // Every poster laid out on the canvas is loaded (a version waits for its wipe under a clip-path that hides it all:
    // left lazy, WebKit loads it only as the wipe reveals it, a black frame until then).
    if (${settled}) for (const img of document.querySelectorAll('.world img.poster')) if (img.closest('[hidden]') === null && !(img.complete && img.naturalWidth > 0)) out.push('the poster of ' + img.closest('figure').dataset.composition + ' is laid out but not loaded');
    const label = document.querySelector('[data-board="c"] .board__ver');
    const want = label.dataset.versions.split(' ').map((x) => x.split(':')).filter(([k]) => Number(k) <= ${Math.floor(n)}).at(-1)[1];
    if (label.textContent !== want) out.push('board C says "' + label.textContent + '", not ' + want);
    const frames = content.map((e) => [e.name, e.el.querySelector(':scope > .board__frame')?.getBoundingClientRect()]).filter(([, r]) => r)
      .map(([name, r]) => ({ name, x: Math.max(0, r.left), y: Math.max(room.top, r.top), w: Math.min(innerWidth, r.right) - Math.max(0, r.left), h: Math.min(room.bottom, r.bottom) - Math.max(room.top, r.top) }))
      .filter((f) => f.w > 8 && f.h > 8);
    return { out, frames, sx: scrollX, sy: scrollY };
  })()`);
  const problems = [...s.out];
  // A composition may hold an empty frame for a moment (between two scenes): blank means blank three times over 1.6 s.
  let blank = s.frames;
  let last = {};
  for (let i = 0; i < 3 && blank.length; i++) {
    if (i) await wait(page, 800);
    const still = [];
    for (const f of blank) {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: f.x + s.sx, y: f.y + s.sy, width: f.w, height: f.h, scale: 0.25 } });
      const l = pngLuma(Buffer.from(data, 'base64'));
      if (l.sd < MIN_BOARD_DEVIATION) { still.push(f); last[f.name] = l; }
    }
    blank = still;
  }
  for (const f of blank) problems.push(`board ${f.name} is a blank frame (luminance ${last[f.name].mean.toFixed(0)} ± ${last[f.name].sd.toFixed(1)}) for 1.6 s`);
  return problems;
}

/** A board whose screenshot varies less than this (luminance standard deviation) shows no picture: black, or empty. */
const MIN_BOARD_DEVIATION = 6;

/** Mean and standard deviation of the luminance of an 8-bit, non-interlaced PNG (RGB or RGBA), as Chrome writes them. */
export function pngLuma(buf) {
  const width = buf.readUInt32BE(16); const height = buf.readUInt32BE(20); const type = buf[25];
  const bpp = type === 6 ? 4 : 3;
  const chunks = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o); const kind = buf.toString('ascii', o + 4, o + 8);
    if (kind === 'IDAT') chunks.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * bpp; const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0; const b = y > 0 ? px[(y - 1) * stride + x] : 0; const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      const pa = Math.abs(b - c); const pb = Math.abs(a - c); const pc = Math.abs(a + b - 2 * c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      px[y * stride + x] = (v + pred) & 255;
    }
  }
  let sum = 0; let sq = 0; const n = width * height;
  for (let i = 0; i < n; i++) { const l = 0.2126 * px[i * bpp] + 0.7152 * px[i * bpp + 1] + 0.0722 * px[i * bpp + 2]; sum += l; sq += l * l; }
  return { mean: sum / n, sd: Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)) };
}

/**
 * Memory on a phone: the whole page scrolled down and up twice. At no point more live runtimes than the phone's budget;
 * back at the top after the second pass, the JS heap, the DOM nodes and the documents (each runtime and each of its html
 * layers is one) are within a small margin of the first pass: nothing visited is kept.
 */
export async function phoneMemory(page, tag) {
  const problems = [];
  await page.send('Performance.enable');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => {
    await page.eval(`scrollTo({ top: 0, behavior: 'instant' })`);
    await sleep(3000);
    await page.send('HeapProfiler.collectGarbage');
    await sleep(500);
    const { metrics } = await page.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    return { heap: m.JSHeapUsedSize, nodes: m.Nodes, docs: m.Documents };
  };
  const limit = await page.eval('window.__siteDebug.budget.limit');
  let most = 0;
  const passes = [];
  for (let pass = 0; pass < 2; pass++) {
    const h = await page.eval('document.documentElement.scrollHeight');
    const ys = []; for (let y = 0; y <= h; y += 450) ys.push(y);
    for (const y of [...ys, ...ys.reverse()]) {
      await page.eval(`scrollTo({ top: ${y}, behavior: 'instant' })`);
      await sleep(320);
      most = Math.max(most, await page.eval(`document.querySelectorAll('iframe').length`));
    }
    passes.push(await settle());
  }
  const [a, b] = passes;
  const mb = (v) => (v / 1048576).toFixed(1);
  console.log(`${tag} memory: at most ${most} live runtimes (budget ${limit}); at the top after pass 1 / 2: heap ${mb(a.heap)} / ${mb(b.heap)} MB, nodes ${a.nodes} / ${b.nodes}, documents ${a.docs} / ${b.docs}`);
  if (most > limit) problems.push(`${most} live runtimes at once, over the phone's budget of ${limit}`);
  if (b.heap > a.heap * 1.15 + 1048576) problems.push(`the JS heap grew from ${mb(a.heap)} to ${mb(b.heap)} MB between two passes`);
  if (b.nodes > a.nodes * 1.1 + 50) problems.push(`DOM nodes grew from ${a.nodes} to ${b.nodes} between two passes`);
  if (b.docs > a.docs + 4) problems.push(`documents grew from ${a.docs} to ${b.docs} between two passes`);
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
