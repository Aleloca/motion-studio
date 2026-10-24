// Real-browser checks of the built site, served under /motion-studio/ like GitHub Pages:
// the home at 360, 768, 1440 and 2000 px, with motion on and with prefers-reduced-motion: no horizontal scroll, no console
// errors or failed requests, every composition either live or on its poster, no player told to play under reduced
// motion, no poster a near-blank frame, every link with its target or file. The story: with motion, each step comes on
// screen at its scroll position, only its boards are mounted, and the canvas's players stop once it has scrolled away;
// under reduced motion every step is a static block (its messages and its result's images loaded). The final cut's slot
// and controls exist. Then the guide (guide.html) at 360, 768 and 1440 px.
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
        if (s.steps.length !== 10) problems.push(`${s.steps.length} steps, not 10`);
        if (reduced) {
          for (const st of s.steps) {
            if (!st.shown) problems.push(`step ${st.n} is not shown as a static block`);
            if (!st.messages) problems.push(`step ${st.n} has no message`);
            if (!st.images.length && !st.files) problems.push(`step ${st.n} has no result`);
            if (st.images.some((ok) => !ok)) problems.push(`step ${st.n}: an image of its result did not load`);
          }
        }
        problems.push(...await links(page));
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
 * has a runtime mounted, and no more than MAX_STAGE_FRAMES runtimes are on the canvas.
 */
async function liveStory(page) {
  const problems = [];
  for (let n = 1; n <= 10; n++) {
    await page.eval(`(() => { const s = document.querySelector('.story'); scrollTo({ top: s.offsetTop + (s.offsetHeight - innerHeight) * (${n - 0.45} / 10.6), behavior: 'instant' }); })()`);
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
  return problems;
}

/** Every in-page link has its target; every local link and image of the page answers 200. */
async function links(page) {
  return page.eval(`(async () => {
    const out = [];
    for (const a of document.querySelectorAll('a[href^="#"]')) if (a.getAttribute('href').length > 1 && !document.getElementById(a.getAttribute('href').slice(1))) out.push('no target for ' + a.getAttribute('href'));
    const urls = new Set([...document.querySelectorAll('a[href], img[src]')].map((e) => new URL(e.getAttribute('href') ?? e.getAttribute('src'), location.href)).filter((u) => u.origin === location.origin).map((u) => u.href.split('#')[0]));
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
