/**
 * Phase 15, Task 5: the "Varianti" field of New creative (spec §3). 1 to 5, a direction for each variant from 2 up; the default is
 * 3 only for a logo from scratch (orchestrator ruling, decision 846), else 1. With 2 or more the creative is made first, then its
 * group (total count, typed directions), then ONE fan-out start: never a single turn first. A logo from scratch is grouped by the
 * core itself (decision 845): the answer has `job: null` and a `variantRun`.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, EMPTY_BRAND_KIT, type BrandKit } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });

const created = { slug: '2026-10-16-lancio', creative: {}, job: null } as { slug: string; creative: object; job: null; variantRun?: unknown; startError?: string; groupError?: string };
const createCreative = vi.fn(async (_slug: string, _body: unknown) => ({ ...created }));
const addVariants = vi.fn(async (..._a: unknown[]) => ({}));
const runVariants = vi.fn(async (..._a: unknown[]) => ({ jobs: {}, queued: [], skipped: [], failed: {} }));
const setVariantDirection = vi.fn(async (..._a: unknown[]) => ({}));
const overview = (kit: BrandKit) => ({ kit, kitError: null, guidelines: '', sources: [], sourcesError: null, proposals: [], jobKey: 'k' });
const withLogo = (): BrandKit => ({ ...EMPTY_BRAND_KIT, logos: [{ id: 'logo', file: 'assets/brand/logo.svg', variant: 'primary', background: 'any', source: { kind: 'manual', ref: null } }] });
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  listAssets: vi.fn(async () => ({ assets: [], error: null, unregistered: [] })),
  getBrand: vi.fn(async () => overview(EMPTY_BRAND_KIT)),
  projectFileUrl: (s: string, rel: string) => `/files/${s}/${rel}`,
  createCreative, addVariants, runVariants, setVariantDirection,
  getFirstGenerations: vi.fn(async (): Promise<{ tokens: number[] }> => ({ tokens: [] })),
  getSecrets: vi.fn(async () => [{ provider: 'openai', configured: true, source: 'keychain' }]),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { NewCreative } = await import('../src/screens/NewCreative.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { __resetToasts, getToasts } = await import('../src/ui/toast.tsx');

const shell = { catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} } } as never;
let platform: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => {
  vi.clearAllMocks();
  __resetToasts();
  api.getBrand.mockImplementation(async () => overview(EMPTY_BRAND_KIT));
  createCreative.mockImplementation(async () => ({ ...created }));
  location.hash = '';
  platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
});
afterEach(() => { platform?.mockRestore(); });

const open = async (locale: 'it' | 'en' = 'it') => {
  render(<I18nProvider locale={locale}><ShellContext.Provider value={shell}><NewCreative slug="acme" /></ShellContext.Provider></I18nProvider>);
  await waitFor(() => screen.getByRole('group', { name: 'Instagram' }));
};
const goal = async () => { await userEvent.type(screen.getByLabelText('Cosa vuoi realizzare?'), 'Lancio della nuova app'); };
const post = () => userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Post 1:1/ }));
const field = () => screen.getByRole('group', { name: 'Varianti' });
/** The identity group is collapsed by default: the search opens it. */
const pick = async (name: RegExp, search = 'Logo') => {
  await userEvent.type(screen.getByRole('searchbox'), search);
  const group = await screen.findByRole('group', { name: /Identità|Identity/ });
  await userEvent.click(within(group).getByRole('button', { name }));
};
const checked = (g: HTMLElement) => within(g).getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.textContent);

