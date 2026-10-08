import type { AgentEvent, JobSummary } from '@motion-studio/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentConsole } from '../src/components/AgentConsole.tsx';

const job = (state: JobSummary['state'], error?: string): JobSummary => ({ id: 'j', key: 'k', label: 'Turno · Acme', state, createdAt: '2026-10-07T10:00:00.000Z', error });
const events: AgentEvent[] = [
  { kind: 'session', sessionId: 's1' },
  { kind: 'text', text: 'Creo la scena.' },
  { kind: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'work/a.txt' } },
  { kind: 'tool_result', toolUseId: 't1', isError: false, content: 'File created' },
  { kind: 'stderr', text: 'warning: x' },
];

describe('AgentConsole', () => {
  it('shows agent text and friendly tool steps in simple mode, hiding raw output', () => {
    render(<AgentConsole job={job('running')} events={events} expert={false} onCancel={() => {}} />);
    expect(screen.getByText('Creo la scena.')).toBeTruthy();
    expect(screen.getByText('Usa lo strumento Write')).toBeTruthy();
    expect(screen.queryByText('File created')).toBeNull();
    expect(screen.queryByText('warning: x')).toBeNull();
  });
  it('shows raw tool input/results and stderr in expert mode', () => {
    render(<AgentConsole job={job('running')} events={events} expert onCancel={() => {}} />);
    expect(screen.getByText(/"file_path": "work\/a.txt"/)).toBeTruthy();
    expect(screen.getByText('File created')).toBeTruthy();
    expect(screen.getByText('warning: x')).toBeTruthy();
  });
  it('offers cancel only while queued or running', async () => {
    const onCancel = vi.fn();
    const { rerender } = render(<AgentConsole job={job('running')} events={[]} expert={false} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(onCancel).toHaveBeenCalledOnce();
    rerender(<AgentConsole job={job('succeeded')} events={[]} expert={false} onCancel={onCancel} />);
    expect(screen.queryByRole('button', { name: 'Annulla' })).toBeNull();
  });
  it('shows the job error when failed', () => {
    render(<AgentConsole job={job('failed', 'claude è terminato con codice 2')} events={[]} expert={false} onCancel={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('claude è terminato con codice 2');
  });
  it('shows progress events in simple mode', () => {
    render(<AgentConsole job={job('running')} events={[{ kind: 'progress', text: 'Rendering 9:16' }]} expert={false} onCancel={() => {}} />);
    expect(screen.getByText('→ Rendering 9:16')).toBeTruthy();
  });
});
