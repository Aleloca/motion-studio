// Renders the launch film to MP4 with the product's own renderer (packages/core: the composition server, headless Chrome
// through the core's ChromeProvider with its isolation flags, ffmpeg), then encodes the site's copy small enough for the
// page and the README (H.264, 1080p, about 1.5 Mbit/s), and writes the poster frame as WebP.
// Usage (the core's tsx; a temp work folder, never the app's own data):
//   node site/build.mjs && node site/scripts/posters.mjs launch-16x9
//   packages/core/node_modules/.bin/tsx site/scripts/launch-gen/render.ts <work dir>
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeComposition } from '../../../packages/shared/src/composition/normalize.ts';
import { validateComposition } from '../../../packages/shared/src/composition/validate.ts';
import { DEFAULT_FORMATS } from '../../../packages/shared/src/formats.ts';
import type { Composition } from '../../../packages/shared/src/composition/schema.ts';
import { ChromeProvider } from '../../../packages/core/src/render/chromium-provider.ts';
import { findFfmpeg } from '../../../packages/core/src/render/encode.ts';
import { renderComposition } from '../../../packages/core/src/render/renderer.ts';
import { findSystemChrome } from '../../../packages/core/src/render/system-chrome.ts';

const SITE = fileURLToPath(new URL('../../', import.meta.url));
const ID = 'launch-16x9';
const OUT = join(SITE, 'src', 'assets', 'video');

const work = process.argv[2];
if (!work) { console.error('usage: render.ts <work dir>'); process.exit(1); }
const format = DEFAULT_FORMATS.find((f) => f.id === 'youtube-16x9')!;
const versionDir = 'outputs/v1';
const compDir = join(work, versionDir, 'compositions', format.id);
mkdirSync(compDir, { recursive: true });
cpSync(join(SITE, 'compositions', ID), compDir, { recursive: true, filter: (p) => !/(meta\.json|poster\.webp)$/.test(p) });
mkdirSync(join(compDir, 'assets', 'fonts'), { recursive: true });
for (const f of readdirSync(join(SITE, 'src', 'assets', 'fonts')).filter((n) => n.endsWith('.woff2'))) copyFileSync(join(SITE, 'src', 'assets', 'fonts', f), join(compDir, 'assets', 'fonts', f));

const composition = normalizeComposition(JSON.parse(readFileSync(join(compDir, 'composition.json'), 'utf8'))) as Composition;
const files = new Map<string, { size: number }>();
const walk = (d: string, rel = '') => { for (const e of readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(join(d, e.name), r); else files.set(r, { size: statSync(join(d, e.name)).size }); } };
walk(compDir);
const { problems } = validateComposition(composition, { format, files });
if (problems.length) { console.error(problems); process.exit(1); }

const chrome = await findSystemChrome();
const ffmpeg = await findFfmpeg();
if (!chrome || !ffmpeg) { console.error('needs Chrome and ffmpeg'); process.exit(1); }
const master = join(work, versionDir, `${format.id}.mp4`);
const started = Date.now();
const r = await renderComposition({
  dir: work, versionDir, composition, format, out: master, quality: 'max', parallel: 4, signal: new AbortController().signal,
  provider: new ChromeProvider({ exe: chrome.exe, kind: 'system', limits: { timeLimitMs: 60 * 60_000 } }),
  ffmpeg, tempDir: work, onProgress: ({ frames, total }) => { if (frames % 150 === 0) console.log(`${frames}/${total}`); },
});
console.log(`master ${r.width}×${r.height}, ${r.frames} frames, ${r.encoder}, ${((Date.now() - started) / 1000).toFixed(0)} s`);

mkdirSync(OUT, { recursive: true });
const site = join(OUT, 'launch.mp4');
execFileSync(ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', master, '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high',
  '-pix_fmt', 'yuv420p', '-b:v', '1500k', '-maxrate', '2500k', '-bufsize', '5000k', '-g', '60', '-movflags', '+faststart', '-an', site]);
console.log(`${site}: ${(statSync(site).size / 1e6).toFixed(2)} MB`);
copyFileSync(join(SITE, 'compositions', ID, 'poster.webp'), join(OUT, 'launch-poster.webp'));
