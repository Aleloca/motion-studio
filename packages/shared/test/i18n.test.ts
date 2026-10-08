import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/schemas.ts';
import { LOCALES, isLocale, languageName, messages, resolveLocale } from '../src/i18n/index.ts';
import type { Messages } from '../src/i18n/index.ts';
import { en } from '../src/i18n/en.ts';

const leaves = (o: unknown, path = ''): Array<[string, unknown]> =>
  typeof o === 'object' && o !== null ? Object.entries(o).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k)) : [[path, o]];

describe('resolveLocale', () => {
  it('honours an explicit choice', () => { expect(resolveLocale('it', ['en-US'])).toBe('it'); expect(resolveLocale('en', ['it-IT'])).toBe('en'); });
  it('follows the system for Italian, English otherwise', () => {
    expect(resolveLocale('system', ['it-IT', 'en'])).toBe('it');
    expect(resolveLocale('system', ['de-DE', 'it'])).toBe('it');
    expect(resolveLocale('system', ['de-DE'])).toBe('en');
    expect(resolveLocale(undefined, [])).toBe('en');
    expect(resolveLocale('system', ['C', 'POSIX'])).toBe('en');
  });
  it('ignores malformed entries and accepts POSIX-style tags, case-insensitively', () => {
    expect(resolveLocale('system', ['', '*', 'C', 'IT'])).toBe('it');
    expect(resolveLocale('system', ['it_IT.UTF-8'])).toBe('it');
    expect(resolveLocale('system', ['It-it'])).toBe('it');
    expect(resolveLocale('system', ['', '*', 'POSIX'])).toBe('en');
  });
  it('walks the system tags in order and takes the first supported one', () => {
    expect(resolveLocale('system', ['en-US', 'it-IT'])).toBe('en');
    expect(resolveLocale('system', ['de-DE', 'it'])).toBe('it');
    expect(resolveLocale('system', ['it-IT', 'en'])).toBe('it');
    expect(resolveLocale('system', [])).toBe('en');
    expect(resolveLocale('system', ['C', 'POSIX'])).toBe('en');
    expect(resolveLocale('system', ['de-DE', 'en-GB', 'it-IT'])).toBe('en');
  });
  it('does not mistake other languages starting with "it" letters', () => {
    expect(resolveLocale('system', ['ita-XX'])).toBe('en');
  });
});

describe('catalogs', () => {
  it('have the same keys and no empty strings', () => {
    const en = leaves(messages('en')); const itl = leaves(messages('it'));
    expect(itl.map(([k]) => k).sort()).toEqual(en.map(([k]) => k).sort());
    for (const l of LOCALES) for (const [k, v] of leaves(messages(l))) {
      if (typeof v === 'string') expect(v.trim(), `${l}:${k}`).not.toBe('');
      else expect(typeof v, `${l}:${k}`).toBe('function');
    }
  });
  it('names the languages', () => {
    expect(languageName('en')).toBe('English');
    expect(languageName('it')).toBe('Italian');
  });
});

describe('issue codes', () => {
  it('every issue.<key> used by the shared schemas has a text in every catalog', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    const codes = new Set(files.flatMap((f) => [...readFileSync(join(src, f), 'utf8').matchAll(/['"`]issue\.(\w+)/g)].map((m) => m[1]!)));
    expect(codes.size).toBeGreaterThan(20);
    for (const l of LOCALES) {
      const issues = messages(l).issues as Record<string, unknown>;
      expect([...codes].filter((c) => typeof issues[c] !== 'string'), l).toEqual([]);
    }
  });
});

describe('isLocale', () => {
  it('accepts exactly the supported locales', () => {
    for (const l of LOCALES) expect(isLocale(l)).toBe(true);
    for (const v of ['system', 'de', 'IT', '', undefined, null, 1, {}]) expect(isLocale(v)).toBe(false);
  });
  it('every locale has a catalog and a language name', () => {
    for (const l of LOCALES) { expect(messages(l)).toBeTruthy(); expect(languageName(l)).toMatch(/^[A-Z]/); }
  });
});

describe('appConfigSchema.language', () => {
  it('defaults to system so existing config files still parse', () => {
    expect(appConfigSchema.parse({ schemaVersion: 1, workspacePath: null }).language).toBe('system');
    expect(appConfigSchema.parse({ schemaVersion: 1, language: 'it' }).language).toBe('it');
    expect(appConfigSchema.safeParse({ schemaVersion: 1, language: 'de' }).success).toBe(false);
  });
});

// Type-level checks: these are compiled by `pnpm typecheck` (never executed).
export function typeLevelChecks(): void {
  const full = messages('it');
  // @ts-expect-error a missing key must not typecheck
  const missing: Messages = { ...full, common: { ...full.common, cancel: undefined } };
  // @ts-expect-error a different parameter shape must not typecheck
  const wrongParams: Messages = { ...full, common: { ...full.common, items: (p: { total: number }) => String(p.total) } };
  // Different text is allowed (strings are widened).
  const ok: Messages = { ...full, common: { ...full.common, cancel: 'Annulla' } };
  void [missing, wrongParams, ok, en];
}
