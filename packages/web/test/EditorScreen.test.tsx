import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type Composition, type CreativeDetail, type EditorCompositionView, type StagedAsset, type VersionEntry } from '@motion-studio/shared';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import spikeJson from '../../shared/test/fixtures/spike-composition.json';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Route } from '../src/routes.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';

const at = '2026-10-08T10:00:00.000Z';
const spike = spikeJson as unknown as Composition;
const REEL = 'instagram-reel-9x16';
const TIKTOK = 'tiktok-9x16';
const hashOf = (n: number) => String(n).repeat(64).slice(0, 64);
const FILES = ['composition.json', 'assets/bg.mp4', 'assets/photo.jpg', 'assets/spikefont.ttf', 'assets/logo.svg', 'assets/music.wav', 'assets/voice.wav', 'assets/sfx.wav', 'layers/outro.html'];
const v2 = (n: number): VersionEntry => ({
  n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: '', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null,
  compositions: [{ format: REEL, dir: `compositions/${REEL}`, hash: hashOf(n) }],
});
const legacy = (n: number): VersionEntry => ({ ...v2(n), compositions: undefined });
const makeDetail = (versions: VersionEntry[], over: Partial<CreativeDetail['creative']['brief']> = {}): CreativeDetail => ({
  slug: 'lancio', jobKey: 'creative:/w:acme:lancio', versions,
  creative: {
    schemaVersion: 1, title: 'Lancio estivo', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'g', message: 'm', formats: [REEL], durationSec: 6, assets: [], notes: '', ...over },
  },
});
const view = (n: number, over: Partial<EditorCompositionView> = {}): EditorCompositionView => ({
  n, format: REEL, primaryFormat: REEL, hash: hashOf(n), composition: structuredClone(spike), files: FILES.map((path) => ({ path, size: 1000 })), fonts: [], ...over,
});

let detail = makeDetail([v2(1), v2(2)]);
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async () => detail),
  getConversation: vi.fn(async () => []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  getEditorComposition: vi.fn(async (_s: string, _c: string, n: number, _f: string) => view(n)),
  saveEdits: vi.fn(async (..._a: unknown[]) => ({ version: 3 })),
  stageEditorAsset: vi.fn(async (..._a: unknown[]): Promise<StagedAsset> => ({ path: 'assets/lib/ab12cd34-clip.mp4', size: 99, kind: 'video' })),
  sendCreativeTurn: vi.fn(async () => ({ id: 'j9', key: 'k', kind: 'creative', label: 'x', state: 'queued', createdAt: at })),
  revokePreview: vi.fn(async (..._a: unknown[]) => ({ revoked: true })),
  previewSession: vi.fn(async (_s: string, _c: string, n: number, format: string, _o: string, _renew?: string) => ({
    url: `http://127.0.0.1:61234/tok-${format}-v${n}/runtime/index.html?mode=preview&parentOrigin=x`, token: `tok-${format}-v${n}`, origin: 'http://127.0.0.1:61234',
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), format, hash: hashOf(n), width: 1080, height: 1920, duration: 6, fps: 30,
  })),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
};
class ApiError extends Error {
  problems?: string[];
  constructor(public status: number, message: string, public code?: string, _retry?: number, problems?: string[]) { super(message); this.problems = problems; }
}
vi.mock('../src/api.ts', () => ({ api, ApiError }));

// A fake of the player: the real one needs a runtime frame. Only the contract the editor uses.
const media = vi.hoisted(() => {
  const events = new EventTarget();
  const m = {
    seq: 0, applied: null as null | { seq: number; errors: Array<{ code: string; message: string }> }, currentTime: 0, duration: 6, loop: false, playbackRate: 1, paused: true,
    setComposition: vi.fn((_c: unknown) => { m.seq += 1; return m.seq; }),
    addSessionMedia: vi.fn((_src: string, _m: unknown) => true),
    play: vi.fn(async () => { m.paused = false; events.dispatchEvent(new Event('play')); }),
    pause: vi.fn(() => { m.paused = true; events.dispatchEvent(new Event('pause')); }),
    addEventListener: (t: string, l: EventListener) => events.addEventListener(t, l),
    removeEventListener: (t: string, l: EventListener) => events.removeEventListener(t, l),
    emit: (t: string) => events.dispatchEvent(new Event(t)),
  };
  return m;
});
vi.mock('../src/components/CompositionPlayer.tsx', async () => {
  const React = await import('react');
  return {
    CompositionMedia: class {},
    CompositionPlayer: (p: { session: { token: string }; onMedia?(m: unknown): void; onShowing?(t: string | null): void }) => {
      const props = React.useRef(p);
      props.current = p;
      React.useEffect(() => { props.current.onMedia?.(media); return () => props.current.onMedia?.(null); }, []);
      React.useEffect(() => {
        const id = setTimeout(() => props.current.onShowing?.(p.session.token), 0);
        return () => clearTimeout(id);
      }, [p.session.token]);
      return React.createElement('div', { 'data-testid': 'player', 'data-token': p.session.token });
    },
  };
});
// The timeline slot's transport reports the editor context (what Tasks 6 to 9 get).
const probe = vi.hoisted(() => ({ ctx: null as null | { stageAsset(from: unknown): Promise<unknown>; token: string | null; staging: boolean; selection: string | null } }));
vi.mock('../src/screens/Transport.tsx', async (orig) => {
  const m = await orig<typeof import('../src/screens/Transport.tsx')>();
  const ed = await import('../src/screens/editor/editorContext.ts');
  const React = await import('react');
  return { ...m, Transport: () => { probe.ctx = React.useContext(ed.EditorContext) as never; return null; } };
});

