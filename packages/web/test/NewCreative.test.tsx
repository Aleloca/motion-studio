import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, EMPTY_BRAND_KIT, type AssetEntry } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { ShellContext, type Shell } from '../src/shell/ShellContext.tsx';
import { requestNewCreativeWithAssets } from '../src/shell/intents.ts';

const createCreative = vi.fn(async (_slug: string, _body: unknown) => ({ slug: '2026-10-07-lancio', creative: {}, job: null }));
const at = '2026-10-08T10:00:00.000Z';
const asset = (file: string, over: Partial<AssetEntry> = {}): AssetEntry => ({
  file, kind: 'image', origin: 'upload', sourceUrl: null, description: '', tags: [], width: 100, height: 100, addedAt: at, attribution: null, ...over,
});
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  listAssets: vi.fn(async () => ({ assets: [asset('foto.jpg', { description: 'Scena del crimine' }), asset('logo.svg', { kind: 'svg' }), asset('Inter.woff2', { kind: 'font' })], error: null, unregistered: [] })),
  getBrand: vi.fn(async () => ({ kit: EMPTY_BRAND_KIT, kitError: null, guidelines: '', sources: [], sourcesError: null, proposals: [], jobKey: 'k' })),
  projectFileUrl: (s: string, rel: string) => `/files/${s}/${rel}`,
  createCreative,
  getFirstGenerations: vi.fn(async (): Promise<{ tokens: number[] }> => ({ tokens: [] })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { NewCreative, titleFromBrief, maxLengthNote, similarRange } = await import('../src/screens/NewCreative.tsx');

const shell = (name: string) => ({ catalog: { projects: [{ slug: 'acme', name }], creatives: {}, refresh: () => {} } }) as unknown as Shell;

// ⌘↵ is the Mac chord: the tests run on a Mac platform.
let platform: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => { vi.clearAllMocks(); location.hash = ''; platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel'); });
afterEach(() => { platform?.mockRestore(); platform = null; });

const board = () => waitFor(() => screen.getByRole('group', { name: 'Instagram' }));
const brief = () => screen.getByLabelText('Cosa vuoi realizzare?');

describe('NewCreative · generate', () => {
  it('without a brief, Generate highlights the field and makes no API call', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Post 1:1/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Genera' }));
    expect(createCreative).not.toHaveBeenCalled();
    expect(brief().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(brief());
    expect(screen.getByText('Prima descrivi cosa vuoi realizzare')).toBeTruthy();
    // ⌘↵ goes the same way.
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    expect(createCreative).not.toHaveBeenCalled();
    // Typing clears the message.
    await userEvent.type(brief(), 'Lancio');
    expect(brief().getAttribute('aria-invalid')).toBe(null);
  });

  it('selecting 2 formats sends 2, with the title from the brief, and opens the canvas', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    await userEvent.type(brief(), 'Lancio della nuova app. Mostra che prenotare è immediato');
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Post 1:1/ }));
    await userEvent.click(within(screen.getByRole('group', { name: 'TikTok' })).getByRole('button', { name: /Video 9:16/ }));
    expect(screen.getByText(/^2 formati · 2 render video$/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    expect(createCreative.mock.calls[0]).toEqual(['acme', {
      title: 'Lancio della nuova app',
      brief: { goal: 'Lancio della nuova app. Mostra che prenotare è immediato', message: '', formats: ['instagram-post-1x1', 'tiktok-9x16'], durationSec: 6, assets: [], notes: '', links: {} },
      generate: true,
      linkedCodebases: [],
    }]);
    await waitFor(() => expect(location.hash).toBe('#/p/acme/c/2026-10-07-lancio'));
  });

  it('with no format, Generate asks for one and makes no API call', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    await userEvent.type(brief(), 'Lancio');
    await userEvent.click(screen.getByRole('button', { name: 'Genera' }));
    expect(createCreative).not.toHaveBeenCalled();
    expect(screen.getAllByText('Scegli almeno un formato').length).toBeGreaterThan(0);
  });

  it('saves a draft without generating and returns to the creatives', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    await userEvent.type(brief(), 'Banner');
    // Web sits behind "More channels".
    await userEvent.click(screen.getByRole('button', { name: /^Web/ }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Web' })).getByRole('button', { name: /Banner 728×90/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Salva bozza' }));
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    // Only images: no video length.
    expect(createCreative.mock.calls[0]![1]).toMatchObject({ generate: false, brief: { durationSec: null, formats: ['web-banner-728x90'] } });
    await waitFor(() => expect(location.hash).toBe('#/p/acme'));
  });

  it('shows an API error with the brief kept', async () => {
    createCreative.mockRejectedValueOnce(new Error('disco pieno'));
    render(<NewCreative slug="acme" />);
    await board();
    await userEvent.type(brief(), 'Lancio');
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Post 1:1/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Genera' }));
    expect((await screen.findByRole('alert')).textContent).toContain('disco pieno');
    expect((brief() as HTMLTextAreaElement).value).toBe('Lancio');
    expect(location.hash).toBe('');
  });
});

