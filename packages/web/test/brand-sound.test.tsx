import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EMPTY_BRAND_KIT, type BrandKit, type BrandOverview } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';
import { __resetDeferred } from '../src/screens/deferred.ts';
import { __resetToasts, getToasts } from '../src/ui/toast.tsx';

let overview: BrandOverview;
const voice = (id: string, name: string, previewUrl: string | null, labels: Record<string, string> = {}) => ({ id, name, labels, previewUrl });
const elevenlabs = { provider: 'elevenlabs' as const, configured: true, previewExpiresAt: 1, voices: [
  voice('v1', 'Rachel', '/api/voices/preview/elevenlabs/v1?s=1.sig', { accent: 'british' }),
  voice('v2', 'Adam', '/api/voices/preview/elevenlabs/v2?s=1.sig2'),
  voice('v3', 'Quiet', null),
] };
const openai = { provider: 'openai' as const, configured: true, previewExpiresAt: 0, voices: ['alloy', 'marin'].map((id) => voice(id, id, null)) };
const api = {
  getBrand: vi.fn(async () => structuredClone(overview)),
  getProject: vi.fn(async () => ({ slug: 'acme', project: { name: 'Acme Studio' }, jobKey: 'k' })),
  listAssets: vi.fn(async () => ({ assets: [], error: null, unregistered: [] })),
  listReferences: vi.fn(async () => ({ references: [], error: null })),
  saveBrandKit: vi.fn(async (_s: string, k: BrandKit) => { overview.kit = structuredClone(k); return k; }),
  saveGuidelines: vi.fn(async () => ({ ok: true as const })),
  listVoices: vi.fn(async (q: { provider: string; q?: string }) => {
    const base = q.provider === 'openai' ? openai : elevenlabs;
    return { ...base, voices: base.voices.filter((v) => !q.q || v.name.toLowerCase().includes(q.q.toLowerCase())) };
  }),
  projectFileUrl: (s: string, r: string) => `/f/${s}/${r}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { Brand } = await import('../src/screens/Brand.tsx');

const live = (): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} });
const en = () => render(<I18nProvider locale="en"><Brand slug="acme" live={live()} /></I18nProvider>);
const lastKit = () => api.saveBrandKit.mock.calls.at(-1)![1] as BrandKit;
const sound = async () => within(await screen.findByRole('region', { name: 'Sound' }));

const audios: Array<{ src: string; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }> = [];
class FakeAudio {
  listeners: Record<string, Array<() => void>> = {};
  play = vi.fn(() => (playFails ? Promise.reject(new Error('403')) : Promise.resolve()));
  pause = vi.fn();
  constructor(public src: string) { audios.push(this as never); }
  addEventListener(n: string, f: () => void) { (this.listeners[n] ??= []).push(f); }
  removeAttribute() {}
}
const fetched: string[] = [];
let playFails = false;

beforeEach(() => {
  __resetToasts();
  audios.length = 0; fetched.length = 0; playFails = false;
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('fetch', ((u: string) => { fetched.push(String(u)); return Promise.reject(new Error('no network')); }) as typeof fetch);
  overview = { kit: { ...EMPTY_BRAND_KIT, colors: [{ id: 'ink', name: 'Ink black', hex: '#1B1913', role: 'background', source: { kind: 'manual', ref: null } }] }, kitError: null, guidelines: '', sourcesError: null, proposals: [], jobKey: 'brand:k', sources: [] };
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); __resetToasts(); __resetDeferred(); });

describe('Brand · Sound section', () => {
  it('shows an older kit without sound as empty', async () => {
    en();
    const s = await sound();
    expect(s.getByText('No brand voice chosen.')).toBeTruthy();
    expect(s.getByRole('radio', { name: 'Not set' }).getAttribute('aria-checked')).toBe('true');
    expect(api.saveBrandKit).not.toHaveBeenCalled();
  });

  it('saves the genre from a suggestion, the energy, and the instrument and avoid chips through the brand saver', async () => {
    en();
    const s = await sound();
    const user = userEvent.setup();
    await user.click(s.getByRole('button', { name: 'Ambient' }));
    await waitFor(() => expect(lastKit().sound).toMatchObject({ genre: 'ambient', energy: null, instruments: [], avoid: [], voice: null }));
    await user.click(s.getByRole('radio', { name: 'High' }));
    await waitFor(() => expect(lastKit().sound).toMatchObject({ genre: 'ambient', energy: 'high' }));
    await user.type(s.getByRole('textbox', { name: 'Instruments' }), 'piano{Enter}');
    await waitFor(() => expect(lastKit().sound!.instruments).toEqual(['piano']));
    await user.type(s.getByRole('textbox', { name: 'Instruments' }), 'Piano{Enter}');
    await user.type(s.getByRole('textbox', { name: 'Avoid' }), 'brass{Enter}');
    await waitFor(() => expect(lastKit().sound).toMatchObject({ instruments: ['piano'], avoid: ['brass'] }));
    await user.click(s.getByRole('button', { name: 'Remove piano' }));
    await waitFor(() => expect(lastKit().sound!.instruments).toEqual([]));
    await user.click(s.getByRole('radio', { name: 'Not set' }));
    await waitFor(() => expect(lastKit().sound!.energy).toBeNull());
  });

  it('stores the canonical genre, not the localized label; an old saved label (any language) still selects its chip', async () => {
    overview.kit = { ...overview.kit, sound: { genre: 'Elettronica', energy: null, instruments: [], avoid: [], voice: null } };
    en();
    const s = await sound();
    expect(s.getByRole('button', { name: 'Electronic' }).getAttribute('aria-pressed')).toBe('true');
    const user = userEvent.setup();
    await user.click(s.getByRole('button', { name: 'Hip hop' }));
    await waitFor(() => expect(lastKit().sound!.genre).toBe('hip hop'));
    await user.click(s.getByRole('button', { name: 'Hip hop' }));
    await waitFor(() => expect(lastKit().sound!.genre).toBe(''));
  });

  it('saves a typed genre after a pause', async () => {
    en();
    const s = await sound();
    await userEvent.type(s.getByRole('textbox', { name: 'Genre' }), 'warm electronic');
    await waitFor(() => expect(lastKit().sound!.genre).toBe('warm electronic'), { timeout: 3000 });
  });
});

describe('Brand · voice picker', () => {
  const openPicker = async () => {
    en();
    const s = await sound();
    await userEvent.click(s.getByRole('button', { name: 'Choose a voice' }));
    return within(await screen.findByRole('dialog', { name: 'Choose the brand voice' }));
  };

  it('lists the voices from the core, searches, and saves the one picked with its provider and name', async () => {
    const d = await openPicker();
    await d.findByRole('button', { name: 'Use Rachel' });
    expect(api.listVoices).toHaveBeenLastCalledWith({ provider: 'elevenlabs', q: '' });
    expect(d.getByText('british')).toBeTruthy();
    await userEvent.type(d.getByRole('textbox', { name: 'Search voices' }), 'ada');
    await waitFor(() => expect(api.listVoices).toHaveBeenLastCalledWith({ provider: 'elevenlabs', q: 'ada' }));
    await userEvent.click(await d.findByRole('button', { name: 'Use Adam' }));
    await waitFor(() => expect(lastKit().sound!.voice).toEqual({ provider: 'elevenlabs', id: 'v2', name: 'Adam' }));
    const s = await sound();
    expect(await s.findByText('ElevenLabs · Adam')).toBeTruthy();
  });

  it('plays the preview only from the core URL, one at a time, and never fetches a third-party URL', async () => {
    const d = await openPicker();
    await userEvent.click(await d.findByRole('button', { name: 'Play preview of Rachel' }));
    expect(audios.map((a) => a.src)).toEqual(['/api/voices/preview/elevenlabs/v1?s=1.sig']);
    await userEvent.click(d.getByRole('button', { name: 'Play preview of Adam' }));
    expect(audios).toHaveLength(2);
    expect(audios[0]!.pause).toHaveBeenCalled();
    expect(audios.every((a) => a.src.startsWith('/api/voices/preview/'))).toBe(true);
    expect(d.getByRole('button', { name: 'Stop preview of Adam' })).toBeTruthy();
    await userEvent.click(d.getByRole('button', { name: 'Stop preview of Adam' }));
    expect(d.getByRole('button', { name: 'Play preview of Adam' })).toBeTruthy();
    expect(d.queryByRole('button', { name: /preview of Quiet/ })).toBeNull();
    expect(d.getByText('No preview')).toBeTruthy();
    expect(fetched.filter((u) => /^https?:\/\//.test(u))).toEqual([]);
  });

  it('says so when a preview cannot play', async () => {
    const d = await openPicker();
    await d.findByRole('button', { name: 'Play preview of Rachel' });
    playFails = true;
    await userEvent.click(d.getByRole('button', { name: 'Play preview of Rachel' }));
    await waitFor(() => expect(getToasts().some((t) => t.text === "Couldn't play the preview.")).toBe(true));
  });

  it('lists the fixed OpenAI voices with no preview', async () => {
    const d = await openPicker();
    await userEvent.click(d.getByRole('radio', { name: 'OpenAI' }));
    await d.findByRole('button', { name: 'Use marin' });
    expect(api.listVoices).toHaveBeenLastCalledWith({ provider: 'openai', q: '' });
    expect(d.queryByRole('button', { name: /Play preview/ })).toBeNull();
    await userEvent.click(d.getByRole('button', { name: 'Use marin' }));
    await waitFor(() => expect(lastKit().sound!.voice).toEqual({ provider: 'openai', id: 'marin', name: 'marin' }));
  });

  it('without a key the picker is disabled and links to Settings', async () => {
    api.listVoices.mockResolvedValueOnce({ provider: 'elevenlabs', configured: false, voices: [], previewExpiresAt: 0 });
    const d = await openPicker();
    expect(await d.findByText(/ElevenLabs needs an API key/)).toBeTruthy();
    expect((d.getByRole('textbox', { name: 'Search voices' }) as HTMLInputElement).disabled).toBe(true);
    expect(d.getByRole('link', { name: 'Open Settings' }).getAttribute('href')).toBe('#/settings/paid');
    expect(d.queryByRole('button', { name: /^Use / })).toBeNull();
  });

  it('shows a load failure', async () => {
    api.listVoices.mockRejectedValueOnce(new Error('ElevenLabs is down'));
    const d = await openPicker();
    expect(await d.findByRole('alert')).toBeTruthy();
  });

  it('removes the brand voice', async () => {
    overview.kit = { ...overview.kit, sound: { genre: '', energy: null, instruments: [], avoid: [], voice: { provider: 'openai', id: 'marin', name: 'marin' } } };
    en();
    const s = await sound();
    expect(s.getByText('OpenAI · marin')).toBeTruthy();
    await userEvent.click(s.getByRole('button', { name: 'Remove voice' }));
    await waitFor(() => expect(lastKit().sound!.voice).toBeNull());
  });
});
