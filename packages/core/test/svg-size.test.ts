// @vitest-environment node
/** Final wave P1: the size of an SVG without ffprobe and without resolving anything it references. */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { svgSize, svgSizeOf } from '../src/media/svg-size.ts';
import { createFfmpegTools } from '../src/media/media-tools.ts';
import type { CommandExec } from '../src/exec.ts';

describe('svgSizeOf', () => {
  it.each([
    ['<svg width="120" height="80"/>', { width: 120, height: 80 }],
    ["<?xml version='1.0'?><!-- <svg width='1' height='1'> --><svg xmlns='http://www.w3.org/2000/svg' width='10px' height='20px'>", { width: 10, height: 20 }],
    ['<svg viewBox="0 0 300 150">', { width: 300, height: 150 }],
    ['<svg viewBox="0,0,300,150" width="600">', { width: 600, height: 300 }],
    ['<svg width="1in" height="72pt">', { width: 96, height: 96 }],
    ['<svg width="100%" height="100%" viewBox="0 0 40 20">', { width: 40, height: 20 }],
    ['<svg width="100%" height="100%">', null],
    ['<svg>', null],
    ['not an svg', null],
    ['<svg width="1e9" height="10">', null],
  ] as const)('%s', (text, expected) => {
    expect(svgSizeOf(text)).toEqual(expected);
  });

  it('never resolves an entity, a DTD, an image or a stylesheet reference; media tools never run ffmpeg on it', async () => {
    let hits = 0;
    const server = createServer((_q, r) => { hits++; r.end('x'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const dir = mkdtempSync(join(tmpdir(), 'ms-test-svg-'));
    try {
      const file = join(dir, 'logo [1].svg');
      writeFileSync(file, `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "${url}/dtd">]><?xml-stylesheet href="${url}/css"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="32"><image xlink:href="${url}/img.png"/><use href="file:///etc/passwd#a"/>&x;</svg>`);
      expect(await svgSize(file)).toEqual({ width: 64, height: 32 });
      const calls: string[][] = [];
      const exec: CommandExec = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '', notFound: false }; };
      const tools = await createFfmpegTools(exec);
      calls.length = 0;
      expect(await tools.probe(file)).toEqual({ width: 64, height: 32, durationSec: null });
      expect(await tools.frame(file, join(dir, 'f.jpg'), 0)).toBe(false);
      expect(await tools.poster(file, join(dir, 'p.jpg'))).toBe(false);
      expect(calls).toEqual([]);
      expect(hits).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
