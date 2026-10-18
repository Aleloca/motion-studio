import { describe, expect, it } from 'vitest';
import { canFollow, checkLink, defaultLinks, effectiveLinks, entryHasProblems, formatRuns, latestDurationOf, sameDelivery, DEFAULT_FORMATS, followerMatches, followerVersion, formatHistory, legacyTurnKind, linksAfterBriefSave, renderProblems, renderState, starOf, type FormatPreset, type OutputFileInfo, type VersionEntry } from '../src/index.ts';

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
    ['identity formats never share a render (Phase 14): favicon → app icon', preset('identity-favicon'), preset('identity-app-icon'), null, { ok: false, reason: 'kind' }],
    ['identity formats never share a render: App Store icon → logo', preset('appstore-icon'), preset('identity-logo'), null, { ok: false, reason: 'kind' }],
    ['identity formats never share a render: app icon → App Store icon', preset('identity-app-icon'), preset('appstore-icon'), null, { ok: false, reason: 'kind' }],
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
    ['a later version where the follower is still the same copy counts, even if the primary changed there', [ver(1, [out(R, 'a'), out(T, 'a')]), ver(2, [out(R, 'z'), out(T, 'a')])], 1, 2],
    ['a missing hash on the follower file counts as not identical', [ver(1, [out(R, 'a')]), ver(2, [out(R, 'a'), out(T, undefined)])], 1, null],
    ['a missing hash on the ★ file: nothing qualifies, not even the ★ version', [ver(1, [out(R, undefined), out(T, 'x')]), ver(2, [out(R, undefined), out(T, 'y')])], 1, null],
    ['linked after a dedicated render: the dedicated TikTok in the ★ version does not qualify', [ver(1, [out(R, 'a'), out(T, 'b')])], 1, null],
    ['unlink, dedicated turn, relink: only the copy of the Reel ★ qualifies', [ver(1, [out(R, 'a'), out(T, 'a')]), ver(2, [out(R, 'a'), out(T, 'd')])], 1, 1],
    ['unlink, dedicated turn, relink, no copy left: missing', [ver(1, [out(R, 'a'), out(T, 'd1')]), ver(2, [out(R, 'a'), out(T, 'd2')])], 1, null],
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
  it('the same version needs proven, identical hashes too', () => {
    expect(followerMatches([ver(1, [out(R, undefined), out(T, undefined)])], T, 1, 1, links)).toBe(false);
    expect(followerMatches([ver(1, [out(R, 'a'), out(T, undefined)])], T, 1, 1, links)).toBe(false);
    expect(followerMatches([ver(1, [out(R, 'a'), out(T, 'b')])], T, 1, 1, links)).toBe(false);
    expect(followerMatches([ver(1, [out(R, 'a'), out(T, 'a')])], T, 1, 1, links)).toBe(true);
  });
});

// ---------- v2 versions (compositions) and the legacy → v2 boundary (decisions R1, R2) ----------

/** A v2 version: a composition per format (`[format, hash, followsFormat?]`), plus optional renders. */
const v2 = (n: number, comps: Array<[string, string, string?, string[]?]>, outputs: OutputFileInfo[] = [], problems: string[] = []): VersionEntry => ({
  ...ver(n, outputs, problems),
  compositions: comps.map(([format, hash, followsFormat, own]) => ({
    format, dir: `compositions/${followsFormat ?? format}`, hash: h(hash), ...(followsFormat ? { followsFormat } : {}), ...(own ? { problems: own } : {}),
  })),
});
const rendered = (format: string, fileSha: string, fromComp: string | undefined): OutputFileInfo => ({ ...out(format, h(fileSha)), ...(fromComp ? { fromComposition: h(fromComp) } : {}) });

