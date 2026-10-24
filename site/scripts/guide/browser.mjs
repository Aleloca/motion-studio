// A small driver for the guide's screenshots over CDP (site/scripts/chrome.mjs): go to a route of the app, find and click
// controls by their visible text, type into fields the way React sees it, and capture the page or one element as webp.
import { writeFileSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openApp(chrome, appUrl, { width = 1440, height = 900 } = {}) {
  const page = await chrome.newPage();
  const errors = [];
  page.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text));
  await page.send('Runtime.enable'); await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.goto(appUrl);
  await sleep(1500);

  const js = (fn, ...a) => page.eval(`(${fn})(${a.map((x) => JSON.stringify(x)).join(',')})`);
  const app = {
    page, errors, js,
    sleep,
    async waitFor(fn, { timeout = 20_000, args = [], what = String(fn).slice(0, 120) } = {}) {
      const end = Date.now() + timeout;
      for (;;) {
        const v = await js(fn, ...args).catch(() => null);
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(200);
      }
    },
    async waitText(text, { timeout = 20_000 } = {}) {
      return app.waitFor((t) => document.body.innerText.includes(t), { timeout, args: [text], what: `text "${text}"` });
    },
    async reload() {
      const loaded = new Promise((r) => { const off = page.on('Page.loadEventFired', () => { off(); r(); }); });
      await page.send('Page.reload', {});
      await loaded;
      await sleep(1500);
    },
    async go(hash, { settle = 1200 } = {}) {
      await js((h) => { location.hash = h; }, hash);
      await sleep(settle);
    },
    /** Clicks the first visible control whose text (or aria-label/title) matches; `exact` compares the whole text. */
    async click(text, { selector = 'button, a, [role=tab], [role=menuitem], [role=option], [role=radio], [role=switch], label, summary, [role=button]', exact = false, nth = 0, within = null, timeout = 10_000 } = {}) {
      const ok = await app.waitFor((t, sel, ex, n, w) => {
        const root = w ? document.querySelector(w) : document;
        if (!root) return false;
        const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
        const els = [...root.querySelectorAll(sel)].filter((e) => {
          const r = e.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const label = [norm(e.innerText), norm(e.getAttribute('aria-label')), norm(e.getAttribute('title'))];
          return label.some((l) => (ex ? l === t : l.startsWith(t)));
        });
        const el = els[n];
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      }, { timeout, args: [text, selector, exact, nth, within], what: `control "${text}"` });
      await sleep(500);
      return ok;
    },
    /** A real mouse click (pointer events) at the centre of the nth visible element matching `selector` whose text starts with `text`. */
    async mouse(selector, text = '', { nth = 0, dx = 0.5, dy = 0.5 } = {}) {
      const p = await app.waitFor((sel, t, n, fx, fy) => {
        const el = [...document.querySelectorAll(sel)].filter((e) => e.getBoundingClientRect().width > 0 && (e.innerText ?? '').replace(/\s+/g, ' ').trim().startsWith(t))[n];
        if (!el) return null;
        el.scrollIntoView({ block: 'nearest' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width * fx, y: r.top + r.height * fy };
      }, { args: [selector, text, nth, dx, dy], what: `${selector} "${text}"` });
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await page.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1, buttons: type === 'mousePressed' ? 1 : 0 });
      }
      await sleep(600);
    },
    /** Sets an input or textarea (found by selector) as if typed. */
    async fill(selector, value) {
      await app.waitFor((sel) => Boolean(document.querySelector(sel)), { args: [selector], what: selector });
      await js((sel, v) => {
        const el = document.querySelector(sel);
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, selector, value);
      await sleep(300);
    },
    /** Focuses `selector` and presses a key through CDP (modifiers: 4 is ⌘, 8 is Shift). */
    async press(selector, key, modifiers = 0) {
      await js((sel) => document.querySelector(sel)?.focus(), selector);
      const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
      const base = { key, code, modifiers, windowsVirtualKeyCode: key === 'Enter' ? 13 : key.toUpperCase().charCodeAt(0) };
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(key === 'Enter' ? { text: '\r' } : {}) });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(600);
    },
    async theme(t) {
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: t }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
      await sleep(400);
    },
    /** The page (or the box of `selector`, padded) as a webp file. */
    async shot(file, { selector = null, pad = 0, clip = null, quality = 82 } = {}) {
      let box = clip;
      if (selector) {
        box = await app.waitFor((sel, p) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          if (!r.width) return null;
          const x = Math.max(0, r.left - p), y = Math.max(0, r.top - p);
          return { x, y, width: Math.min(innerWidth - x, r.width + 2 * p), height: Math.min(innerHeight - y, r.height + 2 * p) };
        }, { args: [selector, pad], what: selector });
      }
      await js(() => document.activeElement?.blur?.());
      // The pointer goes to an empty corner, so no hover state is left on what the step clicked last.
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1439, y: 899 });
      await sleep(250);
      const params = { format: 'webp', quality, ...(box ? { clip: { ...box, scale: 1 } } : {}) };
      const { data } = await page.send('Page.captureScreenshot', params);
      writeFileSync(file, Buffer.from(data, 'base64'));
    },
  };
  return app;
}
