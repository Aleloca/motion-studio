import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('no network APIs in the runtime', () => {
  it('the browser sources never use fetch, XHR, WebSocket, beacons, EventSource, workers or dynamic import', () => {
    const dir = join(import.meta.dirname, '../src');
    const files = [...readdirSync(dir).map((f) => join(dir, f)), ...readdirSync(join(dir, 'entry')).map((f) => join(dir, 'entry', f))].filter((f) => f.endsWith('.ts'));
    const banned = /\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|new\s+Worker|SharedWorker|import\s*\()/;
    for (const f of files) {
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
      expect({ f, hit: banned.exec(code)?.[0] ?? null }).toEqual({ f, hit: null });
    }
  });
});
