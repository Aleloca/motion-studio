# Subtitles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a creative gets subtitles in one or more languages, made from its own audio, corrected in a dedicated editor, styled by the agent, and exported drawn into the video, as `.srt`/`.vtt` files and as soft `mov_text` tracks in the MP4.

**Architecture:** a subtitle set per creative and language lives in `creatives/<slug>/subtitles/<lang>.json` (the working copy, outside any version). A `subtitles` job in its own lane mixes the creative's audio (`render/audio-mix.ts`), transcribes it through the existing `TranscriptionService` (now keeping word times), aligns generated voices to their scripts, and cuts cues by readable rules. The format code (schema, SRT/VTT, cue rules, alignment) is in `packages/shared/src/subtitles/` so the core, the editor and the tests share it. Drawn subtitles are a `subtitles` track of the composition (style only); renders stage a snapshot of the set into the runtime page data and next to the output, so the runtime draws the active cue without a new version. Soft tracks are added at the renderer's final mux; files are written by the export.

**Tech Stack:** TypeScript, zod (shared), Fastify (core), ffmpeg through `render/encode.ts` (`spawnFfmpeg`, `FfArg` checks) and `media/ffmpeg-filters.ts`, whisper.cpp / Python Whisper / OpenAI / ElevenLabs through `transcription/`, the `studio` MCP server (`packages/mcp-studio/src/server.mjs`), the composition runtime, React 19 + Vitest/jsdom, the real-Chrome `LayoutRig` harness (`packages/web/test/support/layoutPage.ts`).

**Spec:** `docs/superpowers/specs/2026-10-22-subtitles-design.md`. Section numbers (§n) and user calls (Un) refer to it.

## Execution model

- Builder subagents, one git worktree and one branch per PHASE, from `main` after the previous phase is merged; each phase ships working, testable software and is mergeable alone:
  - Phase 1 `feat/subtitles-data` (Tasks 1–8): data, text, agent tool, `.srt`/`.vtt` download and export. Decisions **1636–1650**.
  - Phase 2 `feat/subtitles-editor` (Tasks 9–14): the subtitle editor. Decisions **1651–1665**.
  - Phase 3 `feat/subtitles-drawn` (Tasks 15–22): drawn subtitles, agent style, soft MP4 track, export choices. Decisions **1666–1685**.
  - Phase 4 `feat/subtitles-languages` (Tasks 23–27): translation, localized voices, language switcher, multi-language exports. Decisions **1686–1700**.
