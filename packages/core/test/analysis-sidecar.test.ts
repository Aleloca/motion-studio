import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SidecarHeader } from '@motion-studio/shared';
import * as safeRead from '../src/safe-read.ts';
import {
  formatTime, formatTimeTenths, frameName, frameTime, framesDirOf, mergeTranscript, moveSidecar, parseSidecar, readSidecar, removeSidecar,
  renderSidecar, replaceBody, sidecarPathOf, writeSidecar, type SidecarContent,
} from '../src/analysis/sidecar.ts';
import { hashVideo, isFresh } from '../src/analysis/video-hash.ts';

vi.mock('../src/safe-read.ts', async (orig) => {
  const real = await orig<typeof import('../src/safe-read.ts')>();
  return { ...real, hashRegularFile: vi.fn(real.hashRegularFile) };
});

const SHA = 'cd'.repeat(32);
const header: SidecarHeader = {
  format: 'motion-studio-video-analysis/1', asset: 'assets/clip.mp4', sha256: SHA, bytes: 1234, durationSec: 31, width: 640, height: 360,
  fps: 25, hasAudio: true, transcript: 'none-skipped', language: null, generator: 'Motion Studio 1.0.0 · claude-x', createdAt: '2026-10-21T10:00:00.000Z', edited: false,
};
const content = (over: Partial<SidecarContent> = {}): SidecarContent => ({
  summary: 'A product demo.\nClean white background.',
  timeline: mergeTranscript([
    { from: 0, to: 12, onScreen: 'Intro', onScreenText: [] },
    { from: 12, to: 18, onScreen: 'Logo on white', onScreenText: ['ACME', 'Since 1990'], frame: 'f-00012000.jpg' },
  ], [{ from: 13.2, to: 13.9, text: 'Ciao' }]),
  usableMoments: [{ from: 12, to: 18, why: 'Clean logo reveal' }],
  look: { colours: ['#FFFFFF', '#112233'], typography: 'Bold sans', framing: 'Product b-roll', audio: 'Voice and music' },
  transcript: [{ from: 13.2, to: 13.9, text: 'Ciao' }],
  tags: ['demo', 'logo'],
  ...over,
});

