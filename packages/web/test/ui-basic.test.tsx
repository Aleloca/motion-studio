import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import {
  Avatar, Button, CHANNELS, Card, ChannelMark, Check, Chip, CountdownRing, Empty, Field, ICONS, Icon, Input, Markdown,
  NavItem, Pill, ProgressBar, Segmented, Spinner, Tabs, Tag, Textarea, Toggle, Typing, VersionBadge,
} from '../src/ui/index.ts';

const en = (ui: ReactNode) => render(<I18nProvider locale="en">{ui}</I18nProvider>);

afterEach(() => { vi.useRealTimers(); });

describe('Icon', () => {
  it('renders a decorative 1.4 stroke svg with the path of its name', () => {
    const { container } = render(<Icon name="search" size={18} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('width')).toBe('18');
    expect(svg.getAttribute('stroke-width')).toBe('1.4');
    expect(svg.querySelector('path')!.getAttribute('d')).toBe(ICONS.search);
  });
  it('ports the prototype set exactly, plus the redesign additions', () => {
    const lib = readFileSync(resolve(import.meta.dirname, '../../../docs/design/redesign-prototype/lib.js'), 'utf8');
    const block = lib.slice(lib.indexOf('const P = {'), lib.indexOf('};', lib.indexOf('const P = {')));
    const proto = Object.fromEntries([...block.matchAll(/(\w+): '([^']*)'/g)].map((m) => [m[1]!, m[2]!]));
    expect(Object.keys(proto)).toEqual([
      'play', 'back', 'chevron', 'plus', 'close', 'check', 'search', 'bell', 'gear', 'folder', 'upload', 'download', 'link',
      'globe', 'video', 'image', 'comment', 'hand', 'cursor', 'text', 'crop', 'drop', 'eye', 'lock', 'refresh', 'trash',
      'more', 'shield', 'code', 'sparkle', 'chart', 'grid', 'list', 'star', 'alignL', 'alignC', 'alignR', 'warn', 'clock',
      'terminal', 'key',
    ]);
    for (const [name, d] of Object.entries(proto)) expect(ICONS[name as keyof typeof ICONS], name).toBe(d);
    const extra = Object.keys(ICONS).filter((k) => !(k in proto));
    expect(extra).toEqual(['forward', 'menu', 'minus', 'external', 'copy', 'edit', 'pin', 'pause', 'user']);
  });
  it('supports the prototype fill and stroke-width options, colour from currentColor', () => {
    const { container } = render(<Icon name="play" fill strokeWidth={2} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('stroke-width')).toBe('2');
    const { container: plain } = render(<Icon name="play" />);
    expect(plain.querySelector('svg')!.getAttribute('fill')).toBe('none');
  });
});

describe('Button', () => {
  it('defaults to a non-submitting md default button', () => {
    render(<Button>Go</Button>);
    const b = screen.getByRole('button', { name: 'Go' });
    expect(b.getAttribute('type')).toBe('button');
    expect(b.className).toContain('ms-btn');
    expect(b.className).not.toMatch(/\b(sm|lg)\b/);
  });
  it('applies variant, size and icon classes', () => {
    render(<Button variant="accent" size="lg" icon aria-label="Add"><Icon name="plus" /></Button>);
    const b = screen.getByRole('button', { name: 'Add' });
    expect(b.className).toMatch(/\baccent\b/);
    expect(b.className).toMatch(/\blg\b/);
    expect(b.className).toMatch(/\bicon\b/);
  });
  it('is disabled and shows the spinner while loading', () => {
    const onClick = vi.fn();
    en(<Button loading onClick={onClick}>Save</Button>);
    const b = screen.getByRole('button', { name: /Save/ });
    expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(b.querySelector('.ms-spin')).not.toBeNull();
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('ChannelMark', () => {
  it('renders a non-empty svg path for every channel', () => {
    for (const channel of CHANNELS) {
      const { container, unmount } = en(<ChannelMark channel={channel} />);
      const mark = container.querySelector('.ms-ch')!;
      expect(mark, channel).not.toBeNull();
      const path = mark.querySelector('svg path');
      expect(path?.getAttribute('d')?.length ?? 0, channel).toBeGreaterThan(10);
      unmount();
    }
  });
  it('is named by the channel and supports the 20 px size', () => {
    en(<ChannelMark channel="youtube" size={20} />);
    const mark = screen.getByRole('img', { name: 'YouTube' });
    expect(mark.className).toMatch(/\blg\b/);
  });
});

describe('Field', () => {
  it('wraps its control in a label with the inner prefix', () => {
    render(<Field prefix="DUR"><input aria-label="Duration" defaultValue="2.4" /></Field>);
    const input = screen.getByLabelText('Duration');
    const field = input.closest('label')!;
    expect(field.className).toContain('ms-field');
    expect(field.querySelector('small')!.textContent).toBe('DUR');
  });
});

describe('Input and Textarea', () => {
  it('Input forwards props and carries the field class', () => {
    const onChange = vi.fn();
    render(<Input aria-label="Name" value="" onChange={onChange} className="extra" />);
    const i = screen.getByLabelText('Name');
    expect(i.className).toContain('ms-input');
    expect(i.className).toContain('extra');
    fireEvent.change(i, { target: { value: 'x' } });
    expect(onChange).toHaveBeenCalled();
  });
  it('Textarea has controlled rows and no visible resize', () => {
    render(<Textarea aria-label="Brief" rows={5} defaultValue="" />);
    const t = screen.getByLabelText('Brief');
    expect(t.tagName).toBe('TEXTAREA');
    expect(t.getAttribute('rows')).toBe('5');
    expect(t.className).toContain('ms-input');
  });
});

describe('Toggle', () => {
  it('is a switch that emits the inverted value', () => {
    const onChange = vi.fn();
    render(<Toggle on={false} onChange={onChange} label="Auto-save" />);
    const s = screen.getByRole('switch', { name: 'Auto-save' });
    expect(s.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(s);
    expect(onChange).toHaveBeenCalledWith(true);
  });
  it('reflects on and the small size', () => {
    const onChange = vi.fn();
    render(<Toggle on onChange={onChange} label="Feed" size="sm" />);
    const s = screen.getByRole('switch', { name: 'Feed' });
    expect(s.getAttribute('aria-checked')).toBe('true');
    expect(s.className).toMatch(/\bon\b/);
    expect(s.className).toMatch(/\bsm\b/);
    fireEvent.click(s);
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe('Check', () => {
  it('is a checkbox that emits the inverted value', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Check on={false} onChange={onChange} label="Select asset" />);
    const c = screen.getByRole('checkbox', { name: 'Select asset' });
    expect(c.getAttribute('aria-checked')).toBe('false');
    expect(c.className).not.toMatch(/\bon\b/);
    fireEvent.click(c);
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<Check on onChange={onChange} label="Select asset" />);
    expect(c.getAttribute('aria-checked')).toBe('true');
    expect(c.className).toMatch(/\bon\b/);
    fireEvent.click(c);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});

describe('Segmented', () => {
  const options = [{ value: 'all', label: 'All', count: 4 }, { value: 'image', label: 'Images' }, { value: 'link', label: 'Links' }] as const;
  function Harness({ onChange }: { onChange?: (v: string) => void }) {
    const [v, setV] = useState<string>('all');
    return <Segmented options={options} value={v} onChange={(x) => { setV(x); onChange?.(x); }} label="Filter" />;
  }
  it('is a radiogroup with one checked radio and roving tab index', () => {
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'Filter' })).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    expect(radios[0]!.textContent).toContain('4');
  });
  it('moves with ArrowRight / ArrowLeft, wrapping, and focuses the new option', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const radios = screen.getAllByRole('radio');
    radios[0]!.focus();
    fireEvent.keyDown(radios[0]!, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('image');
    expect(document.activeElement).toBe(radios[1]);
    expect(radios[1]!.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(radios[1]!, { key: 'ArrowRight' });
    fireEvent.keyDown(radios[2]!, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('all');
    fireEvent.keyDown(radios[0]!, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('link');
  });
  it('selects on click', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: /Links/ }));
    expect(onChange).toHaveBeenCalledWith('link');
  });
});

describe('Chip', () => {
  it('is a toggle button with aria-pressed when clickable', () => {
    const onClick = vi.fn();
    render(<Chip on onClick={onClick} icon="link">Linked</Chip>);
    const c = screen.getByRole('button', { name: 'Linked' });
    expect(c.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(c);
    expect(onClick).toHaveBeenCalled();
  });
  it('is static text without onClick', () => {
    render(<Chip>3 assets</Chip>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('3 assets').className).toContain('ms-chip');
  });
});

describe('Tag', () => {
  it('renders a small label', () => {
    render(<Tag mono>fonts.gstatic.com</Tag>);
    const t = screen.getByText('fonts.gstatic.com');
    expect(t.className).toContain('ms-tag');
    expect(t.className).toMatch(/\bmono\b/);
  });
});

describe('Pill', () => {
  it('renders the tone and an optional dot', () => {
    const { container } = render(<Pill tone="warn" dot>Needs you</Pill>);
    const p = screen.getByText('Needs you').closest('.ms-pill')!;
    expect(p.className).toMatch(/\bwarn\b/);
    expect(container.querySelector('.ms-dot')).not.toBeNull();
  });
  it('can show a spinner for working states', () => {
    const { container } = en(<Pill tone="neutral" spinner>Rendering</Pill>);
    expect(container.querySelector('.ms-spin')).not.toBeNull();
  });
});

describe('VersionBadge', () => {
  it('shows the version, starred when chosen, with an accessible name', () => {
    en(<VersionBadge n={3} star />);
    const b = screen.getByLabelText('Chosen version 3');
    expect(b.textContent).toBe('★ v3');
  });
  it('is a button when clickable', () => {
    const onClick = vi.fn();
    en(<VersionBadge n={2} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Version 2' }));
    expect(onClick).toHaveBeenCalled();
  });
});

describe('Spinner', () => {
  it('announces loading from the catalog', () => {
    en(<Spinner />);
    expect(screen.getByRole('status', { name: 'Loading' }).querySelector('.ms-spin')).not.toBeNull();
  });
  it('is silent when decorative', () => {
    const { container } = en(<Spinner decorative />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Typing', () => {
  it('shows three dots announced as typing', () => {
    en(<Typing />);
    const s = screen.getByRole('status', { name: 'Typing' });
    expect(s.querySelectorAll('i')).toHaveLength(3);
  });
});

describe('ProgressBar', () => {
  it('exposes a clamped progressbar value', () => {
    const { rerender } = en(<ProgressBar value={42} />);
    const bar = screen.getByRole('progressbar', { name: 'Progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect((bar.querySelector('i') as HTMLElement).style.width).toBe('42%');
    rerender(<I18nProvider locale="en"><ProgressBar value={140} label="Export" /></I18nProvider>);
    expect(screen.getByRole('progressbar', { name: 'Export' }).getAttribute('aria-valuenow')).toBe('100');
  });
  it('has its own class, not the Tabs "bar" variant (which would squash the project bar tabs to 3 px)', () => {
    en(<ProgressBar value={10} />);
    expect(screen.getByRole('progressbar').className).toBe('ms-progress');
    const css = readFileSync(resolve(import.meta.dirname, '../src/ui/ui.css'), 'utf8');
    expect(css).not.toMatch(/(^|\})\s*\.ms-bar\s*[{,]/m);
  });
});

describe('CountdownRing', () => {
  it('counts down in real time and stops at zero', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
    const createdAt = Date.now() - 30_000;
    const { container } = en(<CountdownRing createdAt={createdAt} ttlSec={90} />);
    const timer = screen.getByRole('timer');
    expect(timer.textContent).toContain('1:00');
    expect(timer.getAttribute('aria-label')).toBe('1:00 left');
    const prog = container.querySelector('.ms-ring-prog')!;
    const offset0 = Number(prog.getAttribute('stroke-dashoffset'));
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(timer.textContent).toContain('0:55');
    expect(Number(prog.getAttribute('stroke-dashoffset'))).toBeGreaterThan(offset0);
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(timer.textContent).toContain('0:00');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Avatar', () => {
  it('shows initials and is named', () => {
    render(<Avatar name="Alessandro Locatelli" />);
    expect(screen.getByRole('img', { name: 'Alessandro Locatelli' }).textContent).toBe('AL');
  });
  it('is a button when clickable', () => {
    const onClick = vi.fn();
    render(<Avatar name="Ada" label="Account menu" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(onClick).toHaveBeenCalled();
  });
});

describe('Empty', () => {
  it('uses catalog defaults', () => {
    en(<Empty />);
    expect(screen.getByText('Nothing here')).toBeTruthy();
  });
  it('renders title, sub and action', () => {
    render(<Empty icon="image" title="No assets" sub="Upload images or video." action={<Button>Upload</Button>} />);
    expect(screen.getByText('No assets')).toBeTruthy();
    expect(screen.getByText('Upload images or video.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeTruthy();
  });
});

describe('Card', () => {
  it('renders a panel, hoverable on request', () => {
    render(<Card hoverable data-testid="c">x</Card>);
    const c = screen.getByTestId('c');
    expect(c.className).toContain('ms-card');
    expect(c.className).toMatch(/\bhov\b/);
  });
});

describe('NavItem', () => {
  it('is a button marked current when on, with icon and count', () => {
    const onClick = vi.fn();
    const { container } = render(<NavItem on icon="gear" count={3} onClick={onClick}>Settings</NavItem>);
    const b = screen.getByRole('button', { name: /Settings/ });
    expect(b.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('svg')).not.toBeNull();
    expect(b.querySelector('.ms-n')!.textContent).toBe('3');
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalled();
  });
});

describe('Tabs', () => {
  const tabs = [{ value: 'chat', label: 'Chat' }, { value: 'comments', label: 'Comments', count: 2 }, { value: 'brief', label: 'Brief' }];
  it('is a tablist with the selected tab and keyboard navigation', () => {
    const onChange = vi.fn();
    render(<Tabs tabs={tabs} value="chat" onChange={onChange} label="Panel" />);
    expect(screen.getByRole('tablist', { name: 'Panel' })).toBeTruthy();
    const all = screen.getAllByRole('tab');
    expect(all.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(all[1]!.textContent).toContain('2');
    fireEvent.keyDown(all[0]!, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('comments');
    fireEvent.keyDown(all[0]!, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('brief');
    fireEvent.click(all[2]!);
    expect(onChange).toHaveBeenLastCalledWith('brief');
  });
  it('moves focus and roves the tab index with the selection', () => {
    function Harness() {
      const [v, setV] = useState('chat');
      return <Tabs tabs={tabs} value={v} onChange={setV} label="Panel" />;
    }
    render(<Harness />);
    const all = screen.getAllByRole('tab');
    expect(all.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    all[0]!.focus();
    fireEvent.keyDown(all[0]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(all[1]);
    expect(all.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    expect(all[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(all[1]!, { key: 'ArrowLeft' });
    fireEvent.keyDown(all[0]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(all[2]);
    expect(all.map((t) => t.tabIndex)).toEqual([-1, -1, 0]);
    fireEvent.keyDown(all[2]!, { key: 'Home' });
    expect(document.activeElement).toBe(all[0]);
  });
});

describe('class names', () => {
  it('every class a ui/ component emits is ms- prefixed (no collision with legacy global classes)', () => {
    const noop = () => {};
    const { container } = en(
      <div>
        {(['default', 'ink', 'accent', 'ghost', 'outline', 'danger'] as const).map((v) => (['sm', 'md', 'lg'] as const).map((s) => <Button key={v + s} variant={v} size={s} icon loading={s === 'lg'} aria-label="b">x</Button>))}
        {CHANNELS.map((c) => <ChannelMark key={c} channel={c} size={20} />)}
        <Field prefix="X"><input /></Field><Input /><Textarea />
        <Toggle on size="sm" onChange={noop} label="t" /><Check on onChange={noop} label="c" />
        <Segmented options={[{ value: 'a', label: 'A', icon: 'grid', count: 1 }, { value: 'b', label: 'B' }]} value="a" onChange={noop} label="s" />
        <Chip on onClick={noop} icon="link">c</Chip><Chip>c</Chip><Tag mono>t</Tag>
        {(['ok', 'warn', 'neutral', 'accent'] as const).map((tone) => <Pill key={tone} tone={tone} dot>p</Pill>)}<Pill spinner>p</Pill>
        <VersionBadge n={1} star onClick={noop} /><VersionBadge n={2} /><Spinner /><Typing /><ProgressBar value={3} />
        <CountdownRing createdAt={Date.now()} ttlSec={60} /><Avatar name="A B" size={32} onClick={noop} /><Avatar name="C" size={26} />
        <Empty action={<span />} sub="s" /><Card hoverable /><NavItem on icon="gear" count={2}>n</NavItem>
        <Tabs tabs={[{ value: 'a', label: 'A', count: 1 }]} value="a" onChange={noop} label="t" variant="bar" />
        <Tabs tabs={[{ value: 'a', label: 'A' }]} value="a" onChange={noop} label="t" />
        <Markdown text={'**b** *i* `c` [l](https://x.y)\n\n- li'} />
      </div>,
    );
    const tokens = new Set<string>();
    for (const el of container.querySelectorAll('[class]')) for (const c of (el.getAttribute('class') ?? '').split(/\s+/)) if (c) tokens.add(c);
    expect([...tokens].filter((c) => !c.startsWith('ms-'))).toEqual([]);
  });
});

describe('accent contrast', () => {
  const ui = readFileSync(resolve(import.meta.dirname, '../src/ui/ui.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const theme = readFileSync(resolve(import.meta.dirname, '../src/theme.css'), 'utf8');
  it('allows white text on the accent only on the accent button and the avatar', () => {
    const rules = [...ui.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
    const onAccent = rules.filter((r) => /background:\s*var\(--accent\)/.test(r.body) && /(^|;)\s*color:/.test(r.body));
    expect(onAccent.length).toBeGreaterThan(0);
    for (const r of onAccent) {
      const color = /(?:^|;)\s*color:\s*([^;]+)/.exec(r.body)![1]!.trim();
      if (color === 'var(--onAccent)') expect(['.ms-btn.ms-accent', '.ms-avatar'], r.sel).toContain(r.sel);
      else expect(color, r.sel).toBe('var(--onAccentStrong)');
    }
    expect(ui).toMatch(/\.ms-count \{[^}]*color: var\(--onAccentStrong\); font-size: 11px; font-weight: 700;/);
  });
  it('renders toast actions as AA text buttons, never white on the accent fill', () => {
    const rules = [...ui.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
    const toastRules = rules.filter((r) => /\.ms-toast/.test(r.sel));
    expect(toastRules.length).toBeGreaterThan(0);
    for (const r of toastRules) expect(/--onAccent\b/.test(r.body) && /var\(--accent\)/.test(r.body), r.sel).toBe(false);
    const action = toastRules.find((r) => r.sel === '.ms-toast-action')!;
    expect(action, '.ms-toast-action rule').toBeTruthy();
    expect(action.body).not.toMatch(/background:\s*var\(--accent\)/);
    const fg = /(?:^|;)\s*color:\s*var\(--(\w+)\)/.exec(action.body)![1]!;
    const bg = /(?:^|;)\s*background:\s*var\(--(\w+)\)/.exec(toastRules.find((r) => r.sel === '.ms-toast')!.body)![1]!;
    expect(ui).toMatch(/\.ms-toast-action:hover \{[^}]*underline/);
    expect(ui).toMatch(/\.ms-toast-action:focus-visible \{[^}]*outline/);
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x! + 0.05) / (y! + 0.05); };
    const tok = (block: string, name: string) => new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(block)![1]!;
    const light = theme.slice(theme.indexOf(':root {'), theme.indexOf('@media'));
    const dark = theme.slice(theme.indexOf(':root[data-theme="dark"]'));
    const media = theme.slice(theme.indexOf('@media (prefers-color-scheme: dark)'), theme.indexOf(':root[data-theme="dark"]'));
    for (const block of [light, dark, media]) expect(ratio(tok(block, fg), tok(block, bg))).toBeGreaterThanOrEqual(4.5);
  });
  it('keeps --onAccentStrong #171717 in every theme and uses the AA light --accentText', () => {
    expect(theme).toContain('--onAccentStrong: #171717;');
    expect(theme.match(/--onAccentStrong:/g)).toHaveLength(1);
    expect(theme).toContain('--accentText: #C2410C;');
    expect(theme).not.toMatch(/E8501A/i);
  });
});

describe('Markdown', () => {
  it('renders # titles as headings only when asked (documents), never in chat text', () => {
    const doc = render(<Markdown headings text={'# Brand ##\n\nIntro\n\n## Key **lines**\n###### Deep'} />);
    expect(doc.container.querySelector('h3')!.textContent).toBe('Brand');
    expect(doc.container.querySelector('h4 strong')!.textContent).toBe('lines');
    expect(doc.container.querySelector('h5')!.textContent).toBe('Deep');
    doc.unmount();
    const chat = render(<Markdown text={'# not a title'} />);
    expect(chat.container.querySelector('h3')).toBeNull();
    expect(chat.container.textContent).toBe('# not a title');
  });
  it('renders bold, italic and inline code', () => {
    const { container } = render(<Markdown text={'**a** and *b* and `c`'} />);
    expect(container.querySelector('strong')!.textContent).toBe('a');
    expect(container.querySelector('em')!.textContent).toBe('b');
    expect(container.querySelector('code')!.textContent).toBe('c');
  });
  it('renders bullet lists and paragraphs', () => {
    const { container } = render(<Markdown text={'Intro line\n\n- one\n- **two**\n* three\n\nOutro'} />);
    const items = container.querySelectorAll('ul > li');
    expect(items).toHaveLength(3);
    expect(items[1]!.querySelector('strong')!.textContent).toBe('two');
    expect(container.querySelectorAll('p')).toHaveLength(2);
  });
  it('keeps HTML as text and never executes it', () => {
    const onerror = vi.fn();
    (window as unknown as { pwn: () => void }).pwn = onerror;
    const { container } = render(<Markdown text={'<img src=x onerror="pwn()"> <script>pwn()</script>'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="pwn()">');
    expect(onerror).not.toHaveBeenCalled();
  });
  it('opens http(s) links externally', () => {
    render(<Markdown text={'See [docs](https://example.com/a) or https://example.org/b.'} />);
    const a = screen.getByRole('link', { name: 'docs' });
    expect(a.getAttribute('href')).toBe('https://example.com/a');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('link', { name: 'https://example.org/b' }).getAttribute('href')).toBe('https://example.org/b');
  });
  it('does not render javascript: or other non-http links', () => {
    const { container } = render(<Markdown text={'[x](javascript:alert(1)) [y](data:text/html,hi) [z](//evil.com)'} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('x');
  });
  const onlyHttpLinks = (root: Element) => {
    for (const a of root.querySelectorAll('a')) expect(a.getAttribute('href') ?? '').toMatch(/^https?:\/\//);
  };
  it('refuses obfuscated and non-http schemes', () => {
    const cases = [
      '[x](JaVaScRiPt:alert(1))', '[x](javascript:alert)', '[x](JaVaScRiPt:alert)', '[x](&#106;avascript:alert(1))',
      'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '[x](data:text/html,hi)', '[x](vbscript:x)',
      '[x](//evil.com)', '[x](https:evil)',
    ];
    for (const text of cases) {
      const { container, unmount } = render(<Markdown text={text} />);
      expect(container.querySelector('a'), text).toBeNull();
      expect(container.querySelector('script'), text).toBeNull();
      unmount();
    }
  });
  it('renders a link nested inside bold, and only http(s) anchors', () => {
    const { container } = render(<Markdown text={'**see [docs](https://example.com/d) and [bad](javascript:x)** and *[i](http://a.b)*'} />);
    const strong = container.querySelector('strong')!;
    expect(strong.querySelector('a')!.getAttribute('href')).toBe('https://example.com/d');
    expect(container.querySelector('em a')!.getAttribute('href')).toBe('http://a.b');
    expect(container.querySelectorAll('a')).toHaveLength(2);
    onlyHttpLinks(container);
  });
  it('parses 20 KB adversarial lines with linear work', () => {
    const lines = [
      '**a `c` '.repeat(2500), '**a '.repeat(5000), '['.repeat(20000), '[a]('.repeat(5000), '*a '.repeat(6700),
      '_a '.repeat(6700), '`'.repeat(20000), 'https://'.repeat(2500), '**['.repeat(6700), '[a](https://x '.repeat(1400),
      // Fenced code blocks: many tiny blocks, near-miss openers and closers, one unclosed block of hostile inline text.
      '```js\n**[a](\n```\n'.repeat(1200), '``` `\n'.repeat(2800), '~~~\n```\n'.repeat(2000), '```\n' + '**[a]('.repeat(3300),
    ];
    // Deterministic work count instead of wall-clock time (which flaked under the parallel full run): every regex
    // exec — including those behind split/replace/test — adds the characters it scanned. The current parser does
    // ≤ ~11 units per character on these lines; the old one (which re-searched the whole remaining text with every
    // rule after each match) did ~700–1,300 per character on 4 KB cuts of lines 1, 9 and 10 and grows with the length.
    const K = 20;
    const exec = RegExp.prototype.exec;
    let work = 0;
    RegExp.prototype.exec = function (this: RegExp, s: string) {
      const start = this.global || this.sticky ? this.lastIndex : 0;
      const m = exec.call(this, s);
      // A sticky exec (used by split) only looks at its position; others scan from `start` to the match end.
      work += this.sticky ? (m ? m[0].length : 0) + 1 : Math.max(1, (m ? m.index + m[0].length : String(s).length) - start);
      return m;
    } as typeof exec;
    try {
      for (const text of lines) {
        work = 0;
        Markdown({ text });
        expect(work, text.slice(0, 12)).toBeLessThanOrEqual(K * text.length);
      }
    } finally { RegExp.prototype.exec = exec; }
  });
  it('renders a fenced code block as plain text in a pre, between paragraphs', () => {
    const { container } = render(<Markdown text={'Before **bold**\n\n```ts\nconst a = 1;\n\n  **not bold** `nor code`\n```\nAfter *it*'} />);
    const pre = container.querySelector('pre.ms-md-pre')!;
    expect(pre).toBeTruthy();
    const code = pre.querySelector(':scope > code')!;
    // The blank line and the indentation are kept; nothing inside is parsed.
    expect(code.textContent).toBe('const a = 1;\n\n  **not bold** `nor code`');
    expect(code.querySelector('strong, code, em')).toBeNull();
    expect(container.textContent).not.toContain('```');
    // The language as a small label, outside the code.
    expect(container.querySelector('.ms-md-lang')!.textContent).toBe('ts');
    const ps = container.querySelectorAll('.ms-md > p');
    expect(ps).toHaveLength(2);
    expect(ps[0]!.querySelector('strong')!.textContent).toBe('bold');
    expect(ps[1]!.querySelector('em')!.textContent).toBe('it');
  });
  it('keeps HTML and links inside a fenced block as text', () => {
    const onerror = vi.fn();
    (window as unknown as { alert: () => void }).alert = onerror;
    const { container } = render(<Markdown text={'```html\n<img src=x onerror=alert(1)>\n[x](javascript:alert(1)) [ok](https://example.com) https://example.org\n```'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a[href]')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('pre code')!.textContent).toBe('<img src=x onerror=alert(1)>\n[x](javascript:alert(1)) [ok](https://example.com) https://example.org');
    expect(onerror).not.toHaveBeenCalled();
  });
  it('an unclosed fence runs to the end of the text; ~~~ fences work; no label without a language', () => {
    const open = render(<Markdown text={'Intro\n```\nline 1\n\n- not a list\n# not a title'} />);
    expect(open.container.querySelector('pre code')!.textContent).toBe('line 1\n\n- not a list\n# not a title');
    expect(open.container.querySelector('ul')).toBeNull();
    expect(open.container.querySelector('.ms-md-lang')).toBeNull();
    expect(open.container.querySelector('p')!.textContent).toBe('Intro');
    open.unmount();
    const tilde = render(<Markdown text={'~~~~ sh extra\n```\necho hi\n~~~~\nDone'} />);
    expect(tilde.container.querySelector('pre code')!.textContent).toBe('```\necho hi');
    expect(tilde.container.querySelector('.ms-md-lang')!.textContent).toBe('sh');
    expect(tilde.container.querySelector('p')!.textContent).toBe('Done');
    tilde.unmount();
    // A closing fence must be at least as long as the opener; an inline ```code``` on one line is not a fence.
    const long = render(<Markdown text={'````\n```\nstill code\n````\n```inline``` text'} />);
    expect(long.container.querySelector('pre code')!.textContent).toBe('```\nstill code');
    expect(long.container.querySelectorAll('pre')).toHaveLength(1);
  });
  it('a long line scrolls inside the pre and never widens the message (CSS contract)', () => {
    const { container } = render(<Markdown text={'```\n' + 'x'.repeat(2000) + '\n```'} />);
    const pre = container.querySelector('pre.ms-md-pre')!;
    expect(pre.parentElement!.classList.contains('ms-md-code')).toBe(true);
    const css = readFileSync(resolve(import.meta.dirname, '../src/ui/ui.css'), 'utf8');
    const rule = (sel: string) => {
      const m = new RegExp(`(?:^|\\n)${sel.replace(/[.*]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`).exec(css);
      expect(m, sel).toBeTruthy();
      return m![1]!;
    };
    const pr = rule('.ms-md-pre');
    expect(pr).toMatch(/overflow-x:\s*auto/);
    expect(pr).toMatch(/white-space:\s*pre\b/);
    expect(pr).toMatch(/font-family:\s*var\(--mono\)/);
    expect(pr).toMatch(/background:\s*var\(--[\w-]+\)/);
    expect(pr).toMatch(/max-width:\s*100%/);
    expect(pr).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
    // The wrapper does not take the line's width as its own: it fills the message and lets the pre scroll.
    const wrap = rule('.ms-md-code');
    expect(wrap).toMatch(/contain:\s*inline-size/);
    expect(wrap).toMatch(/max-width:\s*100%/);
  });
  it('does not treat snake_case as italic', () => {
    const { container } = render(<Markdown text={'use some_file_name here'} />);
    expect(container.querySelector('em')).toBeNull();
    expect(container.textContent).toBe('use some_file_name here');
  });
});
