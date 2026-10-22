#!/usr/bin/env node
// Motion Studio MCP server: a dependency-free stdio bridge. Every tool call is forwarded to the Motion Studio core
// on loopback with the per-job token; the core holds the API keys and does the work.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createInterface } from 'node:readline';

const URL_BASE = (process.env.MOTION_STUDIO_BRIDGE_URL ?? '').replace(/\/+$/, '');
// The launcher hands the token over in a private file (never in argv or the config); the env var is a fallback.
const TOKEN = (() => {
  const file = process.env.MOTION_STUDIO_BRIDGE_TOKEN_FILE;
  if (file) {
    try { return readFileSync(file, 'utf8').trim(); } catch { return ''; }
  }
  return (process.env.MOTION_STUDIO_BRIDGE_TOKEN ?? '').trim();
})();
// Just above the agent's MCP_TOOL_TIMEOUT (15 min): an approval waits for the user with no response headers, so no shorter timeout may apply.
const CAP_MS = Number(process.env.MOTION_STUDIO_BRIDGE_TIMEOUT_MS) || 16 * 60 * 1000;
const ENABLED = new Set((process.env.MOTION_STUDIO_TOOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
/** A variant id: a, b … z, then aa, ab … (decision 978; lower case). */
const VARIANT_ID = { type: 'string', pattern: '^[a-z]{1,3}$', description: 'Variant id, lower case: a, b … z, then aa, ab …' };
const TOOLS = [
  { name: 'approve', description: 'For Motion Studio internal use only (permission requests).', inputSchema: { type: 'object', properties: { tool_name: str('Tool'), input: { type: 'object' }, tool_use_id: str('Id') }, additionalProperties: true } },
  { name: 'report_progress', description: 'Tell the user where you are (one short sentence).', inputSchema: { type: 'object', properties: { message: str('Short sentence', { maxLength: 300 }), phase: { enum: ['reading', 'fonts', 'colors', 'logos', 'tone', 'writing'], description: 'Brand analysis only: the step you are in' } }, required: ['message'] } },
  // Phase 3 of the single agent: the coordinator of a variant group (the agent the user talks to). It hands each variant's work
  // to that variant's own turn; the core checks every id and refuses a variant the user did not point to.
  { name: 'list_variants', description: 'Lists the variants of this creative: id, folder, direction, status (active or discarded), whether it is working now, its latest version per format with status and problems, and the export picks (★).', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'work_on_variants', description: 'Records the work of this turn: one item per variant, with your own instruction for that variant\'s helper (its own agent turn, started when your run ends). Only for variants the user pointed to (pinned comments, named in the message, or picked answering your AskUserQuestion); otherwise it is refused: ask first. Calling it again adds items or replaces the item of the same variant. Returns { ok, plan }. Then end your run with one short sentence.', inputSchema: { type: 'object', properties: {
    items: { type: 'array', minItems: 1, items: { type: 'object', properties: {
      variant: VARIANT_ID,
      instruction: str('What this variant\'s helper must do, concrete and complete', { minLength: 1, maxLength: 4000 }),
      formats: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100, description: 'Only these formats of the variant (default: all)' },
    }, required: ['variant', 'instruction'], additionalProperties: false } },
  }, required: ['items'], additionalProperties: false } },
  { name: 'add_variants', description: 'Creates new variants of this creative (no limit on their number), each with its creative direction; their first generation runs in this turn. Once per turn: a request for one new variant makes one variant. Optional baseFrom: start from a saved version of an existing variant.', inputSchema: { type: 'object', properties: {
    items: { type: 'array', minItems: 1, maxItems: 26, items: { type: 'object', properties: {
      direction: str('One line, 3 to 140 characters, clearly different from the other directions', { minLength: 3, maxLength: 140 }),
      baseFrom: { type: 'object', properties: { variant: VARIANT_ID, version: { type: 'integer', minimum: 1 } }, required: ['variant', 'version'], additionalProperties: false },
    }, required: ['direction'], additionalProperties: false } },
  }, required: ['items'], additionalProperties: false } },
  { name: 'validate_composition', description: 'Checks the compositions of the current version (all formats, or one) against the contract: schema, assets, duration, fonts, html layer checks. Returns problems (to fix) and warnings (advisory).', inputSchema: { type: 'object', properties: { format: str('Format id (optional: all formats when omitted)') } } },
  { name: 'preview_frames', description: 'Renders up to 6 frames of a format\'s composition (PNG, at most 540 px wide) and returns them as images, so you can look at your work. Limited calls per turn. In a translation turn, give the language too: the frames show the translation submitted so far.', inputSchema: { type: 'object', properties: { format: str('Format id'), times: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 1, maxItems: 6, description: 'Times in seconds from the start of the composition' }, locale: str('Translation turns only: the language tag, e.g. "de"') }, required: ['format', 'times'] } },
  { name: 'submit_localization', description: 'Translation turns only: submits the translation of one language and one format (merged with what was submitted before). Returns { ok: true, problems } (fix them and submit again: a shorter text, a smaller fit, a shorter voice script) or { ok: false, errors } (nothing was saved).', inputSchema: { type: 'object', properties: {
    locale: str('Language tag, e.g. "de"'), instanceId: str('Format id, as listed in the request'),
    texts: { type: 'object', additionalProperties: { type: 'string' }, description: 'Translated text per text clip id' },
    params: { type: 'object', additionalProperties: { type: 'string' }, description: 'Translated text per html layer parameter, keyed "<clipId>.<param>"' },
    voiceScripts: { type: 'object', additionalProperties: { type: 'string' }, description: 'Translated voice-over script per voice clip id (Motion Studio generates the audio)' },
    fit: { type: 'object', additionalProperties: { type: 'number', minimum: 0.7, maximum: 1 }, description: 'Optional text scale per text clip id, 0.7 to 1 (omit to let Motion Studio choose)' },
  }, required: ['locale', 'instanceId'], additionalProperties: false } },
  { name: 'submit_variant_directions', description: 'Variant directions turns only: submits one creative direction for each variant that has none, in the order asked. Each direction is one line of 3 to 140 characters, clearly different from the others and from the directions already given. Returns { ok: true } (saved) or { ok: false, errors } (nothing was saved: fix them and submit again).', inputSchema: { type: 'object', properties: {
    directions: { type: 'array', items: { type: 'string', minLength: 3, maxLength: 140 }, minItems: 1, description: 'One direction per variant asked, in the order asked' },
  }, required: ['directions'], additionalProperties: false } },
  { name: 'read_brand_kit', description: 'Reads the project brand kit and guidelines.', inputSchema: { type: 'object', properties: {} } },
  // Decision 1421: a brief session's own tools. The agent writes the user's New creative form; nothing is created.
  { name: 'list_formats', description: 'Brief sessions only: lists the formats of the catalog the user can pick (id, label, channel, kind, size, max video length). Use only these ids in fill_brief.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'fill_brief', description: 'Brief sessions only: writes fields of the user\'s New creative form (give only what changes; call it again to change more). Fields the user edited are kept and listed in `kept`: tell the user. Use `reclaim` only for fields the user\'s latest message explicitly asks you to rewrite. Nothing is created: the user reviews the form and presses Generate.', inputSchema: { type: 'object', properties: {
    goal: { type: 'string', minLength: 1, maxLength: 100000, description: 'What the user wants to make' },
    message: { type: 'string', maxLength: 100000, description: 'The key message shown on screen' },
    notes: { type: 'string', maxLength: 100000, description: 'Notes for the agent that will make the creative' },
    durationSec: { type: ['integer', 'null'], minimum: 1, maximum: 600, description: 'Video length in seconds' },
    assets: { type: 'array', items: { type: 'string' }, description: 'Project library paths from the attached assets' },
    linkedCodebases: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, note: { type: 'string', description: 'What the folder is for' } }, required: ['path'], additionalProperties: false }, description: 'Folders linked to the session, each with a note' },
    formats: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Preset ids from list_formats; N copies of one format (different images or videos on the same brief): the id, then <id>@2 … <id>@N (N at most 20, none left out)' },
    variants: { type: 'integer', minimum: 1, maximum: 5, description: 'Only when the user asks for variants' },
    reclaim: { type: 'array', items: { enum: ['goal', 'message', 'durationSec', 'assets', 'linkedCodebases', 'notes', 'formats', 'variants'] }, description: 'Fields the user edited that their latest message explicitly asks you to rewrite; never on your own initiative' },
  }, additionalProperties: false, minProperties: 1 } },
  // Decision 1468: a video analysis run writes its description of the frames it was given; the core checks the times and frames.
  { name: 'write_video_analysis', description: 'Video analysis jobs only: writes the analysis of the frames you were given. Give exactly the fields your instructions ask for; times are seconds from the start of the video. Calling it again replaces the previous write.', inputSchema: { type: 'object', properties: {
    summary: str('3 to 5 lines: what the video is, its style, what it is good for in a motion graphic', { minLength: 1, maxLength: 2000 }),
    timeline: { type: 'array', maxItems: 200, description: 'The scenes in order', items: { type: 'object', properties: {
      from: { type: 'number', minimum: 0 }, to: { type: 'number', minimum: 0 },
      onScreen: str('What is on screen', { minLength: 1, maxLength: 1000 }),
      onScreenText: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 300 }, description: 'Text visible on screen, verbatim' },
      frame: str('The file name of the frame that shows the scene best, e.g. f-00012000.jpg'),
    }, required: ['from', 'to', 'onScreen'], additionalProperties: false } },
    usableMoments: { type: 'array', maxItems: 30, description: 'Clips worth reusing, with exact in/out times', items: { type: 'object', properties: {
      from: { type: 'number', minimum: 0 }, to: { type: 'number', minimum: 0 }, why: str('Why it is worth reusing', { minLength: 1, maxLength: 300 }),
    }, required: ['from', 'to', 'why'], additionalProperties: false } },
    look: { type: 'object', properties: {
      colours: { type: 'array', maxItems: 12, items: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, description: 'Dominant colours as #rrggbb' },
      typography: str('Typography seen', { maxLength: 300 }), framing: str('Framing: screen recording, talking head, b-roll…', { maxLength: 300 }), audio: str('Audio character: voice, music, silence', { maxLength: 300 }),
    }, required: ['colours', 'typography', 'framing', 'audio'], additionalProperties: false },
    tags: { type: 'array', maxItems: 30, items: { type: 'string', minLength: 1, maxLength: 40 } },
  }, additionalProperties: false, minProperties: 1 } },
  // Task 23: a subtitle translation run hands over its lines; the core checks the ids, the length and the lines on screen.
  { name: 'submit_subtitle_translation', description: 'Subtitle translation jobs only: submits translated lines by id (only the ids you were given). Each text is one plain line of 1 to 200 characters that fits two lines on screen (Motion Studio wraps it). Several calls add up (at most 5). Returns { ok: true, remaining } (the ids still missing); an error names the lines to fix, and nothing of that call is kept.', inputSchema: { type: 'object', properties: {
    cues: { type: 'array', minItems: 1, maxItems: 2000, items: { type: 'object', properties: {
      id: str('Line id, as listed', { minLength: 1, maxLength: 64 }), text: str('The translated line', { minLength: 1, maxLength: 200 }),
    }, required: ['id', 'text'], additionalProperties: false } },
  }, required: ['cues'], additionalProperties: false } },
  { name: 'generate_image', description: 'Generates or edits an image with gpt-image-2 (paid; may ask the user for confirmation). Returns the path of the file saved in the assets.', inputSchema: { type: 'object', properties: { prompt: str('Description'), width: { type: 'integer' }, height: { type: 'integer' }, quality: { enum: ['low', 'medium', 'high', 'auto'] }, background: { enum: ['transparent', 'opaque', 'auto'] }, references: { type: 'array', items: { type: 'string' }, maxItems: 16, description: 'Project images to use as references' }, name: str('File name (optional)') }, required: ['prompt', 'width', 'height'] } },
  { name: 'tts', description: 'Generates a voice-over (paid; may ask for confirmation). Returns the path of the audio file.', inputSchema: { type: 'object', properties: { text: str('Text to read'), provider: { enum: ['openai', 'elevenlabs'] }, voice: str('Voice: an OpenAI voice name, or an ElevenLabs voice id from list_voices (then provider \'elevenlabs\')'), instructions: str('Tone and style (OpenAI only)'), format: { enum: ['mp3', 'wav'] }, name: str('File name (optional)') }, required: ['text'] } },
  { name: 'sound_effect', description: 'Generates a sound effect with ElevenLabs (paid; may ask for confirmation). Returns the path of the audio file saved in the assets. Leave the duration out to let the service choose.', inputSchema: { type: 'object', properties: { prompt: str('Description of the sound (up to 1000 characters)'), durationSec: { type: 'number', minimum: 0.5, maximum: 30 }, loop: { type: 'boolean', description: 'Seamless loop' }, promptInfluence: { type: 'number', minimum: 0, maximum: 1 }, name: str('File name (optional)') }, required: ['prompt'] } },
  { name: 'music', description: 'Generates a music track with ElevenLabs (paid; may ask for confirmation). Returns the path of the audio file saved in the assets.', inputSchema: { type: 'object', properties: { prompt: str('Description of the music (up to 1000 characters)'), durationSec: { type: 'number', minimum: 10, maximum: 300 }, instrumental: { type: 'boolean', description: 'No vocals' }, name: str('File name (optional)') }, required: ['prompt', 'durationSec'] } },
  { name: 'list_voices', description: 'Lists the ElevenLabs voices of the account (free): id, name, labels, preview URL. To use one, call tts with provider \'elevenlabs\' and the id as voice (an ElevenLabs id never works with OpenAI).', inputSchema: { type: 'object', properties: { search: str('Search text (optional)'), limit: { type: 'integer', minimum: 1, maximum: 100 } } } },
  { name: 'stock_search', description: 'Searches photos or videos on Pexels or Unsplash.', inputSchema: { type: 'object', properties: { provider: { enum: ['pexels', 'unsplash'] }, query: str('Search query (works best in English)'), kind: { enum: ['photo', 'video'] }, orientation: { enum: ['landscape', 'portrait', 'square'] }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['provider', 'query'] } },
  { name: 'stock_download', description: 'Downloads a stock result into the project assets, with the required attribution.', inputSchema: { type: 'object', properties: { provider: { enum: ['pexels', 'unsplash'] }, id: str('Result id'), kind: { enum: ['photo', 'video'] } }, required: ['provider', 'id'] } },
  { name: 'fonts_fetch', description: 'Downloads a font from Google Fonts into the project assets.', inputSchema: { type: 'object', properties: { family: str('Family, e.g. "Manrope"'), weights: { type: 'array', items: { type: 'integer' } }, italic: { type: 'boolean' } }, required: ['family'] } },
  { name: 'inspect_site_fonts', description: 'Reads a website\'s HTML and CSS (within limits) and lists its fonts: family, roles (heading, body, button, other), weights, italic, source (google, self-hosted, adobe, system) and font file URLs, plus warnings about what was not read.', inputSchema: { type: 'object', properties: { url: str('http(s) URL of the website page') }, required: ['url'] } },
  { name: 'download_file', description: 'Downloads a file (logo, image or font) from a website into the project assets: give the URL and the destination in assets/brand/ or assets/fonts/', inputSchema: { type: 'object', properties: { url: str('http(s) URL of the file to download'), dest: str('Destination, e.g. "assets/brand/logo.svg" or "assets/fonts/Inter-400.woff2"') }, required: ['url', 'dest'] } },
  { name: 'import_codebase_file', description: 'Brand analysis of a codebase: copies a logo, icon or font file from one of the analysis codebases into the project assets (read-only copy; secret files, files outside the codebase and files over 50 MB are refused; at most 40 calls). Give the source path (relative to the codebase folder, or absolute inside it) and the destination in assets/brand/ or assets/fonts/ with the same extension.', inputSchema: { type: 'object', properties: { source: str('Path of the file in the codebase, e.g. "public/logo.svg"'), dest: str('Destination, e.g. "assets/brand/logo.svg" or "assets/fonts/Inter-400.woff2"') }, required: ['source', 'dest'] } },
  // Decision 917: the agent's actions on the app (creative turns only), with no confirmation card; the chat shows each one.
  // The core checks every input again and acts only on the turn's own creative, its variant group and its project.
  { name: 'update_brief', description: 'Changes the brief of this creative: duration (durationSec), goal, key message, notes, services. Give only what changes. The brief changes when your turn ends; a new durationSec applies to this turn\'s output checks at once. Use it when the user asks, or when the brief clearly needs it (e.g. its text asks for 60 s but its duration says 6).', inputSchema: { type: 'object', properties: {
    durationSec: { type: ['integer', 'null'], minimum: 1, maximum: 600, description: 'Video duration in seconds (null: none)' },
    goal: str('Goal', { minLength: 1, maxLength: 2000 }), message: str('Key message', { maxLength: 500 }), notes: str('Notes', { maxLength: 10000 }),
    services: { type: 'object', properties: { images: { enum: ['auto', 'openai', 'stock', 'none'] }, voice: { enum: ['auto', 'openai', 'elevenlabs', 'none'] }, music: { enum: ['auto', 'elevenlabs', 'none'] }, sfx: { enum: ['auto', 'elevenlabs', 'none'] } }, additionalProperties: false, description: 'The services to change (the others stay)' },
  }, additionalProperties: false } },
  { name: 'add_format', description: 'Adds a format of the catalog to the brief (by preset id, e.g. "youtube-shorts-9x16"). Motion Studio makes it in a turn right after this one: do not write its composition now.', inputSchema: { type: 'object', properties: { format: str('Preset id'), label: str('Optional label', { minLength: 1, maxLength: 60 }) }, required: ['format'], additionalProperties: false } },
  { name: 'duplicate_format', description: 'Duplicates a format of the brief as a second instance (e.g. youtube-16x9 → youtube-16x9@2), from the version you are making, when your turn ends.', inputSchema: { type: 'object', properties: { format: str('Format id of the brief'), label: str('Optional label', { minLength: 1, maxLength: 60 }) }, required: ['format'], additionalProperties: false } },
  { name: 'name_formats', description: 'Gives formats of the brief their short speaking names (what each one shows), shown to the user in the formats list, on the canvas and in the exports. A store screenshot keeps its number in front ("1 · name"). Formats the user named are refused: never rename them. The names are set when your turn ends.', inputSchema: { type: 'object', properties: { names: { type: 'object', additionalProperties: str('Name, one line', { minLength: 1, maxLength: 60 }), minProperties: 1, maxProperties: 100, description: 'Format id → name' } }, required: ['names'], additionalProperties: false } },
  { name: 'add_language', description: 'Adds a language variant: the language goes into the brief and its translation starts when your turn ends. On a brief without languages give the primary language (the one the creative is in) too.', inputSchema: { type: 'object', properties: { locale: str('Language tag, e.g. "de"'), primary: str('Primary language tag, e.g. "it" (only when the brief has no languages yet)'), formats: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100, description: 'Formats to translate (default: all)' } }, required: ['locale'], additionalProperties: false } },
  { name: 'add_variant', description: 'Adds a variant of this creative with its creative direction and starts its first generation (its own agent turn). A creative without variants becomes variant A of a group of two. There is no limit on the number of variants.', inputSchema: { type: 'object', properties: { direction: str('One line, 3 to 140 characters', { minLength: 3, maxLength: 140 }) }, required: ['direction'], additionalProperties: false } },
  { name: 'discard_variant', description: 'Discards a variant of the group (hidden, nothing deleted, restorable). A variant that is working cannot be discarded.', inputSchema: { type: 'object', properties: { variant: VARIANT_ID }, required: ['variant'], additionalProperties: false } },
  { name: 'restore_variant', description: 'Restores a discarded variant of the group.', inputSchema: { type: 'object', properties: { variant: VARIANT_ID }, required: ['variant'], additionalProperties: false } },
  { name: 'set_pick', description: 'Sets the ★ of a format: the version exported. version: a saved version number, or "current" (the version you are making, set when your turn ends). In a variant group, variant names whose version it is (default: yours; the agent of the group always names it, with a saved version).', inputSchema: { type: 'object', properties: { format: str('Format id'), version: { anyOf: [{ type: 'integer', minimum: 1 }, { const: 'current' }] }, variant: VARIANT_ID }, required: ['format', 'version'], additionalProperties: false } },
  { name: 'render_version', description: 'Renders a version\'s video and image files on the user\'s computer: a saved version number now, or "current" (the version you are making) when your turn ends. Optional formats (default: all). The agent of a variant group names the variant and a saved version.', inputSchema: { type: 'object', properties: { version: { anyOf: [{ type: 'integer', minimum: 1 }, { const: 'current' }] }, formats: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 }, variant: VARIANT_ID }, required: ['version'], additionalProperties: false } },
  { name: 'prepare_export', description: 'When your turn ends, renders what the ★ export needs. The user then exports (chooses where the files go): you never write outside the project.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  // Decision 1640 (U9) and Task 19: the subtitles job of this creative, which runs on its own, drawn into the video or files
  // only (phase 3 restored `drawn`, decision 1710); and the agent's corrections of their text. The core checks the input again.
  { name: 'start_subtitles', description: 'Makes the subtitles of this creative from the version you are making in this turn: when your turn ends, its audio is transcribed and cut into subtitle lines, on its own (it may take minutes; the chat tells the user when they are ready, with the editor and the .srt/.vtt downloads). Once per turn. drawn: true when the user wants them drawn into the video (when they are ready, Motion Studio asks you in a new turn to add the subtitles track with their style), false for files or a track in the MP4 only. If the user did not say which, ask with AskUserQuestion first. Never write subtitles as text clips.', inputSchema: { type: 'object', properties: {
    drawn: { type: 'boolean', description: 'true: drawn into the video; false: only as files (.srt/.vtt) or a track in the MP4' },
    lang: str('Only when the user names the spoken language: its tag (e.g. "it", "en", "zh-Hans"). Leave it out to detect it'),
  }, required: ['drawn'], additionalProperties: false } },
  { name: 'edit_subtitles', description: 'Corrects the text of this creative\'s subtitles in one language now; their times stay. replace: a literal text found in every line (case-insensitive unless caseSensitive), e.g. "motion studio" → "Motion Studio"; cues: the whole text of lines by id, each with was, its text as you read it (the ids and texts are in creatives/<slug>/subtitles/<lang>.json: read it just before, never write it); if a line changed since (the user corrected it), nothing is changed: read it again. The lines you change count as the user\'s corrections (a new transcription keeps them). An unknown id changes nothing. Returns how many lines changed.', inputSchema: { type: 'object', properties: {
    lang: str('Language tag of the subtitles, e.g. "it"'),
    replace: { type: 'array', maxItems: 20, items: { type: 'object', properties: {
      find: str('Text to find (literal)', { minLength: 1, maxLength: 200 }), with: str('Replacement', { maxLength: 200 }), caseSensitive: { type: 'boolean', description: 'Match the case exactly (default: no)' },
    }, required: ['find', 'with'], additionalProperties: false } },
    cues: { type: 'array', maxItems: 200, items: { type: 'object', properties: {
      id: str('Line id', { minLength: 1, maxLength: 32 }), was: str('The line\'s text as you read it', { maxLength: 200 }), text: str('The line\'s new text, at most two lines (\\n between them)', { minLength: 1, maxLength: 200 }),
    }, required: ['id', 'was', 'text'], additionalProperties: false } },
  }, required: ['lang'], additionalProperties: false } },
  // Task 25 (spec §6.5, U8): one more subtitle language, made from its own voices or translated. The core checks it again.
  { name: 'add_subtitle_language', description: 'Adds subtitles in another language to this creative now: from that language\'s own voices when its localized video has them, else translated from the subtitles made from the video\'s speech (start_subtitles first when there are none). It runs on its own; the chat tells the user when they are ready. Subtitles only: the video is not translated and the brief\'s languages do not change: for subtitles use this tool, not add_language (which translates the video itself). Refused when the language already has subtitles.', inputSchema: { type: 'object', properties: {
    lang: str('Language tag of the new subtitles, e.g. "en"'),
  }, required: ['lang'], additionalProperties: false } },
];

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const listed = () => TOOLS.filter((t) => t.name === 'approve' || ENABLED.has(t.name));
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

