import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { messages, type AgentEvent, type JobSummary, type ServerMessage, type TokenCounts, type UsageReport, type VersionEntry } from '@motion-studio/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = { getUsage: vi.fn(async (): Promise<UsageReport> => report(0)), getConversation: vi.fn(async () => []) };
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));

const { eventsReducer, initialEventsState } = await import('../src/eventsReducer.ts');
type EventsState = import('../src/eventsReducer.ts').EventsState;
const { jobLiveTokens, jobFinalTokens, jobUsagePartial, localMidnightIso, localDay, todayTokens } = await import('../src/usageLive.ts');
const { USAGE_RETRY_MS } = await import('../src/useServerEvents.ts');
const { billingNote, formatCost, formatTokens, TokensButton } = await import('../src/shell/Tokens.tsx');
const { useServerEvents } = await import('../src/useServerEvents.ts');
const { VersionTimeline } = await import('../src/screens/FormatVersions.tsx');
const { ActivityCenter } = await import('../src/shell/ActivityCenter.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');

function report(tokens: number, billing: UsageReport['billing'] = 'subscription'): UsageReport {
  return {
    from: '', to: '', total: { tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0 },
    byDay: [], byProject: [], byKind: [], trackedSince: null, billing, utcOffsetMinutes: 0,
  };
}
const tk = (n: number, cacheRead = 0): TokenCounts => ({ input: n, output: 0, cacheRead, cacheWrite: 0 });
const usage = (jobId: string, live: boolean, n: number, cacheRead = 0): ServerMessage =>
  ({ type: 'agent', jobId, event: { kind: 'usage', live, tokens: tk(n, cacheRead), costUsd: live ? null : 0.01 } as AgentEvent });
const job = (id: string, state: JobSummary['state']): JobSummary => ({ id, key: `creative:/w:acme:c${id}`, kind: 'creative', label: `Job ${id}`, state, createdAt: '2026-10-09T08:00:00.000Z' });
const base = (tokens: number, day = localDay()) => ({ type: 'usage-today' as const, day, tokens, billing: 'subscription' as const });
const run = (s: EventsState, ...msgs: Parameters<typeof eventsReducer>[1][]) => msgs.reduce(eventsReducer, s);
const today = (s: EventsState) => s.today?.tokens ?? null;

