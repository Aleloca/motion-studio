// Generates the launch film's media with the product's own providers (packages/core/src/providers): the voice-over
// (ElevenLabs speech, with the characters' timing for the subtitles), the music bed (ElevenLabs music), the sound effects
// (ElevenLabs sound generation) and the image of the Generate beat (OpenAI images, the model the app uses). Paid calls:
// each one prints what the product estimates it costs and is appended to <cache>/spend.jsonl.
//
//   node site/scripts/audio-gen/build.mjs                 # everything still missing (re-runnable: existing files are kept)
//   node site/scripts/audio-gen/build.mjs voices [search] # the account's ElevenLabs voices (free)
//   node site/scripts/audio-gen/build.mjs trial <openai|elevenlabs> <voice>…   # line 01 in each voice, into the cache
//   node site/scripts/audio-gen/build.mjs voice|sfx|image|music   # one kind only
//   --cache <dir>  raw answers and the spend log (default site/_audio-raw, git-ignored)
//
// Keys: ~/.config/motion-studio-site/elevenlabs.key and openai.key, read here only and sent only in the provider's header.
// Outputs: compositions/launch-16x9/assets/audio/*.mp3 (voice at about -16 LUFS, music and effects lower), the image in
// compositions/launch-16x9/assets/, the voice of the subtitles step in compositions/story-subs/assets/audio/, and
// media.json (durations, the words' timing, waveform peaks) for the generators and the home.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_FILE, IMAGE_PROMPT, LOUDNESS, MUSIC_PROMPT, SFX, sfxFile, VO_LINES, voFile } from './lines.mjs';

