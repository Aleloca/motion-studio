import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentEvent, ApprovalRequest, ConversationEntry, JobSummary, Pin } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

const api = {
  sendCreativeTurn: vi.fn(async () => ({})),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
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

  it('removes a pending comment chip and blocks sending while a job runs', async () => {
    const pins: Pin[] = [{ format: 'story', x: 0.1, y: 0.2, timeSec: null }];
    render(view({ entries: [], pins, job: running }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove comment 1' }));
    expect(props.onRemovePin).toHaveBeenCalledWith(0);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.cancelJob).toHaveBeenCalledWith('j1');
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
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
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
    const line = screen.getByText('3 commands ran automatically in the sandbox');
    const wrap = line.closest('.ms-convo-autoline') as HTMLElement;
    expect(wrap).toBeTruthy();
    // A line, not a message bubble.
    expect(wrap.closest('article')).toBeNull();
    expect(wrap.querySelector('.ms-msg-bubble')).toBeNull();
    const details = screen.getByRole('button', { name: 'Activity details (4)' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    const open = within(wrap).getByRole('button', { name: 'Details' });
    expect(document.getElementById(open.getAttribute('aria-describedby')!)!.textContent).toBe('3 commands ran automatically in the sandbox');
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
    expect(screen.getByText('2 commands ran automatically in the sandbox')).toBeTruthy();
  });

  it('says it once for one command, and not while the turn runs or when nothing ran automatically', () => {
    const { rerender } = render(view({ entries: [agent(2, auto('ffprobe'))], job: done }));
    expect(screen.getByText('1 command ran automatically in the sandbox')).toBeTruthy();
    rerender(view({ entries: [agent(2, auto('ffprobe'))], job: running }));
    expect(screen.queryByText(/ran automatically/)).toBeNull();
    rerender(view({ entries: [agent(2, text('Hi'))], job: done }));
    expect(screen.queryByText(/ran automatically/)).toBeNull();
  });
});

describe('mergeJobEvents', () => {
  it('shows the overlap between persisted and live events once', () => {
    expect(mergeJobEvents([text('a'), text('b')], [text('b'), text('c')]).map((e) => (e.kind === 'text' ? e.text : ''))).toEqual(['a', 'b', 'c']);
  });
});
