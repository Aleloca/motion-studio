import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/api.ts', () => ({ api: { decideApproval: vi.fn() }, ApiError: class extends Error {} }));
const { ApprovalsIndicator } = await import('../src/components/ApprovalsIndicator.tsx');
const a = (id: string) => ({ id, jobId: 'j', projectSlug: 'acme', creativeSlug: 'c1', kind: 'tool' as const, title: `Richiesta ${id}`, detail: 'd', toolName: 'Bash', alwaysRule: null, createdAt: 'x', expiresAt: '2026-10-08T10:10:00.000Z' });

describe('ApprovalsIndicator', () => {
  it('is hidden without approvals and lists them on click', async () => {
    const { rerender, container } = render(<ApprovalsIndicator approvals={[]} />);
    expect(container.textContent).toBe('');
    rerender(<ApprovalsIndicator approvals={[a('1'), a('2')]} />);
    await userEvent.click(screen.getByRole('button', { name: '2 approvazioni in attesa' }));
    expect(screen.getAllByRole('group')).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Apri' })[0]!.getAttribute('href')).toBe('#/p/acme/c/c1');
  });
});
