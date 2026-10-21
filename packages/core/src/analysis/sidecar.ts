import { lstat, mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ANALYSIS_DIR, sidecarHeaderSchema,
  type SidecarHeader, type TranscriptSegment, type VideoAnalysisLook, type VideoAnalysisMoment,
} from '@motion-studio/shared';
import { fileLock } from '../file-locks.ts';
import { writeTextFileAtomic } from '../json-file.ts';
import { readRegularFile } from '../safe-read.ts';

/**
 * The video analysis sidecar (spec §4, decision 1486): `assets/.analysis/<asset path>.md`, a front matter the core writes
 * (`key: <JSON scalar>` lines: a JSON string is valid YAML, so no YAML dependency, decision 1498) and a markdown body meant to
 * be read top-down. Section titles stay English: the body is for the agent.
 */

/** Largest sidecar read or written (a long video's timeline and transcript fit well below it). */
export const MAX_SIDECAR_BYTES = 2 * 1024 * 1024;
/** The key frames' cache of one content, relative to the project (not versioned, regenerable). */
export const FRAMES_ROOT = '.studio/cache/analysis';

const ANALYSIS_PREFIX = `${ANALYSIS_DIR}/`;

/** `assets/foo/clip.mp4` → `assets/.analysis/foo/clip.mp4.md`. Refuses a path outside `assets/`, with `..`, or a sidecar's own. */
export function sidecarPathOf(assetRel: string): string {
  const parts = assetRel.split('/');
  if (parts[0] !== 'assets' || parts.length < 2 || parts.some((p) => p === '' || p === '.' || p === '..') || assetRel.includes('\\') || assetRel.includes('\0')) {
    throw new Error(`not an asset path: ${JSON.stringify(assetRel)}`);
  }
  if (assetRel.startsWith(ANALYSIS_PREFIX)) throw new Error(`an analysis file has no analysis: ${JSON.stringify(assetRel)}`);
  return `${ANALYSIS_PREFIX}${parts.slice(1).join('/')}.md`;
}

/** `.studio/cache/analysis/<sha>` (project-relative). */
export function framesDirOf(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('not a sha256');
  return `${FRAMES_ROOT}/${sha256}`;
}

/** A frame's file name from its time: `f-` + milliseconds zero-padded to 8 + `.jpg` (`12.5` → `f-00012500.jpg`, decision 1497). */
export function frameName(atSec: number): string {
  const ms = Math.max(0, Math.round(atSec * 1000));
  return `f-${String(ms).padStart(8, '0')}.jpg`;
}

/** The time (s) of a frame name made by `frameName`; null for any other name. */
export function frameTime(name: string): number | null {
  const m = /^f-(\d{8,})\.jpg$/.exec(name);
  return m ? Number(m[1]) / 1000 : null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
/** `mm:ss` (`hh:mm:ss` from one hour); seconds are floored (`75.4` → `01:15`). */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h > 0 ? `${pad2(h)}:${pad2(m)}:${pad2(r)}` : `${pad2(m)}:${pad2(r)}`;
}
/** `mm:ss.s` (tenths, floored): the time of a line of speech. */
export function formatTimeTenths(sec: number): string {
  const tenths = Math.max(0, Math.floor(sec * 10 + 1e-6));
  return `${formatTime(Math.floor(tenths / 10))}.${tenths % 10}`;
}

export interface SidecarScene { from: number; to: number; onScreen: string; onScreenText: string[]; frame?: string; speech: TranscriptSegment[] }
export interface SidecarContent {
  summary: string;
  timeline: SidecarScene[];
  usableMoments: VideoAnalysisMoment[];
  look: VideoAnalysisLook | null;
  transcript: TranscriptSegment[];
  tags: string[];
}

/**
 * Each transcript segment goes to the scene holding its midpoint (the last scene starting at or before it); one before the
 * first scene goes to the first, one past the last scene to the last. Scenes come back sorted by start.
 */
export function mergeTranscript(timeline: Array<Omit<SidecarScene, 'speech'> & { speech?: TranscriptSegment[] }>, transcript: TranscriptSegment[]): SidecarScene[] {
  const scenes = [...timeline].sort((a, b) => a.from - b.from).map((s) => ({ ...s, speech: [] as TranscriptSegment[] }));
  if (scenes.length === 0) return scenes;
  for (const seg of [...transcript].sort((a, b) => a.from - b.from)) {
    const mid = (seg.from + seg.to) / 2;
    let at = 0;
    for (let i = 0; i < scenes.length; i++) if (scenes[i]!.from <= mid) at = i;
    scenes[at]!.speech.push(seg);
  }
  return scenes;
}

