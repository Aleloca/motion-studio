import { join } from 'node:path';
import { execCommand } from '../../src/exec.ts';

export const hasFfmpeg = (await execCommand('ffmpeg', ['-version'])).code === 0;

const ff = async (args: string[]) => {
  const r = await execCommand('ffmpeg', ['-y', '-loglevel', 'error', ...args], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(r.stderr);
};
export const probe = async (file: string) => JSON.parse((await execCommand('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file])).stdout) as { streams: Array<Record<string, unknown>> };

/** The fixtures: a name starting with `-` and holding `%` (review focus 5), 3 s red, 3 s blue, 25 s green, a tone for 6 s. */
export async function makeAnalysisFixtures(into: string) {
  const clip = join(into, '-a clip %.mp4');
  await ff(['-f', 'lavfi', '-i', 'color=c=red:s=640x360:d=3:r=25', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=3:r=25', '-f', 'lavfi', '-i', 'color=c=green:s=640x360:d=25:r=25',
    '-f', 'lavfi', '-i', 'sine=f=1000:d=6:r=16000', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a]apad=whole_dur=31[a]',
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '31', clip]);
  const silent = join(into, 'silent.mp4');
  await ff(['-f', 'lavfi', '-i', 'color=c=gray:s=320x240:d=12:r=25', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', silent]);
  const noaudio = join(into, 'noaudio.mp4');
  await ff(['-f', 'lavfi', '-i', 'color=c=white:s=320x240:d=4:r=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', noaudio]);
  const big = join(into, 'big.mp4');
  await ff(['-f', 'lavfi', '-i', 'color=c=yellow:s=1920x1080:d=1:r=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', big]);
  return { clip, silent, noaudio, big };
}


/** An 8 s video of two scenes (red, blue) at 320×240, with a silent track or a tone. */
export async function twoScenes(out: string, audio: 'silent' | 'tone' | 'none' = 'silent') {
  const a = audio === 'none' ? [] : ['-f', 'lavfi', '-i', audio === 'tone' ? 'sine=f=440:d=8:r=16000' : 'anullsrc=r=16000:cl=mono'];
  await ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=4:r=25', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=4:r=25', ...a,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', ...(a.length ? ['-map', '2:a'] : []), '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(a.length ? ['-c:a', 'aac'] : []), out]);
  return out;
}
