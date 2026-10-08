import { workspaceSettingsSchema, type ApprovalRequest } from '@motion-studio/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

const api = {
  decideApproval: vi.fn(),
  getSecrets: vi.fn(async () => [{ provider: 'openai', configured: true, source: 'keychain' }, { provider: 'pexels', configured: true, source: 'env' }]),
  setSecret: vi.fn(), deleteSecret: vi.fn(), updateSettings: vi.fn(), setLanguage: vi.fn(),
  exportVersion: vi.fn(async () => ({ destination: '/out', files: [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }], skipped: ['x.mov'] })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ApprovalCard } = await import('../src/components/ApprovalCard.tsx');
const { ApprovalsIndicator } = await import('../src/components/ApprovalsIndicator.tsx');
const { SettingsPage } = await import('../src/screens/SettingsPage.tsx');
const { ExportDialog } = await import('../src/components/ExportDialog.tsx');
const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);

const approval: ApprovalRequest = { id: 'a1', jobId: 'j', projectSlug: 'acme', creativeSlug: 'c1', kind: 'tool', title: 'Run a command', detail: 'ls', toolName: 'Bash', alwaysRule: 'Bash(ls:*)', createdAt: 'x', expiresAt: '2026-10-08T10:10:00.000Z' };
const settings = workspaceSettingsSchema.parse({ schemaVersion: 1 });
const checks = [{ id: 'sandbox' as const, label: 'Sandbox', ok: true, required: false, message: 'ok' }];

describe('approvals, settings and export in English', () => {
  it('labels the approval decisions and the pending count', async () => {
    en(<ApprovalsIndicator approvals={[approval, { ...approval, id: 'a2' }]} />);
    await userEvent.click(screen.getByRole('button', { name: '2 approvals pending' }));
    expect(screen.getAllByRole('button', { name: 'Allow' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Always here' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Open' })).toHaveLength(2);
  });
  it('says when a request was already handled', async () => {
    const { ApiError } = await import('../src/api.ts');
    api.decideApproval.mockRejectedValue(Object.assign(new ApiError(404, "x"), { status: 404 }));
    en(<ApprovalCard approval={approval} />);
    expect(screen.getByText('The agent wants to run a command on this computer.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Request already handled'));
  });
  it('shows settings sections and key states in English', async () => {
    en(<SettingsPage settings={settings} checks={checks} language="en" systemLocale="en" onLanguage={() => {}} onSaved={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
    await waitFor(() => screen.getByText('Stored in keychain'));
    expect(screen.getByText('From environment variable')).toBeTruthy();
    expect(screen.getByText('Managed by PEXELS_API_KEY')).toBeTruthy();
    expect(screen.getByLabelText('New ElevenLabs key')).toBeTruthy();
    expect(screen.getByText('Sandbox on: the agent works isolated in the project folder')).toBeTruthy();
    expect(screen.getByLabelText('Agent isolation')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'English' }).getAttribute('aria-checked')).toBe('true');
  });
  it('exports with English labels and singular/plural counts', async () => {
    en(<ExportDialog slug="acme" creative="c1" version={2} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Export v2' })).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Destination folder (absolute path)'), '/out');
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect((await screen.findByRole('status')).textContent).toContain('Exported 2 files to /out');
    expect(screen.getByText('Not exported: x.mov')).toBeTruthy();
  });
});
