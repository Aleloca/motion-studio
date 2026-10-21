import type { AssetEntry, SidecarHeader, VideoAnalysisView } from '@motion-studio/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';

export const HEADER: SidecarHeader = {
  format: 'motion-studio-video-analysis/1', asset: 'assets/intro.mp4', sha256: 'a'.repeat(64), bytes: 1000, durationSec: 31, width: 640, height: 360,
  fps: 25, hasAudio: true, transcript: 'whisper-small', language: 'it', generator: 'Motion Studio · x', createdAt: '2026-10-21T10:00:00.000Z', edited: false,
};
export const BODY = [
  '## Summary', 'A product demo on white.', '', '## Timeline',
  '- [00:00–00:12] Intro on a white background',
  '- [00:12–00:18] Logo on white', '  - On-screen text: "ACME", "Since 1990"', '  - [00:13.2] "Benvenuti"',
  '', '## Usable moments', '- [00:12–00:18] Clean logo reveal', '', '## Look', '- Colours: #ffffff', '',
  '## Transcript', 'Automatic transcript: names may be wrong.', '- [00:13.2–00:13.9] Benvenuti', '', '## Tags', 'demo, logo', '',
].join('\n');
const ready = (over: Partial<VideoAnalysisView> = {}): VideoAnalysisView =>
  ({ file: 'assets/intro.mp4', state: 'ready', jobId: null, error: null, pending: null, header: HEADER, body: BODY, ...over });

const api = {
  analyzeVideo: vi.fn(async (_s: string, file: string, _o?: boolean): Promise<VideoAnalysisView> => ready({ file, state: 'queued' })),
  saveAnalysisBody: vi.fn(async (_s: string, file: string, body: string): Promise<VideoAnalysisView> => ready({ file, body, header: { ...HEADER, edited: true } })),
  cancelVideoAnalysis: vi.fn(async () => ({ cancelled: true })),
  listVideoAnalyses: vi.fn(async (): Promise<VideoAnalysisView[]> => [ready(), ready({ file: 'assets/other.mp4', state: 'none', header: null, body: null })]),
  listAssets: vi.fn(async () => ({ error: null, unregistered: [], assets: [video('intro.mp4'), video('other.mp4')] })),
  getBrand: vi.fn(async () => ({ jobKey: 'brand:k' })),
  getProject: vi.fn(async () => ({ slug: 'acme', jobKey: 'k', project: { name: 'Acme' } })),
  getBriefSession: vi.fn(async () => null),
  projectFileUrl: (s: string, r: string) => `/f/${s}/${r}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { constructor(public status: number, m: string, public code?: string) { super(m); } } }));
const { AnalysisSection } = await import('../src/screens/assets/AnalysisSection.tsx');
const { Assets } = await import('../src/screens/Assets.tsx');
afterEach(() => vi.clearAllMocks());

function video(file: string): AssetEntry {
  return { file, kind: 'video', origin: 'upload', sourceUrl: null, description: '', tags: [], width: 640, height: 360, addedAt: '2026-10-21T10:00:00.000Z', attribution: null, durationSec: 31 };
}
const it_ = (node: React.ReactNode) => render(<I18nProvider locale="it">{node}</I18nProvider>);

describe('the library\'s Analisi section (Task 19)', () => {
  it('ready: the state, the summary, the scenes with on-screen text and speech, the transcript and the tags; a row seeks the player', async () => {
    const onSeek = vi.fn();
    it_(<AnalysisSection slug="acme" view={ready()} onSeek={onSeek} />);
    const section = screen.getByRole('region', { name: 'Analisi' });
    expect(within(section).getByText('Pronta')).toBeTruthy();
    expect(within(section).getByText('A product demo on white.')).toBeTruthy();
    const logo = within(section).getByRole('button', { name: 'Vai a 0:12 · Logo on white' });
    expect(logo.textContent).toContain('ACME');
    expect(logo.textContent).toContain('Benvenuti');
    await userEvent.click(logo);
    expect(onSeek).toHaveBeenCalledWith(12);
    await userEvent.click(within(section).getByRole('button', { name: 'Vai a 0:13 · Benvenuti' }));
    expect(onSeek).toHaveBeenLastCalledWith(13.2);
    expect(within(section).getByText('demo')).toBeTruthy();
    expect(within(section).getByText('Trascrizione automatica: i nomi possono essere sbagliati.')).toBeTruthy();
  });

  it('Rianalizza on an edited analysis asks first, then sends overwrite', async () => {
    it_(<AnalysisSection slug="acme" view={ready({ header: { ...HEADER, edited: true } })} onSeek={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Rianalizza' }));
    expect(api.analyzeVideo).not.toHaveBeenCalled();
    const ask = screen.getByRole('group', { name: 'L\'analisi è stata modificata: sovrascriverla?' });
    await userEvent.click(within(ask).getByRole('button', { name: 'Sovrascrivi' }));
    expect(api.analyzeVideo).toHaveBeenCalledWith('acme', 'assets/intro.mp4', true);
  });

  it('Rianalizza on an analysis not edited starts at once', async () => {
    it_(<AnalysisSection slug="acme" view={ready()} onSeek={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Rianalizza' }));
    expect(api.analyzeVideo).toHaveBeenCalledWith('acme', 'assets/intro.mp4', undefined);
  });

  it('Modifica saves the edited text', async () => {
    const onView = vi.fn();
    it_(<AnalysisSection slug="acme" view={ready()} onSeek={() => {}} onView={onView} />);
    await userEvent.click(screen.getByRole('button', { name: 'Modifica' }));
    const box = screen.getByRole('textbox', { name: 'Testo dell\'analisi' });
    fireEvent.change(box, { target: { value: 'Le mie note' } });
    await userEvent.click(screen.getByRole('button', { name: 'Salva' }));
    expect(api.saveAnalysisBody).toHaveBeenCalledWith('acme', 'assets/intro.mp4', 'Le mie note');
    expect(onView.mock.calls[0]![0].header.edited).toBe(true);
  });

  it('a body reshaped by hand is shown raw; none offers Analizza; running offers Ferma', async () => {
    const { unmount } = it_(<AnalysisSection slug="acme" view={ready({ body: 'Le mie note', header: { ...HEADER, edited: true } })} onSeek={() => {}} />);
    expect(screen.getByText('Le mie note', { selector: 'pre' })).toBeTruthy();
    unmount();
    const { unmount: u2 } = it_(<AnalysisSection slug="acme" view={ready({ state: 'none', header: null, body: null })} onSeek={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Analizza' }));
    expect(api.analyzeVideo).toHaveBeenCalledWith('acme', 'assets/intro.mp4', undefined);
    u2();
    it_(<AnalysisSection slug="acme" view={ready({ state: 'running', body: null, header: null })} onSeek={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ferma' }));
    expect(api.cancelVideoAnalysis).toHaveBeenCalledWith('acme', 'assets/intro.mp4');
  });

  it('the tile shows the "analizzato" mark only for a ready analysis', async () => {
    const live: EventsState = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} };
    it_(<Assets slug="acme" live={live} />);
    await waitFor(() => expect(screen.getAllByRole('img', { name: 'Analizzato' })).toHaveLength(1));
    const card = screen.getByRole('img', { name: 'Analizzato' }).closest('[data-file]') as HTMLElement;
    expect(card.dataset.file).toBe('intro.mp4');
  });
});