- Inside a phase, tasks run in order (each task's Interfaces name what the next one uses). SDD scripts (task brief, review package) run from the phase worktree, never from the main checkout.
- The orchestrator merges and pushes `main`; builders never push.

## Global Constraints

- Builders follow every rule in the builder rules file the orchestrator names in each brief (worktree only, TDD, targeted tests plus `pnpm -r typecheck` and `pnpm -s check:i18n`, no full suite except at phase end, i18n it+en, decisions log, commit trailers, no paid providers, no real Claude CLI / app / Whisper model, Chrome only through the harness with `MS_REQUIRE_CHROME=1` and a temp config, personal-data scan of the diff before finishing). Every task implicitly includes them.
- Run a test file with `pnpm vitest run <path>` from the worktree root.
- Fakes only: `fakeWhisper` (`core/test/helpers/fake-whisper.ts`), a fake `fetch` for OpenAI/ElevenLabs, `ControlledRunner` / `fake-stream-runner` for agent jobs, `MemoryVault`, ffmpeg fixtures generated inside tests (`-f lavfi`, as `analysis-media.test.ts`).
- Decisions log (`docs/decisions-log.md`, Italian, emoji, bold title, `*Costo cambio:*`, "decisione: orchestratore (2026-10-22)"): only the phase's own range. Task 1 first appends the design's own calls as **1636–1643** (see Task 1); Phase 1 builder decisions then use 1644–1650.
- Fixed values (§6.2, §6.6): subtitle file `$schema: 'motion-studio/subtitles@1'`; times are integer milliseconds in composition time; cue rules `SUBTITLE_RULES = { maxLines: 2, maxLineChars: 42, cjkLineChars: 16, minMs: 1000, maxMs: 7000, maxCps: 17, pauseMs: 500 }`; at most 2000 cues, 60 words per cue, 200 chars of cue text, set file ≤ 1 MiB; soft tracks `-c:s mov_text` with ISO 639-2/T language tags; files `<stem>.<lang>.srt` / `<stem>.<lang>.vtt`.
- Never forced: the transcriber's language stays `null` (auto) unless the USER picks one in the editor (§6.2); the brief's locale is never passed.
- Anti-goals are acceptance criteria: (1) nothing overwrites a cue with `edited: true`; (2) a video exported with files or soft tracks never also has them drawn; (3) paid transcription only through the user's existing choice; (4) an export or render without subtitles runs exactly as today (no extra job, no extra ffmpeg input); (5) the editor warns, never blocks.
- UI copy from the spec verbatim (it): "Sottotitoli", "Sottotitoli pronti", "Apri l'editor", "Nel video", "File .srt e .vtt", "Traccia nel file MP4", "+ Lingua", "Ritraduci", "Il video è cambiato: ricontrolla i tempi", "Rifai i tempi", "Traduci in {language}". Every string in `packages/shared/src/i18n/en.ts` and `it.ts` (same shape).

## Review Focus

1. **A job ends while the user is editing** (a re-transcription, "Rifai i tempi" or a translation finishes after the user changed cues): edited cues and the user's latest save must survive. Pinned by Task 2 test "mergeKeepingEdited keeps an edited cue whose words no longer match", Task 5 test "a job finishing after a save keeps the saved edits", Task 11 test "a stale baseHash gets 409 subtitles-conflict", Task 23 test "a translation never replaces an edited target cue".
2. **The video changes under the subtitles** (shorter duration, a cut, a voice moved): no cue may be drawn or exported past the end, and the user is told rather than silently retimed. Pinned by Task 1 test "toSrt clamps and drops cues past durationMs", Task 14 test "fingerprint mismatch shows the notice and changes nothing", Task 18 test "staged cues are clamped to the composition".
3. **Text that breaks formats or cutting**: `-->` and `<b>`/`&` in text, a 300-character sentence without spaces, CJK and Thai without spaces, an empty transcript segment, a line break typed by the user. Pinned by Task 1 VTT escaping tests and Task 2 tests "cuts ja text by characters" and "a word longer than a line is hard-split".
4. **No speech at all** (no audio track, silence, transcription answered "none", unsupported detected language): no empty set is written, the chat says why, the agent turn does not wait. Pinned by Task 5 tests "no audio track", "transcription none", "unsupported language".
5. **Subtitle choices on formats that cannot carry them** (a still image format, a `.mov`/`.m4v` output, ffmpeg missing, a follower format): stills are skipped with a note, `.mov` gets `mov_text` too, followers reuse their primary's file. Pinned by Task 20 test "mov output gets a mov_text track" and Task 21 tests "stills are skipped with a note" and "a follower reuses the primary's subtitled file".

---

# Phase 1 — data, text and files (`feat/subtitles-data`, decisions 1636–1650)

## File Structure (Phase 1)

- Create `packages/shared/src/subtitles/` — `schema.ts` (set schema, types, constants, job key, ISO tags), `format.ts` (SRT/VTT write and read), `cues.ts` (cutting, warnings, merge), `align.ts` (script alignment), `index.ts`; export from `packages/shared/src/index.ts`.
- Modify `packages/shared/src/events.ts` (`JobKind` + `'subtitles'`, `ServerMessage` + `subtitles`), `creative.ts` (system entry `subtitles`, `CreativeDetail.subtitles`), i18n `en.ts`/`it.ts`.
- Modify `packages/core/src/transcription/engines.ts`, `openai-stt.ts`, `elevenlabs-stt.ts`, `transcriber.ts` (word times).
- Create `packages/core/src/subtitles/` — `store.ts` (files, hash, fingerprint, batched commits), `subtitles-job.ts` (`SubtitlesService`), `subtitles-tools.ts` (bridge handler); `packages/core/src/server/subtitles-routes.ts`.
- Modify `core/src/server/app.ts` (lane, service, routes, tools), `core/src/agent/launcher.ts` (`SUBTITLE_TOOLS`), `core/src/creatives/creative-turns.ts:1355` (protected dir), `core/src/creatives/prompt.ts` and `core/src/project-template.ts:68` (U9 rule), `core/src/server/creative-routes.ts` (export body), `packages/mcp-studio/src/server.mjs`.
- Web: `api.ts`, `useServerEvents.ts`/`eventsReducer.ts`, `labels.ts` (exhaustive `JobKind`), `components/Conversation.tsx` (ready card), `components/TranscriptionChoices.tsx` (generalized submit), `screens/ExportDialog.tsx` (files option).

### Task 1: Subtitle set schema, SRT/VTT, design decisions

**Files:**
- Create: `packages/shared/src/subtitles/schema.ts`, `packages/shared/src/subtitles/format.ts`, `packages/shared/src/subtitles/index.ts`; Test: `packages/shared/test/subtitles-format.test.ts`
- Modify: `packages/shared/src/index.ts`, `docs/decisions-log.md`

**Interfaces:**
- Produces (from `@motion-studio/shared`):
  - `SUBTITLES_SCHEMA_ID = 'motion-studio/subtitles@1'`; `SUBTITLE_LIMITS = { cues: 2000, words: 60, text: 200, fileBytes: 1_048_576 }`; `SUBTITLES_DIR = 'subtitles'` (inside the creative folder).
  - `subtitleWordSchema = { start: int ≥ 0, end: int ≥ start, text: string 1..100 }` (strict).
  - `subtitleCueSchema` (strict): `{ id: /^[a-z0-9][a-z0-9-]{0,31}$/, start: int ≥ 0, end: int > start, text: string 1..200 (at most one '\n'), words?: SubtitleWord[] ≤ 60, edited?: true, source?: { text: string 1..200 } }`.
  - `subtitleSetSchema` (strict): `{ $schema, lang: LocaleTag, origin: 'speech' | 'translation', sourceLang?: LocaleTag (required iff origin translation), transcript: TranscriptKind | null, detected: string | null, timing: { version: int ≥ 1; format: string; fingerprint: /^[0-9a-f]{64}$/ }, cues: SubtitleCue[] (sorted by start, ids unique) }`; types `SubtitleWord`, `SubtitleCue`, `SubtitleSet`.
  - `parseSubtitleSet(text: string): SubtitleSet | null`; `subtitleSetText(s: SubtitleSet): string` (2-space JSON + `\n`); `subtitleSetHash(s): string` (sha256 of `subtitleSetText`, via the existing shared hashing helper in `composition/hash.ts`).
  - `subtitlesJobKey(root, projectSlug, creativeSlug) => \`subtitles:${root}:${projectSlug}:${creativeSlug}\``.
  - `ISO639_2: Record<LocaleTag, string>` (T codes: `en eng, it ita, fr fra, de deu, es spa, pt por, nl nld, sv swe, da dan, nb nob, fi fin, pl pol, cs ces, hu hun, ro ron, ca cat, el ell, ru rus, uk ukr, tr tur, id ind, vi vie, zh-Hans zho, zh-Hant zho, ja jpn, ko kor, hi hin, th tha`).
  - `subtitleLangOf(detected: string | null): LocaleTag | null` — exact tag match, `zh` → `zh-Hans`, `no`/`nn` → `nb`, anything else null.
  - `toSrt(cues: SubtitleCue[], o: { durationMs: number }): string` — `1\n00:00:01,000 --> 00:00:03,500\ntext\n\n`, cues starting at or after `durationMs` dropped, ends clamped to it, CRLF never emitted.
  - `toVtt(cues, o): string` — `WEBVTT\n\n` header, `00:00:01.000 --> …`, text with `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;` (so `-->` in text never ends a cue line).
  - `fromSrt(text): Array<{ start; end; text }> | null` and `fromVtt(text)` — round-trip readers (used by tests now, import later); tolerant of CRLF and a BOM.
- Decisions: append the design's own calls as 1636–1643 (one entry each): 1636 sets per creative and language in `creatives/<slug>/subtitles/` (§6.1); 1637 the audio mix of the creative is what gets transcribed (§6.2); 1638 detected language kept, never forced (§6.2); 1639 voice scripts are the truth for generated voices (§6.2); 1640 the job runs on its own and the chat says when it is ready (§6.2); 1641 drawn subtitles = `subtitles` track with constrained style + optional HTML template (§6.4); 1642 snapshot staged into renders (§6.1 "Versions"); 1643 export names and the "clean video" rule (§6.6, anti-goal 2; the scheme of Task 21).

- [ ] **Step 1: Write the failing tests**: `subtitleSetSchema` refuses a cue with `end <= start`, a third text line, duplicate ids, unsorted cues, `origin: 'translation'` without `sourceLang`; `subtitleLangOf('zh') === 'zh-Hans'`, `subtitleLangOf('ar') === null`; `toSrt` of `[{start:1000,end:3500,text:'Ciao'}]` equals `'1\n00:00:01,000 --> 00:00:03,500\nCiao\n\n'`; "toSrt clamps and drops cues past durationMs" (duration 3000: a 2500–4000 cue ends at 3000, a 3000–4000 cue is gone); `toVtt` of text `'a --> b <i>&'` contains `a --&gt; b &lt;i&gt;&amp;`; `fromSrt(toSrt(x))` and `fromVtt(toVtt(x))` give back starts, ends and texts (a two-line cue included); `fromSrt` with CRLF and BOM parses.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/test/subtitles-format.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `schema.ts`, `format.ts`, `index.ts`; append decisions 1636–1643.
- [ ] **Step 4: Run** the test and `pnpm -r typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): subtitle sets and the SRT/VTT format`.

### Task 2: Cue cutting, warnings, merge and script alignment

**Files:**
- Create: `packages/shared/src/subtitles/cues.ts`, `packages/shared/src/subtitles/align.ts`; Test: `packages/shared/test/subtitles-cues.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  - `SUBTITLE_RULES` (values in Global Constraints); `type SubtitleRules = typeof SUBTITLE_RULES`.
  - `interface TimedWord { start: number; end: number; text: string }` (ms).
  - `buildCues(input: { words: TimedWord[] } | { segments: TimedWord[] }, lang: LocaleTag, rules = SUBTITLE_RULES): SubtitleCue[]` — from words: greedy fill, a new cue at a sentence end (`/[.!?…。！？]["'”’)\]]*$/`), at a pause ≥ `pauseMs`, or when the text would exceed `maxLines × lineChars` or the cue `maxMs`; text wrapped into ≤ 2 balanced lines (`wrapLines`); a cue shorter than `minMs` is extended into the following gap without overlapping; words kept on the cue. From segments (no words): each segment split by `wrapLines` capacity with times proportional to characters. Ids `c1`, `c2`… in order. `lineChars` = `cjkLineChars` for `zh-Hans`, `zh-Hant`, `ja`, `ko`, `th` (cut by characters), else `maxLineChars` (cut at spaces; a word longer than a line is hard-split).
  - `wrapLines(text: string, lang: LocaleTag, rules?): string[]`.
  - `type CueWarning = 'tooLong' | 'tooFast' | 'tooShort' | 'tooLongOnScreen' | 'overlap'`; `cueWarnings(cue, next: SubtitleCue | undefined, lang, rules?): CueWarning[]` (`tooLong`: wrap needs > 2 lines; `tooFast`: chars / seconds > 17; `tooShort` < 1000 ms; `tooLongOnScreen` > 7000 ms; `overlap`: `next.start < cue.end`).
  - `mergeKeepingEdited(old: SubtitleCue[], fresh: SubtitleCue[]): SubtitleCue[]` — every `edited` old cue is kept with its text; its times move to the fresh words that match its normalized words (≥ 60 % of its words found in order), else keep its old times; fresh cues overlapping a kept cue are dropped; result sorted, ids re-made only for fresh cues (`f1`…, never colliding).
  - `alignToScript(words: TimedWord[], script: string, span: { start: number; end: number }): TimedWord[]` — normalized-token global alignment (Needleman–Wunsch, match 2, mismatch −1, gap −1) of the words inside `span` to the script's words; the result has exactly the script's words, matched ones with the heard times, unmatched ones interpolated between neighbours (or spread over `span` when nothing matched).

- [ ] **Step 1: Write the failing tests**:
  - "cuts at a sentence end and a 500 ms pause": words `Ciao.`(0–400) `come`(450–700) `stai`(1300–1600) → cues `['Ciao.', 'come', 'stai']`… with the third starting at 1300 (the pause), first extended to ≥ 1000 ms but ending ≤ 450.
  - "two balanced lines of at most 42": a 70-char run → one cue, two lines each ≤ 42, length difference ≤ 12.
  - "a word longer than a line is hard-split": a 60-char token → lines of ≤ 42.
  - "cuts ja text by characters": 40 Japanese chars with no spaces → lines ≤ 16 chars.
  - "segments only": one 10 s segment of 160 chars → ≥ 2 cues, contiguous, total span 0–10000.
  - `cueWarnings`: 30 chars in 1000 ms → `tooFast`; 500 ms → `tooShort`; 8000 ms → `tooLongOnScreen`; next starting before end → `overlap`; a clean cue → `[]`.
  - "mergeKeepingEdited keeps an edited cue whose words no longer match": old `[{id:'c1',edited:true,text:'Motion Studio',start:0,end:1000}]`, fresh with different words → the edited cue kept with text and times unchanged, the overlapping fresh cue dropped; with matching words shifted by +500 → the edited cue moved by +500.
  - `alignToScript`: heard `['motion','studia','is','grate']`, script `'Motion Studio is great!'` → texts `['Motion','Studio','is','great!']` with the heard times; script with an extra word → its time between its neighbours.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/test/subtitles-cues.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `cues.ts` and `align.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): subtitle cue rules, warnings and script alignment`.

### Task 3: Word timings from every engine

**Files:**
- Modify: `packages/core/src/transcription/engines.ts:9,52-56,81-96,98-116`, `openai-stt.ts:43-82`, `elevenlabs-stt.ts:15-52`, `transcriber.ts:310-344`, `packages/shared/src/video-analysis.ts` (`TranscriptWord`)
- Test: `packages/core/test/transcription-words.test.ts` (new), plus the existing engine/args tests the compiler or the change touches.

**Interfaces:**
- Produces:
  - shared `TranscriptWord = { from: number; to: number; text: string }` (seconds, like `TranscriptSegment`).
  - `EngineTranscript.words?: TranscriptWord[]`; `EngineFlags.ojf: boolean` (`/(^|\s)(-ojf|--output-json-full)\b/` in `--help`).
  - `whisperArgs(e, i & { words?: boolean })`: whisper.cpp with `words && flags.ojf` uses `-ojf` in place of `-oj`; Python engines add `--word_timestamps True`. `words` absent/false: argv identical to today.
  - `parseWhisperCpp` reads `transcription[].tokens[]` (`offsets.from/to` ms, `text`), skips special tokens (`/^\[_/`), joins tokens into words at a leading space; `parseOpenAiWhisper` reads `segments[].words[]` (`word`, `start`, `end`).
  - `openaiTranscribe(…, o & { words?: boolean })`: with `words`, also `timestamp_granularities[]=word`; reads top-level `words[]`, offset per piece.
  - `elevenlabsTranscribe` returns `words` (the `type: 'word'` items) besides `groupWords` segments.
  - `TranscriptionService.transcribe(i & { words?: boolean; language?: string | null })` returns `{ kind, segments, words?: TranscriptWord[], language }`; `language` (editor's "redo choosing the language", Task 14) is passed to the engine only when given.

- [ ] **Step 1: Write the failing tests**: `whisperArgs('whisper.cpp', {…, words: true, flags: {vad:true,sns:true,np:true,ojf:true}})` contains `-ojf` and not `-oj`; without `words` equals the current argv (snapshot of today's array); `openai-whisper` with words ends with `--word_timestamps True`; `parseWhisperCpp` of a fixture with tokens `[' Ciao' 0–400, ' a' 450–500, 'mi' 500–600, '[_TT_50]']` → words `Ciao` (0–0.4), `ami` (0.45–0.6); `parseOpenAiWhisper` of a words fixture; `openaiTranscribe` with words: the fake fetch sees both granularities and the second 600 s piece's words are offset by 600; `elevenlabsTranscribe` returns 3 words from a 3-word + spacing fixture; `TranscriptionService.transcribe({…, words: true})` with `fakeWhisper` (fixture with tokens, help text listing `-ojf`) returns words, and the fake's recorded argv has `-ojf`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/transcription-words.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** the new file plus the existing transcription test files that cover `whisperArgs`/parsers (find them with `grep -l whisperArgs packages/core/test`) — Expected: PASS, with the analysis argv unchanged.
- [ ] **Step 5: Commit** `feat(core): keep word timings from the transcription engines`.

### Task 4: Subtitle store, fingerprint, protected folder, job kind and events

**Files:**
- Create: `packages/core/src/subtitles/store.ts`; Test: `packages/core/test/subtitles-store.test.ts`
- Modify: `packages/shared/src/events.ts:88,202-237`, `packages/shared/src/creative.ts:493,571`, `packages/core/src/creatives/creative-turns.ts:1355`, web exhaustive switches on `JobKind` (`packages/web/src/labels.ts`, any the compiler names), i18n.

**Interfaces:**
- Produces:
  - `JobKind` + `'subtitles'`; `ServerMessage` + `{ type: 'subtitles'; project: string; creative: string; lang?: LocaleTag }`.
  - `ConversationEntry` system + `subtitles?: { state: 'ready' | 'failed' | 'no-speech' | 'unsupported-language'; lang?: LocaleTag; detected?: string; briefLang?: LocaleTag }`.
  - `interface SubtitlesSummary { lang: LocaleTag; origin: 'speech' | 'translation'; sourceLang?: LocaleTag; cues: number; edited: number; hash: string; timing: SubtitleSet['timing']; timingChanged: boolean; staleCues: number }`; `CreativeDetail.subtitles?: SubtitlesSummary[]` (absent: none).
  - `store.ts`: `subtitlesDir(creativeDir)`, `subtitlePath(creativeDir, lang)`; `listSubtitleSets(creativeDir): Promise<SubtitleSet[]>` (unparseable files skipped with a console warning); `readSubtitleSet(creativeDir, lang): Promise<{ set: SubtitleSet; hash: string } | null>` (through `readRegularFile`, `SUBTITLE_LIMITS.fileBytes`); `writeSubtitleSet(creativeDir, set): Promise<string>` (atomic, returns hash); `removeSubtitleSet`.
  - `audioFingerprint(c: Composition): string` — sha256 of canonical JSON of `{ duration, clips: mixClips(c) sorted by start then src, each { src, start, duration, trimStart, volume, fadeIn, fadeOut } }`: visual edits do not change it.
  - `class SubtitleCommits { constructor(o: { git: Git; quietMs?: number /*30_000*/ }); touch(ref: CreativeRef, message: string): void; flush(ref?: CreativeRef): Promise<void> }` — one `git.commitPaths(projectDir, ['creatives/<slug>/subtitles'], message)` after `quietMs` without a new `touch` for that creative; `flush` commits now (called before any render/export, Tasks 18/21).
  - Creative turns: `protectedDirs` gains `join(creativeDir, 'subtitles')` (the agent changes text only through its tool).
  - i18n: `jobs.subtitlesLabel({ title })` (it "Sottotitoli · {title}"), `subtitles.commit({ title, lang })` (it "Sottotitoli: {title} ({lang})").

- [ ] **Step 1: Write the failing tests**: write → read round-trip and hash stable; a file over 1 MiB or with a bad schema → `readSubtitleSet` null, `listSubtitleSets` skips it; `audioFingerprint` unchanged when a text clip moves, changed when an audio clip's start or the duration changes; `SubtitleCommits` with `quietMs: 20` and a fake `Git`: three touches → one `commitPaths` call after the quiet time; `flush` commits at once; the creative turn's policy input lists `<creativeDir>/subtitles` in `protectedDirs` (extend the existing turn-policy test that asserts `protectedDirs`).
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/subtitles-store.test.ts` (and the extended turn test) — Expected: FAIL.
- [ ] **Step 3: Implement**; fix exhaustive `JobKind` switches (`subtitles` jobs link to the creative page).
- [ ] **Step 4: Run** the files, `pnpm -r typecheck`, `pnpm -s check:i18n` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): subtitle store, audio fingerprint and job kind`.

### Task 5: The subtitles job

**Files:**
- Create: `packages/core/src/subtitles/subtitles-job.ts`; Test: `packages/core/test/subtitles-job.test.ts`
- Modify: `packages/core/src/server/app.ts:291` (lane `subtitles: 1`), i18n

**Interfaces:**
- Consumes: Tasks 1–4; `mixClips`/`mixAudio` (`render/audio-mix.ts`), `findFfmpeg` (`render/encode.ts`), `extractWav`/`silenceRatio` (`analysis/audio.ts`), `knownVoiceScripts`/`instanceComposition` (`localization/store.ts`), the `Transcriber` interface of `analysis/video-analysis.ts` extended with `words`/`language`.
- Produces:
  - `SUBTITLES_LANE = 'subtitles'`.
  - `class SubtitlesService { constructor(d: { queue: JobQueue; transcriber?: Transcriber; ffmpeg?: () => Promise<FfmpegInfo | null>; media: MediaTools; turns: CreativeTurnService; commits: SubtitleCommits; broadcast(m: ServerMessage): void; presets(): Promise<FormatPreset[]> })`
    - `start(ref: CreativeRef, o: { mode: 'new' | 'retime'; lang?: LocaleTag; drawn?: boolean }): Promise<JobSummary>` — 409 `subtitles-running` when one runs for the creative; 409 `subtitles-no-video` when the latest version has no video format.
    - `pending(ref): TranscriptionPending | null`; `choose(ref, c: Omit<TranscriptionChoice, 'file'>): Promise<void>`; `recheck(ref): Promise<TranscriptionPending | null>` — same hold semantics as the analysis (`transcription-check` while planning, `transcription-choice` while asking).
    - `onReady(fn: (ref: CreativeRef, r: { lang: LocaleTag; drawn: boolean }) => void): void` (Phase 3 hooks the style turn here).
  - Job flow: latest version → main format = `subtitleSourceFormat(version, brief, presets)` (the first format of `brief.formats` that is a primary, not a still, with a composition) → `mixAudio` into a temp work dir (`.studio/cache/subtitles/<slug>/`, removed after) → `extractWav` to 16 kHz mono → `silenceRatio ≥ SILENCE_NO_SPEECH` or no audio → system entry `subtitles.state: 'no-speech'`, no set written → `transcribe({ words: true, language: o.lang ?? null })` → `subtitleLangOf(o.lang ?? detected)`; null → `unsupported-language` entry, nothing written → for each voice clip with a known script, words in its span replaced by `alignToScript` → `buildCues` → when a set of that language exists, `mergeKeepingEdited(existing.cues, fresh)` (re-read just before writing) → `writeSubtitleSet` with `timing = { version, format, fingerprint: audioFingerprint(c) }`, `transcript`, `detected` → `commits.touch` → broadcast `subtitles` → system entry `{ state: 'ready', lang, detected, briefLang }` (briefLang only when it differs from `lang`).
  - i18n: `subtitles.ready({ lang })` (it "Sottotitoli pronti ({lang})."), `subtitles.readyOtherLang({ lang, brief })` (it "Sottotitoli pronti in {lang}: è la lingua parlata nel video, non quella del brief ({brief})."), `subtitles.noSpeech` (it "Nessun parlato nel video: nessun sottotitolo."), `subtitles.unsupported({ detected })`, `subtitles.failed({ reason })`, `errors.subtitlesRunning`, `errors.subtitlesNoVideo`, `errors.noFfmpegSubtitles`.

- [ ] **Step 1: Write the failing tests** (temp workspace with a creative whose v1 composition has a `sine`-tone audio clip generated by ffmpeg in `beforeAll`; a fake `Transcriber` returning fixed words):
  - "ready": writes `subtitles/it.json` with cues from the fake words, `timing.version === 1`, the fingerprint of v1, one system entry `subtitles.state === 'ready'`, one `subtitles` broadcast, one `commits.touch`.
  - "detected language differs from the brief": detected `en`, brief primary `it` → set `en.json`, entry carries `briefLang: 'it'`.
  - "voice script is the truth": an audio clip with `role: 'voice'`, `script: 'Motion Studio is great'`, fake words `motion studia is grate` → cue text `Motion Studio is great`.
  - "no audio track" and "silence" → `no-speech`, no file; "transcription none" (fake returns `none-skipped`, no segments) → `no-speech`; "unsupported language" (detected `ar`) → `unsupported-language`, no file.
  - "a job finishing after a save keeps the saved edits": an existing `it.json` with an edited cue written while the fake transcriber is blocked → after release the cue is still there with its text.
  - "a held choice": `plan` returns `ask` → job queued with `waitReason: 'transcription-choice'`, `pending(ref)` returns it; `choose({ choice: 'whisper', remember: false })` releases it.
  - `start` twice → second 409 `subtitles-running`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/subtitles-job.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `SubtitlesService`; register it and the `subtitles` lane in `app.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): the subtitles job`.

### Task 6: Routes, downloads and the agent's `start_subtitles` tool

**Files:**
- Create: `packages/core/src/server/subtitles-routes.ts`, `packages/core/src/subtitles/subtitles-tools.ts`; Test: `packages/core/test/subtitles-routes.test.ts`
- Modify: `packages/core/src/server/app.ts` (register routes, `extraTools`), `packages/core/src/agent/launcher.ts:32-36` (`SUBTITLE_TOOLS`, in `MCP_TOOLS.creative`), `packages/mcp-studio/src/server.mjs`, `packages/mcp-studio/test/server.test.ts`, `packages/core/src/creatives/prompt.ts`, `packages/core/src/project-template.ts:68`, `packages/core/src/server/creative-routes.ts` (`CreativeDetail.subtitles`)

**Interfaces:**
- Produces (routes, all under `/api/projects/:slug/creatives/:c`):
  - `GET /subtitles` → `{ sets: SubtitlesSummary[]; job: JobSummary | null; pending: TranscriptionPending | null }` (`timingChanged`: the set's fingerprint differs from the latest version's main format; `staleCues`: 0 until Phase 4).
  - `POST /subtitles` body `{ mode?: 'new' | 'retime'; lang?: LocaleTag }` → `{ job }`.
  - `POST /subtitles/transcription-choice` body `transcriptionChoiceSchema.omit({ file: true })`; `POST /subtitles/transcription-recheck`.
  - `GET /subtitles/:lang` → `{ set: SubtitleSet; hash: string }`; `GET /subtitles/:lang/file.srt` and `/file.vtt` → `text/plain; charset=utf-8` / `text/vtt`, `content-disposition: attachment; filename="<creative slug>.<lang>.srt"`, cues clamped to the latest version's main-format duration.
  - `SUBTITLE_TOOLS = ['start_subtitles'] as const`; handler `start_subtitles({ drawn: boolean, lang?: LocaleTag })` through `c.appScope` (creative turns only, 403 `tool-unavailable` elsewhere), calls `SubtitlesService.start(ref, { mode: 'new', drawn, lang })`, returns `{ started: true, jobId }`; refuses a second call in the same turn (409).
  - Prompt (`prompt.ts`, creative turns) adds, in English: when the user asks for subtitles without saying how, ask with AskUserQuestion whether they want them drawn into the video or only as a track/file, before calling `start_subtitles`; never hand-time text clips for speech any more. `project-template.ts:68` "Voice-over subtitles" line replaced by "Subtitles: call `start_subtitles`; never one text clip per sentence."

- [ ] **Step 1: Write the failing tests**: GET with no sets → `{ sets: [], job: null, pending: null }`; after writing a set, the SRT download body equals `toSrt(cues, { durationMs })` and has the attachment header; an unknown lang → 404; a `lang` outside `SUPPORTED_LOCALES` → 400; POST twice → 409 `subtitles-running`; the tool through a creative token starts a job and a second call in the turn → 409, through a brief token → 403; `server.mjs` lists `start_subtitles` only when `MOTION_STUDIO_TOOLS` names it; the creative prompt contains `start_subtitles` and `drawn into the video`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/subtitles-routes.test.ts packages/mcp-studio/test/server.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** routes, tool, declaration, prompt lines; `CreativeDetail.subtitles` filled by the creative GET.
- [ ] **Step 4: Run** both files and the existing prompt test file that snapshots the template, updated — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): subtitle routes and the start_subtitles tool`.

### Task 7: `.srt`/`.vtt` in the export

**Files:**
- Modify: `packages/core/src/server/creative-routes.ts:162-177,823-955`, `packages/core/src/creatives/export.ts` (write the files), `packages/web/src/screens/ExportDialog.tsx`, `packages/web/src/api.ts`, i18n
- Test: `packages/core/test/export-subtitles.test.ts` (new), `packages/web/test/ExportDialog.test.tsx` (extend the existing dialog test file)

**Interfaces:**
- Produces:
  - `exportBody.subtitles?: { files?: LocaleTag[] }` (Phase 3 adds `drawn`, `soft`); each lang must have a set (400 `export-subtitles-missing`).
  - `writeSubtitleFiles(o: { destination: string; stem: string; sets: SubtitleSet[]; durationMs: number; copy?: CopyFn }): Promise<string[]>` in `export.ts` — `<stem>.<lang>.srt` and `.vtt` next to each exported VIDEO file (stills get none), through `copyUnique` naming rules; returned paths join `ExportResult.files`.
  - Export dialog: when `detail.subtitles` is non-empty, a "Sottotitoli" section with one row "File .srt e .vtt" and a checkbox per language (none ticked by default); the body sends `subtitles.files`.
  - i18n `web.exportUi.subtitles.{ title, files, filesHint }` (it "Sottotitoli", "File .srt e .vtt", "Accanto a ogni video, per YouTube, Vimeo, LinkedIn e i siti.").

- [ ] **Step 1: Write the failing tests**: core — an export with `subtitles: { files: ['it'] }` of a video format writes `<stem>.mp4`, `<stem>.it.srt`, `<stem>.it.vtt`; a still format in the same export gets none; `files: ['en']` without an `en` set → 400 `export-subtitles-missing`; "export without subtitles is unchanged": the same export without the field writes exactly the files it wrote before (compare to the existing export test's expectation). Web — the section shows only with `detail.subtitles`, and ticking Italian sends `subtitles: { files: ['it'] }`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/export-subtitles.test.ts packages/web/test/ExportDialog.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** both files, typecheck, i18n check — Expected: PASS.
- [ ] **Step 5: Commit** `feat: export subtitles as .srt and .vtt files`.

### Task 8: Chat card and transcription choice for subtitles (web)

**Files:**
- Modify: `packages/web/src/components/Conversation.tsx` (system entry with `subtitles`), `packages/web/src/components/TranscriptionChoices.tsx` (submit seam), `packages/web/src/components/TranscriptionDialog.tsx`, `packages/web/src/api.ts`, `packages/web/src/eventsReducer.ts`/`useServerEvents.ts` (`subtitles` message → creative tick), i18n
- Create: `packages/web/src/components/SubtitlesReadyCard.tsx`; Test: `packages/web/test/subtitles-ready-card.test.tsx`

**Interfaces:**
- Produces:
  - `api.subtitles(slug, c)`, `api.startSubtitles(slug, c, body)`, `api.subtitlesChoice(slug, c, choice)`, `api.subtitlesRecheck(slug, c)`, `api.subtitleSet(slug, c, lang)`, `subtitleFileUrl(slug, c, lang, 'srt' | 'vtt')` (signed like other downloads, following the pattern `api.ts` uses for file links).
  - `TranscriptionChoicesProps.submit?: (c: Omit<TranscriptionChoice, 'file'>) => Promise<unknown>` and `recheck?: () => Promise<TranscriptionPending | null>`; default: the analysis routes (unchanged behaviour).
  - `SubtitlesReadyCard({ slug, creative, entry })`: state `ready` → title "Sottotitoli pronti", the language, downloads ".srt" ".vtt" (Phase 2 adds "Apri l'editor"), and when `briefLang` is set the note `subtitles.readyOtherLang` (Phase 4 adds "Traduci in {language}"); `no-speech` / `unsupported-language` / `failed` → their one line.
  - While the subtitles job is held on `transcription-choice`, the creative page shows `TranscriptionDialog` with `submit = api.subtitlesChoice`.

- [ ] **Step 1: Write the failing tests**: a `ready` entry renders "Sottotitoli pronti" and two links ending in `/subtitles/it/file.srt` and `.vtt`; with `briefLang: 'it'` and `lang: 'en'` the other-language note shows; `TranscriptionChoices` with `submit` calls it (and not `api.transcriptionChoice`) on "Whisper".
- [ ] **Step 2: Run** `pnpm vitest run packages/web/test/subtitles-ready-card.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** it plus the existing `TranscriptionChoices`/dialog tests, typecheck, i18n — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): subtitles ready card and transcription choice`.
- [ ] **Phase end:** full suite, personal-data scan, report ("da verificare a mano": ask the agent "aggiungi i sottotitoli" in the real app and download the `.srt`).

---

# Phase 2 — the subtitle editor (`feat/subtitles-editor`, decisions 1651–1665)

## File Structure (Phase 2)

- Create `packages/web/src/screens/subtitles/`: `SubtitlesScreen.tsx` (layout B), `CueList.tsx`, `CueTimeline.tsx`, `subtitlesModel.ts` (pure reducer), `useSubtitleSave.ts`, `subtitles.css`.
- Modify `packages/web/src/routes.ts`, `App.tsx` (screen), `screens/CreativeCanvas.tsx` (entry), `components/SubtitlesReadyCard.tsx` (button).
- Core: `server/subtitles-routes.ts` (save, waveform), `subtitles/subtitles-job.ts` (retime notice), `library/asset-meta.ts` (peaks helper reuse).

### Task 9: Route and entries

**Files:**
- Modify: `packages/web/src/routes.ts:7-110`, `packages/web/src/App.tsx`, `packages/web/src/screens/CreativeCanvas.tsx` (top bar of the side panel, next to the tabs at :1117), `packages/web/src/components/SubtitlesReadyCard.tsx`, i18n
- Create: `packages/web/src/screens/subtitles/SubtitlesScreen.tsx` (shell only here); Test: `packages/web/test/routes.test.ts` (extend), `packages/web/test/subtitles-ready-card.test.tsx` (extend)

**Interfaces:**
- Produces: `Route` + `{ name: 'subtitles'; slug: string; creative: string; lang?: LocaleTag }`; hash `#/p/<slug>/c/<c>/subtitles` and `#/p/<slug>/c/<c>/subtitles/<lang>`; `href.subtitles(slug, c, lang?)`; `depthOf` 4; `routeKey` `subtitles:<slug>/<c>`; `projectOf` covers it. The creative page shows a "Sottotitoli" button when `detail.subtitles?.length`; the ready card gains "Apri l'editor" → `href.subtitles(slug, c, lang)`.

- [ ] **Step 1: Write the failing tests**: `parseRoute('#/p/acme/c/promo/subtitles/en')` → `{ name: 'subtitles', slug: 'acme', creative: 'promo', lang: 'en' }`; a sister slug `promo~b` parses; an unsupported lang segment → the creative route; `href.subtitles('acme','promo')` round-trips; the card's "Apri l'editor" links to `#/p/acme/c/promo/subtitles/it`.
- [ ] **Step 2: Run** the two files — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): the subtitle editor's route and entries`.

### Task 10: Editor model (pure)

**Files:**
- Create: `packages/web/src/screens/subtitles/subtitlesModel.ts`; Test: `packages/web/test/subtitles-model.test.ts`

**Interfaces:**
- Consumes: `cueWarnings`, `wrapLines`, `SUBTITLE_RULES` (Task 2).
- Produces:
  - `interface EditorState { cues: SubtitleCue[]; past: SubtitleCue[][]; future: SubtitleCue[][]; selected: string | null; durationMs: number; dirty: boolean }` (undo depth 200).
  - `type EditorOp = { type: 'text'; id; text } | { type: 'times'; id; start?; end? } | { type: 'split'; id; at: number /*text index*/ } | { type: 'merge'; id } | { type: 'add'; at: number /*ms*/ } | { type: 'delete'; id } | { type: 'replace'; find: string; with: string; caseSensitive: boolean } | { type: 'undo' } | { type: 'redo' } | { type: 'select'; id: string | null } | { type: 'load'; cues; durationMs }`.
  - `editorReducer(s: EditorState, op: EditorOp): EditorState` — every change sets `edited: true` on the touched cues; `times` snaps to a neighbour edge within 100 ms and clamps so cues never overlap and stay inside `[0, durationMs]` with `end − start ≥ 200`; `split` divides times at the word time of the cut when words exist, else proportionally to characters; `merge` joins with the next (text joined by a space, rewrapped); `add` inserts a 2000 ms cue in the gap at `at` (shorter if the gap is shorter; no-op if none); `replace` changes every matching cue and marks only those edited.
  - `warningsOf(cues, lang): Map<string, CueWarning[]>`; `cueAt(cues, ms): SubtitleCue | null`.

- [ ] **Step 1: Write the failing tests**: text edit marks `edited` and is undoable/redoable; dragging an end past the next start stops at the next start; a start dragged to 50 ms from the previous end snaps to it; split at the middle of `'Ciao a tutti'` with words splits at the word time; merge rewraps to ≤ 2 lines; add in a 600 ms gap makes a 600 ms cue; replace `motion studio` → `Motion Studio` (case-insensitive) marks only the 2 matching cues; `warningsOf` flags a 30-char 1 s cue `tooFast`.
- [ ] **Step 2: Run** `pnpm vitest run packages/web/test/subtitles-model.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): the subtitle editor model`.

### Task 11: Saving (core route, autosave, batched commits)

**Files:**
- Modify: `packages/core/src/server/subtitles-routes.ts`; Test: `packages/core/test/subtitles-routes.test.ts` (extend)
- Create: `packages/web/src/screens/subtitles/useSubtitleSave.ts`; Test: `packages/web/test/subtitle-save.test.tsx`

**Interfaces:**
- Produces:
  - `PUT /subtitles/:lang` body `{ baseHash: string; cues: SubtitleCue[] }` → `{ hash }`; validates with `subtitleSetSchema` (400 with the issue), keeps every other field of the stored set, 409 `subtitles-conflict` with `{ hash }` when `baseHash` is not the stored hash, `commits.touch`, broadcast `subtitles`. Saving stays allowed while a job runs (a transcription takes minutes): reads and writes of a set go through one per-creative `KeyedMutex` (`core/src/keyed-mutex.ts`) shared with the job's final re-read + `mergeKeepingEdited` + write (Task 5), so neither loses the other's change.
  - `useSubtitleSave(slug, c, lang, state): { status: 'saved' | 'saving' | 'error' | 'conflict'; flush(): Promise<void> }` — debounce `SAVE_DEBOUNCE_MS = 800`; on conflict reloads the set and keeps the local undo stack out (status `conflict`, a one-line notice "Modificati altrove: ricaricati" — i18n); flushes on route leave and `beforeunload`.

- [ ] **Step 1: Write the failing tests**: core — PUT with the right hash saves and returns the new hash; "a stale baseHash gets 409 subtitles-conflict"; a cue with `end < start` → 400; PUT during a running job succeeds and the job's later write keeps the saved cue (edited); the store's commit is touched once. Web (fake timers) — three edits within 800 ms → one PUT; a 409 → status `conflict` and the set re-fetched.
- [ ] **Step 2: Run** the two files — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat: autosave of the subtitle editor`.

### Task 12: Editor layout B (player + list)

**Files:**
- Modify: `packages/web/src/screens/subtitles/SubtitlesScreen.tsx`; Create: `CueList.tsx`, `subtitles.css`
- Test: `packages/web/test/subtitles-screen.test.tsx`; Chrome: `packages/web/test/subtitles-layout.test.tsx` (`LayoutRig`, `MS_REQUIRE_CHROME=1`)

**Interfaces:**
- Consumes: `CompositionPlayer` (`components/CompositionPlayer.tsx`) with `api.previewSession` of the latest version's main format; Tasks 10–11.
- Produces: left the player with an editor-only caption overlay (the current cue's text, plain style, highlighted) — replaced by runtime drawing when the composition has a subtitles track (Task 22); right the cue list (start, end as `mm:ss.mmm` inputs, text textarea, warning chips with i18n tooltips, row actions split / merge / delete, "+ Riga", find and replace bar); clicking a row seeks; the row under the playhead follows playback (scrolls into view without stealing focus); keys: Space play/pause (not inside a textarea), ↑/↓ previous/next cue, ⌘Z/⇧⌘Z undo/redo; downloads `.srt`/`.vtt` in the header; light and dark through the theme tokens.

- [ ] **Step 1: Write the failing tests** (jsdom): rows render start/end/text for each cue; typing in a row's text dispatches `text` and shows "Salvataggio…"; clicking a row seeks the fake player; ↓ selects the next cue; a `tooFast` cue shows its chip. Chrome (`subtitles-layout.test.tsx`): at 1280×800 and 900×700 the player and the list sit side by side with no horizontal scroll, the list scrolls by itself, a two-line cue text is fully visible; screenshot artefact kept by the rig.
- [ ] **Step 2: Run** `pnpm vitest run packages/web/test/subtitles-screen.test.tsx` and `MS_REQUIRE_CHROME=1 pnpm vitest run packages/web/test/subtitles-layout.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** both — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): the subtitle editor screen`.

### Task 13: Waveform timeline with draggable cues

**Files:**
- Modify: `packages/core/src/server/subtitles-routes.ts`, `packages/core/src/library/asset-meta.ts` (export the PCM-to-peaks path for a given file)
- Create: `packages/web/src/screens/subtitles/CueTimeline.tsx`
- Test: `packages/core/test/subtitles-routes.test.ts` (extend), `packages/web/test/cue-timeline.test.tsx`

**Interfaces:**
- Produces:
  - `SUBTITLE_WAVEFORM_PEAKS = 1200`; `GET /subtitles/waveform?version=<n>` → `{ peaks: number[]; durationMs: number }` — the main format's audio mix (Task 5's mix code, factored as `mixCreativeAudio(ref, version, format, workDir, signal): Promise<string | null>` in `subtitles-job.ts`) decoded at 4 kHz and `peaksOf(pcm, 1200)`, cached in `.studio/cache/subtitles/<slug>/wave-<fingerprint>.json`.
  - `CueTimeline({ cues, durationMs, peaks, time, selected, dispatch, onSeek })`: canvas waveform; one block per cue; dragging a block's left/right edge (6 px handles) dispatches `times` (the model snaps and clamps); dragging the body moves both edges; a click on empty space seeks; horizontal zoom with ⌘-wheel (1×–20×); `role="slider"` edges with ←/→ 100 ms, ⇧ 1 s.

- [ ] **Step 1: Write the failing tests**: core — the waveform of the tone fixture has 1200 peaks with max > 0.5 and a second call reads the cache (spy on the mixer); web — a pointer drag of 50 px on a 1000 px track of 10 s dispatches `times` with `end + 500`; a keyboard → on an edge moves 100 ms; empty-space click seeks.
- [ ] **Step 2: Run** the two files — Expected: FAIL.
- [ ] **Step 3: Implement**; mount the timeline under player and list in `SubtitlesScreen`.
- [ ] **Step 4: Run** them plus `subtitles-layout.test.tsx` under Chrome (the timeline is under both columns, full width) — Expected: PASS.
- [ ] **Step 5: Commit** `feat: the subtitle timeline with the audio waveform`.

### Task 14: "Il video è cambiato" and redoing the transcription

**Files:**
- Modify: `packages/core/src/subtitles/subtitles-job.ts` (`retime` mode), `packages/core/src/creatives/creative-turns.ts` (after a version is saved: a chat notice when a set's fingerprint no longer matches), `packages/web/src/screens/subtitles/SubtitlesScreen.tsx`, `packages/web/src/components/SubtitlesReadyCard.tsx`, i18n
- Test: `packages/core/test/subtitles-job.test.ts` (extend), `packages/web/test/subtitles-screen.test.tsx` (extend)

**Interfaces:**
- Produces:
  - `retime` = the Task 5 flow with `mergeKeepingEdited` always applied and `timing` updated; text of edited cues never changed.
  - System entry `subtitles.state` + `'timing-changed'` written once per new version whose main-format fingerprint differs from a set's (`it` "Il video è cambiato: ricontrolla i tempi"), with "Rifai i tempi" (→ `POST /subtitles {mode:'retime'}`) and "Apri l'editor".
  - Editor banner with the same text and button when `timingChanged`; header menu "Rifai la trascrizione…" with a language picker (`SUPPORTED_LOCALES`, default auto) → `POST /subtitles { mode: 'new', lang }`.

- [ ] **Step 1: Write the failing tests**: "fingerprint mismatch shows the notice and changes nothing": a v2 whose voice clip starts 1 s later → after the version is saved, one `timing-changed` entry, `it.json` unchanged on disk; `retime` then moves an unedited cue by +1000 and keeps an edited cue's text; the editor shows the banner when `timingChanged` and its button posts `mode: 'retime'`; the redo menu posts `{ mode: 'new', lang: 'de' }`.
- [ ] **Step 2: Run** the two files — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat: the timing-changed notice and Rifai i tempi`.
- [ ] **Phase end:** full suite, scan, report ("da verificare a mano": drag cue edges on a real creative; Space/arrows; light and dark).

