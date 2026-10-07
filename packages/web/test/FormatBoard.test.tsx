import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type VersionEntry } from '@motion-studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { FormatBoard } from '../src/components/FormatBoard.tsx';

const v1: VersionEntry = {
  n: 1, commit: 'c', sessionId: 's', status: 'incomplete', createdAt: '2026-10-07T10:00:00.000Z', request: 'r', problems: ['x'], tools: [], renderCommand: null, basedOn: null,
  outputs: [{ format: 'instagram-post-1x1', file: 'instagram-post-1x1.mp4', width: 1080, height: 1080, durationSec: 10, verified: true, preview: '.previews/instagram-post-1x1.jpg' }],
};
const url = (n: number, f: string) => `/f/v${n}/${f}`;

describe('FormatBoard', () => {
  it('renders outputs, missing placeholders, unknown presets and pins', async () => {
    const onOpen = vi.fn();
    render(<FormatBoard presets={DEFAULT_FORMATS} formats={['instagram-post-1x1', 'web-banner-300x250', 'ghost']} version={v1} compare={null}
      fileUrl={url} pins={[{ format: 'instagram-post-1x1', x: 0.5, y: 0.5, timeSec: 2 }]} showSafeZone={false} onOpen={onOpen} />);
    expect(screen.getByLabelText('Instagram · Post 1:1 v1')).toBeTruthy();
    expect(screen.getByText('Mancante in v1')).toBeTruthy();
    expect(screen.getByText('ghost: preset sconosciuto')).toBeTruthy();
    expect(screen.getByLabelText('Commento 1')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Web · Banner 300×250/ }));
    expect(onOpen).toHaveBeenCalledWith('web-banner-300x250');
  });
  it('shows a waiting placeholder without versions and two frames when comparing', () => {
    const { rerender } = render(<FormatBoard presets={DEFAULT_FORMATS} formats={['instagram-post-1x1']} version={null} compare={null} fileUrl={url} pins={[]} showSafeZone={false} onOpen={() => {}} />);
    expect(screen.getByText('In attesa')).toBeTruthy();
    rerender(<FormatBoard presets={DEFAULT_FORMATS} formats={['instagram-post-1x1']} version={{ ...v1, n: 2 }} compare={v1} fileUrl={url} pins={[]} showSafeZone={false} onOpen={() => {}} />);
    expect(screen.getByLabelText('Instagram · Post 1:1 v1')).toBeTruthy();
    expect(screen.getByLabelText('Instagram · Post 1:1 v2')).toBeTruthy();
  });
});
