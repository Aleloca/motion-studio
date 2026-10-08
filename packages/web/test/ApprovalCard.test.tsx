import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApprovalRequest } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class ApiError extends Error { constructor(public status: number, m: string) { super(m); } }
const api = { decideApproval: vi.fn(async () => ({})) };
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { ApprovalCard } = await import('../src/components/ApprovalCard.tsx');

const base: ApprovalRequest = { id: 'a1', jobId: 'j', projectSlug: 'acme', creativeSlug: 'c1', kind: 'tool', title: 'Eseguire un comando', detail: 'brew install ffmpeg', toolName: 'Bash', alwaysRule: 'Bash(brew:*)', createdAt: '2026-10-08T10:00:00.000Z', expiresAt: '2026-10-08T10:10:00.000Z' };
beforeEach(() => vi.clearAllMocks());

describe('ApprovalCard', () => {
  it('sends the three decisions', async () => {
    render(<ApprovalCard approval={base} />);
    expect(screen.getByText('brew install ffmpeg')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Sempre per questo progetto' }));
    expect(api.decideApproval).toHaveBeenCalledWith('a1', 'always');
  });
  it('hides "always" without a rule and labels provider approvals', () => {
    render(<ApprovalCard approval={{ ...base, kind: 'provider', alwaysRule: null, title: "Generare un'immagine con gpt-image-2" }} />);
    expect(screen.queryByRole('button', { name: 'Sempre per questo progetto' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Genera' })).toBeTruthy();
  });
  it('reports a request already handled', async () => {
    api.decideApproval.mockRejectedValueOnce(new ApiError(404, 'x'));
    render(<ApprovalCard approval={base} />);
    await userEvent.click(screen.getByRole('button', { name: 'Nega' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Richiesta già gestita'));
  });
});
