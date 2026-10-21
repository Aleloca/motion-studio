import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EMPTY_BRIEF_FORM, type AssetEntry, type BriefSessionView, type ConversationEntry, type JobSummary } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { initialEventsState, type EventsState } from '../src/eventsReducer.ts';

const at = '2026-10-20T10:00:00.000Z';
const asset = (file: string): AssetEntry => ({ file, kind: 'image', origin: 'upload', sourceUrl: null, description: '', tags: [], width: 100, height: 100, addedAt: at, attribution: null });
const view = (over: Partial<BriefSessionView> = {}): BriefSessionView => ({
  id: 's1', createdAt: at, updatedAt: at, context: { codebases: [], assets: [] }, form: EMPTY_BRIEF_FORM, userEdited: [], agentFields: [], queued: [], jobId: null, revision: 4, ...over,
});
class ApiError extends Error { constructor(public status: number, m: string, public code?: string) { super(m); } }
const job: JobSummary = { id: 'b1', key: 'brief:/w:acme', kind: 'brief', label: 'l', state: 'running', createdAt: at };
const api = {
  getBriefSession: vi.fn(async (_slug: string): Promise<BriefSessionView | null> => null),
  getBriefConversation: vi.fn(async (): Promise<ConversationEntry[]> => []),
  startBriefSession: vi.fn(async (_slug: string, _b: unknown) => view({ revision: 1 })),
  sendBriefMessage: vi.fn(async (_slug: string, _id: string, _b: Record<string, unknown>) => ({ outcome: 'started' as const, job })),
  saveBriefForm: vi.fn(),
  setBriefContext: vi.fn(async (_slug: string, _id: string, c: BriefSessionView['context']) => view({ context: c })),
  removeBriefQueued: vi.fn(async () => view()),
  discardBriefSession: vi.fn(async () => undefined),
  uploadFiles: vi.fn(async (_slug: string, _kind: string, files: File[]) => ({ assets: files.map((f) => asset(f.name)) })),
  projectFileUrl: (s: string, rel: string) => `/files/${s}/${rel}`,
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: false, interrupt: false, checkedAt: at })),
  stopJob: vi.fn(async () => ({ status: 'stopping' })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const pickFolder = vi.fn(async (_title: string): Promise<string | null> => '/Users/x/app');
let desktopOn = false;
vi.mock('../src/desktop.ts', () => ({ desktop: () => (desktopOn ? { isDesktop: true, pickFolder, revealPath: vi.fn() } : null) }));
const { BriefSessionPanel } = await import('../src/screens/new-creative/BriefSessionPanel.tsx');
const { useBriefSession } = await import('../src/screens/new-creative/useBriefSession.ts');

const form = { ...EMPTY_BRIEF_FORM, goal: 'Lancio' };
const onLibraryChanged = vi.fn();
function Harness({ l }: { l: EventsState }) {
  const brief = useBriefSession('acme', l);
  return (
    <BriefSessionPanel slug="acme" projectName="Acme" brief={brief} live={l}
      snapshot={() => ({ form, userEdited: ['goal'], baseRevision: brief.session?.revision ?? 0 })}
      library={{ value: [asset('casella.png'), asset('logo.svg'), asset('demo.png')], error: null }} onRetryLibrary={() => {}} onLibraryChanged={onLibraryChanged} />
  );
}
const page = (l: EventsState = initialEventsState) => <I18nProvider locale="it"><Harness l={l} /></I18nProvider>;
const box = () => screen.getByRole('textbox', { name: "Messaggio all'agente" });
const openMenu = async () => { await userEvent.click(screen.getByRole('button', { name: 'Aggiungi cartelle o asset' })); return screen.findByRole('menu', { name: 'Aggiungi contesto' }); };

beforeEach(() => { vi.clearAllMocks(); desktopOn = false; });
afterEach(() => { desktopOn = false; });

describe('BriefSessionPanel (decisions 1412–1414)', () => {
  it('the "+" opens the context menu with its three items; Escape closes it', async () => {
    render(page());
    const plus = screen.getByRole('button', { name: 'Aggiungi cartelle o asset' });
    expect(plus.getAttribute('aria-haspopup')).toBe('menu');
    const menu = await openMenu();
    expect(plus.getAttribute('aria-expanded')).toBe('true');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Collega una cartellaCodice sul tuo Mac, letto in sola lettura',
      'Asset dalla libreriaImmagini, video e loghi del progetto',
      'Carica dal MacSolo per questa creatività, se non lo salvi negli Assets',
    ]);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(plus.getAttribute('aria-expanded')).toBe('false');
  });

  it('a folder from the desktop picker becomes a pin; on the web a path with glob characters is refused', async () => {
    desktopOn = true;
    const { unmount } = render(page());
    await userEvent.click(within(await openMenu()).getByRole('menuitem', { name: /Collega una cartella/ }));
    await waitFor(() => expect(pickFolder).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Togli /Users/x/app' })).toBeTruthy();
    unmount();
    desktopOn = false;
    render(page());
    await userEvent.click(within(await openMenu()).getByRole('menuitem', { name: /Collega una cartella/ }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Percorso della cartella' }), '/Users/x/a*b');
    await userEvent.click(screen.getByRole('button', { name: 'Collega' }));
    expect(screen.getByRole('alert').textContent).toContain('/Users/x/a*b');
    expect(screen.queryByRole('button', { name: /^Togli / })).toBeNull();
  });

  it('two assets chosen in the library are two pins', async () => {
    render(page());
    await userEvent.click(within(await openMenu()).getByRole('menuitem', { name: /Asset dalla libreria/ }));
    const picker = await screen.findByRole('dialog', { name: /Acme/ });
    await userEvent.click(within(picker).getByRole('button', { name: 'casella.png' }));
    await userEvent.click(within(picker).getByRole('button', { name: 'logo.svg' }));
    expect(screen.getByRole('button', { name: 'Togli casella.png' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Togli logo.svg' })).toBeTruthy();
  });

  it('an upload is only for this creative (decision 1576) and its file is pinned', async () => {
    const { container } = render(page());
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'demo-app.mov', { type: 'video/quicktime' });
    await userEvent.upload(input, file);
    await waitFor(() => expect(api.uploadFiles).toHaveBeenCalledWith('acme', 'assets', [file], { reference: true }));
    expect(await screen.findByRole('button', { name: 'Togli demo-app.mov' })).toBeTruthy();
    expect(onLibraryChanged).toHaveBeenCalled();
  });

  it('a send opens the session and carries the pins, the form and the user\'s fields; the pins stay on a refusal', async () => {
    desktopOn = true;
    render(page());
    await userEvent.click(within(await openMenu()).getByRole('menuitem', { name: /Collega una cartella/ }));
    await screen.findByRole('button', { name: 'Togli /Users/x/app' });
    await userEvent.click(within(await openMenu()).getByRole('menuitem', { name: /Asset dalla libreria/ }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: /Acme/ })).getByRole('button', { name: 'casella.png' }));
    await userEvent.keyboard('{Escape}');
    api.sendBriefMessage.mockRejectedValueOnce(new ApiError(409, "L'agente sta ancora lavorando al brief", 'brief-session-busy'));
    await userEvent.type(box(), 'Video di lancio');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(screen.getByText(/sta ancora lavorando/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Togli /Users/x/app' })).toBeTruthy();
    expect(api.startBriefSession).toHaveBeenCalledWith('acme', { form, userEdited: ['goal'] });
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(api.sendBriefMessage).toHaveBeenCalledTimes(2));
    const body = api.sendBriefMessage.mock.calls[1]![2];
    expect(body).toMatchObject({ text: 'Video di lancio', form, userEdited: ['goal'], baseRevision: 1, context: { codebases: [{ path: '/Users/x/app' }], assets: ['assets/casella.png'] } });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Togli /Users/x/app' })).toBeNull());
  });

  it('the context row counts the session\'s folders and assets and removes one', async () => {
    api.getBriefSession.mockResolvedValue(view({ context: { codebases: [{ path: '/c/app' }, { path: '/c/web' }], assets: ['assets/a.png', 'assets/b.png', 'assets/c.png'] } }));
    render(page());
    await userEvent.click(await screen.findByRole('button', { name: /2 cartelle/ }));
    expect(screen.getByRole('button', { name: /3 asset/ })).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: 'Togli /c/web dalla sessione' }));
    await waitFor(() => expect(api.setBriefContext).toHaveBeenCalledWith('acme', 's1', { codebases: [{ path: '/c/app' }], assets: ['assets/a.png', 'assets/b.png', 'assets/c.png'] }));
    api.getBriefSession.mockResolvedValue(null);
  });

  it('the state pill: new session, then working while the job runs, then filled once the agent wrote a field', async () => {
    api.getBriefSession.mockResolvedValue(view());
    const { rerender } = render(page());
    await waitFor(() => expect(api.getBriefSession).toHaveBeenCalled());
    const head = () => screen.getByRole('complementary', { name: "Sessione con l'agente" }).querySelector('.ms-brief-state')!;
    expect(head().textContent).toBe('Nuova sessione');
    api.getBriefSession.mockResolvedValue(view({ jobId: 'b1' }));
    rerender(page({ ...initialEventsState, briefTicks: { acme: 1 }, jobs: { b1: job } }));
    await waitFor(() => expect(head().textContent).toBe('Al lavoro…'));
    api.getBriefSession.mockResolvedValue(view({ agentFields: ['goal'] }));
    rerender(page({ ...initialEventsState, briefTicks: { acme: 2 }, jobs: { b1: { ...job, state: 'succeeded' } } }));
    await waitFor(() => expect(head().textContent).toBe('Brief compilato'));
    api.getBriefSession.mockResolvedValue(null);
  });
});

