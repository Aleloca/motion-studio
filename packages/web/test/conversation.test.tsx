import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentEvent, ApprovalRequest, ConversationEntry, JobSummary, Pin } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

const api = {
  sendCreativeTurn: vi.fn(async () => ({})),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
  stopJob: vi.fn(async (_id: string) => ({ status: 'stopping' })),
  decideApproval: vi.fn(async () => ({})),
};
class ApiError extends Error { constructor(public status: number, m: string) { super(m); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { Conversation, mergeJobEvents } = await import('../src/components/Conversation.tsx');
const { ActivityCenter } = await import('../src/shell/ActivityCenter.tsx');
const { initialEventsState } = await import('../src/eventsReducer.ts');

// ⌘↵ is the macOS chord (isSubmitChord): these tests run on a Mac platform unless they say otherwise.
let platform: ReturnType<typeof vi.spyOn> | null = null;
const onPlatform = (name: 'MacIntel' | 'Win32') => { platform?.mockRestore(); platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue(name); };
beforeEach(() => onPlatform('MacIntel'));
afterEach(() => { platform?.mockRestore(); platform = null; });

// Controllable Web Animations: each animate() returns a fake whose `finished` settles only when the test says so.
class FakeAnim {
  cancelled = false;
  finished: Promise<unknown>;
  private res!: () => void;
  private rej!: () => void;
  constructor(public el: Element, public frames: Keyframe[]) {
    this.finished = new Promise((r, j) => { this.res = () => r(undefined); this.rej = () => j(new Error('cancelled')); });
    this.finished.catch(() => {});
  }
  cancel() { if (!this.cancelled) { this.cancelled = true; this.rej(); } }
  finish() { this.res(); }
}
let anims: FakeAnim[] = [];
const origAnimate = Element.prototype.animate;
const origGetAnimations = Element.prototype.getAnimations;
const enters = (el: Element) => anims.filter((a) => a.el === el && String(a.frames[0]?.transform ?? '').startsWith('translate'));
const collapses = () => anims.filter((a) => a.frames.some((f) => f.height !== undefined));

const at = (min: number) => `2026-10-08T10:${String(min).padStart(2, '0')}:00.000Z`;
const running: JobSummary = { id: 'j1', key: 'creative:k', kind: 'creative', label: 'x', state: 'running', createdAt: at(0) };
const done: JobSummary = { ...running, state: 'succeeded', finishedAt: at(9) };
const ap: ApprovalRequest = {
  id: 'a1', jobId: 'j1', projectSlug: 'acme', creativeSlug: 'c1', kind: 'tool', title: 'Run a command', detail: 'npm run render',
  toolName: 'Bash', alwaysRule: null, explanation: null, agentReason: null, createdAt: at(3), expiresAt: '2099-01-01T00:00:00.000Z',
};
const agent = (min: number, event: AgentEvent, jobId = 'j1'): ConversationEntry => ({ type: 'agent', at: at(min), jobId, event });
const text = (t: string): AgentEvent => ({ kind: 'text', text: t });

const props = { slug: 'acme', creative: 'c1', approvals: [] as ApprovalRequest[], job: undefined as JobSummary | undefined, live: [] as AgentEvent[], pins: [] as Pin[], onRemovePin: vi.fn(), onSent: vi.fn(), onSelectVersion: vi.fn() };
type Props = Partial<typeof props> & { entries: ConversationEntry[]; canGenerate?: boolean; snapshots?: number };
const view = (p: Props) => <I18nProvider locale="en"><Conversation {...props} {...p} /></I18nProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  anims = [];
  Element.prototype.animate = function (this: Element, frames: Keyframe[]) {
    const a = new FakeAnim(this, frames);
    anims.push(a);
    return a as unknown as Animation;
  } as never;
  Element.prototype.getAnimations = function (this: Element) {
    return anims.filter((a) => a.el === this && !a.cancelled) as unknown as Animation[];
  } as never;
});
afterEach(() => {
  Element.prototype.animate = origAnimate;
  Element.prototype.getAnimations = origGetAnimations;
});

const messages = () => screen.queryAllByRole('article');

