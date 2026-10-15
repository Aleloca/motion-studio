import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { Button, Modal, Tooltip } from '../src/ui/index.ts';

const bubble = () => document.querySelector<HTMLElement>('.ms-tooltip');
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Tooltip', () => {
  const setup = () => render(<Tooltip label="Send"><Button aria-label="Send">x</Button></Tooltip>);
  it('the bubble shows on hover and hides on leave; a label equal to the name adds no description (M4)', () => {
    vi.useFakeTimers();
    setup();
    const b = screen.getByRole('button');
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(b.hasAttribute('aria-describedby')).toBe(false);
    expect(bubble()).toBeNull();
    fireEvent.mouseEnter(b);
    expect(bubble()?.textContent).toBe('Send');
    expect(bubble()!.getAttribute('aria-hidden')).toBe('true');
    fireEvent.mouseLeave(b);
    expect(bubble()).not.toBeNull(); // grace period
    act(() => { vi.advanceTimersByTime(200); });
    expect(bubble()).toBeNull();
  });
  it('a label that says more than the name is a static .ms-sr description wired by aria-describedby', () => {
    render(<Tooltip label="Send · now"><Button aria-label="Send">x</Button></Tooltip>);
    const b = screen.getByRole('button');
    const desc = screen.getByRole('tooltip');
    expect(desc.textContent).toBe('Send · now');
    expect(desc.className).toBe('ms-sr');
    expect(b.getAttribute('aria-describedby')).toBe(desc.id);
  });
  it('I3: a disabled or loading trigger keeps the hint as a native title while folded; enabled it has none', () => {
    const { rerender } = render(<Tooltip label="Send"><Button aria-label="Send" disabled>x</Button></Tooltip>);
    expect(screen.getByRole('button').getAttribute('title')).toBe('Send');
    rerender(<Tooltip label="Send"><Button aria-label="Send" loading>x</Button></Tooltip>);
    expect(screen.getByRole('button').getAttribute('title')).toBe('Send');
    rerender(<Tooltip label="Send"><Button aria-label="Send">x</Button></Tooltip>);
    expect(screen.getByRole('button').hasAttribute('title')).toBe(false);
  });
  it('I3: a disabled trigger whose word is visible gets no title', () => {
    render(<Tooltip label="Send" whenHidden=".txt"><Button aria-label="Send" disabled><span className="txt">Send</span></Button></Tooltip>);
    expect(screen.getByRole('button').hasAttribute('title')).toBe(false);
  });
  it('M6: a hint after the name shows, and is described, even while the word is visible', () => {
    render(<Tooltip label="Duplicate · copies this format" whenHidden=".txt"><Button aria-label="Duplicate"><span className="txt">Duplicate</span></Button></Tooltip>);
    const b = screen.getByRole('button', { name: 'Duplicate' });
    expect(b.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id);
    fireEvent.mouseEnter(b);
    expect(bubble()?.textContent).toBe('Duplicate · copies this format');
  });
  it('M11: no bubble while the trigger has its popover open, and an open popover hides it', () => {
    const { rerender } = render(<Tooltip label="Services"><Button aria-label="Services" aria-expanded={false}>x</Button></Tooltip>);
    const b = screen.getByRole('button');
    fireEvent.mouseEnter(b);
    expect(bubble()).not.toBeNull();
    rerender(<Tooltip label="Services"><Button aria-label="Services" aria-expanded={true}>x</Button></Tooltip>);
    expect(bubble()).toBeNull();
    fireEvent.mouseEnter(b);
    expect(bubble()).toBeNull();
  });
  it('is hoverable: the pointer can move onto the bubble, and leaving both hides it', () => {
    vi.useFakeTimers();
    setup();
    const b = screen.getByRole('button');
    fireEvent.mouseEnter(b);
    fireEvent.mouseLeave(b);
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.mouseEnter(bubble()!);
    act(() => { vi.advanceTimersByTime(500); });
    expect(bubble()).not.toBeNull();
    fireEvent.mouseLeave(bubble()!);
    act(() => { vi.advanceTimersByTime(200); });
    expect(bubble()).toBeNull();
  });
  it('shows on keyboard focus and hides at once on blur and Escape', () => {
    setup();
    const b = screen.getByRole('button');
    act(() => b.focus());
    expect(bubble()).not.toBeNull();
    act(() => b.blur());
    expect(bubble()).toBeNull();
    act(() => b.focus());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(bubble()).toBeNull();
  });
  it('shows no bubble and no description while the visible text is rendered, and hides if the label unfolds', () => {
    let fire: () => void = () => {};
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { fire = cb; } observe() {} disconnect() {} });
    render(<Tooltip label="Send" whenHidden=".txt"><Button aria-label="Send"><span className="txt">Send</span></Button></Tooltip>);
    const b = screen.getByRole('button');
    const txt = b.querySelector<HTMLElement>('.txt')!;
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(b.hasAttribute('aria-describedby')).toBe(false);
    fireEvent.mouseEnter(b);
    expect(bubble()).toBeNull();
    txt.style.display = 'none';
    act(() => fire());
    expect(screen.queryByRole('tooltip')).toBeNull(); // the label equals the name: nothing to describe (M4)
    fireEvent.mouseEnter(b);
    expect(bubble()).not.toBeNull();
    txt.style.display = '';
    act(() => fire());
    expect(bubble()).toBeNull();
    expect(b.hasAttribute('aria-describedby')).toBe(false);
  });
  it('a composite text starts with the accessible name', () => {
    render(<Tooltip label="Duplicate · copies this format"><Button aria-label="Duplicate">x</Button></Tooltip>);
    const b = screen.getByRole('button', { name: 'Duplicate' });
    expect(screen.getByRole('tooltip').textContent!.startsWith(b.getAttribute('aria-label')!)).toBe(true);
  });
  it('keeps the trigger own handlers', () => {
    const onClick = vi.fn(); const onFocus = vi.fn();
    render(<Tooltip label="Go"><Button onClick={onClick} onFocus={onFocus}>x</Button></Tooltip>);
    const b = screen.getByRole('button');
    fireEvent.click(b); act(() => b.focus());
    expect(onClick).toHaveBeenCalled(); expect(onFocus).toHaveBeenCalled();
  });
  it('Escape with a tooltip open inside a dialog still closes the dialog', async () => {
    function Demo() {
      const [open, setOpen] = useState(true);
      return <Modal open={open} onClose={() => setOpen(false)} label="Dlg"><Tooltip label="Hint"><Button>Inner</Button></Tooltip></Modal>;
    }
    render(<I18nProvider locale="en"><Demo /></I18nProvider>);
    const b = screen.getByRole('button', { name: 'Inner' });
    fireEvent.mouseEnter(b);
    expect(bubble()).not.toBeNull();
    fireEvent.keyDown(b, { key: 'Escape' });
    expect(bubble()).toBeNull();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  describe('placement', () => {
    const rect = (r: Partial<DOMRect>) => vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return (this.classList.contains('ms-tooltip') ? { left: 0, top: 0, width: 100, height: 24 } : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, ...r }) as DOMRect;
    });
    const sizes = () => {
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(24);
    };
    afterEach(() => vi.restoreAllMocks());
    it('sits above the trigger, centred', () => {
      sizes(); rect({ left: 400, top: 300, right: 428, bottom: 328, width: 28, height: 28 });
      setup();
      fireEvent.mouseEnter(screen.getByRole('button'));
      expect(bubble()!.style.left).toBe('364px'); // 414 - 50
      expect(bubble()!.style.top).toBe('270px'); // 300 - 6 - 24
    });
    it('flips below when there is no room above, and clamps to the viewport edge', () => {
      sizes(); rect({ left: 0, top: 10, right: 28, bottom: 38, width: 28, height: 28 });
      setup();
      fireEvent.mouseEnter(screen.getByRole('button'));
      expect(bubble()!.style.left).toBe('8px');
      expect(bubble()!.style.top).toBe('44px'); // 38 + 6
    });
    it('clamps against the right edge', () => {
      sizes(); rect({ left: window.innerWidth - 20, top: 300, right: window.innerWidth, bottom: 328, width: 20, height: 28 });
      setup();
      fireEvent.mouseEnter(screen.getByRole('button'));
      expect(bubble()!.style.left).toBe(`${window.innerWidth - 100 - 8}px`);
    });
  });
});