describe('formatHistory with compositions', () => {
  it.each([
    ['v2 only: the composition hash decides', [v2(1, [['reel', 'a']]), v2(2, [['reel', 'a']]), v2(3, [['reel', 'b']])], [1, 3]],
    ['v2: a new render of the same composition is not a change', [v2(1, [['reel', 'a']]), v2(2, [['reel', 'a']], [rendered('reel', 'f', 'a')])], [1]],
    ['v2: the composition wins over differing render bytes', [v2(1, [['reel', 'a']], [rendered('reel', 'f', 'a')]), v2(2, [['reel', 'a']], [rendered('reel', 'g', 'a')])], [1]],
    ['legacy → v2 is a change even when nothing else moved', [ver(1, [out('reel', h('a'))]), v2(2, [['reel', 'a']])], [1, 2]],
    ['legacy → v2 with the v2 render byte-identical to the legacy file is still a change', [ver(1, [out('reel', h('f'))]), v2(2, [['reel', 'a']], [rendered('reel', 'f', 'a')])], [1, 2]],
    ['v2 → legacy (e.g. a restored old version) is a change', [v2(1, [['reel', 'a']]), ver(2, [out('reel', h('a'))])], [1, 2]],
    ['legacy v1–v3 then v2 v4–v5', [ver(1, [out('reel', h('a'))]), ver(2, [out('reel', h('a'))]), ver(3, [out('reel', h('b'))]), v2(4, [['reel', 'c']]), v2(5, [['reel', 'c']])], [1, 3, 4]],
    ['a v2 version without the format breaks the chain', [v2(1, [['reel', 'a']]), v2(2, [['post', 'p']]), v2(3, [['reel', 'a']])], [1, 3]],
    ['a v2 version whose composition is for another format, with a stray file of this one, counts the file', [v2(1, [['post', 'p']], [out('reel', h('a'))]), ver(2, [out('reel', h('a'))])], [1]],
  ] as const)('%s', (_name, versions, expected) => {
    expect(formatHistory([...versions], 'reel')).toEqual(expected);
  });
});

describe('starOf with compositions', () => {
  it('a v2 version without a render still has the format: picks and history see it', () => {
    const vs = [ver(1, [out('reel', h('a'), [])]), v2(2, [['reel', 'c']])];
    expect(starOf(vs, 'reel', undefined, undefined)).toEqual({ version: 2, manual: false, newer: null, follows: null });
    expect(starOf(vs, 'reel', { reel: 1 }, undefined)).toEqual({ version: 1, manual: true, newer: 2, follows: null });
    expect(starOf(vs, 'reel', { reel: 2 }, undefined)).toEqual({ version: 2, manual: true, newer: null, follows: null });
  });
  it('per-format problems of a v2 version: a broken format does not push a clean one off the version', () => {
    // v2: format A (post) is broken, format B (reel) is clean, in the same version.
    const vs = [v2(1, [['reel', 'a', undefined, []], ['post', 'p', undefined, []]]), v2(2, [['reel', 'b', undefined, []], ['post', 'q', undefined, ['post broken']]], [], ['post broken'])];
    expect(starOf(vs, 'reel', undefined, undefined).version).toBe(2);
    expect(starOf(vs, 'post', undefined, undefined).version).toBe(1);
  });
  it('the composition\'s own problems win over its render\'s', () => {
    const vs = [v2(1, [['reel', 'a', undefined, []]]), v2(2, [['reel', 'b', undefined, ['bad']]], [{ ...rendered('reel', 'f', 'b'), problems: [] }], ['bad'])];
    expect(starOf(vs, 'reel', undefined, undefined).version).toBe(1);
  });
  it('a current render with problems (size, duration, resolution, unreadable) is not a clean ★ (final review I2)', () => {
    const vs = [v2(1, [['reel', 'a', undefined, []]], [rendered('reel', 'f', 'a')]), v2(2, [['reel', 'b', undefined, []]], [{ ...rendered('reel', 'g', 'b'), problems: ['too large'] }])];
    expect(renderProblems(vs[1]!, 'reel')).toEqual(['too large']);
    expect(starOf(vs, 'reel', undefined, undefined).version).toBe(1);
    // A manual pick stays (the export asks before copying it).
    expect(starOf(vs, 'reel', { reel: 2 }, undefined).version).toBe(2);
    // A stale render's problems are not the version's: it is rendered again before any export.
    const stale = v2(3, [['reel', 'c', undefined, []]], [{ ...rendered('reel', 'g', 'b'), problems: ['too large'] }]);
    expect(renderProblems(stale, 'reel')).toEqual([]);
    expect(starOf([...vs, stale], 'reel', undefined, undefined).version).toBe(3);
    // Legacy files keep their own rule.
    expect(renderProblems(ver(1, [out('reel', h('a'), ['bad'])]), 'reel')).toEqual([]);
  });
  it('old v2 data without per-format problems falls back to the version-level problems', () => {
    const vs = [v2(1, [['reel', 'a']]), v2(2, [['reel', 'b']], [], ['broken'])];
    expect(starOf(vs, 'reel', undefined, undefined).version).toBe(1);
  });
});