describe('NewCreative · one creative per Generate', () => {
  const ready = async () => {
    await board();
    await userEvent.type(brief(), 'Lancio');
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Post 1:1/ }));
  };

  it('a second ⌘↵ after a successful Generate makes no second call', async () => {
    render(<NewCreative slug="acme" />);
    await ready();
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(location.hash).toBe('#/p/acme/c/2026-10-07-lancio'));
    // The page is still mounted while it leaves: the shortcut and the button stay off.
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await userEvent.click(screen.getByRole('button', { name: 'Genera' }));
    await act(async () => { await Promise.resolve(); });
    expect(createCreative).toHaveBeenCalledOnce();
  });

  it('two quick presses before the answer make one call', async () => {
    let resolve!: (v: { slug: string; creative: object; job: null }) => void;
    createCreative.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    render(<NewCreative slug="acme" />);
    await ready();
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await act(async () => { resolve({ slug: 'x', creative: {}, job: null }); });
    expect(createCreative).toHaveBeenCalledOnce();
  });

  it('ignores a held ⌘↵ (key repeat)', async () => {
    render(<NewCreative slug="acme" />);
    await ready();
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true, repeat: true });
    await act(async () => { await Promise.resolve(); });
    expect(createCreative).not.toHaveBeenCalled();
  });

  it('ignores ⌘↵ when its page is leaving (not the active page)', async () => {
    const { container } = render(<div className="ms-page"><NewCreative slug="acme" /></div>);
    await ready();
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(createCreative).not.toHaveBeenCalled();
    // The same page, active: the shortcut works.
    container.querySelector('.ms-page')!.setAttribute('data-page-active', '');
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
  });

  it('after a failed call Generate works again', async () => {
    createCreative.mockRejectedValueOnce(new Error('rete'));
    render(<NewCreative slug="acme" />);
    await ready();
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await screen.findByRole('alert');
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(createCreative).toHaveBeenCalledTimes(2));
  });

  it('shows a long API error whole, outside the summary bar', async () => {
    const detail = `${'errore '.repeat(40)}fine`;
    createCreative.mockRejectedValueOnce(new Error(detail));
    const { container } = render(<NewCreative slug="acme" />);
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Genera' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Controlla il brief e riprova');
    expect(container.querySelector('.ms-nc-foot')!.contains(alert)).toBe(false);
  });
});

describe('NewCreative · accessible reasons', () => {
  it('links the disabled video length to its visible reason', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    const length = screen.getByRole('radiogroup', { name: 'Durata dei video' });
    const id = length.getAttribute('aria-describedby')!;
    expect(document.getElementById(id)!.textContent).toBe('nessun formato video scelto');
  });

  it('shows a partial library error above the picker grid', async () => {
    api.listAssets.mockResolvedValueOnce({ assets: [asset('foto.jpg')], error: 'assets.json: riga 3 non valida', unregistered: [] } as never);
    render(<NewCreative slug="acme" />);
    await board();
    await userEvent.click(screen.getByRole('button', { name: 'Sfoglia la libreria' }));
    const picker = await screen.findByRole('dialog');
    expect(within(picker).getByText(/assets\.json: riga 3 non valida/)).toBeTruthy();
    expect(within(picker).getByRole('button', { name: /foto\.jpg/ })).toBeTruthy();
  });
});

