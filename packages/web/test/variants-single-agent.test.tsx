/**
 * Phase 3 of the single agent (decisions 977–980, spec §7, §8): in a group with one agent the composer sends to the group:
 * no "Invia a"/"Tutte" selector, no "Applies to" (the agent decides per variant), the pending comments are the group's (each
 * with its variant), and the chat follows the group turn. The coordinator's words are the agent's voice; a user message to
 * the group shows the chips of its comments' variants; the `group-turn` entry says what each variant did.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type ConversationEntry, type JobSummary, type Pin, type VariantGroup, type VersionEntry } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { at, detailFor, groupOf, HOST, version } from './support/variants.ts';

vi.setConfig({ testTimeout: 30_000 });

let group: VariantGroup = groupOf(['a', 'b', 'c']);
const versionsBy: Record<string, VersionEntry[]> = { [HOST]: [version(1, 'Dal brief')], [`${HOST}~b`]: [version(1, 'Dal brief')], [`${HOST}~c`]: [version(1, 'Dal brief')] };
let conversation: ConversationEntry[] = [];
const GROUP_KEY = `group:creative:/w:acme:${HOST}`;
const single = (slug: string) => {
  const d = detailFor(slug, versionsBy[slug] ?? [], group);
  return { ...d, variants: { ...d.variants!, single: { groupJobKey: GROUP_KEY } } } as typeof d;
};
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async (_s: string, c: string) => single(c)),
  getConversation: vi.fn(async () => conversation),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  getUsage: vi.fn(async () => { throw new Error('offline'); }),
  sendCreativeTurn: vi.fn(async (..._a: unknown[]) => ({ id: 'g1' })),
  runVariants: vi.fn(),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: true, interrupt: true, checkedAt: at })),
  postLiveMessage: vi.fn(async (..._a: unknown[]) => ({ outcome: 'delivered-pending' })), redirectJob: vi.fn(), stopJob: vi.fn(), removeQueued: vi.fn(), editQueued: vi.fn(), reorderQueue: vi.fn(), runNext: vi.fn(), decideApproval: vi.fn(),
  getPinFrames: vi.fn(async () => ({ n: 1, expiresAt: at, frames: [] })),
  groupExportPlan: vi.fn(async () => ({ items: [], formats: [] })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { Conversation } = await import('../src/components/Conversation.tsx');
const { CreativeCanvas } = await import('../src/screens/CreativeCanvas.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { __resetPendingPins } = await import('../src/screens/pendingPins.ts');

const pin = (variant: string, note: string): Pin => ({ format: 'instagram-post-1x1', x: 0.5, y: 0.5, timeSec: null, note, variant });
const groupJob = (over: Partial<JobSummary> = {}): JobSummary => ({ id: 'g1', key: GROUP_KEY, kind: 'creative-group', label: 'Lancio · agente', state: 'running', createdAt: at, ...over });
const panel = (o: { job?: JobSummary; pins?: Pin[]; others?: Pin[]; entries?: ConversationEntry[]; onSent?: (s: { pins: Pin[] }) => void; appliesTo?: Parameters<typeof Conversation>[0]['appliesTo'] } = {}) => (
  <I18nProvider locale="it">
    <Conversation slug="acme" creative={`${HOST}~b`} entries={o.entries ?? []} approvals={[]} job={o.job} onSent={o.onSent ?? vi.fn()} single self="b"
      pins={o.pins ?? []} otherPins={o.others ?? []} {...(o.appliesTo ? { appliesTo: o.appliesTo } : {})} />
  </I18nProvider>
);
const say = async (text: string) => { await userEvent.type(screen.getByRole('textbox', { name: /Chiedi una modifica/ }), text); };

beforeEach(() => {
  vi.clearAllMocks();
  group = groupOf(['a', 'b', 'c']);
  conversation = [];
  __resetPendingPins();
  localStorage.clear();
  location.hash = '#/p/acme/c/lancio';
});

describe('the composer of a group with one agent', () => {
  it('has no selector and no "Applies to"; it says the message goes to the agent, and sends every variant\'s comments to the group', async () => {
    const onSent = vi.fn();
    const appliesTo = { primaries: [{ id: 'instagram-post-1x1', label: 'Instagram', followers: [] }, { id: 'tiktok-9x16', label: 'TikTok', followers: [] }], followerOf: () => null };
    const own = pin('b', 'titolo');
    const other = pin('c', 'logo');
    const { container } = render(panel({ pins: [own], others: [other], onSent, appliesTo }));
    expect(container.querySelector('[data-variant-selector]')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Si applica a' })).toBeNull();
    expect(screen.getByText(/Il messaggio va all'agente della creatività/)).toBeTruthy();
    // Each comment shows its variant.
    const chips = container.querySelectorAll('.ms-composer-pin');
    expect([...chips].map((c) => c.querySelector('.ms-vchip')?.textContent)).toEqual(['B', 'C']);
    await say('Sistema');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', `${HOST}~b`, { text: 'Sistema', pins: [own, other] }));
    expect(onSent).toHaveBeenCalledWith({ pins: [own, other] });
  });

  it('while the group turn works, a message goes to it (the core routes it) with every comment', async () => {
    const own = pin('b', 'qui');
    render(panel({ job: groupJob(), pins: [own], others: [pin('a', 'là')] }));
    await say('E il logo');
    await userEvent.click(await screen.findByRole('button', { name: 'Invia all’agente' }));
    await waitFor(() => expect(api.postLiveMessage).toHaveBeenCalledWith('acme', `${HOST}~b`, expect.objectContaining({ text: 'E il logo', pins: [own, pin('a', 'là')], mode: 'live' })));
  });
});

describe('the group\'s chat', () => {
  it('a message to the group shows its comments\' variants; the coordinator is the agent; the group-turn entry says what each variant did', () => {
    const entries: ConversationEntry[] = [
      { type: 'user', at, text: 'Più contrasto', pins: [pin('c', 'qui')], attachments: [], jobId: 'g1', group: true },
      { type: 'agent', at, jobId: 'g1', event: { kind: 'text', text: 'Lavoro su C.' }, group: true },
      { type: 'agent', at, jobId: 'h1', event: { kind: 'text', text: 'Ho aumentato il contrasto' }, variant: 'c', groupJobId: 'g1' },
      { type: 'version', at, n: 4, status: 'complete', variant: 'c', groupJobId: 'g1' },
      { type: 'agent', at, jobId: 'g1', event: { kind: 'text', text: 'Fatto: C v4.' }, group: true },
      { type: 'group-turn', at, jobId: 'g1', group: true, outcome: [
        { variant: 'b', jobId: 'h0', version: 3, kept: true, status: 'unchanged' },
        { variant: 'c', jobId: 'h1', version: 4, kept: false, status: 'complete' },
        { variant: 'd', version: null, kept: false, status: 'failed', error: 'boom' },
      ] },
    ];
    const { container } = render(panel({ entries }));
    const you = screen.getByRole('article', { name: 'Tu' });
    expect(within(you).getAllByText('C').length).toBeGreaterThan(0);
    const footer = container.querySelector('[data-group-turn]')!;
    expect(footer.textContent).toContain('Ha lavorato su');
    expect(footer.textContent).toContain('B (nessuna modifica, v3)');
    expect(footer.textContent).toContain('C (v4)');
    expect(footer.textContent).toContain('D (non riuscita)');
    expect(screen.getByText('Lavoro su C.')).toBeTruthy();
    expect(screen.getByText('Fatto: C v4.')).toBeTruthy();
  });
});

const emptyLive = (): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState);
function Harness({ live = emptyLive(), creative = HOST }: { live?: EventsState; creative?: string }) {
  const shell = {
    route: { name: 'creative', slug: 'acme', creative }, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as unknown as Shell;
  return (
    <I18nProvider locale="it">
      <ShellContext.Provider value={shell}>
        <header className="ms-topbar"><TopBar /></header>
        <CreativeCanvas slug="acme" creative={creative} live={live} />
      </ShellContext.Provider>
    </I18nProvider>
  );
}

describe('the canvas of a group with one agent', () => {
  it('no selector; a message goes to the group (the core\'s turn route), whatever variant is open', async () => {
    const { container } = render(<Harness />);
    await screen.findByRole('region', { name: 'Variante A' });
    expect(container.querySelector('[data-variant-selector]')).toBeNull();
    await say('Più luce nella B');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', HOST, { text: 'Più luce nella B', pins: [] }));
    expect(api.runVariants).not.toHaveBeenCalled();
  });

  it('the chat follows the group turn: its Stop is the group\'s', async () => {
    const live = { ...emptyLive(), jobs: { g1: groupJob() } } as unknown as EventsState;
    render(<Harness live={live} />);
    await screen.findByRole('region', { name: 'Variante A' });
    expect(await screen.findByRole('button', { name: /Ferma/ })).toBeTruthy();
  });
});

describe('the group\'s pending comments', () => {
  it('a comment placed on B is the group\'s, with its variant; A\'s page shows it as another variant\'s; sending drops every one', async () => {
    const { renderHook, act } = await import('@testing-library/react');
    const { useChatPins } = await import('../src/screens/pendingPins.ts');
    const onB = renderHook(() => useChatPins('acme', `${HOST}~b`, { host: HOST, letter: 'b' }));
    const onA = renderHook(() => useChatPins('acme', HOST, { host: HOST, letter: 'a' }));
    act(() => onB.result.current.setStored((ps) => [...ps, { pin: { format: 'instagram-post-1x1', x: 0.1, y: 0.2, timeSec: null, note: 'titolo' }, version: 1 }]));
    act(() => onA.result.current.setStored((ps) => [...ps, { pin: { format: 'instagram-post-1x1', x: 0.3, y: 0.4, timeSec: null, note: 'logo' }, version: 2 }]));
    expect(onB.result.current.stored.map((p) => [p.pin.variant, p.pin.note])).toEqual([['b', 'titolo']]);
    expect(onA.result.current.stored.map((p) => [p.pin.variant, p.pin.note])).toEqual([['a', 'logo']]);
    expect(onA.result.current.others.map((p) => [p.variant, p.note])).toEqual([['b', 'titolo']]);
    // Outside a group with one agent each creative keeps its own, as before.
    const own = renderHook(() => useChatPins('acme', `${HOST}~b`, null));
    expect(own.result.current.stored).toEqual([]);
    act(() => onA.result.current.drop([onA.result.current.stored[0]!.pin, onA.result.current.others[0]!]));
    expect(onA.result.current.stored).toEqual([]);
    expect(onB.result.current.stored).toEqual([]);
  });
});
