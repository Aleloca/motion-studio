import type { AgentEvent, JobSummary } from '@motion-studio/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

vi.mock('../src/api.ts', () => ({ api: {}, ApiError: class extends Error {} }));
const { ThemeToggle } = await import('../src/components/ThemeToggle.tsx');
const { CodebaseList } = await import('../src/components/CodebaseList.tsx');
const { AgentConsole } = await import('../src/components/AgentConsole.tsx');
const { ConfirmButton } = await import('../src/components/ConfirmButton.tsx');
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
  it('labels the confirm control', async () => {
    en(<ConfirmButton label="Delete" onConfirm={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('button', { name: 'Confirm delete' })).toBeTruthy();
  });
});
