import { z } from 'zod';

/**
 * Video analysis (spec docs/superpowers/specs/2026-10-21-video-analysis-design.md, decisions 1468–1490): a video that enters a
 * brief is analysed once and described in a text sidecar, `assets/.analysis/<asset path>.md`, keyed by the video's sha256.
 * The agents read the sidecar instead of the footage.
 */
export const VIDEO_ANALYSIS_FORMAT = 'motion-studio-video-analysis/1';
/** The sidecars' folder (one hidden folder: the asset grid stays clean, rename and delete follow the asset). */
export const ANALYSIS_DIR = 'assets/.analysis';
/** Frames are scaled so their longer side is this many pixels (never enlarged). */
export const FRAME_LONG_SIDE = 768;
/** One frame every this many seconds inside a scene (and with no detectable cut at all). */
export const STATIC_FRAME_EVERY_SEC = 10;
/** Reduced density (a long video the user chose to analyse lighter): at most one frame every this many seconds. */
export const REDUCED_FRAME_EVERY_SEC = 30;
/** Frames per agent run: a longer video is described in chunks, then a final pass. */
export const CHUNK_FRAMES = 40;
/** Videos longer than this (seconds) wait for the user's confirmation before they are analysed. */
export const LONG_VIDEO_SEC = 1200;
/** Silence covering at least this share of the audio means "no speech": no transcription, no question. */
export const SILENCE_NO_SPEECH = 0.95;
/** Estimated tokens per frame, shown before a long video is analysed (decision 1491). */
export const TOKENS_PER_FRAME = 800;

export const transcriptKindSchema = z.enum(['whisper-small', 'whisper-large-v3-turbo', 'openai', 'elevenlabs', 'none-skipped', 'none-no-speech']);
export type TranscriptKind = z.infer<typeof transcriptKindSchema>;

