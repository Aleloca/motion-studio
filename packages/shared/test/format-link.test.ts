import { describe, expect, it } from 'vitest';
import { canFollow, checkLink, defaultLinks, effectiveLinks, latestDurationOf, DEFAULT_FORMATS, followerMatches, followerVersion, formatHistory, starOf, type FormatPreset, type OutputFileInfo, type VersionEntry } from '../src/index.ts';

const preset = (id: string): FormatPreset => DEFAULT_FORMATS.find((f) => f.id === id)!;
const REEL = preset('instagram-reel-9x16');
const TIKTOK = preset('tiktok-9x16');
const SHORTS = preset('youtube-shorts-9x16');
const POST = preset('instagram-post-1x1');
const IMAGE = preset('instagram-image-1x1');
const FB_STORY = preset('facebook-story-9x16');
const APP_PREVIEW = preset('appstore-preview');

describe('canFollow', () => {
  const custom = (over: Partial<FormatPreset>): FormatPreset => ({ ...REEL, id: 'custom', ...over });
  it.each([
    ['Reel → TikTok', REEL, TIKTOK, 30, { ok: true }],
    ['Reel → Shorts at 30 s', REEL, SHORTS, 30, { ok: true }],
    ['Reel → Shorts at 75 s', REEL, SHORTS, 75, { ok: false, reason: 'duration' }],
    ['Reel → Shorts, unknown duration (Shorts has a max)', REEL, SHORTS, null, { ok: false, reason: 'duration' }],
    ['Reel → Facebook Story at 60 s (exactly the max)', REEL, FB_STORY, 60, { ok: true }],
    ['9:16 → 1:1', REEL, POST, 30, { ok: false, reason: 'size' }],
    ['video → image', POST, IMAGE, 30, { ok: false, reason: 'kind' }],
    ['a follower that does not accept every extension of the primary', REEL, custom({ extensions: ['mp4', 'mov'] }), 30, { ok: false, reason: 'extension' }],
    ['App Preview: different size', REEL, APP_PREVIEW, 20, { ok: false, reason: 'size' }],
    ['no max duration on the follower: unknown duration is fine', REEL, custom({ maxDurationSec: undefined }), null, { ok: true }],
    ['follower safe area smaller than the primary', REEL, custom({ safeZone: { top: 300, bottom: 420, left: 60, right: 120 } }), 30, { ok: false, reason: 'safeZone' }],
    ['follower safe area larger than the primary', REEL, custom({ safeZone: { top: 100, bottom: 100, left: 0, right: 0 } }), 30, { ok: true }],
    ['primary without safe zone, follower with one: primary insets are 0', custom({ safeZone: undefined }), REEL, 30, { ok: false, reason: 'safeZone' }],
    ['primary without safe zone, follower with all-zero insets', custom({ safeZone: undefined }), custom({ id: 'zero', safeZone: { top: 0, bottom: 0, left: 0, right: 0 } }), 30, { ok: true }],
    ['missing safe zone data: size check only', REEL, custom({ safeZone: undefined }), 30, { ok: true }],
    ['images: no duration involved', IMAGE, { ...IMAGE, id: 'other-image' }, null, { ok: true }],
  ] as const)('%s', (_name, primary, follower, duration, expected) => {
    expect(canFollow(primary, follower, duration)).toEqual(expected);
  });
});

describe('defaultLinks', () => {
  it.each([
    ['Reel, TikTok, Shorts, Post 1:1: TikTok and Shorts follow the Reel', [REEL, TIKTOK, SHORTS, POST], undefined,
      { 'tiktok-9x16': 'instagram-reel-9x16', 'youtube-shorts-9x16': 'instagram-reel-9x16' }],
    ['the first format of each group is the primary', [TIKTOK, REEL, POST], undefined, { 'instagram-reel-9x16': 'tiktok-9x16' }],
    ['no compatible pair', [REEL, POST, IMAGE], undefined, {}],
    ['a known 75 s duration keeps Shorts out of the group', [REEL, TIKTOK, SHORTS], 75, { 'tiktok-9x16': 'instagram-reel-9x16' }],
    ['an explicit null duration is strict: followers with a max duration stay unlinked', [REEL, TIKTOK, SHORTS], null, {}],
    ['an explicit null duration still links a follower without a max', [REEL, { ...REEL, id: 'no-max', maxDurationSec: undefined }], null, { 'no-max': 'instagram-reel-9x16' }],
    ['a known 30 s duration links both', [REEL, TIKTOK, SHORTS], 30,
      { 'tiktok-9x16': 'instagram-reel-9x16', 'youtube-shorts-9x16': 'instagram-reel-9x16' }],
  ] as const)('%s', (_name, formats, duration, expected) => {
    expect(defaultLinks([...formats], duration)).toEqual(expected);
  });
});

