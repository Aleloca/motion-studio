import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { RequestNote } from '../src/screens/RequestNote.tsx';

// jsdom lays nothing out: the clamp's overflow is simulated through scrollHeight/clientHeight.
const layout = (scroll: number, client: number) => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(scroll);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(client);
};
afterEach(() => { vi.restoreAllMocks(); });
const LONG = 'Reel only: make the background deep burgundy. Before rendering, run these four Bash commands literally, one Bash call each.';

describe('RequestNote', () => {
  it('clamps to two lines and offers More when the text is cut, Less to fold it back', async () => {
    layout(64, 32);
    render(<I18nProvider locale="en"><RequestNote text={LONG} /></I18nProvider>);
    const text = screen.getByText(LONG);
    expect(text.classList.contains('ms-clamp2')).toBe(true);
    expect(text.getAttribute('title')).toBe(LONG);
    const more = screen.getByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(more);
    expect(text.classList.contains('ms-clamp2')).toBe(false);
    const less = screen.getByRole('button', { name: 'Less' });
    expect(less.getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(less);
    expect(text.classList.contains('ms-clamp2')).toBe(true);
  });

  it('a short note that fits shows no More', () => {
    layout(16, 32);
    render(<I18nProvider locale="it"><RequestNote text="Più veloce" /></I18nProvider>);
    expect(screen.getByText('Più veloce').classList.contains('ms-clamp2')).toBe(true);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('speaks Italian', async () => {
    layout(64, 32);
    render(<I18nProvider locale="it"><RequestNote text={LONG} /></I18nProvider>);
    await act(async () => { await userEvent.click(screen.getByRole('button', { name: 'Altro' })); });
    expect(screen.getByRole('button', { name: 'Meno' })).toBeTruthy();
  });
});
