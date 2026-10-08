import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApprovalRequest } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

class ApiError extends Error { constructor(public status: number, m: string) { super(m); } }
const api = { decideApproval: vi.fn(async () => ({})) };
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { ApprovalCard } = await import('../src/components/ApprovalCard.tsx');

const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);
const base: ApprovalRequest = {
  id: 'a1', jobId: 'j', projectSlug: 'acme', creativeSlug: 'c1', kind: 'tool', title: 'Run a command', detail: 'brew install ffmpeg',
  toolName: 'Bash', alwaysRule: 'Bash(brew:*)', createdAt: '2026-10-08T10:00:00.000Z', expiresAt: '2026-10-08T10:10:00.000Z',
};

// Estimated layout. jsdom has no layout engine, so widths are derived from the computed CSS: a box is CARD_W wide; text
// that may break anywhere (white-space other than pre/nowrap + overflow-wrap anywhere/break-word) fits its box, otherwise
// its longest unbreakable run sets the width (CH px per character). A child that clips (overflow other than visible)
// contributes its own box width; any other child contributes its scroll width.
const CARD_W = 320;
const CH = 7;
// Read from disk: Vitest turns CSS imports (even ?raw) into empty modules.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/components/conversation.css'), 'utf8');
// overflow-wrap and white-space are inherited: jsdom does not compute inheritance, so walk up to the nearest value.
function inherited(el: Element, prop: 'whiteSpace' | 'overflowWrap'): string {
  for (let e: Element | null = el; e; e = e.parentElement) { const v = getComputedStyle(e)[prop]; if (v) return v; }
  return '';
}
function textWidth(el: Element): number {
  const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? '').join('');
  if (!own.trim()) return 0;
  const ws = inherited(el, 'whiteSpace') || 'normal';
  if (ws !== 'pre' && ws !== 'nowrap' && /anywhere|break-word/.test(inherited(el, 'overflowWrap'))) return 0;
  const runs = ws === 'pre' ? own.split('\n') : ws === 'nowrap' ? [own] : own.split(/\s+/);
  return Math.max(...runs.map((r) => r.length)) * CH;
}
const clips = (el: Element) => { const o = getComputedStyle(el).overflow || getComputedStyle(el).overflowX; return !!o && o !== 'visible'; };
function scrollW(el: Element): number {
  return Math.max(CARD_W, textWidth(el), ...[...el.children].map((c) => (clips(c) ? CARD_W : scrollW(c))));
}
let style: HTMLStyleElement;
const descriptors = {
  sw: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth')!,
  cw: Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!,
};
beforeEach(() => {
  vi.clearAllMocks();
  style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get() { return CARD_W; } });
  Object.defineProperty(Element.prototype, 'scrollWidth', { configurable: true, get(this: Element) { return clips(this) ? Math.max(CARD_W, textWidth(this), ...[...this.children].map(scrollW)) : scrollW(this); } });
});
afterEach(() => {
  style.remove();
  Object.defineProperty(Element.prototype, 'scrollWidth', descriptors.sw);
  Object.defineProperty(Element.prototype, 'clientWidth', descriptors.cw);
  vi.useRealTimers();
});

const longPath = `/Users/someone/${'a'.repeat(300)}`;
const command = Array.from({ length: 30 }, (_, i) => (i === 4 ? `cp ${longPath} ./out` : `echo step-${i}`)).join('\n');

