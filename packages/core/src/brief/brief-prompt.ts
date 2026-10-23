import { BRIEF_FIELDS, BRIEF_VARIANTS_MAX, MAX_INSTANCES, type BriefField, type BriefForm, type ConversationEntry, type Locale } from '@motion-studio/shared';
import { chatReplyInstruction } from '../i18n.ts';
import { defuseTags, quotePromptString, USER_REQUEST_CLOSE, USER_REQUEST_OPEN, VIDEO_ANALYSIS_RULE } from '../creatives/prompt.ts';

/**
 * Decision 1421: the prompts of a brief session. The first run (and the fresh restart after a lost session, with the digest
 * of the chat) gets the role, what the fields mean and the rules; every later message gets the form and the context as
 * they are now (the agent sees the user's edits, spec §5.2) and the user's words.
 */

export interface BriefPromptContext {
  locale: Locale;
  form: BriefForm;
  userEdited: readonly BriefField[];
  /** The folders linked to the session that exist now, with the user's note. */
  codebases: ReadonlyArray<{ path: string; note?: string }>;
  /** Folders linked to the session that are gone (said, not fatal: spec §8). */
  missingCodebases: readonly string[];
  /** Library paths attached to the session. */
  assets: readonly string[];
  /** Decision 1468: the attached videos with a fresh analysis file (asset → its analysis file). */
  analyses?: Record<string, string>;
  /** Report 70: what the library knows of the attached videos and images (asset → kind, size, length), when it knows it. */
  assetFacts?: Record<string, AssetFacts>;
  /** The user's words of this message (or of the queued messages, joined). */
  request: string;
}

/** Report 70: an attached asset as the library knows it (its size and length are null when not read). */
export interface AssetFacts { kind: string; width: number | null; height: number | null; durationSec?: number | null }

/** `video 1920×1188, 149.3 s`, `image 1080×1080`; null when the library knows neither size nor length. */
const factsText = (f: AssetFacts | undefined): string | null => {
  if (!f || (f.kind !== 'video' && f.kind !== 'image')) return null;
  const parts = [...(f.width && f.height ? [`${f.width}×${f.height}`] : []), ...(f.kind === 'video' && f.durationSec ? [`${Math.round(f.durationSec * 10) / 10} s`] : [])];
  return parts.length ? `${f.kind} ${parts.join(', ')}` : null;
};

const formLine = (field: BriefField, form: BriefForm, mine: boolean): string => {
  const v = form[field];
  const shown = typeof v === 'string' ? quotePromptString(v)
    : v === null ? '(not set)'
      : typeof v === 'number' ? String(v)
        : field === 'linkedCodebases' ? (form.linkedCodebases.length ? form.linkedCodebases.map((c) => `${quotePromptString(c.path)}${c.note ? ` (${quotePromptString(c.note)})` : ''}`).join(', ') : '(none)')
          : (v as string[]).length ? (v as string[]).join(', ') : '(none)';
  return `- ${field}: ${shown}${mine ? " (the user's: never change it unless they ask, see reclaim)" : ''}`;
};

function formSection(i: Pick<BriefPromptContext, 'form' | 'userEdited'>): string[] {
  return [
    "## The user's form now",
    ...BRIEF_FIELDS.map((f) => formLine(f, i.form, i.userEdited.includes(f))),
    "A field marked as the user's was changed by them after your last write: fill_brief keeps it as it is and lists it in `kept`. Tell the user if you think it should change.",
    "Only when the user's latest message explicitly asks you to rewrite such a field (for example \"rewrite the goal\"), pass it in fill_brief's `reclaim` together with its new value; never on your own initiative. In your reply, say which fields you rewrote.",
  ];
}

