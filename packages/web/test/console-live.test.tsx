import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JobSummary } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

const api = {
  stopJob: vi.fn(async (_id: string) => ({ status: 'stopping' })),
  redirectJob: vi.fn(async (_id: string, _b: unknown) => ({ outcome: 'restarted' as const })),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
  sendConsoleMessage: vi.fn(async (_id: string, _b: unknown) => ({ outcome: 'delivered-pending' as const })),
  getConversation: vi.fn(async () => []),
};
class ApiError extends Error { constructor(public status: number, m: string, public code?: string) { super(m); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { ActivityCenter } = await import('../src/shell/ActivityCenter.tsx');
const { initialEventsState } = await import('../src/eventsReducer.ts');
const { ConsoleMessageBox } = await import('../src/components/ConsoleMessageBox.tsx');

const consoleJob: JobSummary = { id: 'k1', key: 'project:/w:acme', kind: 'console', label: 'Console · Acme', state: 'running', createdAt: '2026-10-14T10:00:00.000Z' };
const creativeJob: JobSummary = { id: 'j1', key: 'creative:/w:acme:c1', kind: 'creative', label: 'Post', state: 'running', createdAt: '2026-10-14T10:00:01.000Z' };
const analysis: JobSummary = { id: 'b1', key: 'brand:/w:acme', kind: 'brand-analysis', label: 'Brand analysis', state: 'running', createdAt: '2026-10-14T10:00:02.000Z' };
const render_: JobSummary = { id: 'r1', key: 'render:/w:acme:c1:v1', kind: 'render', label: 'Render', state: 'running', createdAt: '2026-10-14T10:00:03.000Z' };
const live = (...jobs: JobSummary[]) => ({ ...initialEventsState, jobs: Object.fromEntries(jobs.map((j) => [j.id, j])) });
const center = (...jobs: JobSummary[]) => render(<I18nProvider locale="en"><ActivityCenter live={live(...jobs)} initialTab="running" where={() => 'Acme'} /></I18nProvider>);
beforeEach(() => vi.clearAllMocks());

describe('Activity center uses the same Stop menu', () => {
  it('a creative turn and a console turn have Stop and "Stop and redirect…"', async () => {
    center(consoleJob, creativeJob);
    expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Stop options' })).toHaveLength(2);
  });

  it('Stop on a console turn goes through the job route, with no confirmation', async () => {
    center(consoleJob);
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(api.stopJob).toHaveBeenCalledWith('k1');
    expect(api.cancelJob).not.toHaveBeenCalled();
  });

  it('Stop and redirect on a console turn posts the words to the job redirect route', async () => {
    center(consoleJob);
    await userEvent.click(screen.getByRole('button', { name: 'Stop options' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Stop and redirect…' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Change the tool');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Redirect' }));
    await waitFor(() => expect(api.redirectJob).toHaveBeenCalledTimes(1));
    expect(api.redirectJob.mock.calls[0]![0]).toBe('k1');
    expect((api.redirectJob.mock.calls[0]![1] as { text: string }).text).toBe('Change the tool');
  });

  it('a brand analysis has Stop only; a render keeps its own Cancel', () => {
    center(analysis, render_);
    expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Stop options' })).toBeNull();
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeTruthy();
  });
});

describe('console message box', () => {
  const box = (props: Partial<React.ComponentProps<typeof ConsoleMessageBox>> = {}) => render(
    <I18nProvider locale="en"><ConsoleMessageBox jobId="k1" liveInput {...props} /></I18nProvider>,
  );

  it('sends a message to the running console turn; a double click sends once', async () => {
    box();
    await userEvent.type(screen.getByRole('textbox'), 'Also check the fonts');
    const send = screen.getByRole('button', { name: 'Send to agent' });
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() => expect(api.sendConsoleMessage).toHaveBeenCalledTimes(1));
    const [id, body] = api.sendConsoleMessage.mock.calls[0]! as unknown as [string, { clientId: string; text: string }];
    expect([id, body.text]).toEqual(['k1', 'Also check the fonts']);
    expect(body.clientId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(''));
  });

  it('has no queue action: with live input off it says the console takes no messages mid-turn', async () => {
    box({ liveInput: false });
    expect(screen.queryByRole('button', { name: 'Queue for after' })).toBeNull();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText(/need live input, which is off/)).toBeTruthy();
    expect(api.sendConsoleMessage).not.toHaveBeenCalled();
  });

  it('shows the core’s refusal (turn over) and keeps the words', async () => {
    api.sendConsoleMessage.mockRejectedValueOnce(new ApiError(409, 'The console turn has already finished: send it as a new message.', 'not-running'));
    box();
    await userEvent.type(screen.getByRole('textbox'), 'late');
    await userEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
    expect((await screen.findByRole('alert')).textContent).toContain('already finished');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('late');
  });

  it('has the same Stop menu: Stop and redirect go through the job routes', async () => {
    box({ job: consoleJob });
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(api.stopJob).toHaveBeenCalledWith('k1');
  });
});
