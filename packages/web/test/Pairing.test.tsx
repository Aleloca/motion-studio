import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { Pairing } from '../src/screens/Pairing.tsx';

const COMMAND = 'npx @motion-studio/cli --print-url';
const en = () => render(<I18nProvider locale="en"><Pairing /></I18nProvider>);
const setClipboard = (value: unknown) => Object.defineProperty(navigator, 'clipboard', { configurable: true, value });

afterEach(() => { vi.useRealTimers(); setClipboard(undefined); });

describe('Pairing page', () => {
  it('explains why and shows the --print-url command', () => {
    en();
    expect(screen.getByRole('heading', { name: 'Open Motion Studio from the link in your terminal' })).toBeTruthy();
    expect(screen.getByText(COMMAND)).toBeTruthy();
    // No desktop shortcut: the server does not say a desktop app is available.
    expect(screen.queryByRole('link', { name: /desktop/i })).toBeNull();
  });

  it('copies the command with Copy and confirms it', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    en();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy the command' })); });
    expect(writeText).toHaveBeenCalledWith(COMMAND);
    expect(screen.getByRole('button', { name: 'Copy the command' }).textContent).toContain('Copied');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByRole('button', { name: 'Copy the command' }).textContent).toContain('Copy');
    expect(screen.getByRole('button', { name: 'Copy the command' }).textContent).not.toContain('Copied');
  });

  it('selects the command and shows how to copy it when the clipboard is not available', async () => {
    setClipboard(undefined);
    en();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy the command' })); });
    expect(window.getSelection()?.toString()).toBe(COMMAND);
    expect(screen.getByRole('status').textContent).toMatch(/press (⌘C|Ctrl\+C)/);
  });

  it('falls back the same way when the clipboard refuses', async () => {
    setClipboard({ writeText: vi.fn(async () => { throw new Error('denied'); }) });
    en();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy the command' })); });
    expect(window.getSelection()?.toString()).toBe(COMMAND);
    expect(screen.getByRole('status').textContent).toMatch(/press/);
  });
});
