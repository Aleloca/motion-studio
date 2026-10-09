import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type ConversationEntry, type CreativeDetail, type OutputFileInfo, type UsageReport, type VersionEntry } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Route } from '../src/routes.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';

const at = '2026-10-08T10:00:00.000Z';
const out = (format: string, file: string, preview: string | null = null): OutputFileInfo => ({ format, file, width: 1080, height: 1080, durationSec: null, verified: true, preview });
const version = (n: number, request = '', outputs: OutputFileInfo[] = [out('instagram-post-1x1', 'post.png'), out('tiktok-9x16', 'tiktok.mp4', '.previews/tiktok.mp4.jpg')]): VersionEntry =>
  ({ n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request, outputs, problems: [], tools: [], renderCommand: null, basedOn: null });
const makeDetail = (versions: VersionEntry[], over: Partial<CreativeDetail['creative']> = {}): CreativeDetail => ({
  slug: 'lancio', jobKey: 'creative:/w:acme:lancio', versions,
  creative: {
    schemaVersion: 1, title: 'Lancio estivo', status: versions.length ? 'ready' : 'draft', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'Mostrare la nuova app', message: 'Prenota in un tocco', formats: ['instagram-post-1x1', 'tiktok-9x16'], durationSec: 6, assets: [], notes: '' },
    ...over,
  },
});

let detail = makeDetail([version(1, 'Dal brief')]);
let conversation: ConversationEntry[] = [];
const api = {
  getFormats: vi.fn(async (): Promise<{ presets: typeof DEFAULT_FORMATS; error: string | null; path: string }> => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async () => detail),
  getConversation: vi.fn(async () => conversation),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  sendCreativeTurn: vi.fn(async () => ({ id: 'j9', key: 'creative:/w:acme:lancio', kind: 'creative', label: 'x', state: 'queued', createdAt: at })),
  updateCreative: vi.fn(async () => detail.creative),
  restoreVersion: vi.fn(async () => detail.creative),
  revealVersion: vi.fn(async () => ({ ok: true })),
  exportVersion: vi.fn(async (_s: string, _c: string, _n: number, d: string, formats?: string[]) => ({ destination: d, files: (formats ?? []).map((f) => ({ from: f, to: `${d}/${f}` })), skipped: [] as string[] })),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
  // The creative's ledger total; by default unavailable (the panel then falls back to its versions).
  getUsage: vi.fn(async (_q?: unknown): Promise<UsageReport> => { throw new Error('offline'); }),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { CreativeCanvas } = await import('../src/screens/CreativeCanvas.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { __resetPendingPins } = await import('../src/screens/pendingPins.ts');
const { takeFrameOrigin } = await import('../src/shell/intents.ts');

const emptyLive = (): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState);
const route: Route = { name: 'creative', slug: 'acme', creative: 'lancio' };

function Harness({ live }: { live: EventsState }) {
  const shell = {
    route, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} },
    openPalette: () => {},
  } as unknown as Shell;
  return (
    <ShellContext.Provider value={shell}>
      <header className="ms-topbar"><TopBar /></header>
      <CreativeCanvas slug="acme" creative="lancio" live={live} />
    </ShellContext.Provider>
  );
}

const ready = () => screen.findByRole('img', { name: /Post 1:1 v\d/ });
let platform: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => {
  vi.clearAllMocks();
  api.getUsage.mockImplementation(async () => { throw new Error('offline'); });
  detail = makeDetail([version(1, 'Dal brief')]);
  conversation = [];
  __resetPendingPins();
  localStorage.clear();
  location.hash = '#/p/acme/c/lancio';
  platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
});
afterEach(() => {
  platform?.mockRestore();
  platform = null;
  delete (window as unknown as { motionStudio?: unknown }).motionStudio;
});

describe('CreativeCanvas · fit to view', () => {
  it('opens fitted so every board is visible (CV1), and the zoom controls still work', async () => {
    const size = (dim: 'clientWidth' | 'clientHeight', v: number) => vi.spyOn(HTMLElement.prototype, dim, 'get')
      .mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? v : 0; });
    const w = size('clientWidth', 484);
    const h = size('clientHeight', 700);
    try {
      const { container } = render(<Harness live={emptyLive()} />);
      await ready();
      expect(screen.getByRole('button', { name: /55%/ })).toBeTruthy();
      // The boards (frames and media) scale; the world's spacing follows the same zoom.
      expect((container.querySelector('.ms-cv-frame') as HTMLElement).style.zoom).toBe('0.55');
      expect((container.querySelector('.ms-cv-world') as HTMLElement).style.getPropertyValue('--cv-z')).toBe('0.55');
      await userEvent.click(screen.getByRole('button', { name: /^(Zoom in|Aumenta lo zoom|Ingrandisci)/ }));
      expect(screen.getByRole('button', { name: /65%/ })).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: /65%/ }));
      expect(screen.getByRole('button', { name: /100%,/ })).toBeTruthy();
    } finally { w.mockRestore(); h.mockRestore(); }
  });
});

/** The product of every zoom and scale() on `el` and its ancestors (inline styles: jsdom has no layout). */
function netScale(el: Element): number {
  let k = 1;
  for (let e: Element | null = el.parentElement; e; e = e.parentElement) {
    const st = (e as HTMLElement).style;
    if (!st) continue;
    const z = parseFloat(st.zoom);
    if (Number.isFinite(z) && z > 0) k *= z;
    const m = /scale\(([^)]+)\)/.exec(st.transform);
    if (m) k *= parseFloat(m[1]!);
  }
  return k;
}

