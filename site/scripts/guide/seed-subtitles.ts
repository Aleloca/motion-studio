// Seeds an English subtitle set for a creative of the guide's demo, as the subtitles job would write it from a transcript:
// the cues follow the voice-over's script (the demo has no transcription engine), timed on the latest version's audio with
// the app's own fingerprint, written by the app's own writer. Usage: tsx seed-subtitles.ts <project dir> <creative slug>
import { DEFAULT_FORMATS, SUBTITLES_SCHEMA_ID, type SubtitleCue } from '../../../packages/shared/src/index.ts';
import { subtitleTimingOf } from '../../../packages/core/src/subtitles/subtitles-job.ts';
import { writeSubtitleSet } from '../../../packages/core/src/subtitles/store.ts';
import { CreativeStore } from '../../../packages/core/src/creatives/creative-store.ts';

const [projectDir, slug] = process.argv.slice(2);
if (!projectDir || !slug) throw new Error('usage: seed-subtitles.ts <project dir> <creative slug>');
const store = new CreativeStore(projectDir);
const version = (await store.readVersions(slug)).at(-1)!;
const timing = await subtitleTimingOf(store.dir(slug), version, (await store.get(slug)).brief, DEFAULT_FORMATS);
if (!timing) throw new Error('the latest version has no video format');
const { format } = timing;

// The voice-over's sentences, spread over its length (it starts at 0.5 s; `say` speaks about 2.6 words a second).
const lines = ['Where did twenty twenty-six go?', 'Fernwise shows you,\nin one minute.', 'What you spent,\nwhat you saved,', 'and what comes next.', 'Start free for thirty days.'];
let at = 500;
const cues: SubtitleCue[] = lines.map((text, i) => {
  const words = text.split(/\s+/).length;
  const start = at, end = at + Math.round(words * 390);
  at = end + 120;
  return { id: `c${i + 1}`, start, end, text };
});
const hash = await writeSubtitleSet(store.dir(slug), {
  $schema: SUBTITLES_SCHEMA_ID, lang: 'en', origin: 'speech', transcript: null, detected: 'en',
  timing: { version: version.n, format, fingerprint: timing.fingerprint }, cues,
});
console.log(`subtitles en: ${cues.length} cues, ${hash.slice(0, 12)}`);
