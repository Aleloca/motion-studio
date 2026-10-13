import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_NAME_PATTERN, EXPORT_NAME_TOKENS, defaultPattern, exportNameVars, renderName } from '../src/export-name.ts';

const base = { title: 'Autumn', channel: 'Instagram', format: 'instagram-reel-9x16', ratio: '9x16', v: 5, date: '2026-10-10' };

describe('{locale} token', () => {
  it('is a known token', () => { expect(EXPORT_NAME_TOKENS).toContain('locale'); });
  it('renders the locale slug', () => {
    expect(renderName('{title}-{format}-{locale}-v{v}', { ...base, locale: 'zh-Hans' })).toEqual({ ok: true, name: 'autumn-instagram-reel-9x16-zh-hans-v5', unknown: [] });
  });
  it('renders nothing when absent or empty, separators collapse', () => {
    const expected = { ok: true, name: 'autumn-instagram-reel-9x16-v5', unknown: [] };
    expect(renderName('{title}-{format}-{locale}-v{v}', base)).toEqual(expected);
    expect(renderName('{title}-{format}-{locale}-v{v}', { ...base, locale: '' })).toEqual(expected);
  });
  it('defaultPattern depends on the languages; without them it is the old one', () => {
    expect(defaultPattern(false)).toBe(DEFAULT_EXPORT_NAME_PATTERN);
    expect(DEFAULT_EXPORT_NAME_PATTERN).toBe('{title}-{format}-v{v}');
    expect(defaultPattern(true)).toBe('{title}-{format}-{locale}-v{v}');
  });
  it('exportNameVars carries the locale', () => {
    const o = { title: 'T', slug: 't', format: 'x', preset: undefined, version: 1, date: '2026-10-10' };
    expect(exportNameVars(o)).not.toHaveProperty('locale');
    expect(exportNameVars({ ...o, locale: 'de' }).locale).toBe('de');
  });
});

describe('{format} with an instance id', () => {
  it('renders the slugged id: x@2 becomes x-2, a bare id is unchanged', () => {
    expect(renderName('{format}', { ...base, format: 'instagram-story-9x16@2' })).toEqual({ ok: true, name: 'instagram-story-9x16-2', unknown: [] });
    expect(renderName('{format}', { ...base, format: 'instagram-story-9x16' })).toEqual({ ok: true, name: 'instagram-story-9x16', unknown: [] });
    expect(renderName('{title}-{format}-v{v}', { ...base, format: 'x@20' })).toEqual({ ok: true, name: 'autumn-x-20-v5', unknown: [] });
  });
});
