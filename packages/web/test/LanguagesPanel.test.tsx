import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type ApprovalRequest, type Brief, type CreativeDetail, type JobSummary, type KeyCheckResult, type LocalizationRow, type SecretStatus, type VersionEntry } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';

class ApiError extends Error { constructor(public status: number, m: string, public code?: string, public retryAfterSec?: number, public problems?: string[]) { super(m); } }
let secrets: SecretStatus[];
let checks: Record<string, KeyCheckResult | null>;
const api = {
  getSecrets: vi.fn(async () => secrets),
  getKeyChecks: vi.fn(async () => checks),
  localize: vi.fn(async (..._a: unknown[]) => ({ jobId: 'job-9' })),
  getEditorComposition: vi.fn(async (..._a: unknown[]) => ({ composition: { $schema: 'motion-studio/composition@1', width: 1080, height: 1920, fps: 30, duration: 6, background: '#000000', fonts: [], scenes: [], tracks: [] } })),
  getLocalization: vi.fn(async (..._a: unknown[]) => ({ overlay: { texts: {}, params: {}, voices: {}, fit: {}, fonts: [] }, problems: [], stale: [], voice: 'original', origin: 'agent', hash: 'x' })),
  saveLocalization: vi.fn(),
  decideApproval: vi.fn(async (..._a: unknown[]) => ({})),
  renderVersion: vi.fn(async (..._a: unknown[]) => ({ id: 'r1' })),
  prepareExport: vi.fn(async (..._a: unknown[]) => ({ renders: [] as unknown[] })),
  exportPicks: vi.fn(async (_s: string, _c: string, body: { destination: string }) => ({ destination: body.destination, files: [{ from: 'a', to: 'b' }], skipped: [] as string[] })),
  updateSettings: vi.fn(),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { LanguagesPanel } = await import('../src/screens/creative/LanguagesPanel.tsx');
const { LanguagesButton } = await import('../src/screens/creative/LanguagesButton.tsx');
const { BriefLanguages } = await import('../src/screens/creative/BriefLanguages.tsx');
const { RenderLanguagesDialog } = await import('../src/screens/creative/RenderLanguagesDialog.tsx');
const { ExportDialog } = await import('../src/screens/ExportDialog.tsx');

const secret = (provider: SecretStatus['provider'], configured: boolean): SecretStatus => ({ provider, configured, source: configured ? 'keychain' : null });
const baseBrief: Brief = { goal: 'g', message: '', formats: ['instagram-reel-9x16', 'instagram-post-1x1'], durationSec: 6, assets: [], notes: '' };
const comp = (format: string) => ({ format, folder: format, hash: 'h'.repeat(64) });
const row = (locale: LocalizationRow['locale'], instanceId: string, over: Partial<LocalizationRow> = {}): LocalizationRow =>
  ({ locale, instanceId, hash: 'a'.repeat(64), origin: 'agent', stale: [], voice: 'translated', ...over });
const version = (over: Partial<VersionEntry> = {}): VersionEntry => ({
  n: 3, commit: 'c', sessionId: 's', status: 'complete', createdAt: '2026-10-08T10:00:00.000Z', request: '', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null,
  compositions: [comp('instagram-reel-9x16'), comp('instagram-post-1x1')], ...over,
} as VersionEntry);
const detail = (brief: Partial<Brief>, v: VersionEntry): CreativeDetail => ({
  slug: 'c1', jobKey: 'creative:acme:c1', versions: [v],
  creative: { schemaVersion: 1, title: 'Launch', brief: { ...baseBrief, ...brief }, status: 'ready' } as unknown as CreativeDetail['creative'],
});
const live = (jobs: JobSummary[] = [], approvals: ApprovalRequest[] = []): EventsState => ({
  approvals: Object.fromEntries(approvals.map((a) => [a.id, a])), jobs: Object.fromEntries(jobs.map((j) => [j.id, j])), events: {}, creativeTicks: {}, projectTicks: {},
} as EventsState);
const panel = (d: CreativeDetail, l = live()) => render(
  <I18nProvider locale="en"><LanguagesPanel open onClose={() => {}} slug="acme" creative="c1" detail={d} version={d.versions[0]!} presets={DEFAULT_FORMATS} live={l} /></I18nProvider>,
);
const LOCALES = { locales: { primary: 'en', extra: ['de', 'ja'] } } as Pick<Brief, 'locales'>;
const lang = (tag: string) => document.querySelector(`[data-locale="${tag}"]`) as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  secrets = [secret('openai', true), secret('elevenlabs', true), secret('pexels', false)];
  checks = {};
});

