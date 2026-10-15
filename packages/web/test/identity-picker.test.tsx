import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, EMPTY_BRAND_KIT, type BrandKit } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Identity formats in the New creative screen (Phase 14, Task 5): "Partenza", its defaults and the logo concepts as instances.
vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });

const createCreative = vi.fn(async (_slug: string, _body: unknown) => ({ slug: '2026-10-15-logo', creative: {}, job: null }));
const overview = (kit: BrandKit) => ({ kit, kitError: null, guidelines: '', sources: [], sourcesError: null, proposals: [], jobKey: 'k' });
const withLogo = (kind: 'manual' | 'codebase' = 'manual'): BrandKit => ({
  ...EMPTY_BRAND_KIT,
  logos: [{ id: 'logo', file: 'assets/brand/logo.svg', variant: 'primary', background: 'any', source: kind === 'codebase' ? { kind, ref: 'assets/brand/logo.svg' } : { kind, ref: null } }],
});
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  listAssets: vi.fn(async () => ({ assets: [], error: null, unregistered: [] })),
  getBrand: vi.fn(async () => overview(EMPTY_BRAND_KIT)),
  projectFileUrl: (s: string, rel: string) => `/files/${s}/${rel}`,
  createCreative,
  getFirstGenerations: vi.fn(async (): Promise<{ tokens: number[] }> => ({ tokens: [] })),
  getSecrets: vi.fn(async () => [{ provider: 'openai', configured: true, source: 'keychain' }]),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { NewCreative } = await import('../src/screens/NewCreative.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');

