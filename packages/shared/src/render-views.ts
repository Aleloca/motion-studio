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
