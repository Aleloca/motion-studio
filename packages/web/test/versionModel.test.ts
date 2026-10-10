import { DEFAULT_FORMATS, type CreativeDetail, type JobSummary, type OutputFileInfo, type VersionEntry } from '@motion-studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { messages } from '@motion-studio/shared';
import { boardSource, defaultTargets, entryAt, formatStates, renderingOf, shownOf } from '../src/screens/versionModel.ts';
import { HASH_RETRIES, versionErrorText, withHashRetry } from '../src/screens/versionErrors.ts';

const REEL = 'instagram-reel-9x16';
const POST = 'instagram-post-1x1';
const TIKTOK = 'tiktok-9x16';
const at = '2026-10-08T10:00:00.000Z';
const h = (c: string) => c.repeat(64);
const out = (format: string, sha: string): OutputFileInfo => ({ format, file: `${format}.mp4`, width: 1080, height: 1920, durationSec: 6, verified: true, preview: null, sha256: h(sha) });
const version = (n: number, outputs: OutputFileInfo[]): VersionEntry => ({ n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: '', outputs, problems: [], tools: [], renderCommand: null, basedOn: null });
const detailOf = (versions: VersionEntry[], over: Partial<CreativeDetail['creative']> = {}): CreativeDetail => ({
  slug: 'c', jobKey: 'k', versions,
  creative: {
    schemaVersion: 1, title: 'T', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'g', message: '', formats: [REEL, POST, TIKTOK], durationSec: 6, assets: [], notes: '', links: { [TIKTOK]: REEL } },
    ...over,
  },
});
// The reel changes in v1 and v3; the post only in v1 (v2, v3 carry it); TikTok follows the reel.
const versions = [
  version(1, [out(REEL, 'a'), out(POST, 'b'), out(TIKTOK, 'a')]),
  version(2, [out(REEL, 'a'), out(POST, 'b'), out(TIKTOK, 'a')]),
  version(3, [out(REEL, 'c'), out(POST, 'b'), out(TIKTOK, 'c')]),
];

describe('formatStates', () => {
  it('computes history, ★ and links with the shared rules when the core sends no summary', () => {
    const s = formatStates(detailOf(versions), DEFAULT_FORMATS);
    expect(s[REEL]!.history).toEqual([1, 3]);
    expect(s[POST]!.history).toEqual([1]);
    expect(s[REEL]!.star.version).toBe(3);
    expect(s[TIKTOK]!.follows).toBe(REEL);
    expect(s[TIKTOK]!.star.version).toBeNull();
    expect(s[REEL]!.defaultVersion).toBe(3);
  });
  it('the default-rule version stays known under a manual pick', () => {
    const s = formatStates(detailOf(versions, { exportPicks: { [REEL]: 1 } }), DEFAULT_FORMATS);
    expect(s[REEL]!.star).toMatchObject({ version: 1, manual: true });
    expect(s[REEL]!.defaultVersion).toBe(3);
  });
  it('prefers the core summary', () => {
    const d = { ...detailOf(versions), formats: [{ id: REEL, history: [1], star: { version: 1, manual: true, newer: 3, follows: null }, starFileMissing: true, linkable: [] }] };
    const s = formatStates(d, DEFAULT_FORMATS);
    expect(s[REEL]!.star).toEqual({ version: 1, manual: true, newer: 3, follows: null });
    expect(s[REEL]!.starFileMissing).toBe(true);
  });
});

describe('what a board shows', () => {
  const s = formatStates(detailOf(versions), DEFAULT_FORMATS);
  it('the ★ by default, the viewed history entry when one is viewed', () => {
    expect(shownOf(s[REEL], undefined)).toBe(3);
    expect(shownOf(s[REEL], 1)).toBe(1);
    // A version outside the history is not a file of its own: the ★ stays.
    expect(shownOf(s[REEL], 2)).toBe(3);
  });
  it('a follower shows its primary at the primary’s shown version', () => {
    expect(boardSource(s, TIKTOK, { [REEL]: 1 })).toEqual({ format: REEL, n: 1 });
    expect(boardSource(s, POST, {})).toEqual({ format: POST, n: 1 });
  });
  it('entryAt finds the history entry holding a version’s file', () => {
    expect(entryAt(versions, s[POST], 3)).toBe(1);
    expect(entryAt(versions, s[REEL], 2)).toBe(1);
    expect(entryAt(versions, s[REEL], 9)).toBeNull();
  });
});