/** Agent text on one line (no line break can start a heading or a front matter fence). */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
/** A multi-line text (the summary): its lines kept, none starting a heading or a fence. */
const block = (s: string) => s.split(/\r?\n/).map((l) => l.trim().replace(/^(#+|-{3,})\s*/, '')).filter(Boolean).join('\n');
const quote = (s: string) => `"${oneLine(s).replace(/"/g, '\'')}"`;
const span = (from: number, to: number) => `[${formatTime(from)}–${formatTime(to)}]`;

/** The front matter: one `key: <JSON scalar>` line per header field, in the schema's order, between `---` lines. */
export function renderHeader(h: SidecarHeader): string {
  const checked = sidecarHeaderSchema.parse(h);
  return ['---', ...Object.keys(sidecarHeaderSchema.shape).map((k) => `${k}: ${JSON.stringify(checked[k as keyof SidecarHeader])}`), '---', ''].join('\n');
}

const NO_TRANSCRIPT: Record<string, string> = {
  'none-skipped': 'No transcript: transcription was skipped.',
  'none-no-speech': 'No transcript: the video has no speech.',
};

/** The sidecar's body (markdown) from the content. */
export function renderBody(h: SidecarHeader, c: SidecarContent): string {
  const out: string[] = ['## Summary', block(c.summary) || '-', '', '## Timeline'];
  for (const s of c.timeline) {
    out.push(`- ${span(s.from, s.to)} ${oneLine(s.onScreen)}`);
    const texts = s.onScreenText.map(oneLine).filter(Boolean);
    if (texts.length) out.push(`  - On-screen text: ${texts.map(quote).join(', ')}`);
    if (s.frame) out.push(`  - Frame: ${framesDirOf(h.sha256)}/${s.frame}`);
    for (const sp of s.speech) out.push(`  - [${formatTimeTenths(sp.from)}] ${quote(sp.text)}`);
  }
  out.push('', '## Usable moments', ...(c.usableMoments.length ? c.usableMoments.map((m) => `- ${span(m.from, m.to)} ${oneLine(m.why)}`) : ['- none noted']));
  out.push('', '## Look');
  if (c.look) {
    out.push(`- Colours: ${c.look.colours.length ? c.look.colours.map((x) => x.toLowerCase()).join(', ') : '-'}`,
      `- Typography: ${oneLine(c.look.typography) || '-'}`, `- Framing: ${oneLine(c.look.framing) || '-'}`, `- Audio: ${oneLine(c.look.audio) || '-'}`);
  } else out.push('- not described');
  out.push('', '## Transcript');
  if (c.transcript.length) {
    out.push('Automatic transcript: names may be wrong.', ...c.transcript.map((sp) => `- [${formatTimeTenths(sp.from)}–${formatTimeTenths(sp.to)}] ${oneLine(sp.text)}`));
  } else {
    out.push(!h.hasAudio ? 'No transcript: the video has no audio track.' : NO_TRANSCRIPT[h.transcript] ?? 'No transcript: no speech was recognised.');
  }
  out.push('', '## Tags', c.tags.map(oneLine).filter(Boolean).join(', ') || '-', '');
  return out.join('\n');
}

export function renderSidecar(h: SidecarHeader, c: SidecarContent): string {
  return `${renderHeader(h)}\n${renderBody(h, c)}`;
}

/** The header and body of a sidecar written by us; null for any front matter that is not exactly ours. */
export function parseSidecar(text: string): { header: SidecarHeader; body: string } | null {
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  const raw: Record<string, unknown> = {};
  const keys = new Set(Object.keys(sidecarHeaderSchema.shape));
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z0-9]+): (.*)$/.exec(line);
    if (!m || !keys.has(m[1]!) || Object.hasOwn(raw, m[1]!)) return null;
    try { raw[m[1]!] = JSON.parse(m[2]!); } catch { return null; }
  }
  const parsed = sidecarHeaderSchema.safeParse(raw);
  if (!parsed.success) return null;
  const rest = lines.slice(end + 1).join('\n');
  return { header: parsed.data, body: rest.startsWith('\n') ? rest.slice(1) : rest };
}