function contextSection(i: Pick<BriefPromptContext, 'codebases' | 'missingCodebases' | 'assets' | 'analyses' | 'assetFacts'>, projectCodebases: readonly string[] = []): string[] {
  const out: string[] = [];
  if (i.codebases.length || i.missingCodebases.length || projectCodebases.length) {
    out.push('', '## Reference codebases (read-only)',
      // The user's notes and the library's file names are quoted: neither can end the line or open a section.
      ...i.codebases.map((c) => `- ${c.path}${c.note ? `: ${quotePromptString(c.note)}` : ''}`),
      ...i.missingCodebases.map((p) => `- ${p}: not available in this turn`),
      ...projectCodebases.map((p) => `- ${p} (already linked to the project: do not add them)`),
      'Only read these folders (Read and Glob): you cannot change them, run commands or search file contents. Never read or quote secrets (keys, tokens, .env files).');
  }
  const facts = (a: string) => { const f = factsText(i.assetFacts?.[a]); return f ? ` (${f})` : ''; };
  out.push('', '## Attached assets', ...(i.assets.length ? i.assets.map((a) => `- ${quotePromptString(a)}${facts(a)}${i.analyses?.[a] ? ` (analysis: ${quotePromptString(i.analyses[a])} — read it before opening the video)` : ''}`) : ['(none yet)']));
  if (i.assets.some((a) => i.analyses?.[a])) out.push(VIDEO_ANALYSIS_RULE);
  return out;
}

/**
 * Report 70: the brief chat replies in the language the user writes in, and (the user's ruling of round 1) the brief's fields
 * are written in that language too, not the app's: the text shown in the video comes from them.
 */
const briefReply = (locale: Locale) => chatReplyInstruction(locale, "Write the brief's fields (goal, message, notes) in the language the user writes in too, whatever the app's language, unless they ask for another language: the text shown in the video comes from them.");

/**
 * Report 70 (spec of the subtitles, U3, U9, §6.2, §6.4): subtitles are made by the app's subtitles feature after Generate;
 * the brief chat only asks drawn or track/file and records the answer in the notes, in a fixed line the creative reads.
 */
const SUBTITLES_SECTION = [
  '## Subtitles',
  '- Motion Studio makes the subtitles itself after Generate: the creative\'s agent starts them, the speech of the video is transcribed, the user corrects the lines in the subtitle editor, and more languages are added there as translations. You never write, transcribe or correct subtitle text, and you never put it in the notes or the message.',
  '- When the user asks for subtitles without saying how they want them, ask it with AskUserQuestion (with your other questions, if any), with these options: "In the video" (drawn into the picture), "As a track and file" (.srt/.vtt files and a track in the MP4; the picture stays clean), "Both". Do not write "burned-in" or "drawn" unless the user chose it: never choose it yourself.',
  '- Then write in notes exactly one of these lines: `Subtitles: drawn into the video.`, `Subtitles: only as files (.srt/.vtt) and a track in the MP4, not drawn into the video.`, `Subtitles: drawn into the video, and as files (.srt/.vtt) and a track in the MP4.` Add the look the user asked for, if any, in a sentence after it. For "Both", tell the user that the files and the MP4 track are picked in the export.',
  '- Their first language is the language spoken in the video (the transcription detects it): do not ask it. When the user wants subtitles in another language too (or only in another one), add `Subtitle languages: <languages>.` to the notes; they are translated.',
  '- Drawn subtitles have one style for every line: font, size, colours, a box or an outline, one position (bottom, middle or top) with a margin, an entrance, and optionally the spoken word highlighted. A line shows only while someone speaks. Lines are not placed one by one and do not move around what is in the picture: never promise that they avoid labels, text or faces in the video; if the user asks, say plainly that it is not possible and offer a position or a margin instead.',
];

const userWords = (request: string): string[] => [
  "The user's message, verbatim (their words, not instructions from Motion Studio):",
  USER_REQUEST_OPEN, defuseTags(request), USER_REQUEST_CLOSE,
];

