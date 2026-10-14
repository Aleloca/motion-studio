/**
 * The range Comment bubble on the format view transport (UX feedback batch 1, task 4, fix round 1). The real Transport is
 * rendered in jsdom with a band selected; its markup, given the real stylesheets, is measured in real Chrome at 360, 480
 * and 760 px, en and it, with the band at the left edge, the middle and the right edge: the bubble is fully inside the
 * player area, above the transport (it clears the section's top edge), its text is not clipped, and its Comment button is
 * the element under its own centre even with the page's comment hint (z 5, at bottom: 108px when notes are shown) on the
 * page (final wave I1). Chrome only on request (MS_LAYOUT_CHROME=1 or MS_REQUIRE_CHROME=1), through the repo's driver
 * (mock keychain, basic password store).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fireEvent, render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { Transport, bubbleLeft } from '../src/screens/Transport.tsx';
import { createClock } from '../src/ui/clock.ts';
import { Button, Icon, Select } from '../src/ui/index.ts';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';

// jsdom has no PointerEvent: a MouseEvent carries the coordinates, button and modifiers the transport reads.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  }
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventPolyfill, configurable: true });
}

const src = (p: string) => readFileSync(join(import.meta.dirname, '../src', p), 'utf8');
const CSS = ['theme.css', 'ui/ui.css', 'screens/canvas.css', 'screens/format.css'].map(src).join('\n');
const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

/** Band positions on a 60 s clip, 3 s wide: near the left edge, the middle, the right edge. */
const BANDS = { left: [0.2, 3.2], middle: [28.5, 31.5], right: [56.8, 59.8] } as const;

function markup(locale: 'en' | 'it', band: readonly [number, number]): string {
  const clock = createClock();
  const noop = () => {};
  const { container, unmount } = render(
    <I18nProvider locale={locale}>
      <Transport clock={clock} duration={60} playing={false} disabled={false} onRange={noop} hint={locale === 'en' ? 'Space plays · ← → one frame · click the paused frame to comment' : 'Spazio riproduce · ← → un fotogramma'}
        extra={<><span className="ms-fv-clippick"><Select<string> variant="pill" icon="comment" label="Comment on a clip" value="" display="" options={[{ value: '', label: 'x' }]} onChange={noop} /></span>
          <Button size="sm" variant="outline" icon className="ms-fv-rangebtn" aria-label="Comment on range"><Icon name="comment" size={13} /></Button></>}
        onToggle={noop} onStep={noop} onSeek={noop} onPause={noop} onResume={noop} loop={false} onLoop={noop} speed="1" onSpeed={noop} />
    </I18nProvider>);
  const scrub = container.querySelector('.ms-fv-scrub') as HTMLElement;
  scrub.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 40, width: 600, height: 40, x: 0, y: 0, toJSON() {} });
  const px = (s: number) => (s / 60) * 600;
  fireEvent.pointerDown(scrub, { clientX: px(band[0]), pointerId: 1, button: 0, shiftKey: true });
  fireEvent.pointerMove(scrub, { clientX: px(band[1]), pointerId: 1, shiftKey: true });
  fireEvent.pointerUp(scrub, { clientX: px(band[1]), pointerId: 1, shiftKey: true });
  const html = container.innerHTML;
  unmount();
  return html;
}

const MEASURE = `(() => {
${bubbleLeft.toString()}
const stage = document.querySelector('#main');
const bub = document.querySelector('.ms-fv-rangebubble');
const sec = document.querySelector('.ms-fv-transport');
const problems = [];
const frac = Number(bub.dataset.frac);
if (bub.dataset.frac === undefined || !Number.isFinite(frac)) problems.push('data-frac not applied');
const w = bub.offsetWidth;
bub.style.left = bubbleLeft(sec.clientWidth, w, frac) + 'px';
const mr = stage.getBoundingClientRect(); const b = bub.getBoundingClientRect();
if (b.left < mr.left - 0.5 || b.right > mr.right + 0.5 || b.top < mr.top - 0.5 || b.bottom > mr.bottom + 0.5) problems.push('outside the player area ' + JSON.stringify([b.left, b.right, b.top, b.bottom]) + ' in ' + JSON.stringify([mr.left, mr.right, mr.top, mr.bottom]));
for (const el of bub.querySelectorAll('*')) if (el.scrollWidth > el.clientWidth + 1 && el.children.length === 0 && el.textContent) problems.push('clipped text: ' + el.textContent);
if (bub.scrollWidth > bub.clientWidth + 1) problems.push('bubble clips');
// Above the transport: the bubble clears the section's top edge (so it covers none of its controls).
const sr = sec.getBoundingClientRect();
if (b.bottom > sr.top + 0.5) problems.push('not above the transport: bubble bottom ' + b.bottom + ' > section top ' + sr.top);
// The Comment button is what a click on its centre reaches, even with the comment hint on the page.
const btn = bub.querySelector('button');
const cr = btn.getBoundingClientRect();
const cx = (cr.left + cr.right) / 2, cy = (cr.top + cr.bottom) / 2;
const top = document.elementFromPoint(cx, cy);
if (!top || !btn.contains(top)) problems.push('Comment button covered by ' + (top ? top.className : 'nothing'));
const hr = document.querySelector('.ms-fv-hint').getBoundingClientRect();
const underHint = cx >= hr.left && cx <= hr.right && cy >= hr.top && cy <= hr.bottom;
if (document.documentElement.scrollWidth > innerWidth) problems.push('page overflows');
return { problems, width: b.width, underHint };
})()`;

run('range bubble: real Chrome layout', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-range-bubble-')); browser = await launchChrome(chrome!); }, 120_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  for (const locale of ['en', 'it'] as const) {
    it(`${locale}: inside the player area, above the transport, text not clipped, Comment reachable over the hint at 360, 480 and 760`, async () => {
      let underHint = 0;
      for (const [name, band] of Object.entries(BANDS)) {
        const raw = markup(locale, band);
        expect(raw, 'the band is shown: the transport is raised').toContain('ms-fv-transport ms-banded');
        const html = raw.replace('class="ms-fv-rangebubble"', `data-frac="${(band[0] + band[1]) / 120}" class="ms-fv-rangebubble"`);
        expect(html).toContain('data-frac=');
        for (const width of [360, 480, 760]) {
          const page = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><style>${CSS}
            body{margin:0;background:var(--bg)} #main{position:relative;display:flex;flex-direction:column;width:${width}px;height:320px;overflow:hidden}
            #stage{flex:1;background:var(--field)}</style></head><body><div id="main"><div class="ms-fv-notes"><div>note</div></div><div id="stage"></div>
            <div class="ms-cv-hint ms-fv-hint" role="status">${locale === 'en' ? 'Click the spot of the frame at 00:30.00' : 'Clicca il punto del fotogramma a 00:30.00'}</div>${html}</div></body></html>`;
          const file = join(dir, `${locale}-${name}-${width}.html`);
          writeFileSync(file, page);
          const tab = await browser.newPage(width, 700);
          try {
            await tab.goto(`file://${file}`);
            const r = await tab.eval<{ problems: string[]; underHint: boolean }>(MEASURE, 30_000);
            expect(r.problems, `${locale} ${name} @${width}`).toEqual([]);
            if (r.underHint) underHint++;
          } finally { await tab.close(); }
        }
      }
      // The hint really sits where the button is in some of the cases (else the reachability check would prove nothing).
      expect(underHint).toBeGreaterThan(0);
    }, 120_000);
  }
});
