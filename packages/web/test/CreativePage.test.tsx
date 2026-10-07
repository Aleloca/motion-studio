import { render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';

let getFormats: () => Promise<unknown> = async () => ({});
const detail = {
  creative: { title: 'Lancio', status: 'draft', error: null, resumeFrom: null, brief: { goal: 'g', message: '', formats: ['instagram-post-1x1'], durationSec: 15, assets: [], notes: '' } },
  versions: [], jobKey: 'k',
};
vi.mock('../src/api.ts', () => ({
  api: { getFormats: () => getFormats(), getCreative: vi.fn(async () => detail), getConversation: vi.fn(async () => []), fileUrl: () => '' },
  ApiError: class extends Error {},
}));
const { CreativePage } = await import('../src/screens/CreativePage.tsx');
const live = { jobs: {}, events: {}, creativeTicks: {} } as unknown as EventsState;


describe('CreativePage catalog loading', () => {
  it('shows an alert, not unknown presets, when the catalog fails to load', async () => {
    getFormats = () => Promise.reject(new Error('rete assente'));
    render(<CreativePage slug="acme" creative="c" live={live} expert={false} />);
    expect((await screen.findByRole('alert')).textContent).toContain('rete assente');
    expect(screen.queryByText(/preset sconosciuto/)).toBeNull();
  });
  it('shows the catalog fallback error as a warning', async () => {
    getFormats = async () => ({ presets: DEFAULT_FORMATS, error: 'catalogo non valido', path: '/x' });
    render(<CreativePage slug="acme" creative="c" live={live} expert={false} />);
    expect(await screen.findByText('catalogo non valido')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Instagram · Post 1:1 — apri')).toBeTruthy());
  });
});