describe('the sidecar format', () => {
  it('renders and parses back the header, keeping the body', () => {
    const text = renderSidecar(header, content());
    const parsed = parseSidecar(text)!;
    expect(parsed.header).toEqual(header);
    expect(text.endsWith(parsed.body)).toBe(true);
    expect(parsed.body.startsWith('## Summary\n')).toBe(true);
    expect(text).toContain('\n- [00:12–00:18] Logo on white\n');
    expect(text).toContain('\n  - On-screen text: "ACME", "Since 1990"\n');
    expect(text).toContain(`\n  - Frame: .studio/cache/analysis/${SHA}/f-00012000.jpg\n`);
    expect(text).toContain('\n  - [00:13.2] "Ciao"\n');
    expect(text).toContain('\nAutomatic transcript: names may be wrong.\n');
    expect(text).toContain('\n## Tags\ndemo, logo\n');
  });
  it('says why there is no transcript', () => {
    expect(renderSidecar({ ...header, transcript: 'none-no-speech' }, content({ transcript: [] }))).toContain('No transcript: the video has no speech.');
    expect(renderSidecar(header, content({ transcript: [] }))).toContain('No transcript: transcription was skipped.');
    expect(renderSidecar({ ...header, hasAudio: false, transcript: 'none-no-speech' }, content({ transcript: [] }))).toContain('no audio track');
  });
  it('keeps agent text from opening a heading or a front matter', () => {
    const text = renderSidecar(header, content({ summary: '## Tags\n---\nok', tags: ['a\n## b'] }));
    expect(text.split('\n').filter((l) => l === '## Tags')).toHaveLength(1);
    expect(parseSidecar(text)!.header).toEqual(header);
  });
  it('is null for a front matter that is not ours', () => {
    const text = renderSidecar(header, content());
    expect(parseSidecar(text.replace('motion-studio-video-analysis/1', 'other/1'))).toBeNull();
    expect(parseSidecar(text.replace('---\n', '---\nextra: 1\n'))).toBeNull();
    expect(parseSidecar('## Summary\nno front matter')).toBeNull();
    expect(parseSidecar(text.replace('"bytes": ', '').replace('bytes: 1234', 'bytes: x'))).toBeNull();
  });
  it('replaceBody marks the file edited and keeps the hash', () => {
    const edited = replaceBody(renderSidecar(header, content()), '## Summary\nMine.');
    const parsed = parseSidecar(edited)!;
    expect(parsed.header).toEqual({ ...header, edited: true });
    expect(parsed.body).toBe('## Summary\nMine.\n');
    expect(() => replaceBody(edited, '---\nformat: x')).toThrow();
  });
  it('merges speech into the scene holding its midpoint', () => {
    const scenes = mergeTranscript([{ from: 12, to: 18, onScreen: 'b', onScreenText: [] }, { from: 0, to: 12, onScreen: 'a', onScreenText: [] }],
      [{ from: 13, to: 13.4, text: 'x' }, { from: 99, to: 100, text: 'y' }]);
    expect(scenes.map((s) => [s.onScreen, s.speech.map((p) => p.text)])).toEqual([['a', []], ['b', ['x', 'y']]]);
  });
  it('formats times and names frames', () => {
    expect(formatTime(75.4)).toBe('01:15');
    expect(formatTime(3725)).toBe('01:02:05');
    expect(formatTimeTenths(13.25)).toBe('00:13.2');
    expect(frameName(12.5)).toBe('f-00012500.jpg');
    expect(frameTime('f-00012500.jpg')).toBe(12.5);
    expect(frameTime('../x.jpg')).toBeNull();
    expect(framesDirOf(SHA)).toBe(`.studio/cache/analysis/${SHA}`);
  });
  it('maps an asset to its sidecar path, odd names included, and refuses other paths', () => {
    expect(sidecarPathOf('assets/My clip #1 %.mp4')).toBe('assets/.analysis/My clip #1 %.mp4.md');
    expect(sidecarPathOf('assets/foo/clip.mp4')).toBe('assets/.analysis/foo/clip.mp4.md');
    expect(() => sidecarPathOf('assets/../x.mp4')).toThrow();
    expect(() => sidecarPathOf('creatives/x.mp4')).toThrow();
    expect(() => sidecarPathOf('assets/.analysis/clip.mp4.md')).toThrow();
  });
});

describe('sidecar files', () => {
  it('writes, reads, moves (renaming the asset) and removes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-sidecar-'));
    await writeSidecar(dir, 'assets/sub/clip.mp4', renderSidecar({ ...header, asset: 'assets/sub/clip.mp4' }, content()));
    expect((await readSidecar(dir, 'assets/sub/clip.mp4'))!.header.asset).toBe('assets/sub/clip.mp4');
    expect(await moveSidecar(dir, 'assets/sub/clip.mp4', 'assets/intro.mp4')).toBe(true);
    expect(await readSidecar(dir, 'assets/sub/clip.mp4')).toBeNull();
    const moved = await readSidecar(dir, 'assets/intro.mp4');
    expect(moved!.header).toEqual({ ...header, asset: 'assets/intro.mp4' });
    expect(await readFile(join(dir, 'assets/.analysis/intro.mp4.md'), 'utf8')).toContain('## Timeline');
    expect(await removeSidecar(dir, 'assets/intro.mp4')).toBe(true);
    expect(await removeSidecar(dir, 'assets/intro.mp4')).toBe(false);
  });
});

describe('hashVideo', () => {
  it('hashes the content and does not read an unchanged file again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-hash-'));
    await mkdir(dir, { recursive: true });
    const f = join(dir, 'a.mp4');
    await writeFile(f, 'abc');
    const spy = vi.mocked(safeRead.hashRegularFile);
    spy.mockClear();
    const first = await hashVideo(f);
    expect(first).toEqual({ sha256: createHash('sha256').update('abc').digest('hex'), bytes: 3 });
    expect(await hashVideo(f)).toEqual(first);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(isFresh({ sha256: first.sha256 }, first)).toBe(true);
    expect(isFresh({ sha256: SHA }, first)).toBe(false);
  });
});