describe('CreativeCanvas · overlays stay screen-sized at any zoom', () => {
  it('at 50% the bubble, the pins and the board labels are not scaled, and sit at world point × zoom', async () => {
    const size = (dim: 'clientWidth' | 'clientHeight', v: number) => vi.spyOn(HTMLElement.prototype, dim, 'get')
      .mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? v : 0; });
    // World 808×750 at 100% → a 412 px wide viewport fits at exactly 50% (the 9:16 label keeps 160 px).
    const w = size('clientWidth', 412);
    const h = size('clientHeight', 2000);
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      // The 1:1 board (344×344 at 100%) on screen at 50%: 172×172 at the origin.
      const r = this.classList.contains('ms-cv-hit') ? { left: 0, top: 0, width: 172, height: 172 } : { left: 0, top: 0, width: 0, height: 0 };
      return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
    });
    try {
      const { container } = render(<Harness live={emptyLive()} />);
      await ready();
      expect(screen.getByRole('button', { name: /50%/ })).toBeTruthy();
      const post = container.querySelector('[data-board="instagram-post-1x1"]') as HTMLElement;
      // The media keeps scaling…
      const frame = post.querySelector('.ms-cv-frame') as HTMLElement;
      expect(frame.style.zoom).toBe('0.5');
      expect(netScale(frame.querySelector('img')!)).toBe(0.5);
      // …the label does not.
      const head = post.querySelector('.ms-cv-board-head') as HTMLElement;
      expect(head.textContent).toContain('Instagram · Post 1:1');
      expect(netScale(head)).toBe(1);
      expect(head.closest('[style*="zoom"]')).toBeNull();
      // The ellipsized name says itself in full on hover.
      expect(head.querySelector('.ms-cv-board-name')!.getAttribute('title')).toBe('Instagram · Post 1:1');
      // "Open editor" is screen-sized too, over the board, outside the zoomed frame; it still opens with the frame's rect.
      const open = within(post).getByRole('button', { name: 'Apri l’editor di Instagram · Post 1:1' });
      expect(netScale(open)).toBe(1);
      expect(open.closest('.ms-cv-frame')).toBeNull();
      expect(open.parentElement!.classList.contains('ms-cv-frame-wrap')).toBe(true);
      // Narrow boards on screen (< 170 px) switch Open editor to its icon alone: 9:16 is 152 px at 50%, 1:1 is 172 px.
      const tiktok = container.querySelector('[data-board="tiktok-9x16"]') as HTMLElement;
      expect(tiktok.querySelector('.ms-cv-frame-wrap')!.classList.contains('ms-narrow')).toBe(true);
      expect(post.querySelector('.ms-cv-frame-wrap')!.classList.contains('ms-narrow')).toBe(false);
      expect(post.classList.contains('ms-drafting')).toBe(false);

      // A comment at 25% / 50% of the board (click at 43,86 on the 172 px frame).
      fireEvent.keyDown(window, { key: 'c' });
      fireEvent.click(within(post).getByRole('button', { name: /^Commenta Instagram · Post 1:1/ }), { clientX: 43, clientY: 86, detail: 1 });
      const field = await screen.findByLabelText('Testo del commento');
      const bubble = field.closest('.ms-cv-bubble') as HTMLElement;
      // The board holding the open bubble paints above its neighbours (a bubble past its edge stays on top).
      expect(post.classList.contains('ms-drafting')).toBe(true);
      expect(tiktok.classList.contains('ms-drafting')).toBe(false);
      expect(netScale(bubble)).toBe(1);
      expect(netScale(field)).toBe(1);
      expect(bubble.closest('.ms-cv-frame')).toBeNull();
      // Anchor: the world point (0.25 × 344, 0.5 × 344) × zoom, from the board's screen origin (the pan is the layout's).
      const anchor = bubble.parentElement as HTMLElement;
      expect(anchor.classList.contains('ms-cv-frame-wrap')).toBe(true);
      expect(parseFloat(anchor.style.width)).toBeCloseTo(172);
      expect(parseFloat(bubble.style.left)).toBeCloseTo(0.25 * 344 * 0.5);
      expect(parseFloat(bubble.style.top)).toBeCloseTo(0.5 * 344 * 0.5);
      expect(bubble.style.left.endsWith('px')).toBe(true);

      await userEvent.type(field, 'Logo');
      await userEvent.click(screen.getByRole('button', { name: 'Commenta' }));
      const pin = within(post).getByRole('button', { name: 'Modifica il commento 1' });
      expect(netScale(pin)).toBe(1);
      expect(parseFloat(pin.style.left)).toBeCloseTo(0.25 * 344 * 0.5);
      expect(parseFloat(pin.style.top)).toBeCloseTo(0.5 * 344 * 0.5);

      // Zooming in moves the anchors with the board; the markers keep their size.
      await userEvent.click(screen.getByRole('button', { name: /^(Zoom in|Aumenta lo zoom|Ingrandisci)/ }));
      expect(frame.style.zoom).toBe('0.6');
      const moved = within(post).getByRole('button', { name: 'Modifica il commento 1' });
      expect(parseFloat(moved.style.left)).toBeCloseTo(0.25 * 344 * 0.6);
      expect(netScale(moved)).toBe(1);
    } finally { w.mockRestore(); h.mockRestore(); rect.mockRestore(); }
  });
});

