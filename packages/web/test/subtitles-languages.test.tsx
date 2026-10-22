// Task 26 (spec §6.3, §6.5, U8): the subtitle languages in the editor. The switcher of the creative's subtitle languages in the
// header (the route's `lang`; an edit waiting is saved first), "+ Lingua" with the brief's languages first, the stale marks of a
// translation with "Ritraduci" per line and "Ritraduci tutto", the source text under a translated line, deleting a language,
// the editor's default language and the waveform of a localized voice.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CreativeDetail, JobSummary, SubtitleCue, SubtitlesSummary, VersionEntry } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';

const at = '2026-10-22T10:00:00.000Z';
const REEL = 'instagram-reel-9x16';
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const timing = { version: 2, format: REEL, fingerprint: 'f'.repeat(64) };
const version: VersionEntry = {
  n: 2, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: '', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null,
  compositions: [{ format: REEL, dir: `compositions/${REEL}`, hash: '2'.repeat(64) }],
};
const sum = (lang: SubtitlesSummary['lang'], x: Partial<SubtitlesSummary> = {}): SubtitlesSummary =>
  ({ lang, origin: 'speech', cues: 3, edited: 0, hash: H1, timing, timingChanged: false, staleCues: 0, ...x });
let SETS: SubtitlesSummary[] = [];
const detailOf = (): CreativeDetail => ({
  slug: 'lancio', jobKey: 'creative:/w:acme:lancio', versions: [version],
  creative: {
    schemaVersion: 1, title: 'Lancio estivo', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'g', message: 'm', formats: [REEL], durationSec: 6, assets: [], notes: '', locales: { primary: 'it', extra: ['de'] } },
  },
  subtitles: SETS,
});
/** The original speech (it) and its translation (en): `c2`'s source line changed since it was translated. */
const SOURCE: SubtitleCue[] = [
  { id: 'c1', start: 0, end: 1500, text: 'Ciao a tutti' },
  { id: 'c2', start: 2000, end: 3500, text: 'Prenota in due tocchi' },
  { id: 'c3', start: 4000, end: 5000, text: 'A presto' },
];
let TRANSLATED: SubtitleCue[] = [];
const setOf = (lang: string) => ({
  $schema: 'motion-studio/subtitles@1', lang, origin: lang === 'en' ? 'translation' : 'speech', ...(lang === 'en' ? { sourceLang: 'it' } : {}),
  transcript: 'whisper-small', detected: lang, timing: { ...timing, ...(lang === 'de' ? { locale: 'de' } : {}) }, cues: lang === 'en' ? TRANSLATED : SOURCE,
});
class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string, public readonly retryAfterSec?: number,
    public readonly problems?: string[], public readonly dropped?: number) { super(message); }
}
const api = {
  getCreative: vi.fn(async () => detailOf()),
  subtitleSet: vi.fn(async (_s: string, _c: string, lang: string) => ({ set: setOf(lang), hash: H1 })),
  saveSubtitleSet: vi.fn(async (..._a: unknown[]) => ({ hash: H2 })),
  subtitleWaveform: vi.fn(async (..._a: unknown[]) => ({ peaks: [0.2, 0.9, 0.4], durationMs: 6000 })),
  subtitleFile: vi.fn(async () => new Blob([''])),
  startSubtitles: vi.fn(async () => ({ job: { id: 'j1' } })),
  addSubtitleLanguage: vi.fn(async (..._a: unknown[]) => ({ job: { id: 'j2' } })),
  retranslateSubtitles: vi.fn(async (..._a: unknown[]): Promise<{ job: unknown; dropped?: number }> => ({ job: { id: 'j3' } })),
  deleteSubtitleLanguage: vi.fn(async (_s: string, _c: string, lang: string) => ({ deleted: lang })),
  revokePreview: vi.fn(async () => ({ revoked: true })),
  getEditorComposition: vi.fn(async (_s: string, _c: string, n: number, format: string) => ({
    n, format, primaryFormat: format, hash: H1, files: [], fonts: [],
    composition: { $schema: 'motion-studio/composition@1', width: 1080, height: 1920, fps: 30, duration: 6, background: '#000000', fonts: [], scenes: [], tracks: [] },
  })),
  previewSession: vi.fn(async (_s: string, _c: string, n: number, format: string) => ({
    url: `http://127.0.0.1:61234/tok-v${n}/runtime/index.html`, token: `tok-v${n}`, origin: 'http://127.0.0.1:61234',
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), format, hash: H1, width: 1080, height: 1920, duration: 6, fps: 30,
  })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError }));
