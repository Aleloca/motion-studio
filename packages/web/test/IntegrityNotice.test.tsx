import type { ProjectIntegrity } from '@motion-studio/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';

class ApiError extends Error { constructor(readonly status: number, message: string, readonly code?: string) { super(message); } }
const api = {
  getIntegrity: vi.fn<(slug: string) => Promise<ProjectIntegrity>>(),
  acceptIntegrity: vi.fn<(slug: string, token: string) => Promise<ProjectIntegrity>>(),
  listCreatives: vi.fn(async () => []),
  getFormats: vi.fn(async () => ({ presets: [], error: null, path: '/x' })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { IntegrityNotice, useIntegrity } = await import('../src/components/IntegrityNotice.tsx');
const { ProjectCreatives } = await import('../src/screens/ProjectCreatives.tsx');

const live: EventsState = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} };
const TOKEN = 'a'.repeat(64);
const blocked: ProjectIntegrity = {
  quarantined: true, gitProblem: null, token: TOKEN,
  files: [{ path: 'CLAUDE.md', change: 'changed' }, { path: '.claude/settings.json', change: 'added' }],
};
const ok: ProjectIntegrity = { quarantined: false, files: [], gitProblem: null, token: 'b'.repeat(64) };

function Harness() {
  const integrity = useIntegrity('acme', live);
  return integrity.state ? <IntegrityNotice slug="acme" state={integrity.state} reload={integrity.reload} /> : <p>in order</p>;
}
const renderIn = (locale: 'en' | 'it', node: React.ReactNode) => render(<I18nProvider locale={locale}>{node}</I18nProvider>);

afterEach(() => { vi.clearAllMocks(); });

describe('IntegrityNotice (decisions log 141, round 5)', () => {
  it('lists the changed files; accepting asks for confirmation with the exact text, then clears the block', async () => {
    api.getIntegrity.mockResolvedValueOnce(blocked).mockResolvedValue(ok);
    api.acceptIntegrity.mockResolvedValue(ok);
    renderIn('en', <Harness />);
    expect(await screen.findByRole('heading', { name: 'This project is locked' })).toBeTruthy();
    expect(screen.getByText('CLAUDE.md')).toBeTruthy();
    expect(screen.getByText('.claude/settings.json')).toBeTruthy();
    expect(screen.getByText('added')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Accept these changes' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Only accept if you made these changes yourself');
    expect(api.acceptIntegrity).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(api.acceptIntegrity).toHaveBeenCalledWith('acme', TOKEN));
    expect(await screen.findByText('in order')).toBeTruthy();
  });
  it('says so when the files changed again since the list was shown (409)', async () => {
    api.getIntegrity.mockResolvedValue(blocked);
    api.acceptIntegrity.mockRejectedValue(new ApiError(409, 'changed', 'integrity-changed'));
    renderIn('en', <Harness />);
    await userEvent.click(await screen.findByRole('button', { name: 'Accept these changes' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('The files changed again. Check the updated list.')).toBeTruthy();
  });
  it('shows a git problem apart, with its remedy, and offers no accept for it', async () => {
    const remedy = 'Remove it with "git config --unset filter.x.clean" in the project folder';
    api.getIntegrity.mockResolvedValue({ ...blocked, gitProblem: remedy });
    renderIn('en', <Harness />);
    expect(await screen.findByRole('heading', { name: 'Git is blocked on this project' })).toBeTruthy();
    expect(screen.getByText(remedy)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept these changes' })).toBeNull();
  });
  it('a git problem alone (no quarantine) is shown too', async () => {
    api.getIntegrity.mockResolvedValue({ ...ok, gitProblem: 'remedy text' });
    renderIn('en', <Harness />);
    expect(await screen.findByText('remedy text')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'This project is locked' })).toBeNull();
  });
  it('the confirmation text is translated (it)', async () => {
    api.getIntegrity.mockResolvedValue(blocked);
    renderIn('it', <Harness />);
    await userEvent.click(await screen.findByRole('button', { name: 'Accetta queste modifiche' }));
    expect((await screen.findByRole('dialog')).textContent).toContain('Accetta solo se hai fatto tu queste modifiche');
  });
  it('the project page shows the blocked state', async () => {
    api.getIntegrity.mockResolvedValue(blocked);
    renderIn('en', <ProjectCreatives slug="acme" live={live} />);
    expect(await screen.findByRole('heading', { name: 'This project is locked' })).toBeTruthy();
    expect(screen.getByText('CLAUDE.md')).toBeTruthy();
  });
});
