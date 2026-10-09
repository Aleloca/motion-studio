import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const css = readFileSync(resolve(import.meta.dirname, '../src/theme.css'), 'utf8');
const TOKENS = ['--bg', '--panel', '--line', '--line2', '--text', '--muted', '--faint', '--field', '--dot', '--ink', '--inkText', '--accent', '--accentText', '--sel', '--ok', '--okBg', '--warn', '--warnBg', '--warnLine', '--scrim'];
const block = (sel: string) => css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
describe('theme tokens', () => {
  it('defines every token in light and both dark blocks', () => {
    const root = block(':root {');
    for (const t of TOKENS) expect(root, t).toContain(t + ':');
    for (const sel of [':root:not([data-theme="light"])', ':root[data-theme="dark"]']) for (const t of TOKENS.filter((x) => x !== '--accent')) expect(block(sel), sel + t).toContain(t + ':');
  });
  it('drops the old palette and font', () => { expect(css).not.toMatch(/6D28D9|Manrope/i); });
  it('has no legacy aliases or global classes left (Task 16)', () => {
    for (const alias of ['--surface', '--border', '--accent-soft', '--accent-ink', '--on-accent', '--danger', '--warn-bg', '--warn-border', '--warn-text', '--font:', '--logo-bg']) expect(css, alias).not.toContain(alias);
    expect(css).not.toMatch(/^\.(card|muted|mono|row|stack|page|topbar|badge|error|warn|tabs|chip|dots)\b/m);
    expect(css).not.toMatch(/^button\s*\{/m);
  });
});
