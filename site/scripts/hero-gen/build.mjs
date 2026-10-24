// Generates the hero creatives (KOVA Air, TIDEFALL, Fernwise, three formats each) and the home story's boards (story.mjs)
// into site/compositions/:
// composition.json, meta.json and assets/*.svg. Posters are rendered separately (scripts/posters.mjs).
// Usage: node site/scripts/hero-gen/build.mjs [outDir]
// A text not measured yet in widths.json is measured in Chrome first (needs node site/build.mjs), then everything is
// generated again with the real width.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MISSING } from './lib.mjs';
import { writeKova } from './kova.mjs';
import { writeTidefall } from './tidefall.mjs';
import { writeFernwise } from './fernwise.mjs';
import { writeStory, STORY_IDS } from './story.mjs';

export { STORY_IDS };
export const HERO_IDS = ['kova-9x16', 'kova-1x1', 'kova-16x9', 'tidefall-9x16', 'tidefall-4x5', 'tidefall-16x9', 'fernwise-9x16', 'fernwise-1x1', 'fernwise-16x9'];
export const DEFAULT_OUT = fileURLToPath(new URL('../../compositions', import.meta.url));

/** Writes every hero composition under `out`; returns the texts whose width is not in widths.json yet. */
export function generate(out = DEFAULT_OUT) {
  MISSING.clear();
  writeKova(out);
  writeTidefall(out);
  writeFernwise(out);
  writeStory(out);
  return [...MISSING];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2] ? join(process.cwd(), process.argv[2]) : DEFAULT_OUT;
  let missing = generate(out);
  if (missing.length) {
    const { measure } = await import('./measure.mjs');
    console.log(`measured ${await measure(missing)} new text widths`);
    missing = generate(out);
  }
  if (missing.length) { console.error(`unmeasured widths: ${missing.join(', ')}`); process.exit(1); }
  console.log(`hero compositions written to ${out}`);
}
