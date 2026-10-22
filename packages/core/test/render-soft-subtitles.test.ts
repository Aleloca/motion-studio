import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execCommand } from '../src/exec.ts';
import { finalMuxArgs, spawnFfmpeg, subtitleInput, type FfmpegInfo } from '../src/render/encode.ts';
import { hasFfmpeg, probe } from './helpers/analysis-fixtures.ts';

let dir = '';
let ff: FfmpegInfo;
let seg = '';
let list = '';
let wav = '';
let srtIt = '';
let srtEn = '';
const SRT = (t: string) => `1\n00:00:00,100 --> 00:00:00,800\n${t}\n`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ms-soft-subs-'));
  srtIt = join(dir, 'it.srt');
  srtEn = join(dir, 'en.srt');
  await writeFile(srtIt, SRT('Ciao'));
  await writeFile(srtEn, SRT('Hello'));
  if (!hasFfmpeg) return;
  ff = { path: 'ffmpeg' } as FfmpegInfo;
  seg = join(dir, 'seg-00.mp4');
  wav = join(dir, 'mix.wav');
  list = join(dir, 'segments.txt');
  const run = async (args: string[]) => { const r = await execCommand('ffmpeg', ['-y', '-loglevel', 'error', ...args], { timeoutMs: 60_000 }); if (r.code !== 0) throw new Error(r.stderr); };
  await run(['-f', 'lavfi', '-i', 'color=c=red:s=160x120:d=1:r=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', seg]);
  await run(['-f', 'lavfi', '-i', 'sine=f=440:d=1:r=48000', wav]);
  await writeFile(list, `file '${seg}'\n`);
}, 60_000);
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe('finalMuxArgs argv', () => {
  const base = { list: '/w/segments.txt', wav: '/w/mix.wav', hasAudio: true, storeAudio: false, storeKbps: 256, format: 'mp4', out: '/o/out.mp4' };
  it('without soft subtitles the argv is the one recorded from the code before the option', () => {
    const own = (p: string, f: string) => ['-protocol_whitelist', 'file', '-format_whitelist', f, ...(p === '/w/segments.txt' ? ['-f', 'concat', '-safe', '0'] : []), '-i', p];
    expect(finalMuxArgs(base)).toEqual([...own('/w/segments.txt', 'concat,mov,mp4'), ...own('/w/mix.wav', 'wav'),
      '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-c:v', 'copy', '-movflags', '+faststart', '-f', 'mp4', '/o/out.mp4']);
    expect(finalMuxArgs({ ...base, hasAudio: false, wav: undefined })).toEqual([...own('/w/segments.txt', 'concat,mov,mp4'),
      '-map', '0:v:0', '-c:v', 'copy', '-movflags', '+faststart', '-f', 'mp4', '/o/out.mp4']);
    expect(finalMuxArgs({ ...base, soft: [] })).toEqual(finalMuxArgs(base));
  });
  it('maps each track after the audio input with its ISO 639-2 tag', () => {
    const a = finalMuxArgs({ ...base, soft: [{ lang: 'it', srt: '/w/it.srt' }, { lang: 'en', srt: '/w/en.srt' }] });
    expect(a).toContain('-c:s');
    expect(a.slice(a.indexOf('-map', a.indexOf('1:a:0') + 1))).toEqual(expect.arrayContaining(['2:s:0', '3:s:0', 'language=ita', 'language=eng']));
    const noAudio = finalMuxArgs({ ...base, hasAudio: false, wav: undefined, soft: [{ lang: 'it', srt: '/w/it.srt' }] });
    expect(noAudio).toContain('1:s:0');
  });
  it('subtitleInput accepts only the srt demuxer', () => {
    expect(subtitleInput('/w/it.srt')).toEqual(['-protocol_whitelist', 'file', '-format_whitelist', 'srt', '-i', '/w/it.srt']);
  });
});

describe.skipIf(!hasFfmpeg)('soft subtitles through ffmpeg', () => {
  const soft = () => [{ lang: 'it' as const, srt: srtIt }, { lang: 'en' as const, srt: srtEn }];
  const mux = async (format: 'mp4' | 'mov', out: string, o: { audio: boolean; soft?: ReturnType<typeof soft> }) => {
    await spawnFfmpeg(ff, finalMuxArgs({ list, wav, hasAudio: o.audio, storeAudio: false, storeKbps: 256, format, out, ...(o.soft ? { soft: o.soft } : {}) }), {}).done;
    return (await probe(out)).streams;
  };
  it('mp4: two mov_text streams tagged ita and eng, video copied', async () => {
    const s = await mux('mp4', join(dir, 'a.mp4'), { audio: true, soft: soft() });
    const subs = s.filter((x) => x.codec_type === 'subtitle');
    expect(subs.map((x) => x.codec_name)).toEqual(['mov_text', 'mov_text']);
    expect(subs.map((x) => (x.tags as Record<string, string>).language)).toEqual(['ita', 'eng']);
    expect(s.filter((x) => x.codec_type === 'video')).toHaveLength(1);
    expect(s.filter((x) => x.codec_type === 'audio')).toHaveLength(1);
  }, 60_000);
  it('mov output gets a mov_text track (video only)', async () => {
    const s = await mux('mov', join(dir, 'b.mov'), { audio: false, soft: [soft()[0]!] });
    expect(s.filter((x) => x.codec_type === 'subtitle').map((x) => x.codec_name)).toEqual(['mov_text']);
  }, 60_000);
  it('without the option there is no subtitle stream', async () => {
    const s = await mux('mp4', join(dir, 'c.mp4'), { audio: true });
    expect(s.some((x) => x.codec_type === 'subtitle')).toBe(false);
  }, 60_000);
});
