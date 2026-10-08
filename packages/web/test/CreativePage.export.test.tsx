import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { describe, expect, it, vi } from 'vitest';

const at = '2026-10-07T10:00:00.000Z';
const version = (n: number) => ({ n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null });
let versions: ReturnType<typeof version>[] = [version(1)];
const exportVersion = vi.fn(async (_s: string, _c: string, n: number, d: string) => ({ destination: d, files: [], skipped: [] as string[], n }));
vi.mock('../src/api.ts', () => ({
  api: {
    getFormats: async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' }),
    getCreative: async () => ({ slug: 'c1', jobKey: 'k', versions, creative: { schemaVersion: 1, title: 'T', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [], brief: { goal: 'g', message: '', formats: ['instagram-post-1x1'], durationSec: 6, assets: [], notes: '' } } }),
    getConversation: async () => [],
    fileUrl: () => '/f',
    exportVersion,
  },
  ApiError: class extends Error {},
}));
const { CreativePage } = await import('../src/screens/CreativePage.tsx');

describe('CreativePage export', () => {
  it('keeps the dialog on the version it was opened for when a new version arrives', async () => {
    versions = [version(1)];
    const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {} as Record<string, number>, projectTicks: {} as Record<string, number> };
    const { rerender } = render(<CreativePage slug="acme" creative="c1" live={live} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Esporta…' }));
    expect(screen.getByText('Esporta v1')).toBeTruthy();
    versions = [version(1), version(2)];
    await act(async () => { rerender(<CreativePage slug="acme" creative="c1" live={{ ...live, creativeTicks: { 'acme/c1': 1 } }} />); });
    await waitFor(() => expect(screen.getByRole('radio', { name: 'v2' }).getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByText('Esporta v1')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Cartella di destinazione (percorso assoluto)'), '/d');
    await userEvent.click(screen.getByRole('button', { name: 'Esporta' }));
    await waitFor(() => expect(exportVersion).toHaveBeenCalledWith('acme', 'c1', 1, '/d'));
  });
  it('disables Esporta… without a version', async () => {
    versions = [];
    const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} };
    render(<CreativePage slug="acme" creative="c1" live={live} />);
    expect((await screen.findByRole('button', { name: 'Esporta…' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
