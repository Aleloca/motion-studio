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

/** What a held analysis asks the user (Phase 2 adds `transcription`). `tokens`: frames × TOKENS_PER_FRAME. */
export type VideoAnalysisPending = { kind: 'long'; frames: number; reducedFrames: number; tokens: number; reducedTokens: number };

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
