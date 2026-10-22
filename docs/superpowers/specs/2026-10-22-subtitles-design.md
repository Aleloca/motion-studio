# Subtitles (user request of 2026-10-22)

Status: design, not built. Decisions of this design: 1636–1660 in `docs/decisions-log.md` (to be written when the design
is approved). The editor layout was chosen by the user from three mockups in the brainstorming companion (option B).

## 1. Why

Motion Studio users make videos to publish anywhere: YouTube, a website, LinkedIn, Instagram, TikTok, a TV in a shop.
Most of those places want subtitles, and they want them in different forms. YouTube, Vimeo, LinkedIn and web pages
take a subtitle file next to the video (`.srt`, `.vtt`) and let the viewer turn it on. Players such as VLC, QuickTime and
phones also read subtitle tracks inside the MP4. Instagram, TikTok and Reels take no subtitle file: there, subtitles must
be drawn into the picture.

The user wants Motion Studio to produce all of these, in more than one language, from any video they work on, with the
look of the drawn subtitles decided by talking to the agent. They did not name an anti-goal ("I will understand it by
using it"), so the ones in §4 are the designer's.

## 2. The user's calls

| # | Call |
|---|---|
| U1 | Subtitles are for any kind of video, published anywhere: all three outputs exist (drawn into the video, `.srt`/`.vtt` files, a soft track inside the MP4). |
| U2 | They cover both the videos the user uploads to Assets and the creatives Motion Studio generates. |
| U3 | There is ONE way in: the creative. An uploaded video gets subtitles by "Usa in una creatività", never from the Assets panel. |
| U4 | No fixed caption styles: the user asks the agent for the look they want, in the creative's chat (or in the brief), and the agent designs it. |
| U5 | Text and timing are corrected in a dedicated subtitle editor, separate from today's composition editor. |
| U6 | Editor layout B: video on the left, the list of subtitle lines on the right (each with start, end and editable text), and under them a timeline with the audio waveform where each line is a block whose edges are dragged to move its start and end. |
| U7 | More than one language: the app translates the subtitles, and each language is corrected in the editor. |
| U8 | The subtitles' language is independent of the video's language. By default a language's subtitles go on the video in that language when the creative is localized into it, otherwise on the original video; at export the user can pick any pair (e.g. the Italian video with English subtitles). A subtitle language can be added without localizing the creative. |
| U9 | When the user only says "aggiungi i sottotitoli" (nothing about the look), the agent ASKS whether they want them drawn into the video or as a track/file only, before making anything visible. |

## 3. Goals

- A creative can have subtitles in one or more languages, made from what is said in it.
- The text comes out right with little work: Whisper locally and free by default; for a voice the app generated, the
  exact script it spoke.
- The user corrects text and timing in the subtitle editor; the agent designs the look; neither undoes the other.
- Every output from the same subtitles: drawn into the video (one language per render), `.srt` + `.vtt` per language, and
  an MP4 with one soft track per language.

## 4. Non-goals and anti-goals

Non-goals (not in this design; may come later):
- Subtitles on an asset without a creative (U3).
- Importing an existing `.srt`/`.vtt` (a natural next step; the format code makes it cheap — designer's note).
- Speaker labels, sound descriptions for the deaf ("[music]"), karaoke lyrics.
- Uploading to YouTube or any platform.
- Burning two languages into one video.

Anti-goals (the designer's; it would be a failure even if it works):
- The app silently overwrites text the user corrected: by a new transcription, a translation or an agent turn.
- Subtitles show twice: drawn into the picture AND as a soft track or file of the same render.
- A paid service is used without the user choosing it (transcription follows today's choice: Whisper first).
- A subtitled export is slower or worse for users who never asked for subtitles.
- Subtitles that cannot be read: too long, too fast, under a busy picture. The editor warns; the agent's style keeps them
  legible by default.

## 5. What exists today (grounding)

- **Transcription** (`packages/core/src/transcription/`): whisper.cpp (local, bundled in the desktop app), OpenAI
  `whisper-1`, ElevenLabs Scribe; the user's choice and the "Whisper first, recommended" dialog of reports 64–65. Results
  are SEGMENTS only (`TranscriptSegment {from,to,text}`, `packages/shared/src/video-analysis.ts`); word timings are
  thrown away (ElevenLabs returns them, `groupWords` folds them). The detected language is kept. The transcript lives only
  in the analysis markdown sidecar, rounded to tenths of a second.
- **Compositions**: `outputs/vN/compositions/<format>/composition.json` (`motion-studio/composition@1`), tracks
  `visual|video|text|audio`; text clips; an audio clip may carry a `script` (voice). The project template already tells
  the agent to make "voice-over subtitles" as one text clip per sentence, timed by hand (`project-template.ts:68`).
- **Voices**: the `tts` tool saves audio into `assets/audio/` with the text in its description; no alignment is stored.
- **Localization**: `brief.locales {primary, extra}`, per-language overlays `outputs/vN/locales/<locale>/*.json` with
  texts and voices; localized renders `outputs/vN/<instanceId>.<locale>.<ext>`.
- **Render**: Chrome capture, h264 segments, a final concat mux in `packages/core/src/render/renderer.ts`. ffmpeg is
  found on PATH or `FFMPEG_PATH`, not bundled. Export UI: `ExportDialog.tsx`, `RenderLanguagesDialog.tsx`,
  `ExportChoice.tsx`.
- **Waveform**: `assetWaveform` (400 peaks, cached) and its drawing in `web/src/ui/PlayerControls.tsx`. The composition
  editor's timeline (`screens/editor/Timeline.tsx`) draws none.
- **Creative page**: side panel tabs `chat | comments | brief` (`CreativeCanvas.tsx`); the format route is the editor.
- No subtitle code exists.

## 6. The design

### 6.1 Subtitles are data of the creative, kept apart from the picture

A creative (each variant on its own) has a subtitle set per language. Designer's call: it lives at creative level, not
inside an output version, e.g. `creatives/<slug>/subtitles/<locale>.json`, because the user edits it many times and a
new output version per keystroke is wrong. Each file holds:

- the lines (cues): `id`, `start`, `end` (milliseconds, composition time), `text` (one or two lines), and the words
  with their own times when known (for styles that highlight the spoken word);
- for each line, whether the user edited it (`edited: true`), so nothing later overwrites it (anti-goal 1);
- for a translated language: the source language and, per line, the source text it was translated from, so the app can
  tell a translation that went stale when the source line changed;
- the composition version and audio fingerprint the timing was made for, so the app can tell when the video changed
  under the subtitles (§6.7).

The look is NOT in this file: it belongs to the composition (§6.4).

Versions (designer's call, from the builder check): the creative-level set is the working copy the editor saves into.
A version stays self-contained: every render or export stages a snapshot of the sets it uses INTO the render's
composition input (so the renderer still reads only confined files) and keeps that snapshot next to the output, so a
past render can always be told apart and re-exported as it was. Rendering or restoring an older version uses the
working copy; if its recorded timing fingerprint does not match that version, the §6.7 notice shows. A subtitle edit
invalidates render staleness and caches like any other input of the render. The subtitle files are committed in the
project's history like the creative's other files (with the same batching the app uses for its own writes, never one
commit per keystroke). The format code (SRT/VTT read/write) goes in
`packages/shared` so the editor, the core and the tests share it.

Formats of the same creative usually share one timeline. If two formats of one version have different durations or
cuts, the builder decides between one set per format or one set on the main format with a warning; designer's lean:
one set per creative, and a format whose audio differs gets the §6.7 warning.

### 6.2 Getting the text

The user asks for subtitles in the chat ("aggiungi i sottotitoli", or in the brief). If they said nothing about the
look, the agent first asks whether they want them drawn into the video or only as a track/file (U9). The agent then
calls a core tool that starts a subtitles job. Designer's call on the flow (builder check): the job runs on its own
(it can take minutes, like a video analysis) and is not part of the agent's turn; the turn ends saying it started. When
the job ends, the chat shows a "Sottotitoli pronti" message with "Apri l'editor". If the user wanted them drawn, the job's
end starts a short agent turn that adds the `subtitles` track with its style as a new version (so phase 1 can ship the
data and files without the drawn track). The data never waits for the look. Designer's call: the job transcribes the creative's own audio mix (the rendered audio of the
composition: the video clip's sound and the voices together), so one path serves an uploaded interview and a generated
creative alike, and the times are already in composition time.

- Transcription goes through today's transcriber and its choice (Whisper first; the paid ones only if the user chose them;
  the same question dialog when no choice is remembered).
- Keep WORD timings: whisper.cpp can emit token timestamps (`-ojf` / `-ml`), OpenAI `whisper-1` accepts
  `timestamp_granularities[]=word`, ElevenLabs already returns words. The builder checks each engine; where words are
  unavailable, lines still work and word-highlight styles degrade to whole lines.
- Keep the detected language: it becomes the subtitles' first language. The language is never forced on the transcriber
  by the brief (forcing it on speech in another language gives garbage, or a translation). Designer's call: when the
  detected language differs from the brief's primary locale, the subtitles keep the detected one and the "pronti" message
  says so, with "Traduci in <lingua del brief>" as a one-click follow-up. When detection is unsure, the user can redo the
  transcription choosing the language in the editor.
- Generated voices: where an audio clip carries a `script` (or a TTS asset carries its text), the script is the truth:
  the transcribed words are aligned to the script and the script's words replace them, keeping the times. (A light text
  alignment, not a speech model.)
- Lines are cut by readable rules (designer's defaults, editable later): at most 2 lines of about 42 characters, 1–7 s
  on screen, about 17 characters per second at most, cut at sentence ends and pauses.

### 6.3 The subtitle editor (U5, U6)

A new space of the creative, beside the composition editor (e.g. a "Sottotitoli" entry reachable from the creative page
and from the chat's message when subtitles are ready; the builder picks the route, e.g. `#/p/<slug>/c/<c>/subtitles`).

- Left: the video (the creative's current version, preview player) with the subtitles drawn in the agent's style, the
  current line highlighted.
- Right: the list of lines. Each row: start, end, text, all editable. Clicking a row seeks the video there; the row
  under the playhead follows playback.
- Under both: the timeline with the waveform of the creative's audio; each line is a block, its edges dragged to move
  start and end, snapping to the neighbours and never overlapping; the playhead scrubs.
- Actions on a line: split at the text cursor (times split proportionally or at the word times), merge with the next,
  add, delete. Find and replace across lines.
- A language switcher at the top: the subtitle languages, a separate list from the brief's locales (U8), with "+ Lingua"
  to add one (translated) and the brief's locales suggested first; stale translated lines are
  marked, with "Ritraduci" per line or for all (never automatic, anti-goal 1).
- Gentle warnings per line, never blocking: too long for two lines, too fast to read, too short on screen, overlapping.
- Edits save by themselves (debounced) and the preview updates live. Undo/redo within the session.
- Copy in it and en through the i18n catalogs; light and dark; keyboard: Space play/pause, arrows move between lines.

### 6.4 The look, decided with the agent (U4)

Drawn subtitles are part of the composition: a new kind of track or clip (e.g. a `subtitles` track) that names the
subtitle set and carries the style. The runtime draws the line active at each frame from the subtitle data, so the
editor's changes show without the agent writing a new version. The style is designed by the agent: font, size, colours,
box or outline, position and safe area per format (a 9:16 format places them above the platform's UI), entrance
animation, and the spoken-word highlight when words are known. Designer's call: the style is a constrained set of props
plus an optional HTML layer template the runtime feeds with the current line and words, validated like other layers.

- When the user wants them drawn but says nothing about the look, the agent makes a legible style in the brand's fonts
  and colours (U9 decides drawn or not; this decides only the look).
- The agent can also correct text through a tool (e.g. "write Motion Studio with capitals everywhere"), and those lines
  count as edited.
- A creative can have subtitles without drawing them (files and soft track only): the subtitles track can be off.

### 6.5 Languages (U7)

- The first language comes from the speech (§6.2). Others are added in the editor or asked in chat; they are translated by
  the app's existing translation (Claude), from the corrected source lines, keeping each line's times.
- A creative already localized with its own voice per language (e.g. German voice-over): that language's subtitles come
  from ITS audio (transcribed and aligned to its script), not translated from Italian.
- Each language is edited on its own (text and times).

### 6.6 Outputs (U1)

In the export (`ExportDialog`, and the languages dialog), a "Sottotitoli" section when the creative has subtitles.
Video language and subtitle language are chosen separately (U8): each subtitle language defaults to the video in that
language when the creative is localized into it, else the original video, and the user can change the pairing. Output
names carry both when they differ (e.g. `<name>.it.sub-en.mp4`; the builder fixes the scheme so it never collides with
today's `<instanceId>.<locale>.<ext>`).

- **Nel video** (drawn): pick one language per render; for several languages, one render per language (named like
  today's localized renders).
- **File .srt e .vtt**: one pair per chosen language, named `<name>.<lang>.srt` / `.vtt`, next to the video.
- **Traccia nel file MP4**: every chosen language as a soft `mov_text` track with its language tag, muxed at the
  renderer's final mux (no re-encode).

Files and soft tracks go with a video WITHOUT the drawn subtitles (anti-goal 2): choosing them renders the video with
the subtitles track off; the dialog says so. All three can be produced in one export (e.g. a drawn version for Reels and
a clean version plus files for YouTube). The `.srt`/`.vtt` can also be downloaded from the subtitle editor at any time.

### 6.7 When the video changes under the subtitles

An agent turn or a direct edit may change the composition's timing. The subtitle set records the version and audio
fingerprint it was timed against; when they differ, the editor and the chat show a notice: "Il video è cambiato:
ricontrolla i tempi" with "Rifai i tempi" (re-transcribe and re-align, keeping the edited text where the words still
match) — never automatic overwriting of edited lines.

### 6.8 Costs and privacy

Transcription follows today's rules (local Whisper free; paid providers only by the user's choice, recorded in Usage
under "Servizi a pagamento"). Translations are Claude runs, recorded under Claude's usage.

## 7. Suggested phases (the builder may regroup)

1. Data and text: the subtitle set format, SRT/VTT writer, word timings from the engines, the subtitles job on the
   creative's audio mix, script alignment for voices, the agent tool to start it. Export of `.srt`/`.vtt`.
2. The subtitle editor (U6), with waveform timeline, line actions, warnings, autosave.
3. The drawn subtitles: composition track, runtime drawing, agent style rules and tools, the export choices with the
   soft MP4 track.
4. Languages: translation, stale marking, localized voices, the language switcher, multi-language exports.

## 8. Left to the builder

The exact file layout and schema names; the route; the component structure; how the runtime and the editor share the
drawing code; the line-cutting heuristics' tuning; the alignment algorithm; how the subtitles job reuses the render's
audio path; per-format handling of different timelines (§6.1). Each non-obvious choice goes in the decisions log.
