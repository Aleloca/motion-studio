// Measures text widths with the site's own fonts in headless Chrome (a DOM span, like the runtime's text clips) and adds
// them to widths.json. Needs the built site (node site/build.mjs). Called by build.mjs when a string is not measured yet.
import { writeFileSync } from 'node:fs';
import { serve } from '../serve.mjs';
import { launchChrome } from '../chrome.mjs';
import { WIDTHS, WIDTHS_FILE } from './lib.mjs';

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
      const out = {};
      const span = document.createElement('span');
      span.style.cssText = 'position:absolute;left:0;top:0;white-space:pre;font-size:1000px;line-height:1.2;letter-spacing:0;font-kerning:normal';
      document.body.appendChild(span);
      for (const key of ${JSON.stringify(todo)}) {
        const [fam, weight, text] = key.split('|');
        await document.fonts.load(weight + ' 1000px "' + fam + '"', text);
        span.style.fontFamily = '"' + fam + '"'; span.style.fontWeight = weight; span.textContent = text;
        out[key] = Math.round(span.getBoundingClientRect().width);
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
