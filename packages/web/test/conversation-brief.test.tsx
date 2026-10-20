import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentCapabilities, ConversationEntry, JobSummary, QueuedRequest } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

let caps: AgentCapabilities = { cliVersion: '2.1.301', liveInput: true, interrupt: true, checkedAt: '2026-10-20T10:00:00.000Z' };
const api = {
  sendCreativeTurn: vi.fn(async () => ({ id: 'j9' })),
  postLiveMessage: vi.fn(async () => ({ outcome: 'delivered-pending' })),
  getAgentCapabilities: vi.fn(async () => caps),
  stopJob: vi.fn(async () => ({ status: 'stopping' })),
  removeQueued: vi.fn(async () => ({})),
  runNext: vi.fn(async () => ({})),
};
class ApiError extends Error { constructor(public status: number, m: string, public code?: string) { super(m); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { Conversation } = await import('../src/components/Conversation.tsx');

const at = '2026-10-20T10:00:00.000Z';
const running: JobSummary = { id: 'b1', key: 'brief:/w:acme', kind: 'brief', label: 'Acme · brief', state: 'running', createdAt: at };
const transport = () => ({
  start: vi.fn(async (_b: { clientId: string; text: string }): Promise<JobSummary | null> => running),
  post: vi.fn(async (_b: { clientId: string; text: string; mode: 'live' | 'queued' }) => ({ outcome: 'delivered-pending' as const })),
});
type Extra = Partial<React.ComponentProps<typeof Conversation>>;
const view = (p: Extra, locale: 'it' | 'en' = 'it') => (
  <I18nProvider locale={locale}><Conversation slug="acme" creative="" entries={[]} approvals={[]} job={undefined} {...p} /></I18nProvider>
);
const box = () => screen.getByRole('textbox', { name: "Messaggio all'agente" }) as HTMLTextAreaElement;

beforeEach(() => { vi.clearAllMocks(); caps = { cliVersion: '2.1.301', liveInput: true, interrupt: true, checkedAt: at }; });

describe('Conversation · a brief session (decision 1422)', () => {
  it('sends through the transport: a new turn when idle, a live or queued message while the agent works', async () => {
    const tr = transport();
    const { rerender } = render(view({ transport: tr, composerLabel: "Messaggio all'agente" }));
    await userEvent.type(box(), 'Video di lancio');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(tr.start).toHaveBeenCalledOnce());
    expect(tr.start.mock.calls[0]![0].text).toBe('Video di lancio');
    expect(api.sendCreativeTurn).not.toHaveBeenCalled();
    rerender(view({ transport: tr, composerLabel: "Messaggio all'agente", job: running }));
    await waitFor(() => expect(api.getAgentCapabilities).toHaveBeenCalled());
    await screen.findByRole('button', { name: 'Altri modi di inviare' });
    await userEvent.type(box(), 'Più corto');
    await userEvent.click(screen.getByRole('button', { name: 'Invia all’agente' }));
    await waitFor(() => expect(tr.post).toHaveBeenCalledOnce());
    expect(tr.post.mock.calls[0]![0]).toMatchObject({ text: 'Più corto', mode: 'live' });
    await userEvent.type(box(), 'Poi il logo');
    await userEvent.click(screen.getByRole('button', { name: 'Altri modi di inviare' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Metti in coda per dopo' }));
    await waitFor(() => expect(tr.post).toHaveBeenCalledTimes(2));
    expect(tr.post.mock.calls[1]![0]).toMatchObject({ text: 'Poi il logo', mode: 'queued' });
    expect(api.postLiveMessage).not.toHaveBeenCalled();
  });

  it('a brief job has Stop, never "Stop and redirect"', async () => {
    render(view({ transport: transport(), job: running }));
    expect(await screen.findByRole('button', { name: 'Ferma' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Opzioni di arresto' })).toBeNull();
  });

  it('a draft fills the box once per nonce and is never sent', async () => {
    const tr = transport();
    const { rerender } = render(view({ transport: tr, composerLabel: "Messaggio all'agente", draft: { text: 'Video di lancio', nonce: 1 } }));
    expect(box().value).toBe('Video di lancio');
    await userEvent.clear(box());
    rerender(view({ transport: tr, composerLabel: "Messaggio all'agente", draft: { text: 'Video di lancio', nonce: 1 } }));
    expect(box().value).toBe('');
    rerender(view({ transport: tr, composerLabel: "Messaggio all'agente", draft: { text: 'Altro', nonce: 2 } }));
    expect(box().value).toBe('Altro');
    expect(tr.start).not.toHaveBeenCalled();
  });

  it('places the intro and the composer slots, with the given placeholder', () => {
    render(view({
      transport: transport(), composerLabel: "Messaggio all'agente", placeholder: 'Chiedi una modifica al brief…',
      intro: <p>Benvenuto</p>, composerTop: <span>pins</span>, composerTools: <button type="button">più</button>, composerBelow: <span>contesto</span>,
      entries: [{ type: 'user', at, text: 'Ciao', pins: [], attachments: [] } as unknown as ConversationEntry],
    }));
    const log = screen.getByRole('log');
    const items = within(log).getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('Benvenuto');
    expect(items[1]!.textContent).toContain('Ciao');
    const form = box().closest('form')!;
    const boxEl = form.querySelector('.ms-composer-box')!;
    expect(boxEl.firstElementChild!.textContent).toBe('pins');
    expect(form.querySelector('.ms-composer-foot')!.firstElementChild!.textContent).toBe('più');
    expect(form.nextElementSibling?.textContent).toBe('contesto');
    expect(box().placeholder).toContain('Chiedi una modifica al brief…');
    expect(screen.queryByText('Ancora nessun messaggio')).toBeNull();
  });

  it("shows a message's added context as chips and the brief line as the creative's start", () => {
    render(view({
      entries: [
        { type: 'user', at, text: 'Ecco il codice', pins: [], attachments: [], context: { codebases: ['/c/app'], assets: ['assets/logo.svg'] } } as unknown as ConversationEntry,
        { type: 'system', at, level: 'info', origin: 'brief', text: 'Lancio · 2 formati. La sessione del brief resta qui sopra.' },
      ],
    }));
    const msg = screen.getByText('Ecco il codice').closest('article')!;
    expect(within(msg).getByText('/c/app')).toBeTruthy();
    expect(within(msg).getByText('logo.svg')).toBeTruthy();
    expect(screen.getByText('Creatività creata')).toBeTruthy();
    expect(screen.getByText('Lancio · 2 formati. La sessione del brief resta qui sopra.').closest('.ms-convo-version')).toBeTruthy();
  });

  it('with queue operations the queue offers remove only', async () => {
    const remove = vi.fn(async (_id: string) => undefined);
    const queued: QueuedRequest[] = [{ clientId: 'q1', text: 'Poi il logo', pins: [], at }];
    render(view({ transport: transport(), job: running, queued, queueOps: { remove } }));
    const item = await screen.findByRole('listitem', { name: 'Richiesta in coda 1' });
    expect(within(item).queryByRole('button', { name: /Modifica/ })).toBeNull();
    expect(within(item).queryByRole('button', { name: /Sposta/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Avvia la prossima' })).toBeNull();
    await userEvent.click(within(item).getByRole('button', { name: 'Togli la richiesta in coda 1' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('q1'));
    expect(api.removeQueued).not.toHaveBeenCalled();
  });
});
