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
  it('ports the whole prototype set', () => {
    expect(Object.keys(ICONS).length).toBeGreaterThanOrEqual(45);
    for (const d of Object.values(ICONS)) expect(d.length).toBeGreaterThan(0);
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
    expect(b.querySelector('.n')!.textContent).toBe('3');
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
});

describe('Markdown', () => {
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
  it('does not treat snake_case as italic', () => {
    const { container } = render(<Markdown text={'use some_file_name here'} />);
    expect(container.querySelector('em')).toBeNull();
    expect(container.textContent).toBe('use some_file_name here');
  });
});
