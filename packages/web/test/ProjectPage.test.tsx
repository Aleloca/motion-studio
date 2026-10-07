import type { JobSummary } from '@motion-studio/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.ts';
import { ProjectPage } from '../src/screens/ProjectPage.tsx';

vi.mock('../src/api.ts', () => ({
  ApiError: class extends Error {},
  api: { getProject: vi.fn(), startTurn: vi.fn(), cancelJob: vi.fn() },
}));

const project = { schemaVersion: 1 as const, name: 'Acme', description: '', createdAt: '2026-10-07T10:00:00.000Z', updatedAt: '2026-10-07T10:00:00.000Z', linkedCodebases: [] };
const job = (over: Partial<JobSummary>): JobSummary => ({ id: 'j1', key: 'project:/w:acme', label: 'Turno · Acme', state: 'running', createdAt: '2026-10-07T10:00:00.000Z', ...over });

describe('ProjectPage after a reload', () => {
  afterEach(() => vi.clearAllMocks());
  it('attaches to the active job of this project, resumes its session and reports cancel errors', async () => {
    vi.mocked(api.getProject).mockResolvedValue({ slug: 'acme', project, jobKey: 'project:/w:acme' });
    vi.mocked(api.cancelJob).mockRejectedValue(new Error('server giù'));
    const other = job({ id: 'j0', key: 'project:/w:altro' });
    render(<ProjectPage slug="acme" tab="console" expert={false} live={{ jobs: { j0: other, j1: job({ sessionId: 'sess-9' }) }, events: {}, creativeTicks: {}, projectTicks: {} }} />);
    expect(await screen.findByText('sessione sess-9')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('server giù'));
  });
  it('uses the attached job session id for the next turn (no events after a reload)', async () => {
    vi.mocked(api.getProject).mockResolvedValue({ slug: 'acme', project, jobKey: 'project:/w:acme' });
    vi.mocked(api.startTurn).mockResolvedValue(job({ id: 'j2', state: 'queued' }));
    const { rerender } = render(<ProjectPage slug="acme" tab="console" expert={false} live={{ jobs: { j1: job({}) }, events: {}, creativeTicks: {}, projectTicks: {} }} />);
    await screen.findByText('Acme');
    rerender(<ProjectPage slug="acme" tab="console" expert={false} live={{ jobs: { j1: job({ state: 'succeeded', sessionId: 'sess-9' }) }, events: {}, creativeTicks: {}, projectTicks: {} }} />);
    await userEvent.type(screen.getByLabelText(/Chiedi all'agente/), 'ciao');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    expect(api.startTurn).toHaveBeenCalledWith('acme', 'ciao', 'sess-9');
  });
  it('does not attach to finished jobs', async () => {
    vi.mocked(api.getProject).mockResolvedValue({ slug: 'acme', project, jobKey: 'project:/w:acme' });
    render(<ProjectPage slug="acme" tab="console" expert={false} live={{ jobs: { j1: job({ state: 'succeeded', sessionId: 'sess-9' }) }, events: {}, creativeTicks: {}, projectTicks: {} }} />);
    await screen.findByText('Acme');
    expect(screen.queryByText('sessione sess-9')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Annulla' })).toBeNull();
  });
});

describe('ProjectPage errors', () => {
  afterEach(() => vi.clearAllMocks());
  it('shows a getProject failure', async () => {
    vi.mocked(api.getProject).mockRejectedValue(new Error('Progetto non trovato'));
    render(<ProjectPage slug="acme" tab="console" expert={false} live={{ jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} }} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Impossibile caricare il progetto: Progetto non trovato');
  });
});

describe('ProjectPage tabs', () => {
  afterEach(() => vi.clearAllMocks());
  it('lists every tab and marks the active one', async () => {
    vi.mocked(api.getProject).mockResolvedValue({ slug: 'acme', project, jobKey: 'project:/w:acme' });
    render(<ProjectPage slug="acme" tab="brand" expert={false} live={{ jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} }} />);
    await screen.findByText('Acme');
    expect(screen.getAllByRole('link').filter((l) => l.closest('nav')).map((l) => l.textContent)).toEqual(['Creatività', 'Brand', 'Asset', 'Riferimenti', 'Impostazioni', 'Console agente']);
    expect(screen.getByRole('link', { name: 'Brand' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('In arrivo')).toBeTruthy();
  });
});
