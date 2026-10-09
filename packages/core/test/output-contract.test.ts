import { mkdir, mkdtemp, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outputWarningText, versionEntrySchema, type FormatPreset } from '@motion-studio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { validateOutputs } from '../src/creatives/output-contract.ts';
import { NoMediaTools, type MediaInfo, type MediaTools } from '../src/media/media-tools.ts';

const presets: FormatPreset[] = [
  { id: 'sq', channel: 'Instagram', name: 'Post 1:1', width: 1080, height: 1080, kind: 'video', extensions: ['mp4'], maxDurationSec: 60 },
  { id: 'banner', channel: 'Web', name: 'Banner', width: 300, height: 250, kind: 'image', extensions: ['png', 'jpg'], maxFileMB: 1 },
];
const fakeMedia = (info: Record<string, MediaInfo | null>): MediaTools => ({
  available: true,
  probe: async (f) => info[f.split('/').pop()!] ?? null,
  poster: async (_v, out) => { await mkdir(join(out, '..'), { recursive: true }); await writeFile(out, 'jpg'); return true; },
  frame: async () => true,
});

let dir: string;
beforeEach(async () => { dir = join(await mkdtemp(join(tmpdir(), 'ms-out-')), 'v1'); await mkdir(dir); });
const manifest = (files: unknown[], extra = {}) => writeFile(join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files, tools: ['remotion'], renderCommand: 'npm run render', ...extra }));
const sq = { format: 'sq', file: 'sq.mp4', width: 1080, height: 1080, durationSec: 15 };
const banner = { format: 'banner', file: 'banner.png', width: 300, height: 250 };