describe('LanguagesPanel · status', () => {
  it('shows each language with its state: not translated, translated, n outdated, n problems', async () => {
    const v = version({ localizations: [
      row('de', 'instagram-reel-9x16'), row('de', 'instagram-post-1x1'),
      row('ja', 'instagram-reel-9x16', { stale: ['title', 'sub'], problems: ['x'] }),
    ] });
    panel(detail({ ...LOCALES, locales: { primary: 'en', extra: ['de', 'ja', 'fr'] } }, v));
    expect(await within(lang('de')).findByText('Translated')).toBeTruthy();
    expect(within(lang('ja')).getByText('2 outdated · 1 problem')).toBeTruthy();
    expect(within(lang('fr')).getByText('Not translated')).toBeTruthy();
    // A format with no translation of a language has nothing to review.
    expect((within(lang('ja')).getByRole('button', { name: 'Review Post 1:1' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(lang('de')).getByRole('button', { name: 'Review Post 1:1' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a creative with no languages in its brief has no Languages button at all (old briefs)', () => {
    const v = version();
    const d = detail({}, v);
    const { container } = render(<I18nProvider locale="en"><LanguagesButton slug="acme" creative="c1" detail={d} version={v} presets={DEFAULT_FORMATS} live={live()} /></I18nProvider>);
    expect(container.textContent).toBe('');
    // The primary language alone, with no extra language, is no localization either.
    const alone = detail({ locales: { primary: 'en', extra: [] } }, v);
    const r = render(<I18nProvider locale="en"><LanguagesButton slug="acme" creative="c1" detail={alone} version={v} presets={DEFAULT_FORMATS} live={live()} /></I18nProvider>);
    expect(r.container.textContent).toBe('');
  });

  it('the button opens the panel', async () => {
    const v = version();
    const d = detail(LOCALES, v);
    render(<I18nProvider locale="en"><LanguagesButton slug="acme" creative="c1" detail={d} version={v} presets={DEFAULT_FORMATS} live={live()} /></I18nProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'Languages' }));
    expect(await screen.findByRole('dialog', { name: 'Languages' })).toBeTruthy();
  });
});

describe('LanguagesPanel · voice', () => {
  it('Translate is the default voice when it is available, and the choice goes with the request', async () => {
    panel(detail(LOCALES, version()));
    await waitFor(() => expect(api.getKeyChecks).toHaveBeenCalled());
    expect(within(lang('de')).getByRole('radio', { name: 'Translate' }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(within(lang('ja')).getByRole('radio', { name: 'Mute' }));
    await userEvent.click(screen.getByRole('button', { name: 'Translate 2 languages' }));
    await waitFor(() => expect(api.localize).toHaveBeenCalledOnce());
    expect(api.localize).toHaveBeenCalledWith('acme', 'c1', 3, { locales: ['de', 'ja'], voice: { de: 'translate', ja: 'muted' } });
  });

  it('translates the chosen languages and formats only', async () => {
    panel(detail(LOCALES, version()));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Translate to Japanese' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Post 1:1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Translate 1 language' }));
    await waitFor(() => expect(api.localize).toHaveBeenCalledOnce());
    expect(api.localize).toHaveBeenCalledWith('acme', 'c1', 3, { locales: ['de'], formats: ['instagram-reel-9x16'], voice: { de: 'translate' } });
  });

  it('service none: Translate is disabled with the reason, and the request keeps the original voice', async () => {
    panel(detail({ ...LOCALES, services: { voice: 'none' } }, version()));
    const translate = within(lang('de')).getByRole('radio', { name: 'Translate' }) as HTMLButtonElement;
    expect(translate.disabled).toBe(true);
    expect(within(lang('de')).getByText('The voice cannot be translated: the voice service is off for this creative')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Translate 2 languages' }));
    await waitFor(() => expect(api.localize).toHaveBeenCalledWith('acme', 'c1', 3, { locales: ['de', 'ja'], voice: { de: 'original', ja: 'original' } }));
  });

  it('no key for the chosen service says so', async () => {
    secrets = [secret('openai', true), secret('elevenlabs', false)];
    panel(detail({ ...LOCALES, services: { voice: 'elevenlabs' } }, version()));
    expect(await within(lang('de')).findByText('The voice cannot be translated: there is no key for the voice service')).toBeTruthy();
    expect((within(lang('de')).getByRole('radio', { name: 'Translate' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a key checked as lacking text-to-speech (F5) says which', async () => {
    secrets = [secret('openai', false), secret('elevenlabs', true)];
    checks = { elevenlabs: { provider: 'elevenlabs', checkedAt: '2026-10-08T10:00:00.000Z', capabilities: [{ capability: 'key', status: 'ok' }, { capability: 'tts', status: 'missing', permission: 'text_to_speech' }] } };
    panel(detail(LOCALES, version()));
    expect(await within(lang('de')).findByText('The voice cannot be translated: the key lacks the text-to-speech permission')).toBeTruthy();
  });

  it('a declined batch is shown from the row (voiceFallback), and Translate stays available to try again', async () => {
    const v = version({ localizations: [row('de', 'instagram-reel-9x16', { voice: 'original', voiceFallback: 'declined' })] });
    panel(detail(LOCALES, v));
    expect(await within(lang('de')).findByText('Last time the voice stayed as it was: the confirmation was declined')).toBeTruthy();
    expect((within(lang('de')).getByRole('radio', { name: 'Translate' }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(lang('ja')).queryByText(/Last time/)).toBeNull();
  });

  it('counts the voice clips that cannot be translated', async () => {
    const v = version({ localizations: [row('de', 'instagram-reel-9x16', { noScript: ['narration', 'jingle'] })] });
    panel(detail(LOCALES, v));
    expect(await within(lang('de')).findByText("2 voice clips can't be translated: they have no known script")).toBeTruthy();
  });
});

describe('LanguagesPanel · the turn at work', () => {
  const batch: ApprovalRequest = {
    id: 'b1', jobId: 'job-9', projectSlug: 'acme', creativeSlug: 'c1', kind: 'paid-batch', title: 'Generate 2 voices with ElevenLabs', detail: '', toolName: 'provider:tts-elevenlabs',
    alwaysRule: 'provider:tts-elevenlabs', explanation: null, agentReason: null, createdAt: '2026-10-08T10:00:00.000Z', expiresAt: '2026-10-08T10:10:00.000Z',
    paidBatch: { provider: 'elevenlabs', calls: [{ label: 'German · Reel', chars: 100 }, { label: 'Japanese · Reel', chars: 80 }], estimate: '$0.10' },
  };
  const job: JobSummary = { id: 'job-9', key: 'creative:acme:c1', kind: 'localize', label: 'Translate', state: 'running', createdAt: '2026-10-08T10:00:00.000Z' };

  it('shows the batch card inline while the job runs, with Approve / Always / Decline, and blocks a second request', async () => {
    panel(detail(LOCALES, version()), live([job], [batch]));
    const card = await screen.findByRole('group', { name: 'Generate 2 voices with ElevenLabs' });
    expect(within(card).getByText('Estimate $0.10')).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(api.decideApproval).toHaveBeenCalledWith('b1', 'once');
    expect((screen.getByRole('button', { name: 'Translate 2 languages' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says the agent is translating when no confirmation is pending', () => {
    panel(detail(LOCALES, version()), live([job]));
    expect(screen.getByText('The agent is translating…')).toBeTruthy();
  });

  it('opens the review table of a translation', async () => {
    const v = version({ localizations: [row('de', 'instagram-reel-9x16')] });
    panel(detail(LOCALES, v));
    await userEvent.click(within(lang('de')).getByRole('button', { name: 'Review Story/Reel 9:16' }));
    expect(await screen.findByText('This format has no text to translate')).toBeTruthy();
    expect(api.getEditorComposition).toHaveBeenCalledWith('acme', 'c1', 3, 'instagram-reel-9x16');
  });
});

describe('BriefLanguages', () => {
  it('without a primary language it is one quiet field: no extra language controls', () => {
    render(<I18nProvider locale="en"><BriefLanguages value={undefined} onChange={() => {}} /></I18nProvider>);
    expect(screen.getByRole('button', { name: /Original language/ }).textContent).toContain('None (one language)');
    expect(screen.queryByRole('group', { name: 'Languages to translate into' })).toBeNull();
  });

  it('picks the primary language and the extra ones from the list, at most ten', async () => {
    const onChange = vi.fn();
    const r = render(<I18nProvider locale="en"><BriefLanguages value={undefined} onChange={onChange} /></I18nProvider>);
    await userEvent.click(screen.getByRole('button', { name: /Original language/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Italian' }));
    expect(onChange).toHaveBeenCalledWith({ primary: 'it', extra: [] });
    r.unmount();
    const extra = ['en', 'fr', 'de', 'es', 'pt', 'nl', 'sv', 'da', 'nb', 'fi'] as const;
    const next = vi.fn();
    render(<I18nProvider locale="en"><BriefLanguages value={{ primary: 'it', extra: [...extra] }} onChange={next} /></I18nProvider>);
    const group = screen.getByRole('group', { name: 'Languages to translate into' });
    expect(screen.getByText('Translate into (10 of 10)')).toBeTruthy();
    const polish = within(group).getByRole('button', { name: 'Polish' });
    expect(polish.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(polish);
    expect(next).not.toHaveBeenCalled();
    await userEvent.click(within(group).getByRole('button', { name: 'French' }));
    expect(next).toHaveBeenCalledWith({ primary: 'it', extra: extra.filter((x) => x !== 'fr') });
  });

  it('lists the right-to-left languages disabled in the primary language list too', async () => {
    render(<I18nProvider locale="en"><BriefLanguages value={undefined} onChange={() => {}} /></I18nProvider>);
    await userEvent.click(screen.getByRole('button', { name: /Original language/ }));
    for (const name of ['Arabic', 'Hebrew', 'Persian', 'Urdu']) expect(screen.getByRole('option', { name: new RegExp('^' + name) }).getAttribute('aria-disabled')).toBe('true');
  });

  it('shows the right-to-left languages disabled, with the reason', async () => {
    const onChange = vi.fn();
    render(<I18nProvider locale="en"><BriefLanguages value={{ primary: 'en', extra: [] }} onChange={onChange} /></I18nProvider>);
    const group = screen.getByRole('group', { name: 'Languages to translate into' });
    for (const name of ['Arabic', 'Hebrew', 'Persian', 'Urdu']) {
      const chip = within(group).getByRole('button', { name });
      expect(chip.getAttribute('aria-disabled')).toBe('true');
      expect(chip.getAttribute('title')).toMatch(/^Right-to-left languages are not supported yet/);
      await userEvent.click(chip);
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getAllByText(/Right-to-left languages are not supported yet/).length).toBeGreaterThan(0);
  });

  it('in Italian the reason is Italian', () => {
    render(<I18nProvider locale="it"><BriefLanguages value={{ primary: 'it', extra: [] }} onChange={() => {}} /></I18nProvider>);
    expect(screen.getAllByText(/Le lingue da destra a sinistra non sono ancora supportate/).length).toBeGreaterThan(0);
  });
});

describe('Render in several languages', () => {
  const rows = (n: number) => (n === 3 ? [row('de', 'instagram-reel-9x16'), row('ja', 'instagram-reel-9x16')] : []);
  const dialog = () => render(
    <I18nProvider locale="en">
      <RenderLanguagesDialog open onClose={() => {}} slug="acme" creative="c1" plan={[[3, ['instagram-reel-9x16']]]} locales={{ primary: 'en', extra: ['de', 'ja', 'fr'] }}
        rowsOf={rows} labelOf={(f) => f} />
    </I18nProvider>,
  );

  it('offers the original and the translations that exist; a language without a translation is disabled', () => {
    dialog();
    expect(screen.getByRole('checkbox', { name: 'Original (English)' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('checkbox', { name: 'German' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('checkbox', { name: 'French' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders the original and the chosen translations', async () => {
    dialog();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Japanese' }));
    await userEvent.click(screen.getByRole('button', { name: 'Render' }));
    await waitFor(() => expect(api.renderVersion).toHaveBeenCalledTimes(2));
    expect(api.renderVersion).toHaveBeenNthCalledWith(1, 'acme', 'c1', 3, ['instagram-reel-9x16']);
    expect(api.renderVersion).toHaveBeenNthCalledWith(2, 'acme', 'c1', 3, ['instagram-reel-9x16'], { locales: ['de'], force: false });
  });

  it('a failed original render is sent again by the next press; one that started is not', async () => {
    api.renderVersion.mockRejectedValueOnce(new ApiError(503, 'no renderer', 'no-renderer'));
    dialog();
    await userEvent.click(screen.getByRole('checkbox', { name: 'German' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Japanese' }));
    await userEvent.click(screen.getByRole('button', { name: 'Render' }));
    expect((await screen.findByRole('alert')).textContent).toBe('no renderer');
    await userEvent.click(screen.getByRole('button', { name: 'Render' }));
    await waitFor(() => expect(api.renderVersion).toHaveBeenCalledTimes(2));
    expect(api.renderVersion).toHaveBeenLastCalledWith('acme', 'c1', 3, ['instagram-reel-9x16']);
  });

  it('on a 409 shows the list and "Render anyway", which sends force for the translations only', async () => {
    api.renderVersion.mockResolvedValueOnce({ id: 'r0' });
    api.renderVersion.mockRejectedValueOnce(new ApiError(409, 'raw', 'localization-needs-force', undefined, ['German · Reel: 1 outdated', 'Japanese · Reel: 2 problems']));
    dialog();
    await userEvent.click(screen.getByRole('button', { name: 'Render' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('These translations have open problems or outdated texts:')).toBeTruthy();
    expect(within(alert).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['German · Reel: 1 outdated', 'Japanese · Reel: 2 problems']);
    expect(screen.queryByRole('button', { name: 'Render' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Render anyway' }));
    await waitFor(() => expect(api.renderVersion).toHaveBeenCalledTimes(3));
    expect(api.renderVersion).toHaveBeenLastCalledWith('acme', 'c1', 3, ['instagram-reel-9x16'], { locales: ['de', 'ja'], force: true });
    // The original was rendered once.
    expect(api.renderVersion.mock.calls.filter((c) => c.length === 4)).toHaveLength(1);
  });
});

describe('Export in several languages', () => {
  const REEL = 'instagram-reel-9x16';
  const out = { format: REEL, file: `${REEL}.mp4`, width: 1080, height: 1920, durationSec: 6, verified: true, preview: null };
  const v = version({ outputs: [out] });
  const states = { [REEL]: { id: REEL, history: [3], star: { version: 3, manual: false, newer: null, follows: null }, defaultVersion: 3, exportVersion: 3, starFileMissing: false, linkable: [], follows: null } };
  const open = () => render(
    <I18nProvider locale="en">
      <ExportDialog open onClose={() => {}} slug="acme" creative="c1" title="Launch" snapshot={{ versions: [v], states }} presets={DEFAULT_FORMATS} pattern="{title}-{format}-v{v}"
        locales={{ primary: 'en', extra: ['de'] }} />
    </I18nProvider>,
  );
  beforeEach(() => localStorage.setItem('ms.exportFolder', '/out'));

  it('without extra languages the dialog is the old one', () => {
    render(<I18nProvider locale="en"><ExportDialog open onClose={() => {}} slug="acme" creative="c1" title="Launch" snapshot={{ versions: [v], states }} presets={DEFAULT_FORMATS} pattern="{title}" /></I18nProvider>);
    expect(screen.queryByRole('group', { name: 'Languages' })).toBeNull();
  });

  it('exports the original alone as before: no languages in the request', async () => {
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Export 1 file' }));
    await waitFor(() => expect(api.exportPicks).toHaveBeenCalledOnce());
    expect(api.exportPicks.mock.calls[0]![2]).not.toHaveProperty('locales');
    expect(api.prepareExport.mock.calls.every((c) => !('locales' in (c[2] as object)))).toBe(true);
  });

  it('with a translation ticked, sends the languages (and prepares their renders)', async () => {
    open();
    await userEvent.click(screen.getByRole('checkbox', { name: 'German' }));
    await userEvent.click(screen.getByRole('button', { name: 'Export 1 file' }));
    await waitFor(() => expect(api.exportPicks).toHaveBeenCalledOnce());
    expect(api.exportPicks.mock.calls[0]![2]).toMatchObject({ locales: ['en', 'de'] });
    expect(api.prepareExport.mock.calls[0]![2]).toMatchObject({ locales: ['en', 'de'] });
  });

  it('the name preview lists the translated files, named with their language when the pattern has no {locale} (final review I2)', async () => {
    open();
    const preview = () => document.querySelector('.ms-exp-preview')!;
    expect(preview().textContent).toContain('launch-instagram-reel-9x16-v3.mp4');
    expect(preview().textContent).not.toContain('Preview, German');
    await userEvent.click(screen.getByRole('checkbox', { name: 'German' }));
    expect(within(preview() as HTMLElement).getByText('Preview, German')).toBeTruthy();
    expect(within(preview() as HTMLElement).getByText('launch-instagram-reel-9x16-v3-de.mp4')).toBeTruthy();
    // German alone: the original is not listed, the translation keeps its language.
    await userEvent.click(screen.getByRole('checkbox', { name: /English/ }));
    expect(preview().textContent).not.toContain('launch-instagram-reel-9x16-v3.mp4');
    expect(within(preview() as HTMLElement).getByText('launch-instagram-reel-9x16-v3-de.mp4')).toBeTruthy();
  });

  it('a pattern with {locale} names the original with the primary tag and each translation with its own, as the core does', async () => {
    render(
      <I18nProvider locale="en">
        <ExportDialog open onClose={() => {}} slug="acme" creative="c1" title="Launch" snapshot={{ versions: [v], states }} presets={DEFAULT_FORMATS} pattern="{title}-{locale}"
          locales={{ primary: 'en', extra: ['de'] }} />
      </I18nProvider>,
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'German' }));
    const preview = document.querySelector('.ms-exp-preview') as HTMLElement;
    expect(within(preview).getByText('launch-en.mp4')).toBeTruthy();
    expect(within(preview).getByText('launch-de.mp4')).toBeTruthy();
  });

  it('on a 409 shows the list and "Render anyway", which sends force', async () => {
    api.exportPicks.mockRejectedValueOnce(new ApiError(409, 'raw', 'localization-needs-force', undefined, ['German · Reel: 1 outdated']));
    open();
    await userEvent.click(screen.getByRole('checkbox', { name: 'German' }));
    await userEvent.click(screen.getByRole('button', { name: 'Export 1 file' }));
    const alert = await screen.findByText('German · Reel: 1 outdated');
    expect(alert.closest('[role=alert]')!.textContent).toContain('These translations have open problems or outdated texts:');
    await userEvent.click(screen.getByRole('button', { name: 'Render anyway' }));
    await waitFor(() => expect(api.exportPicks).toHaveBeenCalledTimes(2));
    expect(api.exportPicks.mock.calls[1]![2]).toMatchObject({ locales: ['en', 'de'], force: true });
    expect(api.prepareExport.mock.calls.at(-1)![2]).toMatchObject({ force: true });
  });
});
