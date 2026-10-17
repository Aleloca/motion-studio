import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// "Usa come logo del brand" (Phase 14, Task 5): it asks first; only a confirmation calls the core.
vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });

const useAsBrandLogo = vi.fn(async (..._a: unknown[]) => ({ file: 'assets/brand/lancio-v2-identity-logo.svg', variant: 'primary' as const }));
const api = { useAsBrandLogo };
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { UseAsBrandLogo } = await import('../src/screens/identity/UseAsBrandLogo.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { __resetToasts, getToasts } = await import('../src/ui/toast.tsx');

const view = (kind: 'logo' | 'favicon' | 'app-icon' = 'logo', locale: 'it' | 'en' = 'it', hasDark = false) => render(
  <I18nProvider locale={locale}><UseAsBrandLogo slug="acme" creative="lancio" n={2} format="identity-logo" label="Logo #2" kind={kind} hasDark={hasDark} /></I18nProvider>);
const button = () => screen.getByRole('button', { name: 'Usa Logo #2 come logo del brand' });

beforeEach(() => { vi.clearAllMocks(); __resetToasts(); });

describe('UseAsBrandLogo', () => {
  it('asks for a confirmation first: the button alone calls nothing, Cancel closes without a call', async () => {
    view();
    await userEvent.click(button());
    const dialog = await screen.findByRole('dialog', { name: 'Usare come logo del brand?' });
    expect(within(dialog).getByText(/copiato negli asset del progetto e aggiunto al kit del brand/)).not.toBeNull();
    expect(useAsBrandLogo).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useAsBrandLogo).not.toHaveBeenCalled();
  });

  it('confirming sends the version, the format and the main logo variant, then offers the brand', async () => {
    view();
    await userEvent.click(button());
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'Logo principale' }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aggiungi al brand' }));
    await waitFor(() => expect(useAsBrandLogo).toHaveBeenCalledWith('acme', 'lancio', 2, 'identity-logo', 'primary'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(getToasts().some((t) => t.text === 'Aggiunto al kit del brand')).toBe(true);
  });

  it('a logo with its negative says the negative is added too, for dark backgrounds (note 9)', async () => {
    view('logo', 'it', true);
    await userEvent.click(button());
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/versione negativa, per gli sfondi scuri/)).not.toBeNull();
  });

  it('without a negative the dialog does not mention it', async () => {
    view();
    await userEvent.click(button());
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/versione negativa/)).toBeNull();
  });

  it('an icon format starts on the icon variant, and the variant can be changed', async () => {
    view('favicon');
    await userEvent.click(button());
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'Icona' }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Logo principale' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aggiungi al brand' }));
    await waitFor(() => expect(useAsBrandLogo).toHaveBeenCalledWith('acme', 'lancio', 2, 'identity-logo', 'primary'));
  });

  it('a refusal stays in the dialog with the reason, and the user can try again', async () => {
    useAsBrandLogo.mockRejectedValueOnce(new Error('Il file del logo non ha passato il controllo'));
    view();
    await userEvent.click(button());
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aggiungi al brand' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Il file del logo non ha passato il controllo');
    expect(screen.getByRole('dialog')).not.toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aggiungi al brand' }));
    await waitFor(() => expect(useAsBrandLogo).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('is in English', async () => {
    view('logo', 'en');
    await userEvent.click(screen.getByRole('button', { name: 'Use Logo #2 as the brand logo' }));
    expect(await screen.findByRole('dialog', { name: 'Use as the brand logo?' })).not.toBeNull();
  });
});