---

# Phase 3 — drawn subtitles, soft track, export choices (`feat/subtitles-drawn`, decisions 1666–1685)

## File Structure (Phase 3)

- Shared: `composition/schema.ts` (track kind and clip), `composition/validate.ts`, `composition/composition.schema.json` (regenerated), `formats/link.ts` (`renderState`), `creative.ts` (`OutputFileInfo.subtitles`).
- Runtime: `src/subtitles.ts` (new: cue lookup, layout, drawing), `mount.ts`, `page.ts`, `protocol.ts`, `preview-bridge.ts`, `layer-protocol.ts`, `layer-agent.ts`.
- Core: `compositions/composition-server.ts` (`MintSessionOptions.subtitles`), `render/renderer.ts` (soft tracks), `creatives/render-jobs.ts` (staging, snapshot, export renders), `server/creative-routes.ts` (export choices), `subtitles/subtitles-tools.ts` (`edit_subtitles`), `subtitles/subtitles-job.ts` (style turn), `creatives/prompt.ts`, `project-template.ts`.
- Web: `screens/ExportDialog.tsx`, `screens/subtitles/SubtitlesScreen.tsx` (runtime drawing), `screens/editor/Timeline.tsx` (the track shown, locked).

### Task 15: The `subtitles` track in the composition schema

