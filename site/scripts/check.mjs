// Real-browser checks of the built site, served under /motion-studio/ like GitHub Pages:
// at 360, 768 and 1440 px, with motion on and with prefers-reduced-motion, it checks for no horizontal scroll, no console
// errors or failed requests, every composition either live or on its poster, and no player told to play under reduced
// motion. Usage: node site/scripts/check.mjs [--out <folder for screenshots>]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../build.mjs';
import { serve } from './serve.mjs';
import { launchChrome } from './chrome.mjs';

const WIDTHS = [360, 768, 1440];
const wait = (page, ms) => page.eval(`new Promise(r => setTimeout(r, ${ms}))`);

export async function check({ out } = {}) {
  await build();
  if (out) mkdirSync(out, { recursive: true });
  const server = await serve();
  const chrome = await launchChrome();
  const failures = [];
  try {
    for (const reduced of [false, true]) {
      for (const width of WIDTHS) {
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
          const figs = [...document.querySelectorAll('.comp')];
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
  } finally {
    await chrome.close();
    await server.close();
  }
  if (failures.length) throw new Error(failures.join('\n'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--out');
  check({ out: i > 0 ? process.argv[i + 1] : undefined }).then(() => console.log('site checks passed'), (e) => { console.error(e.message); process.exit(1); });
}