describe('the "Varianti" field', () => {
  it('defaults to 1 for an ordinary format, with no direction fields', async () => {
    await open();
    await post();
    expect(checked(field())).toEqual(['1']);
    expect(screen.queryByLabelText(/Direzione della variante/)).toBeNull();
  });

  it('2 and more ask an optional direction for each variant, up to 5', async () => {
    await open();
    await post();
    await userEvent.click(within(field()).getByRole('radio', { name: '2' }));
    expect(screen.getAllByLabelText(/^Direzione della variante [AB] \(facoltativa\)$/)).toHaveLength(2);
    await userEvent.click(within(field()).getByRole('radio', { name: '5' }));
    expect(screen.getAllByLabelText(/^Direzione della variante [A-E] \(facoltativa\)$/)).toHaveLength(5);
    expect(screen.getByText("Se la lasci vuota, la propone l'agente.")).toBeTruthy();
    // The core refuses a direction over 140 characters: the field stops there.
    expect(screen.getByLabelText('Direzione della variante A (facoltativa)').getAttribute('maxlength')).toBe('140');
  });

  it('is in English too', async () => {
    await open('en');
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Post 1:1/ }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Variants' })).getByRole('radio', { name: '3' }));
    expect(screen.getByLabelText('Direction of variant C (optional)')).toBeTruthy();
    expect(screen.getByText('Left empty, the agent proposes one.')).toBeTruthy();
  });

  it('defaults to 3 when identity-logo is chosen and the logo is made from scratch (the field is in "Partenza")', async () => {
    await open();
    await pick(/^Logo/);
    expect(checked(screen.getByRole('group', { name: 'Partenza' }))).toContain('3');
    // One field, not two.
    expect(screen.getAllByText('Varianti')).toHaveLength(1);
    expect(screen.getAllByLabelText(/^Direzione della variante [A-C] \(facoltativa\)$/)).toHaveLength(3);
  });

  it('is 1 for a favicon alone, even from scratch (no logo among the formats)', async () => {
    await open();
    await pick(/Favicon/, 'Favicon');
    expect(checked(within(screen.getByRole('group', { name: 'Partenza' })).getByRole('radiogroup', { name: 'Varianti' }))).toEqual(['1']);
    expect(screen.queryByLabelText(/Direzione della variante/)).toBeNull();
  });

  it('is 1 for a logo taken from the brand\'s logo: there is nothing to vary', async () => {
    api.getBrand.mockImplementation(async () => overview(withLogo()));
    await open();
    await pick(/^Logo/);
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Partenza' })).getByRole('radio', { name: /Dal logo del brand/ }).getAttribute('aria-checked')).toBe('true'));
    expect(checked(field())).toEqual(['1']);
  });
});

describe('creating with variants', () => {
  it('creates the creative, then the group with the TOTAL count and the typed directions, then one fan-out start', async () => {
    await open();
    await goal();
    await post();
    await userEvent.click(within(field()).getByRole('radio', { name: '3' }));
    await userEvent.type(screen.getByLabelText('Direzione della variante A (facoltativa)'), 'Minimale');
    await userEvent.type(screen.getByLabelText('Direzione della variante C (facoltativa)'), '  Giocosa ');
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(runVariants).toHaveBeenCalledOnce());
    // The creative starts nothing by itself.
    expect(createCreative).toHaveBeenCalledOnce();
    expect(createCreative.mock.calls[0]![1]).toMatchObject({ generate: false });
    expect(addVariants).toHaveBeenCalledWith('acme', created.slug, { count: 3, directions: ['Minimale', null, 'Giocosa'] });
    expect(runVariants).toHaveBeenCalledWith('acme', created.slug, { targets: 'all-active', request: null });
    // Order: create, group, start.
    expect(createCreative.mock.invocationCallOrder[0]!).toBeLessThan(addVariants.mock.invocationCallOrder[0]!);
    expect(addVariants.mock.invocationCallOrder[0]!).toBeLessThan(runVariants.mock.invocationCallOrder[0]!);
    await waitFor(() => expect(location.hash).toBe(`#/p/acme/c/${created.slug}`));
  });

  it('a draft makes the group but starts nothing', async () => {
    await open();
    await goal();
    await post();
    await userEvent.click(within(field()).getByRole('radio', { name: '2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Salva bozza' }));
    await waitFor(() => expect(addVariants).toHaveBeenCalledWith('acme', created.slug, { count: 2, directions: [null, null] }));
    expect(runVariants).not.toHaveBeenCalled();
    expect(createCreative.mock.calls[0]![1]).toMatchObject({ generate: false });
    await waitFor(() => expect(location.hash).toBe('#/p/acme'));
  });

  it('one variant is exactly as before: one create with generate, no group, no fan-out', async () => {
    await open();
    await goal();
    await post();
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    expect(createCreative.mock.calls[0]![1]).toMatchObject({ generate: true });
    expect(addVariants).not.toHaveBeenCalled();
    expect(runVariants).not.toHaveBeenCalled();
  });

  it('when the group cannot be made the creative still exists: the user is told and taken to it', async () => {
    addVariants.mockRejectedValueOnce(new Error('disk full'));
    await open();
    await goal();
    await post();
    await userEvent.click(within(field()).getByRole('radio', { name: '2' }));
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(location.hash).toBe(`#/p/acme/c/${created.slug}`));
    expect(getToasts().some((x) => x.text === 'La creatività è stata creata, ma non è stato possibile creare le varianti: disk full')).toBe(true);
    expect(runVariants).not.toHaveBeenCalled();
    expect(createCreative).toHaveBeenCalledOnce();
  });

  it('when the start fails the user is told and taken to the creative', async () => {
    runVariants.mockRejectedValueOnce(new Error('queue down'));
    await open();
    await goal();
    await post();
    await userEvent.click(within(field()).getByRole('radio', { name: '2' }));
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(location.hash).toBe(`#/p/acme/c/${created.slug}`));
    expect(getToasts().some((x) => x.text === 'La creatività è stata creata, ma le varianti non sono partite: queue down')).toBe(true);
  });
});