describe("today's total (live counter consistency)", () => {
  it('is unknown until the day total arrives, then the base plus what runs now', () => {
    let s = run(initialEventsState, usage('a', true, 100));
    expect(today(s)).toBeNull();
    s = run(s, base(5000));
    expect(today(s)).toBe(5100); // the live run is not in the ledger yet
  });

  it('a repeated live event does not double count', () => {
    const s = run(initialEventsState, base(1000), usage('a', true, 200), usage('a', true, 200), usage('a', true, 200));
    expect(today(s)).toBe(1200);
    expect(jobLiveTokens(s, 'a')).toBe(200);
  });

  it('adds only the growth of each job (live values are sums per run)', () => {
    const s = run(initialEventsState, base(0), usage('a', true, 100), usage('b', true, 50), usage('a', true, 300), usage('b', true, 70));
    expect(today(s)).toBe(370);
  });

  it('the final event replaces the live value', () => {
    const s = run(initialEventsState, base(1000), usage('a', true, 200), usage('a', false, 260));
    expect(today(s)).toBe(1260);
    expect(jobFinalTokens(s, 'a')).toBe(260);
    expect(s.liveUsage?.a).toBeUndefined();
  });

  it('never decreases across live → final, even when the final is lower', () => {
    const seen: number[] = [];
    let s = run(initialEventsState, base(1000));
    for (const m of [usage('a', true, 100), usage('a', true, 300), usage('a', false, 280), { type: 'job', job: job('a', 'succeeded') } as ServerMessage]) {
      s = eventsReducer(s, m);
      seen.push(today(s)!);
    }
    expect(seen).toEqual([1100, 1300, 1300, 1300]);
    expect(jobFinalTokens(s, 'a')).toBe(280); // the job's own figure is the final one
  });

  it('a new attempt restarting from 0 neither decreases the total nor counts the first attempt twice', () => {
    let s = run(initialEventsState, base(0), usage('a', true, 500), usage('a', false, 480));
    expect(today(s)).toBe(500);
    s = run(s, usage('a', true, 10)); // attempt 2: 480 + 10 < 500 already shown
    expect(today(s)).toBe(500);
    expect(jobLiveTokens(s, 'a')).toBe(500);
    s = run(s, usage('a', true, 100), usage('a', false, 120));
    expect(today(s)).toBe(600); // 480 + 120
    expect(jobFinalTokens(s, 'a')).toBe(600);
  });

  it('cacheRead is never counted', () => {
    const s = run(initialEventsState, base(0), usage('a', true, 100, 99_000));
    expect(today(s)).toBe(100);
  });

  it('a new day total resets the per-job state: finished runs are in the ledger, the running one is not', () => {
    let s = run(initialEventsState, base(1000), usage('a', true, 300), usage('a', false, 300), usage('b', true, 40));
    expect(today(s)).toBe(1340);
    // Refetch after a reconnect: the ledger now holds a's run (1300), b is still live.
    s = run(s, base(1300));
    expect(today(s)).toBe(1340);
    s = run(s, usage('b', true, 60), usage('a', true, 20));
    expect(today(s)).toBe(1380);
  });

  it('a refetch lower than what was shown keeps the higher value the same day, and resets on a new day', () => {
    let s = run(initialEventsState, base(1000), usage('a', true, 500));
    s = run(s, { type: 'job', job: job('a', 'cancelled') }, base(1200));
    expect(today(s)).toBe(1500);
    s = run(s, base(0, '2099-01-01'));
    expect(today(s)).toBe(0);
  });

  it('a snapshot keeps the counter and the usage of the jobs it still lists', () => {
    let s = run(initialEventsState, base(100), usage('a', true, 50), usage('b', false, 70));
    s = run(s, { type: 'snapshot', jobs: [job('a', 'running'), job('b', 'succeeded')], approvals: [], locale: 'en', languageSetting: 'system', systemLocale: 'en' });
    expect(today(s)).toBe(220);
    expect(jobLiveTokens(s, 'a')).toBe(50);
    expect(jobFinalTokens(s, 'b')).toBe(70);
    s = run(s, { type: 'snapshot', jobs: [], approvals: [], locale: 'en', languageSetting: 'system', systemLocale: 'en' });
    expect(jobFinalTokens(s, 'b')).toBeNull();
  });

  it('a job running at a snapshot misses earlier runs: its figures are partial, never a complete total', () => {
    // The page connects mid-job (or reconnects): attempt 1's final was not seen, attempt 2's is.
    let s = run(initialEventsState, usage('a', false, 400)); // a final seen before the drop
    s = run(s, { type: 'snapshot', jobs: [job('a', 'running'), job('b', 'running'), job('c', 'queued')], approvals: [], locale: 'en', languageSetting: 'system', systemLocale: 'en' });
    expect(jobUsagePartial(s, 'a')).toBe(true);
    expect(jobUsagePartial(s, 'b')).toBe(true);
    expect(jobUsagePartial(s, 'c')).toBe(false); // queued: nothing ran yet
    s = run(s, usage('a', false, 300), { type: 'job', job: { ...job('a', 'succeeded'), finishedAt: '2026-10-09T09:00:00.000Z' } });
    expect(jobFinalTokens(s, 'a')).toBe(700);
    expect(jobUsagePartial(s, 'a')).toBe(true); // stays partial once done
    wrap(<ActivityCenter live={s} initialTab="done" where={(p) => p} />);
    expect(within(screen.getByRole('list')).getByText('≥ 700 tokens')).toBeTruthy();
    // A later snapshot that still lists it keeps the flag; one that drops it forgets the job.
    s = run(s, { type: 'snapshot', jobs: [{ ...job('a', 'succeeded') }], approvals: [], locale: 'en', languageSetting: 'system', systemLocale: 'en' });
    expect(jobUsagePartial(s, 'a')).toBe(true);
  });

  it("yesterday's total reads as unknown until the new day's arrives", () => {
    const s = run(initialEventsState, base(5000, '2000-01-01'));
    expect(s.today?.tokens).toBe(5000);
    expect(todayTokens(s)).toBeNull();
    expect(todayTokens(run(s, base(10)))).toBe(10);
  });

  it('a job without any usage event has no figure (never 0)', () => {
    const s = run(initialEventsState, { type: 'job', job: job('a', 'running') });
    expect(jobLiveTokens(s, 'a')).toBeNull();
    expect(jobFinalTokens(s, 'a')).toBeNull();
  });
});

class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null; onerror: unknown;
  constructor() { FakeWebSocket.all.push(this); }
  close() {}
}
let state: EventsState = initialEventsState;
function Probe() { state = useServerEvents(); return null; }
const snap = (jobs: JobSummary[] = []): ServerMessage => ({ type: 'snapshot', jobs, approvals: [], locale: 'en', languageSetting: 'system', systemLocale: 'en' });
const send = (msg: ServerMessage) => act(async () => { FakeWebSocket.all.at(-1)!.onmessage!({ data: JSON.stringify(msg) }); });

