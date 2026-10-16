// Renders each composition's poster (its frame at meta.posterTime) with the product's runtime in render mode, into
// site/compositions/<id>/poster.webp; the `og` composition is also written as site/src/assets/og-image.png.
// Needs: node site/build.mjs first. Usage: node site/scripts/posters.mjs [id…]
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  renderPosters(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
