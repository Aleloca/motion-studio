// Real-browser checks of the built site, served under /motion-studio/ like GitHub Pages:
// the home at 360, 768, 1440 and 2000 px, with motion on and with prefers-reduced-motion: no horizontal scroll, no console
// errors or failed requests, every composition either live or on its poster, no player told to play under reduced
// motion, no poster a near-blank frame, every link with its target or file. The hero shows the headline, the download and
// step 1 playing by itself, with the next section peeking. With motion each step's demo plays by itself while it is on
// screen and stops when it leaves (`liveSections`); nothing speaks until a Play with sound is clicked, and each of the two
// controls plays its own sound and stops off screen. Under reduced motion every demo is drawn finished (its messages and
// pictures loaded). The gallery plays at most four boards at once and none under reduced motion. The final cut never
// starts by itself; its big Play starts it from 0:00 with sound. On iPhone sizes every demo's boards and panels lie inside
// its canvas, clear of each other, never a black frame, posters loaded (`phoneSections`), and memory comes back after
// scrolling the whole page twice with at most two live runtimes (`phoneMemory`). Then the guide at 360, 768 and 1440 px.
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
/** iPhone 12-15 and 15 Pro viewports. */
const PHONES = [[390, 844], [393, 852]];
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
        problems.push(...await heroView(page, { reduced, width }));
        if (!reduced) problems.push(...await liveSections(page));
        await page.eval(`(async () => { const h = document.documentElement.scrollHeight; for (let y = 0; y < h; y += 500) { scrollTo({ top: y, behavior: 'instant' }); await new Promise(r => setTimeout(r, 250)); } })()`);
        await wait(page, 4000);
        const s = await page.eval(`(() => {
          const live = document.documentElement.classList.contains('js-motion');
          const figs = [...document.querySelectorAll('.comp')].filter((f) => f.getClientRects().length > 0);
          const stage = [...window.__siteDebug.players].filter((p) => p.figure.closest('[data-scene]'));
          return {
            live, scrollWidth: document.documentElement.scrollWidth, innerWidth,
            figures: figs.length,
            settled: figs.filter((f) => f.classList.contains('is-ready') || f.classList.contains('is-failed') || f.querySelector('.poster').complete).length,
            ready: figs.filter((f) => f.classList.contains('is-ready')).length,
            errored: figs.filter((f) => f.dataset.fail === 'error').map((f) => f.dataset.composition),
            timedOut: figs.filter((f) => f.dataset.fail === 'timeout').map((f) => f.dataset.composition),
            blank: figs.filter((f) => f.classList.contains('is-ready') && !f.querySelector('iframe')).length,
            played: window.__siteDebug.commands.filter((c) => c.type === 'play').length,
            // With motion the demos bring their own pieces in and out; everything else must be readable once scrolled past.
            hidden: [...document.querySelectorAll('h1, h2, h3, p, .btn, .way')].filter((e) => !(live && e.closest('.demo')) && getComputedStyle(e).opacity < 0.5).length,
            stagePlaying: stage.filter((p) => p.playing).map((p) => p.id),
            finalCut: Boolean(document.querySelector('figure[data-final-cut][data-composition] .player-bar .player-bar__play')),
            soundControls: [...document.querySelectorAll('[data-sound-play]')].filter((b) => !b.hidden && b.getClientRects().length > 0).length,
            steps: [...document.querySelectorAll('[data-scene]')].map((st) => ({
              n: st.dataset.scene,
              shown: st.getClientRects().length > 0 && st.offsetHeight > 0 && getComputedStyle(st).visibility !== 'hidden',
              messages: [...st.querySelectorAll('.msg')].filter((m) => getComputedStyle(m).visibility !== 'hidden' && Number(getComputedStyle(m).opacity) > 0.5).length,
              images: [...st.querySelectorAll('.scene img')].map((i) => i.complete && i.naturalWidth > 0),
              files: st.querySelectorAll('.export__rows li').length,
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
        if (s.stagePlaying.length) problems.push(`demo boards still playing off screen: ${s.stagePlaying.join(', ')}`);
        if (!s.finalCut) problems.push('the final cut\'s slot or controls are missing');
        if (s.steps.length !== 10) problems.push(`${s.steps.length} demos, not 10`);
        if (s.soundControls !== 2) problems.push(`${s.soundControls} Play with sound controls, not 2`);
        if (reduced) {
          for (const st of s.steps) {
            if (!st.shown) problems.push(`step ${st.n} is not shown`);
            if (!st.messages) problems.push(`step ${st.n} shows no message`);
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
    // The demos on a phone (iPhone sizes, at 3x): every demo's content inside its canvas, clear, loaded and never black;
    // each plays on screen and stops off it; screenshots of every demo, the final cut and the gallery.
    for (const [width, height] of PHONES) {
      const tag = `phone ${width}x${height}`;
      const page = await chrome.newPage();
      await page.send('Runtime.enable'); await page.send('Page.enable');
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: true });
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await page.goto(`${server.url}?debug`);
      await wait(page, 2500);
      const problems = await phoneSections(page, { out: width === 390 && out ? out : null });
      problems.push(...await liveSections(page));
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

const sceneNames = (page) => page.eval(`[...document.querySelectorAll('[data-scene]')].map((e) => e.dataset.scene)`);
const toScene = (page, name) => page.eval(`(() => { const d = document.querySelector('[data-scene="${name}"]'); const demo = d.classList.contains('demo') ? d : d.querySelector('.demo'); const r = demo.getBoundingClientRect(); scrollTo({ top: scrollY + r.top + r.height / 2 - innerHeight / 2, behavior: 'instant' }); })()`);

/**
 * The first viewport: the headline, the download (on a computer; the bar's Get it on a phone), the final cut's link, step 1
 * playing by itself (with motion), and the next section peeking under it.
 */
async function heroView(page, { reduced, width }) {
  const problems = [];
  await page.eval(`scrollTo({ top: 0, behavior: 'instant' })`);
  await new Promise((r) => setTimeout(r, 900));
  const h = await page.eval(`(() => {
    const on = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && getComputedStyle(el).display !== 'none'; };
    const brief = window.__siteDebug.scenes.find((s) => s.name === 'brief');
    return {
      title: on(document.querySelector('h1')),
      download: on(document.querySelector('.hero__download')), getIt: on(document.querySelector('.topbar__get')),
      film: on(document.querySelector('.hero a[href="#final-cut"]')),
      demo: document.querySelector('.demo--hero').getBoundingClientRect().top < innerHeight,
      next: document.querySelector('#step-ask').getBoundingClientRect().top < innerHeight || document.querySelector('.demo--hero').getBoundingClientRect().bottom > innerHeight,
      playing: brief?.playing ?? false,
    };
  })()`);
  if (!h.title) problems.push('hero: the headline is not in the first viewport');
  if (width >= 721 ? !h.download : !h.getIt) problems.push(`hero: no ${width >= 721 ? 'download' : 'Get it'} in the first viewport`);
  if (!h.film) problems.push('hero: no link to the final cut in the first viewport');
  if (!h.demo) problems.push('hero: step 1 is not in the first viewport');
  if (!h.next) problems.push('hero: nothing shows that the page goes on');
  if (h.playing === reduced) problems.push(`hero: step 1 is ${h.playing ? 'playing' : 'still'} ${reduced ? 'under' : 'without'} reduced motion`);
  return problems;
}

/**
 * Each step's demo, scrolled into view: it plays by itself (its time moves on) while the others are paused, no panel cuts
 * its content, its boards
 * that should play have a runtime unless the page's budget is full, and the page never holds more runtimes than its
 * budget. Nothing speaks by itself. Generate's Play with sound plays its voice-over and stops when it scrolls away;
 * Subtitles' lets its board speak and a second click silences it.
 */
async function liveSections(page) {
  const problems = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const name of await sceneNames(page)) {
    await toScene(page, name);
    await wait(1300);
    const a = await page.eval(`window.__siteDebug.scenes.find((s) => s.name === '${name}').time`);
    await wait(700);
    const r = await page.eval(`(() => {
      const d = window.__siteDebug;
      const me = d.scenes.find((s) => s.name === '${name}');
      const root = document.querySelector('[data-scene="${name}"]');
      return {
        playing: me.playing, time: me.time,
        others: d.scenes.filter((s) => s !== me && s.playing).map((s) => s.name)
          .filter((n) => { const e = document.querySelector('[data-scene="' + n + '"]'); const b = (e.classList.contains('demo') ? e : e.querySelector('.demo')).getBoundingClientRect(); return b.bottom < 0 || b.top > innerHeight; }),
        frames: document.querySelectorAll('iframe').length, limit: d.budget.limit,
        unmounted: d.players.filter((p) => root.contains(p.figure) && p.state.visible && !p.frame && !p.failed).map((p) => p.id),
        full: d.budget.live.size >= d.budget.limit,
        loud: d.players.filter((p) => !p.muted).map((p) => p.id), audio: d.sounds.audio,
        cut: [...root.querySelectorAll('.scene > .panel, .scene > .export')].filter((p) => p.scrollHeight > p.clientHeight + 1).map((p) => p.className.split(' ')[1]),
      };
    })()`);
    if (!r.playing || r.time === a) problems.push(`${name}: on screen, its demo does not play (${r.playing ? 'stuck at ' + r.time.toFixed(2) : 'paused'})`);
    if (r.others.length) problems.push(`${name}: demos off screen still playing: ${r.others.join(', ')}`);
    if (r.frames > r.limit) problems.push(`${name}: ${r.frames} runtimes on the page, over its budget of ${r.limit}`);
    if (r.unmounted.length && !r.full) problems.push(`${name}: boards to play with no runtime: ${r.unmounted.join(', ')}`);
    if (r.cut.length) problems.push(`${name}: panels cut their content: ${r.cut.join(', ')}`);
    if (r.loud.length || r.audio) problems.push(`${name}: something speaks by itself: ${JSON.stringify(r)}`);
  }
  const click = async (sel) => {
    const at = await page.eval(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: at[0], y: at[1], button: 'left', clickCount: 1 });
  };
  const sound = () => page.eval(`(() => { const d = window.__siteDebug; const subs = d.players.find((p) => p.id === 'story-subs'); return { playing: d.sounds.playing, audio: d.sounds.audio, subsMuted: subs.muted, held: !d.scenes.find((s) => s.name === 'generate').playing }; })()`);
  await toScene(page, 'generate');
  await wait(1000);
  await click('[data-sound-play="generate"]');
  await wait(1500);
  let v = await sound();
  if (v.playing !== 'generate' || !v.audio?.src.endsWith('/vo-06.mp3') || v.audio.paused) problems.push(`Generate's Play with sound: ${JSON.stringify(v)}, not its voice-over playing`);
  await toScene(page, 'languages');
  await wait(1200);
  v = await sound();
  if (v.playing || v.audio) problems.push(`Generate's sound still plays after it scrolled away: ${JSON.stringify(v)}`);
  await toScene(page, 'subtitles');
  await wait(1200);
  await click('[data-sound-play="subtitles"]');
  await wait(2000);
  v = await sound();
  if (v.playing !== 'subtitles' || v.subsMuted) problems.push(`Subtitles' Play with sound: ${JSON.stringify(v)}, not its board speaking`);
  await click('[data-sound-play="subtitles"]');
  await wait(500);
  v = await sound();
  if (v.playing || !v.subsMuted) problems.push(`Subtitles' sound after a second click: ${JSON.stringify(v)}`);
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
 * Every demo on a phone, at its finished state and on arrival: the boards, panels and dialogs it shows lie inside its
 * canvas and clear of each other (a board with its label), no panel cuts its content, its pictures are loaded, no board is a black frame (sampled from
 * a screenshot), the chat's text is never cut, and there is no sideways scroll. With `out`, a screenshot of each demo
 * (iphone-<step>.png), of the final cut and of the gallery.
 */