describe('followerVersion and followerMatches with compositions', () => {
  const R = 'instagram-reel-9x16';
  const T = 'tiktok-9x16';
  const links = { [T]: R };
  it.each([
    ['v2: the follower follows the primary composition with the same hash', [v2(1, [[R, 'a'], [T, 'a', R]])], 1, 1],
    ['v2: the latest version following the ★ composition wins', [v2(1, [[R, 'a'], [T, 'a', R]]), v2(2, [[R, 'a'], [T, 'a', R]]), v2(3, [[R, 'b'], [T, 'b', R]])], 1, 2],
    ['v2: a dedicated follower composition (no followsFormat) never qualifies, even with the same hash', [v2(1, [[R, 'a'], [T, 'a']])], 1, null],
    ['v2: following another primary does not qualify', [v2(1, [[R, 'a'], [T, 'a', 'other']])], 1, null],
    ['v2: a different hash does not qualify', [v2(1, [[R, 'a'], [T, 'b', R]])], 1, null],
    ['mixed: a legacy ★ and a v2 follower never match', [ver(1, [out(R, h('a'))]), v2(2, [[R, 'a'], [T, 'a', R]])], 1, null],
    ['mixed: a v2 ★ and a legacy follower file never match, even with equal bytes', [v2(1, [[R, 'a']], [rendered(R, 'f', 'a')]), ver(2, [out(R, h('f')), out(T, h('f'))])], 1, null],
    ['mixed history: a legacy ★ still resolves to its legacy follower copy', [ver(1, [out(R, h('a')), out(T, h('a'))]), v2(2, [[R, 'c'], [T, 'c', R]])], 1, 1],
    ['mixed history: a v2 ★ resolves to its v2 follower', [ver(1, [out(R, h('a')), out(T, h('a'))]), v2(2, [[R, 'c'], [T, 'c', R]])], 2, 2],
  ] as const)('%s', (_name, vs, primaryN, expected) => {
    expect(followerVersion([...vs], T, primaryN, links)).toBe(expected);
  });
  it('followerMatches compares composition hashes across versions', () => {
    const vs = [v2(1, [[R, 'a']]), v2(2, [[R, 'a'], [T, 'a', R]])];
    expect(followerMatches(vs, T, 2, 1, links)).toBe(true);
    expect(followerMatches(vs, T, 1, 1, links)).toBe(false);
  });
});

describe('renderState', () => {
  it.each([
    ['legacy with the media file: rendered (the media is the result)', ver(1, [out('reel', h('a'))]), 'rendered'],
    ['legacy with the media file, hash not computed yet: rendered', ver(1, [out('reel', undefined)]), 'rendered'],
    ['legacy without the format: none', ver(1, [out('post', h('a'))]), 'none'],
    ['v2 without a render: none', v2(1, [['reel', 'a']]), 'none'],
    ['v2 with a render of the current composition: rendered', v2(1, [['reel', 'a']], [rendered('reel', 'f', 'a')]), 'rendered'],
    ['v2 with a render of another composition: stale', v2(1, [['reel', 'b']], [rendered('reel', 'f', 'a')]), 'stale'],
    ['v2 with a render that does not say its composition: stale', v2(1, [['reel', 'a']], [rendered('reel', 'f', undefined)]), 'stale'],
    ['v2 with an output without sha256: none', v2(1, [['reel', 'a']], [{ ...out('reel', undefined), fromComposition: h('a') }]), 'none'],
    ['v2 follower with a copied render of the primary composition: rendered', v2(1, [['reel', 'a'], ['tiktok', 'a', 'reel']], [rendered('tiktok', 'f', 'a')]), 'rendered'],
  ] as const)('%s', (_name, v, expected) => {
    expect(renderState(v, v.compositions?.some((c) => c.format === 'tiktok') ? 'tiktok' : 'reel')).toBe(expected);
  });
});

