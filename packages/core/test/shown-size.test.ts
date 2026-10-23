// @vitest-environment node
/** Round 2 of report 70 (N2): the shown size of a library file is read once per file version, never holding a live message. */
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shownSizeReader } from '../src/library/shown-size.ts';
import { NoMediaTools, type MediaTools } from '../src/media/media-tools.ts';

async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'ms-shown-'));
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'phone.mp4'), 'x');
  return dir;
}
/** A probe that counts its runs and answers when `release` is called (or at once). */
function media(o: { held?: boolean } = {}) {
  let runs = 0;
  const waiting: Array<() => void> = [];
  const tools: MediaTools = { ...NoMediaTools, available: true, probe: async () => {
    runs++;
    if (o.held) await new Promise<void>((r) => waiting.push(r));
    return { width: 1920, height: 1080, durationSec: 3, display: { width: 1080, height: 1920 } };
  } };
  return { tools, runs: () => runs, release: () => waiting.splice(0).forEach((r) => r()) };
}

describe('shownSizeReader (report 70, round 2)', () => {
  it('reads a file once per version: the same size and time read again; a changed file read anew', async () => {
    const dir = await project();
    const m = media();
    const read = shownSizeReader(m.tools);
    expect(await read(dir, 'assets/phone.mp4')).toEqual({ width: 1080, height: 1920 });
    expect(await read(dir, 'assets/phone.mp4')).toEqual({ width: 1080, height: 1920 });
    expect(m.runs()).toBe(1);
    await utimes(join(dir, 'assets', 'phone.mp4'), new Date(), new Date(Date.now() + 5000));
    await read(dir, 'assets/phone.mp4');
    expect(m.runs()).toBe(2);
    // Outside the library, missing, or no ffmpeg: nothing read.
    expect(await read(dir, 'assets/none.mp4')).toBeNull();
    expect(await read(dir, 'other/phone.mp4')).toBeNull();
    expect(await shownSizeReader(NoMediaTools)(dir, 'assets/phone.mp4')).toBeNull();
  });

  it('cachedOnly answers at once: null while the first read runs (started in the background), the size after', async () => {
    const dir = await project();
    const m = media({ held: true });
    const read = shownSizeReader(m.tools);
    expect(await read(dir, 'assets/phone.mp4', { cachedOnly: true })).toBeNull();
    expect(m.runs()).toBe(1);
    m.release();
    await new Promise((r) => setTimeout(r, 10));
    expect(await read(dir, 'assets/phone.mp4', { cachedOnly: true })).toEqual({ width: 1080, height: 1920 });
    expect(m.runs()).toBe(1);
  });

  it('forgets the oldest file beyond its size', async () => {
    const dir = await project();
    await writeFile(join(dir, 'assets', 'b.mp4'), 'y');
    const m = media();
    const read = shownSizeReader(m.tools, 1);
    await read(dir, 'assets/phone.mp4');
    await read(dir, 'assets/b.mp4');
    await read(dir, 'assets/phone.mp4');
    expect(m.runs()).toBe(3);
  });
});
