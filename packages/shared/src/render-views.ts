import type { Composition } from './composition/schema.ts';
import type { JobSummary } from './events.ts';

/** The job key of a creative's turns (core creative-turns): `creative:<root>:<project>:<creative>`; the root may hold ':'. */
export const creativeJobKey = (root: string, projectSlug: string, creativeSlug: string): string => `creative:${root}:${projectSlug}:${creativeSlug}`;
/** The job key of the render jobs of version n (core render-jobs): `render:<root>:<project>:<creative>:v<n>`. */
export const renderJobKey = (root: string, projectSlug: string, creativeSlug: string, n: number): string => `render:${root}:${projectSlug}:${creativeSlug}:v${n}`;
/** `renderJobKey` from a creative's job key (the creative detail's `jobKey`); null for another kind of key. */
export function renderJobKeyOf(creativeKey: string, n: number): string | null {
  return creativeKey.startsWith('creative:') ? `render:${creativeKey.slice('creative:'.length)}:v${n}` : null;
}

/**
 * What the core's preview, storyboard, render and render engine routes answer (Task 8), shared by the core and the web.
 */

/** A live preview session of one format of a saved v2 version (`POST …/versions/:n/preview-session`). */
export interface PreviewSessionInfo {
  /** The runtime page on the composition server (its own origin, a session token in the path). */
  url: string;
  /** The session token (also in `url`): `DELETE …/preview-session/:token` ends the session early. */
  token: string;
  origin: string;
  expiresAt: string;
  /** The composition folder shown (a follower's is its primary's) and its hash. */
  format: string;
  hash: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
}

/** A storyboard frame: a scene start or the poster, with its short-lived signed image URL. */
export interface StoryboardFrameView { t: number; kind: 'scene' | 'poster'; scene?: string; width: number; height: number; url: string }

/** `GET …/versions/:n/storyboards/:format`: the image URLs expire at `expiresAt` (ask again before). */
export interface StoryboardView { format: string; hash: string; width: number; expiresAt: string; frames: StoryboardFrameView[] }

/** `POST …/export/prepare`: the render jobs a ★ export waits for (one per version; empty: nothing to render). */
export interface ExportPrepareResult { renders: Array<{ version: number; formats: string[]; job: JobSummary; covers: boolean }> }

/** The Chromium renders use: Electron's (desktop), a system Chrome, a downloaded Chrome for Testing, an injected one. */
export type RenderEngineKind = 'electron' | 'system' | 'cft' | 'injected';

/** The on-demand Chrome for Testing download (CLI only). `total` is the size agreed to. */
export interface ChromeDownloadState { state: 'idle' | 'running' | 'done' | 'failed'; bytes: number; total: number | null; error?: string }

/** `GET /api/render-engine` (System check). `downloadable`: no engine, and Chrome for Testing may be downloaded here. */
export interface RenderEngineStatus { kind: RenderEngineKind | null; version?: string; downloadable: boolean; download: ChromeDownloadState }

/** `GET /api/render-engine/download-info`: what the consent shows before anything is downloaded. */
export interface ChromeDownloadOffer { version: string; sizeBytes: number }

/** `GET …/pin-frames/:n`: the feedback frames the core made for the comments sent with the turn that made version n. */
export interface PinFramesView { n: number; expiresAt: string | null; frames: Array<{ file: string; url: string }> }

/**
 * `GET …/versions/:n/compositions/:format` (Phase 10b editor): the **primary** composition of `format` in a saved v2 version.
 * Asking for a follower answers with its primary's composition; `primaryFormat` is then the primary's folder (for a primary
 * it equals `format`). `files`: every file of the composition folder (for `validateComposition`); `fonts`: the families the
 * inspector offers, the composition's own first, then the brand kit's not already declared.
 */
export type EditorCompositionView = { n: number; format: string; primaryFormat: string; hash: string; composition: Composition; files: { path: string; size: number }[]; fonts: EditorFontOption[] };
/** A font the inspector offers. A brand font is `staged: false` here: choosing it stages its file first (`StagedAsset`). */
export type EditorFontOption = { family: string; weights: number[]; source: 'composition' | 'brand'; brandFontId?: string; staged: boolean };

/** `POST …/editor/stage`: a library asset (its `assets.json` path) or a brand font, staged for the preview session `token`. */
export type StageRequest = { token: string; from: { kind: 'library'; file: string } | { kind: 'brandFont'; id: string } };

/**
 * A staged video's normalised file in the preview session (the core's media cache, served as `media/<index>.mp4`), with the
 * probed source fields: the web passes it to the runtime (`sessionMedia`), so a draft clip naming `path` plays it as the
 * session's own videos do. `audioStart` only when the original has sound (played from `path` itself).
 */
export type StagedVideoMedia = { index: number; sourceFps: number; sourceStart: number; sourceVideoEnd: number; audioStart?: number };

/**
 * A file staged for a draft: `path` is composition-relative (`assets/lib/<sha8>-<name>`), served under the session's token
 * (base folder first). `media`: a video that was normalised (absent when it could not be: it then plays as it is).
 */
export type StagedAsset = { path: string; size: number; kind: 'image' | 'svg' | 'video' | 'audio' | 'font'; width?: number; height?: number; durationSec?: number | null; media?: StagedVideoMedia };