describe('latestDurationOf with compositions', () => {
  const dur = (o: OutputFileInfo, d: number) => ({ ...o, durationSec: d });
  it('only a current render of the latest version counts', () => {
    expect(latestDurationOf([ver(1, [dur(out('reel', h('a')), 30)]), v2(2, [['reel', 'c']])], 'reel')).toBeUndefined();
    expect(latestDurationOf([v2(1, [['reel', 'c']], [dur(rendered('reel', 'f', 'c'), 20)])], 'reel')).toBe(20);
    expect(latestDurationOf([v2(1, [['reel', 'c']], [dur(rendered('reel', 'f', 'x'), 20)])], 'reel')).toBeUndefined();
    expect(latestDurationOf([ver(1, [dur(out('reel', h('a')), 30)]), v2(2, [['post', 'p']])], 'reel')).toBe(30);
  });
});

describe('legacy turns and brief-save links (final review I4)', () => {
  const legacy = ver(1, [out(REEL.id, h('a'))]);
  it('a brief save links only the formats it adds, against the primaries already there; stored links are kept', () => {
    expect(linksAfterBriefSave({ formats: [REEL.id], links: {} }, [REEL.id, TIKTOK.id], DEFAULT_FORMATS)).toEqual({ [TIKTOK.id]: REEL.id });
    expect(linksAfterBriefSave({ formats: [REEL.id], links: {} }, [REEL.id, POST.id], DEFAULT_FORMATS)).toEqual({});
    expect(linksAfterBriefSave({ formats: [REEL.id, TIKTOK.id], links: {} }, [REEL.id, TIKTOK.id], DEFAULT_FORMATS)).toEqual({});
  });
  it('legacy base: only linked followers added → followers; anything else → convert; v2 or no base → normal', () => {
    expect(legacyTurnKind(legacy, { formats: [REEL.id, TIKTOK.id], links: { [TIKTOK.id]: REEL.id } })).toBe('followers');
    expect(legacyTurnKind(legacy, { formats: [REEL.id, POST.id], links: {} })).toBe('convert');
    expect(legacyTurnKind(legacy, { formats: [REEL.id, TIKTOK.id, POST.id], links: { [TIKTOK.id]: REEL.id } })).toBe('convert');
    expect(legacyTurnKind(legacy, { formats: [REEL.id], links: {} })).toBe('convert');
    expect(legacyTurnKind(v2(1, [[REEL.id, 'a']]), { formats: [REEL.id, POST.id], links: {} })).toBe('normal');
    expect(legacyTurnKind(undefined, { formats: [REEL.id], links: {} })).toBe('normal');
  });
});

