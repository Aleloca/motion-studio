import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type ConversationEntry, type CreativeDetail, type JobSummary } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  sendCreativeTurn: vi.fn(async () => ({})),
  updateCreative: vi.fn(async () => ({})),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ConversationPanel, mergeJobEvents } = await import('../src/components/ConversationPanel.tsx');

const at = '2026-10-07T10:00:00.000Z';
const detail = (versions = 1): CreativeDetail => ({
  slug: 'c1', jobKey: 'creative:k',
  creative: { schemaVersion: 1, title: 'Lancio', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'Lancio app', message: '', formats: ['instagram-post-1x1'], durationSec: 15, assets: [], notes: '' } },
  versions: Array.from({ length: versions }, (_, i) => ({ n: i + 1, commit: 'c', sessionId: 's', status: 'complete' as const, createdAt: at, request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null })),
});
const conversation: ConversationEntry[] = [
  { type: 'user', at, text: 'Logo più grande', pins: [{ format: 'instagram-post-1x1', x: 0.5, y: 0.5, timeSec: 2 }], attachments: [] },
  { type: 'agent', at, jobId: 'old', event: { kind: 'text', text: 'Ingrandisco il logo.' } },
  { type: 'agent', at, jobId: 'old', event: { kind: 'tool_use', id: 't', name: 'Write', input: {} } },
  { type: 'version', at, n: 1, status: 'complete' },
  { type: 'system', at, level: 'error', text: 'Generazione non riuscita: boom' },
];
const running: JobSummary = { id: 'j1', key: 'creative:k', label: 'x', state: 'running', createdAt: at };
const base = {
  slug: 'acme', presets: DEFAULT_FORMATS, liveEvents: [], expert: false, pins: [],
  onRemovePin: vi.fn(), onSent: vi.fn(), onSelectVersion: vi.fn(), onChanged: vi.fn(),
};

beforeEach(() => { vi.clearAllMocks(); });

