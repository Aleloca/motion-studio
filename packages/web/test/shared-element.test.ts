import { afterEach, describe, expect, it } from 'vitest';
import { setFrameOrigin, takeFrameOrigin } from '../src/shell/intents.ts';
import { sharedElement } from '../src/shell/sharedElement.ts';

const rect = { left: 12, top: 64, width: 448, height: 800 } as DOMRect;
afterEach(() => { takeFrameOrigin('brief-panel:acme/lancio'); });

describe('sharedElement (T3/T4, decision 1419)', () => {
  it('New creative → its creative shares the chat only while the brief panel origin is set', () => {
    const a = { name: 'new-creative', slug: 'acme' } as const;
    const b = { name: 'creative', slug: 'acme', creative: 'lancio' } as const;
    expect(sharedElement(a, b)).toBeUndefined();
    setFrameOrigin('brief-panel:acme/lancio', rect);
    expect(sharedElement(a, b)).toBe('shared');
    // Peeking leaves the origin for the canvas to take.
    expect(takeFrameOrigin('brief-panel:acme/lancio')).toBe(rect);
    expect(sharedElement(a, b)).toBeUndefined();
    setFrameOrigin('brief-panel:acme/lancio', rect);
    expect(sharedElement(a, { ...b, slug: 'other' })).toBeUndefined();
    expect(sharedElement(b, a)).toBeUndefined();
  });

  it('a board and its format view still share their element, both ways', () => {
    const c = { name: 'creative', slug: 'acme', creative: 'lancio' } as const;
    const f = { name: 'format', slug: 'acme', creative: 'lancio', format: 'tiktok-9x16' } as const;
    expect(sharedElement(c, f)).toBe('shared');
    expect(sharedElement(f, c)).toBe('shared');
    expect(sharedElement(c, { ...f, creative: 'altro' })).toBeUndefined();
  });
});
