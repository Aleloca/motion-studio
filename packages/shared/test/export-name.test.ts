import { describe, expect, it } from 'vitest';
import { EXPORT_NAME_MAX, exportDate, exportExtension, exportNameCollisions, exportNameVars, ratioToken, renderName } from '../src/export-name.ts';

const vars = { title: 'Autumn Sourdough!', channel: 'Instagram', format: 'instagram-reel-9x16', ratio: '9x16', v: 5, date: '2026-10-10' };

describe('renderName', () => {
  it('renders the default pattern like the phase 7 names', () => {
    expect(renderName('{title}-{format}-v{v}', vars)).toEqual({ ok: true, name: 'autumn-sourdough-instagram-reel-9x16-v5', unknown: [] });
  });
  it('slugifies each token value and keeps the safe literals', () => {
    const r = renderName('Final_{channel} {ratio}.{date}', { ...vars, channel: 'Café Ünïcode' });
    expect(r).toEqual({ ok: true, name: 'Final_cafe-unicode-9x16.2026-10-10', unknown: [] });
  });
  it('collapses separators left by empty tokens and trims the ends', () => {
    expect(renderName('{channel}--{title}__{channel}.-{v}..', { ...vars, channel: '' })).toEqual({ ok: true, name: 'autumn-sourdough_5', unknown: [] });
    expect(renderName('...{v}', vars)).toEqual({ ok: true, name: '5', unknown: [] });
  });
  it('leaves unknown variables out and reports them', () => {
    expect(renderName('{title}-{client}-{v}{Title}', vars)).toEqual({ ok: true, name: 'autumn-sourdough-5', unknown: ['client', 'Title'] });
  });
  it('keeps an unclosed brace as a (sanitised) literal', () => {
    expect(renderName('{title}-{v', vars)).toEqual({ ok: true, name: 'autumn-sourdough-v', unknown: [] });
  });
  it('returns an error for an empty result', () => {
    expect(renderName('{channel}-{nope}', { ...vars, channel: '!!' })).toEqual({ ok: false, error: 'empty', unknown: ['nope'] });
    expect(renderName('   ', vars)).toMatchObject({ ok: false, error: 'empty' });
  });
  it(`caps at ${EXPORT_NAME_MAX} characters, without a trailing separator`, () => {
    const r = renderName(`${'a'.repeat(119)}-{v}`, vars);
    expect(r).toEqual({ ok: true, name: 'a'.repeat(119), unknown: [] });
    const long = renderName('{title}{title}{title}{title}', { ...vars, title: 'x'.repeat(40) });
    expect(long.ok && long.name.length).toBe(EXPORT_NAME_MAX);
  });
  it('never leaves half of a surrogate pair at the cut', () => {
    const pattern = `${'a'.repeat(119)}😀b`;
    const r = renderName(pattern, vars);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name.length).toBeLessThanOrEqual(EXPORT_NAME_MAX);
    expect(/[\uD800-\uDFFF]/.test(r.name)).toBe(false);
    expect(r.name).toBe('a'.repeat(119));
  });
  it('only produces characters the export allows, never a leading dot', () => {
    const r = renderName('.{title}/..\\{format}:*?"<>|', { ...vars, title: '../../etc', format: 'x/../y' });
    expect(r.ok && r.name).toBe('etc-x-y');
    expect(r.ok && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(r.name)).toBe(true);
  });
  it('runs in linear time on hostile patterns', () => {
    const hostile = `${'{'.repeat(50_000)}${'-.'.repeat(50_000)}${'{x'.repeat(50_000)}`;
    const t0 = performance.now();
    renderName(hostile, vars);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('export name helpers', () => {
  it('exportNameCollisions groups names case-insensitively, extension included', () => {
    expect(exportNameCollisions(['A-v1.mp4', 'a-v1.MP4', 'a-v1.png', 'b.mp4'])).toEqual(['a-v1.mp4']);
    expect(exportNameCollisions(['a.mp4', 'b.mp4'])).toEqual([]);
  });
  it('exportDate is the local YYYY-MM-DD', () => {
    expect(exportDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
  it('exportExtension keeps the phase 7 rule', () => {
    expect(exportExtension('a.MP4')).toBe('.mp4');
    expect(exportExtension('.hidden')).toBe('');
    expect(exportExtension('a.we?rd')).toBe('.we_rd');
  });
  it('ratioToken reduces the size', () => {
    expect(ratioToken(1080, 1920)).toBe('9x16');
    expect(ratioToken(300, 250)).toBe('6x5');
    expect(ratioToken(0, 10)).toBe('');
  });
  it('exportNameVars: title slug ≤ 40 or the creative slug, channel and ratio from the preset', () => {
    const preset = { id: 'instagram-reel-9x16', channel: 'Instagram', name: 'Reel', width: 1080, height: 1920, kind: 'video' as const, extensions: ['mp4'] };
    const v = exportNameVars({ title: `${'abcd '.repeat(12)}end`, slug: 'folder', format: 'instagram-reel-9x16', preset, version: 3, date: new Date(2026, 9, 10) });
    expect(v).toEqual({ title: 'abcd-'.repeat(8).slice(0, 39), channel: 'instagram', format: 'instagram-reel-9x16', ratio: '9x16', v: 3, date: '2026-10-10' });
    expect(exportNameVars({ title: ' !!! ', slug: 'folder', format: 'f', preset: undefined, size: { width: 300, height: 250 }, version: 1, date: new Date(2026, 9, 10) }))
      .toMatchObject({ title: 'folder', channel: '', ratio: '6x5' });
  });
});