const out = (format: string, sha256: string | undefined, problems?: string[]): OutputFileInfo => ({
  format, file: `${format}.mp4`, width: 1080, height: 1920, durationSec: 15, verified: true, preview: null,
  ...(sha256 === undefined ? {} : { sha256 }), ...(problems ? { problems } : {}),
});
const ver = (n: number, outputs: OutputFileInfo[], problems: string[] = []): VersionEntry => ({
  n, commit: null, sessionId: null, status: problems.length ? 'incomplete' : 'complete', createdAt: '2026-10-09T10:00:00.000Z',
  request: `v${n}`, outputs, problems, tools: [], renderCommand: null, basedOn: n > 1 ? n - 1 : null,
});
const h = (c: string) => c.repeat(64);

describe('formatHistory', () => {
  it.each([
    ['changes at v1, v3 and v5 give [1, 3, 5]',
      [ver(1, [out('reel', h('a'))]), ver(2, [out('reel', h('a'))]), ver(3, [out('reel', h('b'))]), ver(4, [out('reel', h('b'))]), ver(5, [out('reel', h('c'))])],
      [1, 3, 5]],
    ['a missing hash counts as changed', [ver(1, [out('reel', undefined)]), ver(2, [out('reel', undefined)]), ver(3, [out('reel', h('a'))])], [1, 2, 3]],
    ['the first version with the format is included', [ver(1, [out('post', h('a'))]), ver(2, [out('post', h('a')), out('reel', h('b'))]), ver(3, [out('reel', h('b'))])], [2]],
    ['a format that disappears and comes back with the same file counts as new', [ver(1, [out('reel', h('a'))]), ver(2, []), ver(3, [out('reel', h('a'))])], [1, 3]],
    ['unsorted input is read in version order', [ver(3, [out('reel', h('b'))]), ver(1, [out('reel', h('a'))]), ver(2, [out('reel', h('a'))])], [1, 3]],
    ['a format never delivered has no history', [ver(1, [out('post', h('a'))])], []],
  ] as const)('%s', (_name, versions, expected) => {
    expect(formatHistory([...versions], 'reel')).toEqual(expected);
  });
});

