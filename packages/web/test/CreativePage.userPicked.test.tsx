import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { describe, expect, it, vi } from 'vitest';

const at = '2026-10-07T10:00:00.000Z';
const version = (n: number) => ({ n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null });
let versions = [version(1), version(2)];
vi.mock('../src/api.ts', () => ({
  api: {
    getFormats: async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' }),
    getCreative: async () => ({ slug: 'c1', jobKey: 'k', versions, creative: { schemaVersion: 1, title: 'T', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [], brief: { goal: 'g', message: '', formats: ['instagram-post-1x1'], durationSec: 6, assets: [], notes: '' } } }),
    getConversation: async () => [],
    sendCreativeTurn: vi.fn(async () => ({})),
    fileUrl: () => '/f',
  },
  ApiError: class extends Error {},
}));
const { CreativePage } = await import('../src/screens/CreativePage.tsx');

describe('CreativePage version selection', () => {
  it('follows new versions again after the user sends a message', async () => {
    const live = { jobs: {}, events: {}, creativeTicks: {} as Record<string, number> };
    const { rerender } = render(<CreativePage slug="acme" creative="c1" live={live} expert={false} />);
    await waitFor(() => screen.getByRole('radio', { name: 'v2' }));
    await userEvent.click(screen.getByRole('radio', { name: 'v1' }));
    await userEvent.type(screen.getByLabelText('Chiedi una modifica'), 'ciao');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    versions = [version(1), version(2), version(3)];
    await act(async () => { rerender(<CreativePage slug="acme" creative="c1" live={{ ...live, creativeTicks: { 'acme/c1': 1 } }} expert={false} />); });
    await waitFor(() => expect(screen.getByRole('radio', { name: 'v3' }).getAttribute('aria-checked')).toBe('true'));
  });
});
