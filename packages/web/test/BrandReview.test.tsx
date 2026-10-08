import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EMPTY_BRAND_KIT, type BrandKit, type BrandProposal } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { __resetToasts, getToasts } from '../src/ui/toast.tsx';

const api = {
  applyProposal: vi.fn(async () => ({})),
  discardProposal: vi.fn(async () => ({})),
  saveBrandKit: vi.fn(async (_s: string, k: BrandKit) => k),
  saveGuidelines: vi.fn(async () => ({ ok: true })),
  projectFileUrl: (s: string, r: string) => `/f/${s}/${r}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { BrandReview } = await import('../src/screens/BrandReview.tsx');

const site = { kind: 'website' as const, ref: 'https://acme.example' };
const kit: BrandKit = { ...EMPTY_BRAND_KIT, colors: [{ id: 'ink', name: 'Ink black', hex: '#1B1913', role: 'background', source: site }] };
const proposal: BrandProposal = {
  schemaVersion: 1, id: 'p-1', createdAt: '2026-10-08T10:00:00.000Z', sourceIds: ['s-1'], status: 'open', summary: 'Noir palette.',
  assetsAdded: ['assets/logo-dark.svg'], guidelines: { current: '', proposed: '# Acme\n\nA **detective** game.' },
  changes: [
    { id: 'colors:add:rain', field: 'colors', op: 'add', itemId: 'rain', before: null, after: { id: 'rain', name: 'Rain grey', hex: '#6E6A62', role: 'secondary', source: site } },
    { id: 'colors:add:lamp', field: 'colors', op: 'add', itemId: 'lamp', before: null, after: { id: 'lamp', name: 'Lamp amber', hex: '#C8873A', role: 'accent', source: site } },
    { id: 'fonts:add:se', field: 'fonts', op: 'add', itemId: 'se', before: null, after: { id: 'se', family: 'Special Elite', role: 'accent', weights: [400], file: null, source: site } },
    { id: 'logos:add:dark', field: 'logos', op: 'add', itemId: 'dark', before: null, after: { id: 'dark', file: 'assets/logo-dark.svg', variant: 'primary', background: 'light', source: site } },
    { id: 'dos:add:d1', field: 'dos', op: 'add', itemId: 'd1', before: null, after: { id: 'd1', text: 'Show the case number.', source: site } },
  ],
};
const sources = [{ id: 's-1', kind: 'website' as const, url: 'https://acme.example', file: null, addedAt: '2026-10-07T10:00:00.000Z', lastAnalyzedAt: null }];
const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);
const sheet = (over: Partial<React.ComponentProps<typeof BrandReview>> = {}) => {
  const props = { open: true, slug: 'acme', proposal, kit, guidelines: 'Old rules', sources, onClose: vi.fn(), onChanged: vi.fn(), ...over };
  return { props, view: en(<BrandReview {...props} />) };
};

beforeEach(() => { __resetToasts(); });
afterEach(() => { vi.clearAllMocks(); __resetToasts(); });

describe('BrandReview', () => {
  it('shows real visual previews: swatches, a font specimen and logo images', () => {
    sheet();
    const dialog = screen.getByRole('dialog', { name: 'Review brand suggestions' });
    expect(within(dialog).getByText("Here's what Claude learned from acme.example")).toBeTruthy();
    expect(within(dialog).getByText('Rain grey')).toBeTruthy();
    expect(within(dialog).getByTestId('swatch-rain').style.background).toBe('rgb(110, 106, 98)');
    expect(within(dialog).getByText('Special Elite')).toBeTruthy();
    expect(within(dialog).getByText('Preview in a system font: the font file was not downloaded')).toBeTruthy();
    expect((within(dialog).getByRole('img', { name: 'Logo assets/logo-dark.svg' }) as HTMLImageElement).getAttribute('src')).toBe('/f/acme/assets/logo-dark.svg');
    // The guidelines are rendered, not raw Markdown.
    expect(within(dialog).getByRole('heading', { name: 'Acme' })).toBeTruthy();
    expect(within(dialog).getByText('Also added to Assets: 1 file')).toBeTruthy();
  });

  it('deselecting a group applies only the remaining ids', async () => {
    const { props } = sheet();
    const nav = screen.getByRole('navigation', { name: 'Suggestion groups' });
    expect(within(nav).getByRole('button', { name: /Colors.*2\/2/ })).toBeTruthy();
    const colors = screen.getByRole('region', { name: 'Colors' });
    await userEvent.click(within(colors).getByRole('button', { name: 'Deselect all' }));
    expect(within(nav).getByRole('button', { name: /Colors.*0\/2/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Keep Special Elite' }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply 3 of 6' }));
    await waitFor(() => expect(api.applyProposal).toHaveBeenCalledWith('acme', 'p-1', ['logos:add:dark', 'dos:add:d1'], true));
    expect(props.onClose).toHaveBeenCalled();
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('Undo after applying restores the previous kit and guidelines', async () => {
    sheet();
    await userEvent.click(screen.getByRole('button', { name: 'Apply 6 of 6' }));
    await waitFor(() => expect(api.applyProposal).toHaveBeenCalled());
    const t = getToasts().find((x) => x.text === 'Applied 6 suggestions to the brand');
    expect(t?.action?.label).toBe('Undo');
    await act(async () => { t!.action!.run(); });
    await waitFor(() => expect(api.saveBrandKit).toHaveBeenCalledWith('acme', kit));
    expect(api.saveGuidelines).toHaveBeenCalledWith('acme', 'Old rules');
  });

  it('Discard all discards the proposal', async () => {
    const { props } = sheet();
    await userEvent.click(screen.getByRole('button', { name: 'Discard all' }));
    await waitFor(() => expect(api.discardProposal).toHaveBeenCalledWith('acme', 'p-1'));
    expect(props.onClose).toHaveBeenCalled();
    expect(getToasts().some((x) => x.text === 'Suggestions discarded')).toBe(true);
  });

  it('selects a single item and a whole group back', async () => {
    sheet();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Keep Rain grey' }));
    expect(screen.getByRole('button', { name: 'Apply 5 of 6' })).toBeTruthy();
    const colors = screen.getByRole('region', { name: 'Colors' });
    await userEvent.click(within(colors).getByRole('button', { name: 'Select all' }));
    expect(screen.getByRole('button', { name: 'Apply 6 of 6' })).toBeTruthy();
  });
});
