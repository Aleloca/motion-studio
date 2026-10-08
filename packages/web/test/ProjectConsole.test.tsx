import type { JobSummary } from '@motion-studio/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.ts';
import { ProjectConsole } from '../src/screens/ProjectConsole.tsx';

vi.mock('../src/api.ts', () => ({
  ApiError: class extends Error {},
  api: { getProject: vi.fn(), startTurn: vi.fn(), cancelJob: vi.fn() },
}));

const project = { schemaVersion: 1 as const, name: 'Acme', description: '', createdAt: '2026-10-07T10:00:00.000Z', updatedAt: '2026-10-07T10:00:00.000Z', linkedCodebases: [] };
const job = (over: Partial<JobSummary>): JobSummary => ({ id: 'j1', key: 'project:/w:acme', kind: 'console', label: 'Turno · Acme', state: 'running', createdAt: '2026-10-07T10:00:00.000Z', ...over });
const live = (jobs: Record<string, JobSummary>) => ({ approvals: {}, jobs, events: {}, creativeTicks: {}, projectTicks: {} });

describe('ProjectConsole after a reload', () => {
  afterEach(() => vi.clearAllMocks());
  it('attaches to the active job of this project, resumes its session and reports cancel errors', async () => {
    vi.mocked(api.getProject).mockResolvedValue({ slug: 'acme', project, jobKey: 'project:/w:acme' });
    vi.mocked(api.cancelJob).mockRejectedValue(new Error('server giù'));
    const other = job({ id: 'j0', key: 'project:/w:altro' });
    render(<ProjectConsole slug="acme" expert={false} live={live({ j0: other, j1: job({ sessionId: 'sess-9' }) })} />);
    expect(await screen.findByText('sessione sess-9')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('server giù'));
  });
  it('uses the attached job session id for the next turn (no events after a reload)', async () => {
    vi.mocked(api.getProject).mockResolvedValue({ slug: 'acme', project, jobKey: 'project:/w:acme' });
    vi.mocked(api.startTurn).mockResolvedValue(job({ id: 'j2', state: 'queued' }));
    const { rerender } = render(<ProjectConsole slug="acme" expert={false} live={live({ j1: job({}) })} />);
    await waitFor(() => expect(api.getProject).toHaveBeenCalled());
    await screen.findByRole('button', { name: 'Annulla' });
    rerender(<ProjectConsole slug="acme" expert={false} live={live({ j1: job({ state: 'succeeded', sessionId: 'sess-9' }) })} />);
    await userEvent.type(screen.getByLabelText(/Chiedi all'agente/), 'ciao');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    expect(api.startTurn).toHaveBeenCalledWith('acme', 'ciao', 'sess-9');
  });
  it('does not attach to finished jobs', async () => {
    vi.mocked(api.getProject).mockResolvedValue({ slug: 'acme', project, jobKey: 'project:/w:acme' });
    render(<ProjectConsole slug="acme" expert={false} live={live({ j1: job({ state: 'succeeded', sessionId: 'sess-9' }) })} />);
    await waitFor(() => expect(api.getProject).toHaveBeenCalled());
    expect(screen.queryByText('sessione sess-9')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Annulla' })).toBeNull();
  });
  it('shows a getProject failure', async () => {
    vi.mocked(api.getProject).mockRejectedValue(new Error('Progetto non trovato'));
    render(<ProjectConsole slug="acme" expert={false} live={live({})} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Impossibile caricare il progetto: Progetto non trovato');
  });
});
