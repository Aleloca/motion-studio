import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FormatPreset } from '@motion-studio/shared';
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
      { format: 'sq', file: 'sq.mp4', width: 1080, height: 1080, durationSec: 15.2, verified: true, preview: '.previews/sq.jpg' },
      { format: 'banner', file: 'banner.png', width: 300, height: 250, durationSec: null, verified: true, preview: null },
    ]);
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
    await writeFile(join(dir, 'banner.gif'), 'x'.repeat(2 * 1024 * 1024));
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
});