describe('ConversationPanel', () => {
  it('renders the history and selects versions', async () => {
    render(<ConversationPanel {...base} detail={detail()} conversation={conversation} job={undefined} />);
    expect(screen.getByText('Logo più grande')).toBeTruthy();
    expect(screen.getByText('1 · instagram-post-1x1 @ 2.0s')).toBeTruthy();
    expect(screen.getByText('Ingrandisco il logo.')).toBeTruthy();
    expect(screen.queryByText(/Usa lo strumento Write/)).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('boom');
    await userEvent.click(screen.getByRole('button', { name: 'Vedi v1' }));
    expect(base.onSelectVersion).toHaveBeenCalledWith(1);
    expect(screen.queryByRole('tab', { name: 'Esperto' })).toBeNull();
  });
  it('sends a message with pending pins', async () => {
    const pins = [{ format: 'instagram-post-1x1', x: 0.1, y: 0.2, timeSec: null }];
    render(<ConversationPanel {...base} pins={pins} detail={detail()} conversation={[]} job={undefined} />);
    await userEvent.type(screen.getByLabelText('Chiedi una modifica'), 'Più contrasto');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'c1', { text: 'Più contrasto', pins }));
    expect(base.onSent).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Rimuovi commento 1' }));
    expect(base.onRemovePin).toHaveBeenCalledWith(0);
  });
  it('shows live progress, cancels and blocks sending while a job runs', async () => {
    render(<ConversationPanel {...base} detail={detail()} conversation={[{ type: 'agent', at, jobId: 'j1', event: { kind: 'text', text: 'persistito' } }]}
      job={running} liveEvents={[{ kind: 'text', text: 'dal vivo' }, { kind: 'tool_use', id: 't', name: 'Bash', input: {} }]} />);
    // Persisted events of the active job (written before a reload) come first, then the live ones.
    const texts = screen.getAllByText(/persistito|dal vivo/).map((n) => n.textContent);
    expect(texts).toEqual(['persistito', 'dal vivo']);
    expect(screen.getByText('In lavorazione')).toBeTruthy();
    expect(screen.getByText('Usa lo strumento Bash')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Invia' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(api.cancelJob).toHaveBeenCalledWith('j1');
  });
  it('offers "Genera" when there are no versions', async () => {
    render(<ConversationPanel {...base} detail={detail(0)} conversation={[]} job={undefined} />);
    await userEvent.click(screen.getByRole('button', { name: 'Genera' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'c1', {}));
  });
  it('edits the brief and regenerates', async () => {
    render(<ConversationPanel {...base} detail={detail()} conversation={[]} job={undefined} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    const goal = screen.getByLabelText('Obiettivo');
    await userEvent.clear(goal);
    await userEvent.type(goal, 'Nuovo obiettivo');
    await userEvent.click(screen.getByRole('button', { name: 'Salva e rigenera' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'c1', {}));
    expect(api.updateCreative).toHaveBeenCalledWith('acme', 'c1', { title: 'Lancio', brief: expect.objectContaining({ goal: 'Nuovo obiettivo', formats: ['instagram-post-1x1'] }) });
    expect(base.onChanged).toHaveBeenCalled();
  });
  it('shows every agent event in the expert tab', async () => {
    render(<ConversationPanel {...base} expert detail={detail()} conversation={conversation} job={undefined} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Esperto' }));
    expect(screen.getByText('tool Write')).toBeTruthy();
  });
  it('after a reload shows the persisted events of the active job once, also after a refetch mid-job', () => {
    const ev = (text: string) => ({ kind: 'text' as const, text });
    const persisted = (texts: string[]): ConversationEntry[] => texts.map((t) => ({ type: 'agent', at, jobId: 'j1', event: ev(t) }));
    const { rerender } = render(<ConversationPanel {...base} detail={detail()} conversation={persisted(['a', 'b'])} job={running} liveEvents={[]} />);
    const shown = () => screen.getAllByText(/^[a-d]$/).map((n) => n.textContent);
    expect(shown()).toEqual(['a', 'b']);
    rerender(<ConversationPanel {...base} detail={detail()} conversation={persisted(['a', 'b'])} job={running} liveEvents={[ev('c')]} />);
    expect(shown()).toEqual(['a', 'b', 'c']);
    // A creative tick refetches the conversation: 'c' is now persisted too, and 'd' arrived live.
    rerender(<ConversationPanel {...base} detail={detail()} conversation={persisted(['a', 'b', 'c'])} job={running} liveEvents={[ev('c'), ev('d')]} />);
    expect(shown()).toEqual(['a', 'b', 'c', 'd']);
  });
  it('labels a queued job "In coda"', () => {
    render(<ConversationPanel {...base} detail={detail()} conversation={[]} job={{ ...running, state: 'queued' }} />);
    expect(screen.getByText('In coda')).toBeTruthy();
    expect(screen.queryByText('In lavorazione')).toBeNull();
  });
  it('refreshes the page when the brief is saved but regenerating fails', async () => {
    api.sendCreativeTurn.mockRejectedValueOnce(new Error('Una generazione è già in corso per questa creatività'));
    render(<ConversationPanel {...base} detail={detail()} conversation={[]} job={undefined} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    await userEvent.click(screen.getByRole('button', { name: 'Salva e rigenera' }));
    expect((await screen.findByRole('alert')).textContent).toContain('già in corso');
    expect(base.onChanged).toHaveBeenCalled();
  });
  it('does not refresh when saving the brief fails', async () => {
    api.updateCreative.mockRejectedValueOnce(new Error('Brief non valido'));
    render(<ConversationPanel {...base} detail={detail()} conversation={[]} job={undefined} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    await userEvent.click(screen.getByRole('button', { name: 'Salva e rigenera' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Brief non valido');
    expect(api.sendCreativeTurn).not.toHaveBeenCalled();
    expect(base.onChanged).not.toHaveBeenCalled();
  });
  it('falls back to the conversation when expert mode is turned off on the expert tab', async () => {
    const { rerender } = render(<ConversationPanel {...base} expert detail={detail()} conversation={conversation} job={undefined} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Esperto' }));
    rerender(<ConversationPanel {...base} expert={false} detail={detail()} conversation={conversation} job={undefined} />);
    expect(screen.getByRole('tab', { name: 'Conversazione' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Ingrandisco il logo.')).toBeTruthy();
    rerender(<ConversationPanel {...base} expert detail={detail()} conversation={conversation} job={undefined} />);
    expect(screen.getByRole('tab', { name: 'Conversazione' }).getAttribute('aria-selected')).toBe('true');
  });
  it('limits the message to 10000 characters', () => {
    render(<ConversationPanel {...base} detail={detail()} conversation={[]} job={undefined} />);
    expect((screen.getByLabelText('Chiedi una modifica') as HTMLTextAreaElement).maxLength).toBe(10000);
  });
  it('keeps the brief draft across tab switches', async () => {
    render(<ConversationPanel {...base} detail={detail()} conversation={[]} job={undefined} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    await userEvent.clear(screen.getByLabelText('Obiettivo'));
    await userEvent.type(screen.getByLabelText('Obiettivo'), 'Bozza');
    await userEvent.click(screen.getByRole('tab', { name: 'Conversazione' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    expect((screen.getByLabelText('Obiettivo') as HTMLTextAreaElement).value).toBe('Bozza');
  });
});

describe('mergeJobEvents', () => {
  const ev = (text: string) => ({ kind: 'text' as const, text });
  it('drops the overlap between persisted and live events', () => {
    expect(mergeJobEvents([ev('a'), ev('b')], [ev('b'), ev('c')])).toEqual([ev('a'), ev('b'), ev('c')]);
    expect(mergeJobEvents([ev('a'), ev('b')], [ev('a'), ev('b')])).toEqual([ev('a'), ev('b')]);
  });
  it('concatenates when there is no overlap, and handles empty sides', () => {
    expect(mergeJobEvents([ev('a')], [ev('b')])).toEqual([ev('a'), ev('b')]);
    expect(mergeJobEvents([], [ev('b')])).toEqual([ev('b')]);
    expect(mergeJobEvents([ev('a')], [])).toEqual([ev('a')]);
  });
});