describe('Conversation', () => {
  it('renders one message per entry, each with its time', () => {
    const entries: ConversationEntry[] = [
      { type: 'user', at: at(1), text: 'Make the logo bigger', pins: [], attachments: [] },
      agent(2, text('Looking at the logo.'), 'old'),
      agent(4, text('I scaled it to 120%.'), 'old'),
      { type: 'user', at: at(5), text: 'Thanks', pins: [], attachments: [] },
    ];
    render(view({ entries }));
    const list = messages();
    expect(list).toHaveLength(4);
    list.forEach((m, i) => expect(m.querySelector('time')?.getAttribute('datetime')).toBe(entries[i]!.at));
    expect(within(list[0]!).getByText('You')).toBeTruthy();
    expect(within(list[1]!).getByText('Agent')).toBeTruthy();
    expect(within(list[2]!).getByText('I scaled it to 120%.')).toBeTruthy();
  });

  it('renders the result as safe Markdown', () => {
    const entries = [agent(2, text('Working on it')), agent(3, { kind: 'result', ok: true, text: 'Done: **v2 is ready** <b>x</b>' })];
    render(view({ entries, job: done }));
    const summary = screen.getByText('v2 is ready');
    expect(summary.tagName).toBe('STRONG');
    // HTML in the agent's text stays text.
    expect(summary.closest('.ms-md')!.textContent).toContain('<b>x</b>');
    expect(screen.getByText('Summary')).toBeTruthy();
  });

  it('marks the last message as the summary when the result repeats it', () => {
    const entries = [agent(2, text('All **done**.')), agent(3, { kind: 'result', ok: true, text: 'All **done**.' })];
    render(view({ entries, job: done }));
    expect(messages()).toHaveLength(1);
    expect(screen.getByText('Summary')).toBeTruthy();
  });

  it('shows a failed result as an error', () => {
    render(view({ entries: [agent(3, { kind: 'result', ok: false, error: 'Rate limit reached' })], job: { ...done, state: 'failed' } }));
    expect(screen.getByRole('alert').textContent).toContain('Rate limit reached');
  });

  it('shows agent steps as compact rows with a check, live while the job runs', () => {
    render(view({ entries: [agent(2, { kind: 'progress', text: 'Rendering the reel' })], job: running }));
    const step = screen.getByText('Rendering the reel').closest('li')!;
    expect(step.querySelector('.ms-step-check')).toBeTruthy();
    expect(within(step).getByText((_, el) => el?.tagName === 'TIME')).toBeTruthy();
  });

  it('folds the steps of a finished turn behind a toggle', async () => {
    const entries = [agent(2, { kind: 'progress', text: 'Step one' }), agent(3, { kind: 'progress', text: 'Step two' }), agent(4, text('Finished.'))];
    render(view({ entries, job: done }));
    expect(screen.queryByText('Step one')).toBeNull();
    const toggle = screen.getByRole('button', { name: /2 steps/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(toggle);
    expect(screen.getByText('Step one')).toBeTruthy();
    expect(screen.getByText('Step two')).toBeTruthy();
  });

  it('keeps technical events in a collapsible Activity details panel', async () => {
    const entries = [
      agent(2, { kind: 'tool_use', id: 't', name: 'Write', input: { file_path: 'index.html' } }),
      agent(3, { kind: 'tool_result', toolUseId: 't', isError: false, content: 'ok wrote 12 lines' }),
      agent(4, text('Updated the page.')),
    ];
    render(view({ entries, job: done }));
    expect(screen.queryByText(/index\.html/)).toBeNull();
    expect(screen.queryByText('ok wrote 12 lines')).toBeNull();
    const toggle = screen.getByRole('button', { name: /Activity details/ });
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/index\.html/)).toBeTruthy();
    expect(screen.getByText('ok wrote 12 lines')).toBeTruthy();
  });

  it('shows typing dots while the job runs and nothing is waiting for the user', () => {
    const { rerender } = render(view({ entries: [], job: running }));
    expect(screen.getByRole('status', { name: 'Typing' })).toBeTruthy();
    rerender(view({ entries: [], job: running, approvals: [ap] }));
    expect(screen.queryByRole('status', { name: 'Typing' })).toBeNull();
    rerender(view({ entries: [], job: done }));
    expect(screen.queryByRole('status', { name: 'Typing' })).toBeNull();
  });

  it('places the job approvals in the flow, after the turn', () => {
    render(view({ entries: [{ type: 'user', at: at(1), text: 'Render it', pins: [], attachments: [] }, agent(2, text('Rendering now.'))], job: running, approvals: [ap] }));
    const card = screen.getByRole('group', { name: 'Run a command' });
    const turn = screen.getByText('Rendering now.');
    expect(turn.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('⌘↵ sends the text and the pending comments', async () => {
    const pins: Pin[] = [{ format: 'instagram-post-1x1', x: 0.1, y: 0.2, timeSec: 2 }];
    render(view({ entries: [], pins }));
    expect(screen.getByText(/instagram-post-1x1/)).toBeTruthy();
    const box = screen.getByLabelText('Request a change');
    await userEvent.type(box, 'More contrast');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'c1', { text: 'More contrast', pins }));
    await waitFor(() => expect(props.onSent).toHaveBeenCalled());
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('Ctrl+Enter sends off macOS (not on a Mac); plain Enter never does', async () => {
    render(view({ entries: [] }));
    const box = screen.getByLabelText('Request a change');
    await userEvent.type(box, 'Hi');
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(api.sendCreativeTurn).not.toHaveBeenCalled();
    onPlatform('Win32');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(api.sendCreativeTurn).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'c1', { text: 'Hi', pins: [] }));
  });

  it('removes a pending comment chip; while a job runs the new-turn Send is gone and Stop stops it (Phase 13)', async () => {
    const pins: Pin[] = [{ format: 'story', x: 0.1, y: 0.2, timeSec: null }];
    render(view({ entries: [], pins, job: running }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove comment 1' }));
    expect(props.onRemovePin).toHaveBeenCalledWith(0);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(api.stopJob).toHaveBeenCalledWith('j1');
    expect(api.cancelJob).not.toHaveBeenCalled();
  });

  it('offers Generate before the first version, as an accent button (it acts as Send)', async () => {
    render(view({ entries: [], canGenerate: true }));
    const gen = screen.getByRole('button', { name: 'Generate' });
    expect(gen.className).toContain('ms-accent');
    expect(gen.className).not.toContain('ms-ink');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'c1', {}));
  });

  it('shows versions and system notes in the flow', async () => {
    render(view({ entries: [{ type: 'version', at: at(5), n: 2, status: 'complete' }, { type: 'system', at: at(6), level: 'error', text: 'Generation failed: boom' }] }));
    await userEvent.click(screen.getByRole('button', { name: 'View v2' }));
    expect(props.onSelectVersion).toHaveBeenCalledWith(2);
    expect(screen.getByRole('alert').textContent).toContain('boom');
  });

  it('marks what the agent did in the app as an agent action line (decision 917)', () => {
    render(view({ entries: [
      { type: 'system', at: at(6), level: 'info', text: 'Brief duration: 6 s → 60 s', origin: 'agent' },
      { type: 'system', at: at(7), level: 'info', text: 'Restarted from v1' },
    ] }));
    const action = screen.getByText('Brief duration: 6 s → 60 s').closest('p')!;
    expect(action.className).toContain('ms-convo-action');
    expect(within(action).getByText('Agent action')).toBeTruthy();
    const plain = screen.getByText('Restarted from v1').closest('p')!;
    expect(plain.className).not.toContain('ms-convo-action');
  });

  it('has a designed empty state', () => {
    render(view({ entries: [] }));
    expect(screen.getByText('No messages yet')).toBeTruthy();
  });
});

describe('Conversation composer guards', () => {
  it('a rapid double send makes one request and stays blocked until the new job arrives', async () => {
    let resolve!: (j: JobSummary) => void;
    api.sendCreativeTurn.mockImplementationOnce(() => new Promise((r) => { resolve = r as never; }) as never);
    const { rerender } = render(view({ entries: [], job: done }));
    const box = screen.getByLabelText('Request a change');
    await userEvent.type(box, 'Again');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(api.sendCreativeTurn).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ ...running, id: 'j2' }); });
    // The POST succeeded but the job has not reached the page yet: still no second send.
    await userEvent.type(box, 'Once more');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(api.sendCreativeTurn).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(view({ entries: [], job: { ...running, id: 'j2' } }));
    // The turn runs: the box now sends messages to it (Phase 13) and the new-turn Send is gone.
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    rerender(view({ entries: [], job: { ...done, id: 'j2' } }));
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledTimes(2));
  });

  it('unlocks after a bounded wait when the started job never arrives', async () => {
    vi.useFakeTimers();
    try {
      api.sendCreativeTurn.mockResolvedValueOnce({ ...running, id: 'j9' } as never);
      render(view({ entries: [], job: done }));
      const box = screen.getByLabelText('Request a change');
      const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
      fireEvent.change(box, { target: { value: 'Hello' } });
      await act(async () => { fireEvent.keyDown(box, { key: 'Enter', metaKey: true }); });
      fireEvent.change(box, { target: { value: 'Next' } });
      expect(send.disabled).toBe(true);
      await act(async () => { vi.advanceTimersByTime(9_000); });
      expect(send.disabled).toBe(true);
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(send.disabled).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('unlocks when a new socket snapshot arrives', async () => {
    api.sendCreativeTurn.mockResolvedValueOnce({ ...running, id: 'j9' } as never);
    const { rerender } = render(view({ entries: [], job: done, snapshots: 1 } as Props));
    const box = screen.getByLabelText('Request a change');
    await userEvent.type(box, 'Hello');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledTimes(1));
    await userEvent.type(box, 'Next');
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(view({ entries: [], job: done, snapshots: 2 } as Props));
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('explains a failed send, keeps the text and allows a retry', async () => {
    api.sendCreativeTurn.mockRejectedValueOnce(new ApiError(500, 'ECONNRESET socket hang up'));
    render(view({ entries: [] }));
    const box = screen.getByLabelText('Request a change') as HTMLTextAreaElement;
    await userEvent.type(box, 'Bigger logo');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    // D4: the server's explanation follows the generic text.
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t send: ECONNRESET socket hang up. Your message is kept — try again.');
    expect(box.value).toBe('Bigger logo');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledTimes(2));
  });

  it('explains a 409: a generation is already running', async () => {
    api.sendCreativeTurn.mockRejectedValueOnce(new ApiError(409, 'busy'));
    render(view({ entries: [], canGenerate: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect((await screen.findByRole('alert')).textContent).toBe('A generation is already running for this creative. Wait for it to finish, then send again.');
  });
});

describe('Conversation · retried turns (C2)', () => {
  const user = (min: number, t: string, pins: Pin[] = []): ConversationEntry => ({ type: 'user', at: at(min), text: t, pins, attachments: [] });
  const failed = (min: number, jobId: string): ConversationEntry => agent(min, { kind: 'result', ok: false, error: 'Render failed' }, jobId);
  const pin: Pin = { format: 'tiktok-9x16', x: 0.5, y: 0.2, timeSec: 1.5, note: 'here' };

  it('the same text and pins sent again after a failed turn is a compact "Retried · HH:MM" label, not a second bubble', () => {
    render(view({ entries: [user(1, 'Bigger logo', [pin]), failed(2, 'j1'), user(3, 'Bigger logo', [pin]), agent(4, text('Done'), 'j2')] }));
    expect(screen.getAllByRole('article', { name: 'You' })).toHaveLength(1);
    const label = screen.getByText(/^Retried · /);
    // The app's time of day (as on every message).
    expect(label.textContent).toMatch(/^Retried · \d{1,2}:\d\d/);
  });

  it('a pins-only retry is recognized too', () => {
    render(view({ entries: [user(1, '', [pin]), failed(2, 'j1'), user(3, '', [pin])] }));
    expect(screen.getAllByRole('article', { name: 'You' })).toHaveLength(1);
    expect(screen.getByText(/^Retried · /)).toBeTruthy();
  });

  it('two failures in a row give two Retried labels', () => {
    render(view({ entries: [user(1, 'Bigger logo'), failed(2, 'j1'), user(3, 'Bigger logo'), failed(4, 'j2'), user(5, 'Bigger logo')] }));
    expect(screen.getAllByRole('article', { name: 'You' })).toHaveLength(1);
    expect(screen.getAllByText(/^Retried · /)).toHaveLength(2);
  });

  it('a new message, a different comment or a repeat after a success stays a full bubble', () => {
    render(view({ entries: [
      user(1, 'Bigger logo'), failed(2, 'j1'),
      user(3, 'Bigger logo', [pin]), // different pins
      { type: 'version', at: at(4), n: 1, status: 'complete' },
      user(5, 'Bigger logo', [pin]), // same as before, but the turn before succeeded
    ] }));
    expect(screen.getAllByRole('article', { name: 'You' })).toHaveLength(3);
    expect(screen.queryByText(/^Retried · /)).toBeNull();
  });

  it('a system error after the turn counts as a failure', () => {
    render(view({ entries: [user(1, 'Bigger logo'), { type: 'system', at: at(2), level: 'error', text: 'Generation failed' }, user(3, 'Bigger logo')] }));
    expect(screen.getByText(/^Retried · /)).toBeTruthy();
  });
});

describe('Activity center approvals', () => {
  const where = () => 'Acme';
  it('an approval resolved while another tab is shown never mounts just to collapse; count and list agree', async () => {
    const live = { ...initialEventsState, approvals: { a1: ap } };
    const { rerender } = render(<I18nProvider locale="en"><ActivityCenter live={live} initialTab="running" where={where} /></I18nProvider>);
    rerender(<I18nProvider locale="en"><ActivityCenter live={{ ...initialEventsState }} initialTab="running" where={where} /></I18nProvider>);
    await userEvent.click(screen.getByRole('tab', { name: /Needs you/ }));
    expect(screen.queryByRole('group', { name: 'Run a command' })).toBeNull();
    expect(collapses()).toHaveLength(0);
    expect(screen.getByText('Nothing waiting for you')).toBeTruthy();
  });
});

describe('Conversation with live events and animations', () => {
  it('merges persisted and live events of the job once, without remounting what is already shown', () => {
    const { rerender } = render(view({ entries: [], job: running, live: [text('a')] }));
    const a = screen.getByText('a').closest('article')!;
    // A refetch persists 'a' while 'b' arrives live: 'a' is shown once and is the same element.
    rerender(view({ entries: [agent(2, text('a'))], job: running, live: [text('a'), text('b')] }));
    expect(screen.getAllByText('a')).toHaveLength(1);
    expect(screen.getAllByText('b')).toHaveLength(1);
    expect(screen.getByText('a').closest('article')).toBe(a);
    // The job ends before the next refetch: the live tail stays visible, nothing jumps.
    rerender(view({ entries: [agent(2, text('a'))], job: done, live: [text('a'), text('b')] }));
    expect(messages().map((m) => m.textContent)).toEqual([expect.stringContaining('a'), expect.stringContaining('b')]);
    expect(screen.getByText('a').closest('article')).toBe(a);
  });

  it('a new message arriving while the previous one is still entering leaves both consistent', () => {
    const { rerender } = render(view({ entries: [], job: running, live: [] }));
    rerender(view({ entries: [], job: running, live: [text('first')] }));
    const first = screen.getByText('first').closest('article')!;
    expect(enters(first)).toHaveLength(1);
    const entering = enters(first)[0]!;
    // 'second' arrives before the entrance of 'first' has finished.
    rerender(view({ entries: [], job: running, live: [text('first'), text('second')] }));
    const second = screen.getByText('second').closest('article')!;
    expect(entering.cancelled).toBe(false);
    expect(enters(first)).toHaveLength(1);
    expect(enters(second)).toHaveLength(1);
    expect(enters(second)[0]!.frames[0]!.transform).toContain('8px');
    expect(messages()).toHaveLength(2);
  });

  it('a decided approval collapses (T15) and is removed only when the animation finishes', async () => {
    const { rerender } = render(view({ entries: [], job: running, approvals: [ap] }));
    rerender(view({ entries: [], job: running, approvals: [] }));
    // Still shown while it collapses.
    expect(screen.getAllByRole('group', { name: 'Run a command' })).toHaveLength(1);
    expect(collapses()).toHaveLength(1);
    await act(async () => { collapses()[0]!.finish(); });
    expect(screen.queryByRole('group', { name: 'Run a command' })).toBeNull();
  });

  it('an approval re-added during its exit stays, once, and is not removed when the cancelled exit settles', async () => {
    const { rerender } = render(view({ entries: [], job: running, approvals: [ap] }));
    rerender(view({ entries: [], job: running, approvals: [] }));
    const exit = collapses()[0]!;
    rerender(view({ entries: [], job: running, approvals: [ap] }));
    // The entrance cancels the running exit.
    expect(exit.cancelled).toBe(true);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getAllByRole('group', { name: 'Run a command' })).toHaveLength(1);
    // Even a late "finished" of the old exit must not remove the revived card.
    await act(async () => { exit.finish(); });
    expect(screen.getAllByRole('group', { name: 'Run a command' })).toHaveLength(1);
    // A second approval arriving meanwhile does not duplicate the first.
    rerender(view({ entries: [], job: running, approvals: [ap, { ...ap, id: 'a2', title: 'Edit a file' }] }));
    expect(screen.getAllByRole('group', { name: 'Run a command' })).toHaveLength(1);
    expect(screen.getAllByRole('group', { name: 'Edit a file' })).toHaveLength(1);
  });
});

describe('Conversation · automatic approvals (Phase 8)', () => {
  const auto = (cmd: string, risk: 'low' | 'medium' = 'low'): AgentEvent => ({
    kind: 'auto_approved', toolName: 'Bash', command: cmd,
    explanation: { summary: [{ key: 'explain.runs', params: { cmd } }], indicators: risk === 'medium' ? [{ id: 'unknown-command', risk: 'medium' }] : [], risk, parsed: true },
  });
  const finished = [
    agent(2, auto('ffprobe')), agent(3, auto('magick', 'medium')), agent(4, text('Rendered.')), agent(5, auto('pngquant')),
    agent(6, { kind: 'usage', live: false, tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }, costUsd: null }),
    agent(7, { kind: 'result', ok: true, text: 'Rendered.' }),
  ];

  it('logs each automatic approval as a compact Activity details row whose command expands', async () => {
    render(view({ entries: finished, job: done }));
    // Not in the chat itself.
    expect(screen.queryByText('Runs ffprobe')).toBeNull();
    // Usage is not a visible row: 3 automatic approvals + the result.
    await userEvent.click(screen.getByRole('button', { name: 'Activity details (4)' }));
    const rows = document.querySelectorAll('.ms-convo-auto');
    expect(rows).toHaveLength(3);
    const first = rows[0] as HTMLElement;
    expect(first.querySelector('.ms-step-check svg')).toBeTruthy();
    const toggle = within(first).getByRole('button', { name: /Runs ffprobe/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(rows[1] as HTMLElement).getByText('Unknown command')).toBeTruthy();
    expect(within(first).queryByText('ffprobe', { selector: 'pre' })).toBeNull();
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(first).getByText('ffprobe', { selector: 'pre' })).toBeTruthy();
  });

  it('ends the turn with a compact line counting them, which opens Activity details', async () => {
    render(view({ entries: finished, job: done }));
    const line = screen.getByText('3 commands ran in the sandbox');
    const wrap = line.closest('.ms-convo-autoline') as HTMLElement;
    expect(wrap).toBeTruthy();
    // A line, not a message bubble.
    expect(wrap.closest('article')).toBeNull();
    expect(wrap.querySelector('.ms-msg-bubble')).toBeNull();
    const details = screen.getByRole('button', { name: 'Activity details (4)' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    const open = within(wrap).getByRole('button', { name: 'Details' });
    expect(document.getElementById(open.getAttribute('aria-describedby')!)!.textContent).toBe('3 commands ran in the sandbox');
    await userEvent.click(open);
    expect(details.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('.ms-convo-auto')).toHaveLength(3);
  });

  it('a malformed persisted event shows the tool and the command instead of throwing', async () => {
    const bad = { kind: 'auto_approved', toolName: 'Bash', command: 'ls -la' } as unknown as AgentEvent;
    const odd = { kind: 'auto_approved', toolName: 'Bash', command: 'pwd', explanation: { summary: 'x', indicators: null } } as unknown as AgentEvent;
    render(view({ entries: [agent(2, bad), agent(3, odd)], job: done }));
    await userEvent.click(screen.getByRole('button', { name: 'Activity details (2)' }));
    expect(screen.getByRole('button', { name: /Bash: ls -la/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Bash: pwd/ })).toBeTruthy();
    expect(screen.getByText('2 commands ran in the sandbox')).toBeTruthy();
  });

  it('says it once for one command, and not while the turn runs or when no command ran', () => {
    const { rerender } = render(view({ entries: [agent(2, auto('ffprobe'))], job: done }));
    expect(screen.getByText('1 command ran in the sandbox')).toBeTruthy();
    rerender(view({ entries: [agent(2, auto('ffprobe'))], job: running }));
    expect(screen.queryByText(/commands? ran/)).toBeNull();
    rerender(view({ entries: [agent(2, text('Hi'))], job: done }));
    expect(screen.queryByText(/commands? ran/)).toBeNull();
  });
});

describe('Conversation · every command that ran (count work)', () => {
  const session = (sandboxed?: boolean): AgentEvent => ({ kind: 'session', sessionId: 's1', ...(sandboxed === undefined ? {} : { sandboxed }) });
  const use = (id: string, command: string): AgentEvent => ({ kind: 'tool_use', id, name: 'Bash', input: { command } });
  const result = (id: string, isError = false): AgentEvent => ({ kind: 'tool_result', toolUseId: id, isError, content: isError ? 'exit 1' : 'ok' });
  const decided = (id: string, decision: 'once' | 'always' | 'deny' | 'expired' | 'cancelled'): AgentEvent => ({ kind: 'approval_decided', toolName: 'Bash', decision, toolUseId: id });
  const autoFor = (id: string, command: string): AgentEvent => ({
    kind: 'auto_approved', toolName: 'Bash', command, toolUseId: id,
    explanation: { summary: [{ key: 'explain.runs', params: { cmd: 'ffprobe' } }], indicators: [], risk: 'low', parsed: true },
  });
  const read = (file: string): AgentEvent => ({
    kind: 'auto_approved', toolName: 'Read', command: file,
    explanation: { summary: [{ key: 'explain.runs', params: { cmd: 'read' } }], indicators: [], risk: 'low', parsed: true },
  });
  // 5 Bash calls: one auto-approved by our approve, two allowed by Claude Code itself, one you approved, one you denied.
  const turn = (sandboxed?: boolean) => [
    agent(1, session(sandboxed)),
    agent(2, use('b1', 'ffprobe -v error in.mp4')), agent(2, autoFor('b1', 'ffprobe -v error in.mp4')), agent(2, result('b1')),
    agent(3, use('b2', 'ls -la creatives')), agent(3, result('b2')),
    agent(4, use('b3', 'mkdir -p work/tmp')), agent(4, result('b3', true)),
    agent(5, use('b4', 'brew install ffmpeg')), agent(5, decided('b4', 'once')), agent(5, result('b4')),
    agent(6, use('b5', 'rm -rf ~/Downloads')), agent(6, decided('b5', 'deny')), agent(6, result('b5', true)),
    agent(7, read('/tmp/claude-501/frames/f1.png')),
    agent(8, { kind: 'result', ok: true, text: 'Done.' }),
  ];

  it('counts every Bash call that ran, not only automatic approvals, and says how many you approved', () => {
    render(view({ entries: turn(true), job: done }));
    // 5 calls − 1 denied = 4 ran (the Read is listed but never counted).
    expect(screen.getByText('4 commands ran in the sandbox · 1 approved by you')).toBeTruthy();
  });

  it('every row has an explanation and the right mark; Read is its own row type', async () => {
    render(view({ entries: turn(true), job: done }));
    await userEvent.click(screen.getByRole('button', { name: /^Activity details/ }));
    const rows = [...document.querySelectorAll<HTMLElement>('.ms-convo-auto')];
    expect(rows.map((r) => r.dataset.mark)).toEqual(['auto', 'auto', 'error', 'approved', 'denied', 'read']);
    // The automatic approval is merged into its tool_use: one row per call.
    expect(rows).toHaveLength(6);
    expect(within(rows[3]!).getByText('You approved')).toBeTruthy();
    expect(rows[3]!.querySelector('.ms-step-check svg')).toBeTruthy();
    expect(within(rows[4]!).getByText('Denied')).toBeTruthy();
    expect(within(rows[2]!).getByText('Ended with an error')).toBeTruthy();
    expect(within(rows[0]!).queryByText(/You approved|Denied/)).toBeNull();
    expect(within(rows[5]!).getByText('Read /tmp/claude-501/frames/f1.png')).toBeTruthy();
    // An explanation (never a raw "Bash: …" fallback, never a catalog key) on every command row.
    for (const r of rows.slice(0, 5)) {
      const title = r.querySelector('.ms-convo-auto-text')!.textContent!;
      expect(title).not.toMatch(/^Bash: |explain\./);
      expect(title.length).toBeGreaterThan(0);
    }
    // The web explanation of a call the core did not explain still carries its risk chips.
    expect(within(rows[4]!).getAllByText(/./, { selector: '.ms-risk-label' }).length).toBeGreaterThan(0);
    await userEvent.click(within(rows[1]!).getByRole('button'));
    expect(within(rows[1]!).getByText('ls -la creatives', { selector: 'pre' })).toBeTruthy();
  });

  it('shows the line with the automatic-approval setting off too (no auto_approved at all)', () => {
    const entries = [agent(1, session(true)), agent(2, use('b1', 'ls')), agent(2, result('b1')), agent(3, use('b2', 'pwd')), agent(3, result('b2'))];
    render(view({ entries, job: done }));
    expect(screen.getByText('2 commands ran in the sandbox')).toBeTruthy();
  });

  it('an unsandboxed job (or one whose log does not say) drops "in the sandbox"', () => {
    const { rerender } = render(view({ entries: turn(false), job: done }));
    expect(screen.getByText('4 commands ran · 1 approved by you')).toBeTruthy();
    rerender(view({ entries: [agent(2, use('b1', 'ls')), agent(2, result('b1'))], job: done }));
    expect(screen.getByText('1 command ran')).toBeTruthy();
  });

  it('expired or cancelled requests did not run; a call cut by a cancelled job is "Interrupted" and the line says "attempted"', async () => {
    const entries = [agent(1, session(true)), agent(2, use('b1', 'ls')), agent(2, decided('b1', 'expired')), agent(3, use('b2', 'pwd')), agent(3, decided('b2', 'cancelled')), agent(4, use('b3', 'sleep 100'))];
    render(view({ entries, job: { ...done, state: 'cancelled' } }));
    expect(screen.getByText('1 command ran or was attempted in the sandbox')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /^Activity details/ }));
    expect(screen.getAllByText('Didn’t run')).toHaveLength(2);
    expect(screen.getByText('Interrupted')).toBeTruthy();
  });

  it('a failed turn with two cut calls: plural "ran or were attempted"; while running there is no mark', async () => {
    const entries = [agent(1, session(true)), agent(2, use('b1', 'ls')), agent(3, use('b2', 'pwd')), agent(4, result('b2')), agent(5, use('b3', 'sleep 9'))];
    const { rerender } = render(view({ entries, job: { ...done, state: 'failed' } }));
    expect(screen.getByText('3 commands ran or were attempted in the sandbox')).toBeTruthy();
    rerender(view({ entries, job: running }));
    await userEvent.click(screen.getByRole('button', { name: /^Activity details/ }));
    expect(screen.queryByText('Interrupted')).toBeNull();
  });

  it('the line icon is the shield only for sandboxed runs', () => {
    const { rerender } = render(view({ entries: turn(true), job: done }));
    const icon = () => document.querySelector('.ms-convo-autoline .ms-step-check svg')!.outerHTML;
    const shield = icon();
    rerender(view({ entries: turn(false), job: done }));
    expect(icon()).not.toBe(shield);
  });

  it('only Reads: listed, but no line', () => {
    render(view({ entries: [agent(1, session(true)), agent(2, read('/tmp/claude-501/x.png'))], job: done }));
    expect(screen.queryByText(/commands? ran/)).toBeNull();
  });

  it('copy in Italian, singular and plural', () => {
    const it_ = (entries: ConversationEntry[]) => render(<I18nProvider locale="it"><Conversation {...props} entries={entries} job={done} /></I18nProvider>);
    const { unmount } = it_(turn(true));
    expect(screen.getByText('4 comandi eseguiti nella sandbox · 1 approvato da te')).toBeTruthy();
    unmount();
    const two = [agent(1, session(false)), agent(2, use('b1', 'ls')), agent(2, decided('b1', 'once')), agent(3, use('b2', 'pwd')), agent(3, decided('b2', 'always'))];
    const r2 = it_(two);
    expect(screen.getByText('2 comandi eseguiti · 2 approvati da te')).toBeTruthy();
    r2.unmount();
    const r3 = it_([agent(1, session(true)), agent(2, use('b1', 'ls')), agent(2, result('b1'))]);
    expect(screen.getByText('1 comando eseguito nella sandbox')).toBeTruthy();
    r3.unmount();
    it_([agent(1, session(true)), agent(2, use('b1', 'ls')), agent(3, use('b2', 'pwd'))]);
    expect(screen.getByText('2 comandi eseguiti o tentati nella sandbox')).toBeTruthy();
  });
});

describe('mergeJobEvents', () => {
  it('shows the overlap between persisted and live events once', () => {
    expect(mergeJobEvents([text('a'), text('b')], [text('b'), text('c')]).map((e) => (e.kind === 'text' ? e.text : ''))).toEqual(['a', 'b', 'c']);
  });
});

describe('Conversation · "Applies to" and warnings (Phase 9)', () => {
  const pin = (format: string): Pin => ({ format, x: 0.5, y: 0.5, timeSec: null, note: 'n' });
  // The Reel and the Post are primaries; TikTok follows the Reel.
  const appliesTo = {
    primaries: [{ id: 'reel', label: 'Reel', followers: ['TikTok'] }, { id: 'post', label: 'Post', followers: [] }],
    followerOf: (id: string) => (id === 'tiktok' ? 'reel' : null),
  };
  // Report 42: one menu button saying what is chosen, a menu of checkboxes.
  const button = () => screen.getByRole('button', { name: /^Applies to: / });
  const open = async () => { if (button().getAttribute('aria-expanded') !== 'true') await userEvent.click(button()); return screen.getByRole('menu', { name: 'Applies to' }); };
  const item = async (name: string | RegExp) => within(await open()).getByRole('menuitemcheckbox', { name });
  const checked = async (name: string | RegExp) => (await item(name)).getAttribute('aria-checked');

  it('defaults to All formats without comments and sends no formats', async () => {
    render(view({ entries: [], appliesTo } as Props));
    expect(button().getAttribute('aria-label')).toBe('Applies to: All formats. Choose the formats');
    expect(button().textContent).toBe('Applies to:All formats');
    expect(await checked('All formats')).toBe('true');
    await userEvent.keyboard('{Escape}');
    await userEvent.type(screen.getByRole('textbox'), 'Warmer');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'c1', { text: 'Warmer', pins: [] }));
  });

  it('defaults to the formats of the attached comments (a follower stands for its primary) and sends them', async () => {
    render(view({ entries: [], appliesTo, pins: [pin('tiktok')] } as Props));
    expect(button().textContent).toBe('Applies to:Reel');
    expect(await checked(/^Reel/)).toBe('true');
    expect(await checked('All formats')).toBe('false');
    expect(screen.getByText('TikTok follows Reel: the change applies to both', { selector: 'p' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await userEvent.type(screen.getByRole('textbox'), 'Bigger logo');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'c1', { text: 'Bigger logo', pins: [pin('tiktok')], formats: ['reel'] }));
  });

  it('the checkboxes choose the primaries; a follower is shown by its primary with the reason, never on its own', async () => {
    render(view({ entries: [], appliesTo } as Props));
    await userEvent.click(await item('Post'));
    expect(await checked('Post')).toBe('true');
    expect(await checked('All formats')).toBe('false');
    expect(button().textContent).toBe('Applies to:Post');
    // TikTok follows the Reel: it is in the Reel's row, with the reason as its tooltip, and has no checkbox of its own.
    const reel = await item(/^Reel/);
    expect(reel.textContent).toContain('TikTok');
    expect(reel.querySelector('[title]')!.getAttribute('title')).toBe('TikTok follows Reel: the change applies to both');
    expect(within(await open()).queryByRole('menuitemcheckbox', { name: 'TikTok' })).toBeNull();
    // Choosing every primary is "All formats" again.
    await userEvent.click(reel);
    expect(await checked('All formats')).toBe('true');
    await userEvent.click(await item('Post'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(button().getAttribute('aria-expanded')).toBe('false'));
    await userEvent.type(screen.getByRole('textbox'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'c1', { text: 'x', pins: [], formats: ['post'] }));
  });

  it('the menu groups the formats as the formats column, with a checkbox per group; the button says what is chosen', async () => {
    const shots = ['as1', 'as2', 'as3', 'as4'];
    const grouped = {
      primaries: [...shots.map((id, i) => ({ id, label: `App Store · ${i + 1}`, followers: [] })), { id: 'ps1', label: 'Play Store · 1', followers: [] }, { id: 'ps2', label: 'Play Store · 2', followers: [] }],
      followerOf: () => null,
      groups: [{ label: 'App Store', items: shots.map((id, i) => ({ id, name: `${i + 1}` })) }, { label: 'Play Store', items: [{ id: 'ps1', name: '1' }, { id: 'ps2', name: '2' }] }],
    };
    render(view({ entries: [], appliesTo: grouped } as Props));
    const menu = await open();
    expect(within(menu).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['App Store', 'Play Store']);
    const app = within(menu).getByRole('group', { name: 'App Store' });
    await userEvent.click(within(app).getByRole('menuitemcheckbox', { name: '2' }));
    await userEvent.click(within(app).getByRole('menuitemcheckbox', { name: '3' }));
    expect(within(app).getByRole('menuitemcheckbox', { name: 'App Store: whole group' }).getAttribute('aria-checked')).toBe('mixed');
    expect(button().textContent).toBe('Applies to:App Store · 2 formats');
    await userEvent.click(within(app).getByRole('menuitemcheckbox', { name: 'App Store: whole group' }));
    expect(button().textContent).toBe('Applies to:App Store · 4 formats');
    await userEvent.click(within(within(menu).getByRole('group', { name: 'Play Store' })).getByRole('menuitemcheckbox', { name: '1' }));
    expect(button().textContent).toBe('Applies to:5 formats');
    // Keyboard: arrows move between the checkboxes, Escape closes and gives the focus back to the button.
    (within(menu).getByRole('menuitemcheckbox', { name: 'All formats' })).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(within(app).getByRole('menuitemcheckbox', { name: 'App Store: whole group' }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(button().getAttribute('aria-expanded')).toBe('false'));
    expect(document.activeElement).toBe(button());
    // A click outside closes it too.
    await open();
    await userEvent.click(screen.getByRole('textbox'));
    await waitFor(() => expect(button().getAttribute('aria-expanded')).toBe('false'));
    await userEvent.type(screen.getByRole('textbox'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'c1', { text: 'x', pins: [], formats: ['as1', 'as2', 'as3', 'as4', 'ps1'] }));
  });

  it('a chosen format that is no longer a primary is dropped, before sending too', async () => {
    const { rerender } = render(view({ entries: [], appliesTo } as Props));
    await userEvent.click(await item('Post'));
    await userEvent.keyboard('{Escape}');
    // The post now follows the reel: only the reel is left, the choice falls back to the default (All).
    const linked = { primaries: [{ id: 'reel', label: 'Reel', followers: ['TikTok', 'Post'] }, { id: 'story', label: 'Story', followers: [] }], followerOf: (id: string) => (id === 'tiktok' || id === 'post' ? 'reel' : null) };
    rerender(view({ entries: [], appliesTo: linked } as Props));
    expect(button().textContent).toBe('Applies to:All formats');
    await userEvent.type(screen.getByRole('textbox'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'c1', { text: 'x', pins: [] }));
  });

  it('a coded send refusal gets its clear message', async () => {
    api.sendCreativeTurn.mockRejectedValueOnce(Object.assign(new ApiError(400, 'raw'), { code: 'formats-not-in-brief' }));
    render(view({ entries: [], appliesTo } as Props));
    await userEvent.type(screen.getByRole('textbox'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toBe('None of the chosen formats is in the brief any more: choose them again.');
  });

  it('a coded refusal it has no message for keeps the generic handling (409: busy)', async () => {
    api.sendCreativeTurn.mockRejectedValueOnce(Object.assign(new ApiError(409, 'raw'), { code: 'some-other-code' }));
    render(view({ entries: [], appliesTo } as Props));
    await userEvent.type(screen.getByRole('textbox'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    const busy = (await screen.findByRole('alert')).textContent;
    expect(busy).toBe('A generation is already running for this creative. Wait for it to finish, then send again.');
    api.sendCreativeTurn.mockRejectedValueOnce(Object.assign(new ApiError(500, 'socket hang up'), { code: 'some-other-code' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/socket hang up/));
    expect(screen.getByRole('alert').textContent).not.toBe(busy);
  });

  it('no choice without appliesTo (one primary, no version yet)', () => {
    render(view({ entries: [] }));
    expect(screen.queryByRole('button', { name: /^Applies to: / })).toBeNull();
  });

  it('a warning line is set apart from info, never an alert', () => {
    render(view({ entries: [
      { type: 'system', at: at(1), level: 'info', text: 'Restarted from v1' },
      { type: 'system', at: at(2), level: 'warning', text: 'TikTok was unlinked: it is longer than its limit' },
    ] }));
    const warning = screen.getByText('TikTok was unlinked: it is longer than its limit').closest('p')!;
    expect(warning.classList.contains('ms-warning')).toBe(true);
    expect(warning.getAttribute('role')).toBeNull();
    expect(warning.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('Restarted from v1').classList.contains('ms-warning')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('composer: labels, shortcut and floating dock (user test notes 24, 25)', () => {
  it('the send button shows the shortcut glyph and the textarea placeholder says it (macOS)', () => {
    render(view({ entries: [] }));
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send.textContent).toContain('⌘↵');
    expect(send.querySelector('svg')).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).placeholder).toContain('⌘↵ to send');
  });

  it('uses Ctrl+↵ off macOS', () => {
    onPlatform('Win32');
    render(view({ entries: [] }));
    expect(screen.getByRole('button', { name: 'Send' }).textContent).toContain('Ctrl+↵');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).placeholder).toContain('Ctrl+↵ to send');
  });

  it('the queue button also shows the shortcut while the agent works', async () => {
    render(view({ entries: [], job: running }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Queue for after' }).textContent).toContain('⌘↵'));
  });

  it('the list is padded by the live height of the dock that floats over it', () => {
    let observe: (() => void) | undefined;
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { observe = cb; } observe() {} disconnect() {} unobserve() {} });
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(150);
    try {
      const { container } = render(view({ entries: [] }));
      const convo = container.querySelector('.ms-convo') as HTMLElement;
      expect(container.querySelector('.ms-convo-dock form.ms-composer')).toBeTruthy();
      expect(convo.style.getPropertyValue('--ms-dock-h')).toBe('150px');
      height.mockReturnValue(220);
      act(() => observe?.());
      expect(convo.style.getPropertyValue('--ms-dock-h')).toBe('220px');
    } finally { height.mockRestore(); vi.unstubAllGlobals(); }
  });
});

describe('Conversation · one chat for a variant group (decisions 980 and 982, phase 2)', () => {
  const user = (min: number, t: string, variant?: string, sec = 0): ConversationEntry => ({ type: 'user', at: at(min).replace(':00.000Z', `:${String(sec).padStart(2, '0')}.000Z`), text: t, pins: [], attachments: [], ...(variant ? { variant } : {}) });
  const chips = (el: HTMLElement) => [...el.querySelectorAll('.ms-vchip')].map((c) => c.textContent);

  it('every entry of a variant carries its chip; an entry with no variant has none', () => {
    render(view({ entries: [
      user(1, 'Per B', 'b'), { ...agent(2, text('Fatto su B'), 'jb'), variant: 'b' },
      { type: 'version', at: at(3), n: 4, status: 'complete', variant: 'b' }, { type: 'system', at: at(4), level: 'info', text: 'Nota di A', variant: 'a' },
      user(5, 'Senza gruppo'),
    ] }));
    const [b, none] = screen.getAllByRole('article', { name: 'You' });
    expect(chips(b!)).toEqual(['B']);
    expect(within(b!).getByTitle('Variant B')).toBeTruthy();
    expect(chips(none!)).toEqual([]);
    expect(chips(screen.getByRole('article', { name: 'Agent' }))).toEqual(['B']);
    expect(chips(screen.getByText('Nota di A').closest('p')!)).toEqual(['A']);
  });

  it('the same request sent to several variants at once ("Tutte") is one bubble with their chips, by its request id (decision 1166)', () => {
    const f = (e: ConversationEntry): ConversationEntry => ({ ...e, fanout: 'r1' } as ConversationEntry);
    render(view({ entries: [f(user(1, 'Più contrasto', 'a', 1)), f(user(1, 'Più contrasto', 'b', 2)), f(user(1, 'Più contrasto', 'c', 3)), user(1, 'Più contrasto', 'b', 4)] }));
    const bubbles = screen.getAllByRole('article', { name: 'You' });
    // The same words sent again to B alone, seconds later, are their own message.
    expect(bubbles).toHaveLength(2);
    expect(chips(bubbles[0]!)).toEqual(['A', 'B', 'C']);
    expect(chips(bubbles[1]!)).toEqual(['B']);
  });

  it('a version card of another variant opens that variant; its own keeps "View vN" and its extras', async () => {
    const onOpenVariant = vi.fn();
    const versionExtra = vi.fn(() => <span>extra</span>);
    render(view({ self: 'a', onOpenVariant, versionExtra, entries: [
      { type: 'version', at: at(1), n: 2, status: 'complete', variant: 'a' }, { type: 'version', at: at(2), n: 4, status: 'complete', variant: 'b' },
    ] } as Props));
    expect(screen.queryByRole('button', { name: 'View v4' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Open B · v4' }));
    expect(onOpenVariant).toHaveBeenCalledWith('b');
    await userEvent.click(screen.getByRole('button', { name: 'View v2' }));
    expect(props.onSelectVersion).toHaveBeenCalledWith(2);
    expect(versionExtra).toHaveBeenCalledWith(2);
    expect(versionExtra).not.toHaveBeenCalledWith(4);
  });

  it('a retry is per variant: the same words to another variant after a failure are a full bubble', () => {
    render(view({ entries: [
      user(1, 'Bigger logo', 'a'), { ...agent(2, { kind: 'result', ok: false, error: 'boom' }, 'ja'), variant: 'a' }, user(5, 'Bigger logo', 'b'),
    ] }));
    expect(screen.getAllByRole('article', { name: 'You' })).toHaveLength(2);
    expect(screen.queryByText(/^Retried · /)).toBeNull();
  });

  it('review minor 8: another variant\'s turn with only live events so far carries its chip too', () => {
    const jc: JobSummary = { ...running, id: 'jc', key: 'creative:k~c' };
    render(view({ entries: [], memberJobs: [{ job: jc, live: [text('C parte')], variant: 'c' }] } as Props));
    expect(chips(screen.getByText('C parte').closest('article')!)).toEqual(['C']);
  });

  it('review minor 6: with no way to open it (a host whose group is gone, the editor), another variant\'s version card has no button at all', () => {
    render(view({ self: 'a', entries: [{ type: 'version', at: at(2), n: 4, status: 'complete', variant: 'b' }] } as Props));
    expect(screen.queryByRole('button', { name: /v4/ })).toBeNull();
  });

  it('another variant\'s running turn continues live in the same chat', () => {
    const jb: JobSummary = { ...running, id: 'jb', key: 'creative:k~b' };
    render(view({ entries: [user(1, 'Per B', 'b'), { ...agent(2, text('Inizio B'), 'jb'), variant: 'b' }], memberJobs: [{ job: jb, live: [text('Inizio B'), text('B continua')] }] } as Props));
    expect(screen.getByText('Inizio B')).toBeTruthy();
    expect(screen.getByText('B continua')).toBeTruthy();
    expect(chips(screen.getByText('B continua').closest('article')!)).toEqual(['B']);
  });

  describe('report 97: the chat is in time order whatever variant writes (decision 1986)', () => {
    const ja: JobSummary = { ...running, id: 'ja', key: 'creative:k' };
    const jb: JobSummary = { ...running, id: 'jb', key: 'creative:k~b' };
    const apA: ApprovalRequest = { ...ap, id: 'apa', jobId: 'ja', title: 'A wants to run', createdAt: at(4) };
    const fan = (v: string): ConversationEntry => ({ ...user(0, 'Più contrasto', v), fanout: 'r1' } as ConversationEntry);
    const said = (min: number, words: string, jobId: string, variant: string): ConversationEntry => ({ ...agent(min, text(words), jobId), variant } as ConversationEntry);
    const markers = ['Più contrasto', 'A parte', 'B parte', 'A scrive', 'A wants to run', 'B scrive'];
    const order = (container: HTMLElement) => [...container.querySelectorAll('.ms-convo-list > li')].map((li) => markers.find((m) => li.textContent?.includes(m))).filter(Boolean);
    const expected = ['Più contrasto', 'A parte', 'B parte', 'A scrive', 'A wants to run', 'B scrive'];
    const persisted = [fan('a'), fan('b'), said(1, 'A parte', 'ja', 'a'), said(2, 'B parte', 'jb', 'b'), said(3, 'A scrive', 'ja', 'a'), said(5, 'B scrive', 'jb', 'b')];

    it('two variants working at once: A, B, A, A\'s card, B, the card with A\'s chip and at the bottom when it came', () => {
      const { container } = render(view({ self: 'a', entries: persisted, approvals: [apA], memberJobs: [{ job: ja, live: [], variant: 'a' }, { job: jb, live: [], variant: 'b' }] } as Props));
      expect(order(container)).toEqual(expected);
      const card = container.querySelector('[data-variant="a"]')!;
      expect(chips(card as HTMLElement)).toEqual(['A']);
      // The fan-out request is still one bubble with both chips.
      expect(chips(screen.getByRole('article', { name: 'You' }))).toEqual(['A', 'B']);
    });

    it('live events give the same order as the persisted entries after a reload', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const entries = [fan('a'), fan('b')];
        const members = (a: AgentEvent[], b: AgentEvent[]) => [{ job: ja, live: a, variant: 'a' as const }, { job: jb, live: b, variant: 'b' as const }];
        vi.setSystemTime(new Date(at(1)));
        const { container, rerender, unmount } = render(view({ self: 'a', entries, memberJobs: members([text('A parte')], []) } as Props));
        vi.setSystemTime(new Date(at(2)));
        rerender(view({ self: 'a', entries, memberJobs: members([text('A parte')], [text('B parte')]) } as Props));
        vi.setSystemTime(new Date(at(3)));
        rerender(view({ self: 'a', entries, memberJobs: members([text('A parte'), text('A scrive')], [text('B parte')]) } as Props));
        vi.setSystemTime(new Date(at(4)));
        rerender(view({ self: 'a', entries, approvals: [apA], memberJobs: members([text('A parte'), text('A scrive')], [text('B parte')]) } as Props));
        // The newest thing is the card: it is at the bottom of the flow.
        expect(order(container).at(-1)).toBe('A wants to run');
        vi.setSystemTime(new Date(at(5)));
        rerender(view({ self: 'a', entries, approvals: [apA], memberJobs: members([text('A parte'), text('A scrive')], [text('B parte'), text('B scrive')]) } as Props));
        expect(order(container)).toEqual(expected);
        unmount();
      } finally { vi.useRealTimers(); }
      // The reload: the same turns read from the conversation file.
      const again = render(view({ self: 'a', entries: persisted, approvals: [apA], memberJobs: [{ job: ja, live: [], variant: 'a' }, { job: jb, live: [], variant: 'b' }] } as Props));
      expect(order(again.container)).toEqual(expected);
    });

    it('tool steps stay with their variant\'s segment: no A/B flip on every step', () => {
      const step = (min: number, words: string, jobId: string, variant: string): ConversationEntry => ({ ...agent(min, { kind: 'progress', text: words }, jobId), variant } as ConversationEntry);
      const { container } = render(view({ self: 'a', entries: [fan('a'), fan('b'), said(1, 'A parte', 'ja', 'a'), step(2, 'Passo A1', 'ja', 'a'), said(2, 'B parte', 'jb', 'b'), step(3, 'Passo A2', 'ja', 'a'), step(3, 'Passo B1', 'jb', 'b')],
        memberJobs: [{ job: ja, live: [], variant: 'a' }, { job: jb, live: [], variant: 'b' }] } as Props));
      const rows = [...container.querySelectorAll('.ms-convo-list > li')].map((li) => li.textContent ?? '');
      const idx = (w: string) => rows.findIndex((r) => r.includes(w));
      expect(idx('Passo A1')).toBeLessThan(idx('B parte'));
      expect(idx('Passo A2')).toBeLessThan(idx('B parte'));
      expect(idx('Passo B1')).toBeGreaterThan(idx('B parte'));
    });

    it('single agent: a helper\'s card is in time order, below the later helper rows, never inside its row', () => {
      const g: JobSummary = { ...running, id: 'g1', key: 'group:k' };
      const hb: JobSummary = { ...running, id: 'hb', key: 'creative:k~b', parentJobId: 'g1', variant: 'b' };
      const hc: JobSummary = { ...running, id: 'hc', key: 'creative:k~c', parentJobId: 'g1', variant: 'c' };
      const q: ApprovalRequest = { ...ap, id: 'qb', jobId: 'hb', creativeSlug: 'c1~b', title: 'B wants to run', createdAt: at(3) };
      const { container } = render(view({ self: 'a', single: true, job: g, approvals: [q], entries: [
        { type: 'user', at: at(0), text: 'B e C', pins: [], attachments: [], jobId: 'g1', group: true },
        { type: 'agent', at: at(0), jobId: 'g1', event: text('Lavoro su B e C.'), group: true },
        { type: 'agent', at: at(1), jobId: 'hb', event: text('Inizio B'), variant: 'b', groupJobId: 'g1' },
        { type: 'agent', at: at(2), jobId: 'hc', event: text('Inizio C'), variant: 'c', groupJobId: 'g1' },
      ], memberJobs: [{ job: hb, live: [], variant: 'b' }, { job: hc, live: [], variant: 'c' }] } as Props));
      const lis = [...container.querySelectorAll('.ms-convo-list > li')];
      const rowC = lis.findIndex((li) => li.querySelector('[data-helper="c"]'));
      const card = lis.findIndex((li) => li.textContent?.includes('B wants to run'));
      expect(rowC).toBeGreaterThan(-1);
      expect(card).toBeGreaterThan(rowC);
      expect(container.querySelector('.ms-convo-helper-card')).toBeNull();
      expect(chips(container.querySelector('[data-variant="b"]') as HTMLElement)).toEqual(['B']);
    });
  });
});