**Files:**
- Modify: `packages/shared/src/composition/schema.ts:177-205`, `validate.ts`, `composition.schema.json` (regenerate with `pnpm --filter @motion-studio/shared gen:composition-schema`), `localization/apply.ts` (ignore the clip), i18n problem texts
- Test: `packages/shared/test/composition-subtitles.test.ts`

**Interfaces:**
- Produces:
  - `trackSchema.kind` + `'subtitles'`; `CLIP_TYPES` + `'subtitles'`; `subtitlesClip = { ...clipBase, type: 'subtitles', template?: path (an `.html` under `layers/`), props: { fontFamily?, fontSize: gt 0 ≤ 2000, fontWeight?, color, lineHeight?: 0.8..3, align?: TEXT_ALIGNS, position: 'bottom' | 'middle' | 'top', margin: 0..COORD (px from the safe-zone edge), maxWidth: 0.2..1 (of the frame width), background?: color, boxPadding?: 0..200, boxRadius?: 0..200, outlineColor?: color, outlineWidth?: 0..20, shadow?: boolean, entrance?: 'none' | 'fade' | 'pop' | 'slideUp', entranceSec?: 0..1, highlight?: { color: color } } }` with `.describe()` texts the agent reads (e.g. "Draws the active subtitle line of the creative's subtitle set; one per composition; the text is not here").
  - Validation (`validateComposition`): at most one `subtitles` track (`subtitlesTwice`), holding exactly one `subtitles` clip with `start: 0`, `duration` = composition duration (`subtitlesSpan`), no `scene`; a `subtitles` clip on another kind or another clip on a `subtitles` track → `trackKind`; a still (duration 0) with a subtitles track → `subtitlesOnStill`.
  - `stripSubtitles(c: Composition): Composition` (no `subtitles` track; same object when none) and `subtitlesClipOf(c): SubtitlesClip | null`.

