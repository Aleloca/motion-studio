import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createCreative = vi.fn(async (_slug: string, _body: unknown) => ({ slug: '2026-10-07-lancio', creative: {}, job: null }));
vi.mock('../src/api.ts', () => ({
  api: { getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })), createCreative },
  ApiError: class extends Error {},
}));
const { NewCreative } = await import('../src/screens/NewCreative.tsx');

beforeEach(() => { createCreative.mockClear(); location.hash = ''; });

describe('NewCreative', () => {
  it('updates the preview while picking formats and generates', async () => {
    render(<NewCreative slug="acme" />);
    await waitFor(() => screen.getByRole('group', { name: 'Instagram' }));
    const generate = screen.getByRole('button', { name: 'Genera' }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Cosa vuoi realizzare?'), 'Lancio della nuova app');
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: 'Post 1:1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Banner 300×250' }));
    expect(screen.getByText('Cosa riceverai · 2 formati')).toBeTruthy();
    expect(generate.disabled).toBe(false);
    await userEvent.click(generate);
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    expect(createCreative.mock.calls[0]).toEqual(['acme', {
      title: 'Lancio della nuova app',
      brief: { goal: 'Lancio della nuova app', message: '', formats: ['instagram-post-1x1', 'web-banner-300x250'], durationSec: 15, assets: [], notes: '' },
      generate: true,
    }]);
    expect(location.hash).toBe('#/p/acme/c/2026-10-07-lancio');
  });
  it('saves a draft with duration "Nessuna" and parsed assets', async () => {
    render(<NewCreative slug="acme" />);
    await waitFor(() => screen.getByRole('group', { name: 'Web' }));
    await userEvent.type(screen.getByLabelText('Cosa vuoi realizzare?'), 'Banner');
    await userEvent.click(screen.getByRole('button', { name: 'Banner 728×90' }));
    await userEvent.click(screen.getByRole('button', { name: 'Nessuna' }));
    await userEvent.type(screen.getByLabelText(/Asset da usare/), 'assets/logo.svg, assets/foto.jpg');
    await userEvent.click(screen.getByRole('button', { name: 'Salva bozza' }));
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    expect(createCreative.mock.calls[0]![1]).toMatchObject({ generate: false, brief: { durationSec: null, assets: ['assets/logo.svg', 'assets/foto.jpg'] } });
  });
});
