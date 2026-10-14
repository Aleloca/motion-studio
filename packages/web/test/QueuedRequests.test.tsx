import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { QueuedRequest } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

const api = {
  removeQueued: vi.fn(async (..._a: unknown[]) => ({})),
  editQueued: vi.fn(async (..._a: unknown[]) => ({})),
  reorderQueue: vi.fn(async (..._a: unknown[]) => ({})),
  runNext: vi.fn(async (..._a: unknown[]) => ({})),
};
class ApiError extends Error { constructor(public status: number, m: string, public code?: string) { super(m); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { QueuedRequests } = await import('../src/components/QueuedRequests.tsx');

const item = (n: number, extra: Partial<QueuedRequest> = {}): QueuedRequest => ({ clientId: `c${n}`, text: `Request ${n}`, pins: [], at: '2026-10-14T10:00:00.000Z', ...extra });
const three = [item(1), item(2), item(3)];
const onChanged = vi.fn();
const view = (queued: QueuedRequest[], working = false) => render(
  <I18nProvider locale="en"><QueuedRequests slug="acme" creative="c1" queued={queued} working={working} onChanged={onChanged} /></I18nProvider>,
);
const order = () => within(screen.getByRole('list', { name: 'Queued requests' })).getAllByRole('listitem').map((li) => li.querySelector('[data-text]')!.textContent);
beforeEach(() => vi.clearAllMocks());

describe('QueuedRequests', () => {
  it('renders nothing for an empty queue', () => {
    const { container } = view([]);
    expect(container.textContent).toBe('');
  });

  it('lists the requests in order, each marked Queued', () => {
    view(three, true);
    expect(order()).toEqual(['Request 1', 'Request 2', 'Request 3']);
    expect(screen.getByText('3 requests queued')).toBeTruthy();
    expect(screen.getAllByText('Queued')).toHaveLength(3);
  });

  it('shows pins as a count', () => {
    view([item(1, { pins: [{ format: 'f', x: 0, y: 0, timeSec: null, note: '' } as never] })], true);
    expect(screen.getByText('1 comment')).toBeTruthy();
  });

  it('removes a request', async () => {
    view(three, true);
    await userEvent.click(screen.getByRole('button', { name: 'Remove queued request 2' }));
    await waitFor(() => expect(api.removeQueued).toHaveBeenCalledWith('acme', 'c1', 'c2'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('edits a request in place: Save sends the new text with its pins; Cancel keeps it', async () => {
    const pins = [{ format: 'f', x: 1, y: 2, timeSec: null, note: 'n' } as never];
    view([item(1, { pins }), item(2)], true);
    await userEvent.click(screen.getByRole('button', { name: 'Edit queued request 1' }));
    const field = screen.getByRole('textbox', { name: 'Queued request text' }) as HTMLTextAreaElement;
    expect(field.value).toBe('Request 1');
    await waitFor(() => expect(document.activeElement).toBe(field));
    await userEvent.clear(field);
    await userEvent.type(field, 'Changed');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.editQueued).toHaveBeenCalledWith('acme', 'c1', 'c1', { text: 'Changed', pins }));
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: 'Edit queued request 2' }));
    await userEvent.type(screen.getByRole('textbox'), ' more');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.editQueued).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('cannot save an empty request without comments', async () => {
    view([item(1)], true);
    await userEvent.click(screen.getByRole('button', { name: 'Edit queued request 1' }));
    await userEvent.clear(screen.getByRole('textbox'));
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('moves with the keyboard alternative: Move down / Move up buttons save the new order', async () => {
    view(three, true);
    expect((screen.getByRole('button', { name: 'Move queued request 1 up' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Move queued request 3 down' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Move queued request 1 down' }));
    expect(order()).toEqual(['Request 2', 'Request 1', 'Request 3']);
    await waitFor(() => expect(api.reorderQueue).toHaveBeenCalledWith('acme', 'c1', ['c2', 'c1', 'c3']));
    expect(screen.getByRole('status').textContent).toBe('Request 1 moved to position 2');
    await userEvent.click(screen.getByRole('button', { name: 'Move queued request 3 up' }));
    await waitFor(() => expect(api.reorderQueue).toHaveBeenLastCalledWith('acme', 'c1', ['c2', 'c3', 'c1']));
  });

  it('reorders by drag and drop and saves the order', async () => {
    view(three, true);
    const rows = screen.getAllByRole('listitem');
    fireEvent.dragStart(rows[0]!, { dataTransfer: { setData() {}, effectAllowed: '' } });
    fireEvent.dragOver(rows[2]!, { dataTransfer: { dropEffect: '' } });
    fireEvent.drop(rows[2]!, { dataTransfer: {} });
    fireEvent.dragEnd(rows[0]!);
    expect(order()).toEqual(['Request 2', 'Request 3', 'Request 1']);
    await waitFor(() => expect(api.reorderQueue).toHaveBeenCalledWith('acme', 'c1', ['c2', 'c3', 'c1']));
  });

  it('a refused order (the queue changed) is explained, and the list is reloaded', async () => {
    api.reorderQueue.mockRejectedValueOnce(new ApiError(409, 'x', 'queue-changed'));
    view(three, true);
    await userEvent.click(screen.getByRole('button', { name: 'Move queued request 1 down' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The queue changed meanwhile: reload it and try again.');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('a request that already started cannot be removed: the reason is translated', async () => {
    api.removeQueued.mockRejectedValueOnce(new ApiError(404, 'x', 'not-queued'));
    view(three, true);
    await userEvent.click(screen.getByRole('button', { name: 'Remove queued request 1' }));
    expect((await screen.findByRole('alert')).textContent).toContain('This request is no longer queued');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('hides "Run next" for a moment right after a turn ends, until the queue settles', async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<I18nProvider locale="en"><QueuedRequests slug="acme" creative="c1" queued={three} working onChanged={onChanged} /></I18nProvider>);
      rerender(<I18nProvider locale="en"><QueuedRequests slug="acme" creative="c1" queued={three} working={false} onChanged={onChanged} /></I18nProvider>);
      expect(screen.queryByRole('button', { name: 'Run next' })).toBeNull();
      await act(async () => { vi.advanceTimersByTime(1100); });
      expect(screen.getByRole('button', { name: 'Run next' })).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it('ignores a drop while a save is in flight', async () => {
    let finish!: () => void;
    api.reorderQueue.mockImplementationOnce(() => new Promise((r) => { finish = () => r({}); }));
    view(three, true);
    await userEvent.click(screen.getByRole('button', { name: 'Move queued request 1 down' }));
    const rows = screen.getAllByRole('listitem');
    fireEvent.dragStart(rows[0]!, { dataTransfer: { setData() {}, effectAllowed: '' } });
    fireEvent.drop(rows[2]!, { dataTransfer: {} });
    expect(api.reorderQueue).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it('shows "Run next" only when nothing is running, and starts the first request', async () => {
    const { unmount } = view(three, true);
    expect(screen.queryByRole('button', { name: 'Run next' })).toBeNull();
    unmount();
    view(three, false);
    expect(screen.getByText('Nothing is running: the queue waits for you.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Run next' }));
    await waitFor(() => expect(api.runNext).toHaveBeenCalledWith('acme', 'c1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('a Run next refused because a job is running says why', async () => {
    api.runNext.mockRejectedValueOnce(new ApiError(409, 'A generation is already running for this creative.', 'job-running'));
    view(three, false);
    await userEvent.click(screen.getByRole('button', { name: 'Run next' }));
    expect((await screen.findByRole('alert')).textContent).toContain('A generation is already running for this creative.');
  });

  it('is in Italian when the language is Italian', () => {
    render(<I18nProvider locale="it"><QueuedRequests slug="a" creative="c" queued={three} working={false} onChanged={() => {}} /></I18nProvider>);
    expect(screen.getByRole('button', { name: 'Avvia la prossima' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Richieste in coda' })).toBeTruthy();
  });
});
