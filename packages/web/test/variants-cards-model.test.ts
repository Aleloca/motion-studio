// Decision 973: the pure helpers of the variant cards (short name, sizes, fit, the "choose" banner) and of the canvas zoom
// (trackpad pinch around the pointer, ⌘+ / ⌘− / ⌘0).
import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { groupOf, HOST } from './support/variants.ts';
vi.mock('../src/api.ts', () => ({ api: { fileUrl: () => '' } }));
const { boardsWith } = await import('../src/screens/canvasModel.ts');
const { CARD_W, cardCells, cardColumns, cardWidth, CELL_READABLE, fitCards, readyToChoose, shortName, thumbZoom } = await import('../src/screens/variants/variantModel.ts');
const { pinchZoom, scrollAfterZoom, stepZoom, zoomKey } = await import('../src/screens/canvasZoom.ts');

describe('the short name of a variant', () => {
  it('is the first clause of its direction', () => {
    expect(shortName('Minimal Apple-style keynote: white space, one idea per scene')).toBe('Minimal Apple-style keynote');
    expect(shortName('Foto calda e materica, chicchi e tostatura in primo piano')).toBe('Foto calda e materica');
    expect(shortName('Tipografica — solo testo grande')).toBe('Tipografica');
    expect(shortName('Notturna; neon e contrasto')).toBe('Notturna');
    expect(shortName('Audace. Colori pieni')).toBe('Audace');
    expect(shortName('Audace')).toBe('Audace');
  });
  it('a long first clause is cut at a word, with an ellipsis', () => {
    const s = shortName('Una direzione molto lunga senza nessuna punteggiatura che continua ancora e ancora')!;
    expect(s.length).toBeLessThanOrEqual(33);
    expect(s.endsWith('…')).toBe(true);
    expect(s).toBe('Una direzione molto lunga senza…');
  });
  it('a decimal or a hyphenated word is not a clause break; nothing without a direction', () => {
    expect(shortName('Ritmo 1.5x, tagli veloci')).toBe('Ritmo 1.5x');
    expect(shortName('Apple-style')).toBe('Apple-style');
    expect(shortName(null)).toBeNull();
    expect(shortName('   ')).toBeNull();
  });
});

describe('card sizes', () => {
  const [tall, square] = boardsWith(['tiktok-9x16', 'instagram-post-1x1'], DEFAULT_FORMATS, [], () => ({ format: '', n: null }));
  it('a card is CARD_W × zoom wide, never narrower than its header needs nor wider than the viewport', () => {
    expect(cardWidth(1, 2000, 3)).toBe(CARD_W);
    expect(cardWidth(0.5, 2000, 3)).toBe(210);
    expect(cardWidth(1, 300, 3)).toBe(300 - 2 * 16);
    // Not all on one line: the cards of a line share its width (484 px canvas, a 1024 px window: two 214 px cards a line).
    expect(cardWidth(0.5, 484, 3)).toBe((452 - 24) / 2);
    // 380 px: one card a line, as wide as the canvas.
    expect(cardWidth(0.5, 380, 3)).toBe(348);
    // Two cards that fit keep their width.
    expect(cardWidth(0.5, 700, 2)).toBe(210);
  });
  it('decision 1056: with the chat panel open, 2 cards side by side at 1024–1280 px windows, 3 from 1440', () => {
    // The canvas between the formats column and the chat panel (canvas.css): 1024 → 484, 1280 → 660, 1440 → 820, 1512 → 892, 1728 → 1108.
    const perLine = (view: number) => {
      const z = fitCards(3, view)!;
      const w = cardWidth(z, view, 3);
      return Math.floor((view - 2 * 16 + 24) / (w + 24));
    };
    expect([484, 660, 820, 892, 1108].map(perLine)).toEqual([2, 2, 3, 3, 3]);
  });
  it('the formats of a card share its width in columns, as many as fit', () => {
    expect(cardColumns(236, 2)).toEqual({ cols: 2, width: 112 });
    expect(cardColumns(236, 1)).toEqual({ cols: 1, width: 236 });
    expect(cardColumns(236, 4)).toEqual({ cols: 2, width: 112 });
    expect(cardColumns(80, 3)).toEqual({ cols: 1, width: 80 });
  });
  it('a single format is the hero, a tall one capped in height; among several each fills its column (16:9 of it high at most)', () => {
    // 9:16 is 304×540 at 100%; a hero 320 px wide would be 569 px high: capped at 1.25 × 320 = 400 px high.
    expect(thumbZoom(tall!, 320, true) * 540).toBeCloseTo(400);
    expect(thumbZoom(square!, 320, true) * 344).toBeCloseTo(320);
    expect(thumbZoom(square!, 112, false) * 344).toBeCloseTo(112);
    expect(thumbZoom(tall!, 112, false) * 304).toBeCloseTo(112);
    // A wide column never makes a poster of a tall format: 320 px high at most (440 for a hero).
    expect(thumbZoom(tall!, 400, false) * 540).toBeCloseTo(320);
    expect(thumbZoom(tall!, 452, true) * 540).toBeCloseTo(440);
  });
  it('fits every card side by side when the viewport has room, rounded down to 5%, within 50%–100%', () => {
    expect(fitCards(3, 2000)).toBe(1);
    // 3 cards of 360 + 2 gaps of 24 + 2 × 16 padding = 1160 at 100%: at 1000 px, (1000 - 80) / 1080 = 0.85.
    expect(fitCards(3, 1000)).toBe(0.85);
    expect(fitCards(3, 484)).toBe(0.5);
    expect(fitCards(0, 484)).toBeNull();
    expect(fitCards(3, 0)).toBeNull();
  });
});

