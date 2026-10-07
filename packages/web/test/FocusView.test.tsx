import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { FocusView } from '../src/components/FocusView.tsx';

const banner = DEFAULT_FORMATS.find((f) => f.id === 'web-banner-300x250')!;

describe('FocusView', () => {
  it('adds a pin where the user clicks, then leaves comment mode', async () => {
    const onAddPin = vi.fn();
    render(<FocusView preset={banner} src="/f/banner.png" compareSrc={null} versionN={1} compareN={null} pins={[]} onAddPin={onAddPin} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi commento' }));
    const overlay = screen.getByLabelText('Clicca sul punto da commentare');
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(overlay, { clientX: 50, clientY: 25 });
    expect(onAddPin).toHaveBeenCalledWith({ format: 'web-banner-300x250', x: 0.25, y: 0.25, timeSec: null });
    expect(screen.queryByLabelText('Clicca sul punto da commentare')).toBeNull();
  });
  it('closes with Escape', () => {
    const onClose = vi.fn();
    render(<FocusView preset={banner} src={null} compareSrc={null} versionN={null} compareN={null} pins={[]} onAddPin={() => {}} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
  it('keeps the preset ratio for tall presets and numbers markers by global index', () => {
    const story = DEFAULT_FORMATS.find((f) => f.height > f.width * 1.5)!;
    render(<FocusView preset={story} src="/f/s.png" compareSrc={null} versionN={1} compareN={null} pins={[{ format: story.id, x: 0.1, y: 0.1, timeSec: null }]} pinNumbers={[3]} onAddPin={() => {}} onClose={() => {}} />);
    const frame = screen.getByTestId('focus-frame');
    expect(frame.style.maxHeight).toBe('');
    expect(frame.style.aspectRatio.replace(/\s/g, '')).toBe(`${story.width}/${story.height}`);
    expect(frame.style.width).toBe(`min(100%, ${(70 * story.width) / story.height}vh)`);
    expect(screen.getByLabelText('Commento 3')).toBeTruthy();
  });
  it('shows "non verificato" in the header for unverified outputs', () => {
    const { rerender } = render(<FocusView preset={banner} src="/f/b.png" compareSrc={null} versionN={1} compareN={null} pins={[]} onAddPin={() => {}} onClose={() => {}} />);
    expect(screen.queryByText('non verificato')).toBeNull();
    rerender(<FocusView preset={banner} src="/f/b.png" compareSrc={null} versionN={1} compareN={null} verified={false} pins={[]} onAddPin={() => {}} onClose={() => {}} />);
    expect(screen.getByText('non verificato')).toBeTruthy();
  });
  it('traps Tab inside the dialog and gives focus back to the opener on close', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'apri';
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<FocusView preset={banner} src="/f/b.png" compareSrc={null} versionN={1} compareN={null} pins={[]} onAddPin={() => {}} onClose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    const add = screen.getByRole('button', { name: 'Aggiungi commento' });
    const close = screen.getByRole('button', { name: 'Chiudi' });
    await userEvent.tab();
    expect(document.activeElement).toBe(add);
    await userEvent.tab();
    expect(document.activeElement).toBe(close);
    await userEvent.tab();
    expect(document.activeElement).toBe(add);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(close);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
