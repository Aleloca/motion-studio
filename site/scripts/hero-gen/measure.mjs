// Measures text widths with the site's own fonts in headless Chrome (a DOM span, like the runtime's text clips) and adds
// them to widths.json. Needs the built site (node site/build.mjs). Called by build.mjs when a string is not measured yet.
import { writeFileSync } from 'node:fs';
import { serve } from '../serve.mjs';
import { launchChrome } from '../chrome.mjs';
import { FAM, FILE, WIDTHS, WIDTHS_FILE } from './lib.mjs';

/** @param {string[]} keys `family|weight|text` */
export async function measure(keys) {
  const todo = keys.filter((k) => !(k in WIDTHS));
  if (!todo.length) return 0;
  const server = await serve();
  const chrome = await launchChrome();
  try {
    const page = await chrome.newPage();
    await page.send('Page.enable');
    await page.goto(server.url);
    const res = await page.eval(`(async () => {
      await document.fonts.ready;
      // The gallery's display faces are not on the page: load them from the site's fonts.
      const declared = new Set([...document.fonts].map((f) => f.family.replace(/"/g, '')));
      for (const [fam, file] of ${JSON.stringify(Object.keys(FAM).map((k) => [FAM[k], FILE[k]]))}) {
        if (!declared.has(fam)) document.fonts.add(new FontFace(fam, 'url(assets/fonts/' + file + '.woff2)', { weight: '100 1000' }));
      }
      const out = {};
      const span = document.createElement('span');
      span.style.cssText = 'position:absolute;left:0;top:0;white-space:pre;font-size:1000px;line-height:1.2;letter-spacing:0;font-kerning:normal';
      document.body.appendChild(span);
      for (const key of ${JSON.stringify(todo)}) {
        // "family|weight|text", or "family|weight@size|text" for a face measured at its own size (optical sizes).
        const [fam, ws, ...rest] = key.split('|');
        const text = rest.join('|');
        const [weight, at] = ws.split('@');
        const px = at ? Number(at) : 1000;
        await document.fonts.load(weight + ' ' + px + 'px "' + fam + '"', text);
        span.style.fontFamily = '"' + fam + '"'; span.style.fontWeight = weight; span.style.fontSize = px + 'px'; span.textContent = text;
        out[key] = Math.round((span.getBoundingClientRect().width * 1000) / px);
      }
      return out;
    })()`);
    Object.assign(WIDTHS, res);
    const sorted = Object.fromEntries(Object.entries(WIDTHS).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    writeFileSync(WIDTHS_FILE, `${JSON.stringify(sorted, null, 1)}\n`);
    return todo.length;
  } finally {
    await chrome.close();
    await server.close();
  }
}
