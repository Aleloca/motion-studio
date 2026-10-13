import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { __resetToasts, getToasts } from '../src/ui/toast.tsx';

const fam = (family: string, extra: Record<string, unknown> = {}) => ({ family, category: 'Sans Serif', weights: [400, 700], italic: true, variable: false, previewUrl: `/api/fonts/google/preview/400/${encodeURIComponent(family)}?s=1.sig`, ...extra });
const api = {
  searchGoogleFonts: vi.fn(async (_q: { q?: string; category?: string; limit?: number }) => ({ stale: false, fallback: false, families: [fam('Manrope', { variable: true }), fam('Lora', { category: 'Serif', italic: false })] })),
  addGoogleFont: vi.fn(async (_s: string, b: { family: string; weights: number[]; italic: boolean; role: string }) => ({
    updated: false,
    font: { id: 'font-x', family: b.family, role: b.role, weights: b.weights, file: 'assets/fonts/X-400.ttf', source: { kind: 'manual', ref: null } }, files: ['assets/fonts/X-400.ttf'],
  })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { GoogleFontPicker } = await import('../src/screens/brand/GoogleFontPicker.tsx');

const faces: Array<{ family: string; source: string }> = [];
class FakeFace {
  constructor(public family: string, public source: string) { faces.push({ family, source }); }
  load() { return Promise.resolve(this); }
}
const fetched: string[] = [];

beforeEach(() => {
  __resetToasts();
  faces.length = 0; fetched.length = 0;
  api.searchGoogleFonts.mockClear(); api.addGoogleFont.mockClear();
  vi.stubGlobal('FontFace', FakeFace);
  Object.defineProperty(document, 'fonts', { configurable: true, value: { add: vi.fn() } });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', ((u: string, ...r: unknown[]) => { fetched.push(String(u)); return realFetch ? (realFetch as unknown as (...a: unknown[]) => unknown)(u, ...r) : Promise.reject(new Error('no network')); }) as typeof fetch);
});
afterEach(() => { vi.unstubAllGlobals(); });

const open = (props: Partial<Parameters<typeof GoogleFontPicker>[0]> = {}) => {
  const onAdded = vi.fn(); const onClose = vi.fn();
  render(<I18nProvider locale="en"><GoogleFontPicker open slug="acme" locked={false} onClose={onClose} onAdded={onAdded} {...props} /></I18nProvider>);
  return { onAdded, onClose };
};

describe('GoogleFontPicker', () => {
  it('searches with a debounce and shows the results', async () => {
    open();
    await screen.findByText('Manrope');
    expect(api.searchGoogleFonts).toHaveBeenCalledTimes(1);
    expect(api.searchGoogleFonts).toHaveBeenLastCalledWith({ q: '', category: '', limit: 24 });
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Search fonts' }), 'lor');
    await waitFor(() => expect(api.searchGoogleFonts).toHaveBeenLastCalledWith({ q: 'lor', category: '', limit: 24 }));
    expect(api.searchGoogleFonts.mock.calls.filter((c) => c[0].q === 'l' || c[0].q === 'lo')).toHaveLength(0);
  });
  it('loads previews only from the core URL, under a private family', async () => {
    api.searchGoogleFonts.mockResolvedValueOnce({ stale: false, fallback: false, families: [fam('Fresh Manrope'), fam('Fresh Lora')] });
    open();
    await screen.findByText('Fresh Manrope');
    await waitFor(() => expect(faces.length).toBe(2));
    expect(faces.map((f) => f.source)).toEqual([
      'url("/api/fonts/google/preview/400/Fresh%20Manrope?s=1.sig")',
      'url("/api/fonts/google/preview/400/Fresh%20Lora?s=1.sig")',
    ]);
    expect(faces.every((f) => f.family.startsWith('ms-brand-font-'))).toBe(true);
    expect(fetched.filter((u) => /^https?:\/\//.test(u))).toEqual([]);
    expect(document.querySelector('link[href*="google"], style')?.textContent ?? '').not.toContain('googleapis');
  });
  it('picks weights and italic, then adds through the core and reports the font', async () => {
    const { onAdded, onClose } = open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Manrope/ }));
    expect(screen.getByRole('checkbox', { name: 'Weight 400' }).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('checkbox', { name: 'Weight 700' }));
    await user.click(screen.getByRole('switch', { name: 'Include italic' }));
    await user.click(screen.getByRole('button', { name: 'Add to the brand' }));
    await waitFor(() => expect(api.addGoogleFont).toHaveBeenCalledWith('acme', { family: 'Manrope', weights: [400, 700], italic: true, role: 'body' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ family: 'Manrope', weights: [400, 700] })));
    expect(onClose).toHaveBeenCalled();
    expect(getToasts().some((t) => t.text === 'Manrope added to the brand')).toBe(true);
  });
  it('offers no italic for a family without one and cannot add with no weight', async () => {
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Lora/ }));
    expect(screen.queryByRole('switch', { name: 'Include italic' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Weight 400' }));
    expect((screen.getByRole('button', { name: 'Add to the brand' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('says so when the catalog is not available (exact-name fallback) or stale', async () => {
    api.searchGoogleFonts.mockResolvedValueOnce({ stale: false, fallback: true, families: [] });
    const { unmount } = render(<I18nProvider locale="en"><GoogleFontPicker open slug="acme" locked={false} onClose={() => {}} onAdded={() => {}} /></I18nProvider>);
    expect(await screen.findByText(/catalog is not available right now/)).toBeTruthy();
    unmount();
    api.searchGoogleFonts.mockResolvedValueOnce({ stale: true, fallback: false, families: [fam('Lora')] });
    open();
    expect(await screen.findByText(/saved copy of the catalog/)).toBeTruthy();
  });
  it('says updated when the family was already in the brand', async () => {
    api.addGoogleFont.mockResolvedValueOnce({ updated: true, font: { id: 'f', family: 'Manrope', role: 'body', weights: [400, 700], file: null, source: { kind: 'manual', ref: null } }, files: [] } as never);
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Manrope/ }));
    await user.click(screen.getByRole('button', { name: 'Add to the brand' }));
    await waitFor(() => expect(getToasts().some((t) => t.text === 'Manrope updated: weights added')).toBe(true));
  });
  it('keeps the side panel on the picked family when a new search no longer lists it', async () => {
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Manrope/ }));
    api.searchGoogleFonts.mockResolvedValueOnce({ stale: false, fallback: false, families: [fam('Zilla')] });
    await user.type(screen.getByRole('textbox', { name: 'Search fonts' }), 'zi');
    await screen.findByText('Zilla');
    expect(screen.getByRole('checkbox', { name: 'Weight 700' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add to the brand' })).toBeTruthy();
  });
  it('shows a failed search', async () => {
    api.searchGoogleFonts.mockRejectedValueOnce(new Error('core down'));
    open();
    expect(await screen.findByText("Couldn't search fonts: core down")).toBeTruthy();
  });
  it('shows a failed add', async () => {
    api.addGoogleFont.mockRejectedValueOnce(new Error('Font "X" not found'));
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Manrope/ }));
    await user.click(screen.getByRole('button', { name: 'Add to the brand' }));
    await waitFor(() => expect(getToasts().some((t) => t.text.includes('Couldn’t add') || t.text.includes("Couldn't add"))).toBe(true));
  });
  it('keeps Add off while the brand is read-only', async () => {
    open({ locked: true });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Manrope/ }));
    expect((screen.getByRole('button', { name: 'Add to the brand' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
