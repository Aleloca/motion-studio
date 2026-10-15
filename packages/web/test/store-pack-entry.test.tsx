import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, EMPTY_BRAND_KIT, storePackFormats, type StorePack } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The store pack as an entry of the formats list (Phase 14, Task 6): New creative and the brief, the wizard in a dialog.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const createCreative = vi.fn(async (_slug: string, _body: unknown) => ({ slug: '2026-10-15-pack', creative: {}, job: null }));
/** What the server answers to a save: the whole brief it holds now. */
let serverBrief: unknown = {};
const updateCreative = vi.fn(async (..._a: unknown[]) => ({ brief: serverBrief }));
const createStorePack = vi.fn(async () => ({ slug: 'x', creative: {}, job: null }));
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  listAssets: vi.fn(async () => ({ assets: [], error: null, unregistered: [] })),
  getBrand: vi.fn(async () => ({ kit: EMPTY_BRAND_KIT, kitError: null, guidelines: '', sources: [], sourcesError: null, proposals: [], jobKey: 'k' })),
  projectFileUrl: (s: string, rel: string) => `/files/${s}/${rel}`,
  createCreative, updateCreative, createStorePack,
  getFirstGenerations: vi.fn(async (): Promise<{ tokens: number[] }> => ({ tokens: [] })),
  getSecrets: vi.fn(async () => [{ provider: 'openai', configured: true, source: 'keychain' }]),
  getKeyChecks: vi.fn(async () => ({})),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { NewCreative } = await import('../src/screens/NewCreative.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');