describe('useServerEvents · day total', () => {
  beforeEach(() => { FakeWebSocket.all = []; vi.stubGlobal('WebSocket', FakeWebSocket); });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('fetches the total from local midnight on the first snapshot, and refetches on reconnect', async () => {
    api.getUsage.mockResolvedValueOnce(report(1000)).mockResolvedValueOnce(report(1500));
    render(<Probe />);
    expect(api.getUsage).not.toHaveBeenCalled();
    await send(snap([job('a', 'running')]));
    expect(api.getUsage).toHaveBeenCalledWith({ from: localMidnightIso() });
    expect(state.today?.tokens).toBe(1000);
    await send(usage('a', true, 200));
    expect(state.today?.tokens).toBe(1200);
    await send(snap([job('a', 'running')])); // reconnection
    expect(api.getUsage).toHaveBeenCalledTimes(2);
    expect(state.today?.tokens).toBe(1700); // 1500 from the ledger + a's live run
  });

  it('a failed fetch leaves the total unknown', async () => {
    api.getUsage.mockRejectedValueOnce(new Error('down'));
    render(<Probe />);
    await send(snap());
    expect(state.today).toBeUndefined();
  });

  it('a failed fetch is retried once after a delay', async () => {
    vi.useFakeTimers();
    try {
      api.getUsage.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down')).mockResolvedValue(report(42));
      render(<Probe />);
      await send(snap());
      expect(api.getUsage).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(USAGE_RETRY_MS); });
      expect(api.getUsage).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(USAGE_RETRY_MS * 4); });
      expect(api.getUsage).toHaveBeenCalledTimes(2); // only one retry
      expect(state.today).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('an older response arriving after a newer one is ignored', async () => {
    let first!: (r: UsageReport) => void;
    api.getUsage.mockImplementationOnce(() => new Promise((r) => { first = r; })).mockResolvedValueOnce(report(900));
    render(<Probe />);
    await send(snap());
    await send(snap());
    expect(state.today?.tokens).toBe(900);
    await act(async () => { first(report(5)); });
    expect(state.today?.tokens).toBe(900);
  });
});

const wrap = (node: React.ReactNode, locale: 'en' | 'it' = 'en') => render(<I18nProvider locale={locale}>{node}</I18nProvider>);

describe('Tokens button and formats', () => {
  afterEach(() => { history.replaceState(null, '', '/'); });

  it('k with one decimal; below 1000 the plain number; 0 is "0 tokens"', () => {
    expect(formatTokens('en', 38_240)).toBe('38.2k');
    expect(formatTokens('it', 38_240)).toBe('38,2k');
    expect(formatTokens('en', 999)).toBe('999');
    expect(formatTokens('en', 0)).toBe('0');
  });

  it('shows today\'s tokens, "—" while unknown, and opens Settings → Usage', () => {
    const { rerender } = wrap(<TokensButton tokens={null} />);
    expect(screen.getByRole('button').textContent).toBe('— tokens');
    rerender(<I18nProvider locale="en"><TokensButton tokens={0} /></I18nProvider>);
    expect(screen.getByRole('button').textContent).toBe('0 tokens');
    rerender(<I18nProvider locale="en"><TokensButton tokens={38_240} /></I18nProvider>);
    const b = screen.getByRole('button', { name: 'Tokens used today: 38.2k. Open Usage' });
    fireEvent.click(b);
    expect(location.hash).toBe('#/settings/usage');
  });

  it('the billing label for a subscription mentions the plan; API shows the cost; unknown says estimated', () => {
    const en = messages('en');
    expect(billingNote(en, 'en', 'subscription', 0.42)).toBe('This counts toward your Claude plan. At API prices it would be about $0.42.');
    expect(billingNote(en, 'en', 'api', 0.42)).toBe('$0.42');
    expect(billingNote(en, 'en', 'unknown', 0.42)).toBe('Estimated at API prices: $0.42');
    expect(billingNote(en, 'en', 'api', 0.42, true)).toBe('≥ $0.42');
    expect(billingNote(en, 'en', 'api', null)).toBeNull();
    expect(billingNote(messages('it'), 'it', 'subscription', 0.42)).toContain('piano Claude');
  });

  it('a partly unknown cost reads "at least $X" in the billing note, never "about ≥ $X"', () => {
    const en = messages('en');
    expect(billingNote(en, 'en', 'subscription', 0.2, true)).toBe('This counts toward your Claude plan. At API prices it would be at least $0.20.');
    expect(billingNote(en, 'en', 'unknown', 0.2, true)).toBe('Estimated at API prices: at least $0.20');
    expect(billingNote(messages('it'), 'it', 'subscription', 0.2, true)).toMatch(/^Rientra nel tuo piano Claude\. A prezzi API sarebbe almeno 0,20\s\$\.$/);
    expect(billingNote(messages('it'), 'it', 'unknown', 0.2, true)).toMatch(/^Stima a prezzi API: almeno 0,20\s\$$/);
    for (const l of ['en', 'it'] as const) for (const b of ['subscription', 'api', 'unknown'] as const) expect(billingNote(messages(l), l, b, 0.2, true)).not.toMatch(/(about|circa) ≥/);
  });

  it('costs: three decimals under $0.10 (trailing zero kept), two from $0.10 up', () => {
    expect(formatCost('en', 0.01)).toBe('$0.010');
    expect(formatCost('en', 0.015)).toBe('$0.015');
    expect(formatCost('en', 0.0999)).toBe('$0.100');
    expect(formatCost('en', 0.1)).toBe('$0.10');
    expect(formatCost('en', 0.42)).toBe('$0.42');
    expect(formatCost('en', 0)).toBe('$0.00');
    expect(formatCost('it', 0.05)).toMatch(/^0,050\s\$$/);
  });
});