const { EditorScreen } = await import('../src/screens/editor/EditorScreen.tsx');
const { __resetPreviewSessions } = await import('../src/components/compositionPreview.ts');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { __resetDrafts, draftKey, peekDraft, useDraft, useUnsavedDrafts } = await import('../src/screens/editor/draftStore.ts');
const { leaveRefused } = await import('../src/screens/editor/leaveGuard.ts');
const { useDraftCloseGuard } = await import('../src/shell/useAttention.ts');
const { useHashRoute } = await import('../src/App.tsx');
const { getToasts, __resetToasts } = await import('../src/ui/toast.tsx');
const { useEditorKeys } = await import('../src/screens/editor/useEditorKeys.ts');
const { SAVED_MS } = await import('../src/screens/editor/DraftPill.tsx');

const KEY = draftKey('acme', 'lancio', REEL);
const emptyLive = (): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {}, snapshots: 0 } as unknown as EventsState);
let live = emptyLive();

function Harness({ format = REEL }: { format?: string }) {
  const route: Route = { name: 'edit', slug: 'acme', creative: 'lancio', format };
  const shell = {
    route, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} },
    openPalette: () => {},
  } as unknown as Shell;
  return (
    <I18nProvider locale="en">
      <ShellContext.Provider value={shell}>
        <header className="ms-topbar"><TopBar /></header>
        <EditorScreen slug="acme" creative="lancio" format={format} live={live} />
      </ShellContext.Provider>
    </I18nProvider>
  );
}

/** The store, from outside the screen: how the stage handles and the inspector will apply their edits. */
function store() {
  const h = renderHook(() => useDraft(KEY));
  return {
    apply: (op: Parameters<ReturnType<typeof useDraft>[1]['apply']>[0], o?: { coalesce?: string }) => { let r; act(() => { r = h.result.current[1].apply(op, o); }); return r; },
    stage: (a: StagedAsset) => act(() => h.result.current[1].stage(a)),
    get draft() { return h.result.current[0]; },
  };
}
const move = (x: number) => ({ kind: 'clipProps', clipId: 'title', props: { x } }) as const;
const opened = async (o: { probe?: boolean } = {}) => {
  await screen.findByTestId('player');
  await waitFor(() => expect(peekDraft(KEY)).not.toBeNull());
  // The timeline slot (video) reports the editor context.
  if (o.probe !== false) await waitFor(() => expect(probe.ctx).not.toBeNull());
};

beforeEach(() => {
  __resetPreviewSessions();
  __resetDrafts();
  __resetToasts();
  vi.clearAllMocks();
  // A test that queued a one-off answer it never used must not leak it into the next.
  api.saveEdits.mockReset().mockImplementation(async () => ({ version: 3 }));
  api.getEditorComposition.mockReset().mockImplementation(async (_s, _c, n) => view(n));
  api.stageEditorAsset.mockReset().mockImplementation(async () => ({ path: 'assets/lib/ab12cd34-clip.mp4', size: 99, kind: 'video' }));
  api.previewSession.mockReset().mockImplementation(async (_s, _c, n, format) => ({
    url: `http://127.0.0.1:61234/tok-${format}-v${n}/runtime/index.html?mode=preview&parentOrigin=x`, token: `tok-${format}-v${n}`, origin: 'http://127.0.0.1:61234',
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), format, hash: hashOf(n), width: 1080, height: 1920, duration: 6, fps: 30,
  }));
  probe.ctx = null;
  media.seq = 0;
  media.currentTime = 0;
  media.paused = true;
  media.applied = null;
  detail = makeDetail([v2(1), v2(2)]);
  live = emptyLive();
  location.hash = `#/p/acme/c/lancio/f/${REEL}/edit`;
});
afterEach(() => { vi.useRealTimers(); });

