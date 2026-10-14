/**
 * The range Comment bubble on the format view transport (UX feedback batch 1, task 4, fix round 1). The real Transport is
 * rendered in jsdom with a band selected; its markup, given the real stylesheets, is measured in real Chrome at 360, 480
 * and 760 px, en and it, with the band at the left edge, the middle and the right edge: the bubble is fully inside the
 * player area, its text is not clipped and it overlaps neither the timecode nor the clip and range buttons. Chrome only on
 * request (MS_LAYOUT_CHROME=1 or MS_REQUIRE_CHROME=1), through the repo's driver (mock keychain, basic password store).
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
const CSS = ['theme.css', 'ui/ui.css', 'screens/format.css'].map(src).join('\n');
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
const w = bub.offsetWidth;
bub.style.left = bubbleLeft(sec.clientWidth, w, Number(bub.dataset.frac)) + 'px';
const mr = stage.getBoundingClientRect(); const b = bub.getBoundingClientRect();
const problems = [];
if (b.left < mr.left - 0.5 || b.right > mr.right + 0.5 || b.top < mr.top - 0.5 || b.bottom > mr.bottom + 0.5) problems.push('outside the player area ' + JSON.stringify([b.left, b.right, b.top, b.bottom]) + ' in ' + JSON.stringify([mr.left, mr.right, mr.top, mr.bottom]));
for (const el of bub.querySelectorAll('*')) if (el.scrollWidth > el.clientWidth + 1 && el.children.length === 0 && el.textContent) problems.push('clipped text: ' + el.textContent);
if (bub.scrollWidth > bub.clientWidth + 1) problems.push('bubble clips');
const hit = (r, o) => r.left < o.right && r.right > o.left && r.top < o.bottom && r.bottom > o.top;
for (const sel of ['.ms-fv-tc', '.ms-fv-clippick', '.ms-fv-rangebtn', '.ms-fv-play']) {
  const el = document.querySelector(sel);
  if (hit(b, el.getBoundingClientRect())) problems.push('overlaps ' + sel);
}
if (document.documentElement.scrollWidth > innerWidth) problems.push('page overflows');
return { problems, width: b.width };
})()`;

run('range bubble: real Chrome layout', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-range-bubble-')); browser = await launchChrome(chrome!); }, 120_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  for (const locale of ['en', 'it'] as const) {
    it(`${locale}: inside the player area, text not clipped, off the controls at 360, 480 and 760`, async () => {
      for (const [name, band] of Object.entries(BANDS)) {
        const html = markup(locale, band).replace('class="ms-fv-rangebubble"', `data-frac="${(band[0] + band[1]) / 120}" class="ms-fv-rangebubble"`);
        for (const width of [360, 480, 760]) {
          const page = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><style>${CSS}
            body{margin:0;background:var(--bg)} #main{position:relative;display:flex;flex-direction:column;width:${width}px;height:320px;overflow:hidden}
            #stage{flex:1;background:var(--field)}</style></head><body><div id="main"><div id="stage"></div>${html}</div></body></html>`;
          const file = join(dir, `${locale}-${name}-${width}.html`);
          writeFileSync(file, page);
          const tab = await browser.newPage(width, 700);
          try {
            await tab.goto(`file://${file}`);
            const r = await tab.eval<{ problems: string[] }>(MEASURE, 30_000);
            expect(r.problems, `${locale} ${name} @${width}`).toEqual([]);
          } finally { await tab.close(); }
        }
      }
    }, 120_000);
  }
});
