import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EMPTY_BRAND_KIT, type BrandOverview, type JobSummary, type SecretStatus } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';

let secrets: SecretStatus[];
let overview: BrandOverview;
const secret = (provider: SecretStatus['provider'], configured: boolean): SecretStatus => ({ provider, configured, source: configured ? 'keychain' : null });
const api = {
  getSecrets: vi.fn(async () => secrets),
  getBrand: vi.fn(async () => overview),
  generateAsset: vi.fn(async (_s: string, _b: unknown) => ({ jobId: 'job-1' })),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { GenerateDialog } = await import('../src/screens/assets/GenerateDialog.tsx');

const job = (over: Partial<JobSummary> = {}): JobSummary => ({ id: 'job-1', key: 'generate:x:acme', kind: 'asset-generation', label: 'Generate', state: 'running', createdAt: '2026-01-01T00:00:00Z', ...over });
const live = (jobs: JobSummary[] = []): EventsState => ({ approvals: {}, jobs: Object.fromEntries(jobs.map((j) => [j.id, j])), events: {}, creativeTicks: {}, projectTicks: {} });
const onClose = vi.fn();
const ui = (l: EventsState = live()) => <I18nProvider locale="en"><GenerateDialog open onClose={onClose} slug="acme" live={l} /></I18nProvider>;
const sent = () => api.generateAsset.mock.calls.at(-1)![1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  secrets = [secret('openai', true), secret('elevenlabs', true), secret('pexels', false)];
  overview = { kit: structuredClone(EMPTY_BRAND_KIT), kitError: null, guidelines: '', sources: [], sourcesError: null, proposals: [], jobKey: 'k' };
});