// The product's providers are TypeScript with parameter properties: node runs them with --experimental-transform-types.
if (!process.execArgv.includes('--experimental-transform-types')) {
  const r = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const CORE = new URL('../../../packages/core/src/', import.meta.url);
const { requestBytes } = await import(new URL('providers/http.ts', CORE));
const { ELEVENLABS_TTS_MODEL, OPENAI_TTS_MODEL, openaiSpeech } = await import(new URL('providers/tts.ts', CORE));
const { openaiTranscribe } = await import(new URL('transcription/openai-stt.ts', CORE));
const { elevenlabsMusic, elevenlabsSoundEffect, elevenlabsVoices } = await import(new URL('providers/elevenlabs-audio.ts', CORE));
const { generateImage, OPENAI_IMAGE_MODEL } = await import(new URL('providers/openai-images.ts', CORE));
const { sttBill, voiceBill } = await import(new URL('usage/paid-usage.ts', CORE));

const SITE = fileURLToPath(new URL('../../', import.meta.url));
const FILM = join(SITE, 'compositions', 'launch-16x9', 'assets');
const AUDIO = join(FILM, 'audio');
const SUBS_AUDIO = join(SITE, 'compositions', 'story-subs', 'assets', 'audio');
export const MEDIA_FILE = fileURLToPath(new URL('media.json', import.meta.url));

/**
 * The voice of the film, chosen from a trial of line 01 (see the decisions log). ElevenLabs speech gives the characters'
 * timing with the audio; OpenAI speech is timed by OpenAI's transcription with word timestamps, as the app's subtitles are.
 */
export const VOICE = { provider: 'openai', id: 'cedar', name: 'Cedar' };
const INSTRUCTIONS = 'A confident, warm, professional narrator for a software product launch film. Clear and measured, upbeat but never salesy; short pauses at full stops.';
/** The subtitles step of the home plays this line on its board. */
export const SUBS_LINE = 8;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const CACHE = opt('--cache') ?? join(SITE, '_audio-raw');
mkdirSync(CACHE, { recursive: true });

// ---- keys: read only here, never printed ----
const readKey = (name) => readFileSync(join(homedir(), '.config', 'motion-studio-site', `${name}.key`), 'utf8').trim();
const KEYS = {};
const key = (name) => (KEYS[name] ??= readKey(name));
/** Anything that looks like a key is masked from a message before it is printed. */
const redact = (s) => {
  let out = String(s);
  for (const k of Object.values(KEYS)) if (k.length >= 4) out = out.split(k).join('•••');
  return out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-•••').replace(/\b[A-Za-z0-9_-]{32,}\b/g, '•••').replace(/Bearer\s+\S+/gi, 'Bearer •••');
};
const deps = (name) => ({ fetch, timeoutMs: 600_000, apiKey: key(name) });

// ---- spend log ----
let spent = 0;
function bill(what, b) {
  spent += b.costUsd;
  const units = `${b.units.amount} ${b.units.unit}${b.units.estimated ? ' (estimated)' : ''}`;
  console.log(`  paid: ${what}: ${b.provider} ${b.model}, ${units}, about $${b.costUsd.toFixed(4)}`);
  appendFileSync(join(CACHE, 'spend.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), what, provider: b.provider, model: b.model, units: b.units, costUsd: b.costUsd })}\n`);
}

// ---- ffmpeg ----
const ff = (a) => execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...a], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
const duration = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
/** The JSON block loudnorm prints at the end of its log. */
const loudJson = (log) => { const a = log.lastIndexOf('{'); return JSON.parse(log.slice(a, log.indexOf('}', a) + 1)); };
/** Two-pass EBU R128 normalisation to `lufs` (true peak `tp`), written as 44.1 kHz MP3 (mono for the voice). */
function normalize(src, out, [lufs, tp], mono = false) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', src, '-af', `loudnorm=I=${lufs}:TP=${tp}:LRA=11:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = loudJson(r.stderr);
  const af = `loudnorm=I=${lufs}:TP=${tp}:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  ff(['-i', src, '-af', af, '-ar', '44100', ...(mono ? ['-ac', '1'] : []), '-c:a', 'libmp3lame', '-b:a', mono ? '96k' : '160k', out]);
  return Number(m.input_i);
}
/** Integrated loudness and true peak of a file. */
export function loudness(f) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', f, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = loudJson(r.stderr);
  return { lufs: Number(m.input_i), tp: Number(m.input_tp) };
}
/** `n` RMS peaks (0..1, the loudest = 1) of a file, for its waveform. */
function peaks(f, n) {
  const pcm = ff(['-i', f, '-ac', '1', '-ar', '8000', '-f', 'f32le', '-']);
  const s = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * s.length) / n); const b = Math.floor(((i + 1) * s.length) / n);
    let sum = 0; for (let j = a; j < b; j++) sum += s[j] * s[j];
    out.push(Math.sqrt(sum / Math.max(1, b - a)));
  }
  const max = Math.max(...out) || 1;
  return out.map((v) => Math.round((v / max) * 1000) / 1000);
}

const round3 = (v) => Math.round(v * 1000) / 1000;
const readMedia = () => (existsSync(MEDIA_FILE) ? JSON.parse(readFileSync(MEDIA_FILE, 'utf8')) : {});
const writeMedia = (m) => writeFileSync(MEDIA_FILE, `${JSON.stringify(m, null, 2)}\n`);

// ---- voice ----
/** ElevenLabs speech with the characters' timing (the same model and format as the app's speech, on the -with-timestamps route). */
async function speakElevenLabs(voice, text, what) {
  const k = key('elevenlabs');
  const { bytes, headers } = await requestBytes({ fetch, timeoutMs: 120_000 }, `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': k, 'content-type': 'application/json' }, body: JSON.stringify({ text, model_id: ELEVENLABS_TTS_MODEL }),
  }, { provider: 'ElevenLabs', secrets: [k], maxBytes: 50 * 1024 * 1024 });
  const j = JSON.parse(bytes.toString('utf8'));
  const charged = /^\d+$/.test(headers.get('character-cost')?.trim() ?? '') ? Number(headers.get('character-cost').trim()) : text.length;
  bill(what, voiceBill('elevenlabs', charged));
  return { audio: Buffer.from(j.audio_base64, 'base64'), words: wordsOf(j.alignment), timed: true };
}
/** OpenAI speech (the app's call), then its words timed by OpenAI's transcription (the app's subtitles call, words on). */
async function speakOpenAI(voice, text, what, raw) {
  const r = await openaiSpeech(deps('openai'), { text, voice, instructions: INSTRUCTIONS, format: 'mp3' });
  bill(what, r.bill);
  writeFileSync(raw, r.bytes);
  const wav = `${raw}.16k.wav`;
  ff(['-i', raw, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  const t = await openaiTranscribe(deps('openai'), wav, { language: 'en', words: true, signal: new AbortController().signal });
  bill(`${what} timing`, sttBill('openai', duration(wav)));
  const words = matchWords(text, t.words ?? []);
  return { audio: r.bytes, words, timed: !words.byLength };
}
/** The script's words with the transcription's times (the transcription drops punctuation); proportional when they differ. */
function matchWords(text, heard) {
  const words = text.split(/\s+/);
  const bare = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, '');
  // Same count: the transcription's own spelling may differ ("colors"), its times are the words' times.
  if (heard.length === words.length) {
    const odd = words.filter((w, i) => bare(w) !== bare(heard[i].text));
    if (odd.length) console.warn(`  heard differently: ${odd.join(' ')}`);
    return words.map((w, i) => ({ text: w, start: round3(heard[i].from), end: round3(heard[i].to) }));
  }
  console.warn(`  the transcription heard ${heard.length} words for ${words.length}: timed by length`);
  const a = heard[0]?.from ?? 0; const b = heard.at(-1)?.to ?? a + words.length * 0.35;
  const total = words.reduce((n, w) => n + w.length, 0);
  let at = a;
  const out = words.map((w) => { const d = ((b - a) * w.length) / total; const o = { text: w, start: round3(at), end: round3(at + d) }; at += d; return o; });
  return Object.assign(out, { byLength: true });
}
async function speak(voice, text, what, raw) {
  if (voice.provider === 'elevenlabs') {
    const r = await speakElevenLabs(voice.id, text, what);
    writeFileSync(raw, r.audio);
    return r;
  }
  return speakOpenAI(voice.id, text, what, raw);
}
/** Words with their start and end (seconds), from the characters' timing. */
function wordsOf(al) {
  const words = []; let cur = null;
  al.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) { if (cur) words.push(cur); cur = null; return; }
    if (!cur) cur = { text: '', start: al.character_start_times_seconds[i] };
    cur.text += ch; cur.end = al.character_end_times_seconds[i];
  });
  if (cur) words.push(cur);
  return words.map((w) => ({ text: w.text, start: round3(w.start), end: round3(w.end) }));
}

