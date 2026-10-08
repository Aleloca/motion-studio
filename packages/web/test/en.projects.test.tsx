import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

const api = {
  listProjects: vi.fn(),
  recentCreatives: vi.fn(async () => []),
  getFormats: vi.fn(async () => ({ presets: [], error: null, path: '/x' })),
  listCreatives: vi.fn(async () => []),
  getBrand: vi.fn(async () => { throw new Error('no brand'); }),
  listAssets: vi.fn(async () => ({ assets: [], error: null, unregistered: [] })),
  getProject: vi.fn(),
  getCodebases: vi.fn(async () => []),
  getPermissions: vi.fn(async () => []),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { Projects } = await import('../src/screens/Projects.tsx');
const { ProjectSettings } = await import('../src/screens/ProjectSettings.tsx');

const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);
const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} };

describe('projects in English', () => {
  it('lists projects, an unreadable one and the new project card', async () => {
    api.listProjects.mockResolvedValue([
      { ok: true, slug: 'acme', project: { name: 'Acme', description: 'Coffee roasters', updatedAt: '2026-10-07T12:00:00.000Z' } },
      { ok: false, slug: 'broken', error: 'bad json' },
    ]);
    en(<Projects live={live} />);
    expect(await screen.findByText('Coffee roasters')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy();
    expect(screen.getByText('Unreadable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('creatives')).toBeTruthy());
  });
  it('confirms a saved project', async () => {
    api.getProject.mockResolvedValue({ project: { name: 'Acme', description: '', linkedCodebases: [] }, jobKey: null });
    en(<ProjectSettings slug="acme" tick={0} />);
    expect(await screen.findByRole('button', { name: 'Save' })).toBeTruthy();
  });
});
