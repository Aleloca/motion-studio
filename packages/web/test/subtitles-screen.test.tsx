// The subtitle editor screen (Task 12, spec §6.3, layout B): the player on the left with the editor's caption, the list of
// lines on the right (times, text, warnings, actions, "+ Riga", find and replace), the keyboard and the downloads.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CreativeDetail, SubtitleCue, VersionEntry } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';

const at = '2026-10-22T10:00:00.000Z';
const REEL = 'instagram-reel-9x16';
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const v2 = (n: number): VersionEntry => ({
  n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: '', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null,
  compositions: [{ format: REEL, dir: `compositions/${REEL}`, hash: String(n).repeat(64) }],
});
const detail: CreativeDetail = {
  slug: 'lancio', jobKey: 'creative:/w:acme:lancio', versions: [v2(1), v2(2)],
  creative: {
    schemaVersion: 1, title: 'Lancio estivo', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'g', message: 'm', formats: [REEL], durationSec: 6, assets: [], notes: '' },
  },
  subtitles: [{ lang: 'it', origin: 'speech', cues: 3, edited: 0, hash: H1, timing: { version: 2, format: REEL, fingerprint: 'f'.repeat(64) }, timingChanged: false, staleCues: 0 }],
};
let CUES: SubtitleCue[] = [];
const setOf = (cues: SubtitleCue[]) => ({
  $schema: 'motion-studio/subtitles@1', lang: 'it', origin: 'speech', transcript: 'whisper-small', detected: 'it',
  timing: { version: 2, format: REEL, fingerprint: 'f'.repeat(64) }, cues,
});
class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) { super(message); }
}
const api = {
  getCreative: vi.fn(async () => detail),
  subtitleSet: vi.fn(async (..._a: unknown[]) => ({ set: setOf(CUES), hash: H1 })),
  saveSubtitleSet: vi.fn(async (..._a: unknown[]) => ({ hash: H2 })),
  subtitleFile: vi.fn(async (..._a: unknown[]) => new Blob(['1\n00:00:00,000 --> 00:00:01,500\nCiao\n'])),
  revokePreview: vi.fn(async (..._a: unknown[]) => ({ revoked: true })),
  previewSession: vi.fn(async (_s: string, _c: string, n: number, format: string) => ({
    url: `http://127.0.0.1:61234/tok-v${n}/runtime/index.html?mode=preview`, token: `tok-v${n}`, origin: 'http://127.0.0.1:61234',
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), format, hash: H1, width: 1080, height: 1920, duration: 6, fps: 30,
  })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const saveBlob = vi.fn();
vi.mock('../src/download.ts', () => ({ saveBlob }));

// A fake of the player (the real one needs a runtime frame): the media contract the screen uses.
const media = vi.hoisted(() => {
  const events = new EventTarget();
  const m = {
    currentTime: 0, duration: 6, loop: false, playbackRate: 1, paused: true,
    play: vi.fn(async () => { m.paused = false; events.dispatchEvent(new Event('play')); }),
    pause: vi.fn(() => { m.paused = true; events.dispatchEvent(new Event('pause')); }),
    addEventListener: (t: string, l: EventListener) => events.addEventListener(t, l),
    removeEventListener: (t: string, l: EventListener) => events.removeEventListener(t, l),
    emit: (t: string) => events.dispatchEvent(new Event(t)),
  };
  return m;
});
vi.mock('../src/components/CompositionPlayer.tsx', async () => {
  const React = await import('react');
  return {
    CompositionMedia: class {},
    CompositionPlayer: (p: { session: { token: string }; onMedia?(m: unknown): void }) => {
      const props = React.useRef(p);
      props.current = p;
      React.useEffect(() => { props.current.onMedia?.(media); return () => props.current.onMedia?.(null); }, []);
      return React.createElement('div', { 'data-testid': 'player', 'data-token': p.session.token });
    },
  };
});

const { SubtitlesScreen } = await import('../src/screens/subtitles/SubtitlesScreen.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { __resetPreviewSessions } = await import('../src/components/compositionPreview.ts');
const { SAVE_DEBOUNCE_MS } = await import('../src/screens/subtitles/useSubtitleSave.ts');

const liveWith = (tick: number): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: { 'acme/lancio': tick }, projectTicks: {} });
function Harness({ tick = 0 }: { tick?: number }) {
  const shell = { route: { name: 'subtitles', slug: 'acme', creative: 'lancio', lang: 'it' }, live: liveWith(tick) } as unknown as Shell;
  return <I18nProvider locale="it"><ShellContext.Provider value={shell}><SubtitlesScreen slug="acme" creative="lancio" lang="it" /></ShellContext.Provider></I18nProvider>;
}
async function open(tick = 0) {
  const r = render(<Harness tick={tick} />);
  await screen.findByRole('list', { name: 'Righe dei sottotitoli' });
  await screen.findByTestId('player');
  // The player is ready once it has reported its duration.
  await waitFor(() => expect((screen.getByRole('button', { name: 'Riproduci' }) as HTMLButtonElement).disabled).toBe(false));
  return r;
}
const rows = () => within(screen.getByRole('list', { name: 'Righe dei sottotitoli' })).getAllByRole('listitem');