describe('NewCreative · format board', () => {
  it('the Video filter hides the images', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    const ig = () => within(screen.getByRole('group', { name: 'Instagram' }));
    expect(ig().getByRole('button', { name: /Immagine 1:1/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'Video' }));
    expect(ig().queryByRole('button', { name: /Immagine 1:1/ })).toBeNull();
    expect(ig().getByRole('button', { name: /Post 1:1/ })).toBeTruthy();
    // YouTube's thumbnail (an image) goes too.
    expect(within(screen.getByRole('group', { name: 'YouTube' })).queryByRole('button', { name: /Miniatura|Thumbnail/ })).toBeNull();
  });

  it('marks kind, ratio and maximum length on each tile', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    const tiktok = within(screen.getByRole('group', { name: 'TikTok' })).getByRole('button', { name: /Video 9:16/ });
    expect(tiktok.textContent).toContain('9:16 · ≤ 3 min');
    const image = within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Immagine 1:1/ });
    expect(image.textContent).toContain('1:1 · immagine');
  });

  it('hides the other channels behind "More channels" and the search finds them', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    expect(screen.queryByRole('group', { name: 'LinkedIn' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /LinkedIn/ }));
    expect(screen.getByRole('group', { name: 'LinkedIn' })).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Cerca formati'), 'pin');
    expect(screen.getByRole('group', { name: 'Pinterest' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Instagram' })).toBeNull();
  });

  it('the link icon of a linkable tile is a real toggle, on by default, and is sent as brief.links', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    await userEvent.type(brief(), 'Lancio');
    const reel = within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Story\/Reel 9:16/ });
    await userEvent.click(reel);
    await userEvent.click(within(screen.getByRole('group', { name: 'TikTok' })).getByRole('button', { name: /^Video 9:16/ }));
    // The first 9:16 is the primary: no toggle on it.
    expect(screen.queryByRole('button', { name: /^Collega Instagram · Story\/Reel/ })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Collega TikTok · Video 9:16 a Instagram · Story/Reel 9:16' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('title')).toMatch(/usa lo stesso file di Instagram · Story\/Reel 9:16/);
    await userEvent.click(screen.getByRole('button', { name: 'Genera' }));
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    expect((createCreative.mock.calls[0]![1] as { brief: { links: Record<string, string> } }).brief.links).toEqual({ 'tiktok-9x16': 'instagram-reel-9x16' });
  });

  it('switching the link off sends no link (a dedicated version)', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    await userEvent.type(brief(), 'Lancio');
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Story\/Reel 9:16/ }));
    await userEvent.click(within(screen.getByRole('group', { name: 'TikTok' })).getByRole('button', { name: /^Video 9:16/ }));
    const toggle = screen.getByRole('button', { name: 'Collega TikTok · Video 9:16 a Instagram · Story/Reel 9:16' });
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    // The tile itself stays selected.
    expect(within(screen.getByRole('group', { name: 'TikTok' })).getByRole('button', { name: /^Video 9:16/ }).getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'Genera' }));
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    expect((createCreative.mock.calls[0]![1] as { brief: { links: Record<string, string> } }).brief.links).toEqual({});
  });

  it('a tile that cannot share the file says why', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Story\/Reel 9:16/ }));
    await userEvent.type(screen.getByLabelText('Cerca formati'), 'telefono');
    await userEvent.click(within(screen.getByRole('group', { name: 'Play Store' })).getByRole('button', { name: /Screenshot telefono 9:16/ }));
    const why = screen.getByRole('img', { name: /^Non può usare il file di Instagram · Story\/Reel 9:16: uno è un video/ });
    expect(why.getAttribute('title')).toBe(why.getAttribute('aria-label'));
    expect(screen.queryByRole('button', { name: /^Collega Play Store/ })).toBeNull();
  });

  it('turns the video length off without video formats', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    const length = screen.getByRole('radiogroup', { name: 'Durata dei video' });
    expect((within(length).getByRole('radio', { name: '6 s' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Post 1:1/ }));
    expect((within(length).getByRole('radio', { name: '15 s' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('NewCreative · assets', () => {
  it('the picker adds the assets to the brief', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    await userEvent.click(screen.getByRole('button', { name: 'Sfoglia la libreria' }));
    const picker = await screen.findByRole('dialog');
    // Fonts come from the brand kit: not offered.
    expect(within(picker).queryByRole('button', { name: /Inter\.woff2/ })).toBeNull();
    await userEvent.click(within(picker).getByRole('button', { name: /foto\.jpg/ }));
    expect(within(picker).getByRole('button', { name: /foto\.jpg/ }).getAttribute('aria-pressed')).toBe('true');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Rimuovi foto.jpg' })).toBeTruthy();
    await userEvent.type(brief(), 'Lancio');
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Post 1:1/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Genera' }));
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    expect(createCreative.mock.calls[0]![1]).toMatchObject({ brief: { assets: ['assets/foto.jpg'] } });
  });

  it('removes a chosen asset', async () => {
    requestNewCreativeWithAssets('acme', ['assets/foto.jpg']);
    render(<NewCreative slug="acme" />);
    await board();
    await userEvent.click(screen.getByRole('button', { name: 'Rimuovi foto.jpg' }));
    expect(screen.queryByRole('button', { name: 'Rimuovi foto.jpg' })).toBeNull();
  });

  it('preselects the assets passed from Assets ("Use in a creative")', async () => {
    requestNewCreativeWithAssets('acme', ['assets/logo.svg', 'assets/foto.jpg']);
    requestNewCreativeWithAssets('other', ['assets/x.png']);
    render(<NewCreative slug="acme" />);
    await board();
    expect(screen.getByRole('button', { name: 'Rimuovi logo.svg' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rimuovi foto.jpg' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rimuovi x.png' })).toBeNull();
    await userEvent.type(brief(), 'Lancio');
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Post 1:1/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Genera' }));
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    expect(createCreative.mock.calls[0]![1]).toMatchObject({ brief: { assets: ['assets/logo.svg', 'assets/foto.jpg'] } });
  });

  it('takes a request that arrives while the page is open', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    act(() => requestNewCreativeWithAssets('acme', ['assets/foto.jpg']));
    expect(screen.getByRole('button', { name: 'Rimuovi foto.jpg' })).toBeTruthy();
  });

  it('shows the empty library with a way to Assets', async () => {
    api.listAssets.mockResolvedValueOnce({ assets: [], error: null, unregistered: [] });
    render(<NewCreative slug="acme" />);
    await board();
    await userEvent.click(screen.getByRole('button', { name: 'Sfoglia la libreria' }));
    const picker = await screen.findByRole('dialog');
    await within(picker).findByText('Ancora nessun asset in questo progetto');
    await userEvent.click(within(picker).getByRole('button', { name: 'Apri Asset' }));
    expect(location.hash).toBe('#/p/acme/assets');
  });
});

describe('NewCreative · brand', () => {
  it('offers to set up the brand when the project has none', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    await screen.findByText('Ancora nessun brand');
    await userEvent.click(screen.getByRole('button', { name: 'Imposta il brand' }));
    expect(location.hash).toBe('#/p/acme/brand');
  });

  it('shows the brand it follows as an info row: palette, description and Edit brand, no switch', async () => {
    api.getBrand.mockResolvedValueOnce({
      kit: {
        ...EMPTY_BRAND_KIT,
        colors: [{ id: 'c', name: 'Sepia ink', hex: '#1B1913', role: 'primary', source: { kind: 'manual', ref: null } }],
        fonts: [{ id: 'f', family: 'Newsreader', role: 'heading', weights: [400], source: { kind: 'manual', ref: null } }],
        tone: { text: 'measured, atmospheric noir', source: { kind: 'manual', ref: null } },
      },
      kitError: null, guidelines: '', sources: [], sourcesError: null, proposals: [], jobKey: 'k',
    } as never);
    render(<ShellContext.Provider value={shell('Half Story')}><NewCreative slug="acme" /></ShellContext.Provider>);
    const title = await screen.findByText('Segue il brand di Half Story');
    const row = title.closest('.ms-nc-brand') as HTMLElement;
    expect(within(row).getByText('Newsreader · Sepia ink · measured, atmospheric noir')).toBeTruthy();
    expect(row.querySelectorAll('.ms-nc-swatches > span')).toHaveLength(1);
    expect(within(row).queryByRole('switch')).toBeNull();
    const edit = within(row).getByRole('link', { name: 'Modifica il brand' });
    expect(edit.getAttribute('href')).toBe('#/p/acme/brand');
  });
});

describe('NewCreative · English', () => {
  it('shows the screen in English', async () => {
    render(<I18nProvider locale="en"><NewCreative slug="acme" /></I18nProvider>);
    await waitFor(() => screen.getByRole('group', { name: 'Instagram' }));
    expect(screen.getByLabelText('What do you want to make?')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Where will it be published?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeTruthy();
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Post 1:1/ }));
    expect(screen.getByText(/^1 format · 1 video render$/)).toBeTruthy();
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Image 1:1/ }));
    expect(screen.getByText(/^2 formats · 1 video render \+ 1 image$/)).toBeTruthy();
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Post 1:1/ }));
    expect(screen.getByText(/^1 format · 1 image$/)).toBeTruthy();
  });
});

