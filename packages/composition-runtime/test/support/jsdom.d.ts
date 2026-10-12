// Minimal typing of the jsdom API the tests use (jsdom ships no types and @types/jsdom is not a dependency).
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: { pretendToBeVisual?: boolean; url?: string; runScripts?: 'dangerously' | 'outside-only' });
    readonly window: Window & typeof globalThis;
  }
}