- [ ] **Step 1: Write the failing tests**: a valid composition with the track passes; two tracks → `subtitlesTwice`; a clip of 0–5 in a 10 s composition → `subtitlesSpan`; on a still → `subtitlesOnStill`; `template: 'assets/x.html'` refused; `stripSubtitles` drops only that track; the checked-in JSON schema equals the generated one (existing test, regenerated); `applyLocalization` leaves the clip untouched and `localizableEntries` lists nothing for it.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/test/composition-subtitles.test.ts` and the existing schema test — Expected: FAIL.
- [ ] **Step 3: Implement**; the composition editor shows the track locked and its clip not draggable (`screens/editor/Timeline.tsx`, the existing `locked` path).
- [ ] **Step 4: Run** them and the existing `Timeline` test — Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): the subtitles track of a composition`.

### Task 16: The runtime draws the active line

**Files:**
- Create: `packages/composition-runtime/src/subtitles.ts`; Test: `packages/composition-runtime/test/subtitles.test.ts`, Chrome: `packages/composition-runtime/test/subtitles.chrome.test.ts`
- Modify: `page.ts` (`CompositionData.subtitles`), `runtime-main.ts`, `mount.ts`, `protocol.ts` (incoming `setSubtitles`), `preview-bridge.ts`

**Interfaces:**
- Produces:
  - `interface RuntimeSubtitles { lang: string; cues: Array<{ start: number; end: number; text: string; words?: Array<{ start: number; end: number; text: string }> }> }` (ms); `CompositionData.subtitles?: RuntimeSubtitles` (validated by `readCompositionData`: ≤ 2000 cues, finite sorted times, text ≤ 200; a bad block is dropped with a `subtitlesInvalid` error, never fatal).
  - `activeCue(cues, ms): number` (binary search, −1 when none); `drawSubtitles(el: HTMLElement, clip: SubtitlesClip, cue, tMs, frame: { width; height; safeZone? })` — absolutely positioned box in the safe zone (`position` + `margin`), `maxWidth`, text with `white-space: pre-line`, background/outline/shadow, entrance over `entranceSec` from the cue start, `highlight` colours the word whose span holds `tMs` (words only).
  - `PreviewIncoming` + `{ type: 'setSubtitles'; subtitles: RuntimeSubtitles | null }` (preview only; redraws at the current time).
  - Runtime error code `subtitlesInvalid` in `RUNTIME_ERROR_CODES` (a warning, not failing).