export async function phoneSections(page, { out }) {
  const problems = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => { const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(out, name), Buffer.from(data, 'base64')); };
  for (const name of await sceneNames(page)) {
    await toScene(page, name);
    await wait(500);
    for (const p of await demoContent(page, name, { settled: false })) problems.push(`${name}, on arrival: ${p}`);
    // Its finished state (the hold before it starts again).
    await page.eval(`(() => { const s = window.__siteDebug.scenes.find((x) => x.name === '${name}'); s.timeline.time(s.actEnd + 0.3); })()`);
    await wait(1500);
    for (const p of await demoContent(page, name)) problems.push(`${name}: ${p}`);
    if (out) await shot(`iphone-${name}.png`);
  }
  if (out) {
    await page.eval(`scrollTo({ top: document.querySelector('#final-cut').offsetTop - 60, behavior: 'instant' })`);
    await wait(2500);
    await shot('iphone-final.png');
    await page.eval(`scrollTo({ top: document.querySelector('.gallery').offsetTop - 60, behavior: 'instant' })`);
    await wait(3000);
    await shot('iphone-gallery.png');
  }
  return problems;
}

/** One demo's content on screen: see `phoneSections`. */
export async function demoContent(page, name, { settled = true } = {}) {
  const s = await page.eval(`(() => {
    const root = document.querySelector('[data-scene="${name}"]');
    const demo = root.classList.contains('demo') ? root : root.querySelector('.demo');
    const canvas = demo.querySelector('.demo__canvas').getBoundingClientRect();
    const alpha = (el) => {
      let a = 1;
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
        a *= Number(cs.opacity);
      }
      return el.getClientRects().length ? a : 0;
    };
    const out = [];
    const items = [...demo.querySelectorAll('.scene > .at')].map((el) => {
      const r = el.getBoundingClientRect(); const label = el.querySelector(':scope > .board__label');
      const top = label ? Math.min(r.top, label.getBoundingClientRect().top) : r.top;
      return { el, name: el.dataset.board ?? el.className.split(' ')[1], a: alpha(el), r: { left: r.left, right: r.right, top, bottom: r.bottom } };
    }).filter((e) => e.a >= 0.5);
    const hit = (p, q) => p.r.left < q.r.right - 1 && p.r.right > q.r.left + 1 && p.r.top < q.r.bottom - 1 && p.r.bottom > q.r.top + 1;
    items.forEach((p, i) => items.slice(i + 1).forEach((q) => { if (${settled} && hit(p, q)) out.push(p.name + ' and ' + q.name + ' are drawn over each other'); }));
    for (const e of items) if (e.r.left < canvas.left - 1 || e.r.right > canvas.right + 1 || e.r.top < canvas.top - 1 || e.r.bottom > canvas.bottom + 1) out.push(e.name + ' leaves its canvas');
    if (${settled}) for (const img of demo.querySelectorAll('.scene img')) if (!(img.complete && img.naturalWidth > 0)) out.push('a picture is not loaded: ' + img.getAttribute('src'));
    for (const m of demo.querySelectorAll('.chat .msg')) if (m.scrollWidth > m.clientWidth + 1) out.push('the chat cuts "' + m.textContent.slice(0, 30) + '…"');
    // A panel never cuts its own content.
    for (const p of demo.querySelectorAll('.scene > .panel, .scene > .export')) if (alpha(p) >= 0.5 && p.scrollHeight > p.clientHeight + 1) out.push(p.className.split(' ')[1] + ' cuts its content (' + p.scrollHeight + ' > ' + p.clientHeight + ')');
    if (document.documentElement.scrollWidth > innerWidth) out.push('horizontal scroll');
    const frames = items.map((e) => [e.name, e.el.querySelector(':scope > .board__frame')?.getBoundingClientRect()]).filter(([, r]) => r)
      .map(([n, r]) => ({ name: n, x: Math.max(0, r.left), y: Math.max(0, r.top), w: Math.min(innerWidth, r.right) - Math.max(0, r.left), h: Math.min(innerHeight, r.bottom) - Math.max(0, r.top) }))
      .filter((f) => f.w > 8 && f.h > 8);
    return { out, frames, sx: scrollX, sy: scrollY };
  })()`);
  const problems = [...s.out];
  // A composition may hold an empty frame for a moment (between two scenes): blank means blank three times over 1.6 s.
  let blank = s.frames;
  const last = {};
  for (let i = 0; i < 3 && blank.length; i++) {
    if (i) await new Promise((r) => setTimeout(r, 800));
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
