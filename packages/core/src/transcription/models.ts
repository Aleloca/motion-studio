import { randomBytes } from 'node:crypto';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TranscriptionModelId } from '@motion-studio/shared';
import { streamDownload } from '../render/cft-download.ts';

/**
 * The Whisper models (spec §7), hardcoded: size and sha256 checked while downloading, URLs pinned to a Hugging Face commit
 * (decision 1507; re-verified against the Hub's API on 2026-10-21), never `main`. `silero` is whisper.cpp's VAD model,
 * downloaded only for a whisper.cpp that is not the bundled one.
 */
export type WhisperModelKey = TranscriptionModelId | 'silero';
export interface WhisperModelSpec { file: string; sizeBytes: number; sha256: string; url: string }
export type WhisperModelManifest = Record<WhisperModelKey, WhisperModelSpec>;

const GGML_COMMIT = '5359861c739e955e79d9a303bcbc70fb988958b1';
const VAD_COMMIT = '9ffd54a1e1ee413ddf265af9913beaf518d1639b';
export const WHISPER_MODELS: WhisperModelManifest = {
  small: {
    file: 'ggml-small.bin', sizeBytes: 487_601_967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${GGML_COMMIT}/ggml-small.bin`,
  },
  'large-v3-turbo': {
    file: 'ggml-large-v3-turbo.bin', sizeBytes: 1_624_555_275, sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
    url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${GGML_COMMIT}/ggml-large-v3-turbo.bin`,
  },
  silero: {
    file: 'ggml-silero-v6.2.0.bin', sizeBytes: 885_098, sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
    url: `https://huggingface.co/ggml-org/whisper-vad/resolve/${VAD_COMMIT}/ggml-silero-v6.2.0.bin`,
  },
};

/**
 * Decision 1508: the hosts a Hugging Face `resolve` URL may redirect to (its CDNs; https only, at most 3 hops). The sha256
 * check is what makes the file trusted; this list only keeps the download on Hugging Face.
 */
export const WHISPER_REDIRECT_HOSTS: readonly string[] = [
  'huggingface.co', 'cdn-lfs.hf.co', 'cdn-lfs-us-1.hf.co', 'cdn-lfs-eu-1.hf.co', 'cas-bridge.xethub.hf.co', 'us.aws.cdn.hf.co', 'eu.aws.cdn.hf.co',
];

export class WhisperModelError extends Error {
  constructor(readonly code: 'consentRequired' | 'downloadSizeChanged' | 'unknownModel', message: string) {
    super(message);
    this.name = 'WhisperModelError';
  }
}

export const whisperModelsDir = (appDataDir: string) => join(appDataDir, 'whisper');

/**
 * Downloads one model into `<appData>/whisper/` (folder 0700, file 0600), only with `consent: true` and the size the user
 * saw (`sizeBytes` must equal the manifest's: `downloadSizeChanged`). Staging file, streaming sha256, then rename; an
 * already installed model (right size) returns at once. Returns the model file.
 */
export async function installWhisperModel(o: {
  id: WhisperModelKey; appDataDir: string; consent: true; sizeBytes: number;
  fetchImpl?: typeof fetch; signal?: AbortSignal; onProgress?: (p: { bytes: number; total: number | null }) => void;
  manifest?: WhisperModelManifest; allowRedirectHosts?: readonly string[];
}): Promise<string> {
  if (o.consent !== true) throw new WhisperModelError('consentRequired', 'a Whisper model is downloaded only after the user agrees');
  const spec = (o.manifest ?? WHISPER_MODELS)[o.id];
  if (!spec) throw new WhisperModelError('unknownModel', `unknown model ${String(o.id)}`);
  if (o.sizeBytes !== spec.sizeBytes) throw new WhisperModelError('downloadSizeChanged', `the size shown (${o.sizeBytes}) is not the model's (${spec.sizeBytes})`);
  const dir = whisperModelsDir(o.appDataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const target = join(dir, spec.file);
  if ((await stat(target).catch(() => null))?.size === spec.sizeBytes) return target;
  const staging = join(dir, `.download-${randomBytes(8).toString('hex')}.bin`);
  try {
    await streamDownload({
      url: spec.url, dest: staging, expectedBytes: spec.sizeBytes, maxBytes: spec.sizeBytes, sha256: spec.sha256,
      allowRedirectHosts: o.allowRedirectHosts ?? WHISPER_REDIRECT_HOSTS,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}), ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}),
    });
    await rename(staging, target);
    return target;
  } finally {
    await rm(staging, { force: true }).catch(() => {});
  }
}

export async function removeWhisperModel(id: WhisperModelKey, appDataDir: string, manifest: WhisperModelManifest = WHISPER_MODELS): Promise<void> {
  await rm(join(whisperModelsDir(appDataDir), manifest[id].file), { force: true });
}

/** The two transcription models with their state (a partial file counts as not installed). */
export async function installedModels(appDataDir: string, manifest: WhisperModelManifest = WHISPER_MODELS): Promise<Array<{ id: TranscriptionModelId; sizeBytes: number; installed: boolean; bytesOnDisk: number }>> {
  return Promise.all((['small', 'large-v3-turbo'] as const).map(async (id) => {
    const st = await stat(join(whisperModelsDir(appDataDir), manifest[id].file)).catch(() => null);
    const bytesOnDisk = st?.isFile() ? st.size : 0;
    return { id, sizeBytes: manifest[id].sizeBytes, installed: bytesOnDisk === manifest[id].sizeBytes, bytesOnDisk };
  }));
}