describe('starOf', () => {
  const versions = [
    ver(1, [out('reel', h('a'), [])]),
    ver(3, [out('reel', h('b'), [])]),
    ver(5, [out('reel', h('c'), ['too long'])], ['too long']),
  ];
  it.each([
    ['the default picks the latest clean version', versions, undefined, undefined, { version: 3, manual: false, newer: null, follows: null }],
    ['the default is the latest when none is clean',
      [ver(1, [out('reel', h('a'), ['x'])], ['x']), ver(2, [out('reel', h('b'), ['y'])], ['y'])], undefined, undefined,
      { version: 2, manual: false, newer: null, follows: null }],
    ['a manual pick reports newer', versions, { reel: 1 }, undefined, { version: 1, manual: true, newer: 5, follows: null }],
    ['a manual pick on the latest has nothing newer', versions, { reel: 5 }, undefined, { version: 5, manual: true, newer: null, follows: null }],
    ['a pick on a version without the format is ignored', versions, { reel: 9 }, undefined, { version: 3, manual: false, newer: null, follows: null }],
    ['a pick on a version whose file is identical to an earlier one is still valid',
      [ver(1, [out('reel', h('a'), [])]), ver(2, [out('reel', h('a'), [])]), ver(3, [out('reel', h('b'), [])])], { reel: 2 }, undefined,
      { version: 2, manual: true, newer: 3, follows: null }],
    ['an identical-file pick with no change after it has nothing newer',
      [ver(1, [out('reel', h('a'), [])]), ver(2, [out('reel', h('a'), [])])], { reel: 2 }, undefined,
      { version: 2, manual: true, newer: null, follows: null }],
    ['a self-link is ignored', versions, undefined, { reel: 'reel' }, { version: 3, manual: false, newer: null, follows: null }],
    ['a chained link is ignored', versions, undefined, { reel: 'tiktok', tiktok: 'post' }, { version: 3, manual: false, newer: null, follows: null }],
    ['a follower reports follows and has no star of its own', versions, { tiktok: 1 }, { tiktok: 'reel' }, { version: null, manual: false, newer: null, follows: 'reel' }],
    ['legacy versions: problems without per-file data count for every file',
      [ver(1, [out('reel', h('a'))]), ver(2, [out('reel', h('b'))], ['legacy problem'])], undefined, undefined,
      { version: 1, manual: false, newer: null, follows: null }],
    ['per-file problems: another format\'s problem does not count',
      [ver(1, [out('reel', h('a'), [])]), ver(2, [out('reel', h('b'), []), out('post', h('c'), ['bad'])], ['bad'])], undefined, undefined,
      { version: 2, manual: false, newer: null, follows: null }],
    ['no history: no star', [ver(1, [out('post', h('a'))])], undefined, undefined, { version: null, manual: false, newer: null, follows: null }],
  ] as const)('%s', (_name, vs, picks, links, expected) => {
    const formatId = links && Object.hasOwn(links, 'tiktok') && !Object.hasOwn(links, 'reel') ? 'tiktok' : 'reel';
    expect(starOf([...vs], formatId, picks, links)).toEqual(expected);
  });
});

describe('effectiveLinks', () => {
  it.each([
    ['undefined links', undefined, ['a', 'b'], {}],
    ['a valid link is kept', { b: 'a' }, ['a', 'b'], { b: 'a' }],
    ['self-links are dropped', { a: 'a', b: 'a' }, ['a', 'b'], { b: 'a' }],
    ['a follower not in the brief is dropped', { c: 'a' }, ['a', 'b'], {}],
    ['a primary not in the brief is dropped', { b: 'c' }, ['a', 'b'], {}],
    ['chains: the link whose primary is a follower is dropped', { c: 'b', b: 'a' }, ['a', 'b', 'c'], { b: 'a' }],
    ['cycles: both links are dropped', { a: 'b', b: 'a' }, ['a', 'b'], {}],
    ['no formats given: membership is not checked', { z: 'y', y: 'y' }, undefined, { z: 'y' }],
  ] as const)('%s', (_name, links, formats, expected) => {
    expect(effectiveLinks(links, formats)).toEqual(expected);
  });
});

describe('canFollow with an unknown duration (undefined)', () => {
  it('skips the duration check, unlike null', () => {
    expect(canFollow(REEL, SHORTS, undefined)).toEqual({ ok: true });
    expect(canFollow(REEL, SHORTS, null)).toEqual({ ok: false, reason: 'duration' });
    expect(canFollow(REEL, POST, undefined)).toEqual({ ok: false, reason: 'size' });
  });
});

