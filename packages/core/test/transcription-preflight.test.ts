/**
 * The audio check before a transcription choice (review of phase 2, item 2): it never sits on a creative's first turn. The
 * analysis is queued at once, held with `transcription-check`, and the check (audio extraction, silence) runs in the
 * background with its own signal; a Stop or a Salta of the waiting turn answers at once.
 */
import { writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { CommandExec, CommandResult } from '../src/exec.ts';
import type { MediaTools } from '../src/media/media-tools.ts';
import { analysisApp, analysisHelpers } from './helpers/analysis-app.ts';

const media = (real: MediaTools): MediaTools => ({ ...real, available: true, probe: async () => ({ width: 640, height: 360, durationSec: 20, fps: 25, audio: true }) });

/** An ffmpeg whose audio extraction hangs until its signal is aborted; `aborted` counts the aborted extractions. */
function hangingFf() {
  const state = { started: 0, aborted: 0, release: () => {} };
  let releaseAll!: () => void;
  const released = new Promise<void>((r) => { releaseAll = r; });
  state.release = releaseAll;
  const exec: CommandExec = async (cmd, args, opts) => {
    const ok: CommandResult = { code: 0, stdout: '', stderr: '', notFound: false };
    if (cmd !== 'ffmpeg' || !args.includes('pcm_s16le')) return ok;
    state.started++;
    return new Promise<CommandResult>((resolve) => {
      opts?.signal?.addEventListener('abort', () => { state.aborted++; resolve({ ...ok, code: -1, aborted: true }); }, { once: true });
      void released.then(() => resolve({ ...ok, code: 1 }));
    });
  };
  return { exec, state };
}

describe('the transcription pre-check is off the turn\'s path', () => {
  it('ensure answers at once: the job is queued and held with transcription-check while the audio is checked', async () => {
    const ff = hangingFf();
    const t = await analysisApp({ media, ffExec: ff.exec, transcription: { method: 'ask' } });
    const h = analysisHelpers(t);
    const file = await h.put('clip.mp4', 'fake video');
    const [v] = await t.analyses.ensure(t.ref, [file], { from: 'brief' });
    expect(v!.state).toBe('queued');
    expect((await h.analysisJobs())[0]).toMatchObject({ state: 'queued', waitReason: 'transcription-check' });
    // A first turn waits for it (it is not asking the user yet).
    expect(t.analyses.activeFor(t.ref, [file])).toHaveLength(1);
    await vi.waitFor(() => expect(ff.state.started).toBe(1));
    ff.state.release();
    // The check could not read the audio: no question, the analysis goes ahead.
    await vi.waitFor(async () => expect((await h.analysisJobs())[0]!.waitReason).toBeUndefined());
  });

  it('a Stop of the waiting turn during the check returns at once; Salta too', async () => {
    const ff = hangingFf();
    const t = await analysisApp({ media, ffExec: ff.exec, transcription: { method: 'ask' } });
    const h = analysisHelpers(t);
    const file = await h.put('clip.mp4', 'fake video');
    const notes: string[] = [];
    const stop = new AbortController();
    const waiting = t.analyses.waitForBrief(t.ref, 'c1', [file], stop.signal, { note: async (e) => { notes.push(e.text); } });
    await vi.waitFor(() => expect(notes).toHaveLength(1), { timeout: 2000 });
    const at = Date.now();
    stop.abort();
    expect(await waiting).toBe('aborted');
    expect(Date.now() - at).toBeLessThan(1000);
    const salta = t.analyses.waitForBrief(t.ref, 'c2', [file], new AbortController().signal, { note: async () => {} });
    await vi.waitFor(() => expect(t.analyses.waitingFiles(t.ref, 'c2')).toEqual(['clip.mp4']), { timeout: 2000 });
    expect(t.analyses.skip(t.ref, 'c2')).toBe(true);
    expect(await salta).toBe('skipped');
    ff.state.release();
  });

  it('stopping the analysis during the check kills the check\'s ffmpeg', async () => {
    const ff = hangingFf();
    const t = await analysisApp({ media, ffExec: ff.exec, transcription: { method: 'ask' } });
    const h = analysisHelpers(t);
    const file = await h.put('clip.mp4', 'fake video');
    await t.analyses.ensure(t.ref, [file], { from: 'brief' });
    await vi.waitFor(() => expect(ff.state.started).toBe(1));
    expect(t.analyses.cancel(t.ref, file)).toBe(true);
    await vi.waitFor(() => expect(ff.state.aborted).toBe(1));
    await vi.waitFor(async () => expect((await h.analysisJobs())[0]!.state).toBe('cancelled'));
  });

  it('a long video with speech: the length is confirmed first, then it asks about the transcription', async () => {
    const speechFf: CommandExec = async (cmd, args) => {
      const ok: CommandResult = { code: 0, stdout: '', stderr: '', notFound: false };
      if (cmd === 'ffmpeg' && args.includes('pcm_s16le')) await writeFile(args.at(-1)!, Buffer.alloc(1000));
      return ok;
    };
    const longMedia = (real: MediaTools): MediaTools => ({ ...real, available: true, probe: async () => ({ width: 640, height: 360, durationSec: 1300, fps: 25, audio: true }) });
    const t = await analysisApp({ media: longMedia, ffExec: speechFf, transcription: { method: 'ask' } });
    const h = analysisHelpers(t);
    const file = await h.put('talk.mp4', 'fake long video');
    const [v] = await t.analyses.ensure(t.ref, [file], { from: 'brief' });
    expect(v!.pending?.kind).toBe('long');
    await new Promise((r) => setTimeout(r, 300));
    expect((await t.analyses.view(t.ref, file)).pending?.kind).toBe('long');
    const after = await t.analyses.confirmLong(t.ref, file, 'reduced');
    expect(after.pending).toMatchObject({ kind: 'transcription', audioSec: 1300 });
    expect((await h.analysisJobs())[0]!.waitReason).toBe('transcription-choice');
  });
});