beforeEach(() => {
  // The previous screen's last save (sent when it unmounts) may land after its own clean-up.
  vi.clearAllMocks();
  CUES = [
    { id: 'c1', start: 0, end: 1500, text: 'Ciao a tutti' },
    { id: 'c2', start: 2000, end: 3500, text: 'Prenota in tre tocchi' },
    { id: 'c3', start: 4000, end: 5000, text: 'Questa riga è decisamente troppo lunga per un secondo' },
  ];
  media.currentTime = 0;
  media.paused = true;
});
afterEach(() => { vi.clearAllMocks(); __resetPreviewSessions(); });

describe('the subtitle editor screen (Task 12)', () => {
  it('shows one row per cue with its start, end and text', async () => {
    await open();
    expect(rows()).toHaveLength(3);
    expect((screen.getByRole('textbox', { name: 'Inizio della riga 1' }) as HTMLInputElement).value).toBe('00:00.000');
    expect((screen.getByRole('textbox', { name: 'Fine della riga 1' }) as HTMLInputElement).value).toBe('00:01.500');
    expect((screen.getByRole('textbox', { name: 'Testo della riga 2' }) as HTMLInputElement).value).toBe('Prenota in tre tocchi');
    expect((screen.getByRole('textbox', { name: 'Fine della riga 3' }) as HTMLInputElement).value).toBe('00:05.000');
    expect(api.previewSession).toHaveBeenCalledWith('acme', 'lancio', 2, REEL, expect.any(String));
  });

  it('typing in a row\'s text changes the cue and shows "Salvataggio…", then saves it over the loaded hash', async () => {
    await open();
    expect(screen.getByRole('status', { name: 'Stato del salvataggio' }).textContent).toContain('Salvato');
    const box = screen.getByRole('textbox', { name: 'Testo della riga 1' });
    await userEvent.type(box, ' quanti');
    expect((box as HTMLInputElement).value).toBe('Ciao a tutti quanti');
    expect(screen.getByRole('status', { name: 'Stato del salvataggio' }).textContent).toContain('Salvataggio…');
    await waitFor(() => expect(api.saveSubtitleSet).toHaveBeenCalled(), { timeout: SAVE_DEBOUNCE_MS + 2000 });
    const body = api.saveSubtitleSet.mock.calls.at(-1)![3] as { baseHash: string; cues: SubtitleCue[] };
    expect(body.baseHash).toBe(H1);
    expect(body.cues[0]).toMatchObject({ id: 'c1', text: 'Ciao a tutti quanti', edited: true });
    await waitFor(() => expect(screen.getByRole('status', { name: 'Stato del salvataggio' }).textContent).toContain('Salvato'));
  });

  it('a space typed at the end of the text stays in the box while the cue keeps its trimmed text', async () => {
    await open();
    const box = screen.getByRole('textbox', { name: 'Testo della riga 1' });
    await userEvent.type(box, ' ');
    expect((box as HTMLInputElement).value).toBe('Ciao a tutti ');
  });

  it('clicking a row seeks the player to its start and selects it', async () => {
    await open();
    await userEvent.click(within(rows()[1]!).getByText('2'));
    expect(media.currentTime).toBe(2);
    expect(rows()[1]!.getAttribute('aria-current')).toBe('true');
  });

  it('↓ selects the next cue (and seeks to it), ↑ the previous one; never from inside a text box', async () => {
    await open();
    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    expect(rows()[0]!.getAttribute('aria-current')).toBe('true');
    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    expect(rows()[1]!.getAttribute('aria-current')).toBe('true');
    expect(media.currentTime).toBe(2);
    fireEvent.keyDown(document.body, { key: 'ArrowUp' });
    expect(rows()[0]!.getAttribute('aria-current')).toBe('true');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Testo della riga 1' }), { key: 'ArrowDown' });
    expect(rows()[0]!.getAttribute('aria-current')).toBe('true');
  });

  it('Space plays and pauses, but not inside a text box', async () => {
    await open();
    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
    expect(media.play).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Testo della riga 1' }), { key: ' ', code: 'Space' });
    expect(media.pause).not.toHaveBeenCalled();
  });

  it('the caption over the player shows the cue under the playhead', async () => {
    await open();
    expect(screen.getByTestId('subs-caption').textContent).toContain('Ciao a tutti');
    act(() => { media.currentTime = 2.5; media.emit('timeupdate'); });
    expect(screen.getByTestId('subs-caption').textContent).toContain('Prenota in tre tocchi');
    expect(rows()[1]!.classList.contains('ms-now')).toBe(true);
    act(() => { media.currentTime = 1.8; media.emit('timeupdate'); });
    expect(screen.queryByTestId('subs-caption')).toBeNull();
  });

  it('a cue too fast to read shows its warning chip with an explanation', async () => {
    await open();
    const chip = within(rows()[2]!).getByText('Troppo veloce');
    expect(chip.closest('[title]')!.getAttribute('title')).toMatch(/17 caratteri al secondo/);
    expect(within(rows()[0]!).queryByText('Troppo veloce')).toBeNull();
  });

  it('"+ Riga" adds a line at the playhead: its text box is focused with "…" selected, and it is flagged until written', async () => {
    await open();
    act(() => { media.currentTime = 1.6; media.emit('timeupdate'); });
    await userEvent.click(screen.getByRole('button', { name: '+ Riga' }));
    expect(rows()).toHaveLength(4);
    const box = screen.getByRole('textbox', { name: 'Testo della riga 2' }) as HTMLTextAreaElement;
    expect(box.value).toBe('\u2026');
    expect(document.activeElement).toBe(box);
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, 1]);
    expect(within(rows()[1]!).getByText('Da scrivere')).toBeTruthy();
    await userEvent.keyboard('Benvenuti');
    expect(within(rows()[1]!).queryByText('Da scrivere')).toBeNull();
  });

  it('row actions: delete, merge with the next, undo with ⌘Z / Ctrl+Z', async () => {
    await open();
    await userEvent.click(within(rows()[0]!).getByRole('button', { name: 'Unisci con la successiva' }));
    expect(rows()).toHaveLength(2);
    expect((screen.getByRole('textbox', { name: 'Testo della riga 1' }) as HTMLInputElement).value).toBe('Ciao a tutti Prenota in tre tocchi');
    await userEvent.click(within(rows()[1]!).getByRole('button', { name: 'Elimina la riga' }));
    expect(rows()).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(rows()).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Ripeti' }));
    expect(rows()).toHaveLength(1);
    // The keyboard: ⌘Z on macOS, Ctrl+Z elsewhere, also from inside a line's text box.
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Testo della riga 1' }), { key: 'z', metaKey: mac, ctrlKey: !mac });
    expect(rows()).toHaveLength(2);
    fireEvent.keyDown(document.body, { key: 'z', shiftKey: true, metaKey: mac, ctrlKey: !mac });
    expect(rows()).toHaveLength(1);
  });

  it('an edited start time is parsed and applied; a wrong one goes back', async () => {
    await open();
    const start = screen.getByRole('textbox', { name: 'Inizio della riga 2' });
    await userEvent.clear(start);
    await userEvent.type(start, '00:01.800{Enter}');
    expect((start as HTMLInputElement).value).toBe('00:01.800');
    await userEvent.clear(start);
    await userEvent.type(start, 'abc');
    fireEvent.blur(start);
    expect((start as HTMLInputElement).value).toBe('00:01.800');
  });

  it('find and replace changes every matching line', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Trova e sostituisci' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Trova' }), 'tre');
    expect(screen.getByText('1 riga')).toBeTruthy();
    await userEvent.type(screen.getByRole('textbox', { name: 'Sostituisci con' }), 'due');
    await userEvent.click(screen.getByRole('button', { name: 'Sostituisci tutto' }));
    expect((screen.getByRole('textbox', { name: 'Testo della riga 2' }) as HTMLInputElement).value).toBe('Prenota in due tocchi');
  });

  it('the header downloads the .srt and .vtt with the UI token, after a waiting edit is saved', async () => {
    await open();
    await userEvent.type(screen.getByRole('textbox', { name: 'Testo della riga 1' }), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Scarica .srt' }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), 'lancio.it.srt'));
    expect(api.saveSubtitleSet).toHaveBeenCalledTimes(1);
    expect(api.saveSubtitleSet.mock.invocationCallOrder[0]!).toBeLessThan(api.subtitleFile.mock.invocationCallOrder[0]!);
    expect(api.subtitleFile).toHaveBeenCalledWith('acme', 'lancio', 'it', 'srt');
  });

  it('a save conflict says the lines were changed elsewhere', async () => {
    api.saveSubtitleSet.mockRejectedValueOnce(new ApiError(409, 'changed', 'subtitles-conflict'));
    await open();
    await userEvent.type(screen.getByRole('textbox', { name: 'Testo della riga 1' }), '!');
    await waitFor(() => expect(screen.getByRole('status', { name: 'Stato del salvataggio' }).textContent).toContain('Modificati altrove'), { timeout: SAVE_DEBOUNCE_MS + 2000 });
  });

  it('a subtitles broadcast reloads the set when nothing is unsaved, and not over an edit waiting to be saved', async () => {
    const r = await open(0);
    CUES = [{ id: 'c1', start: 0, end: 1500, text: 'Rifatti dal job' }];
    r.rerender(<Harness tick={1} />);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect((screen.getByRole('textbox', { name: 'Testo della riga 1' }) as HTMLInputElement).value).toBe('Rifatti dal job');

    await userEvent.type(screen.getByRole('textbox', { name: 'Testo della riga 1' }), '!');
    CUES = [{ id: 'c1', start: 0, end: 1500, text: 'Altro' }, { id: 'c9', start: 2000, end: 3000, text: 'Nuova' }];
    const calls = api.subtitleSet.mock.calls.length;
    r.rerender(<Harness tick={2} />);
    await waitFor(() => expect(api.subtitleSet.mock.calls.length).toBeGreaterThan(calls));
    expect(rows()).toHaveLength(1);
    expect((screen.getByRole('textbox', { name: 'Testo della riga 1' }) as HTMLInputElement).value).toBe('Rifatti dal job!');
  });

  describe('fix round 1', () => {
    const mac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    const chord = (o: { shift?: boolean; repeat?: boolean } = {}) => ({ key: 'z', shiftKey: Boolean(o.shift), repeat: Boolean(o.repeat), metaKey: mac(), ctrlKey: !mac() });

    it('a held ⌘Z / ⇧⌘Z in a text box or a time field is always the lines\' undo: repeats are default-prevented and step the model', async () => {
      await open();
      await userEvent.click(within(rows()[0]!).getByRole('button', { name: 'Elimina la riga' }));
      await userEvent.click(within(rows()[0]!).getByRole('button', { name: 'Elimina la riga' }));
      expect(rows()).toHaveLength(1);
      const box = screen.getByRole('textbox', { name: 'Testo della riga 1' });
      expect(fireEvent.keyDown(box, chord())).toBe(false);
      expect(rows()).toHaveLength(2);
      expect(fireEvent.keyDown(box, chord({ repeat: true }))).toBe(false);
      expect(rows()).toHaveLength(3);
      const time = screen.getByRole('textbox', { name: 'Inizio della riga 1' });
      expect(fireEvent.keyDown(time, chord({ shift: true, repeat: true }))).toBe(false);
      expect(rows()).toHaveLength(2);
      // The find and replace fields keep their own undo.
      await userEvent.click(screen.getByRole('button', { name: 'Trova e sostituisci' }));
      expect(fireEvent.keyDown(screen.getByRole('textbox', { name: 'Trova' }), chord({ repeat: true }))).toBe(true);
      expect(rows()).toHaveLength(2);
    });

    it('typing in one line is one undo step', async () => {
      await open();
      await userEvent.type(screen.getByRole('textbox', { name: 'Testo della riga 1' }), ' quanti');
      await userEvent.click(screen.getByRole('button', { name: 'Annulla' }));
      expect((screen.getByRole('textbox', { name: 'Testo della riga 1' }) as HTMLTextAreaElement).value).toBe('Ciao a tutti');
      expect((screen.getByRole('button', { name: 'Annulla' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('a download whose waiting edit could not be saved does not download: it says why', async () => {
      api.saveSubtitleSet.mockRejectedValueOnce(new ApiError(500, 'disk full'));
      await open();
      await userEvent.type(screen.getByRole('textbox', { name: 'Testo della riga 1' }), '!');
      await userEvent.click(screen.getByRole('button', { name: 'Scarica .vtt' }));
      expect((await screen.findByRole('alert')).textContent).toMatch(/^Download non riuscito: /);
      expect(api.subtitleFile).not.toHaveBeenCalled();
      expect(saveBlob).not.toHaveBeenCalled();
    });

    it('a download after a conflict waits for the merged save, then downloads', async () => {
      api.saveSubtitleSet.mockRejectedValueOnce(new ApiError(409, 'changed', 'subtitles-conflict'));
      await open();
      await userEvent.type(screen.getByRole('textbox', { name: 'Testo della riga 1' }), '!');
      await userEvent.click(screen.getByRole('button', { name: 'Scarica .srt' }));
      await waitFor(() => expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), 'lancio.it.srt'));
      expect(api.saveSubtitleSet).toHaveBeenCalledTimes(2);
      expect((api.saveSubtitleSet.mock.calls[1]![3] as { cues: SubtitleCue[] }).cues[0]!.text).toBe('Ciao a tutti!');
      expect(api.saveSubtitleSet.mock.invocationCallOrder[1]!).toBeLessThan(api.subtitleFile.mock.invocationCallOrder[0]!);
    });

    it('the list follows playback, but not while the focus is inside it', async () => {
      const scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll;
      try {
        await open();
        fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
        scroll.mockClear();
        act(() => { media.currentTime = 2.5; media.emit('timeupdate'); });
        expect(scroll).toHaveBeenCalled();
        screen.getByRole('textbox', { name: 'Testo della riga 3' }).focus();
        scroll.mockClear();
        act(() => { media.currentTime = 4.5; media.emit('timeupdate'); });
        expect(scroll).not.toHaveBeenCalled();
      } finally { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; }
    });
  });
});