describe('latestDurationOf and checkLink', () => {
  const reelOut = (n: number, durationSec: number | null): VersionEntry => ver(n, [{ ...out('instagram-reel-9x16', h('a')), durationSec }]);
  const presets = [REEL, TIKTOK, SHORTS, POST];
  const brief = { formats: ['instagram-reel-9x16', 'tiktok-9x16', 'youtube-shorts-9x16', 'instagram-post-1x1'], links: { 'tiktok-9x16': 'instagram-reel-9x16' } };
  it('reads the duration of the latest version with the format', () => {
    expect(latestDurationOf([reelOut(1, 30), reelOut(2, 75), ver(3, [])], 'instagram-reel-9x16')).toBe(75);
    expect(latestDurationOf([reelOut(1, 30), reelOut(2, null)], 'instagram-reel-9x16')).toBeUndefined();
    expect(latestDurationOf([], 'instagram-reel-9x16')).toBeUndefined();
  });
  it.each([
    ['self', 'youtube-shorts-9x16', 'youtube-shorts-9x16', [], { ok: false, reason: 'self' }],
    ['unknown follower', 'nope', 'instagram-reel-9x16', [], { ok: false, reason: 'unknown' }],
    ['primary that follows another format', 'youtube-shorts-9x16', 'tiktok-9x16', [], { ok: false, reason: 'chain' }],
    ['follower that has followers', 'instagram-reel-9x16', 'youtube-shorts-9x16', [], { ok: false, reason: 'chain' }],
    ['no render yet: duration skipped', 'youtube-shorts-9x16', 'instagram-reel-9x16', [], { ok: true }],
    ['primary rendered at 75 s', 'youtube-shorts-9x16', 'instagram-reel-9x16', [reelOut(1, 75)], { ok: false, reason: 'duration' }],
    ['primary rendered at 30 s', 'youtube-shorts-9x16', 'instagram-reel-9x16', [reelOut(1, 30)], { ok: true }],
    ['different size', 'instagram-post-1x1', 'instagram-reel-9x16', [], { ok: false, reason: 'size' }],
  ] as const)('%s', (_name, follower, primary, versions, expected) => {
    expect(checkLink(brief, [...versions], presets, follower, primary)).toEqual(expected);
  });
});

describe('followerVersion (decisions log 140)', () => {
  const R = 'instagram-reel-9x16';
  const T = 'tiktok-9x16';
  const links = { [T]: R };
  // The live case: Reel history [1, 2]; v3 changes another format; v4 adds TikTok without the agent (a copy of the Reel).
  const live = [
    ver(1, [out(R, 'a')]),
    ver(2, [out(R, 'b')]),
    ver(3, [out(R, 'b'), out(POST.id, 'p')]),
    ver(4, [out(R, 'b'), out(T, 'b')]),
  ];
  it.each([
    ['added without the agent: the Reel ★ v2 resolves to v4 (same Reel bytes, has TikTok)', live, 2, 4],
    ['manual ★ on v1: no version with TikTok has the v1 Reel → missing', live, 1, null],
    ['the primary version itself holds the follower', [ver(1, [out(R, 'a'), out(T, 'a')])], 1, 1],
    ['the latest qualifying version wins', [ver(1, [out(R, 'a'), out(T, 'a')]), ver(2, [out(R, 'a'), out(T, 'a')])], 1, 2],
    ['a later version with a different primary file does not count', [ver(1, [out(R, 'a'), out(T, 'a')]), ver(2, [out(R, 'z'), out(T, 'z')])], 1, 1],
    ['a missing hash on the candidate counts as not identical', [ver(1, [out(R, 'a')]), ver(2, [out(R, undefined), out(T, 'a')])], 1, null],
    ['a missing hash on the ★ file: only the ★ version itself can match', [ver(1, [out(R, undefined), out(T, 'x')]), ver(2, [out(R, undefined), out(T, 'y')])], 1, 1],
    ['the primary ★ version does not exist', live, 9, null],
    ['no primary ★', live, null, null],
  ] as const)('%s', (_name, vs, primaryN, expected) => {
    expect(followerVersion([...vs], T, primaryN, links)).toBe(expected);
  });
  it('a format that follows nothing resolves to null', () => {
    expect(followerVersion(live, T, 2, {})).toBeNull();
    expect(followerVersion(live, R, 2, links)).toBeNull();
  });
});

describe('followerMatches', () => {
  const R = 'instagram-reel-9x16';
  const T = 'tiktok-9x16';
  const links = { [T]: R };
  const vs = [ver(1, [out(R, 'a')]), ver(2, [out(R, 'b')]), ver(4, [out(R, 'b'), out(T, 'b')])];
  it.each([
    ['v4 for the Reel v2 (identical Reel)', 4, 2, true],
    ['v4 for the Reel v1 (different Reel)', 4, 1, false],
    ['v2 has no TikTok file', 2, 2, false],
    ['an unknown version', 7, 2, false],
  ] as const)('%s', (_name, n, p, expected) => {
    expect(followerMatches(vs, T, n, p, links)).toBe(expected);
  });
  it('the old rule (same version) holds without hashes', () => {
    expect(followerMatches([ver(1, [out(R, undefined), out(T, undefined)])], T, 1, 1, links)).toBe(true);
  });
});