- [ ] **Step 1: Write the failing tests**: `activeCue` at 999/1000/3499/3500 for one 1000–3500 cue → −1/0/0/−1; `readCompositionData` drops an unsorted subtitles block; mount with a subtitles track and data shows the cue text at t = 2 s and nothing at 4 s; `highlight` marks the second word at its time; `setSubtitles` changes the text shown without a remount. Chrome: a 1080×1920 composition with `position: 'bottom'`, `margin: 120` and a safe zone of `bottom: 300` → the box's bottom edge ≤ 1920 − 300 − 120; screenshot artefact at t = 2 s.
- [ ] **Step 2: Run** `pnpm vitest run packages/composition-runtime/test/subtitles.test.ts` and the Chrome file with `MS_REQUIRE_CHROME=1` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** both plus `protocol.test.ts`, `page.test.ts`, `no-network.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(runtime): draw the active subtitle line`.

### Task 17: The optional HTML template

**Files:**
- Modify: `packages/composition-runtime/src/layer-protocol.ts` (`LayerConfig.subtitles`), `layer-agent.ts` (`window.msSubtitles`), `mount.ts` (a `subtitles` clip with `template` mounts as an html layer fed with the cues), `packages/shared/src/composition/layer-check.ts` (same checks as html layers)
- Test: `packages/composition-runtime/test/subtitles-template.test.ts`

**Interfaces:**
- Produces: `LayerConfig.subtitles?: RuntimeSubtitles`; in the layer `window.msSubtitles` (frozen) and `window.msActiveCue(tMs): { index; text; words; progress } | null` (from layer.js, so the template only paints); the template's `msSeek(t)` is driven like any html layer; `setSubtitles` in preview remounts the template layer; when `template` is set, the built-in drawing is off for that clip.

- [ ] **Step 1: Write the failing tests**: a template layer receives `msSubtitles.cues.length === 2`; `msActiveCue(1500)` returns the first cue with `progress` 0.2 for a 1000–3500 cue; a template that fetches the network is refused by the existing layer check; with `template` set, no built-in subtitle box is in the DOM.
- [ ] **Step 2: Run** the file — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** it plus `layer-host.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(runtime): subtitle templates as html layers`.

### Task 18: Staging, snapshots and render staleness

**Files:**
- Modify: `packages/core/src/compositions/composition-server.ts:118-145,592` (`MintSessionOptions.subtitles`), `packages/core/src/render/renderer.ts:63-120` (`RenderCompositionOptions.subtitles`), `packages/core/src/creatives/render-jobs.ts` (`renderFormat`, `renderLocalized`, preview sessions), `packages/shared/src/creative.ts:209` (`OutputFileInfo.subtitles`), `packages/shared/src/formats/link.ts:233` (`renderState`), `packages/core/src/server/creative-routes.ts` (preview session + detail)
- Test: `packages/core/test/subtitles-render.test.ts`, `packages/shared/test/render-state.test.ts` (extend or create)

**Interfaces:**
- Produces:
  - `MintSessionOptions.subtitles?: RuntimeSubtitles` (inlined into the page data); `RenderCompositionOptions.subtitles?: RuntimeSubtitles`.
  - `stageSubtitles(o: { creativeDir; composition: Composition; lang: LocaleTag | null; durationMs: number }): Promise<{ data: RuntimeSubtitles; hash: string; set: SubtitleSet } | null>` in `core/src/subtitles/store.ts` — null when the composition has no visible subtitles track or no set; cues clamped to the duration.
  - Default pairing (U8): a version render draws `videoLang` = brief primary if a set exists in it, else the set with `origin: 'speech'`; a localized render (`renderLocalized`) draws its own language's set if present, else none (decision).
  - Snapshot: `outputs/vN/subtitles/<lang>.<hash first 12>.json` written before the render (idempotent); `OutputFileInfo.subtitles?: { lang: LocaleTag; hash: string }` and the localized row's `render.subtitles?` the same.
  - `renderState(v, formatId, subtitleHashes?: Readonly<Record<string, string>>)`: an output with `subtitles` whose hash differs from `subtitleHashes[lang]` (when given) is `stale`; callers pass `CreativeDetail.subtitles` hashes; absent map → today's rule.
  - `commits.flush(ref)` before any render job starts.
  - Preview sessions of a version carry the same staged subtitles; the editor sends `setSubtitles` after each local change (Task 22).

