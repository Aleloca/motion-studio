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

const live = (over: Partial<EventsState> = {}): EventsState => ({ ...initialEventsState, ...over });
const fillTick = (n: number, written: BriefSessionView['agentFields'], reclaimed: BriefSessionView['agentFields'] = []) =>
  live({ briefTicks: { acme: n }, briefFills: { acme: { sessionId: 's1', seq: n, written, reclaimed } } });
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