const version = (n: number, over: Partial<VersionEntry> = {}): VersionEntry => ({
  n, commit: null, sessionId: null, status: 'complete', createdAt: '2026-10-09T09:00:00.000Z', request: `change ${n}`, outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null, ...over,
});

describe('per-version tokens', () => {
  it('the version timeline shows tokens per version; a version without usage shows none', async () => {
    const versions = [version(1), version(2, { usage: { tokens: { input: 30_000, output: 8_000, cacheRead: 900_000, cacheWrite: 400 }, costUsd: 0.42 } })];
    const noop = () => {};
    const ref = { current: null as HTMLButtonElement | null };
    wrap(<VersionTimeline slug="acme" creative="c" versions={versions} resumeFrom={null} buttonRef={ref}
      actions={{ star: noop, link: noop, unlink: noop, restart: noop, reveal: noop }} />);
    fireEvent.click(ref.current!);
    await waitFor(() => expect(document.querySelectorAll('.ms-vmenu-row').length).toBe(2));
    const rows = [...document.querySelectorAll('.ms-vmenu-row')];
    const v2 = rows.find((r) => r.textContent?.includes('v2'))!;
    const v1 = rows.find((r) => r.textContent?.includes('v1'))!;
    expect(v2.textContent).toContain('38.4k tokens');
    expect(v1.textContent).not.toMatch(/token/);
  });
});

describe('activity center usage', () => {
  const live = (over: Partial<EventsState>): EventsState => ({ ...initialEventsState, ...over });

  it('footer with today\'s tokens and the Usage link; running rows live tokens, done rows final tokens', () => {
    let s = run(initialEventsState, { type: 'job', job: job('r', 'running') }, { type: 'job', job: job('d', 'running') }, base(12_000),
      usage('r', true, 1500), usage('d', true, 900), usage('d', false, 2500), { type: 'job', job: { ...job('d', 'succeeded'), finishedAt: '2026-10-09T09:00:00.000Z' } });
    s = live(s);
    const { unmount } = wrap(<ActivityCenter live={s} initialTab="running" where={(p) => p} />);
    expect(screen.getByText('Today · 16.0k tokens')).toBeTruthy(); // 12000 + r's 1500 + d's final 2500
    const link = screen.getByRole('link', { name: 'Usage' });
    expect(link.getAttribute('href')).toBe('#/settings/usage');
    // Never the browser's visited purple: the link keeps the accent text colour once visited.
    expect(link.classList.contains('ms-activity-usage')).toBe(true);
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/shell/shell.css'), 'utf8');
    expect(css).toMatch(/\.ms-activity-usage,\s*\.ms-activity-usage:visited\s*\{[^}]*color:\s*var\(--accentText\)/);
    expect(within(screen.getByRole('list')).getByText('1.5k tokens', { exact: false }).textContent).toBe('1.5k tokens so far');
    unmount();
    wrap(<ActivityCenter live={s} initialTab="done" where={(p) => p} />);
    expect(within(screen.getByRole('list')).getByText('2.5k tokens')).toBeTruthy();
  });

  it('without a day total and without usage events: no invented numbers', () => {
    const s = run(initialEventsState, { type: 'job', job: job('r', 'running') });
    wrap(<ActivityCenter live={s} initialTab="running" where={(p) => p} />);
    expect(screen.getByText('Today · tokens not available yet')).toBeTruthy();
    expect(within(screen.getByRole('list')).queryByText(/token/)).toBeNull();
  });
});
