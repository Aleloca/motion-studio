import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/api.ts', () => ({
  api: {
    listCreatives: vi.fn(async () => [
      { ok: true, slug: 'c1', title: 'Lancio', status: 'ready', formats: ['a', 'b'], versions: 2, updatedAt: '2026-10-07T10:00:00.000Z', cover: 'outputs/v2/.previews/a.jpg' },
      { ok: true, slug: 'c2', title: 'Teaser', status: 'draft', formats: ['a'], versions: 0, updatedAt: '2026-10-06T10:00:00.000Z', cover: null },
      { ok: false, slug: 'c3', error: 'creative.json: JSON non valido' },
    ]),
    fileUrl: (s: string, c: string, rel: string) => `/files/${s}/${c}/${rel}`,
  },
  ApiError: class extends Error {},
}));
const { CreativeList } = await import('../src/screens/CreativeList.tsx');
const { api } = await import('../src/api.ts');

describe('CreativeList', () => {
  it('shows cards with status, counts and cover, and broken items', async () => {
    render(<CreativeList slug="acme" tick={0} />);
    await waitFor(() => expect(screen.getByText('Lancio')).toBeTruthy());
    expect(within(screen.getByRole('link', { name: /Lancio/ })).getByText('Pronta')).toBeTruthy();
    expect(screen.getByText('2 formati · 2 versioni')).toBeTruthy();
    expect((screen.getByAltText('Lancio') as HTMLImageElement).src).toContain('/files/acme/c1/outputs/v2/.previews/a.jpg');
    expect(screen.getByText(/JSON non valido/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '+ Nuova creatività' }).getAttribute('href')).toBe('#/p/acme/new');
  });
  it('filters by status', async () => {
    render(<CreativeList slug="acme" tick={0} />);
    await waitFor(() => screen.getByText('Lancio'));
    await userEvent.click(screen.getByRole('button', { name: 'Bozza' }));
    expect(screen.queryByText('Lancio')).toBeNull();
    expect(screen.getByText('Teaser')).toBeTruthy();
  });
  it('keeps unreadable creatives visible under any filter', async () => {
    render(<CreativeList slug="acme" tick={0} />);
    await waitFor(() => screen.getByText('Lancio'));
    await userEvent.click(screen.getByRole('button', { name: 'Bozza' }));
    expect(screen.getByText(/JSON non valido/)).toBeTruthy();
  });
  it('ignores a stale response that arrives after a newer one', async () => {
    let resolveOld!: (v: unknown) => void;
    vi.mocked(api.listCreatives)
      .mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }) as never)
      .mockImplementationOnce(async () => [{ ok: true, slug: 'n', title: 'Nuova', status: 'draft', formats: [], versions: 0, updatedAt: '2026-10-07T10:00:00.000Z', cover: null }]);
    const { rerender } = render(<CreativeList slug="acme" tick={0} />);
    rerender(<CreativeList slug="acme" tick={1} />);
    await waitFor(() => screen.getByText('Nuova'));
    resolveOld([{ ok: true, slug: 'o', title: 'Vecchia', status: 'draft', formats: [], versions: 0, updatedAt: '2026-10-07T10:00:00.000Z', cover: null }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('Vecchia')).toBeNull();
  });
});
