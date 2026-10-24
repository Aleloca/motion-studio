// Generates Motion Studio's launch film into site/compositions/launch-16x9/: composition.json, meta.json and assets/*.svg.
// The poster is rendered separately (scripts/posters.mjs), the MP4 by render.ts.
// Usage: node site/scripts/launch-gen/build.mjs [outDir]
// A text not measured yet in hero-gen/widths.json is measured in Chrome first (needs node site/build.mjs), then
// everything is generated again with the real width.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MISSING, writeComposition } from '../hero-gen/lib.mjs';
import { launch, launchAssets } from './launch.mjs';

export const LAUNCH_IDS = ['launch-16x9'];
export const DEFAULT_OUT = fileURLToPath(new URL('../../compositions', import.meta.url));
export const POSTER_TIME = 29.2;

/** Writes the launch composition under `out`; returns the texts whose width is not in widths.json yet. */
export function generate(out = DEFAULT_OUT) {
  MISSING.clear();
  writeComposition(out, 'launch-16x9', launch(), {
    format: 'youtube-16x9', posterTime: POSTER_TIME,
    label: 'Motion Studio\'s launch film: a brief typed, three variants, a chat request, a hand edit, the brand from a site, every format, three languages, subtitles, an identity set and the export, ending on "Brief in. Motion out."',
  }, launchAssets());
  return [...MISSING];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2] ? join(process.cwd(), process.argv[2]) : DEFAULT_OUT;
  let missing = generate(out);
  if (missing.length) {
    const { measure } = await import('../hero-gen/measure.mjs');
    console.log(`measured ${await measure(missing)} new text widths`);
    missing = generate(out);
  }
  if (missing.length) { console.error(`unmeasured widths: ${missing.join(', ')}`); process.exit(1); }
  console.log(`launch composition written to ${out}`);
}
