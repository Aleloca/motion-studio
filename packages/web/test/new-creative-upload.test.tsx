import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, EMPTY_BRAND_KIT, type AssetEntry, type CreativeReferenceEntry } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestNewCreativeWithAssets } from '../src/shell/intents.ts';

/** Report 62: files added from the computer straight into the brief, only for this creative unless saved in Assets. */
const at = '2026-10-08T10:00:00.000Z';
const asset = (file: string, over: Partial<AssetEntry> = {}): AssetEntry => ({
  file, kind: 'image', origin: 'upload', sourceUrl: null, description: '', tags: [], width: 100, height: 100, addedAt: at, attribution: null, ...over,
});
const ref = (file: string, usedBy: CreativeReferenceEntry['usedBy'] = []): CreativeReferenceEntry => ({ ...asset(file), referenceFor: [], usedBy });
type Listing = { assets: AssetEntry[]; error: string | null; unregistered: string[]; creativeReferences?: CreativeReferenceEntry[] };
const listing = async (): Promise<Listing> => ({ assets: [asset('foto.jpg')], error: null, unregistered: [], creativeReferences: [ref('altrui.png', [{ slug: 'altra', title: 'Altra' }])] });
const createCreative = vi.fn(async (_slug: string, _body: unknown) => ({ slug: '2026-10-07-lancio', creative: {}, job: null }));
const api = {
  getBriefSession: vi.fn(async () => null),
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  listAssets: vi.fn(listing),
  getBrand: vi.fn(async () => ({ kit: EMPTY_BRAND_KIT, kitError: null, guidelines: '', sources: [], sourcesError: null, proposals: [], jobKey: 'k' })),
  projectFileUrl: (s: string, rel: string) => `/files/${s}/${rel}`,
  createCreative,
  getFirstGenerations: vi.fn(async () => ({ tokens: [] })),
  getSecrets: vi.fn(async () => []),
  uploadFiles: vi.fn(async (_slug: string, _kind: string, files: File[], _o?: { reference?: boolean }) => ({ assets: files.map((f) => ({ ...asset(f.name), referenceFor: [] })) })),
  setAssetReference: vi.fn(async (_slug: string, file: string, reference: boolean) => (reference ? { ...asset(file), referenceFor: [] } : asset(file))),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { NewCreative } = await import('../src/screens/NewCreative.tsx');

beforeEach(() => { vi.clearAllMocks(); api.listAssets.mockImplementation(listing); location.hash = ''; });

const board = () => waitFor(() => screen.getByRole('group', { name: 'Instagram' }));
const section = () => screen.getByRole('list', { name: 'Asset da usare' });
const png = (name: string) => new File(['x'], name, { type: 'image/png' });
const generate = async () => {
  await userEvent.type(screen.getByLabelText('Cosa vuoi realizzare?'), 'Lancio');
  await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /Post 1:1/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Genera' }));
  await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
};

describe('NewCreative · files from the computer (report 62)', () => {
  it('"Dal computer…" uploads as references of this brief: picked, marked "Solo per questa creatività", sent with the brief', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    await userEvent.upload(screen.getByLabelText('File da aggiungere al brief'), [png('moodboard.png'), png('scena.png')]);
    expect(api.uploadFiles).toHaveBeenCalledWith('acme', 'assets', expect.any(Array), { reference: true });
    await screen.findByRole('button', { name: 'Rimuovi moodboard.png' });
    expect(within(section()).getAllByRole('button', { name: /è solo per questa creatività/ })).toHaveLength(2);
    expect(within(section()).getAllByText('Solo per questa creatività')).toHaveLength(2);
    await generate();
    expect(createCreative.mock.calls[0]![1]).toMatchObject({ brief: { assets: ['assets/moodboard.png', 'assets/scena.png'] } });
  });

  it('one click on the mark saves the file in Assets, another keeps it only for this creative', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    await userEvent.upload(screen.getByLabelText('File da aggiungere al brief'), [png('logo.png')]);
    const mark = await screen.findByRole('button', { name: /logo\.png è solo per questa creatività/ });
    expect(mark.getAttribute('aria-pressed')).toBe('false');
    // The library is read again after the change; the file is there now (the mark stays: it was added in this brief).
    api.listAssets.mockResolvedValue({ assets: [asset('foto.jpg'), asset('logo.png')], error: null, unregistered: [], creativeReferences: [] });
    await userEvent.click(mark);
    expect(api.setAssetReference).toHaveBeenLastCalledWith('acme', 'logo.png', false);
    const saved = await screen.findByRole('button', { name: /logo\.png è salvato negli Assets/ });
    expect(saved.getAttribute('aria-pressed')).toBe('true');
    expect(within(section()).getByText('Salvato negli Assets')).toBeTruthy();
    await userEvent.click(saved);
    expect(api.setAssetReference).toHaveBeenLastCalledWith('acme', 'logo.png', true);
    await screen.findByRole('button', { name: /logo\.png è solo per questa creatività/ });
  });

  it('the "+" tile offers the computer or the library', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    await userEvent.click(within(section()).getByRole('button', { name: 'Aggiungi asset' }));
    const menu = await screen.findByRole('menu', { name: 'Aggiungi asset' });
    expect(within(menu).getByRole('menuitem', { name: /Dal computer…/ })).toBeTruthy();
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Dalla libreria/ }));
    expect(await screen.findByRole('dialog', { name: /libreria/i })).toBeTruthy();
  });

  it('files dropped on the section are uploaded the same way', async () => {
    render(<NewCreative slug="acme" />);
    await board();
    const files = [png('drop.png')];
    const sec = section().closest('section')!;
    fireEvent.dragEnter(sec, { dataTransfer: { types: ['Files'], files } });
    expect(screen.getByText('Rilascia i file per aggiungerli a questo brief')).toBeTruthy();
    fireEvent.drop(sec, { dataTransfer: { types: ['Files'], files } });
    await screen.findByRole('button', { name: 'Rimuovi drop.png' });
    expect(api.uploadFiles).toHaveBeenCalledWith('acme', 'assets', files, { reference: true });
    expect(screen.queryByText('Rilascia i file per aggiungerli a questo brief')).toBeNull();
  });

  it('a failed upload stays as a tile that says why, until dismissed; nothing is picked', async () => {
    api.uploadFiles.mockRejectedValueOnce(new Error('File troppo grande'));
    render(<NewCreative slug="acme" />);
    await board();
    await userEvent.upload(screen.getByLabelText('File da aggiungere al brief'), [png('enorme.png')]);
    const alert = await within(section()).findByRole('alert');
    expect(alert.textContent).toContain('enorme.png non è stato caricato: File troppo grande');
    await userEvent.click(within(alert).getByRole('button', { name: "Chiudi l'errore di enorme.png" }));
    expect(within(section()).queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rimuovi enorme.png' })).toBeNull();
  });

  it('the library picker leaves out other creatives\' references, and shows this brief\'s own as picked', async () => {
    api.listAssets.mockResolvedValueOnce({ assets: [asset('foto.jpg')], error: null, unregistered: [], creativeReferences: [ref('altrui.png'), ref('mio.png')] });
    act(() => requestNewCreativeWithAssets('acme', ['assets/mio.png']));
    render(<NewCreative slug="acme" />);
    await board();
    // A reference already in the brief (a resumed brief) has its mark too.
    await screen.findByRole('button', { name: /mio\.png è solo per questa creatività/ });
    await userEvent.click(screen.getByRole('button', { name: 'Sfoglia la libreria' }));
    const picker = await screen.findByRole('dialog');
    expect(within(picker).getByRole('button', { name: 'foto.jpg' })).toBeTruthy();
    expect(within(picker).getByRole('button', { name: 'mio.png' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(picker).queryByRole('button', { name: 'altrui.png' })).toBeNull();
  });

  it('an empty library offers "Carica dal computer" first', async () => {
    api.listAssets.mockResolvedValueOnce({ assets: [], error: null, unregistered: [], creativeReferences: [] });
    render(<NewCreative slug="acme" />);
    await board();
    await userEvent.click(screen.getByRole('button', { name: 'Sfoglia la libreria' }));
    const picker = await screen.findByRole('dialog');
    await within(picker).findByText('Ancora nessun asset in questo progetto');
    expect(within(picker).getByText('Aggiungi immagini, loghi o clip dal computer, o caricali in Asset.')).toBeTruthy();
    const input = screen.getByLabelText<HTMLInputElement>('File da aggiungere al brief');
    const click = vi.spyOn(input, 'click');
    expect(within(picker).getByRole('button', { name: 'Apri Asset' })).toBeTruthy();
    await userEvent.click(within(picker).getByRole('button', { name: 'Carica dal computer' }));
    expect(click).toHaveBeenCalledOnce();
  });
});

describe('Brief agent · files from the computer (report 62)', () => {
  it('"Carica dal Mac" in the chat uploads only for this creative: the pin carries the same mark', async () => {
    const { container } = render(<NewCreative slug="acme" />);
    await board();
    const panel = container.querySelector<HTMLElement>('.ms-brief-panel')!;
    const input = panel.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = png('chat.png');
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(api.uploadFiles).toHaveBeenCalledWith('acme', 'assets', [file], { reference: true }));
    const mark = await within(panel).findByRole('button', { name: /chat\.png è solo per questa creatività/, hidden: true });
    expect(mark.textContent).toBe('Solo per questa creatività');
    fireEvent.click(mark);
    await waitFor(() => expect(api.setAssetReference).toHaveBeenCalledWith('acme', 'chat.png', false));
    // The form's section is not where a chat upload goes (it is a pin of the next message).
    expect(screen.queryByRole('button', { name: 'Rimuovi chat.png' })).toBeNull();
  });
});
