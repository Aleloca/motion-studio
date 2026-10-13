import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { ColorField, NumberField, Select, normalizeHex } from '../src/ui/index.ts';

afterEach(cleanup);

function Num({ start, onChange, ...rest }: Partial<Parameters<typeof NumberField>[0]> & { start?: number | null }) {
  const [v, setV] = useState<number | null>(start === undefined ? 10 : start);
  return <NumberField label="Width" {...rest} value={v} onChange={(n) => { setV(n); onChange?.(n); }} />;
}
const box = () => screen.getByRole('spinbutton', { name: 'Width' }) as HTMLInputElement;

describe('NumberField', () => {
  it('steps with the arrows, ×10 with Shift, ten steps with PageUp / PageDown', () => {
    render(<Num step={2} />);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('12');
    fireEvent.keyDown(box(), { key: 'ArrowUp', shiftKey: true });
    expect(box().value).toBe('32');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().value).toBe('30');
    fireEvent.keyDown(box(), { key: 'PageDown' });
    expect(box().value).toBe('10');
  });

  it('clamps to its bounds, typed or stepped, and reports only values inside them', () => {
    const seen: number[] = [];
    render(<Num min={0} max={20} start={19} onChange={(n) => seen.push(n)} />);
    fireEvent.keyDown(box(), { key: 'ArrowUp', shiftKey: true });
    expect(box().value).toBe('20');
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: '-5' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('0');
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: '999' } });
    fireEvent.blur(box());
    expect(box().value).toBe('20');
    expect(seen).toEqual([20, 0, 20]);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(20);
  });

  it('commits typing on Enter and on leaving, drops it on Escape, ignores what is not a number', () => {
    const seen: number[] = [];
    const end = vi.fn();
    render(<Num onChange={(n) => seen.push(n)} onEnd={end} />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: '42,5' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(seen).toEqual([42.5]);
    fireEvent.change(box(), { target: { value: '7' } });
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(box().value).toBe('42.5');
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'abc' } });
    fireEvent.blur(box());
    expect(box().value).toBe('42.5');
    expect(seen).toEqual([42.5]);
    expect(end).toHaveBeenCalled();
  });

  it('is a spinbutton with its bounds, an empty value starts the arrows at startAt, disabled does nothing', () => {
    const seen: number[] = [];
    render(<Num start={null} startAt={100} min={0} max={500} onChange={(n) => seen.push(n)} />);
    expect(box().getAttribute('aria-valuemin')).toBe('0');
    expect(box().getAttribute('aria-valuemax')).toBe('500');
    expect(box().value).toBe('');
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(seen).toEqual([101]);
    cleanup();
    render(<Num disabled onChange={(n) => seen.push(n)} />);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(seen).toEqual([101]);
  });
});

function Color({ onChange }: { onChange?: (h: string) => void }) {
  const [v, setV] = useState<string | undefined>('#112233');
  return <ColorField label="Hex colour" value={v} onChange={(h) => { setV(h); onChange?.(h); }}
    groups={[{ label: 'Brand palette', colors: ['#ff0000', '#00ff00'] }, { label: 'Empty', colors: [] }]} />;
}

describe('ColorField', () => {
  it('has no native colour input; swatches are toggle buttons that choose their colour', () => {
    const seen: string[] = [];
    const { container } = render(<Color onChange={(h) => seen.push(h)} />);
    expect(container.querySelector('input[type="color"]')).toBeNull();
    const red = screen.getByRole('button', { name: '#ff0000' });
    expect(red.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(red);
    expect(seen).toEqual(['#ff0000']);
    expect(screen.getByRole('button', { name: '#ff0000' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('group', { name: 'Empty' })).toBeNull();
  });

  it('commits a valid hex on Enter (the # is optional), rejects an invalid one and keeps the colour', () => {
    const seen: string[] = [];
    render(<Color onChange={(h) => seen.push(h)} />);
    const input = screen.getByRole('textbox', { name: 'Hex colour' }) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(seen).toEqual(['#abc']);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '#12' } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.blur(input);
    expect(input.value).toBe('#abc');
    expect(seen).toEqual(['#abc']);
    expect(normalizeHex('#AABBCCDD')).toBe('#AABBCCDD');
    expect(normalizeHex('zz')).toBeNull();
  });
});

describe('Select with groups and disabled options', () => {
  it('shows group headings, skips disabled options with the arrows and refuses to choose them', () => {
    const picked: string[] = [];
    render(<I18nProvider locale="en"><Select label="Font" value="a" onChange={(v) => picked.push(v)} options={[
      { value: 'a', label: 'Alpha', group: 'Composition' },
      { value: 'b', label: 'Beta', group: 'Brand', disabled: true, hint: 'No font file in the brand kit' },
      { value: 'c', label: 'Gamma', group: 'Brand' },
    ]} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Font/ }));
    expect(screen.getByText('Composition')).toBeTruthy();
    expect(screen.getByText('Brand')).toBeTruthy();
    expect(screen.getByText('No font file in the brand kit')).toBeTruthy();
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(picked).toEqual(['c']);
    fireEvent.click(screen.getByRole('button', { name: /Font/ }));
    fireEvent.click(screen.getByRole('option', { name: /Beta/ }));
    expect(picked).toEqual(['c']);
    expect(screen.getByRole('option', { name: /Beta/ }).getAttribute('aria-disabled')).toBe('true');
  });
});

describe('theming', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../src/ui/ui.css'), 'utf8');
  const theme = readFileSync(resolve(import.meta.dirname, '../src/theme.css'), 'utf8');
  const editorCss = readFileSync(resolve(import.meta.dirname, '../src/screens/editor/editor.css'), 'utf8');
  const mine = css.slice(css.indexOf('/* Select: grouped and disabled options. */'));
  const inspector = editorCss.slice(editorCss.indexOf('/* The inspector (Task 8)'));

  it('the new styles and sources use tokens only, never a literal colour', () => {
    const literal = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;
    expect(literal.test(mine)).toBe(false);
    expect(literal.test(inspector)).toBe(false);
    for (const f of ['ui/NumberField.tsx', 'ui/ColorField.tsx', 'screens/editor/Inspector.tsx', 'screens/editor/AssetPicker.tsx']) {
      const src = readFileSync(resolve(import.meta.dirname, '../src', f), 'utf8');
      expect(src.split('\n').filter((l) => literal.test(l) && !l.includes('// color-data')), f).toEqual([]);
    }
  });

  it('every token they use is defined in the base theme, so it resolves in the light and in the dark one', () => {
    const used = new Set([...(mine + inspector).matchAll(/var\((--[a-zA-Z0-9-]+)\)/g)].map((m) => m[1]!));
    const light = theme.slice(0, theme.indexOf('@media (prefers-color-scheme: dark)'));
    const dark = theme.slice(theme.indexOf('@media (prefers-color-scheme: dark)'));
    for (const token of used) {
      if (['--d-s', '--e-std', '--mono'].includes(token)) continue; // motion and font tokens are theme-independent
      expect(light.includes(`${token}:`), `${token} in the base (light) theme`).toBe(true);
      // The dark theme overrides the surface tokens; a token it does not override keeps its base value.
      if (dark.includes(`${token}:`)) expect(dark.indexOf(`${token}:`)).toBeGreaterThan(0);
    }
  });
});