describe('validateOutputs', () => {
  it('accepts complete, correct outputs and extracts video posters', async () => {
    await manifest([sq, banner]);
    await writeFile(join(dir, 'sq.mp4'), 'v');
    await writeFile(join(dir, 'banner.png'), 'i');
    const r = await validateOutputs({ dir, requested: ['sq', 'banner'], presets, durationSec: 15,
      media: fakeMedia({ 'sq.mp4': { width: 1080, height: 1080, durationSec: 15.2 }, 'banner.png': { width: 300, height: 250, durationSec: null } }) });
    expect(r.problems).toEqual([]);
    expect(r.tools).toEqual(['remotion']);
    expect(r.renderCommand).toBe('npm run render');
    expect(r.outputs).toEqual([
      { format: 'sq', file: 'sq.mp4', width: 1080, height: 1080, durationSec: 15.2, verified: true, preview: '.previews/sq.mp4.jpg', problems: [] },
      { format: 'banner', file: 'banner.png', width: 300, height: 250, durationSec: null, verified: true, preview: null, problems: [] },
    ]);
  });
  it('accepts null durationSec/renderCommand and ignores durationSec for images', async () => {
    await manifest([{ ...sq, durationSec: null }, { ...banner, durationSec: 99 }], { renderCommand: null });
    await writeFile(join(dir, 'sq.mp4'), 'v');
    await writeFile(join(dir, 'banner.png'), 'i');
    const r = await validateOutputs({ dir, requested: ['sq', 'banner'], presets, durationSec: 15, media: NoMediaTools });
    expect(r.problems).toEqual([]);
    expect(r.renderCommand).toBeNull();
    expect(r.outputs.map((o) => o.durationSec)).toEqual([null, null]);
  });
  it('reports a manifest.json that is a directory instead of throwing', async () => {
    await mkdir(join(dir, 'manifest.json'));
    const r = await validateOutputs({ dir, requested: ['sq'], presets, durationSec: null, media: NoMediaTools });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/^manifest\.json non valido: .*EISDIR/);
  });
  it('reports a missing manifest', async () => {
    const r = await validateOutputs({ dir, requested: ['sq'], presets, durationSec: null, media: NoMediaTools });
    expect(r.problems).toEqual(['manifest.json mancante in v1']);
  });
  it('reports an invalid manifest', async () => {
    await writeFile(join(dir, 'manifest.json'), '{"schemaVersion":1,"files":[{"format":"sq","file":"../x"}]}');
    const r = await validateOutputs({ dir, requested: ['sq'], presets, durationSec: null, media: NoMediaTools });
    expect(r.problems[0]).toMatch(/^manifest.json non valido: /);
  });
  it('lists every kind of problem', async () => {
    await manifest([{ ...sq, file: 'sq.mov' }, { ...banner, file: 'banner.gif' }, { format: 'ghost', file: 'g.png', width: 1, height: 1 }]);
    await writeFile(join(dir, 'banner.gif'), 'x'.repeat(2_000_000));
    const r = await validateOutputs({ dir, requested: ['sq', 'banner', 'ghost', 'missing'], presets, durationSec: null, media: NoMediaTools });
    expect(r.problems).toEqual([
      'File non trovato per sq: sq.mov',
      'banner.gif: estensione .gif non ammessa per banner (ammesse: png, jpg)',
      'banner.gif: 2.0 MB, massimo 1 MB',
      'Preset sconosciuto: ghost (non è nel catalogo formati)',
      'Preset sconosciuto: missing (non è nel catalogo formati)',
    ]);
  });
  it('checks resolution and duration from the probe', async () => {
    await manifest([sq]);
    await writeFile(join(dir, 'sq.mp4'), 'v');
    const r = await validateOutputs({ dir, requested: ['sq'], presets, durationSec: 15,
      media: fakeMedia({ 'sq.mp4': { width: 1080, height: 1350, durationSec: 70 } }) });
    expect(r.problems).toEqual([
      'sq.mp4: risoluzione 1080×1350, attesa 1080×1080',
      'sq.mp4: durata 70.0s oltre il massimo di 60s',
      'sq.mp4: durata 70.0s, richiesta circa 15s',
    ]);
  });
  it('flags a "video" that has no duration', async () => {
    await manifest([sq]);
    await writeFile(join(dir, 'sq.mp4'), 'v');
    const r = await validateOutputs({ dir, requested: ['sq'], presets, durationSec: null, media: fakeMedia({ 'sq.mp4': { width: 1080, height: 1080, durationSec: null } }) });
    expect(r.problems).toEqual(['sq.mp4: non sembra un video']);
  });
  it('falls back to manifest values without media tools and marks outputs unverified', async () => {
    await manifest([{ ...sq, width: 1000 }]);
    await writeFile(join(dir, 'sq.mp4'), 'v');
    const r = await validateOutputs({ dir, requested: ['sq'], presets, durationSec: null, media: NoMediaTools });
    expect(r.problems).toEqual(['sq.mp4: risoluzione 1000×1080, attesa 1080×1080']);
    expect(r.outputs[0]).toMatchObject({ verified: false, preview: null });
  });
  it.skipIf(process.platform === 'win32')('refuses symlinks', async () => {
    await manifest([banner]);
    await symlink('/etc/hosts', join(dir, 'banner.png'));
    const r = await validateOutputs({ dir, requested: ['banner'], presets, durationSec: null, media: NoMediaTools });
    expect(r.problems).toEqual(['File non trovato per banner: banner.png']);
    expect(r.outputs).toEqual([]);
  });
  it('handles poster() rejection gracefully', async () => {
    await manifest([sq]);
    await writeFile(join(dir, 'sq.mp4'), 'v');
    const brokenMedia: MediaTools = {
      available: true,
      probe: async () => ({ width: 1080, height: 1080, durationSec: 15 }),
      poster: async () => { throw new Error('mkdir failed'); },
      frame: async () => true,
    };
    const r = await validateOutputs({ dir, requested: ['sq'], presets, durationSec: null, media: brokenMedia });
    expect(r.problems).toEqual([]);
    expect(r.outputs[0]).toMatchObject({ verified: true, preview: null });
  });
  it.skipIf(process.platform === 'win32')('skips poster when .previews is a symlink', async () => {
    await manifest([sq]);
    await writeFile(join(dir, 'sq.mp4'), 'v');
    const otherDir = await mkdtemp(join(tmpdir(), 'ms-other-'));
    await symlink(otherDir, join(dir, '.previews'));
    const r = await validateOutputs({ dir, requested: ['sq'], presets, durationSec: null,
      media: fakeMedia({ 'sq.mp4': { width: 1080, height: 1080, durationSec: 15 } }) });
    expect(r.problems).toEqual([]);
    expect(r.outputs[0]).toMatchObject({ preview: null });
  });
  it.skipIf(process.platform === 'win32')('skips poster when .previews is a regular file', async () => {
    await manifest([sq]);
    await writeFile(join(dir, 'sq.mp4'), 'v');
    await writeFile(join(dir, '.previews'), 'not a directory');
    const r = await validateOutputs({ dir, requested: ['sq'], presets, durationSec: null,
      media: fakeMedia({ 'sq.mp4': { width: 1080, height: 1080, durationSec: 15 } }) });
    expect(r.problems).toEqual([]);
    expect(r.outputs[0]).toMatchObject({ preview: null });
  });
  it('reports unreadable media when probe returns null with available tools', async () => {
    await manifest([sq]);
    await writeFile(join(dir, 'sq.mp4'), 'v');
    const r = await validateOutputs({ dir, requested: ['sq'], presets, durationSec: null,
      media: fakeMedia({ 'sq.mp4': null }) });
    expect(r.problems).toEqual(['sq.mp4: file non leggibile come media']);
    expect(r.outputs[0]).toMatchObject({ verified: false, preview: null });
  });

  describe('large-file warnings', () => {
    const reel: FormatPreset = { id: 'reel', channel: 'Instagram', name: 'Reel', width: 1080, height: 1920, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 4000 };
    const entry = (durationSec: number | null) => ({ format: 'reel', file: 'reel.mp4', width: 1080, height: 1920, durationSec });
    const put = async (bytes: number) => { await writeFile(join(dir, 'reel.mp4'), ''); await truncate(join(dir, 'reel.mp4'), bytes); };
    const media = (durationSec: number | null, fps?: number) => fakeMedia({ 'reel.mp4': { width: 1080, height: 1920, durationSec, ...(fps ? { fps } : {}) } });
    const run = (m: MediaTools, presetList = [reel]) => validateOutputs({ dir, requested: [presetList[0]!.id], presets: presetList, durationSec: null, media: m });
    it('warns (never a problem) about a 78 MB / 6 s reel (about 104 Mbps)', async () => {
      await manifest([entry(6)]);
      await put(78_000_000);
      const r = await run(media(6));
      expect(r.problems).toEqual([]);
      expect(r.outputs[0]!.warnings).toEqual([{ key: 'outputs.largeFile', params: { sizeMB: 78, mbps: 104, targetMbps: 4, channel: 'Instagram' } }]);
      expect(outputWarningText(r.outputs[0]!.warnings![0]!, 'en')).toBe('Large file: 78 MB at 104 Mbps (about 4 Mbps is plenty for Instagram)');
      expect(outputWarningText(r.outputs[0]!.warnings![0]!, 'it')).toContain('104 Mbps');
    });
    it('does not warn at a 4 Mbps reel', async () => {
      await manifest([entry(6)]);
      await put(3_000_000);
      const r = await run(media(6));
      expect(r.problems).toEqual([]);
      expect(r.outputs[0]!.warnings).toBeUndefined();
    });
    it('60 fps raises the target by 50%: 7 Mbps warns at 30 fps but not at 60', async () => {
      await manifest([entry(6)]);
      await put(5_250_000); // 7 Mbps over 6 s
      expect((await run(media(6, 30))).outputs[0]!.warnings).toHaveLength(1);
      expect((await run(media(6, 60))).outputs[0]!.warnings).toBeUndefined();
    });
    it('does not warn on bitrate when the duration is unknown', async () => {
      await manifest([entry(null)]);
      await put(78_000_000);
      const r = await run(NoMediaTools);
      expect(r.problems).toEqual([]);
      expect(r.outputs[0]!.warnings).toBeUndefined();
    });
    it('a custom video preset without a target derives it from its size and warns, never a problem', async () => {
      const custom: FormatPreset = { id: 'mine', channel: 'Custom', name: 'Mine', width: 1080, height: 1920, kind: 'video', extensions: ['mp4'] };
      await manifest([{ format: 'mine', file: 'mine.mp4', width: 1080, height: 1920, durationSec: 6 }]);
      await writeFile(join(dir, 'mine.mp4'), '');
      await truncate(join(dir, 'mine.mp4'), 78_000_000);
      const r = await validateOutputs({ dir, requested: ['mine'], presets: [custom], durationSec: null, media: NoMediaTools });
      expect(r.problems).toEqual([]);
      expect(r.outputs[0]!.warnings?.[0]?.params).toMatchObject({ mbps: 104, targetMbps: 4 });
    });
    it('never warns on bitrate for GIF or WebM outputs (no H.264 target)', async () => {
      const multi: FormatPreset = { ...reel, extensions: ['mp4', 'gif', 'webm'] };
      for (const ext of ['gif', 'webm']) {
        await manifest([{ ...entry(6), file: `reel.${ext}` }]);
        await writeFile(join(dir, `reel.${ext}`), '');
        await truncate(join(dir, `reel.${ext}`), 78_000_000);
        const r = await validateOutputs({ dir, requested: ['reel'], presets: [multi], durationSec: null, media: NoMediaTools });
        expect(r.problems, ext).toEqual([]);
        expect(r.outputs[0]!.warnings, ext).toBeUndefined();
      }
    });
    it('a documented maxFileMB stays a hard problem, for video too', async () => {
      const x: FormatPreset = { ...reel, maxFileMB: 1 };
      await manifest([entry(600)]);
      await put(3 * 1024 * 1024);
      const r = await run(media(600), [x]);
      expect(r.problems).toHaveLength(1);
      expect(r.outputs[0]!.warnings).toBeUndefined();
    });
    it('an oversized image stays a hard problem, not a warning', async () => {
      await manifest([banner]);
      await writeFile(join(dir, 'banner.png'), '');
      await truncate(join(dir, 'banner.png'), 3 * 1024 * 1024);
      const r = await validateOutputs({ dir, requested: ['banner'], presets, durationSec: null, media: NoMediaTools });
      expect(r.problems).toHaveLength(1);
      expect(r.outputs[0]!.warnings).toBeUndefined();
    });
    it('outputWarningText is safe on unknown keys and non-numeric params', () => {
      expect(outputWarningText({ key: 'x.y', params: {} }, 'en')).toBe('x.y');
      expect(outputWarningText({ key: 'outputs.largeFile', params: { sizeMB: 'a', channel: 'X' } }, 'en')).toBe('outputs.largeFile');
    });
    it('old versions without warnings still parse', () => {
      const old = { n: 1, commit: null, sessionId: null, status: 'complete', createdAt: '2026-10-07T10:00:00.000Z', request: 'x',
        outputs: [{ format: 'sq', file: 'sq.mp4', width: 1, height: 1, durationSec: null, verified: true, preview: null }], problems: [], tools: [], renderCommand: null, basedOn: null };
      expect(versionEntrySchema.safeParse(old).success).toBe(true);
    });
  });
});