describe('GenerateDialog', () => {
  it('shows one tab per kind, the provider and model, and the paid note', async () => {
    render(ui());
    expect(await screen.findAllByRole('tab')).toHaveLength(4);
    expect(screen.getByText(/Made by OpenAI \(gpt-image-2\)/)).toBeTruthy();
    expect(screen.getByText(/paid call/)).toBeTruthy();
  });
  it('sends an image request and follows the job to its end', async () => {
    const user = userEvent.setup();
    const r = render(ui());
    await user.type(await screen.findByLabelText('Description'), 'A blue plane');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(api.generateAsset).toHaveBeenCalled());
    expect(api.generateAsset.mock.calls[0]![0]).toBe('acme');
    expect(sent()).toMatchObject({ kind: 'image', provider: 'openai', prompt: 'A blue plane', options: { width: 1024, height: 1024, quality: 'auto' } });
    expect(await screen.findByText(/Generating…/)).toBeTruthy();
    r.rerender(ui(live([job()])));
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(api.cancelJob).toHaveBeenCalledWith('job-1');
    r.rerender(ui(live([job({ state: 'succeeded' })])));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
  it('shows a failed job\'s error and allows another try', async () => {
    const user = userEvent.setup();
    const r = render(ui());
    await user.type(await screen.findByLabelText('Description'), 'x');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText(/Generating…/);
    r.rerender(ui(live([job({ state: 'failed', error: 'The OpenAI key is invalid' })])));
    expect((await screen.findByRole('alert')).textContent).toContain('The OpenAI key is invalid');
    expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('sends a voice-over with the brand voice prefilled', async () => {
    overview.kit.sound = { genre: '', energy: null, instruments: [], avoid: [], voice: { provider: 'elevenlabs', id: 'v1', name: 'Rachel' } };
    const user = userEvent.setup();
    render(ui());
    await user.click(await screen.findByRole('tab', { name: 'Voice-over' }));
    await waitFor(() => expect((screen.getByLabelText('Voice ID') as HTMLInputElement).value).toBe('v1'));
    expect(screen.getByText('Brand voice: Rachel')).toBeTruthy();
    await user.type(screen.getByLabelText('Text to speak'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(sent()).toMatchObject({ kind: 'voice', provider: 'elevenlabs', text: 'Hello', options: { voice: 'v1', format: 'mp3' } }));
  });
  it('clears the voice when the provider changes, unless it is the brand voice of the new provider', async () => {
    overview.kit.sound = { genre: '', energy: null, instruments: [], avoid: [], voice: { provider: 'elevenlabs', id: 'v1', name: 'Rachel' } };
    const user = userEvent.setup();
    render(ui());
    await user.click(await screen.findByRole('tab', { name: 'Voice-over' }));
    const field = () => screen.getByLabelText('Voice ID') as HTMLInputElement;
    await waitFor(() => expect(field().value).toBe('v1'));
    // ElevenLabs → OpenAI: the ElevenLabs id is not carried over.
    await user.click(screen.getByRole('button', { name: /Provider/ }));
    await user.click(await screen.findByRole('option', { name: 'OpenAI' }));
    await waitFor(() => expect(field().value).toBe(''));
    await user.type(field(), 'alloy');
    // OpenAI → ElevenLabs: the OpenAI name is dropped and the brand's ElevenLabs voice comes back.
    await user.click(screen.getByRole('button', { name: /Provider/ }));
    await user.click(await screen.findByRole('option', { name: 'ElevenLabs' }));
    await waitFor(() => expect(field().value).toBe('v1'));
    await user.type(screen.getByLabelText('Text to speak'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(sent()).toMatchObject({ kind: 'voice', provider: 'elevenlabs', options: { voice: 'v1' } }));
  });
  it('the brand voice of a provider without its key is not prefilled for the other provider', async () => {
    secrets = [secret('openai', true), secret('elevenlabs', false)];
    overview.kit.sound = { genre: '', energy: null, instruments: [], avoid: [], voice: { provider: 'elevenlabs', id: 'v1', name: 'Rachel' } };
    const user = userEvent.setup();
    render(ui());
    await user.click(await screen.findByRole('tab', { name: 'Voice-over' }));
    await waitFor(() => expect(screen.getByText(/Made by OpenAI \(gpt-4o-mini-tts\)/)).toBeTruthy());
    expect((screen.getByLabelText('Voice ID') as HTMLInputElement).value).toBe('');
    await user.type(screen.getByLabelText('Text to speak'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(api.generateAsset).toHaveBeenCalled());
    expect(sent()).toMatchObject({ kind: 'voice', provider: 'openai' });
    expect((sent().options as Record<string, unknown>).voice).toBeUndefined();
  });
  it('prefills the music prompt from the brand sound style and shows the duration limits', async () => {
    overview.kit.sound = { genre: 'warm electronic', energy: 'low', instruments: ['piano'], avoid: ['brass'], voice: null };
    const user = userEvent.setup();
    render(ui());
    await user.click(await screen.findByRole('tab', { name: 'Music' }));
    await waitFor(() => expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('warm electronic, low energy, instruments: piano, avoid: brass'));
    expect(screen.getByText('Between 10 and 300 seconds.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(sent()).toMatchObject({ kind: 'music', provider: 'elevenlabs', options: { durationSec: 30 } }));
  });
  it('sound effects: shows the limits and sends the loop flag', async () => {
    const user = userEvent.setup();
    render(ui());
    await user.click(await screen.findByRole('tab', { name: 'Sound effect' }));
    expect(screen.getByText(/Between 0.5 and 30 seconds/)).toBeTruthy();
    await user.type(screen.getByLabelText('Description'), 'Door slam');
    await user.click(screen.getByRole('switch', { name: 'Loop' }));
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(sent()).toMatchObject({ kind: 'sfx', prompt: 'Door slam', options: { loop: true } }));
  });
  it('validation messages: an empty description sends nothing', async () => {
    const user = userEvent.setup();
    render(ui());
    await user.click(await screen.findByRole('button', { name: 'Generate' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Describe what to generate.');
    expect(api.generateAsset).not.toHaveBeenCalled();
  });
  it('disables the tabs whose provider has no key, with a link to Settings', async () => {
    secrets = [secret('openai', true), secret('elevenlabs', false)];
    render(ui());
    await waitFor(() => expect((screen.getByRole('tab', { name: 'Music' }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole('tab', { name: 'Sound effect' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('tab', { name: 'Image' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('tab', { name: 'Voice-over' }) as HTMLButtonElement).disabled).toBe(false);
    const link = screen.getByRole('link', { name: 'Open Settings' });
    expect(link.getAttribute('href')).toBe('#/settings/paid');
  });
  it('with no key at all, every tab is disabled and nothing can be sent', async () => {
    secrets = [secret('openai', false), secret('elevenlabs', false)];
    render(ui());
    expect(await screen.findByText(/No provider key is set yet/)).toBeTruthy();
    for (const tab of screen.getAllByRole('tab')) expect((tab as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(screen.getByRole('dialog')).getByRole('link', { name: 'Open Settings' })).toBeTruthy();
  });
  it('shows an error from the core when the request is refused', async () => {
    api.generateAsset.mockRejectedValueOnce(new Error('Choose a duration between 10 and 300 seconds.'));
    const user = userEvent.setup();
    render(ui());
    await user.type(await screen.findByLabelText('Description'), 'x');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    expect((await screen.findByRole('alert')).textContent).toContain('between 10 and 300');
  });
});