describe('ApprovalCard', () => {
  it('shows the whole long command wrapped inside the card, with its line count', async () => {
    en(<ApprovalCard approval={{ ...base, detail: command }} />);
    const card = screen.getByRole('group', { name: 'Run a command' });
    const show = screen.getByRole('button', { name: /Show command/ });
    expect(show.textContent).toContain('30 lines');
    expect(show.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(show);
    expect(show.getAttribute('aria-expanded')).toBe('true');
    const pre = screen.getByLabelText('Full command');
    expect(pre.tagName).toBe('PRE');
    // The full text, never truncated.
    expect(pre.textContent).toBe(command);
    // CSS contract: wraps anywhere, bounded height with its own visible scrolling.
    const s = getComputedStyle(pre);
    expect(s.whiteSpace).toBe('pre-wrap');
    expect(s.overflowWrap).toBe('anywhere');
    expect(s.maxHeight).not.toBe('');
    expect(s.overflow).toBe('auto');
    // Estimated layout: neither the command box nor the card scrolls horizontally.
    expect(pre.scrollWidth).toBeLessThanOrEqual(pre.clientWidth);
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    // 30 lines do not fit the box: the card says there is more to read.
    expect(screen.getByText('Scroll to read it all')).toBeTruthy();
    expect(pre.tabIndex).toBe(0);
  });

  it('the layout estimate catches text that does not wrap', async () => {
    style.textContent = css.replace(/overflow-wrap:\s*anywhere/g, 'overflow-wrap: normal');
    en(<ApprovalCard approval={{ ...base, title: `Edit ${longPath}`, detail: command }} />);
    await userEvent.click(screen.getByRole('button', { name: /Show command/ }));
    expect(screen.getByLabelText('Full command').scrollWidth).toBeGreaterThan(CARD_W);
    expect(screen.getByRole('group').scrollWidth).toBeGreaterThan(CARD_W);
  });

  it('wraps a long title too', () => {
    en(<ApprovalCard approval={{ ...base, title: `Edit ${longPath}` }} />);
    const card = screen.getByRole('group');
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
  });

  it('says when the core shortened the detail', async () => {
    en(<ApprovalCard approval={{ ...base, detail: 'x'.repeat(2000) }} />);
    await userEvent.click(screen.getByRole('button', { name: /Show command/ }));
    expect(screen.getByText(/first 2,000 characters/)).toBeTruthy();
  });

  it('says when the core shortened a generic tool input (500 characters)', async () => {
    en(<ApprovalCard approval={{ ...base, toolName: 'mcp__other__thing', alwaysRule: null, detail: '{"a":"' + 'x'.repeat(494) }} />);
    await userEvent.click(screen.getByRole('button', { name: /Show details/ }));
    expect(screen.getByText(/first 500 characters/)).toBeTruthy();
  });

  it('does not claim a short detail was shortened', async () => {
    en(<ApprovalCard approval={{ ...base, detail: 'x'.repeat(600) }} />);
    await userEvent.click(screen.getByRole('button', { name: /Show command/ }));
    expect(screen.queryByText(/first .* characters/)).toBeNull();
  });

  it('a card that is pending again after a decision can be decided again', async () => {
    const { rerender } = en(<ApprovalCard approval={base} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement).disabled).toBe(true));
    rerender(<I18nProvider locale="en"><ApprovalCard approval={base} leaving /></I18nProvider>);
    rerender(<I18nProvider locale="en"><ApprovalCard approval={base} leaving={false} /></I18nProvider>);
    expect((screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Allow sends a one-time approval', async () => {
    en(<ApprovalCard approval={base} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    // The API decision for "Allow" is 'once' (ApprovalDecision = 'once' | 'always' | 'deny').
    expect(api.decideApproval).toHaveBeenCalledWith('a1', 'once');
  });

  it('Always here and Deny send their decisions', async () => {
    en(<ApprovalCard approval={base} />);
    await userEvent.click(screen.getByRole('button', { name: 'Always here' }));
    expect(api.decideApproval).toHaveBeenLastCalledWith('a1', 'always');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true));
  });

  it('has no "Always here" without a proposed rule', () => {
    en(<ApprovalCard approval={{ ...base, alwaysRule: null }} />);
    expect(screen.queryByRole('button', { name: 'Always here' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
  });

  it('labels provider approvals Generate and shows their summary in plain view', () => {
    en(<ApprovalCard approval={{ ...base, kind: 'provider', toolName: 'provider:openai-images', alwaysRule: null, title: 'Generate an image', detail: 'gpt-image-2 · 1024×1024' }} />);
    expect(screen.getByRole('button', { name: 'Generate' })).toBeTruthy();
    expect(screen.getByText('gpt-image-2 · 1024×1024')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Show command/ })).toBeNull();
  });

  it('shows the context line and a live countdown', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-10-08T10:05:00.000Z'));
    en(<ApprovalCard approval={base} context="Acme · Launch" />);
    expect(screen.getByText('Acme · Launch')).toBeTruthy();
    expect(screen.getByRole('timer').getAttribute('aria-label')).toBe('5:00 left');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByRole('timer').getAttribute('aria-label')).toBe('4:58 left');
  });

  it('reports a request already handled', async () => {
    api.decideApproval.mockRejectedValueOnce(new ApiError(404, 'x'));
    en(<ApprovalCard approval={base} />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Request already handled'));
    expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders the detail as text, never as HTML', async () => {
    en(<ApprovalCard approval={{ ...base, detail: '<img src=x onerror=alert(1)>' }} />);
    await userEvent.click(screen.getByRole('button', { name: /Show command/ }));
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByLabelText('Full command').textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
