import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { Button, Modal, Tooltip } from '../src/ui/index.ts';

describe('Tooltip', () => {
  const setup = () => render(<Tooltip label="Send"><Button aria-label="Send">x</Button></Tooltip>);
  it('shows on hover, wires aria-describedby, hides on leave', () => {
    setup();
    const b = screen.getByRole('button');
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(b);
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('Send');
    expect(b.getAttribute('aria-describedby')).toBe(tip.id);
    fireEvent.mouseLeave(b);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(b.hasAttribute('aria-describedby')).toBe(false);
  });
  it('shows on keyboard focus and hides on blur and Escape', () => {
    setup();
    const b = screen.getByRole('button');
    act(() => b.focus());
    expect(screen.getByRole('tooltip')).toBeTruthy();
    act(() => b.blur());
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => b.focus());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
  it('does not show while the visible text is still rendered', () => {
    render(<Tooltip label="Send" whenHidden=".txt"><Button aria-label="Send"><span className="txt">Send</span></Button></Tooltip>);
    const b = screen.getByRole('button');
    fireEvent.mouseEnter(b);
    expect(screen.queryByRole('tooltip')).toBeNull();
    (b.querySelector('.txt') as HTMLElement).style.display = 'none';
    fireEvent.mouseLeave(b);
    fireEvent.mouseEnter(b);
    expect(screen.getByRole('tooltip')).toBeTruthy();
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
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(b, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
