import { DEFAULT_FORMATS, workspaceSettingsSchema, type ApprovalRequest } from '@motion-studio/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

const api = {
  decideApproval: vi.fn(),
  getSecrets: vi.fn(async () => [{ provider: 'openai', configured: true, source: 'keychain' }, { provider: 'pexels', configured: true, source: 'env' }]),
  setSecret: vi.fn(), deleteSecret: vi.fn(), updateSettings: vi.fn(), setLanguage: vi.fn(),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  exportPicks: vi.fn(async () => ({ destination: '/out', files: [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }], skipped: ['x.mov'] })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ApprovalCard } = await import('../src/components/ApprovalCard.tsx');
const { AppSettings } = await import('../src/screens/AppSettings.tsx');
const { ExportDialog } = await import('../src/screens/ExportDialog.tsx');
const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);

const approval: ApprovalRequest = { id: 'a1', jobId: 'j', projectSlug: 'acme', creativeSlug: 'c1', kind: 'tool', title: 'Run a command', detail: 'ls', toolName: 'Bash', alwaysRule: 'Bash(ls:*)', explanation: null, agentReason: null, createdAt: 'x', expiresAt: '2026-10-08T10:10:00.000Z' };
const settings = workspaceSettingsSchema.parse({ schemaVersion: 1 });
const checks = [{ id: 'sandbox' as const, label: 'Sandbox', ok: true, required: false, message: 'ok' }];

describe('approvals, settings and export in English', () => {
  it('says when a request was already handled', async () => {
    const { ApiError } = await import('../src/api.ts');
    api.decideApproval.mockRejectedValue(Object.assign(new ApiError(404, "x"), { status: 404 }));
    en(<ApprovalCard approval={approval} />);
    expect(screen.getByText('The agent wants to run a command on this computer.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Request already handled'));
  });
  it('shows settings sections and key states in English', async () => {
    en(<AppSettings section="paid" settings={settings} checks={checks} checking={false} checksRun={1} loadError={null} onRecheck={() => {}}
      language="en" systemLocale="en" onLanguage={() => {}} onSettings={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Paid services' })).toBeTruthy();
    await waitFor(() => screen.getByText('Key saved in the Keychain'));
    expect(screen.getByText('From the PEXELS_API_KEY environment variable')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Add key' })).toHaveLength(2);
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeTruthy();
  });
  it('exports with English labels and singular/plural counts', async () => {
    const at = '2026-10-08T10:00:00.000Z';
    const out = (format: string, file: string) => ({ format, file, width: 1080, height: 1080, durationSec: null, verified: true, preview: null });
    const version = { n: 2, commit: 'c', sessionId: 's', status: 'complete' as const, createdAt: at, request: '', outputs: [out('instagram-post-1x1', 'a.png'), out('tiktok-9x16', 'b.mp4')], problems: [], tools: [], renderCommand: null, basedOn: null };
    const star = (n: number) => ({ version: n, manual: false, newer: null, follows: null });
    const st = (id: string) => ({ id, history: [2], star: star(2), defaultVersion: 2, exportVersion: 2, starFileMissing: false, linkable: [], follows: null });
    const states = { 'instagram-post-1x1': st('instagram-post-1x1'), 'tiktok-9x16': st('tiktok-9x16') };
    en(<ExportDialog open onClose={() => {}} slug="acme" creative="c1" title="Summer launch" snapshot={{ versions: [version], states }} presets={DEFAULT_FORMATS} pattern="{title}-{format}-v{v}" />);
    expect(screen.getByRole('dialog', { name: 'Export the starred versions of “Summer launch”' })).toBeTruthy();
    expect(screen.getByText('“Summer launch”: each format at its ★ version, ready to post.')).toBeTruthy();
    expect(screen.getAllByText('summer-launch-instagram-post-1x1-v2.png').length).toBeGreaterThan(0);
    await userEvent.type(screen.getByLabelText('Destination folder'), '/out');
    await userEvent.click(screen.getByRole('checkbox', { name: /^Export TikTok/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Export 1 file' }));
    expect((await screen.findByRole('status')).textContent).toContain('2 files exported');
    expect(screen.getByText('Not exported: x.mov')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });
});
