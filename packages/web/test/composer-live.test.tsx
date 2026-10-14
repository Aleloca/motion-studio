import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentCapabilities, AgentEvent, ConversationEntry, JobSummary, LiveMessageOutcome, QueuedRequest } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

const CAPS_OFF: AgentCapabilities = { cliVersion: null, liveInput: false, interrupt: false, checkedAt: '2026-10-14T10:00:00.000Z' };
let caps: AgentCapabilities = CAPS_OFF;
let outcome: LiveMessageOutcome = 'delivered-pending';
const api = {
  sendCreativeTurn: vi.fn(async () => ({ id: 'j9' })),
  stopJob: vi.fn(async (_id: string) => ({ status: 'stopping' })),
  redirectJob: vi.fn(async (_id: string, _b: unknown) => ({ outcome: 'restarted' as const })),
  getAgentCapabilities: vi.fn(async () => caps),
  postLiveMessage: vi.fn(async (_s: string, _c: string, b: { clientId: string; text: string; mode: string }) => ({ entry: { type: 'user' as const, at: '2026-10-14T10:05:00.000Z', text: b.text, pins: [], attachments: [] }, outcome })),
  removeQueued: vi.fn(async () => ({})),
  editQueued: vi.fn(async () => ({})),
  reorderQueue: vi.fn(async () => ({})),
  runNext: vi.fn(async () => ({})),
  decideApproval: vi.fn(async () => ({})),
};
class ApiError extends Error { constructor(public status: number, m: string, public code?: string) { super(m); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { Conversation } = await import('../src/components/Conversation.tsx');

const at = (min: number) => `2026-10-14T10:${String(min).padStart(2, '0')}:00.000Z`;
const running: JobSummary = { id: 'j1', key: 'creative:k', kind: 'creative', label: 'x', state: 'running', createdAt: at(0) };
const queuedJob: JobSummary = { ...running, state: 'queued' };
const done: JobSummary = { ...running, state: 'succeeded', finishedAt: at(9) };
const agent = (min: number, event: AgentEvent, jobId = 'j1'): ConversationEntry => ({ type: 'agent', at: at(min), jobId, event });
const CID = '11111111-1111-4111-8111-111111111111';
const q = (clientId: string, text: string): QueuedRequest => ({ clientId, text, pins: [], at: at(2) });

const props = { slug: 'acme', creative: 'c1', approvals: [], pins: [], job: undefined as JobSummary | undefined, onSent: vi.fn(), onQueueChanged: vi.fn() };
type P = { entries: ConversationEntry[]; job?: JobSummary; live?: AgentEvent[]; queued?: QueuedRequest[] };
const view = (p: P) => <I18nProvider locale="en"><Conversation {...props} {...p} /></I18nProvider>;
const box = () => screen.getByRole('textbox', { name: 'Request a change' }) as HTMLTextAreaElement;
/** The message bubble holding `text` (the box may hold the same words while they are being sent). */
const article = (text: string) => screen.getAllByText(text).map((el) => el.closest('article')).find((a) => a !== null)!;
const MAC = vi.spyOn(navigator, 'platform', 'get');

beforeEach(() => {
  vi.clearAllMocks();
  MAC.mockReturnValue('MacIntel');
  caps = CAPS_OFF;
  outcome = 'delivered-pending';
});
afterEach(() => MAC.mockReset());

describe('composer while the agent works: capabilities off (the default)', () => {
  it('keeps the box active and offers "Queue for after" as the only send action, with its explanation', async () => {
    render(view({ entries: [], job: running }));
    // Until the answer comes the send action is neutral (a disabled, busy button): no flip from the fallback.
    expect((screen.getByRole('button', { name: 'Send to agent' }) as HTMLButtonElement).disabled).toBe(true);
    await screen.findByRole('button', { name: 'Queue for after' });
    expect(screen.queryByRole('button', { name: 'Send to agent' })).toBeNull();
    expect(box().disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Send to agent' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More ways to send' })).toBeNull();
    expect(screen.getByText(/can’t take messages while it works/)).toBeTruthy();
  });

  it('queues the message with Enter and keeps no bubble: it shows in the queue list', async () => {
    outcome = 'queued-unsupported';
    render(view({ entries: [], job: running }));
    await screen.findByRole('button', { name: 'Queue for after' });
    await userEvent.type(box(), 'Make the logo blue');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(api.postLiveMessage).toHaveBeenCalledTimes(1));
    const [slug, creative, body] = api.postLiveMessage.mock.calls[0]! as unknown as [string, string, { clientId: string; text: string; mode: string }];
    expect([slug, creative, body.text, body.mode]).toEqual(['acme', 'c1', 'Make the logo blue', 'queued']);
    expect(body.clientId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(box().value).toBe(''));
    expect(props.onQueueChanged).toHaveBeenCalled();
    expect(screen.queryByText('Make the logo blue')).toBeNull();
    expect(screen.getByText(/^Queued: this Claude Code can’t take messages/).getAttribute('role')).toBe('status');
  });