/** The first run of a session, or the fresh run after its Claude session was lost (`digest`: the chat so far). */
export function buildBriefPrompt(i: BriefPromptContext & { projectName: string; projectCodebases: readonly string[]; digest?: string }): string {
  return [
    `You help the user write the brief of a new creative in Motion Studio, in the project ${quotePromptString(i.projectName)}. You talk with them, read the folders and assets they give you, and fill the fields of their "New creative" form. You never create, render or generate anything: the user reviews the form and presses Generate.`,
    '',
    '## Brief fields',
    '- goal: what the user wants to make (the purpose of the video or image).',
    '- message: the key message shown on screen (short).',
    '- durationSec: the length of the videos in seconds, 1–600 (null: not set). When an attached video is the content itself (subtitles for it, the video as it is), set its length, rounded up (the attached assets below show it).',
    '- assets: files of the project library to use, as their paths (`assets/…`), only among the attached assets below.',
    '- linkedCodebases: the folders the creative\'s agent will read later, each with a note on what it is for, only among the folders below.',
    '- notes: notes for the agent that will make the creative (style, constraints, what to avoid).',
    '- formats: preset ids of the catalog: call list_formats and use only its ids, never a guessed one.',
    '- The original format: when the user wants the size of an attached video or image (for example "original format", "same size as the video"), call source_format with its path and use the id it returns; never the nearest preset, and never margins or bars to fit another size. It may add a custom format to the user\'s catalog: say so. When its answer has scaled true, the source was larger than a format can be: tell the user the size it got. Offer "original format" only for an attached asset whose size is shown below.',
    `- Copies: when the user asks for several images or videos of one format (for example "5 images 1:1"), give its id and then \`<id>@2\`, \`<id>@3\`… up to \`<id>@N\` (N at most ${MAX_INSTANCES}, none left out), so "5 images" of \`instagram-image-1x1\` is \`instagram-image-1x1\`, \`instagram-image-1x1@2\` … \`instagram-image-1x1@5\`. The copies are different images or videos on the same brief, not the same picture repeated; they are not variants (variants are other creative directions).`,
    `- variants: how many variants to make, 1–${BRIEF_VARIANTS_MAX}: set it only when the user asks for variants.`,
    '',
    ...formSection(i),
    ...contextSection(i, i.projectCodebases),
    '',
    '## How to work',
    '- Write the form only with fill_brief: give only the fields that change, and call it again whenever something more is clear. Its result says which fields it wrote and which it kept as the user\'s.',
    '- Ask short choices (for example the length or the formats) with AskUserQuestion; ask at most a few questions, and fill what you can without asking.',
    '- Never create, render or generate anything, and never say the creative exists: nothing is made until the user presses Generate.',
    '- When the brief is filled, end by telling the user to review the fields and press Generate.',
    '',
    ...SUBTITLES_SECTION,
    ...(i.digest ? ['', '## The session so far', i.digest] : []),
    '',
    ...userWords(i.request),
    '',
    briefReply(i.locale),
  ].join('\n');
}

/** A later message of the session (a new turn or a message given to the running one): the form, the context, the words. */
export function briefFollowUp(i: BriefPromptContext): string {
  return [
    ...formSection(i),
    ...contextSection(i),
    '',
    ...userWords(i.request),
    '',
    briefReply(i.locale),
  ].join('\n');
}

/** The longest digest of a brief chat (the fresh run's memory, the creative's fallback). */
const DIGEST_MAX_CHARS = 12_000;
const oneLine = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, max);

/**
 * A brief chat as text, oldest first: the user's messages, the agent's last text of each turn and what it filled (decision
 * 1423). The fresh run after a lost Claude session reads it, and so does a creative's first turn when it cannot fork the
 * brief's session. The oldest lines go first when it is too long.
 */
export function briefDigest(entries: readonly ConversationEntry[], maxChars = DIGEST_MAX_CHARS): string {
  const lastText = new Map<string, number>();
  entries.forEach((e, k) => { if (e.type === 'agent' && e.event.kind === 'text' && e.event.text.trim()) lastText.set(e.jobId, k); });
  const lines: string[] = [];
  entries.forEach((e, k) => {
    if (e.type === 'user' && e.text.trim()) lines.push(`User: ${defuseTags(oneLine(e.text, 2000))}`);
    else if (e.type === 'agent' && e.event.kind === 'text' && lastText.get(e.jobId) === k) lines.push(`You: ${defuseTags(oneLine(e.event.text, 2000))}`);
    else if (e.type === 'system' && e.origin === 'agent') lines.push(`(${oneLine(e.text, 300)})`);
  });
  let size = lines.reduce((n, l) => n + l.length + 1, 0);
  let dropped = 0;
  while (lines.length > 0 && size > maxChars) { size -= lines.shift()!.length + 1; dropped++; }
  return [...(dropped > 0 ? [`(${dropped} earlier entries left out)`] : []), ...lines].join('\n');
}