describe('titleFromBrief', () => {
  it('takes the first sentence', () => {
    expect(titleFromBrief('Lancio della nuova app. Poi il resto.', 'x')).toBe('Lancio della nuova app');
    expect(titleFromBrief('  teaser del caso!  Altro', 'x')).toBe('Teaser del caso');
    expect(titleFromBrief('Prima riga\nseconda riga', 'x')).toBe('Prima riga');
  });
  it('cuts at 60 characters on a word boundary, without trailing punctuation', () => {
    const t = titleFromBrief('Un video di sei secondi per il caso della settimana, con la scena del crimine e il logo alla fine', 'x');
    expect(t.length).toBeLessThanOrEqual(60);
    expect(t).toBe('Un video di sei secondi per il caso della settimana, con la');
    // "dieci" would end at the 61st character: back to "nove", without its comma.
    expect(titleFromBrief('Uno, due, tre, quattro, cinque, sei, sette, otto, nove, dieci, undici', 'x')).toBe('Uno, due, tre, quattro, cinque, sei, sette, otto, nove');
    // A word that ends exactly at the 60th character is kept.
    expect(titleFromBrief(`${'a'.repeat(55)} bcde, poi altro`, 'x')).toBe(`A${'a'.repeat(54)} bcde`);
    expect(titleFromBrief('x'.repeat(200), 'f')).toBe('X'.concat('x'.repeat(59)));
  });
  it('falls back when empty', () => {
    expect(titleFromBrief('   ', 'Creatività senza titolo')).toBe('Creatività senza titolo');
    expect(titleFromBrief('...', 'Senza titolo')).toBe('Senza titolo');
  });
});