  it('a failed capabilities read falls back to the queue-only action', async () => {
    api.getAgentCapabilities.mockRejectedValueOnce(new Error('down'));
    render(view({ entries: [], job: running }));
    await screen.findByRole('button', { name: 'Queue for after' });
  });

  it('Shift+Enter writes a new line instead of sending', async () => {
    render(view({ entries: [], job: running }));
    await userEvent.type(box(), 'a{Shift>}{Enter}{/Shift}b');
    expect(box().value).toBe('a\nb');
    expect(api.postLiveMessage).not.toHaveBeenCalled();
  });
});

describe('composer while the agent works: live input on', () => {
  beforeEach(() => { caps = { ...CAPS_OFF, liveInput: true }; });

  it('the primary action is "Send to agent" and a menu offers "Queue for after"', async () => {
    render(view({ entries: [], job: running }));
    await screen.findByRole('button', { name: 'More ways to send' });
    await userEvent.type(box(), 'Use blue');
    await userEvent.click(screen.getByRole('button', { name: 'More ways to send' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Queue for after' }));
    await waitFor(() => expect(api.postLiveMessage).toHaveBeenCalledTimes(1));
    expect((api.postLiveMessage.mock.calls[0]![2] as { mode: string }).mode).toBe('queued');
  });

  it('shows the message as sending, then waiting, and "Sent" once its delivered marker arrives', async () => {
    let finish!: () => void;
    api.postLiveMessage.mockImplementationOnce((_s, _c, b) => new Promise((res) => { finish = () => res({ entry: { type: 'user', at: at(5), text: b.text, pins: [], attachments: [] }, outcome: 'delivered-pending' }); }));
    const { rerender } = render(view({ entries: [], job: running }));
    await screen.findByRole('button', { name: 'More ways to send' });
    await userEvent.type(box(), 'Use blue');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.getAllByText('Use blue').some((el) => el.closest('article'))).toBe(true));
    expect(within(article('Use blue')).getByText('Sending…')).toBeTruthy();
    await act(async () => finish());
    await waitFor(() => expect(within(article('Use blue')).getByText('Waiting for the agent’s next step')).toBeTruthy());
    const clientId = (api.postLiveMessage.mock.calls[0]![2] as { clientId: string }).clientId;
    const persisted: ConversationEntry = { type: 'user', at: at(5), text: 'Use blue', pins: [], attachments: [], jobId: 'j1', mode: 'live', clientId };
    rerender(view({ entries: [persisted], job: running }));
    expect(document.querySelectorAll('article')).toHaveLength(1);
    expect(within(article('Use blue')).getByText('Waiting for the agent’s next step')).toBeTruthy();
    rerender(view({ entries: [persisted, agent(6, { kind: 'user_message_delivered', clientId })], job: running }));
    const state = within(article('Use blue'));
    expect(state.getByText('Sent')).toBeTruthy();
    expect(state.queryByText(/Delivered/i)).toBeNull();
  });

  it('reads the delivered marker from the live events too', () => {
    const persisted: ConversationEntry = { type: 'user', at: at(5), text: 'Use blue', pins: [], attachments: [], jobId: 'j1', mode: 'live', clientId: CID };
    render(view({ entries: [persisted], job: running, live: [{ kind: 'user_message_delivered', clientId: CID }] }));
    expect(within(screen.getByText('Use blue').closest('article')!).getByText('Sent')).toBeTruthy();
  });

  it('a double click sends once (one clientId); a retry after a failure reuses it', async () => {
    let finish!: () => void;
    api.postLiveMessage.mockImplementationOnce((_s, _c, b) => new Promise((res) => { finish = () => res({ entry: { type: 'user', at: at(5), text: b.text, pins: [], attachments: [] }, outcome: 'delivered-pending' }); }));
    render(view({ entries: [], job: running }));
    await screen.findByRole('button', { name: 'More ways to send' });
    const send = screen.getByRole('button', { name: 'Send to agent' });
    await userEvent.type(box(), 'Use blue');
    fireEvent.click(send);
    fireEvent.click(send);
    await act(async () => finish());
    expect(api.postLiveMessage).toHaveBeenCalledTimes(1);

    api.postLiveMessage.mockRejectedValueOnce(new ApiError(500, 'boom'));
    await userEvent.type(box(), 'Again');
    await userEvent.keyboard('{Enter}');
    await screen.findByText(/Your message is kept/);
    expect(box().value).toBe('Again');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(api.postLiveMessage).toHaveBeenCalledTimes(3));
    const ids = api.postLiveMessage.mock.calls.map((c) => (c[2] as { clientId: string }).clientId);
    expect(ids[1]).toBe(ids[2]);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it.each([
    ['tooLong', 'The message is too long: at most 4000 characters.'],
    ['tooMany', 'At most 10 messages per turn: queue it for after, or wait for the turn to end.'],
    ['queueFull', 'At most 5 requests can wait in the queue: remove one or wait for the next to start.'],
  ])('shows the limit error %s translated and keeps the words', async (_n, text) => {
    api.postLiveMessage.mockRejectedValueOnce(new ApiError(409, text, 'limit'));
    render(view({ entries: [], job: running }));
    await screen.findByRole('button', { name: 'More ways to send' });
    await userEvent.type(box(), 'words');
    await userEvent.keyboard('{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe(text);
    expect(box().value).toBe('words');
    expect(screen.queryByText('Sending…')).toBeNull();
  });

  it('the limit error is shown in Italian when the core answers in Italian', async () => {
    api.postLiveMessage.mockRejectedValueOnce(new ApiError(409, 'Il messaggio è troppo lungo: al massimo 4000 caratteri.', 'limit'));
    render(<I18nProvider locale="it"><Conversation {...props} entries={[]} job={running} /></I18nProvider>);
    const field = await screen.findByRole('textbox');
    await userEvent.type(field, 'parole');
    await userEvent.keyboard('{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe('Il messaggio è troppo lungo: al massimo 4000 caratteri.');
  });

  it('a queued-after-finish answer is said once: the core writes the notice, the UI adds none', async () => {
    outcome = 'queued-after-finish';
    const notice: ConversationEntry = { type: 'system', at: at(6), level: 'info', text: 'Arrived after the agent finished: queued as the next request.' };
    render(view({ entries: [notice], job: running }));
    await screen.findByRole('button', { name: 'More ways to send' });
    await userEvent.type(box(), 'late one');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(box().value).toBe(''));
    expect(screen.getAllByText(/Arrived after the agent finished/)).toHaveLength(1);
    expect(screen.queryByText('late one')).toBeNull();
  });

  it('a retry in another mode gets a new clientId; the same mode reuses it', async () => {
    api.postLiveMessage.mockRejectedValueOnce(new ApiError(500, 'boom'));
    render(view({ entries: [], job: running }));
    await screen.findByRole('button', { name: 'More ways to send' });
    await userEvent.type(box(), 'words');
    await userEvent.keyboard('{Enter}');
    await screen.findByText(/Your message is kept/);
    await userEvent.click(screen.getByRole('button', { name: 'More ways to send' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Queue for after' }));
    await waitFor(() => expect(api.postLiveMessage).toHaveBeenCalledTimes(2));
    const [a, b] = api.postLiveMessage.mock.calls.map((c) => c[2] as { clientId: string; mode: string });
    expect([a!.mode, b!.mode]).toEqual(['live', 'queued']);
    expect(a!.clientId).not.toBe(b!.clientId);
  });

  it('the send group and the stop group have accessible names', async () => {
    render(view({ entries: [], job: running }));
    await screen.findByRole('button', { name: 'More ways to send' });
    expect(screen.getByRole('group', { name: 'Send to agent' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Stop' })).toBeTruthy();
  });

  it('shows a visible row for an interrupted step', () => {
    render(view({ entries: [agent(3, { kind: 'interrupted' })], job: running }));
    expect(screen.getByText('Interrupted by you')).toBeTruthy();
  });

  it('a pending-start answer says the message joins the agent’s first prompt', async () => {
    outcome = 'pending-start' as never;
    render(view({ entries: [], job: queuedJob }));
    await screen.findByRole('button', { name: 'More ways to send' });
    await userEvent.type(box(), 'before start');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('Will be included when the agent starts')).toBeTruthy();
  });

  it('Esc in the box never stops the agent', async () => {
    render(view({ entries: [], job: running }));
    await screen.findByRole('button', { name: 'More ways to send' });
    await userEvent.type(box(), 'abc');
    await userEvent.keyboard('{Escape}');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(api.stopJob).not.toHaveBeenCalled();
    expect(box().value).toBe('abc');
  });
});

describe('Stop and redirect in the composer', () => {
  it('"Stop" stops with no confirmation', async () => {
    render(view({ entries: [], job: running }));
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(api.stopJob).toHaveBeenCalledWith('j1');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('"Stop and redirect…" focuses the composer in redirect mode: the send action is "Redirect"', async () => {
    render(view({ entries: [], job: running }));
    await userEvent.click(screen.getByRole('button', { name: 'Stop options' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Stop and redirect…' }));
    expect(api.stopJob).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(box()));
    expect(screen.getByRole('button', { name: 'Redirect' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Queue for after' })).toBeNull();
    // Bare Enter writes a line: a redirect is sent by its button or the chord.
    await userEvent.type(box(), 'Do this instead{Enter}x');
    expect(api.redirectJob).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Redirect' }));
    await waitFor(() => expect(api.redirectJob).toHaveBeenCalledTimes(1));
    const [id, body] = api.redirectJob.mock.calls[0]! as unknown as [string, { clientId: string; text: string }];
    expect(id).toBe('j1');
    expect(body.text).toBe('Do this instead\nx');
    expect(body.clientId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(box().value).toBe(''));
    // Back to the normal send action once sent.
    expect(screen.queryByRole('button', { name: 'Redirect' })).toBeNull();
  });

  it('shows the redirect as a bubble in sending and can be cancelled', async () => {
    render(view({ entries: [], job: running }));
    await userEvent.click(screen.getByRole('button', { name: 'Stop options' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Stop and redirect…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel redirect' }));
    expect(screen.queryByRole('button', { name: 'Redirect' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Queue for after' })).toBeTruthy();
  });

  it('a failed redirect keeps the words and the mode, with the reason', async () => {
    api.redirectJob.mockRejectedValueOnce(new ApiError(409, 'The job is not running any more.', 'not-running'));
    render(view({ entries: [], job: running }));
    await userEvent.click(screen.getByRole('button', { name: 'Stop options' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Stop and redirect…' }));
    await userEvent.type(box(), 'Other');
    await userEvent.click(screen.getByRole('button', { name: 'Redirect' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The job is not running any more.');
    expect(box().value).toBe('Other');
    expect(screen.getByRole('button', { name: 'Redirect' })).toBeTruthy();
  });
});

describe('old conversations and idle composer', () => {
  it('render without states, and the idle composer still starts a normal turn', async () => {
    const entries: ConversationEntry[] = [
      { type: 'user', at: at(1), text: 'Old request', pins: [], attachments: [] },
      agent(2, { kind: 'text', text: 'Done.' }, 'old'),
    ];
    render(view({ entries, job: done }));
    expect(screen.getByText('Old request')).toBeTruthy();
    expect(screen.queryByText('Sent')).toBeNull();
    expect(screen.queryByText('Sending…')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(api.getAgentCapabilities).not.toHaveBeenCalled();
    await userEvent.type(box(), 'Next');
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledTimes(1));
    expect(api.postLiveMessage).not.toHaveBeenCalled();
  });

  it('a queued request that has started is a plain, sent message', () => {
    const entries: ConversationEntry[] = [{ type: 'user', at: at(1), text: 'Was queued', pins: [], attachments: [], jobId: 'j2', mode: 'queued', clientId: CID, deliveredAt: at(2) }];
    render(view({ entries, job: running }));
    expect(within(screen.getByText('Was queued').closest('article')!).getByText('Sent')).toBeTruthy();
  });

  it('a redirect given to a run that never read it and moved back to the queue shows Queued, not Sent (final wave P3)', () => {
    const entries: ConversationEntry[] = [
      { type: 'user', at: at(1), text: 'Go another way', pins: [], attachments: [], jobId: 'j1', mode: 'redirect', clientId: CID },
      agent(2, { kind: 'user_message_delivered', clientId: CID }),
    ];
    render(view({ entries, job: { ...running, state: 'failed', finishedAt: at(3) }, queued: [q(CID, 'Go another way')] }));
    const bubble = screen.getAllByText('Go another way').map((el) => el.closest('article')).find((a) => a !== null)!;
    expect(within(bubble).getByText('Queued')).toBeTruthy();
    expect(within(bubble).queryByText('Sent')).toBeNull();
  });

  it('a message still in the queue shows as Queued in the list, not as a second bubble', () => {
    render(view({ entries: [], job: running, queued: [q(CID, 'Later one')] }));
    expect(screen.getAllByText('Later one')).toHaveLength(1);
    expect(screen.getByRole('list', { name: 'Queued requests' })).toBeTruthy();
  });

  it('after a restart (no job) the list offers Run next, and the queue reloads when it changes', async () => {
    render(view({ entries: [], job: done, queued: [q(CID, 'Waited over the restart')] }));
    expect(screen.getByText('Waited over the restart')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Run next' }));
    await waitFor(() => expect(api.runNext).toHaveBeenCalledWith('acme', 'c1'));
    await waitFor(() => expect(props.onQueueChanged).toHaveBeenCalled());
  });

  it('while a turn runs the list has no Run next: the queue starts by itself after a turn that saved a version', () => {
    render(view({ entries: [], job: running, queued: [q(CID, 'Next one')] }));
    expect(screen.queryByRole('button', { name: 'Run next' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit queued request 1' })).toBeTruthy();
  });
});