- [ ] **Step 1: Write the failing tests**: "staged cues are clamped to the composition" (a cue past the 5 s duration is cut/dropped in `stageSubtitles`); no subtitles track → null (and the render options carry no `subtitles`: anti-goal 4); the version render of a composition with the track records `outputs[].subtitles = { lang: 'it', hash }` and writes the snapshot (fake engine capturing the mint options); `renderState` → `stale` after the set's hash changes, `rendered` without the map; a localized `de` render with no `de` set gets no subtitles.
- [ ] **Step 2: Run** the two files — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** them plus `render-jobs.test.ts` and `render-locale.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: stage subtitle snapshots into renders`.

### Task 19: The agent designs the look and corrects text

**Files:**
- Modify: `packages/core/src/subtitles/subtitles-tools.ts` (`edit_subtitles`), `packages/core/src/subtitles/subtitles-job.ts` (style turn on ready), `packages/core/src/agent/launcher.ts` (`SUBTITLE_TOOLS` + `edit_subtitles`), `packages/mcp-studio/src/server.mjs`, `packages/core/src/creatives/prompt.ts`, `packages/core/src/project-template.ts`, `packages/shared/src/creative.ts` (`CreativeFile.subtitlesDrawn?`)
- Test: `packages/core/test/subtitles-tools.test.ts`

**Interfaces:**
- Produces:
  - `edit_subtitles({ lang: LocaleTag, replace?: Array<{ find: string; with: string; caseSensitive?: boolean }> ≤ 20, cues?: Array<{ id: string; text: string }> ≤ 200 })` → `{ changed: number }`; every changed cue gets `edited: true`; through `SubtitleCommits`; it re-reads the set, applies, and writes under the same per-creative lock as the PUT, so a concurrent user save is never lost.
  - `start_subtitles({ drawn: true })` records `CreativeFile.subtitlesDrawn = true`; on the job's ready with `drawn`, `SubtitlesService.onReady` starts a creative turn (`turns.start(ref, { text: <i18n subtitles.styleRequest>, pins: [] })`) asking the agent to add the `subtitles` track (a new version); the turn is not started when the latest version already has the track.
  - Prompt rules (English): the track draws the creative's set; default legible style in the brand fonts and colours (`fontSize` ≥ 4.5 % of the frame height, contrast box or outline); in 9:16 formats `position: 'bottom'` with `margin` ≥ 18 % of the height (above the platform UI); entrance subtle; `highlight` only when asked; never write subtitle text in text clips; to turn drawing off remove the track.

- [ ] **Step 1: Write the failing tests**: `edit_subtitles` replace `motion studio` → `Motion Studio` changes 2 cues, marks them edited, touches the commit; an unknown cue id → 400; outside a creative turn → 403; the ready hook with `subtitlesDrawn` starts one turn whose message contains `subtitles track`; with the track already present, no turn; the creative prompt contains `18 %` and `brand`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/subtitles-tools.test.ts` and `packages/mcp-studio/test/server.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): the agent styles and corrects subtitles`.

### Task 20: Soft `mov_text` tracks at the final mux

**Files:**
- Modify: `packages/core/src/render/renderer.ts:279-283` (final mux), `packages/core/src/render/encode.ts` (a `subtitleInput` helper passing the `FfArg` checks)
- Test: `packages/core/test/render-soft-subtitles.test.ts`

**Interfaces:**
- Produces: `RenderCompositionOptions.softSubtitles?: Array<{ lang: LocaleTag; srt: string /*absolute, in the work dir*/ }>`; at the final mux each becomes an input (`ownInput(srt, { formats: ['srt'] })`), `-map <k>:s:0`, `-c:s mov_text`, `-metadata:s:s:<i> language=<ISO639_2[lang]>`, still `-c:v copy` (no re-encode); `.mp4`, `.mov`, `.m4v` only (other containers: ignored with a warning). `RenderResult.softSubtitles?: LocaleTag[]`. Absent option → the argv is byte-identical to today's.

- [ ] **Step 1: Write the failing tests** (a 1 s lavfi video rendered through the mux helper, not Chrome): with two SRT files `it`, `en` the output has 2 subtitle streams (`ffprobe -show_streams`), codec `mov_text`, tags `ita` and `eng`; "mov output gets a mov_text track"; without the option the mux argv equals the recorded argv of today (snapshot).
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/render-soft-subtitles.test.ts packages/core/test/ffmpeg-exec.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** (factor the final mux argv into `finalMuxArgs(...)` so it is testable without Chrome).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(render): soft mov_text subtitle tracks`.

### Task 21: Export choices in the core (drawn, files, soft; the clean video)

**Files:**
- Modify: `packages/core/src/server/creative-routes.ts:162-177,823-955`, `packages/core/src/creatives/render-jobs.ts:338-470` (`exportRenderAndWait`/`renderForExport` gain subtitle options), `packages/core/src/creatives/export.ts`, `packages/shared/src/export-name.ts`
- Test: `packages/core/test/export-subtitles.test.ts` (extend)

**Interfaces:**
- Produces:
  - `exportBody.subtitles?: { drawn?: LocaleTag[]; files?: LocaleTag[]; soft?: LocaleTag[] }` (each lang must have a set: 400 `export-subtitles-missing`).
  - Naming (`export-name.ts`): `subtitledStem(stem, lang) = withSuffix(stem, 'sub-' + slugToken(lang))`; never collides with `withLocaleSuffix` (`-<locale>` vs `-sub-<locale>`), tested with `exportNameCollisions`.
  - Rules: `drawn` → for each lang a video `<stem>-sub-<lang>.<ext>` rendered for the export with that set drawn (the version render is reused when its `outputs[].subtitles` already is that lang and hash); `files`/`soft` → the CLEAN video `<stem>.<ext>`: the version render when the composition has no subtitles track, else an export render of `stripSubtitles(c)`; `soft` langs muxed into it (Task 20); `files` written next to it (Task 7). Without `subtitles` in the body: today's path, no render job added.
  - `ExportRenderOptions = { profile: RenderProfile; subtitles?: { drawn: LocaleTag | null; strip: boolean; soft: LocaleTag[] } }` on `exportRenderAndWait`; job label adds "· sottotitoli {lang}" / "· senza sottotitoli".
  - Stills are skipped with `skipped` text `export.subtitlesStill({ format })`; a follower reuses its primary's file, renamed.

- [ ] **Step 1: Write the failing tests** (fake render engine recording options): `drawn: ['en']` on a composition whose version render draws `it` → one export render with drawn `en`, file `<stem>-sub-en.mp4`; `files: ['it'], soft: ['it','en']` on a composition with the track → one export render with `strip: true` and `soft: ['it','en']`, files `<stem>.mp4`, `<stem>.it.srt`, `<stem>.it.vtt`, and NO drawn subtitles in its options (anti-goal 2); same request on a composition without the track → no render job, the soft mux runs on a copy of the version file; "stills are skipped with a note"; "a follower reuses the primary's subtitled file"; no `subtitles` → render-job count unchanged from the existing export test.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/export-subtitles.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** (the soft mux on an existing file = `finalMuxArgs` with `-c copy` on the video+audio input).
- [ ] **Step 4: Run** it plus `export.test.ts`, `export-jobs.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: subtitle choices in the export`.

### Task 22: Export dialog section and drawn preview in the editor (web)

**Files:**
- Modify: `packages/web/src/screens/ExportDialog.tsx` (section), `packages/web/src/screens/exportModel.ts`, `packages/web/src/screens/subtitles/SubtitlesScreen.tsx` (runtime drawing + `setSubtitles`), `packages/web/src/components/CompositionPlayer.tsx` (a `subtitles` prop forwarded as `setSubtitles`), i18n
- Test: `packages/web/test/ExportDialog.test.tsx` (extend), `packages/web/test/subtitles-screen.test.tsx` (extend); Chrome: `packages/web/test/export-subtitles-layout.test.tsx`

**Interfaces:**
- Produces: the "Sottotitoli" section with three rows — "Nel video" (a language picker, one render per chosen language), "File .srt e .vtt" and "Traccia nel file MP4" (checkbox per language) — and the note (it) "File e tracce vanno con un video senza sottotitoli disegnati." when either of the last two is on; the file-name preview lists `-sub-<lang>` videos and the `.srt`/`.vtt` names; the body sends `subtitles`. In the editor, when the latest version has a subtitles track the overlay is off and the player gets `subtitles` (debounced 150 ms) so the runtime draws the agent's style live.