describe('maxLengthNote', () => {
  it('reads seconds and whole minutes', () => {
    expect(maxLengthNote(60)).toBe('≤ 60 s');
    expect(maxLengthNote(90)).toBe('≤ 90 s');
    expect(maxLengthNote(180)).toBe('≤ 3 min');
  });
});

// Estimated layout (as in approval-card.test.tsx). jsdom has no layout engine: a box is BOX_W wide; text that may break
// anywhere fits its box, otherwise its longest unbreakable run sets the width (CH px per character); a child that clips
// (overflow other than visible) contributes its own box width.
const BOX_W = 320;
const CH = 7;
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/screens/newcreative.css'), 'utf8');
function inherited(el: Element, prop: 'whiteSpace' | 'overflowWrap'): string {
  for (let e: Element | null = el; e; e = e.parentElement) { const v = getComputedStyle(e)[prop]; if (v) return v; }
  return '';
}
function textWidth(el: Element): number {
  const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? '').join('');
  if (!own.trim()) return 0;
  const ws = inherited(el, 'whiteSpace') || 'normal';
  if (ws !== 'pre' && ws !== 'nowrap' && /anywhere|break-word/.test(inherited(el, 'overflowWrap'))) return 0;
  const runs = ws === 'pre' ? own.split('\n') : ws === 'nowrap' ? [own] : own.split(/\s+/);
  return Math.max(...runs.map((r) => r.length)) * CH;
}
const clips = (el: Element) => { const o = getComputedStyle(el).overflow || getComputedStyle(el).overflowX; return !!o && o !== 'visible'; };
function scrollW(el: Element): number {
  return Math.max(BOX_W, textWidth(el), ...[...el.children].map((c) => (clips(c) ? BOX_W : scrollW(c))));
}

