import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceSettingsSchema, type UsageReport } from '@motion-studio/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

let report: UsageReport;
const api = {
  getSecrets: vi.fn(async () => []),
  getUsage: vi.fn(async () => structuredClone(report)),
  setLanguage: vi.fn(),
  updateSettings: vi.fn(),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { AppSettings } = await import('../src/screens/AppSettings.tsx');

const settings = workspaceSettingsSchema.parse({ schemaVersion: 1 });
const days = ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
const perDay = [1000, 0, 2000, 4000, 0, 500, 3000];
const full = (): UsageReport => ({
  from: '2026-10-02T22:00:00.000Z', to: '2026-10-09T22:00:00.000Z',
  total: { tokens: { input: 6000, output: 3000, cacheRead: 99999, cacheWrite: 1500 }, costUsd: 0.2, estimated: true },
  byDay: days.map((day, i) => ({ day, tokens: perDay[i]!, costUsd: perDay[i] ? 0.01 : null })),
  byProject: [
    { slug: 'acme', name: 'Acme', tokens: 7000, costUsd: 0.2 },
    { slug: 'beta', name: 'Beta', tokens: 3500, costUsd: null, estimated: true },
    { slug: 'gamma', name: 'Gamma', tokens: 0, costUsd: null },
  ],
  byKind: [
    { kind: 'creative', tokens: 9000, costUsd: 0.15, estimated: true },
    { kind: 'brand-analysis', tokens: 1500, costUsd: 0.05 },
    { kind: 'describe', tokens: 0, costUsd: null },
    { kind: 'console', tokens: 0, costUsd: null },
  ],
  trackedSince: '2026-09-01T09:00:00.000Z',
  billing: 'subscription',
  utcOffsetMinutes: 120,
});

const page = () => render(
  <I18nProvider locale="en">
    <AppSettings section="usage" settings={settings} checks={[]} checking={false} checksRun={1} loadError={null} onRecheck={() => {}}
      language="system" systemLocale="en" onLanguage={() => {}} onSettings={() => {}} />
  </I18nProvider>,
);

beforeEach(() => {
  report = full();
  // Only Date: 12:00Z is 14:00 on the 9th in the report's UTC+2.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-09T12:00:00.000Z'));
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('Settings · Usage', () => {
  it('draws the 7 days scaled to the busiest, today in accent, empty days as a hairline', async () => {
    const { container } = page();
    await waitFor(() => expect(container.querySelectorAll('.ms-usage-bar')).toHaveLength(7));
    const bars = [...container.querySelectorAll<HTMLElement>('.ms-usage-bar')];
    expect(bars.map((b) => b.dataset.day)).toEqual(days);
    expect(bars.map((b) => b.style.height)).toEqual(['25%', '', '50%', '100%', '', '12.5%', '75%']);
    expect(bars[1]!.classList.contains('ms-zero')).toBe(true);
    expect(bars[4]!.classList.contains('ms-zero')).toBe(true);
    expect(bars.filter((b) => b.classList.contains('ms-today')).map((b) => b.dataset.day)).toEqual(['2026-10-09']);
    // Labels: real weekdays, the last one "Today".
    const labels = [...container.querySelectorAll('.ms-usage-days > span')].map((s) => s.textContent);
    expect(labels).toEqual(['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Today']);
    // Text alternative.
    const table = screen.getByRole('table', { name: 'Tokens per day, last 7 days' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(8);
    expect(rows[7]!.textContent).toContain('Today');
    expect(rows[7]!.textContent).toContain('3.0k');
    expect(rows[2]!.textContent).toContain('0');
  });

  it('shows the week total, projects and kinds with tokens first, the billing note, estimates marked and the start of tracking', async () => {
    page();
    // input + output + cache write; cache reads are left out.
    expect(await screen.findByText('10.5k tokens')).toBeTruthy();
    const projects = screen.getByRole('list', { name: 'By project' });
    expect(within(projects).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Acme7.0k tokens$0.20', 'Beta3.5k tokens']);
    const kinds = screen.getByRole('list', { name: 'By kind of work' });
    expect(within(kinds).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Creatives9.0k tokens≥ $0.15', 'Brand analyses1.5k tokens$0.050']);
    expect(screen.getByText('This counts toward your Claude plan. At API prices it would be at least $0.20.')).toBeTruthy();
    expect(screen.getByText('The cost of some runs is not known, so the real figure may be higher.')).toBeTruthy();
    expect(screen.getByText('Tracked since Sep 1, 2026')).toBeTruthy();
  });

  it('today with 0 tokens keeps the accent (hairline in accent); weekday labels use --muted (AA)', async () => {
    report = { ...full(), byDay: days.map((day, i) => ({ day, tokens: i === 6 ? 0 : perDay[i]!, costUsd: null })) };
    const { container } = page();
    await waitFor(() => expect(container.querySelectorAll('.ms-usage-bar')).toHaveLength(7));
    const todayBar = container.querySelector<HTMLElement>('.ms-usage-bar[data-day="2026-10-09"]')!;
    expect(todayBar.classList.contains('ms-zero')).toBe(true);
    expect(todayBar.classList.contains('ms-today')).toBe(true);
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/screens/settings.css'), 'utf8');
    const rule = (sel: string) => { const m = new RegExp(`(^|\\n)${sel.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css); return m ? m[2]! : null; };
    // Declared after .ms-zero and more specific: the accent wins over the grey hairline.
    expect(rule('.ms-usage-bar.ms-zero.ms-today')).toMatch(/background:\s*var\(--accent\)/);
    expect(css.indexOf('.ms-usage-bar.ms-zero.ms-today')).toBeGreaterThan(css.indexOf('.ms-usage-bar.ms-zero {'));
    expect(rule('.ms-usage-days')).toMatch(/color:\s*var\(--muted\)/);
    expect(rule('.ms-usage-days')).not.toMatch(/--faint/);
  });

  it('shows the empty state before the first generation', async () => {
    report = { ...full(), trackedSince: null, total: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: null },
      byDay: days.map((day) => ({ day, tokens: 0, costUsd: null })), byProject: [], byKind: [] };
    const { container } = page();
    expect(await screen.findByText('Usage appears here after your first generation')).toBeTruthy();
    expect(container.querySelector('.ms-usage-bar')).toBeNull();
    expect(screen.queryByText(/Tracked since/)).toBeNull();
    expect(screen.queryByText(/tokens/)).toBeNull();
  });

  it('says so when the report cannot load, without numbers', async () => {
    api.getUsage.mockRejectedValueOnce(new Error('offline'));
    page();
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load usage: offline");
    expect(screen.queryByText(/tokens/)).toBeNull();
  });
});
