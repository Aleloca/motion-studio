/**
 * Hostile html layers for the isolation tests (plan "Review focus" 1), shared by the composition server's Chrome test
 * (Task 3) and the renderer's (Task 4). Every attempt targets a **canary** origin standing in for the core API: a test
 * asserts which canary paths were (not) requested.
 *
 * - `hostileLayer`: everything the headers must block (fetch, WebSocket, EventSource, beacon, Worker, import(), script,
 *   stylesheet, image, file://, form, popup, top navigation, top/parent document access, cross-origin pushState). It paints
 *   itself green, or red when a synchronous attempt did not throw. Nothing may reach the canary, in any mode.
 * - `selfNavigationLayer`: a layer that navigates its own frame (`location.href`, `<meta http-equiv=refresh>`, an anchor
 *   `.click()`, a nested `<iframe src>`). The layer's own CSP and sandbox stop only the nested iframe. Measured in Chrome:
 *   - **through the runtime page**, the runtime page's `default-src 'self'` (its `frame-src`) blocks every self-navigation
 *     of its child frames, in render and in preview, so nothing reaches the canary. Task 3 asserts this;
 *   - **a layer URL framed directly** by a page without our CSP (which needs the token) reaches the canary with href, meta
 *     and anchor. This is the known residual, asserted as such in Task 3.
 *   Task 4 (CDP request interception, render) and Task 7 (webRequest filter, desktop preview) add a block that does not
 *   depend on the CSP. Reuse these layers there and assert that nothing reaches the canary. The web preview in the user's
 *   browser relies on the runtime page's CSP (documented; layers load only when the user starts the preview).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Canary path of every `hostileLayer` attempt starts with one of these; the self-navigation ones with `/selfnav-`. */
export const SELF_NAVIGATION_CASES = ['href', 'meta', 'anchor', 'iframe'] as const;
export type SelfNavigationCase = (typeof SELF_NAVIGATION_CASES)[number];
export const selfNavigationPath = (c: SelfNavigationCase) => `/selfnav-${c}`;

/** Where the hostile clip sits in a 320×180 composition: on top, in the bottom-right corner. */
export const HOSTILE_BOX = { x: 280, y: 140, width: 40, height: 40 } as const;

export const hostileLayer = (canary: string) => `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;background:#00ff00;overflow:hidden}img,form{position:absolute;left:-1000px;top:0}</style>
<link rel="stylesheet" href="${canary}/css">
</head><body>
<img src="${canary}/img"><img src="file:///etc/hosts">
<form id="f" action="${canary}/form" method="post"><input name="a" value="b"></form>
<script>
  const C = ${JSON.stringify(canary)};
  let escaped = false;
  const attempt = (f) => { try { f(); escaped = true; } catch (e) { /* refused */ } };
  attempt(() => { if (!window.top.document.body) throw 0; });
  attempt(() => { if (!window.parent.document.body) throw 0; });
  attempt(() => { if (typeof window.top.location.href !== 'string') throw 0; });
  attempt(() => history.pushState({}, '', C + '/push'));
  attempt(() => { if (!window.open(C + '/popup')) throw 0; });
  fetch(C + '/fetch').catch(() => {});
  fetch(C + '/fetch-no-cors', { mode: 'no-cors' }).catch(() => {});
  try { new WebSocket(C.replace('http:', 'ws:') + '/ws'); } catch (e) {}
  try { new EventSource(C + '/es'); } catch (e) {}
  try { navigator.sendBeacon(C + '/beacon', 'x'); } catch (e) {}
  try { new Worker(C + '/worker.js'); } catch (e) {}
  import(C + '/mod.js').catch(() => {});
  const s = document.createElement('script'); s.src = C + '/script.js'; document.head.appendChild(s);
  try { document.getElementById('f').submit(); } catch (e) {}
  try { window.top.location = C + '/nav'; } catch (e) {}
  if (escaped) document.body.style.background = '#ff0000';
  window.msReady = Promise.resolve();
</script></body></html>`;

/** A layer that navigates its own frame (or a nested frame) to `<canary>/selfnav-<case>`. */
export function selfNavigationLayer(canary: string, c: SelfNavigationCase): string {
  const url = canary + selfNavigationPath(c);
  const body: Record<SelfNavigationCase, string> = {
    href: `<script>window.msReady = Promise.resolve(); location.href = ${JSON.stringify(url)};</script>`,
    meta: `<meta http-equiv="refresh" content="0;url=${url}"><script>window.msReady = Promise.resolve();</script>`,
    anchor: `<a id="a" href="${url}">x</a><script>window.msReady = Promise.resolve(); document.getElementById('a').click();</script>`,
    iframe: `<iframe src="${url}"></iframe><script>window.msReady = Promise.resolve();</script>`,
  };
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body[c]}</body></html>`;
}

/** Writes `layers/hostile.html` and `layers/selfnav-<case>.html` into a composition folder. */
export function writeHostileLayers(compDir: string, canary: string): void {
  writeFileSync(join(compDir, 'layers', 'hostile.html'), hostileLayer(canary));
  for (const c of SELF_NAVIGATION_CASES) writeFileSync(join(compDir, 'layers', `selfnav-${c}.html`), selfNavigationLayer(canary, c));
}

/** A composition track with the hostile clip (over the whole 4 s). */
export const hostileTrack = (duration = 4) => ({ id: 'hostile', kind: 'visual', clips: [
  { id: 'hostile', type: 'html', src: 'layers/hostile.html', start: 0, duration, props: { ...HOSTILE_BOX } },
] });

/** A composition track with one self-navigating clip per case, side by side along the top. */
export const selfNavigationTrack = (duration = 4) => ({ id: 'selfnav', kind: 'visual', clips: SELF_NAVIGATION_CASES.map((c, i) => (
  { id: `selfnav-${c}`, type: 'html', src: `layers/selfnav-${c}.html`, start: 0, duration, props: { x: i * 40, y: 0, width: 40, height: 40 } }
)) });
