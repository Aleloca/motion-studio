import { mkdir, mkdtemp, readdir, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveGeneratedFile } from '../src/providers/files.ts';
import { generateImage, normalizeImageSize } from '../src/providers/openai-images.ts';

describe('normalizeImageSize', () => {
  it.each([
    [1080, 1920, 1088, 1920],
    [3840, 2160, 3840, 2160],
    [300, 250, 880, 736],
    [728, 90, 1408, 464],
    [8000, 8000, 2880, 2880],
  ])('%i×%i → %i×%i', (w, h, ew, eh) => {
    const r = normalizeImageSize(w, h);
    expect(r).toEqual({ width: ew, height: eh });
    expect(r.width % 16 + r.height % 16).toBe(0);
  });
  it('rejects non-positive sizes', () => {
    expect(() => normalizeImageSize(0, 100)).toThrow();
  });
});

describe('generateImage', () => {
  it('calls generations without references and edits with references', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const png = Buffer.from('fake-png');
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64'), revised_prompt: 'rp' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const a = await generateImage({ fetch: fetchImpl, apiKey: 'sk-x' }, { prompt: 'Banner blu', width: 300, height: 250 });
    expect(a).toMatchObject({ width: 880, height: 736, revisedPrompt: 'rp' });
    expect(a.bytes.equals(png)).toBe(true);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/images/generations');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ model: 'gpt-image-2', size: '880x736', output_format: 'png', n: 1 });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-x');
    await generateImage({ fetch: fetchImpl, apiKey: 'sk-x' }, { prompt: 'Come questo', width: 1024, height: 1024, references: [{ name: 'ref.jpg', bytes: Buffer.from('j') }] });
    expect(calls[1]!.url).toBe('https://api.openai.com/v1/images/edits');
    const form = calls[1]!.init.body as FormData;
    expect(form.get('model')).toBe('gpt-image-2');
    expect((form.getAll('image[]')[0] as File).type).toBe('image/jpeg');
  });
});

describe('saveGeneratedFile', () => {
  it('saves under assets/<dir> with unique names and no temp files', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ms-gen è '));
    expect(await saveGeneratedFile(project, 'generated', 'Logo Blu.png', Buffer.from('a'))).toBe('generated/Logo-Blu.png');
    expect(await saveGeneratedFile(project, 'generated', 'Logo Blu.png', Buffer.from('b'))).toBe('generated/Logo-Blu-2.png');
    expect(await readFile(join(project, 'assets', 'generated', 'Logo-Blu-2.png'), 'utf8')).toBe('b');
    expect((await readdir(join(project, 'assets', 'generated'))).sort()).toEqual(['Logo-Blu-2.png', 'Logo-Blu.png']);
  });
  it('refuses symlinked asset folders and writes nothing outside', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ms-gen-'));
    const outside = await mkdtemp(join(tmpdir(), 'ms-out-'));
    await mkdir(join(project, 'assets'));
    await symlink(outside, join(project, 'assets', 'generated'));
    await expect(saveGeneratedFile(project, 'generated', 'a.png', Buffer.from('x'))).rejects.toMatchObject({ status: 400, message: 'Cartella degli asset non valida' });
    expect(await readdir(outside)).toEqual([]);
    const p2 = await mkdtemp(join(tmpdir(), 'ms-gen-'));
    await symlink(outside, join(p2, 'assets'));
    await expect(saveGeneratedFile(p2, 'audio', 'a.mp3', Buffer.from('x'))).rejects.toMatchObject({ status: 400 });
    expect(await readdir(outside)).toEqual([]);
  });
});