async function voiceOver(media) {
  mkdirSync(AUDIO, { recursive: true });
  media.voice = { provider: VOICE.provider, id: VOICE.id, name: VOICE.name, model: VOICE.provider === 'elevenlabs' ? ELEVENLABS_TTS_MODEL : OPENAI_TTS_MODEL };
  media.vo ??= [];
  for (const [i, text] of VO_LINES.entries()) {
    const file = voFile(i); const out = join(AUDIO, file);
    const known = media.vo[i];
    if (existsSync(out) && known?.text === text && known.voice === VOICE.id && known.timed) continue;
    console.log(`voice ${file}: ${text}`);
    const raw = join(CACHE, `raw-${file}`);
    const { words, timed } = await speak(VOICE, text, `voice ${file}`, raw);
    writeFileSync(`${raw}.words.json`, JSON.stringify(words));
    const before = normalize(raw, out, LOUDNESS.voice, true);
    media.vo[i] = { file, text, voice: VOICE.id, timed, duration: round3(duration(out)), speechStart: words[0].start, speechEnd: words.at(-1).end, words, peaks: peaks(out, 120), sourceLufs: round3(before) };
    writeMedia(media);
  }
  // The subtitles step of the home: its board speaks this line.
  mkdirSync(SUBS_AUDIO, { recursive: true });
  copyFileSync(join(AUDIO, voFile(SUBS_LINE)), join(SUBS_AUDIO, voFile(SUBS_LINE)));
}