const shell = { catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} } } as never;
let platform: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => { vi.clearAllMocks(); location.hash = ''; platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel'); });
afterEach(() => { platform?.mockRestore(); });

/** The wizard, from the app name to the review, with `n` captions and no app screens (the user chose "no screen" for each). */
async function fillWizard(dialog: HTMLElement, n = 3, name = 'Tasky') {
  await userEvent.type(within(dialog).getByLabelText("Nome dell'app"), name);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
  for (let i = 1; i <= n; i++) {
    await userEvent.type(within(dialog).getByLabelText(`Didascalia dello screenshot ${i}`), `Didascalia ${i}`);
    await userEvent.click(within(dialog).getByRole('button', { name: `Screenshot ${i}: nessuna schermata dell'app` }));
  }
  await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
}

describe('New creative · the store pack is an entry of the formats list', () => {
  const open = async () => {
    render(<I18nProvider locale="it"><ShellContext.Provider value={shell}><NewCreative slug="acme" /></ShellContext.Provider></I18nProvider>);
    await waitFor(() => screen.getByRole('group', { name: 'Instagram' }));
  };

  it('has no separate card; the entry is visible without searching or opening any group, and a search by name still finds it', async () => {
    await open();
    expect(screen.queryByRole('group', { name: 'App Store' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Aggiungi il pacchetto store ai formati' })).toBeTruthy();
    await userEvent.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.queryByRole('button', { name: 'Aggiungi il pacchetto store ai formati' })).toBeNull();
    await userEvent.clear(screen.getByRole('searchbox'));
    await userEvent.type(screen.getByRole('searchbox'), 'pacchetto');
    expect(screen.getByRole('button', { name: 'Aggiungi il pacchetto store ai formati' })).toBeTruthy();
    await userEvent.clear(screen.getByRole('searchbox'));
    expect(screen.queryByText('Prepara il pacchetto')).toBeNull();
    expect(screen.queryByText('Pacchetto App Store', { selector: 'b' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi il pacchetto store ai formati' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pacchetto App Store' });
    expect(within(dialog).getByLabelText("Nome dell'app")).toBeTruthy();
  });

  it('confirming adds the pack to the chosen formats; Generate sends it through the normal create route with other formats', async () => {
    await open();
    await userEvent.type(screen.getByLabelText('Cosa vuoi realizzare?'), 'Lancio di Tasky');
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getAllByRole('button')[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi il pacchetto store ai formati' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pacchetto App Store' });
    await fillWizard(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aggiungi ai formati' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pacchetto App Store' })).toBeNull());
    expect(createStorePack).not.toHaveBeenCalled();
    // The tile is on and says how many screenshots.
    expect((await screen.findByRole('button', { name: 'Pacchetto store, 3 screenshot: modifica' })).getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'Salva bozza' }));
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    const body = createCreative.mock.calls[0]![1] as { brief: { formats: string[]; storePack: StorePack; formatLabels: Record<string, string> } };
    const pack = body.brief.storePack;
    expect(pack.app.name).toBe('Tasky');
    const own = storePackFormats(pack).formats;
    expect(own).toEqual(['appstore-iphone-69', 'appstore-iphone-69@2', 'appstore-iphone-69@3']);
    // The picked Instagram format first, then the pack's instances with their labels.
    expect(body.brief.formats.slice(-3)).toEqual(own);
    expect(body.brief.formats.length).toBe(4);
    expect(body.brief.formatLabels['appstore-iphone-69@2']).toBe('2 · Didascalia 2');
  });

  it('a picked tile of the same format is never taken over: the pack gets the next free instances and records them', async () => {
    await open();
    await userEvent.type(screen.getByLabelText('Cosa vuoi realizzare?'), 'Lancio di Tasky');
    await userEvent.type(screen.getByRole('searchbox'), 'iPhone 6');
    await userEvent.click(within(await screen.findByRole('group', { name: 'App Store' })).getByRole('button', { name: /iPhone 6\.9/ }));
    await userEvent.clear(screen.getByRole('searchbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi il pacchetto store ai formati' }));
    await fillWizard(await screen.findByRole('dialog', { name: 'Pacchetto App Store' }));
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi ai formati' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Salva bozza' }));
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    const body = createCreative.mock.calls[0]![1] as { brief: { formats: string[]; storePack: StorePack; formatLabels: Record<string, string> } };
    expect(body.brief.formats).toEqual(['appstore-iphone-69', 'appstore-iphone-69@2', 'appstore-iphone-69@3', 'appstore-iphone-69@4']);
    expect(body.brief.storePack.instances).toEqual(['appstore-iphone-69@2', 'appstore-iphone-69@3', 'appstore-iphone-69@4']);
    expect(body.brief.formatLabels['appstore-iphone-69@2']).toBe('1 · Didascalia 1');
    expect(body.brief.formatLabels['appstore-iphone-69']).toBeUndefined();
  });

  it('a pack alone is enough to create; taking it out brings back the "pick a format" state', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi il pacchetto store ai formati' }));
    await fillWizard(await screen.findByRole('dialog', { name: 'Pacchetto App Store' }));
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi ai formati' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Rimuovi il pacchetto store' }));
    expect(screen.getByRole('button', { name: 'Aggiungi il pacchetto store ai formati' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('Brief · the store pack entry', () => {
  const pack: StorePack = { app: { name: 'Tasky', tagline: '' }, stores: ['appstore'], devices: { appstore: ['iphone-69'] }, screenshots: [{ caption: 'Uno', screen: null }, { caption: 'Due', screen: null }], preview: false };
  const brief = (withPack: boolean) => {
    const f = storePackFormats(pack);
    return { goal: 'App', message: '', formats: withPack ? ['youtube-16x9', ...f.formats] : ['youtube-16x9'], ...(withPack ? { formatLabels: f.formatLabels, storePack: pack } : {}), durationSec: null, assets: [], notes: '' };
  };
  const detail = (b: unknown) => ({ slug: 'c1', jobKey: 'k', versions: [], creative: { schemaVersion: 1, title: 'App', brief: b, status: 'draft', error: null, resumeFrom: null, linkedCodebases: [], createdAt: '2026-10-15T10:00:00.000Z', updatedAt: '2026-10-15T10:00:00.000Z' } });
  const mount = async (b: ReturnType<typeof brief>) => {
    const { BriefEditor } = await import('../src/components/BriefEditor.tsx');
    render(<I18nProvider locale="it"><BriefEditor slug="acme" detail={detail(b) as never} presets={DEFAULT_FORMATS} disabled={false} onChanged={() => {}} onRefresh={() => {}} /></I18nProvider>);
  };

  it('with a pack: "Pacchetto store · N screenshot" with Modifica and Rimuovi', async () => {
    await mount(brief(true));
    const group = screen.getAllByRole('group', { name: 'App Store' })[0]!;
    expect(within(group).getByRole('button', { name: 'Pacchetto store · 2 screenshot' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(group).getByRole('button', { name: 'Modifica' })).toBeTruthy();
    expect(within(group).getByRole('button', { name: 'Rimuovi il pacchetto store' })).toBeTruthy();
  });

  it('Modifica reopens the wizard with the current values and saves only the pack', async () => {
    await mount(brief(true));
    serverBrief = brief(true);
    await userEvent.click(screen.getByRole('button', { name: 'Modifica' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pacchetto App Store' });
    expect((within(dialog).getByLabelText("Nome dell'app") as HTMLInputElement).value).toBe('Tasky');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    expect((within(dialog).getByLabelText('Didascalia dello screenshot 2') as HTMLInputElement).value).toBe('Due');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Avanti' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aggiorna il pacchetto' }));
    await waitFor(() => expect(updateCreative).toHaveBeenCalledOnce());
    expect(updateCreative.mock.calls[0]![2]).toEqual({ storePack: pack });
  });

  it('Rimuovi asks first, then sends storePack: null', async () => {
    await mount(brief(true));
    serverBrief = brief(false);
    await userEvent.click(screen.getByRole('button', { name: 'Rimuovi il pacchetto store' }));
    const dialog = await screen.findByRole('dialog', { name: 'Togliere il pacchetto store?' });
    expect(updateCreative).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Togli il pacchetto' }));
    await waitFor(() => expect(updateCreative).toHaveBeenCalledWith('acme', 'c1', { storePack: null }));
  });

  it('without a pack: the entry is "Pacchetto store" and adding goes through the wizard', async () => {
    await mount(brief(false));
    serverBrief = brief(true);
    const chip = screen.getByRole('button', { name: 'Pacchetto store' });
    expect(screen.queryByRole('button', { name: 'Modifica' })).toBeNull();
    await userEvent.click(chip);
    const dialog = await screen.findByRole('dialog', { name: 'Pacchetto App Store' });
    await fillWizard(dialog, 3);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aggiungi ai formati' }));
    await waitFor(() => expect(updateCreative).toHaveBeenCalledOnce());
    expect((updateCreative.mock.calls[0]![2] as { storePack: StorePack }).storePack.screenshots).toHaveLength(3);
  });
});
