/**
 * SVG inner editor, review fix I1: a shadow `:host` rule with `!important` beats any style the page gives the overlay's host,
 * so even if one reached the overlay (the core refuses them and the overlay drops them: both bypassed here, the rule is
 * put straight into the shadow root in Chrome), the host must stay boxed in the clip's box: nothing of it is hit outside the
 * box, the selection box above it keeps the clicks, and the rest of the page stays clickable. The stage markup is the real
 * Stage rendered in jsdom, measured with the app's real stylesheets in real Chrome. Chrome only on request
 * (MS_LAYOUT_CHROME=1 or MS_REQUIRE_CHROME=1), through the repo's driver (mock keychain, basic password store).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { DEFAULT_FORMATS, type Composition, type EditorCompositionView } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';
import { ALL_CSS } from './support/layoutAssets.ts';

const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

vi.mock('../src/api.ts', () => ({ api: {}, ApiError: class extends Error {} }));
const { EditorContext } = await import('../src/screens/editor/editorContext.ts');
const { __resetDrafts, draftKey, useDraft } = await import('../src/screens/editor/draftStore.ts');
const { Stage } = await import('../src/screens/editor/Stage.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { createClock } = await import('../src/ui/clock.ts');
type EditorState = import('../src/screens/editor/editorContext.ts').EditorState;

const LOGO = 'identity-logo';
const KEY = draftKey('acme', 'marchio', LOGO);
const preset = DEFAULT_FORMATS.find((p) => p.id === LOGO)!;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="50" height="50" fill="#ff0000"/></svg>';
const comp = (): Composition => ({
  $schema: 'motion-studio/composition@1', width: 1024, height: 1024, fps: 30, duration: 0, background: '#ffffff', fonts: [], scenes: [],
  tracks: [{ id: 't', kind: 'visual', clips: [{ id: 'logo', type: 'svg', src: 'assets/logo.svg', start: 0, duration: 0, props: { fit: 'contain' } }] }],
} as unknown as Composition);
const view = (): EditorCompositionView => ({ n: 1, format: LOGO, primaryFormat: LOGO, hash: 'h'.repeat(64), composition: comp(), files: [{ path: 'assets/logo.svg', size: 100 }], fonts: [] });

/** The stage with the logo selected and drawn at 100,100 (200 × 200 px), as markup (the shadow root is not part of it). */
async function markup(): Promise<string> {
  __resetDrafts();
  const events = new EventTarget();
  const player = {
    clipBounds: null as unknown,
    select: () => {},
    addEventListener: (t: string, l: EventListener) => events.addEventListener(t, l),
    removeEventListener: (t: string, l: EventListener) => events.removeEventListener(t, l),
  };
  function Harness() {
    const [draft, actions] = useDraft(KEY);
    const [svgElement, selectSvgElement] = useState<string | null>(null);
    useEffect(() => { actions.open(view(), preset); actions.svgText('assets/logo.svg', SVG); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    if (!draft) return null;
    const ctx = {
      slug: 'acme', creative: 'marchio', format: LOGO, primary: LOGO, draft, actions, player, selection: 'logo', select: () => {},
      snap: false, setSnap: () => {}, token: 't', stageAsset: async () => null, staging: false, readOnly: null, svgElement, selectSvgElement,
      controls: { clock: createClock(), playing: false, ready: true, duration: 0, pause: () => {}, seek: () => {}, toggle: () => {}, step: () => {} },
    } as unknown as EditorState;
    return <I18nProvider locale="en"><EditorContext.Provider value={ctx}><Stage /></EditorContext.Provider></I18nProvider>;
  }
  const { container } = render(<Harness />);
  await waitFor(() => expect(container.querySelector('[data-slot="stage-layer"]')).toBeTruthy());
  player.clipBounds = { clipId: 'logo', bounds: { x: 100, y: 100, width: 200, height: 200 }, scale: 200 / 1024 };
  act(() => { events.dispatchEvent(new Event('clipbounds')); });
  await waitFor(() => expect(container.querySelector('[data-slot="svg-overlay"]')).toBeTruthy());
  const html = container.innerHTML;
  cleanup();
  return html;
}

const MEASURE = `(() => {
const problems = [];
const host = document.querySelector('[data-slot="svg-overlay"]');
const box = document.querySelector('[data-slot="svg-overlay-box"]');
const stage = document.querySelector('#stage').getBoundingClientRect();
// What a hostile SVG <style> would do, put straight into the shadow root (the core and the overlay would both drop it).
const root = host.attachShadow({ mode: 'open' });
const st = document.createElement('style');
st.textContent = ':host{all:initial!important;display:block!important;position:fixed!important;left:0!important;top:0!important;width:100vw!important;height:100vh!important;z-index:2147483647!important;pointer-events:auto!important;visibility:visible!important;background:red!important;contain:none!important}';
const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
svg.setAttribute('style', 'width:100vw;height:100vh;pointer-events:all;visibility:visible');
root.append(st, svg);
const r = box.getBoundingClientRect();
const want = { left: stage.left + 100, top: stage.top + 100, width: 200, height: 200 };
for (const k of Object.keys(want)) if (Math.abs(r[k] - want[k]) > 0.5) problems.push('the overlay box moved: ' + k + ' ' + r[k] + ' != ' + want[k]);
const cs = getComputedStyle(box);
if (!/strict|size layout paint|layout paint/.test(cs.contain)) problems.push('the box is not contained: ' + cs.contain);
const isHost = (el) => el === host || (el && host.contains(el));
// Outside the box: the page and the stage keep their clicks.
const outside = document.querySelector('#outside').getBoundingClientRect();
const pts = [[outside.left + outside.width / 2, outside.top + outside.height / 2, 'the page button'], [stage.left + 20, stage.top + 20, 'the stage corner'], [stage.left + 520, stage.top + 520, 'the far stage corner'], [5, 5, 'the window corner']];
for (const [x, y, what] of pts) { const el = document.elementFromPoint(x, y); if (isHost(el)) problems.push('the overlay takes clicks on ' + what); }
const btn = document.elementFromPoint(outside.left + outside.width / 2, outside.top + outside.height / 2);
if (!btn || btn.id !== 'outside') problems.push('the page button is covered by ' + (btn ? btn.className || btn.tagName : 'nothing'));
// Inside the box: the selection box above it keeps the clicks (move, resize).
const inside = document.elementFromPoint(want.left + 100, want.top + 100);
if (!inside || !inside.closest('.ms-stage-box')) problems.push('the selection box is covered by ' + (inside ? inside.className || inside.tagName : 'nothing'));
return problems;
})()`;

run('SVG overlay: a shadow :host rule stays boxed in (real Chrome)', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-svg-overlay-')); browser = await launchChrome(chrome!); }, 120_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  it('the overlay box keeps the clip box, nothing outside it is covered, the handles stay on top', async () => {
    const html = await markup();
    expect(html).toContain('data-slot="svg-overlay-box"');
    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${ALL_CSS()}
      body{margin:0;background:var(--bg)} #stage{position:absolute;left:40px;top:40px;width:600px;height:600px;background:var(--field)}
      #outside{position:absolute;left:700px;top:60px;width:120px;height:40px}</style></head><body>
      <div id="stage">${html}</div><button id="outside" type="button">Outside</button></body></html>`;
    const file = join(dir, 'overlay.html');
    writeFileSync(file, page);
    const tab = await browser.newPage(1000, 760);
    try {
      await tab.goto(`file://${file}`);
      expect(await tab.eval<string[]>(MEASURE, 30_000)).toEqual([]);
    } finally { await tab.close(); }
  }, 120_000);
});
