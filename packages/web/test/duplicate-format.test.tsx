import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type CreativeDetail, type VersionEntry } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Route } from '../src/routes.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';

vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });

const at = '2026-10-08T10:00:00.000Z';
const VIDEO = 'tiktok-9x16';
const version = (n: number, withComposition = true): VersionEntry => ({
  n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: '', problems: [], tools: [], renderCommand: null, basedOn: null,
  outputs: [{ format: VIDEO, file: 'tiktok.mp4', width: 1080, height: 1920, durationSec: 8, verified: true, preview: null }],
  ...(withComposition ? { compositions: [{ format: VIDEO, dir: `compositions/${VIDEO}`, hash: String(n).repeat(64) }] } : {}),
});
const makeDetail = (versions: VersionEntry[], formats = [VIDEO], labels?: Record<string, string>): CreativeDetail => ({
  slug: 'lancio', jobKey: 'creative:/w:acme:lancio', versions,
  creative: {
    schemaVersion: 1, title: 'Lancio', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'g', message: 'm', formats, ...(labels ? { formatLabels: labels } : {}), durationSec: 8, assets: [], notes: '' },
  },
});
let detail = makeDetail([version(1), version(2)]);
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async () => detail),
  getConversation: vi.fn(async () => []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  duplicateFormat: vi.fn(async (_s: string, _c: string, _n: number, body: { instanceId: string }) => ({ version: version(3), instanceId: `${body.instanceId}@2` })),
  revokePreview: vi.fn(async () => ({ revoked: true })),
  previewSession: vi.fn(async (_s: string, _c: string, n: number, format: string) => ({
    url: `http://127.0.0.1:61234/tok-${format}-v${n}/runtime/index.html?mode=preview&parentOrigin=x`, token: `tok-${format}-v${n}`, origin: 'http://127.0.0.1:61234',
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), format, hash: 'b'.repeat(64), width: 1080, height: 1920, duration: 8, fps: 30,
  })),
  getStoryboard: vi.fn(async () => ({ format: VIDEO, hash: 'b'.repeat(64), width: 270, expiresAt: new Date(Date.now() + 600_000).toISOString(), frames: [] })),
  getEditorComposition: vi.fn(async () => { throw new Error('none'); }),
};
class ApiError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { FormatView } = await import('../src/screens/FormatView.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { __resetPreviewSessions } = await import('../src/components/compositionPreview.ts');
const { __resetPendingPins } = await import('../src/screens/pendingPins.ts');
const { I18nProvider } = await import('../src/i18n.tsx');

let jobsNow: Record<string, unknown> = {};
const live = (): EventsState => ({ approvals: {}, jobs: jobsNow, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState);
function Harness({ format }: { format: string }) {
  const route: Route = { name: 'format', slug: 'acme', creative: 'lancio', format };
  const shell = {
    route, live: live(), catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as unknown as Shell;
  return (
    <I18nProvider locale="en">
      <ShellContext.Provider value={shell}>
        <header className="ms-topbar"><TopBar /></header>
        <FormatView slug="acme" creative="lancio" format={format} live={live()} />
      </ShellContext.Provider>
    </I18nProvider>
  );
}

beforeEach(() => {
  __resetPreviewSessions();
  __resetPendingPins();
  vi.clearAllMocks();
  jobsNow = {};
  detail = makeDetail([version(1), version(2)]);
  location.hash = `#/p/acme/c/lancio/f/${VIDEO}`;
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { value: vi.fn(), configurable: true, writable: true });
});

describe('Duplicate format', () => {
  /** User report 17: the bar's "…" menu holds Duplicate format. */
  const duplicateItem = async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    return screen.findByRole('menuitem', { name: 'Duplicate format' });
  };
  it('copies the format of the version on screen and opens the new instance', async () => {
    render(<Harness format={VIDEO} />);
    await userEvent.click(await duplicateItem());
    await waitFor(() => expect(api.duplicateFormat).toHaveBeenCalledOnce());
    // The ★ of a format with no manual pick is its latest version.
    expect(api.duplicateFormat).toHaveBeenCalledWith('acme', 'lancio', 2, { instanceId: VIDEO });
    await waitFor(() => expect(location.hash).toBe(`#/p/acme/c/lancio/f/${VIDEO}@2`));
  });

  it('shows the refusal of the core and stays on the format', async () => {
    api.duplicateFormat.mockRejectedValueOnce(new ApiError(409, 'A generation is running', 'duplicate-busy'));
    render(<Harness format={VIDEO} />);
    await userEvent.click(await duplicateItem());
    expect((await screen.findByText("Couldn't duplicate the format: A generation is running"))).toBeTruthy();
    expect(location.hash).toBe(`#/p/acme/c/lancio/f/${VIDEO}`);
  });

  it('is not offered for a legacy version (no composition)', async () => {
    detail = makeDetail([version(1, false)]);
    const { unmount } = render(<Harness format={VIDEO} />);
    await screen.findByRole('main');
    await waitFor(() => expect(api.getCreative).toHaveBeenCalled());
    // User report 17: Duplicate format lives in the bar's "…" menu.
    await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    await screen.findByRole('menu', { name: 'More actions' });
    expect(screen.queryByRole('menuitem', { name: 'Duplicate format' })).toBeNull();
    unmount();
  });

  it('an instance shows its label in the bar and duplicates by its own id (encoded in the new hash only by the core id)', async () => {
    detail = makeDetail([version(1)], [VIDEO, `${VIDEO}@2`], { [`${VIDEO}@2`]: 'Summer promo' });
    detail.versions[0]!.compositions!.push({ format: `${VIDEO}@2`, dir: `compositions/${VIDEO}@2`, hash: 'c'.repeat(64) });
    detail.versions[0]!.outputs.push({ format: `${VIDEO}@2`, file: 'tiktok@2.mp4', width: 1080, height: 1920, durationSec: 8, verified: true, preview: null });
    location.hash = `#/p/acme/c/lancio/f/${VIDEO}@2`;
    render(<Harness format={`${VIDEO}@2`} />);
    expect(await screen.findByText('Summer promo', { selector: 'b[aria-current="page"]' })).toBeTruthy();
    await userEvent.click(await duplicateItem());
    await waitFor(() => expect(api.duplicateFormat).toHaveBeenCalledWith('acme', 'lancio', 1, { instanceId: `${VIDEO}@2` }));
  });
});
