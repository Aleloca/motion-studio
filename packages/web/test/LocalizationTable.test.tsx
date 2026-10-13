import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Composition, Localization, LocalizationRow } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

class ApiError extends Error { constructor(public status: number, m: string, public code?: string) { super(m); } }
let stored: { warnings?: string[]; overlay: Localization; problems: string[]; stale: string[]; voice: LocalizationRow['voice']; origin: 'agent' | 'editor'; hash: string };
const api = {
  getLocalization: vi.fn(async (..._a: unknown[]) => stored),
  saveLocalization: vi.fn(async (..._a: unknown[]): Promise<typeof stored> => ({ ...stored, origin: 'editor' as const })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { LocalizationTable } = await import('../src/screens/creative/LocalizationTable.tsx');

const composition = {
  $schema: 'motion-studio/composition@1', width: 1080, height: 1920, fps: 30, duration: 6, background: '#000000', fonts: [], scenes: [],
  tracks: [
    { id: 't1', kind: 'text', clips: [
      { id: 'title', type: 'text', name: 'Title', start: 0, duration: 3, props: { text: 'Welcome', fontSize: 80, width: 600 } },
      { id: 'sub', type: 'text', name: 'Subtitle', start: 1, duration: 3, props: { text: 'Fresh ideas', fontSize: 40, width: 600 } },
    ] },
    { id: 't2', kind: 'html', clips: [{ id: 'cta', type: 'html', start: 3, duration: 3, src: 'layers/cta.html', params: { label: { type: 'text', label: 'Button', value: 'Start now' } }, props: {} }] },
  ],
} as unknown as Composition;
const overlay = (): Localization => ({
  $schema: 'motion-studio/localization@1', locale: 'de', instanceId: 'reel', fit: { title: 0.85 }, fonts: [], voices: {},
  texts: { title: { source: 'Welcome', text: 'Willkommen zur neuen Version' } }, params: {},
});
const row = (over: Partial<LocalizationRow> = {}): LocalizationRow => ({ locale: 'de', instanceId: 'reel', hash: 'a'.repeat(64), origin: 'agent', stale: [], voice: 'original', ...over });
const ui = (r: LocalizationRow | undefined, extra: Partial<Parameters<typeof LocalizationTable>[0]> = {}) => (
  <I18nProvider locale="en"><LocalizationTable slug="acme" creative="c1" n={2} locale="de" instanceId="reel" formatLabel="Reel" composition={composition} row={r} voiceReason={null} {...extra} /></I18nProvider>
);
beforeEach(() => {
  vi.clearAllMocks();
  stored = { overlay: overlay(), problems: [], stale: [], voice: 'original', origin: 'agent', hash: 'a'.repeat(64) };
});

describe('LocalizationTable', () => {
  it('lists each text with its source, the translation, the state and the fit', async () => {
    render(ui(row()));
    const title = await screen.findByRole('textbox', { name: 'Translation of Title' });
    await waitFor(() => expect((title as HTMLTextAreaElement).value).toBe('Willkommen zur neuen Version'));
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(within(rows[1]!).getByText('Welcome')).toBeTruthy();
    expect(within(rows[1]!).getByText('OK')).toBeTruthy();
    expect(within(rows[2]!).getByText('Not translated')).toBeTruthy();
    expect(within(rows[3]!).getByText('Start now')).toBeTruthy();
    const fit = screen.getByRole('slider', { name: 'Text size of Title' });
    expect(fit.getAttribute('aria-valuemin')).toBe('70');
    expect(fit.getAttribute('aria-valuemax')).toBe('100');
    expect(fit.getAttribute('aria-valuenow')).toBe('85');
  });

  it('saves the edited texts, the fit and the voice mode through PUT, and shows the answer', async () => {
    render(ui(row()));
    const title = await screen.findByRole('textbox', { name: 'Translation of Title' });
    await waitFor(() => expect((title as HTMLTextAreaElement).value).toBe('Willkommen zur neuen Version'));
    const save = screen.getByRole('button', { name: 'Save translation' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.type(screen.getByRole('textbox', { name: 'Translation of Subtitle' }), 'Frische Ideen');
    await userEvent.type(screen.getByRole('textbox', { name: 'Translation of Button' }), 'Jetzt starten');
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Text size of Title' }), { key: 'ArrowLeft' });
    await userEvent.click(screen.getByRole('radio', { name: 'Mute' }));
    expect(save.disabled).toBe(false);
    await userEvent.click(save);
    await waitFor(() => expect(api.saveLocalization).toHaveBeenCalledOnce());
    expect(api.saveLocalization).toHaveBeenCalledWith('acme', 'c1', 2, 'de', 'reel', {
      texts: { sub: 'Frische Ideen' }, params: { 'cta.label': 'Jetzt starten' }, fit: { title: 0.8 }, voice: 'muted',
    });
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('an emptied translation is removed (null); nothing changed sends nothing', async () => {
    render(ui(row()));
    const title = await screen.findByRole('textbox', { name: 'Translation of Title' });
    await waitFor(() => expect((title as HTMLTextAreaElement).value).not.toBe(''));
    await userEvent.clear(title);
    await userEvent.click(screen.getByRole('button', { name: 'Save translation' }));
    await waitFor(() => expect(api.saveLocalization).toHaveBeenCalledWith('acme', 'c1', 2, 'de', 'reel', { texts: { title: null } }));
  });

  it('shows an overflow inline on its row, and the warnings of the checks below', async () => {
    const problem = 'The translation of "Title" does not fit its box, even at 70% size';
    stored = { ...stored, problems: [problem, 'Something else about the layer'] };
    api.saveLocalization.mockResolvedValueOnce({ ...stored, warnings: ['Layer cta.html: no font declared'] });
    render(ui(row({ problems: [problem, 'Something else about the layer'] })));
    const titleRow = (await screen.findByRole('textbox', { name: 'Translation of Title' })).closest('tr')!;
    await waitFor(() => expect(within(titleRow).getByRole('alert').textContent).toBe(problem));
    expect(within(titleRow).getByText('Outside the box')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Problems of this translation' }).textContent).toBe('Something else about the layer');
    await userEvent.type(screen.getByRole('textbox', { name: 'Translation of Subtitle' }), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save translation' }));
    expect((await screen.findByRole('list', { name: 'Warnings' })).textContent).toBe('Layer cta.html: no font declared');
  });

  it('marks an outdated entry, and a busy core refuses the edit with the reason', async () => {
    stored = { ...stored, stale: ['title'] };
    api.saveLocalization.mockRejectedValueOnce(new ApiError(409, 'raw', 'localization-busy'));
    render(ui(row({ stale: ['title'] })));
    const titleRow = (await screen.findByRole('textbox', { name: 'Translation of Title' })).closest('tr')!;
    await waitFor(() => expect(within(titleRow).getByText('Outdated')).toBeTruthy());
    await userEvent.type(screen.getByRole('textbox', { name: 'Translation of Subtitle' }), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save translation' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The agent is working on this creative: edit the translation when it has finished');
  });

  it('lists the voice clips that cannot be translated, and says why Translate is not offered for the voice', async () => {
    render(ui(row({ noScript: ['narration'] }), { voiceReason: 'noKey' }));
    expect(await screen.findByText("Voice clips that can't be translated")).toBeTruthy();
    expect(screen.getByText('narration: no known script, it keeps the original voice')).toBeTruthy();
    const translate = screen.getByRole('radio', { name: 'Translate' }) as HTMLButtonElement;
    expect(translate.disabled).toBe(true);
    expect(translate.title).toBe('there is no key for the voice service');
  });

  it('a language with no translation yet starts empty and saves as a new translation', async () => {
    render(ui(undefined));
    const title = await screen.findByRole('textbox', { name: 'Translation of Title' });
    expect(api.getLocalization).not.toHaveBeenCalled();
    await userEvent.type(title, 'Willkommen');
    await userEvent.click(screen.getByRole('button', { name: 'Save translation' }));
    await waitFor(() => expect(api.saveLocalization).toHaveBeenCalledWith('acme', 'c1', 2, 'de', 'reel', { texts: { title: 'Willkommen' } }));
  });

  it('is read-only while the agent works', async () => {
    render(ui(row(), { busy: true }));
    expect((await screen.findByRole('textbox', { name: 'Translation of Title' }) as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Save translation' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
