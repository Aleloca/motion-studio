import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

const api = {
  listProjects: vi.fn(),
  getProject: vi.fn(),
  getCodebases: vi.fn(async () => []),
  getPermissions: vi.fn(async () => []),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { Onboarding } = await import('../src/screens/Onboarding.tsx');
const { ProjectList } = await import('../src/screens/ProjectList.tsx');
const { ProjectPage } = await import('../src/screens/ProjectPage.tsx');
const { ProjectSettings } = await import('../src/screens/ProjectSettings.tsx');

const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);
const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} };

describe('onboarding and projects in English', () => {
  it('shows the environment check and workspace form', () => {
    en(<Onboarding checks={[{ id: 'git', label: 'Git', ok: false, required: true, message: 'Not found' }]} workspacePath={null}
      workspaceError={{ code: 'not-found', message: 'x' }} onRecheck={() => {}} onWorkspaceSet={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Welcome to Motion Studio' })).toBeTruthy();
    expect(screen.getByText('Missing')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Folder not found: . Choose another.');
  });
  it('lists projects with a localized date', async () => {
    api.listProjects.mockResolvedValue([
      { ok: true, slug: 'acme', project: { name: 'Acme', description: '', updatedAt: '2026-10-07T12:00:00.000Z' } },
      { ok: false, slug: 'broken', error: 'bad json' },
    ]);
    en(<ProjectList />);
    expect(await screen.findByText('No description')).toBeTruthy();
    expect(screen.getByText('Updated 10/7/2026')).toBeTruthy();
    expect(screen.getByText('Unreadable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
  });
  it('names the project tabs and settings form', async () => {
    api.getProject.mockResolvedValue({ project: { name: 'Acme', description: '', linkedCodebases: [] }, jobKey: null });
    en(<ProjectPage slug="acme" tab="settings" live={live} expert={false} />);
    expect(screen.getByRole('link', { name: 'Agent console' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '← Projects' })).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeTruthy());
  });
  it('confirms a saved project', async () => {
    api.getProject.mockResolvedValue({ project: { name: 'Acme', description: '', linkedCodebases: [] }, jobKey: null });
    en(<ProjectSettings slug="acme" tick={0} />);
    expect(await screen.findByRole('button', { name: 'Save' })).toBeTruthy();
  });
});