async function music(media) {
  const { timeline } = await import('../launch-gen/timeline.mjs');
  const D = timeline(media).D;
  const out = join(AUDIO, 'music.mp3');
  // A music bed a little longer than the film (the composition fades it out at the end).
  const seconds = Math.ceil(D + 2);
  if (existsSync(out) && media.music?.prompt === MUSIC_PROMPT && media.music.asked >= D) return;
  console.log(`music: ${seconds} s`);
  const r = await elevenlabsMusic(deps('elevenlabs'), { prompt: MUSIC_PROMPT, durationSec: seconds, instrumental: true });
  bill('music', r.bill);
  const raw = join(CACHE, 'raw-music.mp3');
  writeFileSync(raw, r.bytes);
  const before = normalize(raw, out, LOUDNESS.music);
  media.music = { file: 'music.mp3', prompt: MUSIC_PROMPT, asked: seconds, duration: round3(duration(out)), peaks: peaks(out, 240), sourceLufs: round3(before) };
  writeMedia(media);
}

async function effects(media) {
  media.sfx ??= {};
  for (const [id, prompt, seconds] of SFX) {
    const out = join(AUDIO, sfxFile(id));
    if (existsSync(out) && media.sfx[id]?.prompt === prompt) continue;
    console.log(`sound effect ${id}`);
    const r = await elevenlabsSoundEffect(deps('elevenlabs'), { prompt, durationSec: seconds, promptInfluence: 0.6 });
    bill(`sound effect ${id}`, r.bill);
    const raw = join(CACHE, `raw-${sfxFile(id)}`);
    writeFileSync(raw, r.bytes);
    normalize(raw, out, LOUDNESS.sfx);
    media.sfx[id] = { file: sfxFile(id), prompt, duration: round3(duration(out)), peaks: peaks(out, 60) };
    writeMedia(media);
  }
}

async function image(media) {
  const out = join(FILM, IMAGE_FILE);
  if (existsSync(out) && media.image?.prompt === IMAGE_PROMPT) return;
  console.log('image');
  const r = await generateImage(deps('openai'), { prompt: IMAGE_PROMPT, width: 1024, height: 1024, quality: 'high', background: 'opaque' });
  bill('image', r.bill);
  const raw = join(CACHE, 'raw-image.png');
  writeFileSync(raw, r.bytes);
  ff(['-i', raw, '-vf', 'scale=900:900:flags=lanczos', '-q:v', '3', out]);
  media.image = { file: IMAGE_FILE, prompt: IMAGE_PROMPT, model: OPENAI_IMAGE_MODEL, width: 900, height: 900 };
  writeMedia(media);
}

async function main() {
  const cmd = args[0] ?? 'all';
  if (cmd === 'voices') {
    const list = await elevenlabsVoices(deps('elevenlabs'), { search: args[1], pageSize: 100 });
    for (const v of list) console.log(`${v.id}  ${v.name}  ${Object.entries(v.labels).map(([k, x]) => `${k}=${x}`).join(' ')}`);
    return;
  }
  if (cmd === 'trial') {
    // trial <provider> <voice>…
    const provider = args[1];
    for (const id of args.slice(2)) {
      const out = join(CACHE, `trial-${provider}-${id}.mp3`);
      if (existsSync(out)) continue;
      const raw = join(CACHE, `trial-${provider}-${id}-raw.mp3`);
      const { words: w } = await speak({ provider, id }, VO_LINES[0], `trial ${provider} ${id}`, raw);
      normalize(raw, out, LOUDNESS.voice, true);
      console.log(`${id}: ${duration(out).toFixed(2)} s, speech ${w[0].start}–${w.at(-1).end} s, ${JSON.stringify(w.map((x) => x.text))}`);
    }
  } else if (['all', 'voice', 'sfx', 'image', 'music'].includes(cmd)) {
    const media = readMedia();
    if (cmd === 'all' || cmd === 'voice') await voiceOver(media);
    if (cmd === 'all' || cmd === 'sfx') await effects(media);
    if (cmd === 'all' || cmd === 'image') await image(media);
    if (cmd === 'all' || cmd === 'music') await music(media);
    writeMedia(media);
  } else throw new Error(`unknown command ${cmd}`);
  console.log(`spent this run: about $${spent.toFixed(4)}`);
}

main().catch((e) => {
  const status = e?.upstreamStatus ?? e?.status;
  console.error(`failed${status ? ` (${status})` : ''}${e?.refusal ? `, ${e.refusal}${e.permissionNamed ? ' (a permission is named)' : ''}` : ''}: ${redact(e?.message ?? e)}`);
  console.log(`spent this run: about $${spent.toFixed(4)}`);
  process.exit(1);
});
