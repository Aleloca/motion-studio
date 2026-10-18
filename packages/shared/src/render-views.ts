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
 * The key of an export job (decision 974): `export:<root>:<project>:<creative>:<id>`, one per export (two exports of a creative
 * may run at once). `exportJobPrefixOf` gives `export:<root>:<project>:<creative>:` from the creative's job key.
 */
export const exportJobKey = (root: string, projectSlug: string, creativeSlug: string, id: string): string => `export:${root}:${projectSlug}:${creativeSlug}:${id}`;
export function exportJobPrefixOf(creativeKey: string): string | null {
  return creativeKey.startsWith('creative:') ? `export:${creativeKey.slice('creative:'.length)}:` : null;
}
/**
 * The key of a render made for one export at another quality or size (decision 974): `render-export:<root>:<project>:<creative>:v<n>:<id>`.
 * Never a version's render job (`renderJobKey`): it records nothing in the version and is not reused by another request.
 */
export const exportRenderJobKey = (root: string, projectSlug: string, creativeSlug: string, n: number, id: string): string =>
  `render-export:${root}:${projectSlug}:${creativeSlug}:v${n}:${id}`;

/** How far a running render job is with `format`: its frames (a format not reached yet is at 0; finishing is 99). */
export function renderJobPct(job: JobSummary, format: string): number {
  const p = job.progress;
  if (!p || p.format !== format || p.phase === 'media') return 0;
  if (p.phase === 'finishing') return 99;
  return p.total > 0 ? Math.min(99, Math.floor((p.done / p.total) * 100)) : 0;
}

/** Overall progress of render jobs: each job by its formats done and the current one's frames; null when none is known. */
export function renderJobsPct(jobs: ReadonlyArray<JobSummary | undefined>): number | null {
  const known = jobs.filter((j): j is JobSummary => j !== undefined);
  if (!known.length) return null;
  const one = (j: JobSummary) => {
    if (j.state === 'succeeded') return 100;
    if (j.state !== 'running' || !j.progress) return 0;
    const list = j.formats?.length ? j.formats : [j.progress.format];
    const at = Math.max(0, list.indexOf(j.progress.format));
    return ((at + renderJobPct(j, j.progress.format) / 100) / list.length) * 100;
  };
  return Math.round(known.reduce((a, j) => a + one(j), 0) / known.length);
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
  /**
   * A renewal (`renewFrom`, Phase 10b) of a session of the same version and format: the files staged for the draft on the
   * old session, now this session's (moved, not copied again; a staged video keeps its normalised file, with its index in
   * this session's media). Absent when nothing was moved.
   */
  staged?: StagedAsset[];
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

/**
 * `POST …/editor/stage`: a library asset (its `assets.json` path), a brand font, or an SVG edited in the editor (SVG inner
 * editor: `content` is the whole edited file, `baseSrc` the clip's current `src`, a file of the base or one staged in this
 * session), staged for the preview session `token`.
 */
export type StageRequest = {
  token: string;
  from: { kind: 'library'; file: string } | { kind: 'brandFont'; id: string } | { kind: 'svgEdit'; clipId: string; baseSrc: string; content: string };
};
/**
 * The answer to an `svgEdit` staging: the staged file (`path` = `assets/lib/<base stem>-e<first 8 hex of its sha256>.svg`,
 * the same for the same content) and the warnings of the core's SVG check (text in the SVG). A refusal is 400
 * `svg-edit-refused` with the check's reasons as `problems` (English), or 400 `svg-edit-bad-base`.
 */
export type StagedSvgEdit = StagedAsset & { svgEdit: true; warnings: string[] };
/**
 * Most staged paths one direct save names: 20 library files and fonts plus 200 edited SVGs (the core's staging limits).
 * The save body's schema and the editor use the same number.
 */
export const EDITOR_SAVE_STAGED_MAX = 220;

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
export type StagedAsset = {
  path: string; size: number; kind: 'image' | 'svg' | 'video' | 'audio' | 'font'; width?: number; height?: number; durationSec?: number | null; media?: StagedVideoMedia;
  /**
   * A font's weights as its file says (core font probe): a variable font's `wght` axis `[min, max]`, or a static font's
   * `OS/2` weight (`min === max`). Absent when the file could not be read that far (the editor then keeps its rule).
   */
  fontWeights?: { min: number; max: number };
  /** An SVG edited in the editor (`StagedSvgEdit`), not a library file: it has its own count limit. */
  svgEdit?: true;
};
