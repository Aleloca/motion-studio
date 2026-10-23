// Screenshots of the real Motion Studio for the user guide (site/src/guide.html), in English, light theme (a few dark).
// It starts the real core and web UI (packages/web/dist: run `pnpm build` first) on a demo folder whose path names no user
// (/private/tmp/ms-guide-demo, or GUIDE_DEMO), with an in-memory keychain and the demo agent (site/scripts/guide/
// demo-agent.mjs) in place of Claude Code: no model, no paid service, no real configuration is touched. It seeds an
// "Ember Coffee" project through the app's own API and the UI, drives headless Chrome (throwaway profile, mock keychain)
// and writes site/src/assets/guide/<name>.webp. The demo folder is removed at the end (--keep keeps it).
// Usage: node site/scripts/guide-shots.mjs [--only name,name] [--until step] [--keep]
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
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
const keep = argv.includes('--keep');
const until = argv.includes('--until') ? argv[argv.indexOf('--until') + 1] : null;

/** Demo media made with ffmpeg from the site's own posters: a photo, a short clip and a jingle. */
function makeMedia(dir) {
  const poster = (id) => join(HERE, '..', 'compositions', id, 'poster.webp');
  const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
  ff('-i', poster('hero-16x9'), join(dir, 'ember-hero.png'));
  ff('-i', poster('hero-9x16'), '-vf', 'scale=540:-2', join(dir, 'reel-cover.jpg'));
  ff('-i', poster('brand'), '-vf', 'scale=800:-2', join(dir, 'brand-board.png'));
  ff('-loop', '1', '-i', poster('hero-16x9'), '-t', '6', '-r', '30', '-vf', "scale=1280:720,zoompan=z='min(zoom+0.0015,1.2)':d=180:s=1280x720:fps=30", '-pix_fmt', 'yuv420p', join(dir, 'cafe-loop.mp4'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=4', '-filter_complex', 'amix=inputs=2,afade=t=out:st=3:d=1', join(dir, 'jingle.mp3'));
  return ['ember-hero.png', 'reel-cover.jpg', 'brand-board.png', 'cafe-loop.mp4', 'jingle.mp3'].map((f) => join(dir, f));
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
    if (!keep) rmSync(ROOT, { recursive: true, force: true });
  }
  console.log(`${done.length} screenshots in ${OUT}`);
}

// The CDP socket and fetch's keep-alive would hold the process open: exit once done.
main().then(() => process.exit(0), (e) => { console.error(e.stack ?? e.message); process.exit(1); });
