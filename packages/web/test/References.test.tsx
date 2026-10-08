import type { ReferenceEntry } from '@motion-studio/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';
import { __resetToasts, getToasts } from '../src/ui/toast.tsx';

const at = '2026-10-07T10:00:00.000Z';
let listing: { references: ReferenceEntry[]; error: string | null };
const api = {
  listReferences: vi.fn(async () => structuredClone(listing)),
  updateReference: vi.fn(async (_s: string, file: string, patch: Partial<ReferenceEntry>) => {
    const r = listing.references.find((x) => x.file === file)!;
    Object.assign(r, patch);
    return structuredClone(r);
  }),
  deleteReference: vi.fn(async () => ({ ok: true })),
  uploadFiles: vi.fn(async (): Promise<unknown> => ({ references: [] })),
  analyzeBrand: vi.fn(async () => ({ id: 'j1' })),
  projectFileUrl: (s: string, r: string) => `/f/${s}/${r}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { References } = await import('../src/screens/References.tsx');
const { UNDO_MS } = await import('../src/screens/Assets.tsx');
const { flushDeferred } = await import('../src/screens/deferred.ts');

const live = (over: Partial<EventsState> = {}): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {}, ...over });
const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);

beforeEach(() => {
  __resetToasts();
  history.replaceState(null, '', '/#/p/acme/references');
  listing = {
    error: null,
    references: [
      { file: 'leaf.jpg', note: 'The single orange leaf is the whole palette idea.', useForBrand: true, addedAt: at },
      { file: 'deco.png', note: '', useForBrand: false, addedAt: at },
    ],
  };
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); __resetToasts(); });

describe('References', () => {
  it('shows the moodboard with notes and how many references feed the brand analysis', async () => {
    en(<References slug="acme" live={live()} />);
    expect(await screen.findByText('The single orange leaf is the whole palette idea.')).toBeTruthy();
    expect(screen.getByText('1 reference feeds the next brand analysis')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'leaf.jpg' })).toBeTruthy();
    // No link field: the API has no way to add one.
    expect(screen.queryByRole('textbox', { name: /link/i })).toBeNull();
  });

  it('the Brand analysis switch calls the API', async () => {
    en(<References slug="acme" live={live()} />);
    const sw = await screen.findByRole('switch', { name: 'Use deco.png for brand analysis' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(sw);
    await waitFor(() => expect(api.updateReference).toHaveBeenCalledWith('acme', 'deco.png', { useForBrand: true }));
    expect(await screen.findByText('2 references feed the next brand analysis')).toBeTruthy();
  });

  it('puts the switch back and explains when the change fails', async () => {
    api.updateReference.mockRejectedValueOnce(new Error('disk full'));
    en(<References slug="acme" live={live()} />);
    const sw = await screen.findByRole('switch', { name: 'Use leaf.jpg for brand analysis' });
    await userEvent.click(sw);
    await waitFor(() => expect(getToasts().some((x) => x.text === 'Not saved: disk full')).toBe(true));
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('edits a note and saves it when the field loses focus', async () => {
    en(<References slug="acme" live={live()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Note for deco.png' }));
    const field = screen.getByRole('textbox', { name: 'Note for deco.png' });
    await userEvent.type(field, 'Art Deco lettering');
    fireEvent.blur(field);
    await waitFor(() => expect(api.updateReference).toHaveBeenCalledWith('acme', 'deco.png', { note: 'Art Deco lettering' }));
  });

  it('removing hides the card with Undo: Undo never calls deleteReference', async () => {
    en(<References slug="acme" live={live()} />);
    await screen.findByText('The single orange leaf is the whole palette idea.');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Remove leaf.jpg' }));
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.queryByRole('img', { name: 'leaf.jpg' })).toBeNull();
    const toast = getToasts().find((x) => x.text === 'Reference removed')!;
    await act(async () => { toast.action!.run(); });
    await act(async () => { vi.advanceTimersByTime(UNDO_MS * 2); });
    expect(api.deleteReference).not.toHaveBeenCalled();
    expect(screen.getByRole('img', { name: 'leaf.jpg' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove leaf.jpg' }));
    await act(async () => {}); // the card collapses (T15), then the Undo time starts
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 500); });
    expect(api.deleteReference).toHaveBeenCalledWith('acme', 'leaf.jpg');
  });

  it('"Analyze brand with these" goes to Brand and starts the analysis', async () => {
    en(<References slug="acme" live={live()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Analyze brand with these' }));
    await waitFor(() => expect(api.analyzeBrand).toHaveBeenCalledWith('acme'));
    expect(location.hash).toBe('#/p/acme/brand');
  });

  it('sends a pending removal before the analysis', async () => {
    en(<References slug="acme" live={live()} />);
    await screen.findByText('The single orange leaf is the whole palette idea.');
    await userEvent.click(screen.getByRole('switch', { name: 'Use deco.png for brand analysis' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove leaf.jpg' }));
    await userEvent.click(screen.getByRole('button', { name: 'Analyze brand with these' }));
    await waitFor(() => expect(api.analyzeBrand).toHaveBeenCalled());
    expect(api.deleteReference.mock.invocationCallOrder[0]!).toBeLessThan(api.analyzeBrand.mock.invocationCallOrder[0]!);
    await act(async () => { await flushDeferred(); });
  });

  it('adds images through the upload', async () => {
    api.uploadFiles.mockImplementationOnce(async () => {
      const r = { file: 'rain.jpg', note: '', useForBrand: true, addedAt: at };
      listing.references.push(r);
      return { references: [r] };
    });
    en(<References slug="acme" live={live()} />);
    await screen.findByText('The single orange leaf is the whole palette idea.');
    const file = new File(['x'], 'rain.jpg', { type: 'image/jpeg' });
    await userEvent.upload(screen.getByLabelText('Add images'), file);
    await waitFor(() => expect(api.uploadFiles).toHaveBeenCalledWith('acme', 'references', [file]));
    expect(await screen.findByRole('img', { name: 'rain.jpg' })).toBeTruthy();
  });

  it('shows the designed empty state with an action, and no analyze button', async () => {
    listing = { error: null, references: [] };
    en(<References slug="acme" live={live()} />);
    expect(await screen.findByText('No references yet')).toBeTruthy();
    const empty = screen.getByText('No references yet').closest('.ms-empty') as HTMLElement;
    expect(within(empty).getByRole('button', { name: 'Add images' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Analyze brand with these' })).toBeNull();
  });

  it('explains a load failure and retries', async () => {
    api.listReferences.mockRejectedValueOnce(new Error('offline'));
    en(<References slug="acme" live={live()} />);
    expect(await screen.findByText("Can't load the references: offline")).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('The single orange leaf is the whole palette idea.')).toBeTruthy();
  });
});