vi.mock('../src/download.ts', () => ({ saveBlob: vi.fn() }));
vi.mock('../src/components/CompositionPlayer.tsx', async () => {
  const React = await import('react');
  return {
    CompositionMedia: class {},
    CompositionPlayer: () => React.createElement('div', { 'data-testid': 'player' }),
  };
});

const { SubtitlesScreen } = await import('../src/screens/subtitles/SubtitlesScreen.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { __resetPreviewSessions } = await import('../src/components/compositionPreview.ts');
const { entrySubtitleLang, languageJob, noteLanguageJob, noteSubtitleLangs } = await import('../src/screens/subtitles/LangSwitcher.tsx');

let JOBS: Record<string, JobSummary> = {};
const live = (): EventsState => ({ approvals: {}, jobs: JOBS, events: {}, creativeTicks: { 'acme/lancio': 0 }, projectTicks: {} });
function Harness({ lang }: { lang?: SubtitlesSummary['lang'] }) {
  const shell = { route: { name: 'subtitles', slug: 'acme', creative: 'lancio', ...(lang ? { lang } : {}) }, live: live() } as unknown as Shell;
  return <I18nProvider locale="it"><ShellContext.Provider value={shell}><SubtitlesScreen slug="acme" creative="lancio" {...(lang ? { lang } : {})} /></ShellContext.Provider></I18nProvider>;
}
async function open(lang?: SubtitlesSummary['lang']) {
  const r = render(<Harness {...(lang ? { lang } : {})} />);
  await screen.findByRole('list', { name: 'Righe dei sottotitoli' });
  return r;
}
const switcher = () => screen.getByRole('radiogroup', { name: 'Lingue dei sottotitoli' });
const row = (id: string) => document.querySelector(`[data-cue="${id}"]`) as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  location.hash = '';
  JOBS = {};
  SETS = [sum('it'), sum('en', { origin: 'translation', sourceLang: 'it', staleCues: 1 })];
  TRANSLATED = [
    { id: 'c1', start: 0, end: 1500, text: 'Hi everyone', source: { text: 'Ciao a tutti' } },
    { id: 'c2', start: 2000, end: 3500, text: 'Book in three taps', source: { text: 'Prenota in tre tocchi' } },
    { id: 'c3', start: 4000, end: 5000, text: 'See you soon', source: { text: 'A presto' } },
  ];
});
afterEach(() => { vi.clearAllMocks(); __resetPreviewSessions(); });

