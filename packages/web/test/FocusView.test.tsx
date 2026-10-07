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
});