describe('validateOutputs per format (phase 9)', () => {
  const vert: FormatPreset = { id: 'vert', channel: 'TikTok', name: 'Video 9:16', width: 1080, height: 1920, kind: 'video', extensions: ['mp4'], maxDurationSec: 60 };
  const all = [...presets, vert];
  it('records each file\'s own problems; the version keeps them all', async () => {
    await manifest([{ ...sq, durationSec: 99 }, banner]);
    await writeFile(join(dir, 'sq.mp4'), 'v');
    await writeFile(join(dir, 'banner.png'), 'i');
    const r = await validateOutputs({ dir, requested: ['sq', 'banner'], presets, durationSec: 99, media: NoMediaTools });
    const sqOut = r.outputs.find((o) => o.format === 'sq')!;
    expect(sqOut.problems).toHaveLength(1);
    expect(sqOut.problems![0]).toContain('99');
    expect(r.outputs.find((o) => o.format === 'banner')!.problems).toEqual([]);
    expect(r.problems).toEqual(sqOut.problems);
  });
  it('checks carried files on presence and dimensions only', async () => {
    // Over the max duration, off target and a wrong extension: none of these counts for a carried file.
    await manifest([{ ...sq, file: 'sq.webm', durationSec: 99 }, { ...banner, width: 10 }]);
    await writeFile(join(dir, 'sq.webm'), 'v');
    await writeFile(join(dir, 'banner.png'), 'i');
    const r = await validateOutputs({ dir, requested: ['sq', 'banner'], presets, durationSec: 15, media: NoMediaTools, carried: ['sq', 'banner'] });
    expect(r.outputs.find((o) => o.format === 'sq')!.problems).toEqual([]);
    expect(r.outputs.find((o) => o.format === 'banner')!.problems).toEqual([expect.stringContaining('10×250')]);
    expect(r.problems).toEqual([expect.stringContaining('10×250')]);
  });
  it('reports a carried file missing on disk', async () => {
    await manifest([sq]);
    const r = await validateOutputs({ dir, requested: ['sq'], presets, durationSec: 15, media: NoMediaTools, carried: ['sq'] });
    expect(r.outputs).toEqual([]);
    expect(r.problems).toEqual([expect.stringContaining('sq.mp4')]);
  });
  it('gives a follower a copy of its primary\'s problems, once in the version, in the requested order', async () => {
    const big = { ...sq, format: 'vert', file: 'vert.mp4', width: 1080, height: 1920, durationSec: 99 };
    await manifest([{ ...big, format: 'follower', file: 'follower.mp4' }, big]);
    await writeFile(join(dir, 'vert.mp4'), 'v');
    await writeFile(join(dir, 'follower.mp4'), 'v');
    const withFollower = [...all, { ...vert, id: 'follower' }];
    const r = await validateOutputs({ dir, requested: ['follower', 'vert'], presets: withFollower, durationSec: 99, media: NoMediaTools, followers: { follower: 'vert' } });
    expect(r.outputs.map((o) => o.format)).toEqual(['follower', 'vert']);
    const primary = r.outputs.find((o) => o.format === 'vert')!;
    expect(primary.problems).toHaveLength(1);
    expect(r.outputs.find((o) => o.format === 'follower')!.problems).toEqual(primary.problems);
    expect(r.problems).toEqual(primary.problems);
  });
});

