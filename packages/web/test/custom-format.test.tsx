import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { customPreset, DEFAULT_FORMATS, EMPTY_BRAND_KIT, type CustomFormatInput, type FormatPreset } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

// Report 59: the "Personalizzati" group of New creative and its dialog.
let presets: FormatPreset[] = [];
let used = 0;
const state = () => ({ presets, error: null, path: '/x' });
const createCreative = vi.fn(async (_slug: string, _body: unknown) => ({ slug: 'c', creative: {}, job: null }));
const api = {
  getBriefSession: vi.fn(async () => null),
  getFormats: vi.fn(async () => state()),
  listAssets: vi.fn(async () => ({ assets: [], error: null, unregistered: [] })),
  getBrand: vi.fn(async () => ({ kit: EMPTY_BRAND_KIT, kitError: null, guidelines: '', sources: [], sourcesError: null, proposals: [], jobKey: 'k' })),
  projectFileUrl: (s: string, rel: string) => `/files/${s}/${rel}`,
  createCreative,
  getFirstGenerations: vi.fn(async () => ({ tokens: [] })),
  getSecrets: vi.fn(async () => []),
  addCustomFormat: vi.fn(async (body: CustomFormatInput) => {
    const p = customPreset(body, `custom-${body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
    presets = [...presets, p];
    return { preset: p, catalog: state() };
  }),
  editCustomFormat: vi.fn(async (id: string, body: CustomFormatInput) => {
    const p = customPreset(body, id);
    presets = presets.map((x) => (x.id === id ? p : x));
    return { preset: p, catalog: state() };
  }),
  deleteCustomFormat: vi.fn(async (id: string) => {
    if (used > 0) { presets = presets.map((x) => (x.id === id ? { ...x, hidden: true as const } : x)); return { outcome: 'hidden' as const, catalog: state() }; }
    presets = presets.filter((x) => x.id !== id);
    return { outcome: 'deleted' as const, catalog: state() };
  }),
  customFormatUsage: vi.fn(async () => ({ creatives: used })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { NewCreative } = await import('../src/screens/NewCreative.tsx');
const { customDraftProblems, heightFor } = await import('../src/screens/new-creative/CustomFormatDialog.tsx');

beforeEach(() => { vi.clearAllMocks(); presets = [...DEFAULT_FORMATS]; used = 0; location.hash = ''; });

const view = () => render(<I18nProvider locale="it"><NewCreative slug="acme" /></I18nProvider>);
const group = () => screen.getByRole('group', { name: 'Personalizzati' });
const openNew = async () => {
  await waitFor(() => group());
  await userEvent.click(within(group()).getByRole('button', { name: 'Nuovo formato personalizzato' }));
  return screen.findByRole('dialog', { name: 'Nuovo formato personalizzato' });
};

describe('NewCreative · custom formats (report 59)', () => {
  it('has a "Personalizzati" group with the "Personalizzato" tile, even with no custom format yet', async () => {
    view();
    await waitFor(() => group());
    expect(within(group()).getByRole('button', { name: 'Nuovo formato personalizzato' }).textContent).toContain('Personalizzato');
  });

  it('the dialog opens with focus on the name; Esc and Annulla close it without saving', async () => {
    view();
    const dialog = await openNew();
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Nome'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(within(group()).getByRole('button', { name: 'Nuovo formato personalizzato' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.addCustomFormat).not.toHaveBeenCalled();
  });

  it('create: the new format lands in Personalizzati, chosen, and goes into the brief like any format', async () => {
    view();
    const dialog = await openNew();
    await userEvent.type(within(dialog).getByLabelText('Nome'), 'Totem');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Video' }));
    const w = within(dialog).getByLabelText('Larghezza');
    await userEvent.clear(w); await userEvent.type(w, '1080');
    await userEvent.click(within(dialog).getByRole('button', { name: '9:16' }));
    expect((within(dialog).getByLabelText('Altezza') as HTMLInputElement).value).toBe('1920');
    expect(within(dialog).getByRole('button', { name: '9:16' }).getAttribute('aria-pressed')).toBe('true');
    await userEvent.type(within(dialog).getByLabelText('Durata massima'), '30');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crea formato' }));
    expect(api.addCustomFormat).toHaveBeenCalledWith({ name: 'Totem', kind: 'video', width: 1080, height: 1920, maxDurationSec: 30 });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const tile = within(group()).getByRole('button', { name: /Totem/, pressed: true });
    expect(tile.textContent).toContain('9:16');
    // The copies counter of report 58 works on it.
    await userEvent.click(within(group()).getByRole('button', { name: 'Una copia in più' }));
    await userEvent.type(screen.getByLabelText('Cosa vuoi realizzare?'), 'Lancio');
    await userEvent.click(screen.getByRole('button', { name: 'Genera' }));
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    expect((createCreative.mock.calls[0]![1] as { brief: { formats: string[] } }).brief.formats).toEqual(['custom-totem', 'custom-totem@2']);
  });

  it('validation: says what is wrong, beside the field, and focuses the first one; nothing is sent', async () => {
    view();
    const dialog = await openNew();
    const w = within(dialog).getByLabelText('Larghezza');
    await userEvent.clear(w); await userEvent.type(w, '9');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crea formato' }));
    expect(api.addCustomFormat).not.toHaveBeenCalled();
    const name = within(dialog).getByLabelText('Nome');
    expect(document.activeElement).toBe(name);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(within(dialog).getAllByRole('alert').map((a) => a.textContent)).toEqual(['Dai un nome al formato', 'Un numero intero da 16 a 8192']);
    expect(w.getAttribute('aria-describedby')).toContain('ms-cfd-size-err');
    // Typing a name clears its message only.
    await userEvent.type(name, 'A');
    expect(within(dialog).getAllByRole('alert').map((a) => a.textContent)).toEqual(['Un numero intero da 16 a 8192']);
  });

  it('edit: the tile has an edit button; a format in use keeps type and size', async () => {
    presets = [...DEFAULT_FORMATS, customPreset({ name: 'Totem', kind: 'video', width: 1080, height: 1920 }, 'custom-totem')];
    used = 2;
    view();
    await waitFor(() => group());
    await userEvent.click(within(group()).getByRole('button', { name: 'Modifica Personalizzati · Totem' }));
    const dialog = await screen.findByRole('dialog', { name: 'Modifica formato personalizzato' });
    await waitFor(() => expect(within(dialog).getByText(/2 creatività usano questo formato/)).toBeTruthy());
    expect((within(dialog).getByLabelText('Larghezza') as HTMLInputElement).disabled).toBe(true);
    const name = within(dialog).getByLabelText('Nome');
    await userEvent.clear(name); await userEvent.type(name, 'Totem grande');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salva' }));
    expect(api.editCustomFormat).toHaveBeenCalledWith('custom-totem', { name: 'Totem grande', kind: 'video', width: 1080, height: 1920 });
    await waitFor(() => expect(within(group()).getByRole('button', { name: /^Totem grande/ })).toBeTruthy());
    // Editing does not choose it.
    expect(within(group()).getByRole('button', { name: /^Totem grande/ }).getAttribute('aria-pressed')).toBe('false');
  });

  it('delete: asks first, then the format leaves the board and the brief (hidden when creatives use it)', async () => {
    presets = [...DEFAULT_FORMATS, customPreset({ name: 'Totem', kind: 'image', width: 1080, height: 1920 }, 'custom-totem')];
    used = 1;
    view();
    await waitFor(() => group());
    await userEvent.click(within(group()).getByRole('button', { name: /^Totem/ }));
    await userEvent.click(within(group()).getByRole('button', { name: 'Modifica Personalizzati · Totem' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Elimina' }));
    expect(api.deleteCustomFormat).not.toHaveBeenCalled();
    expect(within(dialog).getByText('Eliminare «Totem»? Le creatività che lo usano lo tengono.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Elimina formato' }));
    expect(api.deleteCustomFormat).toHaveBeenCalledWith('custom-totem');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(within(group()).queryByRole('button', { name: /^Totem/ })).toBeNull();
    expect(screen.getByText('Scegli almeno un formato')).toBeTruthy();
  });

  it('a hidden custom format is not on the board', async () => {
    presets = [...DEFAULT_FORMATS, { ...customPreset({ name: 'Vecchio', kind: 'image', width: 100, height: 100 }, 'custom-vecchio'), hidden: true }];
    view();
    await waitFor(() => group());
    expect(within(group()).queryByRole('button', { name: /Vecchio/ })).toBeNull();
  });

  it('the search finds the "Personalizzato" tile', async () => {
    view();
    await waitFor(() => group());
    await userEvent.type(screen.getByRole('searchbox', { name: 'Cerca formati' }), 'personalizz');
    expect(within(group()).getByRole('button', { name: 'Nuovo formato personalizzato' })).toBeTruthy();
    await act(async () => {});
  });
});

describe('custom format rules', () => {
  const ok = { name: 'A', kind: 'video' as const, width: '1080', height: '1080', duration: '' };
  it('checks name, sizes and duration', () => {
    expect(customDraftProblems(ok, [], null)).toEqual({});
    expect(customDraftProblems({ ...ok, name: ' ', width: '15', height: '8193', duration: '0' }, [], null)).toEqual({ name: 'name', width: 'size', height: 'size', duration: 'duration' });
    expect(customDraftProblems({ ...ok, kind: 'image', duration: '0' }, [], null)).toEqual({});
    const mine = customPreset({ name: 'Totem', kind: 'image', width: 100, height: 100 }, 'custom-totem');
    expect(customDraftProblems({ ...ok, name: 'totem ' }, [mine], null)).toEqual({ name: 'nameTaken' });
    expect(customDraftProblems({ ...ok, name: 'Totem' }, [mine], 'custom-totem')).toEqual({});
    expect(customDraftProblems({ ...ok, name: 'Totem' }, [{ ...mine, hidden: true }], null)).toEqual({});
  });
  it('a ratio sets the height from the width, within the limits', () => {
    expect(heightFor(1080, [4, 5])).toBe(1350);
    expect(heightFor(1080, [16, 9])).toBe(608);
    expect(heightFor(8000, [9, 16])).toBe(8192);
    expect(heightFor(20, [16, 9])).toBe(16);
  });
});
