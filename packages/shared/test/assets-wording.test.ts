import { describe, expect, it } from 'vitest';
import { messages, LOCALES } from '../src/i18n/index.ts';

// Report 80 (decision 1820): the project's files are "Assets" (it: "Asset") everywhere the user reads them, never "library".
const OLD_NAME = /\blibrar(y|ies)\b|\blibreri[ae]\b/i;
// The meanings that stay: the macOS ~/Library folder in the codebase-brand refusal.
const KEPT = [/\bunder Library\b/, /\bsotto Library\b/];

function strings(node: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof node === 'string') out.push([path, node]);
  else if (typeof node === 'function') out.push([path, String(node)]);
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) strings(v, `${path}.${k}`, out);
}

describe('assets wording', () => {
  for (const locale of LOCALES) {
    it(`no ${locale} catalog string calls the project's files a library`, () => {
      const all: Array<[string, string]> = [];
      strings(messages(locale), locale, all);
      const bad = all.filter(([, s]) => {
        let text = s;
        for (const k of KEPT) text = text.replace(k, '');
        return OLD_NAME.test(text);
      });
      expect(bad.map(([p]) => p)).toEqual([]);
    });
  }
});