describe('EditorScreen · shell', () => {
  it('opens the latest version: the layout slots, the format crumb and the stage player, no pill without edits', async () => {
    render(<Harness />);
    await opened();
    expect(api.getEditorComposition).toHaveBeenCalledWith('acme', 'lancio', 2, REEL);
    expect(api.previewSession).toHaveBeenCalledWith('acme', 'lancio', 2, REEL, location.origin);
    expect(screen.getByRole('complementary', { name: 'Scenes' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Timeline' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Inspector' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeTruthy();
    expect(screen.queryByText(/Draft ·/)).toBeNull();
    // Nothing is sent to the player until there is a draft to show.
    expect(media.setComposition).not.toHaveBeenCalled();
    // The bar: the format, the facts of the composition, the version.
    const bar = document.querySelector('.ms-topbar') as HTMLElement;
    expect(within(bar).getByText('1080×1920 · 6 s · 30 fps')).toBeTruthy();
    expect(within(bar).getByText('v2')).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Back to the preview' })).toBeTruthy();
  });

  it('an image format has the layers panel and no timeline', async () => {
    detail = makeDetail([v2(1)]);
    api.getEditorComposition.mockResolvedValueOnce(view(1, { composition: { ...structuredClone(spike), duration: 0, scenes: [], tracks: [] } as Composition }));
    render(<Harness />);
    await opened({ probe: false });
    expect(screen.getByRole('complementary', { name: 'Layers' })).toBeTruthy();
    expect(document.querySelector('.ms-ed-image')).not.toBeNull();
  });

  it('a legacy version has no editor: it says so and offers the way back', async () => {
    detail = makeDetail([legacy(1)]);
    render(<Harness />);
    expect(await screen.findByText(/no composition to edit/)).toBeTruthy();
    expect(api.getEditorComposition).not.toHaveBeenCalled();
  });

  it('a follower opens its primary composition and says so, with the formats that share it', async () => {
    detail = makeDetail([v2(1)], { formats: [REEL, TIKTOK], links: { [TIKTOK]: REEL } });
    render(<Harness format={TIKTOK} />);
    await opened();
    expect(api.getEditorComposition).toHaveBeenCalledWith('acme', 'lancio', 1, REEL);
    const note = await screen.findByText(/^Editing .* · also used by /);
    expect(note.textContent).toContain('TikTok');
    expect(screen.getAllByText(/Also used by .*TikTok/).length).toBeGreaterThan(0);
    // The draft belongs to the primary.
    expect(peekDraft(draftKey('acme', 'lancio', REEL))).not.toBeNull();
  });
});

describe('EditorScreen · draft pill and the live preview', () => {
  it('an edit shows the pill, goes to the player, and undo / redo go back and forth', async () => {
    render(<Harness />);
    await opened();
    const s = store();
    s.apply(move(111));
    expect(await screen.findByText('Draft · 1 edit')).toBeTruthy();
    await waitFor(() => expect(media.setComposition).toHaveBeenCalledTimes(1));
    const sentX = (call: number) => ((media.setComposition.mock.calls[call]![0] as Composition).tracks.flatMap((t) => t.clips).find((k) => k.id === 'title') as unknown as { props: { x: number } }).props.x;
    expect(sentX(0)).toBe(111);
    expect(screen.getByRole('button', { name: 'Save as v3' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(media.setComposition).toHaveBeenCalledTimes(2));
    expect(sentX(1)).toBe(90);
    expect(screen.queryByText(/Draft ·/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(media.setComposition).toHaveBeenCalledTimes(3));
    expect(sentX(2)).toBe(111);
  });

  it('Save is disabled with the first problem as its description while the draft has problems', async () => {
    api.getEditorComposition.mockResolvedValueOnce(view(2, { files: FILES.filter((f) => f !== 'assets/photo.jpg').map((path) => ({ path, size: 1 })) }));
    render(<Harness />);
    await opened();
    const s = store();
    s.apply(move(5));
    const save = await screen.findByRole('button', { name: 'Save as v3' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    const why = document.getElementById(save.getAttribute('aria-describedby')!)!;
    expect(why.textContent).toMatch(/photo\.jpg/);
    expect(api.saveEdits).not.toHaveBeenCalled();
  });

  it('Save is disabled while an agent turn or a render works on the creative', async () => {
    live = { ...emptyLive(), jobs: { j1: { id: 'j1', key: 'creative:/w:acme:lancio', kind: 'creative', label: 'x', state: 'running', createdAt: at } } } as unknown as EventsState;
    render(<Harness />);
    await opened();
    store().apply(move(5));
    const save = await screen.findByRole('button', { name: 'Save as v3' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById(save.getAttribute('aria-describedby')!)!.textContent).toMatch(/agent or a render/);
  });

  it('a draft the runtime refuses is shown, not ignored', async () => {
    render(<Harness />);
    await opened();
    store().apply(move(5));
    await waitFor(() => expect(media.setComposition).toHaveBeenCalled());
    media.applied = { seq: media.seq, errors: [{ code: 'compositionInvalid', message: 'x' }] };
    act(() => media.emit('compositionapplied'));
    expect(await screen.findByText(/The preview can't show this draft/)).toBeTruthy();
    // A fixed draft clears it.
    store().apply(move(6));
    await waitFor(() => expect(media.setComposition).toHaveBeenCalledTimes(2));
    media.applied = { seq: media.seq, errors: [] };
    act(() => media.emit('compositionapplied'));
    await waitFor(() => expect(screen.queryByText(/The preview can't show this draft/)).toBeNull());
  });

  it('Discard asks, then tells the player the BASE composition again and starts a fresh draft', async () => {
    render(<Harness />);
    await opened();
    store().apply(move(111));
    await waitFor(() => expect(media.setComposition).toHaveBeenCalledTimes(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard the draft?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Discard the draft?' })).getByRole('button', { name: 'Discard edits' }));
    await waitFor(() => expect(media.setComposition).toHaveBeenCalledTimes(2));
    expect(media.setComposition.mock.calls[1]![0]).toEqual(spike);
    expect(peekDraft(KEY)!.ops).toHaveLength(0);
    expect(screen.queryByText(/Draft ·/)).toBeNull();
  });
});

describe('EditorScreen · save', () => {
  it('sends the primary, the base, the composition, the staged paths, the ops and the session token; reopens on the new version', async () => {
    api.saveEdits.mockImplementationOnce(async () => { detail = makeDetail([v2(1), v2(2), v2(3)]); return { version: 3 }; });
    render(<Harness />);
    await opened();
    const s = store();
    s.apply(move(111));
    await userEvent.click(await screen.findByRole('button', { name: 'Save as v3' }));
    await waitFor(() => expect(api.saveEdits).toHaveBeenCalledTimes(1));
    const [slug, creative, body] = api.saveEdits.mock.calls[0]! as [string, string, Record<string, unknown>];
    expect([slug, creative]).toEqual(['acme', 'lancio']);
    expect(body).toMatchObject({ baseVersion: 2, format: REEL, baseHash: hashOf(2), staged: [], ops: [move(111)], token: `tok-${REEL}-v2` });
    expect((body.composition as Composition).tracks.flatMap((t) => t.clips).find((k) => k.id === 'title')).toMatchObject({ props: { x: 111 } });
    expect(await screen.findByText(/^✓ Saved as .* v3$/)).toBeTruthy();
    // The editor reopens on the new version and the draft is gone.
    await waitFor(() => expect(api.getEditorComposition).toHaveBeenCalledWith('acme', 'lancio', 3, REEL));
    await waitFor(() => expect(within(document.querySelector('.ms-topbar') as HTMLElement).getByText('v3')).toBeTruthy());
    expect(peekDraft(KEY)!.ops).toHaveLength(0);
    // ...and the confirmation goes after 1.8 s.
    expect(SAVED_MS).toBe(1800);
    await waitFor(() => expect(screen.queryByText(/Saved as/)).toBeNull(), { timeout: 4000 });
    expect(api.sendCreativeTurn).not.toHaveBeenCalled();
  });

  it('a staged file the composition does not use is not sent; a used one is', async () => {
    render(<Harness />);
    await opened();
    const s = store();
    s.stage({ path: 'assets/lib/aaaaaaaa-unused.png', size: 5, kind: 'image' });
    s.stage({ path: 'assets/lib/bbbbbbbb-used.png', size: 5, kind: 'image' });
    s.apply({ kind: 'clipMedia', clipId: 'photo1', src: 'assets/lib/bbbbbbbb-used.png' });
    await userEvent.click(await screen.findByRole('button', { name: 'Save as v3' }));
    await waitFor(() => expect(api.saveEdits).toHaveBeenCalled());
    expect((api.saveEdits.mock.calls[0]![2] as { staged: string[] }).staged).toEqual(['assets/lib/bbbbbbbb-used.png']);
  });

  it('a 409 base-changed keeps the draft and offers to reopen on the latest version, discarding only after a confirmation', async () => {
    api.saveEdits.mockRejectedValueOnce(new ApiError(409, 'The format changed in v4 while you were editing', 'editor-base-changed'));
    render(<Harness />);
    await opened();
    store().apply(move(111));
    await userEvent.click(await screen.findByRole('button', { name: 'Save as v3' }));
    const dialog = await screen.findByRole('dialog', { name: 'This format changed while you were editing' });
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'This format changed while you were editing' })).toBeNull());
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
    // The version list is asked again at the 409, so the reopen can really land on the latest version.
    await waitFor(() => expect(api.getCreative.mock.calls.length).toBeGreaterThan(1));
    // The note stays, with Save off; Reopen asks first and only then discards.
    expect((screen.getByRole('button', { name: 'Save as v3' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Reopen on the latest version' }));
    const confirm = await screen.findByRole('dialog', { name: 'Discard the draft and reopen?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard the draft and reopen?' })).toBeNull());
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
    api.getEditorComposition.mockClear();
    api.getCreative.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'Reopen on the latest version' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Discard the draft and reopen?' })).getByRole('button', { name: 'Discard and reopen' }));
    await waitFor(() => expect(api.getEditorComposition).toHaveBeenCalledWith('acme', 'lancio', 2, REEL));
    await waitFor(() => expect(peekDraft(KEY)?.ops).toHaveLength(0));
    expect(screen.queryByText(/Draft ·/)).toBeNull();
  });

  it('hundreds of edits still save: the ops are compacted, one per object, last value winning', async () => {
    render(<Harness />);
    await opened();
    const s = store();
    for (let i = 0; i < 501; i += 1) s.apply(move(i));
    expect(peekDraft(KEY)!.ops).toHaveLength(501);
    api.saveEdits.mockImplementationOnce(async () => { detail = makeDetail([v2(1), v2(2), v2(3)]); return { version: 3 }; });
    await userEvent.click(await screen.findByRole('button', { name: 'Save as v3' }));
    await waitFor(() => expect(api.saveEdits).toHaveBeenCalledTimes(1));
    const body = api.saveEdits.mock.calls[0]![2] as { ops: unknown[]; composition: Composition };
    expect(body.ops).toEqual([move(500)]);
    expect(await screen.findByText(/^✓ Saved as/)).toBeTruthy();
  });

  it('a newer version that changed only other formats does not move the base: no dialog, Save works on the old base', async () => {
    const r = render(<Harness />);
    await opened();
    store().apply(move(1));
    detail = makeDetail([v2(1), v2(2), { ...v2(3), compositions: [{ format: REEL, dir: `compositions/${REEL}`, hash: hashOf(2) }] }]);
    live = { ...emptyLive(), creativeTicks: { 'acme/lancio': 1 } } as unknown as EventsState;
    r.rerender(<Harness />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save as v4' })).toBeTruthy());
    expect(screen.queryByRole('dialog', { name: 'This format changed while you were editing' })).toBeNull();
    const save = screen.getByRole('button', { name: 'Save as v4' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect(peekDraft(KEY)!.base.n).toBe(2);
    await userEvent.click(save);
    await waitFor(() => expect(api.saveEdits).toHaveBeenCalledTimes(1));
    expect(api.saveEdits.mock.calls[0]![2]).toMatchObject({ baseVersion: 2, baseHash: hashOf(2) });
  });

  it('another version that changed the format while editing shows the same dialog, and keeps the draft', async () => {
    const r = render(<Harness />);
    await opened();
    store().apply(move(1));
    detail = makeDetail([v2(1), v2(2), v2(3)]);
    live = { ...emptyLive(), creativeTicks: { 'acme/lancio': 1 } } as unknown as EventsState;
    r.rerender(<Harness />);
    expect(await screen.findByRole('dialog', { name: 'This format changed while you were editing' })).toBeTruthy();
    expect(peekDraft(KEY)!.base.n).toBe(2);
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
    expect((screen.getByRole('button', { name: 'Save as v4' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('an untouched draft simply moves to the latest version', async () => {
    const r = render(<Harness />);
    await opened();
    detail = makeDetail([v2(1), v2(2), v2(3)]);
    live = { ...emptyLive(), creativeTicks: { 'acme/lancio': 1 } } as unknown as EventsState;
    r.rerender(<Harness />);
    await waitFor(() => expect(api.getEditorComposition).toHaveBeenCalledWith('acme', 'lancio', 3, REEL));
    await waitFor(() => expect(peekDraft(KEY)!.base.n).toBe(3));
  });

  it('shows a refused draft (422) with the core\'s translated problem and keeps it', async () => {
    api.saveEdits.mockRejectedValueOnce(new ApiError(422, 'The draft cannot be saved: clip title is outside its scene', 'editor-invalid', undefined, ['clip title is outside its scene']));
    render(<Harness />);
    await opened();
    store().apply(move(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Save as v3' }));
    expect(await screen.findByText('The draft cannot be saved: clip title is outside its scene')).toBeTruthy();
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
  });

  it('a busy core (agent or render) is said and the draft is kept', async () => {
    api.saveEdits.mockRejectedValueOnce(new ApiError(409, 'The agent or a render is working on this creative', 'editor-busy'));
    render(<Harness />);
    await opened();
    store().apply(move(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Save as v3' }));
    expect(await screen.findByText('The agent or a render is working on this creative')).toBeTruthy();
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
  });
});

describe('EditorScreen · leave guard', () => {
  const OTHER = `#/p/acme/c/lancio/f/${TIKTOK}`;
  const dirty = async () => { render(<Harness />); await opened(); store().apply(move(111)); await screen.findByText('Draft · 1 edit'); };

  it('does not block a clean editor, nor the editor\'s own route', async () => {
    render(<Harness />);
    await opened();
    expect(leaveRefused(OTHER)).toBe(false);
    store().apply(move(1));
    expect(leaveRefused(`#/p/acme/c/lancio/f/${REEL}/edit`)).toBe(false);
  });

  it('a move away with edits asks; Keep editing stays', async () => {
    await dirty();
    let blocked = false;
    act(() => { blocked = leaveRefused(OTHER); });
    expect(blocked).toBe(true);
    const dialog = await screen.findByRole('dialog', { name: 'Save your edits first?' });
    expect(within(dialog).getByText('You have 1 edit that is not saved as a version.')).toBeTruthy();
    location.hash = '#/stay';
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save your edits first?' })).toBeNull());
    expect(location.hash).toBe('#/stay');
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
  });

  it('Discard throws the draft away and goes where it was going', async () => {
    await dirty();
    act(() => { leaveRefused(OTHER); });
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Save your edits first?' })).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(location.hash).toBe(OTHER));
    expect(peekDraft(KEY)?.ops ?? []).toHaveLength(0);
    expect(api.saveEdits).not.toHaveBeenCalled();
  });

  it('Save as vN saves, then goes where it was going; a failed save stays here with the draft', async () => {
    await dirty();
    api.saveEdits.mockRejectedValueOnce(new ApiError(409, 'busy', 'editor-busy'));
    act(() => { leaveRefused(OTHER); });
    location.hash = '#/stay';
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Save your edits first?' })).getByRole('button', { name: 'Save as v3' }));
    await waitFor(() => expect(api.saveEdits).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save your edits first?' })).toBeNull());
    expect(location.hash).toBe('#/stay');
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
    // Again, this time it saves.
    api.saveEdits.mockImplementationOnce(async () => { detail = makeDetail([v2(1), v2(2), v2(3)]); return { version: 3 }; });
    act(() => { leaveRefused(OTHER); });
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Save your edits first?' })).getByRole('button', { name: 'Save as v3' }));
    await waitFor(() => expect(location.hash).toBe(OTHER));
  });

  it('the back button goes through the same guard', async () => {
    await dirty();
    await userEvent.click(within(document.querySelector('.ms-topbar') as HTMLElement).getByRole('button', { name: 'Back to the preview' }));
    // The router (App) would refuse the hash change and ask; here the move happened: ask as the router does.
    expect(location.hash).toBe(`#/p/acme/c/lancio/f/${REEL}`);
    act(() => { leaveRefused(location.hash); });
    expect(await screen.findByRole('dialog', { name: 'Save your edits first?' })).toBeTruthy();
  });

  it('sending a chat message asks first: Keep editing sends nothing, Discard sends it', async () => {
    await dirty();
    await userEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    const box = await screen.findByLabelText('Request a change');
    await userEvent.type(box, 'More rhythm');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    let dialog = await screen.findByRole('dialog', { name: 'Save your edits first?' });
    expect(within(dialog).getByText(/starts from the latest saved version/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save your edits first?' })).toBeNull());
    expect(api.sendCreativeTurn).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Request a change') as HTMLTextAreaElement).value).toBe('More rhythm');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    dialog = await screen.findByRole('dialog', { name: 'Save your edits first?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledTimes(1));
    expect(peekDraft(KEY)!.ops).toHaveLength(0);
  });

  it('sending a chat message with no edits goes straight out', async () => {
    render(<Harness />);
    await opened();
    await userEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    await userEvent.type(await screen.findByLabelText('Request a change'), 'Hi');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledTimes(1));
  });
});

describe('the router asks the guard (App useHashRoute)', () => {
  function Router() {
    const hash = useHashRoute();
    return <output data-testid="hash">{hash}</output>;
  }
  it('a refused move puts the address back and does not change the page; an allowed one does', async () => {
    location.hash = '#/p/acme/c/lancio/f/a/edit';
    const asked: string[] = [];
    const { registerLeaveGuard } = await import('../src/screens/editor/leaveGuard.ts');
    let blocking = true;
    const off = registerLeaveGuard({ blocks: () => blocking, ask: (h) => { asked.push(h); } });
    render(<Router />);
    expect(screen.getByTestId('hash').textContent).toBe('#/p/acme/c/lancio/f/a/edit');
    act(() => { location.hash = '#/settings'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(asked).toEqual(['#/settings']);
    expect(screen.getByTestId('hash').textContent).toBe('#/p/acme/c/lancio/f/a/edit');
    expect(location.hash).toBe('#/p/acme/c/lancio/f/a/edit');
    blocking = false;
    act(() => { location.hash = '#/settings'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(screen.getByTestId('hash').textContent).toBe('#/settings');
    off();
  });
});

describe('closing with an unsaved draft', () => {
  function Guard() {
    useDraftCloseGuard(useUnsavedDrafts());
    return null;
  }
  const unload = () => {
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  it('a browser asks before a reload only while a draft has edits', async () => {
    render(<Guard />);
    expect(unload()).toBe(false);
    render(<Harness />);
    await opened();
    expect(unload()).toBe(false);
    store().apply(move(1));
    await waitFor(() => expect(unload()).toBe(true));
    act(() => { peekDraft(KEY); });
    const h = renderHook(() => useDraft(KEY));
    act(() => h.result.current[1].undo());
    await waitFor(() => expect(unload()).toBe(false));
  });
  it('the desktop app is told the count (its close confirmation is the render guard\'s)', async () => {
    const setDraftsUnsaved = vi.fn(async () => {});
    (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => null, revealPath: async () => {}, setDraftsUnsaved };
    try {
      render(<Guard />);
      await waitFor(() => expect(setDraftsUnsaved).toHaveBeenLastCalledWith(0));
      render(<Harness />);
      await opened();
      store().apply(move(1));
      await waitFor(() => expect(setDraftsUnsaved).toHaveBeenLastCalledWith(1));
      // The desktop's own dialog replaces beforeunload.
      expect(unload()).toBe(false);
    } finally {
      delete (window as unknown as { motionStudio?: unknown }).motionStudio;
    }
  });
});

describe('EditorScreen · keyboard', () => {
  const key = (init: KeyboardEventInit, target: Window | Element = window) => fireEvent.keyDown(target, init);
  it('undo / redo with Ctrl (Ctrl+Y too) and ⌘ on macOS, Space and the arrows drive the player, Delete explains', async () => {
    render(<Harness />);
    await opened();
    const s = store();
    s.apply(move(1));
    s.apply(move(2), { coalesce: undefined });
    expect(s.draft!.ops).toHaveLength(2);
    key({ key: 'z', ctrlKey: true });
    expect(s.draft!.ops).toHaveLength(1);
    key({ key: 'z', ctrlKey: true, shiftKey: true });
    expect(s.draft!.ops).toHaveLength(2);
    key({ key: 'z', ctrlKey: true });
    key({ key: 'y', ctrlKey: true });
    expect(s.draft!.ops).toHaveLength(2);
    // Space plays and pauses the stage player.
    await waitFor(() => expect(probe.ctx).not.toBeNull());
    key({ key: ' ', code: 'Space' });
    await waitFor(() => expect(media.play).toHaveBeenCalledTimes(1));
    key({ key: ' ', code: 'Space' });
    expect(media.pause).toHaveBeenCalled();
    // A frame at a time.
    media.paused = true;
    key({ key: 'ArrowRight' });
    expect(media.currentTime).toBeCloseTo(1 / 30, 5);
    key({ key: 'ArrowLeft' });
    expect(media.currentTime).toBeCloseTo(0, 5);
    // Delete: clips cannot be removed here.
    key({ key: 'Delete' });
    expect(getToasts().map((t) => t.text)).toContain('Ask the agent to remove clips');
    expect(s.draft!.ops).toHaveLength(2);
  });

  it('never while typing: a field keeps its own undo, Space and arrows', async () => {
    render(<Harness />);
    await opened();
    const s = store();
    s.apply(move(1));
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    key({ key: 'z', ctrlKey: true }, input);
    key({ key: ' ', code: 'Space' }, input);
    key({ key: 'ArrowRight' }, input);
    key({ key: 'Delete' }, input);
    expect(s.draft!.ops).toHaveLength(1);
    expect(media.play).not.toHaveBeenCalled();
    expect(media.currentTime).toBe(0);
    expect(getToasts()).toHaveLength(0);
    // The chat box too.
    await userEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    const box = await screen.findByLabelText('Request a change');
    key({ key: 'z', ctrlKey: true }, box);
    expect(s.draft!.ops).toHaveLength(1);
    input.remove();
  });

  it('⌘Z and ⇧⌘Z on macOS; Ctrl+Z does nothing there', async () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    try {
      render(<Harness />);
      await opened();
      const s = store();
      s.apply(move(1));
      key({ key: 'z', ctrlKey: true });
      expect(s.draft!.ops).toHaveLength(1);
      key({ key: 'z', metaKey: true });
      expect(s.draft!.ops).toHaveLength(0);
      key({ key: 'z', metaKey: true, shiftKey: true });
      expect(s.draft!.ops).toHaveLength(1);
    } finally { platform.mockRestore(); }
  });

  describe('useEditorKeys', () => {
    function Keys({ enabled = true, h }: { enabled?: boolean; h: Record<string, () => void> }) {
      const ref = useRef<HTMLDivElement>(null);
      useEditorKeys(ref, enabled, h as never);
      return <div ref={ref} />;
    }
    const handlers = () => ({ undo: vi.fn(), redo: vi.fn(), toggle: vi.fn(), step: vi.fn(), deselect: vi.fn(), remove: vi.fn() });
    it('Esc deselects, Backspace and Delete explain, a disabled map does nothing, a modal on top owns the keyboard', () => {
      const h = handlers();
      const { rerender } = render(<Keys h={h} />);
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.keyDown(window, { key: 'Delete' });
      fireEvent.keyDown(window, { key: 'Backspace' });
      expect(h.deselect).toHaveBeenCalledTimes(1);
      expect(h.remove).toHaveBeenCalledTimes(2);
      fireEvent.keyDown(window, { key: 'ArrowLeft' });
      fireEvent.keyDown(window, { key: 'ArrowRight' });
      expect(h.step.mock.calls).toEqual([[-1], [1]]);
      const modal = document.createElement('div');
      modal.className = 'ms-modal';
      const inner = document.createElement('button');
      modal.append(inner);
      document.body.append(modal);
      fireEvent.keyDown(inner, { key: 'Escape' });
      expect(h.deselect).toHaveBeenCalledTimes(1);
      modal.remove();
      const quiet = handlers();
      rerender(<Keys enabled={false} h={quiet} />);
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
      expect(quiet.deselect).not.toHaveBeenCalled();
      expect(quiet.undo).not.toHaveBeenCalled();
    });
    it('Space on a focused button is that button\'s click, not play', () => {
      const h = handlers();
      render(<><Keys h={h} /><button type="button">Other</button></>);
      const b = screen.getByRole('button', { name: 'Other' });
      b.focus();
      fireEvent.keyDown(b, { key: ' ', code: 'Space' });
      expect(h.toggle).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: ' ', code: 'Space' });
      expect(h.toggle).toHaveBeenCalledTimes(1);
    });
  });
});

describe('EditorScreen · staging and session renewal', () => {
  const asset: StagedAsset = { path: 'assets/lib/ab12cd34-clip.mp4', size: 99, kind: 'video', media: { index: 3, sourceFps: 30, sourceStart: 0, sourceVideoEnd: 4 } };

  it('stages with the session token, shows the busy note meanwhile, adds the video to the player, and keeps the draft', async () => {
    let finish: (a: StagedAsset) => void = () => {};
    api.stageEditorAsset.mockImplementationOnce(() => new Promise<StagedAsset>((r) => { finish = r; }));
    render(<Harness />);
    await opened();
    let result: Promise<unknown> = Promise.resolve();
    act(() => { result = probe.ctx!.stageAsset({ kind: 'library', file: 'assets/clip.mp4' }); });
    expect(api.stageEditorAsset).toHaveBeenCalledWith('acme', 'lancio', { token: `tok-${REEL}-v2`, from: { kind: 'library', file: 'assets/clip.mp4' } });
    expect(await screen.findByText(/Large videos are converted first/)).toBeTruthy();
    expect(probe.ctx!.staging).toBe(true);
    // The UI stays responsive meanwhile: an edit goes through.
    store().apply(move(7));
    expect(peekDraft(KEY)!.ops).toHaveLength(1);
    await act(async () => { finish(asset); await result; });
    expect(media.addSessionMedia).toHaveBeenCalledWith(asset.path, asset.media);
    expect(peekDraft(KEY)!.staged).toEqual([asset]);
    expect(screen.queryByText(/Large videos are converted first/)).toBeNull();
  });

  it('a staging failure shows the translated error and stages nothing', async () => {
    api.stageEditorAsset.mockRejectedValueOnce(new ApiError(400, 'clip.mp4 is not a readable media file', 'editor-not-media'));
    render(<Harness />);
    await opened();
    let r: unknown = 'x';
    await act(async () => { r = await probe.ctx!.stageAsset({ kind: 'library', file: 'assets/clip.mp4' }); });
    expect(r).toBeNull();
    expect(await screen.findByText(/Couldn't add the file: clip.mp4 is not a readable media file/)).toBeTruthy();
    expect(peekDraft(KEY)!.staged).toEqual([]);
  });

  it('a renewed session: no new staging; the staged videos go to the player again, the frame is replaced, the new token is used', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The first session is about to expire (renewed in ~6 s), the second one lives.
    api.previewSession.mockImplementationOnce(async (_s, _c, n, format) => ({
      url: `http://127.0.0.1:61234/tok-a/runtime/index.html?mode=preview&parentOrigin=x`, token: 'tok-a', origin: 'http://127.0.0.1:61234',
      expiresAt: new Date(Date.now() + 66_000).toISOString(), format, hash: hashOf(n), width: 1080, height: 1920, duration: 6, fps: 30,
    }));
    api.previewSession.mockImplementationOnce(async (_s, _c, n, format) => ({
      url: `http://127.0.0.1:61234/tok-b/runtime/index.html?mode=preview&parentOrigin=x`, token: 'tok-b', origin: 'http://127.0.0.1:61234',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), format, hash: hashOf(n), width: 1080, height: 1920, duration: 6, fps: 30,
    }));
    render(<Harness />);
    await opened();
    expect(screen.getByTestId('player').getAttribute('data-token')).toBe('tok-a');
    api.stageEditorAsset.mockResolvedValueOnce(asset);
    await act(async () => { await probe.ctx!.stageAsset({ kind: 'library', file: 'assets/clip.mp4' }); });
    store().apply({ kind: 'clipMedia', clipId: 'bgv', src: asset.path });
    expect(api.stageEditorAsset).toHaveBeenCalledTimes(1);
    media.addSessionMedia.mockClear();
    media.setComposition.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    await waitFor(() => expect(screen.getByTestId('player').getAttribute('data-token')).toBe('tok-b'));
    // Renewed from the first one; the core moved the staging, the web never stages again.
    expect(api.previewSession).toHaveBeenLastCalledWith('acme', 'lancio', 2, REEL, location.origin, 'tok-a');
    expect(api.stageEditorAsset).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(media.addSessionMedia).toHaveBeenCalledWith(asset.path, asset.media);
    expect(media.setComposition).toHaveBeenCalled();
    // Staging and saving use the new token.
    await act(async () => { await probe.ctx!.stageAsset({ kind: 'library', file: 'assets/other.mp4' }); });
    expect(api.stageEditorAsset).toHaveBeenLastCalledWith('acme', 'lancio', expect.objectContaining({ token: 'tok-b' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save as v3' }));
    await waitFor(() => expect(api.saveEdits).toHaveBeenCalled());
    expect(api.saveEdits.mock.calls[0]![2]).toMatchObject({ token: 'tok-b', staged: [asset.path] });
  });
});
