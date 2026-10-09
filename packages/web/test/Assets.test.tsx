import type { AssetEntry, JobSummary } from '@motion-studio/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';
import { __resetToasts, getToasts } from '../src/ui/toast.tsx';

const at = '2026-10-07T10:00:00.000Z';
const asset = (over: Partial<AssetEntry> & { file: string }): AssetEntry => ({
  kind: 'image', origin: 'upload', sourceUrl: null, description: '', tags: [], width: null, height: null, addedAt: at, attribution: null, ...over,
});
let listing: { assets: AssetEntry[]; error: string | null; unregistered: string[] };
const api = {
  listAssets: vi.fn(async () => structuredClone(listing)),
  getBrand: vi.fn(async () => ({ jobKey: 'brand:k' })),
  getProject: vi.fn(async () => ({ slug: 'acme', jobKey: 'k', project: { name: 'Acme Studio' } })),
  uploadFiles: vi.fn(async (): Promise<unknown> => ({ assets: [] })),
  registerAssets: vi.fn(async () => ({ assets: [] })),
  describeAssets: vi.fn(async (): Promise<unknown> => ({ id: 'j-desc' })),
  updateAsset: vi.fn(async (_s: string, file: string, patch: Partial<AssetEntry>) => {
    const a = listing.assets.find((x) => x.file === file)!;
    Object.assign(a, patch);
    return structuredClone(a);
  }),
  deleteAsset: vi.fn(async () => ({ ok: true })),
  projectFileUrl: (s: string, r: string) => `/f/${s}/${r}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { Assets } = await import('../src/screens/Assets.tsx');
const { UNDO_MS } = await import('../src/screens/common.tsx');
const { __resetDeferred } = await import('../src/screens/deferred.ts');
const { useNewCreativeAssetsIntent } = await import('../src/shell/intents.ts');

const live = (over: Partial<EventsState> = {}): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {}, ...over });
const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);
const card = (name: string) => screen.queryByRole('button', { name: `Open ${name}` });
const job = (over: Partial<JobSummary> = {}): JobSummary => ({ id: 'j-desc', key: 'brand:k', kind: 'asset-description', label: 'Describe', state: 'running', createdAt: at, ...over });

beforeEach(() => {
  __resetToasts();
  history.replaceState(null, '', '/#/p/acme/assets');
  listing = {
    error: null, unregistered: [],
    assets: [
      asset({ file: 'brand/logo.svg', kind: 'svg', origin: 'website', sourceUrl: 'https://acme.example/logo.svg', description: 'Wordmark for dark backgrounds', tags: ['logo', 'white'] }),
      asset({ file: 'night.jpg', origin: 'upload', description: 'Rainy street at night', tags: ['city', 'night', 'rain'], width: 1920, height: 1080 }),
      asset({ file: 'intro.mp4', kind: 'video', origin: 'generated', description: '', tags: [] }),
    ],
  };
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); __resetToasts(); __resetDeferred(); });

describe('Assets · library', () => {
  it('shows descriptions and tags on the cards (point 17), with the file name, not the folder path, as the title', async () => {
    en(<Assets slug="acme" live={live()} />);
    expect(await screen.findByText('Wordmark for dark backgrounds')).toBeTruthy();
    expect(card('logo.svg')).toBeTruthy();
    const night = card('night.jpg')!.closest('.ms-acard') as HTMLElement;
    expect(within(night).getByText('city')).toBeTruthy();
    expect(within(night).getByText('night')).toBeTruthy();
    expect(within(night).getByText('+1')).toBeTruthy();
    expect(within(night).getByText('1920×1080')).toBeTruthy();
    expect(screen.getByText('No description yet')).toBeTruthy();
  });

  it('filters by type, origin, tag and search, and clears the filters', async () => {
    en(<Assets slug="acme" live={live()} />);
    await screen.findByText('Wordmark for dark backgrounds');
    const filters = screen.getByRole('navigation', { name: 'Asset filters' });
    await userEvent.click(within(filters).getByRole('button', { name: /^Video/ }));
    expect(card('intro.mp4')).toBeTruthy();
    expect(card('night.jpg')).toBeNull();
    await userEvent.click(within(filters).getByRole('button', { name: /^All/ }));
    await userEvent.click(within(filters).getByRole('button', { name: /^From website/ }));
    expect(card('logo.svg')).toBeTruthy();
    expect(card('night.jpg')).toBeNull();
    await userEvent.click(within(filters).getByRole('button', { name: /^From website/ }));
    await userEvent.click(within(filters).getByRole('button', { name: 'rain' }));
    expect(card('night.jpg')).toBeTruthy();
    expect(card('logo.svg')).toBeNull();
    expect(screen.getByText('1 of 3')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search assets' }), 'WORDMARK');
    expect(card('logo.svg')).toBeTruthy();
    expect(card('night.jpg')).toBeNull();
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search assets' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search assets' }), 'zzz');
    expect(screen.getByText('Nothing matches')).toBeTruthy();
  });

  it('selects several assets and describes them again; the cards show Describing… while the job runs (point 18)', async () => {
    const { rerender } = en(<Assets slug="acme" live={live()} />);
    await screen.findByText('Wordmark for dark backgrounds');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select logo.svg' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select night.jpg' }));
    const bar = screen.getByRole('toolbar', { name: 'Selection' });
    expect(within(bar).getByText('2 selected')).toBeTruthy();
    await userEvent.click(within(bar).getByRole('button', { name: 'Describe again' }));
    expect(api.describeAssets).toHaveBeenCalledWith('acme', ['brand/logo.svg', 'night.jpg']);
    expect(screen.queryByRole('toolbar', { name: 'Selection' })).toBeNull();
    rerender(<I18nProvider locale="en"><Assets slug="acme" live={live({ jobs: { 'j-desc': job() } })} /></I18nProvider>);
    expect(within(card('logo.svg')!.closest('.ms-acard') as HTMLElement).getByText('Describing…')).toBeTruthy();
    expect(within(card('night.jpg')!.closest('.ms-acard') as HTMLElement).getByText('Describing…')).toBeTruthy();
    expect(within(card('intro.mp4')!.closest('.ms-acard') as HTMLElement).queryByText('Describing…')).toBeNull();
    rerender(<I18nProvider locale="en"><Assets slug="acme" live={live({ jobs: { 'j-desc': job({ state: 'succeeded' }) } })} /></I18nProvider>);
    await waitFor(() => expect(screen.queryByText('Describing…')).toBeNull());
  });

  it('describes the assets without a description from the side card', async () => {
    en(<Assets slug="acme" live={live()} />);
    expect(await screen.findByText('1 asset without a description')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Describe it' }));
    expect(api.describeAssets).toHaveBeenCalledWith('acme', ['intro.mp4']);
  });

  it('adds tags to every selected asset', async () => {
    en(<Assets slug="acme" live={live()} />);
    await screen.findByText('Wordmark for dark backgrounds');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select logo.svg' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select intro.mp4' }));
    await userEvent.click(within(screen.getByRole('toolbar', { name: 'Selection' })).getByRole('button', { name: 'Add tags' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Tags to add' }), 'hero, Logo{Enter}');
    await waitFor(() => expect(api.updateAsset).toHaveBeenCalledTimes(2));
    expect(api.updateAsset).toHaveBeenCalledWith('acme', 'brand/logo.svg', { tags: ['logo', 'white', 'hero'] });
    expect(api.updateAsset).toHaveBeenCalledWith('acme', 'intro.mp4', { tags: ['hero', 'Logo'] });
    expect(getToasts().some((x) => x.text === 'Tags added to 2 assets')).toBe(true);
  });

  it('"Use in a creative" opens New creative with the selected assets preselected', async () => {
    const got = vi.fn();
    function Consumer() { useNewCreativeAssetsIntent('acme', got); return null; }
    en(<Assets slug="acme" live={live()} />);
    await screen.findByText('Wordmark for dark backgrounds');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select night.jpg' }));
    await userEvent.click(within(screen.getByRole('toolbar', { name: 'Selection' })).getByRole('button', { name: 'Use in a creative' }));
    expect(location.hash).toBe('#/p/acme/new');
    render(<Consumer />);
    expect(got).toHaveBeenCalledWith(['assets/night.jpg']);
  });

  it('Delete hides the assets with Undo: Undo within 5 s never calls deleteAsset', async () => {
    en(<Assets slug="acme" live={live()} />);
    await screen.findByText('Wordmark for dark backgrounds');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select logo.svg' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select night.jpg' }));
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Selection' })).getByRole('button', { name: 'Delete' }));
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(card('logo.svg')).toBeNull();
    expect(card('night.jpg')).toBeNull();
    const toast = getToasts().find((x) => x.text === '2 assets deleted')!;
    expect(toast.action!.label).toBe('Undo');
    await act(async () => { vi.advanceTimersByTime(UNDO_MS - 1000); });
    await act(async () => { toast.action!.run(); });
    await act(async () => { vi.advanceTimersByTime(UNDO_MS * 2); });
    expect(api.deleteAsset).not.toHaveBeenCalled();
    expect(card('logo.svg')).toBeTruthy();
    expect(card('night.jpg')).toBeTruthy();
  });

  it('Delete without Undo sends deleteAsset once the 5 s are over', async () => {
    en(<Assets slug="acme" live={live()} />);
    await screen.findByText('Wordmark for dark backgrounds');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select night.jpg' }));
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Selection' })).getByRole('button', { name: 'Delete' }));
    await act(async () => {}); // the card leaves (exit), then the Undo time starts
    await act(async () => { vi.advanceTimersByTime(UNDO_MS - 100); });
    expect(api.deleteAsset).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(api.deleteAsset).toHaveBeenCalledWith('acme', 'night.jpg', { keepalive: true });
  });
});

describe('Assets · bulk delete commit', () => {
  afterEach(() => { api.deleteAsset.mockImplementation((async () => ({ ok: true })) as never); });
  const selectAndDelete = async () => {
    await screen.findByText('Wordmark for dark backgrounds');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select logo.svg' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select night.jpg' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select intro.mp4' }));
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Selection' })).getByRole('button', { name: 'Delete' }));
    await act(async () => { vi.advanceTimersByTime(400); });
  };

  it('issues every keepalive delete synchronously on a pagehide flush, before any resolves', async () => {
    api.deleteAsset.mockImplementation(() => new Promise<never>(() => {}));
    en(<Assets slug="acme" live={live()} />);
    await selectAndDelete();
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(api.deleteAsset).toHaveBeenCalledTimes(3);
    expect(api.deleteAsset).toHaveBeenCalledWith('acme', 'intro.mp4', { keepalive: true });
  });

  it('when only some deletes fail, restores only the files that failed', async () => {
    api.deleteAsset.mockImplementation((async (_s: string, f: string) => {
      if (f === 'night.jpg') throw new Error('nope');
      return { ok: true };
    }) as never);
    en(<Assets slug="acme" live={live()} />);
    await selectAndDelete();
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 1000); });
    await act(async () => {});
    expect(api.deleteAsset).toHaveBeenCalledTimes(3);
    expect(card('night.jpg')).toBeTruthy();
    expect(card('logo.svg')).toBeNull();
    expect(card('intro.mp4')).toBeNull();
  });
});

describe('Assets · stages and unreadable files', () => {
  it('puts SVG and transparent formats on a stage that suits them, never on the theme tile', async () => {
    listing.assets.push(asset({ file: 'mark.svg', kind: 'svg', tags: ['logo'] }), asset({ file: 'badge.png', tags: [] }));
    en(<Assets slug="acme" live={live()} />);
    await screen.findByText('Wordmark for dark backgrounds');
    const thumb = (name: string) => card(name)!.closest('.ms-acard')!.querySelector('.ms-athumb')!;
    expect(thumb('mark.svg').classList.contains('ms-stage-light')).toBe(true);
    expect(thumb('logo.svg').classList.contains('ms-stage-dark')).toBe(true); // tagged "white"
    expect(thumb('badge.png').classList.contains('ms-stage-light')).toBe(true);
    expect(thumb('night.jpg').className).not.toMatch(/ms-stage/);
  });

  it('an unreadable image shows the designed "can\'t preview" state', async () => {
    en(<Assets slug="acme" live={live()} />);
    await screen.findByText('Wordmark for dark backgrounds');
    const media = card('night.jpg')!.closest('.ms-acard')!;
    fireEvent.error(media.querySelector('img')!);
    expect(within(media as HTMLElement).getByRole('img', { name: 'Can’t preview this file' })).toBeTruthy();
  });
});

describe('Assets · pending deletes across navigation', () => {
  const deleteNight = async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select night.jpg' }));
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Selection' })).getByRole('button', { name: 'Delete' }));
    await act(async () => {});
    expect(card('night.jpg')).toBeNull();
  };
  const reopen = async (unmount: () => void) => {
    unmount();
    en(<Assets slug="acme" live={live()} />);
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(card('logo.svg')).toBeTruthy();
  };

  it('stays hidden when the screen is left and opened again within the Undo time; Undo brings it back', async () => {
    const view = en(<Assets slug="acme" live={live()} />);
    await screen.findByText('Wordmark for dark backgrounds');
    vi.useFakeTimers();
    await deleteNight();
    await reopen(view.unmount);
    expect(card('night.jpg')).toBeNull();
    await act(async () => { getToasts().find((x) => x.text === 'night.jpg deleted')!.action!.run(); });
    expect(card('night.jpg')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(UNDO_MS * 2); });
    expect(api.deleteAsset).not.toHaveBeenCalled();
  });

  it('does not come back on the reopened screen once the delete goes out', async () => {
    const view = en(<Assets slug="acme" live={live()} />);
    await screen.findByText('Wordmark for dark backgrounds');
    vi.useFakeTimers();
    await deleteNight();
    await reopen(view.unmount);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 500); });
    expect(api.deleteAsset).toHaveBeenCalledWith('acme', 'night.jpg', { keepalive: true });
    expect(card('night.jpg')).toBeNull();
  });

  it('sends the pending delete at once, with keepalive, when the window is closing', async () => {
    en(<Assets slug="acme" live={live()} />);
    await screen.findByText('Wordmark for dark backgrounds');
    vi.useFakeTimers();
    await deleteNight();
    expect(api.deleteAsset).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new Event('beforeunload')); });
    expect(api.deleteAsset).toHaveBeenCalledWith('acme', 'night.jpg', { keepalive: true });
  });
});

describe('Assets · selection and failures', () => {
  it('a filter change clears the selection, so the bar never acts on assets that are not on screen', async () => {
    en(<Assets slug="acme" live={live()} />);
    await screen.findByText('Wordmark for dark backgrounds');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select logo.svg' }));
    expect(screen.getByRole('toolbar', { name: 'Selection' })).toBeTruthy();
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Asset filters' })).getByRole('button', { name: /^Video/ }));
    expect(screen.queryByRole('toolbar', { name: 'Selection' })).toBeNull();
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Asset filters' })).getByRole('button', { name: /^All/ }));
    expect((screen.getByRole('checkbox', { name: 'Select logo.svg' }) as HTMLElement).getAttribute('aria-checked')).toBe('false');
  });

  it('a failed delete brings the assets back and explains why', async () => {
    api.deleteAsset.mockRejectedValueOnce(new Error('disk full'));
    en(<Assets slug="acme" live={live()} />);
    await screen.findByText('Wordmark for dark backgrounds');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select night.jpg' }));
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Selection' })).getByRole('button', { name: 'Delete' }));
    await act(async () => {});
    expect(card('night.jpg')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 500); });
    expect(api.deleteAsset).toHaveBeenCalledWith('acme', 'night.jpg', { keepalive: true });
    expect(card('night.jpg')).toBeTruthy();
    expect(getToasts().some((x) => x.text === 'Not deleted: disk full')).toBe(true);
  });
});

describe('Assets · detail', () => {
  it('saves tags as chips: Enter adds one, × removes one', async () => {
    en(<Assets slug="acme" live={live()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open logo.svg' }));
    const panel = screen.getByRole('complementary', { name: 'Asset details' });
    expect(within(panel).getByText('brand/logo.svg')).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'acme.example' })).toBeTruthy();
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Add a tag' }), 'wordmark{Enter}');
    await waitFor(() => expect(api.updateAsset).toHaveBeenCalledWith('acme', 'brand/logo.svg', { tags: ['logo', 'white', 'wordmark'] }));
    expect(await within(panel).findByRole('button', { name: 'Remove wordmark' })).toBeTruthy();
    await userEvent.click(within(panel).getByRole('button', { name: 'Remove white' }));
    await waitFor(() => expect(api.updateAsset).toHaveBeenLastCalledWith('acme', 'brand/logo.svg', { tags: ['logo', 'wordmark'] }));
  });

  it('never claims a description was written by Claude (no provenance in the data), and dates are relative', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 9, 15, 0));
    listing.assets[1]!.addedAt = new Date(2026, 9, 9, 14, 28).toISOString();
    en(<Assets slug="acme" live={live()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open night.jpg' }));
    const panel = screen.getByRole('complementary', { name: 'Asset details' });
    expect(within(panel).queryByText(/by Claude/)).toBeNull();
    expect(within(panel).getByText('Claude reads it · edit freely')).toBeTruthy();
    expect(within(panel).getByText('Uploaded · today 14:28')).toBeTruthy();
  });

  it('saves the description when the field loses focus, and never overwrites what is being typed', async () => {
    const { rerender } = en(<Assets slug="acme" live={live()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open night.jpg' }));
    const panel = screen.getByRole('complementary', { name: 'Asset details' });
    const field = within(panel).getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement;
    await userEvent.clear(field);
    await userEvent.type(field, 'Wet asphalt');
    listing.assets[1]!.description = 'Changed elsewhere';
    rerender(<I18nProvider locale="en"><Assets slug="acme" live={live({ projectTicks: { acme: 1 } })} /></I18nProvider>);
    await waitFor(() => expect(api.listAssets).toHaveBeenCalledTimes(2));
    expect(field.value).toBe('Wet asphalt');
    fireEvent.blur(field);
    await waitFor(() => expect(api.updateAsset).toHaveBeenCalledWith('acme', 'night.jpg', { description: 'Wet asphalt' }));
  });

  it('deletes with Undo from the panel, which closes', async () => {
    en(<Assets slug="acme" live={live()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open intro.mp4' }));
    const panel = screen.getByRole('complementary', { name: 'Asset details' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Delete asset' }));
    await waitFor(() => expect(card('intro.mp4')).toBeNull());
    expect(screen.queryByRole('complementary', { name: 'Asset details' })).toBeNull();
    expect(getToasts().some((x) => x.text === 'intro.mp4 deleted')).toBe(true);
  });
});

describe('Assets · upload and states', () => {
  it('uploads from the button: the cards appear, and nothing is described without a click', async () => {
    api.uploadFiles.mockImplementationOnce(async () => {
      const added = asset({ file: 'map.png' });
      listing.assets.push(added);
      return { assets: [added] };
    });
    en(<Assets slug="acme" live={live()} />);
    await screen.findByText('Wordmark for dark backgrounds');
    const file = new File(['x'], 'map.png', { type: 'image/png' });
    await userEvent.upload(screen.getByLabelText('Upload files'), file);
    await waitFor(() => expect(api.uploadFiles).toHaveBeenCalledWith('acme', 'assets', [file]));
    expect(await screen.findByRole('button', { name: 'Open map.png' })).toBeTruthy();
    expect(getToasts().some((x) => x.text === 'Uploaded 1 file')).toBe(true);
    expect(api.describeAssets).not.toHaveBeenCalled();
    // The new file waits in the side card, described only on a click.
    expect(screen.getByText('2 assets without a description')).toBeTruthy();
  });

  it('accepts files dropped anywhere on the page', async () => {
    en(<Assets slug="acme" live={live()} />);
    await screen.findByText('Wordmark for dark backgrounds');
    const page = document.querySelector('.ms-assets') as HTMLElement;
    const file = new File(['x'], 'drop.png', { type: 'image/png' });
    fireEvent.dragEnter(page, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(screen.getByText('Drop to add to Acme Studio')).toBeTruthy();
    fireEvent.drop(page, { dataTransfer: { types: ['Files'], files: [file] } });
    await waitFor(() => expect(api.uploadFiles).toHaveBeenCalledWith('acme', 'assets', [file]));
    expect(screen.queryByText('Drop to add to Acme Studio')).toBeNull();
  });

  it('offers no drop target when the library cannot be read', async () => {
    listing.error = 'bad JSON';
    en(<Assets slug="acme" live={live()} />);
    await screen.findByText(/The asset list can't be read: bad JSON/);
    const page = document.querySelector('.ms-assets') as HTMLElement;
    const file = new File(['x'], 'drop.png', { type: 'image/png' });
    fireEvent.dragEnter(page, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(screen.queryByText('Drop to add to Acme Studio')).toBeNull();
    fireEvent.drop(page, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(api.uploadFiles).not.toHaveBeenCalled();
  });

  it('shows the designed empty state with an Upload action', async () => {
    listing = { error: null, unregistered: [], assets: [] };
    en(<Assets slug="acme" live={live()} />);
    expect(await screen.findByText('No assets yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Upload' }).length).toBeGreaterThan(0);
  });

  it('explains a load failure and retries', async () => {
    api.listAssets.mockRejectedValueOnce(new Error('offline'));
    en(<Assets slug="acme" live={live()} />);
    expect(await screen.findByText("Can't load the assets: offline")).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Wordmark for dark backgrounds')).toBeTruthy();
  });

  it('offers to add files found in the folder but missing from the library', async () => {
    listing.unregistered = ['a.png', 'b.png'];
    en(<Assets slug="acme" live={live()} />);
    expect(await screen.findByText('2 files in the assets folder are not in the library yet')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add them' }));
    expect(api.registerAssets).toHaveBeenCalledWith('acme', ['a.png', 'b.png']);
  });

  it('disables Describe while the brand job runs, saying why', async () => {
    en(<Assets slug="acme" live={live({ jobs: { j1: job({ id: 'j1', kind: 'brand-analysis' }) } })} />);
    const btn = await screen.findByRole('button', { name: 'Describe it' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Claude is working on this project’s brand. Describe when it finishes.')).toBeTruthy();
  });
});
