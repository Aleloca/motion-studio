// Renders each composition's poster (its frame at meta.posterTime) with the product's runtime in render mode, into
// site/compositions/<id>/poster.webp, and the same frame at half size as poster-half.webp (what a phone loads: a full-size
// poster decodes to 8 MB); the `og` composition is also written as site/src/assets/og-image.png.
// Needs: node site/build.mjs first. Usage: node site/scripts/posters.mjs [id…], or --half [id…] to redo only the half-size
// posters from the posters there.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';
import { launchChrome } from './chrome.mjs';
import { loadCompositions } from '../lib/compositions.mjs';

const SITE = fileURLToPath(new URL('..', import.meta.url));

export async function renderPosters(only = []) {
  const items = (await loadCompositions(join(SITE, 'compositions'))).filter((i) => only.length === 0 || only.includes(i.id));
  const server = await serve();
  const chrome = await launchChrome();
  const failures = [];
  try {
    for (const item of items) {
      const { width, height } = item.composition;
      const page = await chrome.newPage();
      await page.send('Page.enable');
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await page.goto(`${server.url}runtime/${item.id}.html`);
      const errors = await page.eval(`(async () => { const info = await window.__ms.ready(); await window.__ms.seek(${item.meta.posterTime}); return window.__ms.errors; })()`);
      if (errors.length) failures.push(`${item.id}: ${errors.map((e) => `${e.code} ${e.message}`).join('; ')}`);
      const shot = async (format, quality) => Buffer.from((await page.send('Page.captureScreenshot', { format, ...(quality ? { quality } : {}), clip: { x: 0, y: 0, width, height, scale: 1 } })).data, 'base64');
      await writeFile(join(item.dir, 'poster.webp'), await shot('webp', 82));
      await writeFile(join(item.dir, 'poster-half.webp'), Buffer.from((await page.send('Page.captureScreenshot', { format: 'webp', quality: 82, clip: { x: 0, y: 0, width, height, scale: 0.5 } })).data, 'base64'));
      if (item.id === 'og') await writeFile(join(SITE, 'src', 'assets', 'og-image.png'), await shot('png'));
      await page.close();
      console.log(`poster ${item.id}`);
    }
  } finally {
    await chrome.close();
    await server.close();
  }
  if (failures.length) throw new Error(`runtime errors:\n${failures.join('\n')}`);
}

/** The half-size posters, drawn from the posters already there (no new render). */
export async function halfPosters(only = []) {
  const items = (await loadCompositions(join(SITE, 'compositions'))).filter((i) => only.length === 0 || only.includes(i.id));
  const server = await serve({ dir: SITE, prefix: '/site/' });
  const chrome = await launchChrome();
  try {
    for (const item of items) {
      const width = item.composition.width / 2; const height = item.composition.height / 2;
      const page = await chrome.newPage();
      await page.send('Page.enable');
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await page.goto(`${server.url}compositions/${item.id}/poster.webp`);
      await page.eval(`(async () => { document.body.style.margin = '0'; document.body.innerHTML = '<img src="${server.url}compositions/${item.id}/poster.webp" style="display:block;width:${width}px;height:${height}px">'; await document.images[0].decode(); })()`);
      const { data } = await page.send('Page.captureScreenshot', { format: 'webp', quality: 82, clip: { x: 0, y: 0, width, height, scale: 1 } });
      await writeFile(join(item.dir, 'poster-half.webp'), Buffer.from(data, 'base64'));
      await page.close();
      console.log(`poster-half ${item.id}`);
    }
  } finally {
    await chrome.close();
    await server.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const run = args[0] === '--half' ? halfPosters(args.slice(1)) : renderPosters(args);
  run.catch((e) => { console.error(e.message); process.exit(1); });
}
