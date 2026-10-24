// Screenshots of the real Motion Studio for the user guide (site/src/guide.html), in English, light theme (a few dark).
// It starts the real core and web UI (packages/web/dist: run `pnpm build` first) on a demo folder whose path names no user
// (/private/tmp/ms-guide-demo, or GUIDE_DEMO), with an in-memory keychain and the demo agent (site/scripts/guide/
// demo-agent.mjs) in place of Claude Code: no model, no paid service, no real configuration is touched. It seeds three
// projects, the brands of the site's hero (KOVA, TIDEFALL, Fernwise), through the app's own API and its UI, drives headless
// Chrome (throwaway profile, mock keychain) and writes site/src/assets/guide/<name>.webp. It never deletes anything: the demo folder stays (it must be empty or absent
// at the start; remove it by hand, or set GUIDE_DEMO to a new folder).
// Usage: node site/scripts/guide-shots.mjs [--only name,name] [--until step]
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './chrome.mjs';
import { startDemo } from './guide/demo.mjs';
import { openApp } from './guide/browser.mjs';
import { SHOTS } from './guide/shots.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = join(HERE, '..', 'src', 'assets', 'guide');
const ROOT = process.env.GUIDE_DEMO ?? '/private/tmp/ms-guide-demo';
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? new Set(argv[argv.indexOf('--only') + 1].split(',')) : null;
const until = argv.includes('--until') ? argv[argv.indexOf('--until') + 1] : null;

/** Demo media made with ffmpeg from the site's own posters: photos, a short clip, a jingle, and a spoken clip for Fernwise. */
function makeMedia(dir) {
  const poster = (id) => join(HERE, '..', 'compositions', id, 'poster.webp');
  const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
  ff('-i', poster('kova-16x9'), join(dir, 'kova-air-hero.png'));
  ff('-i', poster('kova-9x16'), '-vf', 'scale=540:-2', join(dir, 'kova-air-story.jpg'));
  ff('-i', poster('kova-1x1'), '-vf', 'scale=800:-2', join(dir, 'kova-air-square.png'));
  ff('-loop', '1', '-i', poster('kova-16x9'), '-t', '6', '-r', '30', '-vf', "scale=1280:720,zoompan=z='min(zoom+0.0015,1.2)':d=180:s=1280x720:fps=30", '-pix_fmt', 'yuv420p', join(dir, 'kova-air-loop.mp4'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=4', '-filter_complex', 'amix=inputs=2,afade=t=out:st=3:d=1', join(dir, 'kova-chime.mp3'));
  // A talk to camera with real speech (macOS `say`; a tone elsewhere), for the video analysis and its transcription choice.
  const speech = join(dir, 'speech.aiff');
  const said = spawnSync('say', ['-v', 'Samantha', '-o', speech, 'Hi, I am Ana, and I built Fernwise. This year I wanted to know where my money really went. So we made an app that shows you, in one minute, what you spent and what you saved.']).status === 0;
  // Two shots (a cut at 5 s): the Fernwise 16:9 and its 1:1 poster on a forest background.
  ff('-loop', '1', '-t', '5', '-i', poster('fernwise-16x9'), '-loop', '1', '-t', '5', '-i', poster('fernwise-1x1'),
    ...(said ? ['-i', speech] : ['-f', 'lavfi', '-i', 'sine=frequency=200:duration=10']),
    '-filter_complex', '[0]scale=1280:720,setsar=1,fps=30[a];[1]scale=720:720,pad=1280:720:280:0:0x0E2A1F,setsar=1,fps=30[b];[a][b]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a', '-t', '10', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'founder-interview.mp4'));
  return {
    kova: ['kova-air-hero.png', 'kova-air-story.jpg', 'kova-air-square.png', 'kova-air-loop.mp4', 'kova-chime.mp3'].map((f) => join(dir, f)),
    fernwise: [join(dir, 'founder-interview.mp4')],
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const demo = await startDemo({ root: ROOT });
  const chrome = await launchChrome();
  // An interrupted run still stops the two processes it started.
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { Promise.allSettled([chrome.close(), demo.stop()]).then(() => process.exit(130)); });
  const media = makeMedia(demo.dirs.files);
  const done = [];
  try {
    const app = await openApp(chrome, demo.appUrl);
    // Every step runs (each builds on the state the previous ones left); --only limits which images are written.
    const shot = async (name, opts) => {
      if (only && !only.has(name)) return;
      await app.shot(join(OUT, `${name}.webp`), opts);
      done.push(name);
    };
    for (const step of SHOTS) {
      process.stdout.write(`${step.name}… `);
      try { await step.run({ demo, app, media, shot }); } catch (e) {
        // What the page showed when a step failed, next to the demo folder.
        await app.shot(`${ROOT}-failure.webp`).catch(() => {});
        throw e;
      }
      console.log('ok');
      if (step.name === until) break;
    }
    if (app.errors.length) console.log(`page errors:\n${app.errors.join('\n')}`);
  } finally {
    await chrome.close();
    await demo.stop();
  }
  console.log(`${done.length} screenshots in ${OUT}`);
}

// The CDP socket and fetch's keep-alive would hold the process open: exit once done.
main().then(() => process.exit(0), (e) => { console.error(e.stack ?? e.message); process.exit(1); });