describe('a logo from scratch (the core makes the group, decision 845)', () => {
  it('sends the count in the brief and starts with the creative: the answer has no job but a variantRun, and the canvas opens', async () => {
    createCreative.mockImplementationOnce(async () => ({ ...created, job: null, variantRun: { jobs: { a: 'j1', b: 'j2', c: 'j3' }, queued: [], skipped: [], failed: {}, directionsJobId: 'd1' } }));
    await open();
    await userEvent.type(screen.getByLabelText('Cosa vuoi realizzare?'), 'Un logo per Acme');
    await pick(/^Logo/);
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    const body = createCreative.mock.calls[0]![1] as { generate: boolean; brief: { identity: { concepts: number } } };
    expect(body.generate).toBe(true);
    expect(body.brief.identity.concepts).toBe(3);
    await waitFor(() => expect(location.hash).toBe(`#/p/acme/c/${created.slug}`));
    // The core already started the variants: nothing more is sent from here.
    expect(addVariants).not.toHaveBeenCalled();
    expect(runVariants).not.toHaveBeenCalled();
    expect(getToasts()).toEqual([]);
  });

  it('a start that failed after the group existed is reported, and the slug is not lost', async () => {
    createCreative.mockImplementationOnce(async () => ({ ...created, job: null, startError: 'start boom' }));
    await open();
    await userEvent.type(screen.getByLabelText('Cosa vuoi realizzare?'), 'Un logo per Acme');
    await pick(/^Logo/);
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(location.hash).toBe(`#/p/acme/c/${created.slug}`));
    expect(getToasts().some((x) => x.text === 'La creatività è stata creata, ma le varianti non sono partite: start boom')).toBe(true);
  });

  it('final wave M4: a group the core could not make after the creative existed is reported, and the slug is not lost', async () => {
    createCreative.mockImplementationOnce(async () => ({ ...created, job: null, groupError: 'group boom' }));
    await open();
    await userEvent.type(screen.getByLabelText('Cosa vuoi realizzare?'), 'Un logo per Acme');
    await pick(/^Logo/);
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(location.hash).toBe(`#/p/acme/c/${created.slug}`));
    expect(getToasts().some((x) => x.text === 'La creatività è stata creata, ma non è stato possibile creare le varianti: group boom')).toBe(true);
  });

  it('typed directions are set before anything starts, and the start is then one fan-out', async () => {
    await open();
    await userEvent.type(screen.getByLabelText('Cosa vuoi realizzare?'), 'Un logo per Acme');
    await pick(/^Logo/);
    await userEvent.type(screen.getByLabelText('Direzione della variante B (facoltativa)'), 'Geometrico');
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(runVariants).toHaveBeenCalledOnce());
    expect(createCreative.mock.calls[0]![1]).toMatchObject({ generate: false });
    expect(setVariantDirection).toHaveBeenCalledWith('acme', created.slug, 'b', 'Geometrico');
    expect(addVariants).not.toHaveBeenCalled();
    expect(setVariantDirection.mock.invocationCallOrder[0]!).toBeLessThan(runVariants.mock.invocationCallOrder[0]!);
  });

  it('one concept is a plain creative: no group, no fan-out', async () => {
    await open();
    await userEvent.type(screen.getByLabelText('Cosa vuoi realizzare?'), 'Un logo per Acme');
    await pick(/^Logo/);
    await userEvent.click(within(screen.getByRole('group', { name: 'Partenza' })).getByRole('radio', { name: '1' }));
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    expect(createCreative.mock.calls[0]![1]).toMatchObject({ generate: true, brief: { identity: { concepts: 1 } } });
    expect(runVariants).not.toHaveBeenCalled();
  });
});