describe('CreativeCanvas · overlays (round 2)', () => {
  it('Open editor, outside the zoomed frame, still hands the frame rect to T3', async () => {
    const { container } = render(<Harness live={emptyLive()} />);
    await ready();
    const post = container.querySelector('[data-board="instagram-post-1x1"]') as HTMLElement;
    const frame = post.querySelector('.ms-cv-frame') as HTMLElement;
    const rect = vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({ left: 11, top: 22, width: 172, height: 172, x: 11, y: 22, right: 183, bottom: 194, toJSON: () => ({}) } as DOMRect);
    await userEvent.click(within(post).getByRole('button', { name: 'Apri l’editor di Instagram · Post 1:1' }));
    expect(rect).toHaveBeenCalled();
    expect(takeFrameOrigin('format:acme/lancio/instagram-post-1x1')).toMatchObject({ left: 11, top: 22, width: 172 });
  });

  it('the bubble re-measures its side when the zoom changes while it is open', async () => {
    const size = (dim: 'clientWidth' | 'clientHeight', v: number) => vi.spyOn(HTMLElement.prototype, dim, 'get')
      .mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? v : 0; });
    const w = size('clientWidth', 412);
    const h = size('clientHeight', 2000);
    const ow = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-bubble') ? 260 : 0; });
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const r = this.classList.contains('ms-cv-viewport') ? { left: 0, top: 0, width: 500, height: 800 }
        : this.classList.contains('ms-cv-frame-wrap') ? { left: 0, top: 0, width: parseFloat(this.style.width) || 0, height: parseFloat(this.style.height) || 0 }
          : this.classList.contains('ms-cv-hit') ? { left: 0, top: 0, width: 172, height: 172 } : { left: 0, top: 0, width: 0, height: 0 };
      return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
    });
    try {
      const { container } = render(<Harness live={emptyLive()} />);
      await ready();
      expect(screen.getByRole('button', { name: /50%/ })).toBeTruthy();
      const post = container.querySelector('[data-board="instagram-post-1x1"]') as HTMLElement;
      fireEvent.keyDown(window, { key: 'c' });
      // At 90% of the board: 155 px from the left at 50% (room on the right), 310 px at 100% (no room: opens left).
      fireEvent.click(within(post).getByRole('button', { name: /^Commenta Instagram · Post 1:1/ }), { clientX: 155, clientY: 86, detail: 1 });
      await userEvent.type(await screen.findByLabelText('Testo del commento'), 'Più luce');
      const bubble = () => container.querySelector('.ms-cv-bubble') as HTMLElement;
      expect(bubble().classList.contains('ms-left')).toBe(false);
      await userEvent.click(screen.getByRole('button', { name: /50%,/ }));
      expect(screen.getByRole('button', { name: /100%,/ })).toBeTruthy();
      expect(bubble().classList.contains('ms-left')).toBe(true);
    } finally { w.mockRestore(); h.mockRestore(); ow.mockRestore(); rect.mockRestore(); }
  });
});