describe('the language switcher (Task 26)', () => {
  it('lists the creative\'s subtitle languages; picking English opens /subtitles/en', async () => {
    await open('it');
    const group = switcher();
    expect(within(group).getByRole('radio', { name: /Italiano/ }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(within(group).getByRole('radio', { name: /Inglese/ }));
    await waitFor(() => expect(location.hash).toBe('#/p/acme/c/lancio/subtitles/en'));
  });

  it('an edit waiting is saved before the language changes (the save hook is per language)', async () => {
    await open('it');
    const box = within(row('c1')).getByRole('textbox', { name: /Testo/ });
    await userEvent.type(box, '!');
    await userEvent.click(within(switcher()).getByRole('radio', { name: /Inglese/ }));
    await waitFor(() => expect(location.hash).toBe('#/p/acme/c/lancio/subtitles/en'));
    expect(api.saveSubtitleSet).toHaveBeenCalledWith('acme', 'lancio', 'it', expect.objectContaining({ baseHash: H1 }));
  });

  it('a save that fails keeps the language and says why', async () => {
    api.saveSubtitleSet.mockRejectedValue(new Error('rete assente'));
    await open('it');
    await userEvent.type(within(row('c1')).getByRole('textbox', { name: /Testo/ }), '!');
    await userEvent.click(within(switcher()).getByRole('radio', { name: /Inglese/ }));
    expect(await screen.findByText(/non sono salvate/)).toBeTruthy();
    expect(location.hash).toBe('');
    api.saveSubtitleSet.mockResolvedValue({ hash: H2 });
  });

  it('"+ Lingua" lists the brief\'s languages first (de), then the others (fr), never one the creative already has', async () => {
    await open('it');
    await userEvent.click(screen.getByRole('button', { name: '+ Lingua' }));
    const menu = await screen.findByRole('dialog', { name: 'Aggiungi una lingua' });
    const names = within(menu).getAllByRole('button').map((b) => b.textContent);
    expect(names.indexOf('Tedesco')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('Tedesco')).toBeLessThan(names.indexOf('Francese'));
    expect(names).not.toContain('Italiano');
    expect(names).not.toContain('Inglese');
    await userEvent.click(within(menu).getByRole('button', { name: 'Tedesco' }));
    expect(api.addSubtitleLanguage).toHaveBeenCalledWith('acme', 'lancio', 'de');
    await waitFor(() => expect(location.hash).toBe('#/p/acme/c/lancio/subtitles/de'));
  });

  it('a language being made shows that it is on its way', async () => {
    JOBS = { j2: { id: 'j2', key: 'subtitles-translate:/w:acme:lancio:fr', kind: 'subtitles', label: 'x', state: 'running', createdAt: at } as unknown as JobSummary };
    render(<Harness lang="fr" />);
    expect(await screen.findByText('Preparo i sottotitoli in francese…')).toBeTruthy();
    expect(api.subtitleSet).not.toHaveBeenCalledWith('acme', 'lancio', 'fr');
  });
});

describe('the job a language without its set claims (final review T26)', () => {
  const job = (id: string, key: string, state: JobSummary['state'], createdAt: string) => ({ id, key, kind: 'subtitles', label: 'x', state, createdAt }) as unknown as JobSummary;

  it('only a job for this language, asked since the language last had a set', () => {
    const old = job('j1', 'subtitles-translate:/w:acme:t26:fr', 'failed', '2026-10-22T10:00:00.000Z');
    expect(languageJob({ j1: old }, 'acme', 't26', 'fr')).toBe(old);
    // The French set was there after that failure (made again, then deleted): the old failure is not this absence's.
    noteSubtitleLangs('acme', 't26', [{ lang: 'fr' }]);
    expect(languageJob({ j1: old }, 'acme', 't26', 'fr')).toBeNull();
    const later = job('j2', 'subtitles-translate:/w:acme:t26:fr', 'running', new Date(Date.now() + 60_000).toISOString());
    expect(languageJob({ j1: old, j2: later }, 'acme', 't26', 'fr')).toBe(later);
    // The creative's subtitles job is this language's only when it was started for it ("+ Lingua" of its own voice).
    const redo = job('j3', 'subtitles:/w:acme:t26', 'running', new Date(Date.now() + 60_000).toISOString());
    expect(languageJob({ j3: redo }, 'acme', 't26', 'de')).toBeNull();
    noteLanguageJob('acme', 't26', 'de', 'j3');
    expect(languageJob({ j3: redo }, 'acme', 't26', 'de')).toBe(redo);
  });

  it('a transcription running for the creative is not shown as the language on its way', async () => {
    JOBS = { j9: { id: 'j9', key: 'subtitles:/w:acme:lancio', kind: 'subtitles', label: 'x', state: 'running', createdAt: at } as unknown as JobSummary };
    render(<Harness lang="fr" />);
    expect(await screen.findByText('Questa creatività non ha sottotitoli in francese: aggiungili con «+ Lingua».')).toBeTruthy();
    expect(screen.queryByText('Preparo i sottotitoli in francese…')).toBeNull();
  });
});

describe('a translation in the editor (Task 26)', () => {
  it('a stale line is marked, its "Ritraduci" asks for that line; the source text shows under each translated line', async () => {
    await open('en');
    await waitFor(() => expect(within(row('c2')).getByText('Testo originale cambiato')).toBeTruthy());
    expect(within(row('c1')).queryByText('Testo originale cambiato')).toBeNull();
    expect(within(row('c1')).getByText('Ciao a tutti')).toBeTruthy();
    // A stale line shows the source line as it is now.
    expect(within(row('c2')).getByText('Prenota in due tocchi')).toBeTruthy();
    await userEvent.click(within(row('c2')).getByRole('button', { name: 'Ritraduci' }));
    expect(api.retranslateSubtitles).toHaveBeenCalledWith('acme', 'lancio', 'en', { ids: ['c2'] });
  });

  it('"Ritraduci tutto" counts the lines it acts on (not the corrected ones) and says when nothing was left', async () => {
    TRANSLATED = [...TRANSLATED, { id: 'c4', start: 4000, end: 4500, text: 'Mine', edited: true, source: { text: 'Vecchio' } }];
    TRANSLATED = TRANSLATED.filter((c) => c.id !== 'c3').concat({ id: 'c3', start: 4600, end: 5000, text: 'See you soon', source: { text: 'A presto' } });
    await open('en');
    const all = await screen.findByRole('button', { name: /Ritraduci tutto/ });
    expect(all.textContent).toContain('1');
    api.retranslateSubtitles.mockRejectedValueOnce(new ApiError(409, 'Nessuna riga in inglese è da ritradurre.', 'subtitles-nothing-stale', undefined, undefined, 2));
    await userEvent.click(all);
    expect(api.retranslateSubtitles).toHaveBeenCalledWith('acme', 'lancio', 'en', {});
    expect(await screen.findByText(/Nessuna riga in inglese è da ritradurre\./)).toBeTruthy();
    expect(screen.getByText(/2 righe senza più il testo originale/)).toBeTruthy();
  });

  it('a source line with no translation shows "Manca la traduzione" and counts in "Ritraduci tutto" (final review I2)', async () => {
    SOURCE.push({ id: 'c5', start: 6000, end: 7000, text: 'Nuova riga' });
    try {
      await open('en');
      const missing = await screen.findByRole('region', { name: 'Manca la traduzione' });
      expect(within(missing).getByText('Nuova riga')).toBeTruthy();
      // The changed c2 and the missing c5.
      expect((await screen.findByRole('button', { name: /Ritraduci tutto/ })).textContent).toContain('2');
    } finally { SOURCE.pop(); }
  });

  it('a translation not timed as its source: "Ritraduci tutto" counts every source line it translates again (final review I2)', async () => {
    SETS = [sum('it'), sum('en', { origin: 'translation', sourceLang: 'it', timingChanged: true })];
    TRANSLATED = TRANSLATED.map((c) => (c.id === 'c1' ? { ...c, edited: true as const } : c));
    await open('en');
    // c2 and c3: c1 is the user's.
    const all = await screen.findByRole('button', { name: /Ritraduci tutto/ });
    expect(all.textContent).toContain('2');
    await userEvent.click(all);
    expect(api.retranslateSubtitles).toHaveBeenCalledWith('acme', 'lancio', 'en', {});
  });

  it('a translation\'s editor has no "Rifai la trascrizione…": its lines come from the source, not from speech (final review I3)', async () => {
    await open('en');
    expect(screen.queryByRole('button', { name: 'Rifai la trascrizione…' })).toBeNull();
  });

  it('a translation can be deleted, after a confirmation when it has corrected lines; the original speech cannot', async () => {
    SETS = [sum('it'), sum('en', { origin: 'translation', sourceLang: 'it', edited: 2 })];
    TRANSLATED = TRANSLATED.map((c) => (c.id === 'c2' ? c : { ...c, edited: true }));
    await open('en');
    await userEvent.click(screen.getByRole('button', { name: 'Elimina i sottotitoli in inglese' }));
    expect(api.deleteSubtitleLanguage).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('dialog', { name: 'Elimina i sottotitoli in inglese' });
    expect(within(confirm).getByText(/2 righe che hai corretto/)).toBeTruthy();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Elimina' }));
    expect(api.deleteSubtitleLanguage).toHaveBeenCalledWith('acme', 'lancio', 'en');
    await waitFor(() => expect(location.hash).toBe('#/p/acme/c/lancio/subtitles/it'));
  });

  it('the original speech set has no delete while a translation comes from it', async () => {
    await open('it');
    expect(screen.queryByRole('button', { name: /Elimina i sottotitoli/ })).toBeNull();
  });

  it('with no translation from it, the original speech set can be deleted (follow-up ruling)', async () => {
    SETS = [sum('it')];
    await open('it');
    await userEvent.click(screen.getByRole('button', { name: 'Elimina i sottotitoli in italiano' }));
    expect(api.deleteSubtitleLanguage).toHaveBeenCalledWith('acme', 'lancio', 'it');
  });
});

describe('the editor\'s default language and the waveform (Task 26)', () => {
  it('opens the original audio\'s speech set, not the first set', () => {
    const de = sum('de', { timing: { ...timing, locale: 'de' } });
    const en = sum('en', { origin: 'translation', sourceLang: 'it' });
    expect(entrySubtitleLang([en, de, sum('it')], 'fr')).toBe('it');
    expect(entrySubtitleLang([en, de], 'de')).toBe('de');
    expect(entrySubtitleLang([en, de], 'fr')).toBe('en');
    expect(entrySubtitleLang([], 'it')).toBeNull();
  });

  it('without a language in the route the editor opens the original speech set', async () => {
    SETS = [sum('en', { origin: 'translation', sourceLang: 'it' }), sum('it')];
    await open();
    expect(api.subtitleSet).toHaveBeenCalledWith('acme', 'lancio', 'it');
    expect(api.subtitleSet).not.toHaveBeenCalledWith('acme', 'lancio', 'en');
  });

  it('a localized voice\'s set reads the waveform of its own audio', async () => {
    SETS = [sum('it'), sum('de', { timing: { ...timing, locale: 'de' } })];
    await open('de');
    await waitFor(() => expect(api.subtitleWaveform).toHaveBeenCalledWith('acme', 'lancio', 2, 'de'));
    expect(screen.getByRole('button', { name: 'Elimina i sottotitoli in tedesco' })).toBeTruthy();
  });
});
