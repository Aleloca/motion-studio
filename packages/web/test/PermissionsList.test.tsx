import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const api = {
  getPermissions: vi.fn(async () => [{ rule: 'Bash(brew:*)', label: 'Comandi "brew"', addedAt: '2026-10-08T10:00:00.000Z' }]),
  deletePermission: vi.fn(async () => ({ ok: true })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { PermissionsList } = await import('../src/components/PermissionsList.tsx');

describe('PermissionsList', () => {
  it('lists and revokes rules', async () => {
    render(<PermissionsList slug="acme" />);
    await waitFor(() => screen.getByText('Comandi "brew"'));
    await userEvent.click(screen.getByRole('button', { name: 'Revoca Comandi "brew"' }));
    expect(api.deletePermission).toHaveBeenCalledWith('acme', 'Bash(brew:*)');
  });
});
