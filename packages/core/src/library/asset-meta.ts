import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AssetEntry, type AssetKind } from '@motion-studio/shared';
import { realDirChain, writeThroughTemp } from '../creatives/core-files.ts';
import { noteCoreTemp } from '../core-temps.ts';
import { svgSize } from '../media/svg-size.ts';
import { displaySize, type MediaTools } from '../media/media-tools.ts';
import { WorkspaceError } from '../workspace-store.ts';
import { t } from '../i18n.ts';

export interface AssetMeta { durationSec: number | null; width: number | null; height: number | null; bytes: number }

/**
 * What the library knows about a file, read once: the size in bytes always, the picture size of images, SVGs and videos, the
 * duration of videos and audio. A kind without that information (a font, an unknown file) gets nulls; a file ffprobe cannot
 * read gets nulls too (it is still registered, and the metadata is not read again).
 */
export async function readAssetMeta(deps: { media: MediaTools }, absPath: string, kind: AssetKind): Promise<AssetMeta> {
  const bytes = (await stat(absPath).catch(() => null))?.size ?? 0;
  const none = { durationSec: null, width: null, height: null, bytes };
  if (kind === 'svg') { const s = await svgSize(absPath); return { ...none, width: s?.width ?? null, height: s?.height ?? null }; }
  if (!deps.media.available) return none;
  if (kind === 'image' || kind === 'video') {
    const p = await deps.media.probe(absPath);
    // Report 70 (round 1): the size the user sees (a phone's portrait clip is often stored landscape with a rotation).
    const size = p ? displaySize(p) : null;
    return { ...none, width: size?.width ?? null, height: size?.height ?? null, durationSec: p?.durationSec ?? null };
  }
  if (kind === 'audio' && deps.media.probeAudio) return { ...none, durationSec: (await deps.media.probeAudio(absPath))?.durationSec ?? null };
  return none;
}

/** Whether the entry predates the metadata (no size recorded): read it once, then it is stored. */
export const needsMeta = (a: AssetEntry) => a.bytes === undefined;

/** Peaks per waveform and the decode bounds: 4 kHz mono s16 for at most 30 minutes is under 15 MB of PCM. */
export const WAVEFORM_PEAKS = 400;
const SAMPLE_RATE = 4000;
const MAX_SEC = 1800;

/** At most `buckets` peaks (0..1, three decimals) of mono s16le PCM: the largest absolute sample of each equal slice. */
export function peaksOf(pcm: Buffer, buckets = WAVEFORM_PEAKS): number[] {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return [];
  const count = Math.min(buckets, n);
  const peaks = new Array<number>(count).fill(0);
  for (let b = 0; b < count; b++) {
    const from = Math.floor((b * n) / count), to = Math.floor(((b + 1) * n) / count);
    let max = 0;
    for (let i = from; i < to; i++) { const v = Math.abs(pcm.readInt16LE(i * 2)); if (v > max) max = v; }
    peaks[b] = Math.round(Math.min(1, max / 32768) * 1000) / 1000;
  }
  return peaks;
}

/**
 * The peaks of the audio of `abs` (its first `maxSec` seconds): decoded at 4 kHz to a fresh temp name in `dir` (a real
 * folder), removed at once. Null when it cannot be decoded.
 */
export async function filePeaks(decodePcm: NonNullable<MediaTools['decodePcm']>, abs: string, dir: string, o: { buckets: number; maxSec: number }): Promise<number[] | null> {
  const pcm = join(dir, `.pcm-${randomBytes(6).toString('hex')}.pcm`);
  noteCoreTemp(pcm);
  try {
    if (!(await decodePcm(abs, pcm, { sampleRate: SAMPLE_RATE, maxSec: o.maxSec }))) return null;
    const st = await lstat(pcm);
    if (!st.isFile() || st.nlink !== 1 || st.size > SAMPLE_RATE * 2 * (Math.round(o.maxSec) + 1)) return null;
    return peaksOf(await readFile(pcm), o.buckets);
  } finally { await rm(pcm, { force: true }).catch(() => {}); }
}

const inFlight = new Map<string, Promise<number[]>>();

/**
 * The waveform of a library audio file: cached in `.studio/cache/waveforms/` (named after the file and its size and
 * modification time, so a replaced file is decoded again). The cache folder is a chain of real directories; the PCM goes
 * through a fresh temp name there and is removed at once.
 */
export async function assetWaveform(deps: { media: MediaTools; projectDir: string }, file: string, abs: string): Promise<number[]> {
  const info = await stat(abs);
  const key = createHash('sha1').update(`${file}\0${info.size}\0${info.mtimeMs}`).digest('hex').slice(0, 24);
  const dir = await realDirChain(deps.projectDir, ['.studio', 'cache', 'waveforms']);
  if (!dir) throw new WorkspaceError(422, t().errors.waveformUnavailable);
  const cache = join(dir, `${key}.json`);
  const pending = inFlight.get(cache);
  if (pending) return pending;
  const job = (async () => {
    const hit = !(await lstat(cache).catch(() => null))?.isFile() ? null : await readFile(cache, 'utf8').then((s) => JSON.parse(s) as { peaks?: unknown }).catch(() => null);
    if (hit && Array.isArray(hit.peaks) && hit.peaks.length <= WAVEFORM_PEAKS && hit.peaks.every((p) => typeof p === 'number')) return hit.peaks as number[];
    if (!deps.media.decodePcm) throw new WorkspaceError(422, t().errors.waveformUnavailable);
    const peaks = await filePeaks(deps.media.decodePcm, abs, dir, { buckets: WAVEFORM_PEAKS, maxSec: MAX_SEC });
    if (!peaks) throw new WorkspaceError(422, t().errors.waveformUnavailable);
    await writeThroughTemp(dir, `${key}.json`, async (temp) => { await writeFile(temp, JSON.stringify({ peaks }), { flag: 'wx' }); return true; });
    return peaks;
  })();
  inFlight.set(cache, job);
  try { return await job; } finally { inFlight.delete(cache); }
}