describe('BriefSessionPanel · refusals (review round 1)', () => {
  it('a send refused because the session is gone reads it again and says why; handed off offers discard without a creative name', async () => {
    api.getBriefSession.mockResolvedValue(view());
    render(page());
    await waitFor(() => expect(api.getBriefSession).toHaveBeenCalledTimes(1));
    api.sendBriefMessage.mockRejectedValueOnce(new ApiError(409, 'Questa sessione del brief è finita', 'brief-session-gone'));
    await userEvent.type(box(), 'Ciao');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(api.getBriefSession).toHaveBeenCalledTimes(2));
    const panel = screen.getByRole('complementary', { name: "Sessione con l'agente" });
    expect(within(panel).getAllByText(/Questa sessione del brief è finita/).length).toBeGreaterThan(0);
    expect(within(panel).queryByRole('button', { name: 'Scarta la sessione' })).toBeNull();
    api.sendBriefMessage.mockRejectedValueOnce(new ApiError(409, 'Spostata in una creatività', 'brief-session-handed-off'));
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await userEvent.click(await within(panel).findByRole('button', { name: 'Scarta la sessione' }));
    await waitFor(() => expect(api.discardBriefSession).toHaveBeenCalledWith('acme', 's1'));
    api.getBriefSession.mockResolvedValue(null);
  });
});
