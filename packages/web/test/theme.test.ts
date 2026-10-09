import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const css = readFileSync(resolve(import.meta.dirname, '../src/theme.css'), 'utf8');
const TOKENS = ['--bg', '--panel', '--line', '--line2', '--text', '--muted', '--faint', '--field', '--dot', '--ink', '--inkText', '--accent', '--accentText', '--sel', '--ok', '--okBg', '--warn', '--warnBg', '--warnLine', '--danger', '--dangerBg', '--scrim'];
const block = (sel: string) => css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
describe('theme tokens', () => {
  it('defines every token in light and both dark blocks', () => {
    const root = block(':root {');
    for (const t of TOKENS) expect(root, t).toContain(t + ':');
    for (const sel of [':root:not([data-theme="light"])', ':root[data-theme="dark"]']) for (const t of TOKENS.filter((x) => x !== '--accent')) expect(block(sel), sel + t).toContain(t + ':');
  });
  it('drops the old palette and font', () => { expect(css).not.toMatch(/6D28D9|Manrope/i); });
  it('has no legacy aliases or global classes left (Task 16)', () => {
    for (const alias of ['--surface', '--border', '--accent-soft', '--accent-ink', '--on-accent', '--danger-', '--warn-bg', '--warn-border', '--warn-text', '--font:', '--logo-bg']) expect(css, alias).not.toContain(alias);
    expect(css).not.toMatch(/^\.(card|muted|mono|row|stack|page|topbar|badge|error|warn|tabs|chip|dots)\b/m);
    expect(css).not.toMatch(/^button\s*\{/m);
  });
  it('keeps the risk colour --danger AA (4.5:1) on --dangerBg and on --panel in every theme (Phase 8)', () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x! + 0.05) / (y! + 0.05); };
    const tok = (b: string, name: string) => new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(b)![1]!;
    for (const sel of [':root {', ':root:not([data-theme="light"])', ':root[data-theme="dark"]']) {
      const b = block(sel);
      expect(ratio(tok(b, '--danger'), tok(b, '--dangerBg')), sel).toBeGreaterThanOrEqual(4.5);
      expect(ratio(tok(b, '--danger'), tok(b, '--panel')), sel).toBeGreaterThanOrEqual(4.5);
    }
  });
});
