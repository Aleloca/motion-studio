import { describe, expect, it } from 'vitest';
import { canFollow, defaultLinks, DEFAULT_FORMATS, formatHistory, starOf, type FormatPreset, type OutputFileInfo, type VersionEntry } from '../src/index.ts';

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
    ['a follower reports follows and has no star of its own', versions, { tiktok: 1 }, { tiktok: 'reel' }, { version: null, manual: false, newer: null, follows: 'reel' }],
    ['legacy versions: problems without per-file data count for every file',
      [ver(1, [out('reel', h('a'))]), ver(2, [out('reel', h('b'))], ['legacy problem'])], undefined, undefined,
      { version: 1, manual: false, newer: null, follows: null }],
    ['per-file problems: another format\'s problem does not count',
      [ver(1, [out('reel', h('a'), [])]), ver(2, [out('reel', h('b'), []), out('post', h('c'), ['bad'])], ['bad'])], undefined, undefined,
      { version: 2, manual: false, newer: null, follows: null }],
    ['no history: no star', [ver(1, [out('post', h('a'))])], undefined, undefined, { version: null, manual: false, newer: null, follows: null }],
  ] as const)('%s', (_name, vs, picks, links, expected) => {
    const formatId = links ? 'tiktok' : 'reel';
    expect(starOf([...vs], formatId, picks, links)).toEqual(expected);
  });
});
