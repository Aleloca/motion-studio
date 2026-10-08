import type { AgentEvent, JobSummary } from '@motion-studio/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

const api = { getPermissions: vi.fn(async () => [{ rule: 'Bash(ls:*)', label: 'Run ls' }]), deletePermission: vi.fn() };
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ThemeToggle } = await import('../src/components/ThemeToggle.tsx');
const { CodebaseList } = await import('../src/components/CodebaseList.tsx');
const { PermissionsList } = await import('../src/components/PermissionsList.tsx');
const { AgentConsole } = await import('../src/components/AgentConsole.tsx');
const { UploadZone } = await import('../src/components/UploadZone.tsx');
const { ConfirmButton } = await import('../src/components/ConfirmButton.tsx');
const { SourceBadge } = await import('../src/components/SourceBadge.tsx');
const { StatusBadge } = await import('../src/components/StatusBadge.tsx');
const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);

describe('shared components in English', () => {
  it('names themes', () => {
    en(<ThemeToggle value="dark" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Light' })).toBeTruthy();
  });
  it('explains codebase errors', async () => {
    en(<CodebaseList value={[{ path: '/a' }]} checks={[{ path: '/a', exists: false }]} onChange={() => {}} />);
    expect(screen.getByText('Not found')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Absolute folder path'), 'rel');
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(screen.getByRole('alert').textContent).toBe('Enter an absolute path');
  });
  it('lists permissions with a revoke action', async () => {
    en(<PermissionsList slug="acme" />);
    await waitFor(() => screen.getByRole('button', { name: 'Revoke Run ls' }));
    expect(screen.getByRole('region', { name: 'Always-allowed permissions' })).toBeTruthy();
  });
  it('shows the agent console in English, with a localized cost', () => {
    const job: JobSummary = { id: 'j', key: 'k', kind: 'console', label: 'Turn', state: 'running', createdAt: '2026-10-07T10:00:00.000Z' };
    const events: AgentEvent[] = [{ kind: 'tool_use', id: 't', name: 'Write', input: {} }, { kind: 'result', ok: true, costUsd: 0.0123 }];
    const { rerender } = en(<AgentConsole job={job} events={events} expert={false} onCancel={() => {}} />);
    expect(screen.getByRole('region', { name: 'Agent activity' })).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('Using the Write tool')).toBeTruthy();
    rerender(<I18nProvider locale="en"><AgentConsole job={job} events={events} expert onCancel={() => {}} /></I18nProvider>);
    expect(screen.getByText(/ok · \$0\.0123/)).toBeTruthy();
  });
  it('labels upload, confirm, source and status controls', async () => {
    en(<><UploadZone label="Upload" onFiles={async () => {}} /><ConfirmButton label="Delete" onConfirm={() => {}} /><SourceBadge source={{ kind: 'manual', ref: null }} /><StatusBadge status="draft" waiting /></>);
    expect(screen.getByText(/Drop files here/)).toBeTruthy();
    expect(screen.getByText('Manual')).toBeTruthy();
    expect(screen.getByText('Awaiting approval')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('button', { name: 'Confirm delete' })).toBeTruthy();
  });
});