describe('CreativeCanvas · comments', () => {
  it('a click in comment mode opens a bubble whose text becomes a pin chip that can be edited and deleted', async () => {
    render(<Harness live={emptyLive()} />);
    await ready();
    // C switches to comment mode (not while typing).
    fireEvent.keyDown(window, { key: 'c' });
    expect(screen.getByRole('button', { name: 'Commenta (C)' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Clicca una tavola per commentare · Esc per uscire')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Commenta Instagram · Post 1:1/ }), { clientX: 10, clientY: 10 });
    const field = await screen.findByLabelText('Testo del commento');
    expect(document.activeElement).toBe(field);
    // Typing a "v" in the bubble does not switch tools.
    await userEvent.type(field, 'Logo più piccolo, via');
    expect(screen.getByRole('button', { name: 'Commenta (C)' }).getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'Commenta' }));
    expect(screen.queryByLabelText('Testo del commento')).toBeNull();
    // The pin is a numbered marker on the board and a chip in the composer, with its text.
    expect(screen.getByRole('button', { name: 'Modifica il commento 1' })).toBeTruthy();
    const chip = screen.getByRole('button', { name: /^Modifica il commento 1 ·/ });
    expect(chip.textContent).toContain('Logo più piccolo, via');
    // Edit from the chip.
    await userEvent.click(chip);
    const again = await screen.findByLabelText('Testo del commento');
    expect((again as HTMLTextAreaElement).value).toBe('Logo più piccolo, via');
    await userEvent.clear(again);
    await userEvent.type(again, 'Logo al 80%');
    await userEvent.click(screen.getByRole('button', { name: 'Salva' }));
    expect(screen.getByRole('button', { name: /^Modifica il commento 1 ·/ }).textContent).toContain('Logo al 80%');
    // Delete from the chip.
    await userEvent.click(screen.getByRole('button', { name: 'Rimuovi commento 1' }));
    expect(screen.queryByRole('button', { name: /Modifica il commento 1/ })).toBeNull();
  });

  it('sends the text with the pin through sendCreativeTurn', async () => {
    render(<Harness live={emptyLive()} />);
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Commenta (C)' }));
    fireEvent.click(screen.getByRole('button', { name: /^Commenta TikTok/ }));
    await userEvent.type(await screen.findByLabelText('Testo del commento'), 'Titolo più in alto');
    // ⌘↵ in the bubble adds the comment.
    fireEvent.keyDown(screen.getByLabelText('Testo del commento'), { key: 'Enter', metaKey: true });
    expect(screen.queryByLabelText('Testo del commento')).toBeNull();
    await userEvent.type(screen.getByLabelText('Chiedi una modifica'), 'Ritmo più veloce');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledOnce());
    expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'lancio', {
      text: 'Ritmo più veloce',
      // A video board on the canvas comments at 0 s (frame-accurate pins come with the format view).
      pins: [{ format: 'tiktok-9x16', x: 0.5, y: 0.5, timeSec: 0, note: 'Titolo più in alto' }],
    });
    // Sent: the chips are gone.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Modifica il commento 1/ })).toBeNull());
  });

  it('Escape leaves comment mode and drops the open bubble; V and H pick the other tools', async () => {
    render(<Harness live={emptyLive()} />);
    await ready();
    fireEvent.keyDown(window, { key: 'h' });
    expect(screen.getByRole('button', { name: 'Mano (H)' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(window, { key: 'c' });
    fireEvent.click(screen.getByRole('button', { name: /^Commenta Instagram/ }));
    const field = await screen.findByLabelText('Testo del commento');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByLabelText('Testo del commento')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Seleziona (V)' }).getAttribute('aria-pressed')).toBe('true');
    // Shortcuts with a modifier are not the canvas's.
    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    expect(screen.getByRole('button', { name: 'Seleziona (V)' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('CreativeCanvas · versions', () => {
  it('follows new versions with a toast, and picking v2 in the version menu changes the board images', async () => {
    detail = makeDetail([version(1, 'Dal brief')]);
    const { rerender } = render(<Harness live={emptyLive()} />);
    expect(((await ready()) as HTMLImageElement).getAttribute('src')).toBe('/f/acme/lancio/outputs/v1/post.png');
    detail = makeDetail([version(1, 'Dal brief'), version(2, 'Logo più piccolo')]);
    await act(async () => { rerender(<Harness live={{ ...emptyLive(), creativeTicks: { 'acme/lancio': 1 } } as unknown as EventsState} />); });
    await waitFor(() => expect(screen.getByRole('img', { name: /Post 1:1 v2/ }).getAttribute('src')).toBe('/f/acme/lancio/outputs/v2/post.png'));
    // The video board shows its poster.
    expect(screen.getByRole('img', { name: /TikTok.* v2/ }).getAttribute('src')).toBe('/f/acme/lancio/outputs/v2/.previews/tiktok.mp4.jpg');

    // Back to v1 from the history.
    await userEvent.click(screen.getByRole('button', { name: 'Versione 2 di 2, apri la cronologia' }));
    const menu = await screen.findByRole('dialog', { name: 'Versioni' });
    expect(within(menu).getByText('Logo più piccolo')).toBeTruthy();
    await userEvent.click(within(menu).getByRole('button', { name: /^Versione 1/ }));
    await waitFor(() => expect(screen.getByRole('img', { name: /Post 1:1 v1/ }).getAttribute('src')).toBe('/f/acme/lancio/outputs/v1/post.png'));
    // A new version no longer steals the explicit pick.
    detail = makeDetail([version(1), version(2), version(3)]);
    await act(async () => { rerender(<Harness live={{ ...emptyLive(), creativeTicks: { 'acme/lancio': 2 } } as unknown as EventsState} />); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Versione 1 di 3, apri la cronologia' })).toBeTruthy());
    expect(screen.getByRole('img', { name: /Post 1:1 v1/ })).toBeTruthy();
  });

  it('Restart from here and Show in Finder call the API for the version', async () => {
    detail = makeDetail([version(1), version(2)]);
    render(<Harness live={emptyLive()} />);
    await ready();
    await userEvent.click(screen.getByRole('button', { name: /apri la cronologia/ }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Versioni' })).getByRole('button', { name: /^Versione 1/ }));
    await userEvent.click(screen.getByRole('button', { name: /apri la cronologia/ }));
    const menu = await screen.findByRole('dialog', { name: 'Versioni' });
    expect(within(menu).getByText('La prossima modifica parte dalla v1. Le versioni successive restano nella cronologia.')).toBeTruthy();
    await userEvent.click(within(menu).getByRole('button', { name: 'Mostra nel Finder' }));
    expect(api.revealVersion).toHaveBeenCalledWith('acme', 'lancio', 1);
    await userEvent.click(screen.getByRole('button', { name: /apri la cronologia/ }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Versioni' })).getByRole('button', { name: 'Riparti da qui' }));
    expect(api.restoreVersion).toHaveBeenCalledWith('acme', 'lancio', 1);
  });

  it('Compare opens the slider between two versions', async () => {
    detail = makeDetail([version(1), version(2)]);
    render(<Harness live={emptyLive()} />);
    await ready();
    await userEvent.click(screen.getByRole('button', { name: /apri la cronologia/ }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Versioni' })).getByRole('button', { name: 'Confronta' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confronta le versioni' });
    const slider = within(dialog).getByRole('slider', { name: 'Posizione del divisore' });
    expect(slider.getAttribute('aria-valuenow')).toBe('50');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider.getAttribute('aria-valuenow')).toBe('55');
    // Previous version on the left, the shown one on the right.
    expect(within(dialog).getByRole('img', { name: /v1$/ }).getAttribute('src')).toBe('/f/acme/lancio/outputs/v1/post.png');
    expect(within(dialog).getByRole('img', { name: /v2$/ }).getAttribute('src')).toBe('/f/acme/lancio/outputs/v2/post.png');
  });
});

describe('CreativeCanvas · export', () => {
  it('exports only the chosen formats, remembers the folder and offers Show in Finder', async () => {
    const revealPath = vi.fn(async () => {});
    (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => '/Users/me/Consegna', revealPath };
    render(<Harness live={emptyLive()} />);
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Esporta' }));
    const dialog = await screen.findByRole('dialog', { name: 'Esporta “Lancio estivo”' });
    // One row per format with its final name.
    expect(within(dialog).getByText('lancio-estivo-instagram-post-1x1-v1.png')).toBeTruthy();
    expect(within(dialog).getByText('lancio-estivo-tiktok-9x16-v1.mp4')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /^Esporta TikTok/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scegli…' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Esporta 1 file' }));
    await waitFor(() => expect(api.exportVersion).toHaveBeenCalledOnce());
    expect(api.exportVersion).toHaveBeenCalledWith('acme', 'lancio', 1, '/Users/me/Consegna', ['instagram-post-1x1']);
    expect(await within(dialog).findByText('1 file esportato')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mostra nel Finder' }));
    expect(revealPath).toHaveBeenCalledWith('/Users/me/Consegna');
    // No second export from the success screen.
    expect(within(dialog).queryByRole('button', { name: /^Esporta \d/ })).toBeNull();
    expect(localStorage.getItem('ms.exportFolder')).toBe('/Users/me/Consegna');
  });

  it('on the web takes a typed folder, shows errors in place and keeps the folder for next time', async () => {
    localStorage.setItem('ms.exportFolder', '/Users/me/Ultima');
    api.exportVersion.mockRejectedValueOnce(new Error('Cartella non scrivibile'));
    render(<Harness live={emptyLive()} />);
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Esporta' }));
    const dialog = await screen.findByRole('dialog', { name: 'Esporta “Lancio estivo”' });
    const folder = within(dialog).getByLabelText('Cartella di destinazione') as HTMLInputElement;
    expect(folder.value).toBe('/Users/me/Ultima');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Esporta 2 file' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Cartella non scrivibile');
    expect(api.exportVersion).toHaveBeenCalledWith('acme', 'lancio', 1, '/Users/me/Ultima', ['instagram-post-1x1', 'tiktok-9x16']);
    // No bridge: no Finder button anywhere.
    expect(within(dialog).queryByRole('button', { name: 'Scegli…' })).toBeNull();
  });
});

describe('CreativeCanvas · bar and states', () => {
  it('renames the creative from the bar with F2', async () => {
    render(<Harness live={emptyLive()} />);
    await ready();
    expect(screen.getByRole('button', { name: 'Rinomina “Lancio estivo” (F2)' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'F2' });
    const field = screen.getByLabelText('Titolo della creatività') as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    await userEvent.clear(field);
    await userEvent.type(field, 'Estate 2026{Enter}');
    expect(api.updateCreative).toHaveBeenCalledWith('acme', 'lancio', { title: 'Estate 2026' });
  });

  it('opens the editor of a board on double click, keeping its rect for the shared-element transition', async () => {
    render(<Harness live={emptyLive()} />);
    await ready();
    const frame = screen.getByRole('img', { name: /Post 1:1 v1/ }).closest('[data-frame]')!;
    fireEvent.doubleClick(frame);
    expect(location.hash).toBe('#/p/acme/c/lancio/f/instagram-post-1x1');
    expect(takeFrameOrigin('format:acme/lancio/instagram-post-1x1')).not.toBeNull();
    // Taken once.
    expect(takeFrameOrigin('format:acme/lancio/instagram-post-1x1')).toBeNull();
  });

  it('without a version shows the boards waiting and offers Generate', async () => {
    detail = makeDetail([]);
    render(<Harness live={emptyLive()} />);
    expect(await screen.findByText('Ancora niente di generato')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Esporta' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getAllByRole('button', { name: 'Genera' })[0]!);
    expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'lancio', {});
  });

  it('explains a load failure with Try again', async () => {
    api.getCreative.mockRejectedValueOnce(new Error('rete assente'));
    render(<Harness live={emptyLive()} />);
    expect((await screen.findByRole('alert')).textContent).toContain('rete assente');
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(await ready()).toBeTruthy();
  });

  it('shows the safe zones with a legend', async () => {
    detail = makeDetail([version(1)]);
    render(<Harness live={emptyLive()} />);
    await ready();
    await userEvent.click(screen.getByRole('switch', { name: 'Zone sicure' }));
    expect(screen.getByText('Le aree ombreggiate sono coperte dall’interfaccia del canale. Tieni fuori testi e loghi.')).toBeTruthy();
    // TikTok 9:16 has a safe zone in the catalog: its bands carry their labels.
    expect(screen.getAllByText('Didascalia e pulsanti').length).toBeGreaterThan(0);
  });
});

describe('CreativeCanvas · ported checks', () => {
  it('shows an alert, not unknown presets, when the catalog fails to load', async () => {
    api.getFormats.mockRejectedValueOnce(new Error('catalogo irraggiungibile'));
    render(<Harness live={emptyLive()} />);
    expect((await screen.findByRole('alert')).textContent).toContain('catalogo irraggiungibile');
    expect(screen.queryByText(/preset sconosciuto/)).toBeNull();
  });

  it('shows the catalog fallback error as a note, and marks missing and unverified outputs', async () => {
    api.getFormats.mockResolvedValueOnce({ presets: DEFAULT_FORMATS, error: 'catalogo non valido', path: '/x' });
    detail = makeDetail([version(1, '', [{ ...out('instagram-post-1x1', 'post.png'), verified: false }])]);
    render(<Harness live={emptyLive()} />);
    expect(await screen.findByText('catalogo non valido')).toBeTruthy();
    expect(screen.getByText('Mancante in v1')).toBeTruthy();
    expect(screen.getByText('non verificato')).toBeTruthy();
  });

  it('follows new versions again after the user sends a message', async () => {
    detail = makeDetail([version(1), version(2)]);
    const { rerender } = render(<Harness live={emptyLive()} />);
    await ready();
    await userEvent.click(screen.getByRole('button', { name: /apri la cronologia/ }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Versioni' })).getByRole('button', { name: /^Versione 1/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Versione 1 di 2, apri la cronologia' })).toBeTruthy());
    await userEvent.type(screen.getByLabelText('Chiedi una modifica'), 'Più luce');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    detail = makeDetail([version(1), version(2), version(3)]);
    await act(async () => { rerender(<Harness live={{ ...emptyLive(), creativeTicks: { 'acme/lancio': 5 } } as unknown as EventsState} />); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Versione 3 di 3, apri la cronologia' })).toBeTruthy());
  });

  it('keeps the export on the version it was opened for when a new version arrives', async () => {
    localStorage.setItem('ms.exportFolder', '/d');
    const { rerender } = render(<Harness live={emptyLive()} />);
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Esporta' }));
    const dialog = await screen.findByRole('dialog', { name: 'Esporta “Lancio estivo”' });
    detail = makeDetail([version(1), version(2)]);
    await act(async () => { rerender(<Harness live={{ ...emptyLive(), creativeTicks: { 'acme/lancio': 1 } } as unknown as EventsState} />); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Versione 2 di 2, apri la cronologia' })).toBeTruthy());
    expect(within(dialog).getByText('La versione 1 di ogni formato, pronta da pubblicare.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Esporta 2 file' }));
    await waitFor(() => expect(api.exportVersion).toHaveBeenCalledWith('acme', 'lancio', 1, '/d', ['instagram-post-1x1', 'tiktok-9x16']));
  });

  it('ignores canvas shortcuts from a page that is leaving', async () => {
    const { container } = render(<div className="ms-page"><Harness live={emptyLive()} /></div>);
    await ready();
    // No data-page-active: PageHost keeps this page mounted only for its exit.
    fireEvent.keyDown(window, { key: 'c' });
    fireEvent.keyDown(window, { key: 'F2' });
    expect(screen.getByRole('button', { name: 'Seleziona (V)' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByLabelText('Titolo della creatività')).toBeNull();
    container.querySelector('.ms-page')!.setAttribute('data-page-active', '');
    fireEvent.keyDown(window, { key: 'c' });
    expect(screen.getByRole('button', { name: 'Commenta (C)' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('CreativeCanvas · review round 1', () => {
  const pinOnPost = async (text: string) => {
    await userEvent.click(screen.getByRole('button', { name: 'Commenta (C)' }));
    fireEvent.click(screen.getByRole('button', { name: /^Commenta Instagram · Post 1:1/ }));
    await userEvent.type(await screen.findByLabelText('Testo del commento'), text);
    await userEvent.click(screen.getByRole('button', { name: 'Commenta' }));
  };
  const pickVersion = async (n: number) => {
    await userEvent.click(screen.getByRole('button', { name: /apri la cronologia/ }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Versioni' })).getByRole('button', { name: new RegExp(`^Versione ${n}`) }));
  };

  it('comments only on the core pin source (the latest): another version disables C and hides its pins', async () => {
    detail = makeDetail([version(1), version(2)]);
    render(<Harness live={emptyLive()} />);
    await ready();
    await pinOnPost('Più contrasto');
    expect(screen.getByRole('button', { name: 'Modifica il commento 1' })).toBeTruthy();
    await pickVersion(1);
    await waitFor(() => expect(screen.getByRole('img', { name: /Post 1:1 v1/ })).toBeTruthy());
    const tool = screen.getByRole('button', { name: 'Commenta (C)' }) as HTMLButtonElement;
    expect(tool.disabled).toBe(true);
    expect(screen.getByText('I commenti valgono per la v2: usa Riparti da qui per commentare questa versione.')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'c' });
    expect(tool.getAttribute('aria-pressed')).toBe('false');
    // The v2 pin is not drawn on v1's boards, but it is still pending for v2 (its chip stays).
    expect(screen.queryByRole('button', { name: 'Modifica il commento 1' })).toBeNull();
    expect(screen.getByRole('button', { name: /^Modifica il commento 1 ·/ })).toBeTruthy();
  });

  it('with a resume point, comments go on that version and not on the latest', async () => {
    detail = makeDetail([version(1), version(2)], { resumeFrom: { version: 1, sessionId: 's' } });
    render(<Harness live={emptyLive()} />);
    await ready();
    // The latest (v2) is on screen: not the pin source.
    expect((screen.getByRole('button', { name: 'Commenta (C)' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('I commenti valgono per la v1: usa Riparti da qui per commentare questa versione.')).toBeTruthy();
    await pickVersion(1);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Commenta (C)' }) as HTMLButtonElement).disabled).toBe(false));
    await pinOnPost('Tieni questo');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'lancio', { text: '', pins: [expect.objectContaining({ note: 'Tieni questo', format: 'instagram-post-1x1' })] }));
  });

  it('a failed send keeps the pins', async () => {
    api.sendCreativeTurn.mockRejectedValueOnce(new Error('rete'));
    render(<Harness live={emptyLive()} />);
    await ready();
    await pinOnPost('Logo');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Impossibile inviare|Non è stato possibile|riprova/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Modifica il commento 1 ·/ })).toBeTruthy();
  });

  it('a pin added while the send is in flight stays pending', async () => {
    let finish!: () => void;
    api.sendCreativeTurn.mockImplementationOnce(() => new Promise((r) => { finish = () => r({ id: 'j9', key: 'k', kind: 'creative', label: 'x', state: 'queued', createdAt: at }); }));
    render(<Harness live={emptyLive()} />);
    await ready();
    await pinOnPost('Primo');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await pinOnPost('Secondo');
    await act(async () => { finish(); });
    await waitFor(() => expect(screen.queryByText('Primo')).toBeNull());
    expect(screen.getByRole('button', { name: /^Modifica il commento 1 ·/ }).textContent).toContain('Secondo');
  });

  it('double click opens the editor only with the Select tool', async () => {
    render(<Harness live={emptyLive()} />);
    await ready();
    fireEvent.keyDown(window, { key: 'h' });
    fireEvent.doubleClick(screen.getByRole('img', { name: /Post 1:1 v1/ }).closest('[data-frame]')!);
    expect(location.hash).toBe('#/p/acme/c/lancio');
  });

  it('a click on the canvas keeps a bubble with text, and closes an empty one', async () => {
    render(<Harness live={emptyLive()} />);
    await ready();
    fireEvent.keyDown(window, { key: 'c' });
    fireEvent.click(screen.getByRole('button', { name: /^Commenta Instagram · Post 1:1/ }));
    await screen.findByLabelText('Testo del commento');
    const viewport = document.querySelector('.ms-cv-viewport')!;
    fireEvent.click(viewport);
    expect(screen.queryByLabelText('Testo del commento')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Commenta Instagram · Post 1:1/ }));
    await userEvent.type(await screen.findByLabelText('Testo del commento'), 'Non perdermi');
    fireEvent.click(viewport);
    expect((screen.getByLabelText('Testo del commento') as HTMLTextAreaElement).value).toBe('Non perdermi');
  });

  it('cannot close the export while it runs', async () => {
    localStorage.setItem('ms.exportFolder', '/d');
    let finish!: () => void;
    api.exportVersion.mockImplementationOnce((_s, _c, _n, d) => new Promise((r) => { finish = () => r({ destination: d, files: [{ from: 'a', to: 'b' }], skipped: [] }); }));
    render(<Harness live={emptyLive()} />);
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Esporta' }));
    const dialog = await screen.findByRole('dialog', { name: 'Esporta “Lancio estivo”' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Esporta 2 file' }));
    expect((within(dialog).getByRole('button', { name: 'Annulla' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole('button', { name: 'Chiudi' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.keyboard('{Escape}');
    fireEvent.click(document.querySelector('.ms-scrim')!);
    expect(screen.getByRole('dialog', { name: 'Esporta “Lancio estivo”' })).toBe(dialog);
    await act(async () => { finish(); });
    expect(await within(dialog).findByText('1 file esportato')).toBeTruthy();
    // Done: closing works again.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Esporta “Lancio estivo”' })).toBeNull());
  });

  it('Restart from here: Undo only when there was a resume point, restoring exactly that version', async () => {
    const { __resetToasts, getToasts } = await import('../src/ui/toast.tsx');
    const restart = async (pick: number) => {
      await pickVersion(pick);
      await userEvent.click(screen.getByRole('button', { name: /apri la cronologia/ }));
      await userEvent.click(within(await screen.findByRole('dialog', { name: 'Versioni' })).getByRole('button', { name: 'Riparti da qui' }));
      await waitFor(() => expect(getToasts().some((x) => x.text === `Le prossime modifiche partono dalla v${pick}`)).toBe(true));
      return getToasts().find((x) => x.text === `Le prossime modifiche partono dalla v${pick}`)!;
    };
    // No resume point before: no exact undo exists, so no Undo.
    __resetToasts();
    detail = makeDetail([version(1), version(2)]);
    const first = render(<Harness live={emptyLive()} />);
    await ready();
    expect((await restart(1)).action).toBeUndefined();
    first.unmount();
    // With a resume point (v2 of 3), Undo restores exactly v2.
    __resetToasts();
    detail = makeDetail([version(1), version(2), version(3)], { resumeFrom: { version: 2, sessionId: 's' } });
    render(<Harness live={emptyLive()} />);
    await ready();
    const item = await restart(1);
    expect(item.action?.label).toBe('Annulla');
    act(() => item.action!.run());
    await waitFor(() => expect(api.restoreVersion).toHaveBeenLastCalledWith('acme', 'lancio', 2));
    __resetToasts();
  });

  it('while a resume point is set, the latest version offers Restart from here as the way back', async () => {
    detail = makeDetail([version(1), version(2)], { resumeFrom: { version: 1, sessionId: 's' } });
    render(<Harness live={emptyLive()} />);
    await ready();
    // v2 (the latest) is on screen.
    await userEvent.click(screen.getByRole('button', { name: 'Versione 2 di 2, apri la cronologia' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Versioni' })).getByRole('button', { name: 'Riparti da qui' }));
    expect(api.restoreVersion).toHaveBeenCalledWith('acme', 'lancio', 2);
    // On the resume version itself there is nothing to restart.
    await pickVersion(1);
    await userEvent.click(screen.getByRole('button', { name: /apri la cronologia/ }));
    expect(within(await screen.findByRole('dialog', { name: 'Versioni' })).queryByRole('button', { name: 'Riparti da qui' })).toBeNull();
  });

  it('edits the brief with ui controls: length segments, format chips, same save semantics', async () => {
    render(<Harness live={emptyLive()} />);
    await ready();
    await userEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    await userEvent.click(screen.getByRole('button', { name: 'Modifica il brief' }));
    const form = document.querySelector('.ms-brief-form') as HTMLElement;
    // No native select, checkbox or number field.
    expect(form.querySelector('select, input[type="checkbox"], input[type="number"]')).toBeNull();
    await userEvent.click(within(form).getByRole('radio', { name: '15 s' }));
    await userEvent.click(within(within(form).getByRole('group', { name: 'YouTube' })).getByRole('button', { name: /Shorts/ }));
    await userEvent.click(within(form).getByRole('button', { name: 'Salva e rigenera' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'lancio', {}));
    expect(api.updateCreative).toHaveBeenCalledWith('acme', 'lancio', expect.objectContaining({
      title: 'Lancio estivo',
      brief: expect.objectContaining({ durationSec: 15, formats: ['instagram-post-1x1', 'tiktok-9x16', 'youtube-shorts-9x16'] }),
    }));
  });
});


describe('CreativeCanvas · tokens (Phase 8)', () => {
  const used = { tokens: { input: 30_000, output: 8_000, cacheRead: 900_000, cacheWrite: 400 }, costUsd: 0.42 };
  const withUsage = (v: VersionEntry, usage = used): VersionEntry => ({ ...v, usage });

  it('the version card shows tokens and cost with a breakdown and the billing note; a version without usage shows none', async () => {
    detail = makeDetail([version(1, 'Dal brief'), withUsage(version(2, 'Più caldo'))]);
    conversation = [
      { type: 'version', at, n: 1, status: 'complete' },
      { type: 'user', at, text: 'Più caldo', pins: [], attachments: [] },
      { type: 'version', at, n: 2, status: 'complete' },
    ];
    const live = { ...emptyLive(), today: { day: '2026-10-09', tokens: 0, billing: 'subscription', jobs: {} } } as unknown as EventsState;
    render(<Harness live={live} />);
    await ready();
    const cards = await waitFor(() => { const c = [...document.querySelectorAll('.ms-convo-version')]; expect(c).toHaveLength(2); return c as HTMLElement[]; });
    expect(cards[0]!.textContent).not.toMatch(/token/);
    const badge = within(cards[1]!).getByRole('button', { name: /^38,4k token · 0,42/ });
    await userEvent.click(badge);
    const pop = await screen.findByRole('dialog', { name: 'Dettaglio dei token' });
    expect(within(pop).getByText('30.000')).toBeTruthy();
    expect(within(pop).getByText('900.000')).toBeTruthy(); // cache reads only here
    expect(pop.textContent).toContain('Rientra nel tuo piano Claude');
  });

  const ledger = (tokens: Partial<UsageReport['total']['tokens']>, costUsd: number | null, estimated?: boolean): UsageReport => ({
    from: at, to: at, total: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...tokens }, costUsd, ...(estimated ? { estimated } : {}) },
    byDay: [], byProject: [], byKind: [], trackedSince: at, billing: 'subscription', utcOffsetMinutes: 0,
  });

  it('the Brief panel shows the ledger total of the creative (failed and cancelled runs included), asked for this creative only', async () => {
    detail = makeDetail([withUsage(version(1, 'Dal brief')), withUsage(version(2))]);
    // The versions sum to 76.8k; the ledger also has a failed run.
    api.getUsage.mockResolvedValue(ledger({ input: 100_000, output: 20_000, cacheWrite: 30_000, cacheRead: 999_999 }, 0.5));
    render(<Harness live={emptyLive()} />);
    await ready();
    await userEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    const value = (await screen.findByText('150,0k token', { exact: false })).closest('.ms-cv-brief-row')!;
    expect(value.textContent).toContain('150,0k token · 0,50');
    expect(value.textContent).not.toContain('≥');
    expect(value.textContent).not.toContain('non sono incluse');
    expect(api.getUsage).toHaveBeenCalledWith({ project: 'acme', creative: 'lancio' });
  });

  it('versions made before tracking, or a partial ledger, make the total a lower bound (≥)', async () => {
    detail = makeDetail([version(1, 'Dal brief'), withUsage(version(2))]);
    api.getUsage.mockResolvedValue(ledger({ input: 50_000 }, 0.2));
    render(<Harness live={emptyLive()} />);
    await ready();
    await userEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    const value = (await screen.findByText(/≥ 50,0k token/)).closest('.ms-cv-brief-row')!;
    expect(value.textContent).toContain('non sono incluse');
  });

  it('when the ledger cannot be read: the versions\' sum as a lower bound; older versions are said not to be counted', async () => {
    detail = makeDetail([version(1, 'Dal brief'), withUsage(version(2)), withUsage(version(3), { ...used, costUsd: null } as never)]);
    render(<Harness live={emptyLive()} />);
    await ready();
    await userEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    const value = (await screen.findByText('Token')).closest('.ms-cv-brief-row')!;
    expect(value.textContent).toContain('≥ 76,8k token · ≥');
    expect(value.textContent).toContain('non sono incluse');
  });

  it('a ledger with nothing for the creative and no version usage: no total row (no invented 0)', async () => {
    api.getUsage.mockResolvedValue(ledger({}, null));
    render(<Harness live={emptyLive()} />);
    await ready();
    await userEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    await waitFor(() => expect(api.getUsage).toHaveBeenCalled());
    expect(screen.queryByText('Token')).toBeNull();
  });

  it('no version with usage: no total row', async () => {
    render(<Harness live={emptyLive()} />);
    await ready();
    await userEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    expect(screen.queryByText('Token')).toBeNull();
  });

  it('a live counter sits beside the status pill while the job runs, and nothing before its first usage event', async () => {
    const job = { id: 'j1', key: 'creative:/w:acme:lancio', kind: 'creative', label: 'x', state: 'running', createdAt: at };
    const base = { ...emptyLive(), jobs: { j1: job } } as unknown as EventsState;
    const { rerender } = render(<Harness live={base} />);
    await ready();
    const bar = document.querySelector('.ms-topbar')!;
    expect(bar.querySelector('.ms-cv-tokens')).toBeNull();
    await act(async () => { rerender(<Harness live={{ ...base, jobUsage: { j1: { done: 1000, runs: 1, peak: 1500 } } } as unknown as EventsState} />); });
    expect(bar.querySelector('.ms-cv-tokens')?.textContent).toBe('1,5k token finora'); // "finora" is screen-reader text
  });
});

describe('CreativeCanvas · large-file warnings (Phase 8)', () => {
  const heavy = (): OutputFileInfo => ({ ...out('tiktok-9x16', 'tiktok.mp4', '.previews/tiktok.mp4.jpg'), warnings: [{ key: 'outputs.largeFile', params: { sizeMB: 78.4, mbps: 24, targetMbps: 8, channel: 'TikTok' } }] });
  const full = 'File pesante: 78.4 MB a 24 Mbps (circa 8 Mbps bastano per TikTok)';

  it('the board shows a warning chip whose popover gives the recommendation as text; the version card says it too', async () => {
    detail = makeDetail([version(1, 'Dal brief', [out('instagram-post-1x1', 'post.png'), heavy()])]);
    conversation = [{ type: 'version', at, n: 1, status: 'complete' }];
    render(<Harness live={emptyLive()} />);
    await ready();
    const board = document.querySelector<HTMLElement>('[data-board="tiktok-9x16"]')!;
    const chip = within(board).getByRole('button', { name: 'File pesante, 78 MB: mostra il consiglio' });
    expect(chip.textContent).toBe('78 MB · pesante');
    expect(within(document.querySelector<HTMLElement>('[data-board="instagram-post-1x1"]')!).queryByText(/pesante/)).toBeNull();
    await userEvent.click(chip);
    const pop = await screen.findByRole('dialog', { name: 'File pesante' });
    // The title says "File pesante" once; the text below gives the figures without repeating it.
    expect(pop.textContent).toContain('78,4 MB a 24 Mbps. Circa 8 Mbps bastano per TikTok.');
    expect(pop.textContent!.match(/File pesante/g)).toHaveLength(1);
    const card = await waitFor(() => { const c = document.querySelector<HTMLElement>('.ms-convo-version'); expect(c).toBeTruthy(); return c!; });
    expect(card.textContent).toContain(full);
  });

  it('renders the parameters as text, never as markup', async () => {
    const evil = { ...heavy(), warnings: [{ key: 'outputs.largeFile', params: { sizeMB: 78.4, mbps: 24, targetMbps: 8, channel: '<img src=x onerror=alert(1)>' } }] };
    detail = makeDetail([version(1, 'Dal brief', [evil])]);
    conversation = [{ type: 'version', at, n: 1, status: 'complete' }];
    render(<Harness live={emptyLive()} />);
    const card = await waitFor(() => { const c = document.querySelector<HTMLElement>('.ms-convo-version'); expect(c?.textContent).toContain('<img src=x'); return c!; });
    expect(card.querySelector('img')).toBeNull();
  });

  it('a version without warnings shows no chip and no line', async () => {
    conversation = [{ type: 'version', at, n: 1, status: 'complete' }];
    render(<Harness live={emptyLive()} />);
    await ready();
    expect(screen.queryByText(/pesante/)).toBeNull();
  });
});