describe('outputWarningText outputs.keptUnchanged', () => {
  it('names a catalog format in the reader\'s language, any other id as stored', () => {
    const w = { key: 'outputs.keptUnchanged', params: { format: 'instagram-post-1x1' } };
    expect(outputWarningText(w, 'en')).toBe('Instagram · Post 1:1 was not part of this request: the agent’s file was discarded and the previous one kept unchanged');
    expect(outputWarningText(w, 'it')).toMatch(/^Instagram · Post 1:1 non faceva parte di questa richiesta/);
    expect(outputWarningText({ ...w, params: { format: 'custom' } }, 'en')).toMatch(/^custom was not part/);
  });
});

describe('validateOutputs carried problems and reserved names (review fixes)', () => {
  it('a carried file keeps its inherited problems, also in the version list (once)', async () => {
    await manifest([sq, banner]);
    await writeFile(join(dir, 'sq.mp4'), 'v');
    await writeFile(join(dir, 'banner.png'), 'i');
    const r = await validateOutputs({ dir, requested: ['sq', 'banner'], presets, durationSec: 15, media: NoMediaTools, carried: ['sq', 'banner'],
      inherited: { sq: ['vecchio problema'], banner: ['vecchio problema'] } });
    expect(r.outputs.map((o) => o.problems)).toEqual([['vecchio problema'], ['vecchio problema']]);
    expect(r.problems).toEqual(['vecchio problema']);
  });
  it('flags a delivered file that uses a name the core owns, never a carried one', async () => {
    await manifest([{ ...sq, file: 'banner.png' }, { ...banner, file: 'banner.png' }]);
    await writeFile(join(dir, 'banner.png'), 'i');
    const owner = (f: string) => (f === 'banner.png' ? 'banner' : undefined);
    const r = await validateOutputs({ dir, requested: ['sq'], presets, durationSec: null, media: NoMediaTools, reservedOwner: owner });
    expect(r.outputs[0]!.problems).toEqual(expect.arrayContaining([expect.stringContaining('banner.png: questo nome appartiene a banner')]));
    const c = await validateOutputs({ dir, requested: ['banner'], presets, durationSec: null, media: NoMediaTools, carried: ['banner'], reservedOwner: owner });
    expect(c.problems).toEqual([]);
  });
});

