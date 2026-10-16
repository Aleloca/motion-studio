/**
 * Phase 15, Task 5: the chat selector "Variante · A · B · C · Tutte" (spec §4). A letter shows that variant's conversation and
 * sends to that member's own turn route; "Tutte" posts the request to the fan-out route. Discarded variants are not offered.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type ConversationEntry, type JobSummary, type VariantGroup, type VariantLetter, type VersionEntry } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { at, detailFor, groupOf, HOST, version } from './support/variants.ts';

vi.setConfig({ testTimeout: 30_000 });

type Run = { jobs: Partial<Record<VariantLetter, string>>; queued: VariantLetter[]; skipped: VariantLetter[]; failed: Partial<Record<VariantLetter, string>> };
const run = vi.fn(async (..._a: unknown[]): Promise<Run> => ({ jobs: { a: 'j1', b: 'j2' }, queued: ['c'], skipped: [], failed: {} }));
let group: VariantGroup = groupOf(['a', 'b', 'c']);
const versionsBy: Record<string, VersionEntry[]> = { [HOST]: [version(1, 'Dal brief')], [`${HOST}~b`]: [version(1, 'Dal brief')], [`${HOST}~c`]: [version(1, 'Dal brief')] };
const conversations: Record<string, ConversationEntry[]> = {};
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async (_s: string, c: string) => detailFor(c, versionsBy[c] ?? [], group)),
  getConversation: vi.fn(async (_s: string, c: string) => conversations[c] ?? []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  getUsage: vi.fn(async () => { throw new Error('offline'); }),
  sendCreativeTurn: vi.fn(async (..._a: unknown[]) => ({ id: 'j9' })),
  runVariants: run,
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: true, interrupt: true, checkedAt: at })),
  postLiveMessage: vi.fn(), redirectJob: vi.fn(), stopJob: vi.fn(), removeQueued: vi.fn(), editQueued: vi.fn(), reorderQueue: vi.fn(), runNext: vi.fn(), decideApproval: vi.fn(),
  getPinFrames: vi.fn(async () => ({ n: 1, expiresAt: at, frames: [] })),
};
class ApiError extends Error { status = 0; }
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
void ApiError;
const { Conversation } = await import('../src/components/Conversation.tsx');
const { CreativeCanvas } = await import('../src/screens/CreativeCanvas.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { __resetPendingPins } = await import('../src/screens/pendingPins.ts');

const job = (over: Partial<JobSummary> = {}): JobSummary => ({ id: 'j1', key: 'creative:/w:acme:lancio', kind: 'creative', label: 'Lancio', state: 'running', createdAt: at, ...over });
const panel = (o: { all?: boolean; current?: 'a' | 'b' | 'c'; onSelect?: (t: string) => void; job?: JobSummary; g?: VariantGroup; missing?: Array<'a' | 'b' | 'c' | 'd' | 'e'> } = {}) => (
  <I18nProvider locale="it">
    <Conversation slug="acme" creative={o.current && o.current !== 'a' ? `${HOST}~${o.current}` : HOST} entries={[]} approvals={[]} job={o.job} onSent={vi.fn()}
      variants={{ group: o.g ?? group, current: o.current ?? 'a', all: o.all ?? false, missing: o.missing ?? [], onSelect: (o.onSelect ?? vi.fn()) as never, runAll: run }} />
  </I18nProvider>
);
const say = async (text: string) => {
  await userEvent.type(screen.getByRole('textbox', { name: /Chiedi una modifica/ }), text);
};

beforeEach(() => {
  vi.clearAllMocks();
  group = groupOf(['a', 'b', 'c']);
  __resetPendingPins();
  localStorage.clear();
  location.hash = '#/p/acme/c/lancio';
});

describe('chat selector', () => {
  it('lists the active variants and "Tutte"; the open variant is the checked one', () => {
    render(panel({ current: 'b' }));
    const sel = screen.getByRole('radiogroup', { name: 'Variante' });
    expect(within(sel).getAllByRole('radio').map((r) => r.textContent)).toEqual(['A', 'B', 'C', 'Tutte']);
    expect(within(sel).getByRole('radio', { name: 'B' }).getAttribute('aria-checked')).toBe('true');
    expect(within(sel).getByRole('radio', { name: 'Tutte' }).getAttribute('aria-checked')).toBe('false');
  });

  it('a discarded variant is not in the selector, nor in "Tutte"', () => {
    render(panel({ g: groupOf(['a', 'b', 'c'], {}, { c: { status: 'discarded' } }) }));
    expect(within(screen.getByRole('radiogroup', { name: 'Variante' })).getAllByRole('radio').map((r) => r.textContent)).toEqual(['A', 'B', 'Tutte']);
  });

  it('a click on a letter, or on Tutte, tells the page', async () => {
    const onSelect = vi.fn();
    render(panel({ onSelect }));
    await userEvent.click(screen.getByRole('radio', { name: 'C' }));
    expect(onSelect).toHaveBeenLastCalledWith('c');
    await userEvent.click(screen.getByRole('radio', { name: 'Tutte' }));
    expect(onSelect).toHaveBeenLastCalledWith('all');
  });

  it('a single variant posts to that member\'s normal turn route', async () => {
    render(panel({ current: 'b' }));
    await say('Più colore');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', `${HOST}~b`, { text: 'Più colore', pins: [] }));
    expect(run).not.toHaveBeenCalled();
  });

  it('"Tutte" posts the request to the fan-out route and says how many variants it reached', async () => {
    render(panel({ all: true }));
    expect(screen.getByRole('radio', { name: 'Tutte' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('La stessa richiesta parte in ogni variante attiva.')).toBeTruthy();
    await say('Più colore');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(run).toHaveBeenCalledWith({ text: 'Più colore', pins: [] }));
    expect(api.sendCreativeTurn).not.toHaveBeenCalled();
    expect((await screen.findAllByRole('status')).some((s) => s.textContent === 'Richiesta inviata a 3 varianti')).toBe(true);
  });

  it('"Tutte" names the variants that did not start, with the reason', async () => {
    run.mockResolvedValueOnce({ jobs: { a: 'j1' }, queued: [], skipped: ['c'], failed: { b: 'Ferma prima la variante' } });
    render(panel({ all: true }));
    await say('Ciao');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    expect(await screen.findByText('Richiesta inviata a 1 variante · Non partite: C, B (Ferma prima la variante)')).toBeTruthy();
  });

  it('"Tutte" works while the open variant is busy: the composer is not in its queue-for-after mode', async () => {
    render(panel({ all: true, job: job() }));
    expect(screen.queryByRole('button', { name: /Ferma|Stop/ })).toBeNull();
    await say('Ancora');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(run).toHaveBeenCalledWith({ text: 'Ancora', pins: [] }));
  });

  it('a refused "Tutte" keeps the text and says so', async () => {
    run.mockRejectedValueOnce(new Error('boom'));
    render(panel({ all: true }));
    await say('Ciao');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Impossibile inviare la richiesta alle varianti: boom');
    expect((screen.getByRole('textbox', { name: /Chiedi una modifica/ }) as HTMLTextAreaElement).value).toBe('Ciao');
  });

  it('a queued turn says why it waits', () => {
    render(panel({ job: job({ state: 'queued', waitReason: 'variant-slot' }) }));
    expect(screen.getByText('in coda: due varianti già al lavoro')).toBeTruthy();
  });

  it('a panel without variants has no selector and no waiting line (the chat of an old creative)', () => {
    const { container } = render(<I18nProvider locale="it"><Conversation slug="acme" creative={HOST} entries={[]} approvals={[]} job={undefined} onSent={vi.fn()} /></I18nProvider>);
    expect(container.querySelector('[data-variant-selector]')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Variante' })).toBeNull();
  });
});

const emptyLive = (): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState);
function Harness({ live = emptyLive() }: { live?: EventsState }) {
  const shell = {
    route: { name: 'creative', slug: 'acme', creative: HOST }, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as unknown as Shell;
  return (
    <I18nProvider locale="it">
      <ShellContext.Provider value={shell}>
        <header className="ms-topbar"><TopBar /></header>
        <CreativeCanvas slug="acme" creative={HOST} live={live} />
      </ShellContext.Provider>
    </I18nProvider>
  );
}

describe('chat selector in the canvas', () => {
  it('a letter opens that variant\'s conversation and a message goes to its own turn route', async () => {
    conversations[`${HOST}~b`] = [{ type: 'user', at, text: 'Messaggio della B', pins: [], attachments: [] }];
    render(<Harness />);
    await screen.findByRole('region', { name: 'Variante A' });
    await userEvent.click(screen.getByRole('radio', { name: 'B' }));
    await screen.findByText('Messaggio della B');
    expect(api.getConversation).toHaveBeenCalledWith('acme', `${HOST}~b`);
    expect(screen.getByRole('radio', { name: 'B' }).getAttribute('aria-checked')).toBe('true');
    await say('Meno testo');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', `${HOST}~b`, expect.objectContaining({ text: 'Meno testo' })));
    delete conversations[`${HOST}~b`];
  });

  it('"Tutte" sends the request to the fan-out route of the group', async () => {
    render(<Harness />);
    await screen.findByRole('region', { name: 'Variante A' });
    await userEvent.click(screen.getByRole('radio', { name: 'Tutte' }));
    await say('Tutti più chiari');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(run).toHaveBeenCalledWith('acme', HOST, { targets: 'all-active', request: expect.objectContaining({ text: 'Tutti più chiari' }) }));
    expect(api.sendCreativeTurn).not.toHaveBeenCalled();
  });

  it('clicking a variant\'s name in its row opens its conversation too', async () => {
    render(<Harness />);
    const row = await screen.findByRole('region', { name: 'Variante C' });
    await userEvent.click(within(row).getByRole('button', { name: /Variante C · Giocosa/ }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'C' }).getAttribute('aria-checked')).toBe('true'));
    expect(api.getConversation).toHaveBeenCalledWith('acme', `${HOST}~c`);
  });
});
