import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, EMPTY_BRAND_KIT, EMPTY_BRIEF_FORM, type AssetEntry, type BriefSessionView, type ConversationEntry } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { initialEventsState, type EventsState } from '../src/eventsReducer.ts';

const at = '2026-10-20T10:00:00.000Z';
const asset = (file: string): AssetEntry => ({ file, kind: 'image', origin: 'upload', sourceUrl: null, description: '', tags: [], width: 100, height: 100, addedAt: at, attribution: null });
const view = (over: Partial<BriefSessionView> = {}): BriefSessionView => ({
  id: 's1', createdAt: at, updatedAt: at, context: { codebases: [], assets: [] }, form: EMPTY_BRIEF_FORM, userEdited: [], agentFields: [], queued: [], jobId: null, revision: 1, ...over,
});
class ApiError extends Error { constructor(public status: number, m: string, public code?: string) { super(m); } }
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  listAssets: vi.fn(async () => ({ assets: [asset('foto.jpg'), asset('logo.png')], error: null, unregistered: [] })),
  getBrand: vi.fn(async () => ({ kit: EMPTY_BRAND_KIT, kitError: null, guidelines: '', sources: [], sourcesError: null, proposals: [], jobKey: 'k' })),
  projectFileUrl: (s: string, rel: string) => `/files/${s}/${rel}`,
  createCreative: vi.fn(async (_slug: string, _body: unknown) => ({ slug: '2026-10-20-lancio', creative: {}, job: null })),
  getFirstGenerations: vi.fn(async () => ({ tokens: [] })),
  getSecrets: vi.fn(async () => []),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: false, interrupt: false, checkedAt: at })),
  getBriefSession: vi.fn(async (_slug: string): Promise<BriefSessionView | null> => view()),
  getBriefConversation: vi.fn(async (): Promise<ConversationEntry[]> => []),
  startBriefSession: vi.fn(async () => view()),
  sendBriefMessage: vi.fn(async () => ({ outcome: 'queued' as const })),
  saveBriefForm: vi.fn(async (_s: string, _id: string, b: { form: typeof EMPTY_BRIEF_FORM; userEdited: string[]; baseRevision: number }) => ({ ok: true, form: b.form, userEdited: b.userEdited, agentFields: [], revision: b.baseRevision + 1 })),
  setBriefContext: vi.fn(async () => view()),
  removeBriefQueued: vi.fn(async () => view()),
  discardBriefSession: vi.fn(async () => undefined),
  uploadFiles: vi.fn(async () => ({ assets: [] })),
  stopJob: vi.fn(async () => ({ status: 'stopping' })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const motion = vi.hoisted(() => ({ glow: vi.fn(async (_el: Element | null) => true), tileIn: vi.fn(async (_el: Element | null, _d?: number) => true) }));
vi.mock('../src/motion/motion.ts', async (orig) => ({ ...(await orig<typeof import('../src/motion/motion.ts')>()), glow: motion.glow, tileIn: motion.tileIn }));
const { NewCreative } = await import('../src/screens/NewCreative.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { takeFrameOrigin } = await import('../src/shell/intents.ts');

const live = (over: Partial<EventsState> = {}): EventsState => ({ ...initialEventsState, ...over });
const fillTick = (n: number, written: BriefSessionView['agentFields'], reclaimed: BriefSessionView['agentFields'] = []) =>
  live({ briefTicks: { acme: n }, briefFills: { acme: [{ sessionId: 's1', seq: n, written, reclaimed }] } });
const page = (l: EventsState) => <I18nProvider locale="it"><NewCreative slug="acme" live={l} /></I18nProvider>;
const goal = () => screen.getByLabelText('Cosa vuoi realizzare?') as HTMLTextAreaElement;
const board = () => waitFor(() => screen.getByRole('group', { name: 'Instagram' }));
const rowOf = (text: string) => screen.getAllByText(new RegExp(`^${text}`)).map((el) => el.closest('.ms-nc-qrow, .ms-nc-row, .ms-nc-boardhead')).find(Boolean) as HTMLElement;
const lastSave = () => api.saveBriefForm.mock.calls.at(-1)![2];

beforeEach(() => { vi.clearAllMocks(); location.hash = ''; });

describe('NewCreative · the agent fills the form (decision 1422)', () => {
  it('an agent fill fills the fields and marks them', async () => {
    const { rerender } = render(page(live()));
    await board();
    await waitFor(() => expect(api.getBriefSession).toHaveBeenCalled());
    api.getBriefSession.mockResolvedValueOnce(view({ revision: 2, form: { ...EMPTY_BRIEF_FORM, goal: 'Video di lancio', formats: ['instagram-post-1x1'] }, agentFields: ['goal', 'formats'] }));
    rerender(page(fillTick(1, ['goal', 'formats'])));
    await waitFor(() => expect(goal().value).toBe('Video di lancio'));
    const ig = screen.getByRole('group', { name: 'Instagram' });
    expect(within(ig).getByRole('button', { name: /Post 1:1/ }).getAttribute('aria-pressed')).toBe('true');
    expect(within(rowOf('Cosa vuoi realizzare?')).getByText('Agente')).toBeTruthy();
    expect(within(rowOf('Dove verrà pubblicata?')).getByText('Agente')).toBeTruthy();
    await waitFor(() => expect(motion.glow).toHaveBeenCalledTimes(1));
    expect(motion.glow.mock.calls[0]![0]).toBe(goal().closest('.ms-nc-goalbox'));
    expect(motion.tileIn).toHaveBeenCalled();
  });

  it('a fill never replaces a field edited locally since the last save', async () => {
    const { rerender } = render(page(live()));
    await board();
    await waitFor(() => expect(api.getBriefSession).toHaveBeenCalled());
    await userEvent.type(goal(), 'Il mio testo');
    api.getBriefSession.mockResolvedValueOnce(view({ revision: 2, form: { ...EMPTY_BRIEF_FORM, goal: "Testo dell'agente", message: 'Una casella' }, agentFields: ['goal', 'message'] }));
    rerender(page(fillTick(1, ['goal', 'message'])));
    await waitFor(() => expect((screen.getByLabelText(/Messaggio chiave/) as HTMLInputElement).value).toBe('Una casella'));
    expect(goal().value).toBe('Il mio testo');
    expect(within(rowOf('Cosa vuoi realizzare?')).queryByText('Agente')).toBeNull();
    // The next save carries the user's text as theirs.
    await waitFor(() => expect(api.saveBriefForm).toHaveBeenCalled(), { timeout: 2000 });
    expect(lastSave().form.goal).toBe('Il mio testo');
    expect(lastSave().userEdited).toContain('goal');
  });

  it('an edit removes the mark and makes the field the user\'s', async () => {
    const { rerender } = render(page(live()));
    await board();
    await waitFor(() => expect(api.getBriefSession).toHaveBeenCalled());
    api.getBriefSession.mockResolvedValueOnce(view({ revision: 2, form: { ...EMPTY_BRIEF_FORM, message: 'Una casella' }, agentFields: ['message'] }));
    rerender(page(fillTick(1, ['message'])));
    const msg = () => screen.getByLabelText(/Messaggio chiave/) as HTMLInputElement;
    await waitFor(() => expect(msg().value).toBe('Una casella'));
    expect(within(rowOf('Messaggio chiave')).getByText('Agente')).toBeTruthy();
    await userEvent.type(msg(), ' sola');
    expect(within(rowOf('Messaggio chiave')).queryByText('Agente')).toBeNull();
    await waitFor(() => expect(api.saveBriefForm).toHaveBeenCalled(), { timeout: 2000 });
    expect(lastSave()).toMatchObject({ baseRevision: 2, userEdited: ['message'] });
    expect(lastSave().form.message).toBe('Una casella sola');
  });

  it('one hand change makes a list the user\'s', async () => {
    const { rerender } = render(page(live()));
    await board();
    await waitFor(() => expect(api.getBriefSession).toHaveBeenCalled());
    api.getBriefSession.mockResolvedValueOnce(view({ revision: 2, form: { ...EMPTY_BRIEF_FORM, assets: ['assets/foto.jpg', 'assets/logo.png'] }, agentFields: ['assets'] }));
    rerender(page(fillTick(1, ['assets'])));
    const remove = await screen.findByRole('button', { name: 'Rimuovi foto.jpg' });
    await userEvent.click(remove);
    await waitFor(() => expect(api.saveBriefForm).toHaveBeenCalled(), { timeout: 2000 });
    expect(lastSave().userEdited).toEqual(['assets']);
    expect(lastSave().form.assets).toEqual(['assets/logo.png']);
  });

  it('without a session nothing is saved', async () => {
    api.getBriefSession.mockResolvedValueOnce(null);
    render(page(live()));
    await board();
    await userEvent.type(goal(), 'Lancio');
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
    expect(api.saveBriefForm).not.toHaveBeenCalled();
  });
});

const job = (state: 'running' | 'queued' | 'succeeded' = 'running') => ({ id: 'b1', key: 'brief:/w:acme', kind: 'brief' as const, label: 'l', state, createdAt: at });
const userEntry = { type: 'user', at, text: 'Video di lancio', pins: [], attachments: [] } as unknown as ConversationEntry;
function Shelled({ l }: { l: EventsState }) {
  const shell = {
    route: { name: 'new-creative', slug: 'acme' }, live: l,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as never;
  return <I18nProvider locale="it"><ShellContext.Provider value={shell}><TopBar /><NewCreative slug="acme" live={l} /></ShellContext.Provider></I18nProvider>;
}
const modes = () => within(document.querySelector('header.ms-topbar') as HTMLElement).getByRole('radiogroup', { name: 'Come compilare il brief' });
const panel = () => document.querySelector('.ms-nc-panel') as HTMLElement;
const draftBox = () => within(panel()).getByRole('textbox', { name: "Messaggio all'agente" }) as HTMLTextAreaElement;

describe('NewCreative · Con l\'agente (decisions 1410–1411, 1419, 1422)', () => {
  it('the mode switch sits in the bar, "Compila tu" first; "Con l\'agente" opens the panel', async () => {
    api.getBriefSession.mockResolvedValueOnce(null);
    render(<Shelled l={live()} />);
    await board();
    const seg = await waitFor(() => modes());
    expect(within(seg).getByRole('radio', { name: 'Compila tu' }).getAttribute('aria-checked')).toBe('true');
    expect(panel().getAttribute('aria-hidden')).toBe('true');
    await userEvent.click(within(seg).getByRole('radio', { name: "Con l'agente" }));
    expect(document.querySelector('.ms-nc')!.classList.contains('ms-nc-agent')).toBe(true);
    expect(panel().getAttribute('aria-hidden')).toBeNull();
    await userEvent.click(within(modes()).getByRole('radio', { name: 'Compila tu' }));
    expect(panel().getAttribute('aria-hidden')).toBe('true');
  });

  it('"Fallo compilare all\'agente" moves the goal into the composer, not sent, and the goal is not the user\'s', async () => {
    api.getBriefSession.mockResolvedValueOnce(null);
    render(page(live()));
    await board();
    await userEvent.type(goal(), 'Video di lancio');
    await userEvent.click(screen.getByRole('button', { name: "Fallo compilare all'agente" }));
    expect(document.querySelector('.ms-nc')!.classList.contains('ms-nc-agent')).toBe(true);
    expect(goal().value).toBe('');
    expect(draftBox().value).toBe('Video di lancio');
    expect(screen.queryByRole('button', { name: "Fallo compilare all'agente" })).toBeNull();
    expect(api.sendBriefMessage).not.toHaveBeenCalled();
    // The first message opens the session with the goal not marked as the user's.
    await userEvent.click(within(panel()).getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(api.startBriefSession).toHaveBeenCalled());
    expect((api.startBriefSession.mock.calls[0] as unknown[])[1]).toMatchObject({ userEdited: [] });
  });

  it('an idle session with messages asks: Riprendi brings back the form in Con l\'agente', async () => {
    api.getBriefSession.mockResolvedValue(view({ form: { ...EMPTY_BRIEF_FORM, goal: 'Lancio di Audin' }, agentFields: ['goal'] }));
    api.getBriefConversation.mockResolvedValue([userEntry]);
    render(page(live()));
    const dialog = await screen.findByRole('dialog', { name: 'Hai una sessione del brief in corso' });
    expect(goal().value).toBe('');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Riprendi la sessione del brief' }));
    await waitFor(() => expect(goal().value).toBe('Lancio di Audin'));
    expect(document.querySelector('.ms-nc')!.classList.contains('ms-nc-agent')).toBe(true);
    expect(within(rowOf('Cosa vuoi realizzare?')).getByText('Agente')).toBeTruthy();
    api.getBriefSession.mockResolvedValue(view());
    api.getBriefConversation.mockResolvedValue([]);
  });

  it('Inizia da capo discards the session and stays in Compila tu with an empty form', async () => {
    api.getBriefSession.mockResolvedValueOnce(view({ form: { ...EMPTY_BRIEF_FORM, goal: 'Lancio di Audin' } }));
    api.getBriefConversation.mockResolvedValueOnce([userEntry]);
    render(page(live()));
    const dialog = await screen.findByRole('dialog', { name: 'Hai una sessione del brief in corso' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Inizia da capo' }));
    await waitFor(() => expect(api.discardBriefSession).toHaveBeenCalledWith('acme', 's1'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Hai una sessione del brief in corso' })).toBeNull());
    expect(goal().value).toBe('');
    expect(document.querySelector('.ms-nc')!.classList.contains('ms-nc-agent')).toBe(false);
  });

  it('a session the agent is working on reopens in Con l\'agente without asking; Genera waits for it', async () => {
    api.getBriefSession.mockResolvedValueOnce(view({ jobId: 'b1', form: { ...EMPTY_BRIEF_FORM, goal: 'Lancio', formats: ['instagram-post-1x1'], durationSec: 6 } }));
    api.getBriefConversation.mockResolvedValueOnce([userEntry]);
    render(page(live({ jobs: { b1: job() } })));
    await waitFor(() => expect(document.querySelector('.ms-nc')!.classList.contains('ms-nc-agent')).toBe(true));
    expect(screen.queryByRole('dialog', { name: 'Hai una sessione del brief in corso' })).toBeNull();
    await waitFor(() => expect(goal().value).toBe('Lancio'));
    const genera = screen.getByRole('button', { name: 'Genera' });
    expect(genera.hasAttribute('disabled')).toBe(true);
    expect(genera.getAttribute('title')).toBe("L'agente sta compilando il brief");
    expect(screen.getByRole('button', { name: 'Salva bozza' }).hasAttribute('disabled')).toBe(true);
  });

  it('Genera with a session hands it over, with the panel origin for the canvas; group with variants', async () => {
    api.getBriefSession.mockResolvedValue(view({ form: { ...EMPTY_BRIEF_FORM, goal: 'Lancio', formats: ['instagram-post-1x1'], durationSec: 6 }, agentFields: ['goal', 'formats'] }));
    const { rerender } = render(<Shelled l={live()} />);
    await waitFor(() => expect(goal().value).toBe('Lancio'));
    await userEvent.click(within(modes()).getByRole('radio', { name: "Con l'agente" }));
    await userEvent.click(screen.getByRole('button', { name: 'Genera' }));
    await waitFor(() => expect(api.createCreative).toHaveBeenCalledOnce());
    expect((api.createCreative.mock.calls[0]![1] as { briefSession: unknown }).briefSession).toEqual({ id: 's1', group: false });
    expect(takeFrameOrigin('brief-panel:acme/2026-10-20-lancio')).not.toBeNull();
    await waitFor(() => expect(location.hash).toBe('#/p/acme/c/2026-10-20-lancio'));
    rerender(<div />);
    api.getBriefSession.mockResolvedValue(view());
  });

  it('Genera from Compila tu leaves no panel origin; Salva bozza sends the session too', async () => {
    api.getBriefSession.mockResolvedValue(view({ form: { ...EMPTY_BRIEF_FORM, goal: 'Lancio', formats: ['instagram-post-1x1'], durationSec: 6 } }));
    render(page(live()));
    await waitFor(() => expect(goal().value).toBe('Lancio'));
    await userEvent.click(screen.getByRole('button', { name: 'Salva bozza' }));
    await waitFor(() => expect(api.createCreative).toHaveBeenCalledOnce());
    expect(api.createCreative.mock.calls[0]![1]).toMatchObject({ generate: false, briefSession: { id: 's1', group: false } });
    expect(takeFrameOrigin('brief-panel:acme/2026-10-20-lancio')).toBeNull();
    api.getBriefSession.mockResolvedValue(view());
  });

  it('with Varianti 3 the session goes to the group', async () => {
    api.getBriefSession.mockResolvedValue(view({ form: { ...EMPTY_BRIEF_FORM, goal: 'Lancio', formats: ['instagram-post-1x1'], variants: 3, durationSec: 6 } }));
    (api as Record<string, unknown>).addVariants = vi.fn(async () => ({}));
    (api as Record<string, unknown>).runVariants = vi.fn(async () => ({ jobs: {}, queued: [], skipped: [], failed: {} }));
    render(page(live()));
    await waitFor(() => expect(goal().value).toBe('Lancio'));
    await userEvent.click(screen.getByRole('button', { name: 'Genera' }));
    await waitFor(() => expect(api.createCreative).toHaveBeenCalledOnce());
    expect(api.createCreative.mock.calls[0]![1]).toMatchObject({ briefSession: { id: 's1', group: true } });
    api.getBriefSession.mockResolvedValue(view());
  });
});

/** A small stand-in for the core's form merge (brief-tools `mergeClientForm`): enough for the save scenarios below. */
function fakeCore(start: BriefSessionView) {
  let s = { ...start };
  api.getBriefSession.mockImplementation(async () => ({ ...s }));
  api.saveBriefForm.mockImplementation(async (_slug: string, _id: string, b: { form: typeof EMPTY_BRIEF_FORM; userEdited: string[]; baseRevision: number }) => {
    const form = { ...s.form } as Record<string, unknown>;
    const userEdited: string[] = [];
    for (const f of Object.keys(s.form)) {
      const clientOwns = b.userEdited.includes(f);
      if (s.userEdited.includes(f as never) || clientOwns) { form[f] = (b.form as Record<string, unknown>)[f]; if (clientOwns) userEdited.push(f); }
    }
    const changed = JSON.stringify(form) !== JSON.stringify(s.form) || JSON.stringify(userEdited) !== JSON.stringify(s.userEdited);
    s = { ...s, form: form as typeof EMPTY_BRIEF_FORM, userEdited: userEdited as never, agentFields: s.agentFields.filter((f) => !userEdited.includes(f)), revision: s.revision + (changed ? 1 : 0) };
    return { ok: true, form: s.form, userEdited: s.userEdited as string[], agentFields: s.agentFields as never[], revision: s.revision };
  });
  return { get: () => s, set: (next: Partial<BriefSessionView>) => { s = { ...s, ...next, revision: s.revision + 1 }; } };
}

describe('NewCreative · review round 1 (decisions 1422–1423)', () => {
  it('a rewrite the user asked for is not undone by the next save, even when its fill was missed (reconnection)', async () => {
    const core = fakeCore(view({ form: { ...EMPTY_BRIEF_FORM, goal: 'Il mio testo', durationSec: 6 }, userEdited: ['goal'], revision: 2 }));
    const { rerender } = render(page(live()));
    await waitFor(() => expect(goal().value).toBe('Il mio testo'));
    // The agent rewrote the goal on the user's request; this page missed the fill (only a reconnection tells).
    core.set({ form: { ...core.get().form, goal: "Riscritto dall'agente" }, userEdited: [], agentFields: ['goal'] });
    rerender(page(live({ snapshots: 1 })));
    await waitFor(() => expect(goal().value).toBe("Riscritto dall'agente"));
    await userEvent.type(screen.getByLabelText(/Messaggio chiave/), 'Una casella');
    await waitFor(() => expect(api.saveBriefForm).toHaveBeenCalled(), { timeout: 2000 });
    expect(lastSave().form.goal).toBe("Riscritto dall'agente");
    expect(lastSave().userEdited).not.toContain('goal');
    expect(core.get().form.goal).toBe("Riscritto dall'agente");
    api.getBriefSession.mockImplementation(async () => view());
  });

  it('owned goal, a load out, a fill reclaiming the goal then a fill writing the message: the save keeps the rewrite', async () => {
    const core = fakeCore(view({ form: { ...EMPTY_BRIEF_FORM, goal: 'Il mio testo', durationSec: 6 }, userEdited: ['goal'], revision: 2 }));
    const { rerender } = render(page(live()));
    await waitFor(() => expect(goal().value).toBe('Il mio testo'));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    api.getBriefSession.mockImplementationOnce(async () => { await gate; return { ...core.get() }; });
    rerender(page(live({ snapshots: 1 })));
    core.set({ form: { ...core.get().form, goal: "Riscritto dall'agente" }, userEdited: [], agentFields: ['goal'] });
    const f1 = { sessionId: 's1', seq: 1, written: [] as never[], reclaimed: ['goal' as const] };
    rerender(page(live({ snapshots: 1, briefTicks: { acme: 1 }, briefFills: { acme: [f1] } })));
    core.set({ form: { ...core.get().form, message: 'Una casella' }, agentFields: ['goal', 'message'] });
    const f2 = { sessionId: 's1', seq: 2, written: ['message' as const], reclaimed: [] as never[] };
    rerender(page(live({ snapshots: 1, briefTicks: { acme: 2 }, briefFills: { acme: [f1, f2] } })));
    release();
    await waitFor(() => expect(goal().value).toBe("Riscritto dall'agente"));
    await waitFor(() => expect((screen.getByLabelText(/Messaggio chiave/) as HTMLInputElement).value).toBe('Una casella'));
    await userEvent.click(screen.getByRole('button', { name: 'Altre opzioni' }));
    await userEvent.type(screen.getByLabelText(/Note per l'agente/), 'x');
    await waitFor(() => expect(api.saveBriefForm).toHaveBeenCalled(), { timeout: 2000 });
    expect(core.get().form.goal).toBe("Riscritto dall'agente");
    expect(core.get().userEdited).not.toContain('goal');
    api.getBriefSession.mockImplementation(async () => view());
  });

  it("the CTA with a session saves the emptied goal, so the old one never comes back (agent used, back to Compila tu)", async () => {
    const core = fakeCore(view({ form: { ...EMPTY_BRIEF_FORM, goal: "Testo dell'agente", durationSec: 6 }, agentFields: ['goal'], revision: 2 }));
    const { rerender } = render(page(live()));
    await waitFor(() => expect(goal().value).toBe("Testo dell'agente"));
    await userEvent.clear(goal());
    await userEvent.type(goal(), 'Video nuovo');
    await waitFor(() => expect(core.get().form.goal).toBe('Video nuovo'), { timeout: 2000 });
    await userEvent.click(screen.getByRole('button', { name: "Fallo compilare all'agente" }));
    expect(draftBox().value).toBe('Video nuovo');
    await waitFor(() => expect(core.get().form.goal).toBe(''));
    expect(core.get().userEdited).not.toContain('goal');
    // The next view of the session leaves the goal empty: the text is only in the composer.
    rerender(page(live({ briefTicks: { acme: 1 } })));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(goal().value).toBe('');
    expect(draftBox().value).toBe('Video nuovo');
    // The composer has the focus.
    await waitFor(() => expect(document.activeElement).toBe(draftBox()));
    api.getBriefSession.mockImplementation(async () => view());
  });

  it("the CTA on the agent's own goal: saved empty in two steps (the core takes a value only for the user's field)", async () => {
    const core = fakeCore(view({ form: { ...EMPTY_BRIEF_FORM, goal: "Testo dell'agente", durationSec: 6 }, agentFields: ['goal'], revision: 2 }));
    render(page(live()));
    await waitFor(() => expect(goal().value).toBe("Testo dell'agente"));
    await userEvent.click(screen.getByRole('button', { name: "Fallo compilare all'agente" }));
    await waitFor(() => expect(api.saveBriefForm).toHaveBeenCalledTimes(2));
    expect(core.get().form.goal).toBe('');
    expect(core.get().userEdited).not.toContain('goal');
    api.getBriefSession.mockImplementation(async () => view());
  });

  it('Genera refused because the session was half moved: the error offers to discard it, also in Compila tu; the session is read again', async () => {
    api.getBriefSession.mockResolvedValue(view({ form: { ...EMPTY_BRIEF_FORM, goal: 'Lancio', formats: ['instagram-post-1x1'], durationSec: 6 } }));
    api.createCreative.mockRejectedValueOnce(new ApiError(409, 'Questa sessione del brief è stata spostata in una creatività', 'brief-session-handed-off'));
    render(page(live()));
    await waitFor(() => expect(goal().value).toBe('Lancio'));
    const calls = api.getBriefSession.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Genera' }));
    const alert = await waitFor(() => screen.getAllByRole('alert').find((a) => a.textContent?.includes('spostata'))!);
    await waitFor(() => expect(api.getBriefSession.mock.calls.length).toBeGreaterThan(calls));
    await userEvent.click(within(alert).getByRole('button', { name: 'Scarta la sessione' }));
    await waitFor(() => expect(api.discardBriefSession).toHaveBeenCalledWith('acme', 's1'));
    api.getBriefSession.mockResolvedValue(view());
  });

  it('a first read that fails: nothing in Compila tu; in Con l\'agente the panel says it with Riprova, nothing can be sent, and the resume question still comes', async () => {
    api.getBriefSession.mockRejectedValueOnce(new ApiError(500, 'EMFILE'));
    render(page(live()));
    await board();
    await waitFor(() => expect(api.getBriefSession).toHaveBeenCalled());
    expect(screen.queryAllByRole('alert').filter((a) => a.textContent?.includes('EMFILE'))).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: "Fallo compilare all'agente" }));
    const alert = await waitFor(() => within(panel()).getAllByRole('alert').find((a) => a.textContent?.includes('EMFILE'))!);
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.type(draftBox(), 'Ciao');
    expect(within(panel()).getByRole('button', { name: 'Invia' }).hasAttribute('disabled')).toBe(true);
    expect(within(panel()).getByRole('button', { name: 'Aggiungi cartelle o asset' }).hasAttribute('disabled')).toBe(true);
    api.getBriefSession.mockResolvedValueOnce(view({ form: { ...EMPTY_BRIEF_FORM, goal: 'Lancio' } }));
    api.getBriefConversation.mockResolvedValueOnce([userEntry]);
    await userEvent.click(within(alert).getByRole('button', { name: 'Riprova' }));
    expect(await screen.findByRole('dialog', { name: 'Hai una sessione del brief in corso' })).toBeTruthy();
  });

  it('an edit made before the session existed, carried by the first message, does not hold off a rewrite seen after a reconnection', async () => {
    api.getBriefSession.mockResolvedValueOnce(null);
    api.startBriefSession.mockImplementationOnce((async (_s: string, b: { form: typeof EMPTY_BRIEF_FORM; userEdited: never[] }) => view({ form: b.form, userEdited: b.userEdited, revision: 1 })) as never);
    const { rerender } = render(page(live()));
    await board();
    await userEvent.type(goal(), 'Il mio testo');
    await userEvent.click(screen.getByRole('button', { name: "Fallo compilare all'agente" }));
    await userEvent.type(draftBox(), 'Scrivi tu');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(api.sendBriefMessage).toHaveBeenCalled());
    await userEvent.type(goal(), 'Obiettivo mio');
    await waitFor(() => expect(api.saveBriefForm).toHaveBeenCalled(), { timeout: 2000 });
    api.getBriefSession.mockResolvedValue(view({ form: { ...EMPTY_BRIEF_FORM, goal: "Riscritto dall'agente" }, userEdited: [], agentFields: ['goal'], revision: 9 }));
    rerender(page(live({ snapshots: 1 })));
    await waitFor(() => expect(goal().value).toBe("Riscritto dall'agente"));
    api.getBriefSession.mockResolvedValue(view());
  });

  it('the CTA: when giving the goal back fails, it is given back by the next save (never left the user\'s and empty)', async () => {
    const core = fakeCore(view({ form: { ...EMPTY_BRIEF_FORM, goal: "Testo dell'agente", durationSec: 6 }, agentFields: ['goal'], revision: 2 }));
    const real = api.saveBriefForm.getMockImplementation()!;
    let n = 0;
    api.saveBriefForm.mockImplementation(async (...a: Parameters<typeof real>) => { n += 1; if (n === 2) throw new ApiError(500, 'EIO'); return real(...a); });
    render(page(live()));
    await waitFor(() => expect(goal().value).toBe("Testo dell'agente"));
    await userEvent.click(screen.getByRole('button', { name: "Fallo compilare all'agente" }));
    await waitFor(() => expect(n).toBeGreaterThanOrEqual(3), { timeout: 3000 });
    await waitFor(() => expect(core.get().userEdited).not.toContain('goal'));
    expect(core.get().form.goal).toBe('');
    expect(goal().value).toBe('');
    api.getBriefSession.mockImplementation(async () => view());
  });

  it('Genera refused because the session is gone: the footer says Genera now goes without it, and the next one does', async () => {
    api.getBriefSession.mockResolvedValueOnce(view({ form: { ...EMPTY_BRIEF_FORM, goal: 'Lancio', formats: ['instagram-post-1x1'], durationSec: 6 } }));
    api.createCreative.mockRejectedValueOnce(new ApiError(409, 'finita', 'brief-session-gone'));
    render(page(live()));
    await waitFor(() => expect(goal().value).toBe('Lancio'));
    api.getBriefSession.mockResolvedValue(null);
    await userEvent.click(screen.getByRole('button', { name: 'Genera' }));
    await waitFor(() => expect(screen.getByText(/premi di nuovo Genera per creare la creatività senza/)).toBeTruthy());
    expect(within(panel()).queryAllByRole('alert', { hidden: true }).filter((a) => a.textContent?.includes('finita'))).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Genera' }));
    await waitFor(() => expect(api.createCreative).toHaveBeenCalledTimes(2));
    expect((api.createCreative.mock.calls[1]![1] as { briefSession?: unknown }).briefSession).toBeUndefined();
    api.getBriefSession.mockResolvedValue(view());
  });
});