describe('renderingOf (per-board "Rendering…")', () => {
  const s = formatStates(detailOf(versions), DEFAULT_FORMATS);
  const job = (over: Partial<JobSummary>): JobSummary => ({ id: 'j', key: 'k', kind: 'creative', label: 'x', state: 'running', createdAt: at, ...over });
  it('a targeted job renders its targets and their followers', () => {
    expect(renderingOf(job({ formats: [REEL] }), s)).toEqual(new Set([REEL, TIKTOK]));
    expect(renderingOf(job({ formats: [POST] }), s)).toEqual(new Set([POST]));
  });
  it('an untargeted job renders every board; a finished one none', () => {
    expect(renderingOf(job({}), s)).toBe('all');
    expect(renderingOf(job({ state: 'succeeded', formats: [REEL] }), s)).toEqual(new Set());
    expect(renderingOf(undefined, s)).toEqual(new Set());
  });
});

describe('defaultTargets ("Applies to")', () => {
  const s = formatStates(detailOf(versions), DEFAULT_FORMATS);
  const primaryOf = (id: string) => s[id]?.follows ?? id;
  it('the formats of the comments, a follower standing for its primary; else All (null)', () => {
    expect(defaultTargets([POST], primaryOf, [REEL, POST])).toEqual([POST]);
    expect(defaultTargets([TIKTOK], primaryOf, [REEL, POST])).toEqual([REEL]);
    expect(defaultTargets([], primaryOf, [REEL, POST])).toBeNull();
    expect(defaultTargets([POST, REEL], primaryOf, [REEL, POST])).toBeNull();
  });
});

describe('version action errors', () => {
  const t = messages('en');
  const coded = (code: string, extra: object = {}) => Object.assign(new Error('server text'), { code, ...extra });
  it('maps every stable code to a clear message', () => {
    const ctx = { label: 'TikTok', primary: 'Reel', n: 3 };
    expect(versionErrorText(coded('hashes-pending'), t, ctx)).toBe('Still computing versions, try again in a moment');
    expect(versionErrorText(coded('pick-follower'), t, ctx)).toMatch(/^TikTok follows Reel/);
    expect(versionErrorText(coded('pick-file-missing'), t, ctx)).toMatch(/TikTok file of v3 is missing/);
    expect(versionErrorText(coded('version-not-found'), t, ctx)).toMatch(/^v3 no longer exists/);
    expect(versionErrorText(coded('link-self'), t, ctx)).toBe('A format can’t follow itself.');
    expect(versionErrorText(coded('link-chain'), t, ctx)).toMatch(/^TikTok can’t follow Reel: a linked format/);
    expect(versionErrorText(coded('link-incompatible'), t, { ...ctx, reason: 'duration' })).toBe('TikTok can’t follow Reel: the main format is longer than its maximum duration.');
    expect(versionErrorText(coded('link-incompatible'), t, ctx)).toBe('server text');
    expect(versionErrorText(coded('format-not-in-brief'), t, ctx)).toBe('TikTok is no longer in the brief. Reload the creative.');
    expect(versionErrorText(coded('pick-no-file'), t, ctx)).toBe('v3 has no TikTok file: it can’t be used for export.');
    expect(versionErrorText(coded('job-running'), t, ctx)).toMatch(/^Wait for the current generation/);
    expect(versionErrorText(coded('formats-not-in-brief'), t, ctx)).toMatch(/^None of the chosen formats/);
    expect(versionErrorText(new Error('boom'), t, ctx)).toBe('That didn’t work: boom');
  });
  it('retries hashes-pending after Retry-After, at most twice, then gives up with the last error', async () => {
    const wait = vi.fn(async () => {});
    const fn = vi.fn(async () => { throw coded('hashes-pending', { retryAfterSec: 2 }); });
    await expect(withHashRetry(fn, wait)).rejects.toMatchObject({ code: 'hashes-pending' });
    expect(fn).toHaveBeenCalledTimes(HASH_RETRIES + 1);
    expect(wait).toHaveBeenCalledWith(2000);
  });
  it('succeeds on a retry, and never retries other errors', async () => {
    const wait = vi.fn(async () => {});
    let calls = 0;
    const ok = await withHashRetry(async () => { calls++; if (calls === 1) throw coded('hashes-pending'); return 'done'; }, wait);
    expect(ok).toBe('done');
    expect(wait).toHaveBeenCalledWith(5000);
    const other = vi.fn(async () => { throw coded('pick-follower'); });
    await expect(withHashRetry(other, wait)).rejects.toMatchObject({ code: 'pick-follower' });
    expect(other).toHaveBeenCalledTimes(1);
  });
});