describe('the "choose" banner', () => {
  it('shows when every active variant is ready and nothing is chosen yet', () => {
    const g = groupOf(['a', 'b', 'c']);
    expect(readyToChoose(g, [], () => 'ready')).toBe(3);
    expect(readyToChoose(g, [], (l) => (l === 'b' ? 'working' : 'ready'))).toBeNull();
    expect(readyToChoose({ ...g, picks: { 'tiktok-9x16': { slug: HOST, version: 1 } } }, [], () => 'ready')).toBeNull();
    // A discarded variant does not count, a missing one blocks it (it cannot be compared).
    expect(readyToChoose(groupOf(['a', 'b', 'c'], {}, { c: { status: 'discarded' } }), [], () => 'ready')).toBe(2);
    expect(readyToChoose(g, ['c'], () => 'ready')).toBeNull();
    // One variant alone has nothing to compare.
    expect(readyToChoose(groupOf(['a', 'b'], {}, { b: { status: 'discarded' } }), [], () => 'ready')).toBeNull();
  });
});

describe('canvas zoom', () => {
  it('a pinch (ctrl+wheel) zooms in on a negative delta and out on a positive one, within the limits', () => {
    expect(pinchZoom(1, -10)).toBeGreaterThan(1);
    expect(pinchZoom(1, 10)).toBeLessThan(1);
    expect(pinchZoom(1.95, -500)).toBe(2);
    expect(pinchZoom(0.55, 500)).toBe(0.5);
    // A mouse wheel notch (±100) is one moderate step, not a jump to the limit.
    expect(pinchZoom(1, -100)).toBeLessThan(1.7);
  });
  it('keeps the point under the pointer still', () => {
    // The world point under the pointer: (scroll + pointer) / zoom; the same after the zoom.
    const s = scrollAfterZoom({ left: 100, top: 50 }, { x: 200, y: 100 }, 1, 2);
    expect((s.left + 200) / 2).toBeCloseTo((100 + 200) / 1);
    expect((s.top + 100) / 2).toBeCloseTo((50 + 100) / 1);
    expect(scrollAfterZoom({ left: 0, top: 0 }, { x: 10, y: 10 }, 1, 0.5)).toEqual({ left: 0, top: 0 });
  });
  it('⌘+ / ⌘− step by 10%, rounded to 5%, within the limits', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(0.55, -1)).toBe(0.5);
    expect(stepZoom(0.5, -1)).toBe(0.5);
    expect(stepZoom(2, 1)).toBe(2);
  });
  it('reads ⌘ on a Mac and Ctrl elsewhere; = and + zoom in, - out, 0 fits', () => {
    const k = (key: string, o: Partial<KeyboardEvent> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, ...o }) as KeyboardEvent;
    expect(zoomKey(k('=', { metaKey: true }), true)).toBe('in');
    expect(zoomKey(k('+', { metaKey: true, shiftKey: true }), true)).toBe('in');
    expect(zoomKey(k('-', { metaKey: true }), true)).toBe('out');
    expect(zoomKey(k('0', { metaKey: true }), true)).toBe('fit');
    expect(zoomKey(k('0', { ctrlKey: true }), true)).toBeNull();
    expect(zoomKey(k('0', { ctrlKey: true }), false)).toBe('fit');
    expect(zoomKey(k('0'), false)).toBeNull();
    expect(zoomKey(k('0', { metaKey: true, altKey: true }), true)).toBeNull();
  });
  it('report 61: zooming in enlarges a card\'s thumbnails, its columns never grow (3 variants × 17 formats, a 2000 px window)', () => {
    const view = 1380;
    const open = cardCells(1, view, 3, 17);
    // At the opening zoom: two readable columns (at least CELL_READABLE wide) in a 360 px card.
    expect(open).toEqual({ width: CARD_W, cols: 2, cell: 162, scale: 1 });
    let last = open;
    for (const z of [1.2, 1.5, 2]) {
      const c = cardCells(z, view, 3, 17);
      expect(c.cell).toBeCloseTo(162 * z);
      expect(c.cols).toBeLessThanOrEqual(last.cols);
      expect(c.scale).toBeCloseTo(z);
      last = c;
    }
    // Zoomed out, the thumbnails shrink with the zoom too (the card keeps its header's width).
    expect(cardCells(0.5, view, 3, 17).cell).toBeCloseTo(81);
    expect(cardCells(0.5, view, 3, 17).cols).toBe(2);
  });
  it('report 61: a thumbnail never wider than the canvas: past it the columns give way, one at the end', () => {
    // 600 px canvas: 3 cards open at 50%, one 210 px card a line... inner 186: one column.
    expect(cardCells(fitCards(3, 600)!, 600, 3, 17).cols).toBe(1);
    expect(cardCells(5, 1380, 3, 17)).toMatchObject({ cols: 1, cell: 810 });
    const big = cardCells(10, 1380, 3, 17);
    expect(big.cols).toBe(1);
    expect(big.cell).toBe(1380 - 2 * 16 - 2 * 12);
    expect(big.width).toBe(1380 - 2 * 16);
  });
  it('report 61: one format is the hero, the card\'s whole width; the opening columns are readable ones', () => {
    expect(cardCells(1, 1380, 3, 1)).toEqual({ width: CARD_W, cols: 1, cell: CARD_W - 24, scale: 1 });
    expect(cardCells(1, 1380, 3, 17).cell).toBeGreaterThanOrEqual(CELL_READABLE);
    // 1108 px canvas (a 1728 px window): 95% cards, two columns of about 153 px.
    expect(cardCells(fitCards(3, 1108)!, 1108, 3, 17).cols).toBe(2);
  });
});