- [ ] **Step 1: Write the failing tests**: ticking "Nel video: English" and "Traccia nel file MP4: Italiano" sends `subtitles: { drawn: ['en'], soft: ['it'] }` and shows the note and `promo-…-sub-en.mp4` in the preview; with no sets the section is absent; the editor with a track sends `setSubtitles` after a text edit (fake player). Chrome: the dialog at 520 px wide shows the section without overflow in light and dark.
- [ ] **Step 2: Run** the files (Chrome one with `MS_REQUIRE_CHROME=1`) — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): subtitle choices in the export dialog`.
- [ ] **Phase end:** full suite (including the Chrome files), scan, report ("da verificare a mano": a real render with drawn subtitles in 9:16; open the MP4 in QuickTime/VLC and switch the soft track).

---

# Phase 4 — languages (`feat/subtitles-languages`, decisions 1686–1700)

## File Structure (Phase 4)

- Core: `subtitles/translate-job.ts` (new), `agent/launcher.ts` + `agent/policy.ts` (job kind `subtitles-translate`), `bridge/bridge.ts` (scope), `subtitles/subtitles-job.ts` (localized voices), `server/subtitles-routes.ts`, `subtitles/subtitles-tools.ts` (`add_subtitle_language`), `server/creative-routes.ts` + `creatives/render-jobs.ts` (pairing).
- Shared: `subtitles/cues.ts` (`staleCues`), `events.ts` (`JobKind`), i18n.
- Web: `screens/subtitles/LangSwitcher.tsx` (new), `SubtitlesScreen.tsx`, `CueList.tsx`, `components/SubtitlesReadyCard.tsx`, `screens/ExportDialog.tsx`, `screens/creative/RenderLanguagesDialog.tsx`.

### Task 23: Translation job

**Files:**
- Create: `packages/core/src/subtitles/translate-job.ts`; Test: `packages/core/test/subtitles-translate.test.ts`
- Modify: `packages/shared/src/events.ts` (`JobKind` + `'subtitles-translate'`), `packages/shared/src/subtitles/cues.ts`, `packages/core/src/agent/launcher.ts:35-52`, `packages/core/src/agent/policy.ts:96-97`, `packages/core/src/bridge/bridge.ts` (`SubtitleTranslateScope`), `packages/mcp-studio/src/server.mjs`, web exhaustive switches

**Interfaces:**
- Produces:
  - `staleCues(target: SubtitleSet, source: SubtitleSet): string[]` — target cue ids whose `source.text` differs from the source cue they overlap most (by time), or whose source cue is gone.
  - Agent kind `subtitles-translate`: `MCP_TOOLS = ['report_progress', 'submit_subtitle_translation']`, no file tools, no Bash, no network (policy like `video-analysis` with empty `readDirs`); usage recorded under Claude's usage as today's kinds.
  - `submit_subtitle_translation({ cues: Array<{ id: string; text: string }> })` → validates ids ⊆ asked ids, text 1..200, ≤ 2 lines after `wrapLines` (else 400 with the ids, the agent retries; at most 5 calls).
  - `SubtitleTranslateService.start(ref, o: { target: LocaleTag; ids?: string[] /*Ritraduci: these only*/ }): Promise<JobSummary>` — source = the `origin: 'speech'` set; prompt (English) lists source cues `id | start–end | text` inside `<cues>` (defused), the target language, the brand's glossary from `read_brand_kit` text if present, the rule "keep each line's meaning within its time; 17 characters per second at most"; result written as a set `origin: 'translation'`, `sourceLang`, same ids and times as the source, `source.text` per cue; an existing target cue with `edited: true` is never replaced (it is reported stale instead).

- [ ] **Step 1: Write the failing tests** (fake runner calling the tool): a full translation writes `en.json` with source ids, times and `source.text`; "a translation never replaces an edited target cue" (edited `c2` keeps its text, `staleCues` lists it when its source changed); `ids: ['c3']` only rewrites `c3`; a tool call with an unknown id → 400; a 3-line text → 400 naming the id; the policy for the kind has no `Bash`, `Read`, `WebFetch`; `staleCues` after editing source `c1` → `['c1']`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/subtitles-translate.test.ts packages/core/test/policy.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): translate subtitle sets`.

### Task 24: Localized voices transcribe their own audio

**Files:**
- Modify: `packages/core/src/subtitles/subtitles-job.ts`; Test: `packages/core/test/subtitles-job.test.ts` (extend)

**Interfaces:**
- Produces: `SubtitlesService.start(ref, { mode: 'new', lang })` where `lang` has a localization row with translated voices (`row.voice` not `original`/`muted`) on the latest version's main format → the mix is made from `localizedComposition(base, overlay, row)` (localization store), transcribed with `language: lang` (the language is known here, not guessed), each voice clip's words aligned to the overlay's translated `voiceScripts`; `origin: 'speech'`; the set's `timing.fingerprint` is that localized composition's. `add language` (Task 25) picks this path instead of translation when such a row exists.

- [ ] **Step 1: Write the failing tests**: a v1 with a `de` row whose voice clip is replaced by a German voice file and script → the job for `de` mixes the German file (the fake transcriber sees the localized wav duration), passes `language: 'de'`, and the cues carry the German script's words; with `voice: 'original'` the add-language path translates instead (assert `SubtitleTranslateService.start` called).
- [ ] **Step 2: Run** the file — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): subtitles from localized voices`.

### Task 25: Language routes and the agent's `add_subtitle_language`

**Files:**
- Modify: `packages/core/src/server/subtitles-routes.ts`, `packages/core/src/subtitles/subtitles-tools.ts`, `packages/core/src/agent/launcher.ts` (`SUBTITLE_TOOLS`), `packages/mcp-studio/src/server.mjs`, `packages/core/src/creatives/prompt.ts`
- Test: `packages/core/test/subtitles-routes.test.ts` (extend)

**Interfaces:**
- Produces: `POST /subtitles/languages` body `{ lang: LocaleTag }` → `{ job }` (Task 24 path or translation; 409 `subtitles-lang-exists`; 409 `subtitles-no-source` without a speech set); `POST /subtitles/:lang/retranslate` body `{ ids?: string[] }` → `{ job }` (all stale cues when absent; edited cues included only when listed — the user asked for them explicitly); `DELETE /subtitles/:lang` (not the speech set: 409); `SubtitlesSummary.staleCues` now counted. Tool `add_subtitle_language({ lang })` → the same as the route. Subtitle languages are independent of `brief.locales` (U8): nothing here changes the brief.

- [ ] **Step 1: Write the failing tests**: add `en` → translate job started; add an existing lang → 409; retranslate without ids → job with the stale ids; delete the speech set → 409; the summary reports `staleCues: 1` after a source edit; the tool works from a creative token and the brief stays unchanged.
- [ ] **Step 2: Run** the file — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): subtitle languages`.

### Task 26: Language switcher, stale marks and "Traduci in" (web)

**Files:**
- Create: `packages/web/src/screens/subtitles/LangSwitcher.tsx`
- Modify: `SubtitlesScreen.tsx`, `CueList.tsx`, `packages/web/src/components/SubtitlesReadyCard.tsx`, i18n
- Test: `packages/web/test/subtitles-languages.test.tsx`; Chrome: `packages/web/test/subtitles-layout.test.tsx` (extend: the switcher with 6 languages fits the header)

**Interfaces:**
- Produces: header switcher of the creative's subtitle languages (route `lang` segment), "+ Lingua" menu listing the brief's locales first then the rest of `SUPPORTED_LOCALES` without existing ones; a translated language's stale rows marked ("Testo originale cambiato") with "Ritraduci" per row and "Ritraduci tutto" in the header; a translated row shows its source text greyed under the field; the ready card's other-language note gains "Traduci in {language}" → `POST /subtitles/languages { lang: briefLang }` then opens the editor on it.

- [ ] **Step 1: Write the failing tests**: switching to `en` navigates to `/subtitles/en`; "+ Lingua" lists `de` (brief extra) before `fr`; a stale row shows the mark and its "Ritraduci" posts `{ ids: ['c2'] }`; "Traduci in Italiano" posts `{ lang: 'it' }`.
- [ ] **Step 2: Run** the files — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): subtitle languages in the editor`.

### Task 27: Multi-language exports and pairing

**Files:**
- Modify: `packages/core/src/server/creative-routes.ts` (`withLocales` + subtitles), `packages/core/src/creatives/render-jobs.ts` (`renderForExport` with a locale), `packages/core/src/creatives/export.ts`, `packages/web/src/screens/ExportDialog.tsx`, `packages/web/src/screens/creative/RenderLanguagesDialog.tsx`, i18n
- Test: `packages/core/test/export-subtitles.test.ts` (extend), `packages/web/test/ExportDialog.test.tsx` (extend)

**Interfaces:**
- Produces:
  - `exportBody.subtitles.drawn` becomes `Array<{ video: LocaleTag; lang: LocaleTag }>` (a bare `LocaleTag` still accepted = `{ video: briefPrimary, lang }`); defaults the dialog proposes: each subtitle language on the video in that language when the creative is localized into it, else on the original (U8); any pair allowed.
  - Names: drawn file `subtitledStem(localizedStem(pattern, stem, video, video !== primary), lang)` — e.g. `promo-9x16-v3-de-sub-en.mp4`; `files` and `soft` go with each exported video language's clean video, every chosen subtitle language muxed/written once per video.
  - Export renders of a localized video with drawn subtitles use `localizedComposition` plus the chosen set (the export-only render path, `refuseProfileWithLanguages` relaxed only for subtitle renders at the default profile).
  - `RenderLanguagesDialog` shows, per language with a set, "con sottotitoli" (it) when that language's localized render will draw them (Task 18 default pairing).

- [ ] **Step 1: Write the failing tests**: `drawn: [{ video: 'it', lang: 'en' }, { video: 'de', lang: 'de' }]` → two export renders with those compositions and sets, names `…-sub-en.mp4` and `…-de-sub-de.mp4`; `soft: ['it','en','de']` with `locales: ['it','de']` → each clean video gets 3 tracks; a bare `drawn: ['en']` still works (Phase 3 clients); the dialog's default pairing for `de` (creative localized in `de`) is the German video, for `en` the original.
- [ ] **Step 2: Run** the two files — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** them plus `export.test.ts`, `render-locale.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: multi-language subtitle exports`.
- [ ] **Phase end:** full suite, scan, report ("da verificare a mano": add English to an Italian creative, fix one line, export Italian video + English drawn and both soft tracks).

---

## Self-review notes

- Spec coverage: §6.1 → Tasks 1, 4, 18; §6.2 → Tasks 3, 5, 6, 8 (U9 in Task 6 prompt); §6.3 → Tasks 9–14 (language switcher in 26); §6.4 → Tasks 15–17, 19, 22; §6.5 → Tasks 23–26; §6.6 → Tasks 7, 20–22, 27; §6.7 → Task 14; §6.8 → Task 3 (paid transcription billed as today) and Task 23 (Claude usage).
- Type names used across tasks: `SubtitleSet`, `SubtitleCue`, `SubtitlesSummary`, `RuntimeSubtitles`, `SubtitleCommits`, `SubtitlesService`, `SubtitleTranslateService`, `stageSubtitles`, `stripSubtitles`, `subtitledStem`, `mergeKeepingEdited`, `audioFingerprint`, `SUBTITLE_TOOLS`.