/** The sidecar's front matter: computed by the core, never by the agent. */
export const sidecarHeaderSchema = z.object({
  format: z.literal(VIDEO_ANALYSIS_FORMAT),
  asset: z.string().regex(/^assets\//),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(0),
  durationSec: z.number().min(0),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  fps: z.number().min(0).nullable(),
  hasAudio: z.boolean(),
  transcript: transcriptKindSchema,
  language: z.string().max(32).nullable(),
  generator: z.string().max(200),
  createdAt: z.string().max(64),
  edited: z.boolean(),
}).strict();
export type SidecarHeader = z.infer<typeof sidecarHeaderSchema>;

/** One timed piece of speech (seconds from the start of the video). */
export const transcriptSegmentSchema = z.object({
  from: z.number().min(0),
  to: z.number().min(0),
  text: z.string().min(1).max(2000),
}).strict().refine((s) => s.to >= s.from, { message: 'to must not be before from' });
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

/** One timed word (seconds from the start of the video), as an engine heard it: the subtitles are cut from these. */
export const transcriptWordSchema = z.object({
  from: z.number().min(0),
  to: z.number().min(0),
  text: z.string().min(1).max(200),
}).strict().refine((w) => w.to >= w.from, { message: 'to must not be before from' });
export type TranscriptWord = z.infer<typeof transcriptWordSchema>;

const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const timelineItemSchema = z.object({
  from: z.number().min(0),
  to: z.number(),
  onScreen: z.string().min(1).max(1000),
  onScreenText: z.array(z.string().max(300)).max(20).optional(),
  frame: z.string().max(64).optional(),
}).strict();
const usableMomentSchema = z.object({ from: z.number().min(0), to: z.number(), why: z.string().min(1).max(300) }).strict();
const lookSchema = z.object({
  colours: z.array(colour).max(12),
  typography: z.string().max(300),
  framing: z.string().max(300),
  audio: z.string().max(300),
}).strict();

/**
 * What the `video-analysis` agent writes through `write_video_analysis` (agent input: validated here, then against the run's
 * scope by the core). Every key is optional; at least one is required.
 */
export const writeVideoAnalysisSchema = z.object({
  summary: z.string().min(1).max(2000).optional(),
  timeline: z.array(timelineItemSchema).max(200).optional(),
  usableMoments: z.array(usableMomentSchema).max(30).optional(),
  look: lookSchema.optional(),
  tags: z.array(z.string().min(1).max(40)).max(30).optional(),
}).strict().refine((w) => Object.keys(w).length > 0, { message: 'write at least one field' });
export type VideoAnalysisWrite = z.infer<typeof writeVideoAnalysisSchema>;
export type VideoAnalysisTimelineItem = z.infer<typeof timelineItemSchema>;
export type VideoAnalysisLook = z.infer<typeof lookSchema>;
export type VideoAnalysisMoment = z.infer<typeof usableMomentSchema>;

/**
 * Where a video's analysis is: `none` never analysed; `queued`/`running` its job; `waiting` a held job (a long video waits for
 * the user's confirmation); `ready` a sidecar matching the file; `stale` a sidecar of other content (an edited one waits for
 * the user, decision 1494); `error` the last analysis failed.
 */
export type VideoAnalysisState = 'none' | 'queued' | 'running' | 'waiting' | 'ready' | 'stale' | 'error';

/**
 * What a held analysis asks the user. `long`: a video over 20 minutes (`tokens`: frames × TOKENS_PER_FRAME). `transcription`:
 * the video has speech and no transcription method is set or available (spec §6): the dialog offers Whisper (its model's
 * size; `canInstall` only with a bundled binary), the providers with a saved key (estimated cost in USD) and "without".
 */
export type VideoAnalysisPending =
  | { kind: 'long'; frames: number; reducedFrames: number; tokens: number; reducedTokens: number }
  | TranscriptionPending;
export interface TranscriptionPending {
  kind: 'transcription';
  audioSec: number;
  whisper: {
    /** An engine was found (settings, bundled or detected). */
    available: boolean;
    /** The model it needs is present (always true for a Python engine: it keeps its own models). */
    installed: boolean;
    /** The model of the setting: what "Installa Whisper" downloads. */
    model: TranscriptionModelId;
    sizeBytes: number;
    /** Downloading the model alone makes Whisper work (a bundled whisper-cli, or a whisper.cpp set or detected). */
    canInstall: boolean;
    /** The engine "Whisper" would use (null: none found). */
    engine: WhisperEngine | null;
    /** A Python engine that downloads its own model on its first run: the dialog says so (`transcription.pythonCache`). */
    downloadsOwnModel: boolean;
  };
  openai: { costUsd: number } | null;
  elevenlabs: { costUsd: number } | null;
  /** The last attempt of this dialog failed (a model download): shown above the choices. */
  error?: string;
}

// ---------- transcription (Phase 2, spec §6–§7) ----------

export const whisperEngineSchema = z.enum(['whisper.cpp', 'openai-whisper', 'faster-whisper']);
export type WhisperEngine = z.infer<typeof whisperEngineSchema>;
export const transcriptionModelIdSchema = z.enum(['small', 'large-v3-turbo']);
export type TranscriptionModelId = z.infer<typeof transcriptionModelIdSchema>;
export const transcriptionMethodSchema = z.enum(['ask', 'whisper', 'openai', 'elevenlabs', 'never']);
export type TranscriptionMethod = z.infer<typeof transcriptionMethodSchema>;
/** A method that transcribes (what a choice or a saved method runs). */
export type TranscribeMethod = 'whisper' | 'openai' | 'elevenlabs';

/** An absolute path (POSIX or Windows), at most 4096 characters. */
const absolutePath = z.string().min(2).max(4096).refine((p) => /^(\/|[A-Za-z]:[\\/])/.test(p) && !p.includes('\0'), { message: 'must be an absolute path' });

/** "Usa un Whisper già installato": the program, its engine, and (whisper.cpp) a ggml model file the user already has. */
export const customWhisperSchema = z.object({ program: absolutePath, engine: whisperEngineSchema, modelFile: absolutePath.optional() }).strict();
export type CustomWhisper = z.infer<typeof customWhisperSchema>;

/** Settings → Trascrizione video (app-wide, in `config.json`; decision 1503). Older files parse with the defaults. */
export const transcriptionSettingsSchema = z.object({
  method: transcriptionMethodSchema.default('ask'),
  model: transcriptionModelIdSchema.default('small'),
  custom: customWhisperSchema.nullable().default(null),
}).strict();
export type TranscriptionSettings = z.infer<typeof transcriptionSettingsSchema>;
/** A change of the settings: any of the keys (`custom: null` removes the program). */
export const transcriptionSettingsPatchSchema = z.object({
  method: transcriptionMethodSchema.optional(),
  model: transcriptionModelIdSchema.optional(),
  custom: customWhisperSchema.nullable().optional(),
}).strict();
export type TranscriptionSettingsPatch = z.infer<typeof transcriptionSettingsPatchSchema>;

/**
 * The answer to the transcription dialog. `sizeBytes`: the model size the user saw (the consent for its download: it must
 * equal the manifest's); `remember` writes the method into the settings (`none` → `never`).
 */
export const transcriptionChoiceSchema = z.object({
  file: z.string().min(1).max(1024),
  choice: z.enum(['whisper', 'openai', 'elevenlabs', 'none']),
  remember: z.boolean(),
  sizeBytes: z.number().int().positive().optional(),
}).strict();
export type TranscriptionChoice = z.infer<typeof transcriptionChoiceSchema>;

/** A Whisper that works: found through the settings, bundled with the app, or detected on the PATH / in Homebrew. */
export interface WhisperFound {
  engine: WhisperEngine;
  program: string;
  version: string | null;
  /** The model it runs: a file for whisper.cpp, a name for the Python engines. */
  model: string;
  /** Metal/GPU in use (whisper.cpp's own report); null: unknown (the Python engines). */
  gpu: boolean | null;
  source: 'settings' | 'bundled' | 'detected';
  /** A detected program that failed its check (decision 1551): listed with the reason, never used. */
  problem?: string;
  /** A whisper.cpp that can only be checked once a model is downloaded (it is then usable with it). */
  needsModel?: boolean;
  /** A Python engine whose model is not in its own cache: its first transcription downloads it (`transcription.pythonCache`). */
  downloadsOwnModel?: boolean;
}

/** `GET /api/transcription`: what Settings → Trascrizione video shows. */
export interface TranscriptionStatus {
  settings: TranscriptionSettings;
  models: Array<{ id: TranscriptionModelId; sizeBytes: number; installed: boolean; bytesOnDisk: number }>;
  /** The Whisper the analyses would use now (lookup order §7), or null. */
  whisper: WhisperFound | null;
  /** Every Whisper the last detection found on the PATH and in the Homebrew folders, checked (`problem`: not usable). */
  detected: WhisperFound[];
  /** The detection (decision 1553): at server start and on `POST /api/transcription/detect`; reading the status runs nothing. */
  detection: { state: 'idle' | 'running' | 'done'; at: string | null };
  /** A bundled whisper-cli exists (the dialog can offer "Installa Whisper"). */
  bundled: boolean;
  download: { state: 'idle' | 'running' | 'done' | 'failed'; model: TranscriptionModelId | null; bytes: number; total: number; error?: string };
  /** Providers with a saved key. */
  providers: { openai: boolean; elevenlabs: boolean };
  /** List prices used for the estimates (USD per minute). */
  prices: { openai: number; elevenlabs: number };
}

export interface VideoAnalysisView {
  /** The video, as a project path (`assets/…`). */
  file: string;
  state: VideoAnalysisState;
  jobId: string | null;
  error: string | null;
  pending: VideoAnalysisPending | null;
  header: SidecarHeader | null;
  /** The sidecar's body (markdown, after the front matter). */
  body: string | null;
}

/** Key of a video's analysis job: one per content (sha256) and project, so the same content is never analysed twice at once. */
export const videoAnalysisJobKey = (root: string, projectSlug: string, sha256: string) => `video-analysis:${root}:${projectSlug}:${sha256}`;