// node:http instead of fetch: undici cuts a request without response headers after 5 minutes.
function post(path, payload) {
  return new Promise((resolve, reject) => {
    const req = request(`${URL_BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-motion-studio-bridge': TOKEN } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    const timer = setTimeout(() => req.destroy(new Error('no response within the maximum time')), CAP_MS);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end(payload);
  });
}

async function call(name, args) {
  if (!listed().some((t) => t.name === name)) return fail(`Tool not available: ${name}`);
  if (!TOKEN) return fail('Motion Studio is unreachable: token missing');
  try {
    const { status, body } = await post(`/api/bridge/${encodeURIComponent(name)}`, JSON.stringify(args ?? {}));
    if (status < 200 || status > 299) return fail(body?.error ?? `Error ${status}`);
    // A result with `images` (preview_frames): the images become image content, the rest stays text.
    if (body && typeof body === 'object' && Array.isArray(body.images)) {
      const { images, ...rest } = body;
      const pictures = images.filter((i) => i && typeof i.data === 'string' && /^image\/(png|jpeg)$/.test(i.mimeType ?? '')).slice(0, 6);
      return { content: [{ type: 'text', text: JSON.stringify(rest) }, ...pictures.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  } catch (err) {
    return fail(`Motion Studio is unreachable: ${err.message}`);
  }
}

let inflight = 0;
let closed = false;
const maybeExit = () => { if (closed && inflight === 0) process.exit(0); };
createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  if (msg.id === undefined) return; // notification
  inflight++;
  try { await handle(msg); } finally { inflight--; maybeExit(); }
}).on('close', () => { closed = true; maybeExit(); });

async function handle(msg) {
  switch (msg.method) {
    case 'initialize':
      return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'studio', version: '0.4.0' } } });
    case 'ping':
      return send({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id: msg.id, result: { tools: listed() } });
    case 'tools/call':
      return send({ jsonrpc: '2.0', id: msg.id, result: await call(msg.params?.name, msg.params?.arguments) });
    default:
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unsupported method: ${msg.method}` } });
  }
}