/** The sidecar with a body written by the user: the header kept (`edited: true`). Refuses a body that starts a front matter. */
export function replaceBody(text: string, body: string): string {
  const parsed = parseSidecar(text);
  if (!parsed) throw new Error('not a video analysis file');
  if (/^\s*---/.test(body)) throw new Error('the body cannot start with ---');
  return `${renderHeader({ ...parsed.header, edited: true })}\n${body.endsWith('\n') ? body : `${body}\n`}`;
}

/** `rel` under `projectDir` with no link nor non-folder on the way (the last part may be missing). */
async function assertPlainPath(projectDir: string, rel: string): Promise<string> {
  const parts = rel.split('/');
  let at = projectDir;
  for (let i = 0; i < parts.length - 1; i++) {
    at = join(at, parts[i]!);
    const st = await lstat(at).catch(() => null);
    if (!st) break;
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`not a plain folder: ${parts.slice(0, i + 1).join('/')}`);
  }
  return join(projectDir, rel);
}

export interface SidecarFile { header: SidecarHeader; body: string; text: string }

/**
 * Runs `fn` under the lock the asset library takes for its renames and deletes (the lock of `assets/assets.json`, decision
 * 1540): an analysis file is written, or edited by the user, never in the middle of a rename or a delete of its video.
 */
export function withLibraryLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  return fileLock.run(join(projectDir, 'assets', 'assets.json'), fn);
}

/** The video's sidecar, when it is a regular file of ours; null when missing or not ours. */
export async function readSidecar(projectDir: string, assetRel: string): Promise<SidecarFile | null> {
  const path = await assertPlainPath(projectDir, sidecarPathOf(assetRel)).catch(() => null);
  if (!path) return null;
  const f = await readRegularFile(path, MAX_SIDECAR_BYTES).catch(() => null);
  if (f?.kind !== 'file') return null;
  const text = f.data.toString('utf8');
  const parsed = parseSidecar(text);
  return parsed ? { ...parsed, text } : null;
}

/** Writes the sidecar (folders made, atomic temp + rename). */
export async function writeSidecar(projectDir: string, assetRel: string, text: string): Promise<void> {
  if (Buffer.byteLength(text, 'utf8') > MAX_SIDECAR_BYTES) throw new Error('the analysis file is too large');
  const rel = sidecarPathOf(assetRel);
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = join(projectDir, ...parts.slice(0, i));
    await mkdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
  }
  await writeTextFileAtomic(await assertPlainPath(projectDir, rel), text);
}

/** Removes the sidecar (whatever entry is there); true when there was one. */
export async function removeSidecar(projectDir: string, assetRel: string): Promise<boolean> {
  const path = await assertPlainPath(projectDir, sidecarPathOf(assetRel)).catch(() => null);
  if (!path || !(await lstat(path).catch(() => null))) return false;
  await unlink(path);
  return true;
}

/** Moves the sidecar of `from` to `to` (its header names `to`); true when there was one. */
export async function moveSidecar(projectDir: string, from: string, to: string): Promise<boolean> {
  const src = await assertPlainPath(projectDir, sidecarPathOf(from)).catch(() => null);
  if (!src || !(await lstat(src).catch(() => null))) return false;
  const current = await readSidecar(projectDir, from);
  const dst = join(projectDir, sidecarPathOf(to));
  if (current && src.toLowerCase() === dst.toLowerCase()) {
    // A change of letter case only (one file on a case-insensitive volume): rewritten in place, then renamed.
    await writeSidecar(projectDir, from, `${renderHeader({ ...current.header, asset: to })}\n${current.body}`);
    await rename(src, await assertPlainPath(projectDir, sidecarPathOf(to)));
    return true;
  }
  if (current) {
    await writeSidecar(projectDir, to, `${renderHeader({ ...current.header, asset: to })}\n${current.body}`);
    await unlink(src);
    return true;
  }
  // Not ours (or unreadable): moved as it is.
  const rel = sidecarPathOf(to);
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) await mkdir(join(projectDir, ...parts.slice(0, i))).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
  await rename(src, await assertPlainPath(projectDir, rel));
  return true;
}
