// Real-browser checks of the built site, served under /motion-studio/ like GitHub Pages:
// at 360, 768 and 1440 px, with motion on and with prefers-reduced-motion, it checks for no horizontal scroll, no console
// errors or failed requests, every composition either live or on its poster, and no player told to play under reduced
// motion, plus the showcase cards at 2000 px: every card a clean frame (its figure fills the media area above the label,
// the stage centred inside it in its own ratio, at any scroll position) and no poster a near-blank frame; then the guide
// (guide.html) at 360, 768 and 1440 px. Usage: node site/scripts/check.mjs [--out <folder for screenshots>]
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
        await page.eval(`(async () => { const h = document.documentElement.scrollHeight; for (let y = 0; y < h; y += 500) { scrollTo({ top: y, behavior: 'instant' }); await new Promise(r => setTimeout(r, 350)); } })()`);
        await wait(page, 4000);
        const s = await page.eval(`(() => {
          // Figures in the hero's waiting sets (hidden until the cycle reaches them, posters loaded lazily) are not shown.
          const figs = [...document.querySelectorAll('.comp')].filter((f) => f.getClientRects().length > 0);
          return {
            scrollWidth: document.documentElement.scrollWidth, innerWidth,
            figures: figs.length,
            settled: figs.filter((f) => f.classList.contains('is-ready') || f.classList.contains('is-failed') || f.querySelector('.poster').complete).length,
            ready: figs.filter((f) => f.classList.contains('is-ready')).length,
            errored: figs.filter((f) => f.dataset.fail === 'error').map((f) => f.dataset.composition),
            timedOut: figs.filter((f) => f.dataset.fail === 'timeout').map((f) => f.dataset.composition),
            blank: figs.filter((f) => f.classList.contains('is-ready') && !f.querySelector('iframe')).length,
            played: window.__siteDebug.commands.filter((c) => c.type === 'play').length,
            hidden: [...document.querySelectorAll('h1, h2, h3, p, .btn, .card, .way')].filter((e) => getComputedStyle(e).opacity < 0.5).length,
          };
        })()`);
        if (s.scrollWidth > s.innerWidth) problems.push(`horizontal scroll: ${s.scrollWidth} > ${s.innerWidth}`);
        if (s.settled < s.figures) problems.push(`${s.figures - s.settled} figures neither live nor on their poster`);
        if (s.errored.length) problems.push(`compositions refused by the runtime: ${s.errored.join(', ')}`);
        if (s.blank) problems.push(`${s.blank} figures hide their poster with no live frame`);
        if (reduced && s.played > 0) problems.push(`${s.played} play commands under reduced motion`);
        if (s.hidden > 0) problems.push(`${s.hidden} text elements still hidden after scrolling`);
        // A slow load that times out degrades to the poster by design (and retries when the figure comes back): a note only.
        problems.push(...await showcaseCards(page));
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
 * Each showcase card, scrolled to the top, the middle and the bottom of the screen: its figure fills the media area (the
 * card's content box above the label) within 1 px, and the stage sits inside the figure, centred, in its composition's
 * ratio, touching two opposite edges. Any transform on the figure alone (a parallax) or an overflow fails it.
 */
async function showcaseCards(page) {
  const problems = [];
  const count = await page.eval(`document.querySelectorAll('.showcase .card').length`);
  for (let i = 0; i < count; i++) {
    for (const block of ['start', 'center', 'end']) {
      await page.eval(`document.querySelectorAll('.showcase .card')[${i}].scrollIntoView({ block: '${block}', behavior: 'instant' })`);
      await wait(page, 250);
      problems.push(...await page.eval(`(() => {
        const card = document.querySelectorAll('.showcase .card')[${i}];
        const fig = card.querySelector('.comp'), stage = fig.querySelector('.comp-stage'), label = card.querySelector('.card__label');
        const id = fig.dataset.composition + ' (${block})';
        const c = card.getBoundingClientRect(), cs = getComputedStyle(card), f = fig.getBoundingClientRect(), st = stage.getBoundingClientRect();
        const px = (v) => parseFloat(v) || 0;
        const media = {
          left: c.left + px(cs.borderLeftWidth) + px(cs.paddingLeft), right: c.right - px(cs.borderRightWidth) - px(cs.paddingRight),
          top: c.top + px(cs.borderTopWidth) + px(cs.paddingTop), bottom: label.getBoundingClientRect().top - px(getComputedStyle(label).marginTop),
        };
        const out = [];
        const off = ['left', 'right', 'top', 'bottom'].filter((k) => Math.abs(f[k] - media[k]) > 1);
        if (off.length) out.push(\`\${id}: figure off the card's media area at \${off.map((k) => k + ' ' + (f[k] - media[k]).toFixed(1)).join(', ')}\`);
        const inside = st.left >= f.left - 1 && st.right <= f.right + 1 && st.top >= f.top - 1 && st.bottom <= f.bottom + 1;
        if (!inside) out.push(\`\${id}: stage outside its figure\`);
        const [w, h] = getComputedStyle(stage).aspectRatio.split('/').map(Number);
        if (Math.abs(st.width / st.height - w / (h || 1)) > 0.01) out.push(\`\${id}: stage ratio \${(st.width / st.height).toFixed(3)}, not \${w}/\${h || 1}\`);
        const dx = (st.left - f.left) - (f.right - st.right), dy = (st.top - f.top) - (f.bottom - st.bottom);
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) out.push(\`\${id}: stage not centred in its figure (\${dx.toFixed(1)}, \${dy.toFixed(1)})\`);
        const fills = (Math.abs(st.left - f.left) <= 1.5 && Math.abs(st.right - f.right) <= 1.5) || (Math.abs(st.top - f.top) <= 1.5 && Math.abs(st.bottom - f.bottom) <= 1.5);
        if (!fills) out.push(\`\${id}: stage touches no two opposite edges of its figure\`);
        return out;
      })()`));
    }
  }
  return [...new Set(problems)];
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