const shell = { catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} } } as never;
let platform: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => { vi.clearAllMocks(); (api as Record<string, unknown>).updateCreative = undefined; api.getBrand.mockImplementation(async () => overview(EMPTY_BRAND_KIT)); location.hash = ''; platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel'); });
afterEach(() => { platform?.mockRestore(); });

const open = async (locale: 'it' | 'en' = 'it') => {
  render(<I18nProvider locale={locale}><ShellContext.Provider value={shell}><NewCreative slug="acme" /></ShellContext.Provider></I18nProvider>);
  await waitFor(() => screen.getByRole('group', { name: 'Instagram' }));
};
/** The identity group is collapsed by default: the search opens it. */
const pick = async (name: RegExp, search = 'Logo') => {
  await userEvent.type(screen.getByRole('searchbox'), search);
  const group = await screen.findByRole('group', { name: /Identità|Identity/ });
  await userEvent.click(within(group).getByRole('button', { name }));
};
const goal = async (text = 'Un logo per Acme') => { await userEvent.type(screen.getByLabelText('Cosa vuoi realizzare?'), text); };
const start = () => screen.getByRole('group', { name: 'Partenza' });

describe('NewCreative · identity start waits for the brand', () => {
  it('Generate stays disabled for an identity format until the brand has loaded, then the default follows the brand', async () => {
    let release: (v: ReturnType<typeof overview>) => void = () => {};
    api.getBrand.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    await open();
    await goal();
    await pick(/^Logo/);
    const generate = screen.getByRole('button', { name: 'Genera' }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    expect(createCreative).not.toHaveBeenCalled();
    release(overview(withLogo()));
    await waitFor(() => expect(generate.disabled).toBe(false));
    expect(within(start()).getByRole('radio', { name: /Dal logo del brand/ }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('BriefEditor · identity formats', () => {
  const brief = (formats: string[], identity?: unknown) => ({ goal: 'Logo', message: '', formats, durationSec: null, assets: [], notes: '', ...(identity ? { identity } : {}) });
  const detail = (b: unknown) => ({ slug: 'c1', jobKey: 'k', versions: [], creative: { schemaVersion: 1, title: 'Logo', brief: b, status: 'draft', error: null, resumeFrom: null, linkedCodebases: [], createdAt: '2026-10-15T10:00:00.000Z', updatedAt: '2026-10-15T10:00:00.000Z' } });
  const updateCreative = vi.fn(async (..._a: unknown[]) => ({ brief: {} }));
  const mount = async (b: unknown) => {
    Object.assign(api, { updateCreative, getKeyChecks: vi.fn(async () => ({})) });
    const { BriefEditor } = await import('../src/components/BriefEditor.tsx');
    render(<I18nProvider locale="it"><BriefEditor slug="acme" detail={detail(b) as never} presets={DEFAULT_FORMATS} disabled={false} onChanged={() => {}} /></I18nProvider>);
  };

  it('has no "Partenza" without an identity format', async () => {
    await mount(brief(['instagram-post-1x1']));
    expect(screen.queryByRole('group', { name: 'Partenza' })).toBeNull();
  });

  it('shows the saved start without concepts, and saves a changed one with the brief', async () => {
    await mount(brief(['identity-favicon'], { start: 'scratch', name: 'Acme', colors: 'brand', concepts: 3 }));
    const s = start();
    expect(within(s).getByRole('radio', { name: 'Da zero' }).getAttribute('aria-checked')).toBe('true');
    expect((within(s).getByLabelText('Nome o sigla') as HTMLInputElement).value).toBe('Acme');
    expect(within(s).queryByText('Proposte di logo')).toBeNull();
    await userEvent.click(within(s).getByRole('radio', { name: 'Liberi' }));
    await userEvent.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(updateCreative).toHaveBeenCalledOnce());
    const sent = (updateCreative.mock.calls[0]![2] as { brief: { identity: unknown } }).brief.identity;
    expect(sent).toEqual({ start: 'scratch', name: 'Acme', colors: 'free', concepts: 3 });
  });

  it('with a brand logo and nothing saved, the default is the brand logo and nothing is sent', async () => {
    api.getBrand.mockImplementation(async () => overview(withLogo()));
    await mount(brief(['identity-app-icon']));
    await waitFor(() => expect(within(start()).getByRole('radio', { name: /Dal logo del brand/ }).getAttribute('aria-checked')).toBe('true'));
    await userEvent.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(updateCreative).toHaveBeenCalledOnce());
    expect((updateCreative.mock.calls[0]![2] as { brief: object }).brief).not.toHaveProperty('identity');
  });
});

describe('NewCreative · identity formats', () => {
  it('a normal format shows no "Partenza"', async () => {
    await open();
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Post 1:1/ }));
    expect(screen.queryByRole('group', { name: 'Partenza' })).toBeNull();
  });

  it('without a brand logo the default is "Da zero", with its fields and 3 concepts', async () => {
    await open();
    await pick(/^Logo/);
    const s = start();
    expect(within(s).getByRole('radio', { name: 'Da zero' }).getAttribute('aria-checked')).toBe('true');
    expect(within(s).getByLabelText('Nome o sigla')).not.toBeNull();
    expect(within(s).getByLabelText(/Parole chiave di stile/)).not.toBeNull();
    expect(within(s).getByRole('radio', { name: 'Dal brand' }).getAttribute('aria-checked')).toBe('true');
    expect(within(s).getByRole('radio', { name: '3' }).getAttribute('aria-checked')).toBe('true');
  });

  it('with a brand logo the default is "Dal logo del brand", and a logo from a codebase says so', async () => {
    api.getBrand.mockImplementation(async () => overview(withLogo('codebase')));
    await open();
    await pick(/^Logo/);
    await waitFor(() => expect(within(start()).getByRole('radio', { name: /Dal logo del brand/ }).getAttribute('aria-checked')).toBe('true'));
    expect(within(start()).getByRole('radio', { name: 'Dal logo del brand · da codebase' })).not.toBeNull();
    expect(within(start()).queryByLabelText('Nome o sigla')).toBeNull();
  });

  it('the favicon has no concepts', async () => {
    await open();
    await pick(/Favicon/, 'Favicon');
    await userEvent.click(within(start()).getByRole('radio', { name: 'Da zero' }));
    expect(within(start()).queryByText('Proposte di logo')).toBeNull();
  });

  it('a logo from scratch with 3 concepts creates the instances identity-logo, @2 and @3 and sends the brief\'s identity', async () => {
    await open();
    await goal();
    await pick(/^Logo/);
    await userEvent.type(within(start()).getByLabelText('Nome o sigla'), '  Acme ');
    await userEvent.type(within(start()).getByLabelText(/Parole chiave di stile/), 'geometrico');
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    const brief = (createCreative.mock.calls[0]![1] as { brief: { formats: string[]; identity: unknown } }).brief;
    expect(brief.formats).toEqual(['identity-logo', 'identity-logo@2', 'identity-logo@3']);
    expect(brief.identity).toEqual({ start: 'scratch', name: 'Acme', keywords: 'geometrico', colors: 'brand', concepts: 3 });
  });

  it('the number of concepts is 1 to 5', async () => {
    await open();
    await goal();
    await pick(/^Logo/);
    await userEvent.click(within(start()).getByRole('radio', { name: '5' }));
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    expect((createCreative.mock.calls[0]![1] as { brief: { formats: string[] } }).brief.formats).toEqual(['identity-logo', 'identity-logo@2', 'identity-logo@3', 'identity-logo@4', 'identity-logo@5']);
  });

  it('from the brand logo: one logo instance, no name or keywords sent', async () => {
    api.getBrand.mockImplementation(async () => overview(withLogo()));
    await open();
    await goal();
    await pick(/^Logo/);
    await waitFor(() => expect(within(start()).getByRole('radio', { name: /Dal logo del brand/ }).getAttribute('aria-checked')).toBe('true'));
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    const brief = (createCreative.mock.calls[0]![1] as { brief: { formats: string[]; identity: unknown } }).brief;
    expect(brief.formats).toEqual(['identity-logo']);
    expect(brief.identity).toMatchObject({ start: 'brand' });
  });

  it('the Identity channel has its own mark, so it is not mistaken for Web', async () => {
    await open();
    expect(screen.getAllByRole('button', { name: /^Web/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^Identità/ }).querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Identità');
  });

  it('is in English too', async () => {
    await open('en');
    await userEvent.type(screen.getByRole('searchbox'), 'Logo');
    const group = await screen.findByRole('group', { name: 'Identity' });
    await userEvent.click(within(group).getByRole('button', { name: /^Logo/ }));
    expect(screen.getByRole('group', { name: 'Start' })).not.toBeNull();
    expect(screen.getByRole('radio', { name: 'From scratch' })).not.toBeNull();
  });
});
