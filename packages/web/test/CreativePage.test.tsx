import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';

let getFormats: () => Promise<unknown> = async () => ({});
let detail: Record<string, unknown> = {
  creative: { title: 'Lancio', status: 'draft', error: null, resumeFrom: null, linkedCodebases: [], brief: { goal: 'g', message: '', formats: ['instagram-post-1x1'], durationSec: 15, assets: [], notes: '' } },
  versions: [], jobKey: 'k',
};
vi.mock('../src/api.ts', () => ({
  api: { getFormats: () => getFormats(), getCreative: vi.fn(async () => detail), getConversation: vi.fn(async () => []), fileUrl: () => '' },
  ApiError: class extends Error {},
}));
const { CreativePage } = await import('../src/screens/CreativePage.tsx');
const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {} } as unknown as EventsState;


describe('CreativePage catalog loading', () => {
  it('shows an alert, not unknown presets, when the catalog fails to load', async () => {
    getFormats = () => Promise.reject(new Error('rete assente'));
    render(<CreativePage slug="acme" creative="c" live={live} />);
    expect((await screen.findByRole('alert')).textContent).toContain('rete assente');
    expect(screen.queryByText(/preset sconosciuto/)).toBeNull();
  });
  it('shows the catalog fallback error as a warning', async () => {
    getFormats = async () => ({ presets: DEFAULT_FORMATS, error: 'catalogo non valido', path: '/x' });
    render(<CreativePage slug="acme" creative="c" live={live} />);
    expect(await screen.findByText('catalogo non valido')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Instagram · Post 1:1 — apri')).toBeTruthy());
  });
});

describe('CreativePage version selection', () => {
  const v = (n: number) => ({ n, commit: 'c', sessionId: 's', status: 'complete', createdAt: '2026-10-07T10:00:00.000Z', request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null });
  const withVersions = (ns: number[]) => { detail = { ...detail, versions: ns.map(v) }; };
  const liveTick = (t: number) => ({ ...live, creativeTicks: { 'acme/c': t } }) as unknown as EventsState;
  const checked = () => screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.textContent);

  it('follows new versions until the user picks one, then keeps the pick', async () => {
    getFormats = async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' });
    withVersions([1]);
    const { rerender } = render(<CreativePage slug="acme" creative="c" live={liveTick(0)} />);
    await waitFor(() => expect(checked()).toEqual(['v1']));
    withVersions([1, 2, 3]); // two versions arrived between refreshes
    rerender(<CreativePage slug="acme" creative="c" live={liveTick(1)} />);
    await waitFor(() => expect(checked()).toEqual(['v3']));
    await userEvent.click(screen.getByRole('radio', { name: 'v3' })); // explicit pick, even of the latest
    withVersions([1, 2, 3, 4]);
    rerender(<CreativePage slug="acme" creative="c" live={liveTick(2)} />);
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(4));
    expect(checked()).toEqual(['v3']);
  });
});