describe('sameDelivery (decision 1060: a turn that changes no output makes no version)', () => {
  const loc = (instanceId: string, hash: string) => ({ locale: 'de' as const, instanceId, hash: h(hash), origin: 'agent' as const, stale: [], voice: 'original' as const });
  it.each([
    ['the same compositions', v2(1, [['reel', 'a'], ['post', 'p']]), v2(2, [['post', 'p'], ['reel', 'a']]), true],
    ['one composition changed', v2(1, [['reel', 'a'], ['post', 'p']]), v2(2, [['reel', 'a'], ['post', 'q']]), false],
    ['a format added', v2(1, [['reel', 'a']]), v2(2, [['reel', 'a'], ['post', 'p']]), false],
    ['a format gone', v2(1, [['reel', 'a'], ['post', 'p']]), v2(2, [['reel', 'a']]), false],
    ['a follower unlinked onto the same content', v2(1, [['reel', 'a'], ['tiktok', 'a', 'reel']]), v2(2, [['reel', 'a'], ['tiktok', 'a']]), false],
    ['a new render of the same composition', v2(1, [['reel', 'a']]), v2(2, [['reel', 'a']], [rendered('reel', 'f', 'a')]), true],
    ['legacy files with the same hashes', ver(1, [out('reel', h('a'))]), ver(2, [out('reel', h('a'))]), true],
    ['legacy files without a hash (equality must be proven)', ver(1, [out('reel', undefined)]), ver(2, [out('reel', undefined)]), false],
    ['legacy then v2', ver(1, [out('reel', h('a'))]), v2(2, [['reel', 'a']]), false],
    ['nothing at all on either side', ver(1, []), ver(2, []), false],
  ] as const)('%s', (_name, latest, next, expected) => {
    expect(sameDelivery(latest, next)).toBe(expected);
  });
  it('localization overlays count: a changed or missing overlay is a change', () => {
    const a = { ...v2(1, [['reel', 'a']]), localizations: [loc('reel', 'l')] };
    expect(sameDelivery(a, { ...v2(2, [['reel', 'a']]), localizations: [loc('reel', 'l')] })).toBe(true);
    expect(sameDelivery(a, { ...v2(2, [['reel', 'a']]), localizations: [loc('reel', 'm')] })).toBe(false);
    expect(sameDelivery(a, v2(2, [['reel', 'a']]))).toBe(false);
  });
});

describe('formatRuns and the state of a history entry (decision 1061)', () => {
  it('each history entry spans the versions that kept its content', () => {
    const vs = [v2(1, [['reel', 'a']], [], ['too long']), v2(2, [['reel', 'a']]), v2(3, [['reel', 'b']]), v2(4, [['post', 'p']]), v2(5, [['reel', 'b']])];
    expect(formatRuns(vs, 'reel')).toEqual([{ n: 1, last: 2 }, { n: 3, last: 3 }, { n: 5, last: 5 }]);
    expect(formatRuns(vs, 'nope')).toEqual([]);
  });
  it('an entry has the problems of the latest version with the same content', () => {
    // v1 incomplete (duration off the brief), v2 the same composition checked again against the new brief: clean.
    const vs = [v2(1, [['reel', 'a', undefined, ['too long']]], [], ['too long']), v2(2, [['reel', 'a', undefined, []]])];
    expect(entryHasProblems(vs, 'reel', 1)).toBe(false);
    expect(entryHasProblems([vs[0]!], 'reel', 1)).toBe(true);
    // A third version with another, broken, composition: the clean entry v1 is the default ★.
    const v3 = v2(3, [['reel', 'b', undefined, ['bad']]], [], ['bad']);
    expect(starOf([...vs, v3], 'reel', undefined, undefined).version).toBe(1);
    expect(entryHasProblems([...vs, v3], 'reel', 3)).toBe(true);
  });
});

describe('entryHasProblems and renders (review, decision 1066)', () => {
  it('the entry\'s own current render counts; a later identical version\'s render does not', () => {
    const badRender = { ...rendered('reel', 'f', 'a'), problems: ['too large'] };
    // v1's own render has problems; v2 keeps the content, checked clean: still not a clean ★.
    const own = [v2(1, [['reel', 'a', undefined, ['durata']]], [badRender]), v2(2, [['reel', 'a', undefined, []]])];
    expect(entryHasProblems(own, 'reel', 1)).toBe(true);
    // v1 clean with no render; v2 keeps the content and has a bad render of its own: v1 is clean.
    const later = [v2(1, [['reel', 'a', undefined, []]]), v2(2, [['reel', 'a', undefined, []]], [badRender])];
    expect(entryHasProblems(later, 'reel', 1)).toBe(false);
  });
});