describe('NewCreative · long text', () => {
  let style: HTMLStyleElement;
  const sw = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth')!;
  const cw = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!;
  beforeEach(() => {
    style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get() { return BOX_W; } });
    Object.defineProperty(Element.prototype, 'scrollWidth', { configurable: true, get(this: Element) { return Math.max(BOX_W, textWidth(this), ...[...this.children].map(scrollW)); } });
  });
  afterEach(() => {
    style.remove();
    Object.defineProperty(Element.prototype, 'scrollWidth', sw);
    Object.defineProperty(Element.prototype, 'clientWidth', cw);
  });

  const long = 'Precipitevolissimevolmente'.repeat(8).slice(0, 200);
  const setup = async () => {
    api.listAssets.mockResolvedValueOnce({ assets: [asset(`${long}.mp3`, { kind: 'audio' })], error: null, unregistered: [] });
    api.getBrand.mockResolvedValueOnce({
      kit: { ...EMPTY_BRAND_KIT, fonts: [{ id: 'f', family: long, role: 'heading', weights: [400], source: { kind: 'manual', ref: null } }] },
      kitError: null, guidelines: '', sources: [], sourcesError: null, proposals: [], jobKey: 'k',
    } as never);
    requestNewCreativeWithAssets('acme', [`assets/${long}.mp3`]);
    const view = render(<ShellContext.Provider value={shell(long)}><NewCreative slug="acme" /></ShellContext.Provider>);
    await board();
    await screen.findByText(new RegExp(`Segue il brand di ${long.slice(0, 20)}`));
    fireEvent.change(brief(), { target: { value: long } });
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Post 1:1/ }));
    return view.container;
  };

  it('a 200-character title, brief, brand and asset name never overflow horizontally', async () => {
    const root = await setup();
    // The title made from the brief is on the page (cut to 60 characters).
    expect(root.querySelector('.ms-nc-title b')!.textContent).toBe(titleFromBrief(long, ''));
    for (const sel of ['.ms-nc-left', '.ms-nc-right', '.ms-nc-foot']) {
      const el = root.querySelector(sel)!;
      expect(el, sel).toBeTruthy();
      expect(el.scrollWidth, sel).toBeLessThanOrEqual(el.clientWidth);
    }
  });

  it('the layout estimate catches text that does not wrap', async () => {
    style.textContent = css.replace(/overflow-wrap:\s*anywhere/g, 'overflow-wrap: normal').replace(/text-overflow:\s*ellipsis;?/g, '').replace(/overflow:\s*hidden;?/g, '');
    const root = await setup();
    expect(root.querySelector('.ms-nc-left')!.scrollWidth).toBeGreaterThan(BOX_W);
  });
});

describe('NewCreative · estimate from history', () => {
  it('shows no line with fewer than 3 first generations', async () => {
    api.getFirstGenerations.mockResolvedValueOnce({ tokens: [12000, 30000] });
    render(<NewCreative slug="acme" />);
    await board();
    await waitFor(() => expect(api.getFirstGenerations).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText(/Creatività simili/)).toBeNull();
  });

  it('shows the 25th–75th percentile range with 3 first generations', async () => {
    api.getFirstGenerations.mockResolvedValueOnce({ tokens: [30000, 10000, 20000] });
    render(<NewCreative slug="acme" />);
    expect(await screen.findByText('Creatività simili hanno usato circa 15–25k token')).toBeTruthy();
  });

  it('shows no line when the history cannot be read', async () => {
    api.getFirstGenerations.mockRejectedValueOnce(new Error('offline'));
    render(<NewCreative slug="acme" />);
    await board();
    await act(async () => {});
    expect(screen.queryByText(/Creatività simili/)).toBeNull();
  });

  it('formats the range in thousands, with a decimal under 10k', () => {
    expect(similarRange([1000, 2000, 3000, 4000], 'en')).toBe('1.8–3.3k');
    expect(similarRange([1000, 2000, 3000, 4000], 'it')).toBe('1,8–3,3k');
    expect(similarRange([100, 200, 300], 'en')).toBe('150–250');
    expect(similarRange([20000, 20000, 20000], 'en')).toBe('20k');
    expect(similarRange([1, 2], 'en')).toBeNull();
  });
});
