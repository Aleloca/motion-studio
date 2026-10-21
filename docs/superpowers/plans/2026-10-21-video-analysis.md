# Video analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** analyse each video that enters a brief once, store a text sidecar `assets/.analysis/<file>.md` (summary, one timeline with on-screen text and speech, usable moments, look, transcript, tags) keyed by the video's sha256, and have the creative and brief agents read it instead of the footage. Transcription is optional: local Whisper (bundled whisper.cpp, an installed whisper.cpp / openai-whisper / faster-whisper) or OpenAI / ElevenLabs.

**Architecture:** a `VideoAnalysisService` in the core keeps one queue per project (dedup by sha256). For each video it runs, without the agent, ffmpeg scene detection, frame extraction to `.studio/cache/analysis/<sha>/` and audio extraction; then (Phase 2) the transcription; then a new agent job kind `video-analysis` (read-only, no network, no Bash) in chunks of 40 frames that writes structured data through the MCP tool `write_video_analysis`. The core renders the sidecar (header always core-computed), commits it, and the prompt builders annotate fresh sidecars. Waits that need the user (long video, transcription choice) are held jobs (`JobQueue` `hold`) answered through routes; Phase 3 adds the screens.

**Tech Stack:** TypeScript, Fastify (core), zod (shared), ffmpeg/ffprobe through `media/ffmpeg-exec.ts` + `media/ffmpeg-filters.ts`, the `studio` MCP server (`server.mjs`), React 19 + Vitest/jsdom (web), the project's real-Chrome layout harness, electron-builder, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-21-video-analysis-design.md` (approved). Section numbers below (§n) refer to it.

## Global Constraints

- Three phases, three branches, merged in order, each from `main` after the previous merge, each leaving the app working: Phase 1 `feat/video-analysis-core` (Tasks 1–10), Phase 2 `feat/video-analysis-transcription` (Tasks 11–17), Phase 3 `feat/video-analysis-ui` (Tasks 18–23). Each builder works only in its own worktree; SDD scripts run from the phase worktree.
- Agent jobs only through `AgentLauncher.start` + `buildAgentPolicy`; app actions only as `studio` MCP tools served by `/api/bridge/<tool>`; ffmpeg filtergraphs only as builders in `media/ffmpeg-filters.ts` (the source scan in `test/ffmpeg-exec.test.ts` must stay green).
- Tests: TDD, Vitest. Fake agent only (`ControlledRunner`, `buildServer` on a temp workspace, the bridge-token pattern of `core/test/helpers/brief-app.ts`), temp `MOTION_STUDIO_CONFIG_DIR`; ffmpeg fixtures generated inside the tests (`execCommand('ffmpeg', ['-f','lavfi', …])`, as `media-tools.test.ts`); never the real `claude`, the app, a real Whisper model or binary, a provider call (fake `fetch` / loopback `node:http` server with `guardedFetch`), the keychain (`MemoryVault`). Real Chrome only through the project harness with `MS_REQUIRE_CHROME=1`.
- Run only the task's test files (`pnpm vitest run <file>`) plus `pnpm -r typecheck` and `pnpm -s check:i18n`; the full suite only at the end of each phase.
- Nothing downloaded and nothing paid without an explicit click that showed size or cost (§3 anti-goals); frames go only to Claude Code, audio only to the transcription method the user chose.
- Every UI and agent-visible core string in `packages/shared/src/i18n/en.ts` and `it.ts` (same shape). Italian copy from the spec verbatim where quoted: "Analisi del video in corso ({files})… · Salta", "Non analizzato · In corso · Pronta · Non aggiornata · Errore", "Analizza", "Rianalizza", "Modifica", "Chiedi ogni volta · Whisper sul Mac · OpenAI · ElevenLabs · Mai", "Installa Whisper (gratis, sul tuo Mac) · {size}", "Trascrivi con OpenAI · ~{cost}", "Trascrivi con ElevenLabs · ~{cost}", "Continua senza trascrizione", "Ricorda la scelta", "Analizza tutto", "Analizza a densità ridotta", "Usa un Whisper già installato", "Scegli…", "Whisper trovato: {engine}, {version}, {model}, Metal/GPU {gpu}".
- Fixed values (§4–§7): sidecar `format: motion-studio-video-analysis/1`; frames 768 px on the long side; one frame per scene plus one every 10 s inside a scene; no cuts → one every 10 s; chunks of 40 frames; videos > 20 min (1200 s) ask first, reduced density = one frame per scene, at most one every 30 s; audio `-vn -map 0:a:0 -ac 1 -ar 16000 -c:a pcm_s16le -f wav`; silence ≥ 95 % = no speech; whisper.cpp v1.9.5 built with `-DGGML_METAL_EMBED_LIBRARY=ON -DBUILD_SHARED_LIBS=OFF`; models `ggml-small.bin` 487,601,967 B sha256 `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`, `ggml-large-v3-turbo.bin` 1,624,555,275 B sha256 `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69`, `ggml-silero-v6.2.0.bin` 885,098 B sha256 `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987`.
- Commits small; every message ends with exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_019pFVuDZefGiQPfptrkkr1A`
- Decisions in `docs/decisions-log.md`, Italian, format of the last entries (`1467. 🟢 **Titolo (decisione: …).** testo *Costo cambio:* …`): Task 10 first appends the spec's 1468–1490 (they are not in the log yet), then Phase 1 uses 1491–1505, Phase 2 1506–1520, Phase 3 1521–1535. No other numbers.
- Before finishing a phase: the personal-data scan of the diff (patterns in the builder rules file) finds nothing; tree clean.

## Review Focus

1. **A video renamed, replaced or deleted while its analysis runs** (or between two chunk runs): no sidecar must be written for a file that is gone, nor a fresh-looking sidecar for content that changed. Pinned by Task 6 test "the video changes during the analysis: the sidecar is not written, the analysis is queued again" and Task 8 test "rename during a running analysis".
2. **A user edit of the sidecar meeting an automatic re-analysis** (the video changes after an edit, then enters another brief): the edit must never be overwritten silently. Pinned by Task 7 test "a stale edited sidecar is not re-analysed automatically" and Task 7 "Rianalizza on an edited sidecar → 409 analysis-edited unless overwrite".
3. **The agent returning times outside its chunk, unknown frame names, or nothing at all** (a run that ends without calling the tool): the core must reject bad calls with a clear message, retry nothing silently, and fail the analysis without blocking the creative. Pinned by Task 5 tool tests and Task 6 "a chunk run without a write fails the analysis; the waiting turn starts".
4. **Generate pressed with a held analysis** (long video awaiting confirmation, transcription awaiting a choice, no UI yet in Phases 1–2): the turn must not wait for a held job. Pinned by Task 9 test "a held analysis does not hold the turn".
5. **Video files with odd names** (spaces, accents, `#`, `%`, a name starting with `-`): sidecar path, frame names, ffmpeg arguments and prompt lines must all hold. Pinned by Task 2 test (`sidecarPathOf('assets/My clip #1 %.mp4')`) and Task 3 fixture named `-a clip %.mp4`.

---

# Phase 1 — core analysis without transcription (`feat/video-analysis-core`)

## File Structure (Phase 1)

- Create `packages/shared/src/video-analysis.ts` (schemas, types, constants, job keys), exported from `packages/shared/src/index.ts`; modify `events.ts` (`JobKind`, `JobWaitReason`, `ServerMessage`), `usage.ts` (`usageKindSchema`), `creative.ts` (system entry `analysisWait`), i18n `en.ts` / `it.ts`.
- Create `packages/core/src/analysis/`: `sidecar.ts` (render/parse/freshness/merge), `video-hash.ts` (streaming sha256 with a stat-keyed cache), `frames.ts` (scene detection, frame plan, extraction), `audio.ts` (wav extraction, silence ratio), `analysis-prompt.ts`, `analysis-tool.ts` (`write_video_analysis` validation), `video-analysis.ts` (`VideoAnalysisService`); `packages/core/src/server/analysis-routes.ts`.
- Modify `media/ffmpeg-filters.ts` (new builders), `agent/policy.ts`, `agent/launcher.ts`, `bridge/bridge.ts`, `bridge/bridge-routes.ts`, `mcp-studio/src/server.mjs`, `server/app.ts`, `server/creative-routes.ts`, `creatives/creative-turns.ts`, `creatives/group-turn.ts`, `creatives/variant-directions.ts`, `creatives/prompt.ts`, `brief/brief-session.ts`, `brief/brief-prompt.ts`, `library/library-store.ts`, `library/rename-journal.ts`, `library/rename-recovery.ts`, `creatives/cache-sweep.ts`, web exhaustive switches on `JobKind` (`labels.ts`, `shell/ActivityCenter.tsx` link to assets).
- Docs: `docs/agent-backends.md` (the new kind), `docs/decisions-log.md`.

### Task 1: Shared types, events, usage kind and copy

**Files:**
- Create: `packages/shared/src/video-analysis.ts`; Test: `packages/shared/test/video-analysis.test.ts`
- Modify: `packages/shared/src/events.ts:88` (`JobKind` + `'video-analysis'`), `events.ts:120-121` (`JobWaitReason` + `'video-long'`, `JOB_WAIT_REASONS`), `events.ts:193` (`ServerMessage`), `packages/shared/src/usage.ts:17`, `packages/shared/src/creative.ts` (system entry), `index.ts`, i18n `en.ts` / `it.ts`

**Interfaces:**
- Produces (all from `@motion-studio/shared`):
  - `VIDEO_ANALYSIS_FORMAT = 'motion-studio-video-analysis/1'`; `ANALYSIS_DIR = 'assets/.analysis'`; `FRAME_LONG_SIDE = 768`; `STATIC_FRAME_EVERY_SEC = 10`; `REDUCED_FRAME_EVERY_SEC = 30`; `CHUNK_FRAMES = 40`; `LONG_VIDEO_SEC = 1200`; `SILENCE_NO_SPEECH = 0.95`; `TOKENS_PER_FRAME = 800` (estimate shown before a long video, decision 1491).
  - `transcriptKindSchema = z.enum(['whisper-small','whisper-large-v3-turbo','openai','elevenlabs','none-skipped','none-no-speech'])`.
  - `sidecarHeaderSchema` (strict): `{ format: literal, asset: string (/^assets\//), sha256: /^[0-9a-f]{64}$/, bytes: int ≥ 0, durationSec: number ≥ 0, width: int, height: int, fps: number | null, hasAudio: boolean, transcript: TranscriptKind, language: string | null, generator: string, createdAt: string, edited: boolean }`; `type SidecarHeader`.
  - `transcriptSegmentSchema = { from: number ≥ 0, to: number ≥ from, text: string 1..2000 }`; `type TranscriptSegment`.
  - `writeVideoAnalysisSchema` (strict, every key optional, at least one): `summary: string 1..2000`; `timeline: Array<{ from: number ≥ 0; to: number; onScreen: string 1..1000; onScreenText?: string[] ≤ 20 (each ≤ 300); frame?: string }> ≤ 200`; `usableMoments: Array<{ from; to; why: string 1..300 }> ≤ 30`; `look: { colours: string[] ≤ 12 (each /^#[0-9a-fA-F]{6}$/); typography: string ≤ 300; framing: string ≤ 300; audio: string ≤ 300 }`; `tags: string[] ≤ 30 (each 1..40)`; `type VideoAnalysisWrite`.
  - `type VideoAnalysisState = 'none' | 'queued' | 'running' | 'waiting' | 'ready' | 'stale' | 'error'`.
  - `type VideoAnalysisPending = { kind: 'long'; frames: number; reducedFrames: number; tokens: number; reducedTokens: number }` (Phase 2 adds the `'transcription'` member).
  - `interface VideoAnalysisView { file: string; state: VideoAnalysisState; jobId: string | null; error: string | null; pending: VideoAnalysisPending | null; header: SidecarHeader | null; body: string | null }`.
  - `videoAnalysisJobKey(root, projectSlug, sha256) => \`video-analysis:${root}:${projectSlug}:${sha256}\``.
  - `ServerMessage` + `{ type: 'video-analysis'; project: string; file: string; view: VideoAnalysisView }` and `{ type: 'analysis-wait'; project: string; creative: string; files: string[] }` (empty `files` = the wait ended).
  - `ConversationEntry` system: `analysisWait?: { files: string[] }`.
  - `usageKindSchema` + `'video-analysis'`.
  - i18n: `jobs.videoAnalysisLabel({ file })` (it "Analisi video · {file}", en "Video analysis · {file}"); `jobs.waitReasons['video-long']` (it "In attesa di conferma: video lungo"); `videoAnalysis.waiting({ files })` (it "Analisi del video in corso ({files})…", en "Analysing the video ({files})…"); `videoAnalysis.skip` ("Salta" / "Skip"); `videoAnalysis.skipped({ files })` (it "Analisi saltata: l'agente usa il video così com'è ({files}).") ; `videoAnalysis.failed({ file, reason })`; `videoAnalysis.states.<VideoAnalysisState>` (it: "Non analizzato", "In coda", "In corso", "In attesa", "Pronta", "Non aggiornata", "Errore"); `videoAnalysis.commit({ file })` (it "Analisi video: {file}"); `errors.analysisEdited`, `errors.analysisNotVideo`, `errors.analysisBadWrite({ detail })`, `errors.analysisNoWrite`, `errors.analysisChanged`, `errors.analysisWriteLimit`; `approvals.videoAnalysisReadOnly` (it "L'analisi video guarda solo i fotogrammi estratti: nient'altro si può approvare.").

- [ ] **Step 1: Write the failing tests** (`video-analysis.test.ts`): `writeVideoAnalysisSchema` accepts `{ timeline: [{ from: 0, to: 2.5, onScreen: 'Logo', frame: 'f-00000000.jpg' }] }`; refuses `{}`, `{ extra: 1 }`, colour `'red'`, 31 tags, a tag of 41 chars; `sidecarHeaderSchema` refuses `sha256: 'abc'` and `transcript: 'whisper'`; `videoAnalysisJobKey('/w','acme','ab…')` shape.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/test/video-analysis.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the module, extend `JobKind` / `JobWaitReason` / `ServerMessage` / `usageKindSchema` / system entry, add the i18n keys.
- [ ] **Step 4: Run** the test, `pnpm -r typecheck` (fix exhaustive switches the compiler names; the web routes `video-analysis` jobs to the Assets screen in `jobHref`), `pnpm -s check:i18n` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): video analysis schemas, job kind and events`.

### Task 2: The sidecar file and the video hash

**Files:**
- Create: `packages/core/src/analysis/sidecar.ts`, `packages/core/src/analysis/video-hash.ts`; Test: `packages/core/test/analysis-sidecar.test.ts`

**Interfaces:**
- Produces:
  - `sidecarPathOf(assetRel: string): string` — `assets/foo/clip.mp4` → `assets/.analysis/foo/clip.mp4.md` (keeps the subfolder; refuses a path outside `assets/` or containing `..`).
  - `framesDirOf(sha256): string` — `.studio/cache/analysis/<sha>`; `frameName(atSec): string` — `f-` + milliseconds zero-padded to 8 + `.jpg` (`12.5` → `f-00012500.jpg`); `frameTime(name): number | null`.
  - `formatTime(sec): string` — `mm:ss` (`hh:mm:ss` from one hour; `75.4` → `01:15`); speech lines use `mm:ss.s`.
  - `interface SidecarContent { summary: string; timeline: Array<{ from; to; onScreen; onScreenText: string[]; frame?: string; speech: TranscriptSegment[] }>; usableMoments; look; transcript: TranscriptSegment[]; tags: string[] }`.
  - `mergeTranscript(timeline, transcript): SidecarContent['timeline']` — each segment goes to the scene holding its midpoint; a segment past the last scene goes to the last one.
  - `renderSidecar(h: SidecarHeader, c: SidecarContent): string` — front matter as `key: <JSON scalar>` lines between `---` (no YAML dependency; a JSON string is valid YAML), then `## Summary`, `## Timeline` (`- [00:12–00:18] <onScreen>` + `  - On-screen text: "…"` + `  - Frame: .studio/cache/analysis/<sha>/<frame>` + `  - [00:13.2] "<speech>"`), `## Usable moments` (`- [in–out] why`), `## Look` (`- Colours: #…`, `- Typography: …`, `- Framing: …`, `- Audio: …`), `## Transcript` (first line `Automatic transcript: names may be wrong.`; omitted when the transcript is empty, replaced by one line naming `none-skipped` / `none-no-speech` in plain words), `## Tags` (comma-separated). Section titles stay English (agent-facing).
  - `parseSidecar(text): { header: SidecarHeader; body: string } | null` — null for any front matter that is not exactly ours (missing `---`, unknown key, schema failure).
  - `replaceBody(text, body): string` — keeps the header, sets `edited: true`, refuses a body starting with `---`.
  - `readSidecar(projectDir, assetRel)`, `writeSidecar(projectDir, assetRel, text)` (atomic tmp + rename, folders created, reads through `readRegularFile`, 2 MiB cap), `removeSidecar`, `moveSidecar(projectDir, from, to)` (also rewrites `asset` in the header).
  - `video-hash.ts`: `hashVideo(absPath): Promise<{ sha256: string; bytes: number }>` streaming; results cached in memory by `realpath + size + mtimeMs` (cap 500 entries); `isFresh(header, hash): boolean` = same sha256.

- [ ] **Step 1: Write the failing tests**: render → parse round-trip equals the header and keeps the body; `parseSidecar` returns null for a file with `format: other/1`, an extra key, no front matter; `replaceBody` sets `edited: true` and leaves `sha256` unchanged; `mergeTranscript` puts a 13.0–13.4 segment in the 12–18 scene and a 99 s segment in the last scene; `formatTime(3725) === '01:02:05'`; `sidecarPathOf('assets/My clip #1 %.mp4') === 'assets/.analysis/My clip #1 %.mp4.md'`, `sidecarPathOf('assets/../x.mp4')` throws; the rendered timeline line `- [00:12–00:18] Logo on white` and a speech line `  - [00:13.2] "Ciao"`; `hashVideo` of a 3-byte file equals the known sha256 and a second call with the same mtime does not re-read (spy on `createReadStream`).
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/analysis-sidecar.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): the video analysis sidecar format`.

### Task 3: Frames and audio without the agent

**Files:**
- Create: `packages/core/src/analysis/frames.ts`, `packages/core/src/analysis/audio.ts`; Test: `packages/core/test/analysis-media.test.ts`
- Modify: `packages/core/src/media/ffmpeg-filters.ts` (builders + `BUILT_FILTERS` gains `select`, `showinfo`, `silencedetect`), `packages/core/test/ffmpeg-filters.test.ts`

**Interfaces:**
- Produces:
  - Filter builders: `sceneDetectFilter(threshold: number /*0.05..0.9*/): FilterArg` (`-vf select='gt(scene,T)',showinfo`), `longSideScaleFilter(px: int 16..4096): FilterArg` (scales so the longer side is `px`, never enlarges, even sizes), `silenceDetectFilter(noiseDb: int -90..-10, minSec: number 0.1..10): FilterArg` (`-af silencedetect=n=…dB:d=…`).
  - `SCENE_THRESHOLD = 0.3` (decision 1492).
  - `detectScenes(ffmpeg: CommandExec, video: string, durationSec: number, signal?): Promise<number[]>` — cut times (s) parsed from `showinfo` `pts_time:` in stderr, sorted, deduplicated within 0.5 s.
  - `planFrames(cuts: number[], durationSec: number, density: 'full' | 'reduced'): number[]` — full: scene starts `[0, ...cuts]` plus `start + 10k` while `< sceneEnd − 1`; no cuts → `0, 10, 20…`; reduced: scene starts only, dropping any within 30 s of the previous kept one, and `0, 30, 60…` with no cuts. Each time clamped to `max(0, duration − 0.1)`.
  - `extractFrames(media: MediaTools-like exec, video, times, outDir, signal?): Promise<string[]>` — one `-ss t -frames:v 1` grab per time with `longSideScaleFilter(768)`, named `frameName(t)`, into `outDir` (created 0700); returns the names written.
  - `audio.ts`: `extractWav(exec, video, outWav, signal?): Promise<boolean>` with exactly the §5.2 arguments; `silenceRatio(exec, wav, durationSec): Promise<number>` (sum of `silence_duration` / duration, an open `silence_start` counted to the end; `n=-50dB`, `d=0.5`).
  - All ffmpeg calls through `execFfVia` with `mediaInput`; long runs get `timeoutMs = max(120 s, 2 × duration)`.

- [ ] **Step 1: Write the failing tests** (fixtures made in `beforeAll` in a temp dir: `-a clip %.mp4` = 3 s red + 3 s blue + 25 s green at 640×360 concatenated, with a 1 kHz `sine` track for the first 6 s and silence after; `silent.mp4` = 12 s colour + `anullsrc`; `noaudio.mp4` = 4 s colour):
  - `ffmpeg-filters.test.ts`: the three builders mint the expected argv and refuse out-of-range values.
  - `detectScenes` on the fixture → two cuts within 0.2 s of 3 and 6.
  - `planFrames([3,6], 31, 'full')` → `[0, 3, 6, 16, 26]`; `planFrames([], 25, 'full')` → `[0, 10, 20]`; `planFrames([3,6,40], 100, 'reduced')` → `[0, 40]`; `planFrames([], 95, 'reduced')` → `[0, 30, 60, 90]`.
  - `extractFrames` writes `f-00000000.jpg`… whose long side probes to 640 (no enlargement) and, from a 1920×1080 fixture, to 768.
  - `extractWav` on `noaudio.mp4` → false; on the fixture → a 16 kHz mono wav (ffprobe); `silenceRatio(silent wav) ≥ 0.95`; `silenceRatio(fixture wav) < 0.95`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/analysis-media.test.ts packages/core/test/ffmpeg-filters.test.ts packages/core/test/ffmpeg-exec.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the builders, `frames.ts`, `audio.ts`.
- [ ] **Step 4: Run** the three files — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): scene frames and audio for the video analysis`.

### Task 4: The `video-analysis` job kind (policy, launcher, bridge)

**Files:**
- Modify: `packages/core/src/agent/policy.ts:20,89-92,95-172`, `packages/core/src/agent/launcher.ts:31-35,100,101,296-309,329-337`, `packages/core/src/agent/runner.ts` (tool list constant), `packages/core/src/bridge/bridge.ts:6,69` (`VideoAnalysisScope`), `packages/core/src/bridge/bridge-routes.ts:55,151-169`
- Test: `packages/core/test/policy.test.ts`, `packages/core/test/bridge-routes.test.ts`, `packages/core/test/launcher.test.ts`

**Interfaces:**
- Produces: `AgentJobKind` + `'video-analysis'`; `MCP_TOOLS['video-analysis'] = ['report_progress', 'write_video_analysis']`; `SANDBOXED_TOOLS['video-analysis'] = LEGACY_TOOLS['video-analysis'] = ['Read']`; `PolicyInput.readDirs?: string[]` (absolute folders the job may Read, nothing else); `interface VideoAnalysisScope { root; projectSlug; projectDir; file: string; sha256: string; pass: 'whole' | 'chunk' | 'final'; from: number; to: number; frames: string[]; write: (w: VideoAnalysisWrite) => void }`; `BridgeContext.videoAnalysisScope?: Readonly<VideoAnalysisScope>`; `LaunchInput.videoAnalysisScope?`, `LaunchInput.readDirs?`.
- Policy for `video-analysis` (decision 1493): `disallowedTools` += `[...EDIT_TOOLS, 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task']`; `allowedTools` = `readDirs.map(d => Read(/<d>/**))` + MCP tools only (no project "Always" rules); sandbox: no network, `autoAllowBashIfSandboxed: false`; `addDirs` = `readDirs` (the frames folder). Usage tracker records the kind as `'video-analysis'`; not a live kind. Bridge `approve`: every tool of a `video-analysis` job is denied without a card with `approvals.videoAnalysisReadOnly`; never auto-approved.

- [ ] **Step 1: Write the failing tests**:
  - `policy.test.ts` "video-analysis: reads only the frames, no Bash, no network": with `readDirs: ['/p/.studio/cache/analysis/ab']` → `allowedTools` = `['Read(//p/.studio/cache/analysis/ab/**)', 'mcp__studio__report_progress', 'mcp__studio__write_video_analysis']`, `disallowedTools` ⊇ `['Bash','Grep','Edit','Write','WebFetch']`, `settings.sandbox.network` undefined.
  - `bridge-routes.test.ts` "a video-analysis job gets nothing approved": `approve` with `Read` of `/etc/hosts` → deny with `approvals.videoAnalysisReadOnly`, no approval created; `generate_image` with its token → 403.
  - `launcher.test.ts` "a video-analysis launch registers its scope and records usage under its kind": the bridge context resolved from the run's token has `videoAnalysisScope.sha256`; after `run.finish()` the ledger line has `kind: 'video-analysis'`.
- [ ] **Step 2: Run** the three files — Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** the three files, `pnpm -r typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): the read-only video-analysis job kind`.

### Task 5: The prompt and the `write_video_analysis` tool

**Files:**
- Create: `packages/core/src/analysis/analysis-prompt.ts`, `packages/core/src/analysis/analysis-tool.ts`; Test: `packages/core/test/analysis-tool.test.ts`
- Modify: `packages/mcp-studio/src/server.mjs:24-100` (tool declaration), `packages/mcp-studio/test/*` (listed-tools test, if one exists for `fill_brief`, mirror it)

**Interfaces:**
- Produces:
  - `buildAnalysisPrompt(i: { locale: Locale; pass: 'whole' | 'chunk' | 'final'; file: string; meta: { durationSec; width; height; fps; hasAudio }; framesDir: string /*absolute*/; frames: Array<{ name: string; at: number }>; transcript: TranscriptSegment[] /*the span's*/; transcriptNote: 'none-skipped' | 'none-no-speech' | null; timeline?: SidecarContent['timeline'] /*final pass*/ ; span?: { from; to; index; count } }): string` — English instructions (role: describe a video for a motion-graphics agent; Read each listed frame by absolute path; write once with `write_video_analysis`; `whole` = all fields, `chunk` = only `timeline` covering `span`, `final` = summary (3–5 lines: what, style, what it is good for in a creative), usableMoments with exact in/out and why, look (hex colours, typography, framing, audio character), tags — no frames, from the timeline text); the transcript inside `<transcript>` with `defuseTags`; `replyInstruction(locale)` last.
  - `validateWrite(scope: VideoAnalysisScope, raw: unknown): VideoAnalysisWrite` — `writeVideoAnalysisSchema`, then: `chunk` needs `timeline` and nothing else; `final` needs summary + usableMoments + look + tags and no `timeline`; `whole` needs all five; every `from < to`, inside `[scope.from − 0.5, scope.to + 0.5]`; `frame` ∈ `scope.frames`; errors `CodedError(400, errors.analysisBadWrite({ detail }), 'analysis-bad-write')` naming the item index.
  - `videoAnalysisTools(): Record<'write_video_analysis', BridgeHandler>` — scope from `c.videoAnalysisScope` (403 `tool-unavailable` without it or another kind), at most 5 calls per job (429 `errors.analysisWriteLimit`), `scope.write(validated)` (last write wins), returns `{ ok: true }`.
  - `server.mjs`: `write_video_analysis` with the JSON schema of `writeVideoAnalysisSchema` (description: "Video analysis jobs only: writes the analysis of the frames you were given").

- [ ] **Step 1: Write the failing tests**: the chunk prompt lists every frame's absolute path with its `formatTime`, contains `write_video_analysis` and the span, and defuses `</transcript>` in a segment; the final prompt holds no frame path and contains the timeline; `validateWrite` on a chunk scope 0–40 refuses `summary`, a scene 50–60, `frame: 'f-99999999.jpg'`, `from: 5, to: 5`; accepts a timeline inside the span; a final scope refuses `timeline`; the handler with a creative token → 403, the sixth call → 429; `server.mjs` lists `write_video_analysis` only when `MOTION_STUDIO_TOOLS` names it.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/analysis-tool.test.ts` (and the mcp-studio test) — Expected: FAIL.
- [ ] **Step 3: Implement** both modules and the declaration; register `...videoAnalysisTools()` in `extraTools` (`server/app.ts:838-850`).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): write_video_analysis and the analysis prompt`.

### Task 6: `VideoAnalysisService` — queue, pipeline, sidecar

**Files:**
- Create: `packages/core/src/analysis/video-analysis.ts`; Test: `packages/core/test/video-analysis.test.ts`, helper `packages/core/test/helpers/analysis-app.ts` (as `brief-app.ts`: `buildServer`, `ControlledRunner`, bridge origin, `tokenOf`, `tool(run, name, args)`)
- Modify: `packages/core/src/server/app.ts:375-390` (construct after `turns`), `packages/core/src/creatives/cache-sweep.ts` (sweep `.studio/cache/analysis/<sha>/` older than `DERIVED_CACHE_MAX_AGE_MS`)

**Interfaces:**
- Consumes: Tasks 1–5; `JobQueue`, `AgentLauncher`, `MediaTools`, `GitService.commitAll`, `assertAgentFolders`.
- Produces `class VideoAnalysisService`:
  - `constructor(deps: { queue; launcher; media: MediaTools; ffExec?: CommandExec; git; broadcast(m: ServerMessage): void; model(): Promise<string | null | undefined>; transcriber?: Transcriber /*Phase 2*/ })`.
  - `type ProjectRef` = the brand/brief `ProjectRef` (`root, projectSlug, projectDir`).
  - `ensure(ref, files: string[], o?: { from: 'brief' | 'library'; overwrite?: boolean }): Promise<VideoAnalysisView[]>` — for each `assets/…` video (`assetKindOf === 'video'`, others ignored): hash; fresh sidecar → `ready`; stale and `edited` with no `overwrite` → `stale`, nothing queued (decision 1494); otherwise queue unless a job with the same sha is active (dedup). Over `LONG_VIDEO_SEC` and no density chosen → enqueue with `hold: 'video-long'` and `pending: { kind: 'long', … }` from `planFrames` counts × `TOKENS_PER_FRAME`.
  - `confirmLong(ref, file, density: 'full' | 'reduced')` releases the hold (`queue.hold(id, null)`); `cancel(ref, file)`.
  - `view(ref, file): Promise<VideoAnalysisView>`; `list(ref): Promise<VideoAnalysisView[]>` (videos of the library).
  - `activeFor(ref, files): { file: string; jobId: string }[]` — analyses queued or running and **not held** (used by the wait, Task 9); `settled(jobId): Promise<void>`.
  - One analysis at a time per project: jobs share the queue lane `video-analysis:<root>:<slug>` (or the service starts the next job when one settles if `JobSpec` has no lane — the builder checks `job-queue.ts:172` lanes).
  - Run: probe (`media.probe`), `detectScenes`, `planFrames`, `extractFrames` into `<project>/.studio/cache/analysis/<sha>/`; if `audio`, `extractWav` into a temp dir (`core-temps.ts`) and `silenceRatio` → `none-no-speech` when ≥ 0.95, else `deps.transcriber?.transcribe(...)` or `none-skipped` (Phase 1); chunks of `CHUNK_FRAMES` (one chunk → pass `whole`; otherwise `chunk` runs then one `final` run); each run `launcher.start({ kind: 'video-analysis', readDirs: [framesDir], videoAnalysisScope, request: { prompt, model } })`, events broadcast as `agent`; a run that ends without a valid write fails the analysis (`errors.analysisNoWrite`); then re-hash: changed → no sidecar, `errors.analysisChanged`, queued again once; else `mergeTranscript`, `renderSidecar` (header: `generator: 'Motion Studio <version> · <model>'`, `createdAt` now, `edited: false`), `writeSidecar`, `git.commitAll(projectDir, t().videoAnalysis.commit({ file }))`, broadcast `video-analysis`. Temp files removed in `finally`; frames kept. Errors set state `error` with the message (never thrown into a creative).

- [ ] **Step 1: Write the failing tests** (`video-analysis.test.ts`, fixtures from Task 3 plus a 2-scene 8 s video; the chunked and long cases use an `ffExec` / `media.probe` stub returning 45 cuts or a 1300 s duration):
  - "a short video: one whole run, the sidecar is written and committed": `ensure` → job `kind: 'video-analysis'`; the run's `addDirs` = [frames dir], prompt lists `f-00000000.jpg`; the fake agent calls `write_video_analysis` with all fields, `finish()`; `assets/.analysis/clip.mp4.md` parses, header `sha256` = the file's, `transcript: 'none-no-speech'` for a silent track and `'none-skipped'` for the sine fixture; `git log -1` subject = `videoAnalysis.commit`; a `video-analysis` message with `state: 'ready'` was broadcast.
  - "same content twice: one job" — two `ensure` calls for the same file, or for a copy under another name, while the first is active → one job (dedup by sha); once it is ready, the copy's `ensure` queues its own run (each sidecar names its own asset).
  - "a fresh sidecar is not re-analysed"; "a changed file is re-analysed".
  - "45 frames: two chunk runs then a final run" — the second chunk's scope `from` is the 41st frame's time; the final prompt holds the merged timeline and no frame path.
  - "a chunk run without a write fails the analysis" → state `error`, `errors.analysisNoWrite`, no sidecar, temp wav removed.
  - "the video changes during the analysis: the sidecar is not written, the analysis is queued again".
  - "a long video waits for confirmation": `durationSec` 1300 (probe stub) → job `waitReason: 'video-long'`, view `pending.kind: 'long'` with `tokens = frames × 800`; `confirmLong('reduced')` → the run's frames follow the reduced plan.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/video-analysis.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the service, the wiring and the cache sweep.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): the video analysis queue and pipeline`.

### Task 7: Routes and the brief triggers

**Files:**
- Create: `packages/core/src/server/analysis-routes.ts`; Test: `packages/core/test/analysis-routes.test.ts`
- Modify: `packages/core/src/server/app.ts` (register), `server/creative-routes.ts:488` (after `store.create`), `creatives/creative-turns.ts:391,431,548,662` (`updateBrief`, `briefFromAgent`, `briefChange`, `applySharedBrief`: assets added), `brief/brief-session.ts:163,175,200,454` (`setContext`, `saveForm`, `send` `added.assets`, after `fill_brief`'s `store.update`)

**Interfaces:**
- Routes (404 unknown project / asset, 400 `errors.analysisNotVideo` for a non-video):
  - `GET /api/projects/:slug/video-analyses` → `VideoAnalysisView[]`
  - `GET /api/projects/:slug/video-analyses/view?file=assets/…` → `VideoAnalysisView`
  - `POST /api/projects/:slug/video-analyses` body `{ file, overwrite?: boolean }` → 202 view ("Analizza" / "Rianalizza"); an edited sidecar without `overwrite` → 409 `analysis-edited`.
  - `POST /api/projects/:slug/video-analyses/confirm-long` body `{ file, density: 'full'|'reduced' }` → view.
  - `PUT /api/projects/:slug/video-analyses/body` body `{ file, body: string ≤ 1 MiB }` → view (`replaceBody`, commit "Analisi video modificata: {file}", decision 1480 of the spec).
  - `DELETE /api/projects/:slug/video-analyses?file=` → cancels a queued/running analysis.
- Triggers call `analyses.ensure(ref, videoAssets, { from: 'brief' })` without awaiting the analysis (errors logged, never failing the brief call).

- [ ] **Step 1: Write the failing tests**: creating a creative whose brief holds `assets/clip.mp4` and `assets/logo.png` queues one analysis (the png is ignored); `PUT` of a brief adding a second video queues it, removing one queues nothing; a brief session `setContext` with a video queues it; `fill_brief` with a context video (already queued) creates no second job; `POST` on an edited sidecar → 409, with `overwrite: true` → 202; `PUT body` sets `edited: true` and keeps `sha256`; "a stale edited sidecar is not re-analysed automatically" (edit, change the file, create a creative with it → no job, view `stale`); `confirm-long` releases the held job.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/analysis-routes.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** routes and hooks.
- [ ] **Step 4: Run** it plus `brief-session.test.ts` and the creative-routes tests touched — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): videos entering a brief are analysed`.

### Task 8: The sidecar follows the asset; the creative agent cannot write it

**Files:**
- Modify: `packages/core/src/library/library-store.ts:164,253,318` (`renameAsset`, `recoverRenameUnlocked`, `removeAsset`), `library/rename-journal.ts:31` (journal gains `sidecar: boolean`), `creatives/creative-turns.ts:1328-1330` (`protectedDirs` + `join(projectDir, 'assets', '.analysis')`), and the same for `group-turn.ts` / `variant-directions.ts` launches that pass `protectedDirs`
- Test: `packages/core/test/library-rename.test.ts`, `packages/core/test/library-store.test.ts`, `packages/core/test/creative-turns.test.ts` (or the file holding the creative policy launch assertions)

**Interfaces:**
- Consumes: `moveSidecar`, `removeSidecar`, `sidecarPathOf` (Task 2); `VideoAnalysisService.cancel`.
- Behaviour: rename moves the sidecar in the same journaled step (recovery finishes or rolls back the move); delete removes the sidecar (frames stay in the cache until the sweep); a rename/delete cancels a running analysis of that file (decision 1495); the creative, group and directions launches deny Edit/Write and sandbox writes on `assets/.analysis` (spec 1485).

- [ ] **Step 1: Write the failing tests**: rename `clip.mp4` → `intro.mp4` moves the sidecar, its header `asset: 'assets/intro.mp4'`; a crash after the asset move (journal left) is recovered with the sidecar moved; delete removes the sidecar; "rename during a running analysis" → the job is cancelled and no sidecar is written under either name; a creative launch's `disallowedTools` contain `Edit(/<project>/assets/.analysis/**)` (match the existing `dirDenyRules` spelling) and the sandbox `denyWrite` the folder.
- [ ] **Step 2: Run** the three files — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): analysis files follow their video and are read-only for the creative agent`.

### Task 9: Prompt lines and the first-turn wait with "Salta"

**Files:**
- Modify: `packages/core/src/creatives/prompt.ts:638-645` (and `:834` where the same brief lines repeat), `brief/brief-prompt.ts:44-54`, `creatives/creative-turns.ts:354,839` (the first turn's run, before `launcher.start`), `creatives/group-turn.ts` and `creatives/variant-directions.ts` (their first runs), `server/creative-routes.ts` (skip route)
- Test: `packages/core/test/prompt.test.ts`, `packages/core/test/brief-prompt.test.ts`, `packages/core/test/analysis-wait.test.ts`

**Interfaces:**
- Produces:
  - `analysisRefs(ref, files): Promise<Record<string, string>>` on the service — asset → sidecar path, fresh ones only.
  - Prompt input gains `analyses?: Record<string, string>`; the line becomes `- Assets to use (project paths): assets/clip.mp4 (analysis: assets/.analysis/clip.mp4.md — read it before opening the video), assets/logo.png`, and when any analysis is listed one rule follows: `- Video analyses: read the analysis file first; open the video or extract frames only for what it does not answer (e.g. an exact frame to reuse). Its frames are in .studio/cache/analysis/; if missing, extract the frame yourself. An automatic transcript may misspell names.` `brief-prompt.ts` `## Attached assets` uses the same annotation.
  - `VideoAnalysisService.waitForBrief(ref, creativeSlug, files, signal): Promise<'done' | 'skipped'>` — waits for `activeFor` jobs (held jobs excluded); while waiting appends one system entry `{ level: 'info', text: videoAnalysis.waiting({ files }), analysisWait: { files } }` and broadcasts `analysis-wait`; on end broadcasts `files: []`; `skip(ref, creativeSlug)` resolves it with `'skipped'` and appends `videoAnalysis.skipped`. A failed analysis resolves the wait (the agent gets the plain path).
  - Route `POST /api/projects/:slug/creatives/:c/analysis-wait/skip` → 204 (404 when nothing waits); `GET …/analysis-wait` → `{ files: string[] }`.
  - The wait runs only for the creative's first job (version 1, first turn; for groups the first coordinator / directions run), after the job started (it shows as running), before the prompt is built (so the prompt sees the new sidecars).

- [ ] **Step 1: Write the failing tests**: `prompt.test.ts` first-turn line with one analysed video and one image exactly as above, rule present only when an analysis is listed; `brief-prompt.test.ts` the annotated attached asset; `analysis-wait.test.ts`: "the first turn waits and then reads the sidecar" (a running analysis → the turn's run not started, a system entry with `analysisWait.files = ['clip.mp4']`; the analysis finishes → the run starts and its prompt has the analysis line); "Salta starts the turn without the sidecar" (skip → run starts, prompt has the plain path, `skipped` line); "a held analysis does not hold the turn" (long video held → the run starts at once); "a failed analysis never blocks the turn"; "a second turn never waits".
- [ ] **Step 2: Run** the three files — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): agents read the video analysis; the first turn waits for it`.

### Task 10: Docs, decisions, Phase 1 verification

**Files:**
- Modify: `docs/agent-backends.md` (the `video-analysis` kind in the policy section), `docs/decisions-log.md`

- [ ] **Step 1:** Append decisions 1468–1490 exactly as the spec's §2 and §10 state them (Italian, the log's format, order by number), then 1491–1505 for this phase's choices (at least: tokens per frame 800, scene threshold 0.3, the `video-analysis` policy, stale edited sidecars wait for the user, rename/delete cancel a running analysis, reduced density rule, frame naming, front matter as JSON scalars without a YAML dependency, analyses held for confirmation never hold a turn).
- [ ] **Step 2: Run** the full suite once (`pnpm test` with `MS_REQUIRE_CHROME=1`), `pnpm -r typecheck`, `pnpm -s check:i18n`, the personal-data scan — Expected: all green.
- [ ] **Step 3: Commit** `docs: video analysis core, decisions 1468-1505`.

---

# Phase 2 — transcription (`feat/video-analysis-transcription`)

## File Structure (Phase 2)

- Modify `packages/shared/src/schemas.ts` (`appConfigSchema.transcription`), `video-analysis.ts` (pending `'transcription'`, choice and status types), `events.ts` (`JobWaitReason` + `'transcription-choice'`), `usage.ts` (`'transcription'` kind), i18n.
- Create `packages/core/src/transcription/`: `child-run.ts` (cancellable spawn), `engines.ts` (runners + parsers), `detect.ts` (auto-detect, lookup order, test-run), `models.ts` (manifest, install/remove), `openai-stt.ts`, `elevenlabs-stt.ts`, `pricing.ts`, `transcriber.ts` (method resolution + run); `packages/core/src/server/transcription-routes.ts`; test fixtures under `packages/core/test/fixtures/whisper/`.
- Modify `render/cft-download.ts` (extract the shared streaming download), `app-config.ts`, `analysis/video-analysis.ts`, `server/app.ts`, `server/main.ts` (`StartServerOptions.whisperDir`), `docs/providers.md`.

### Task 11: Settings, types and copy

**Files:**
- Modify: `packages/shared/src/schemas.ts` (`appConfigSchema`), `packages/shared/src/video-analysis.ts`, `events.ts`, `usage.ts`, i18n; `packages/core/src/app-config.ts`
- Test: `packages/shared/test/video-analysis.test.ts`, `packages/core/test/app-config.test.ts`

**Interfaces:**
- Produces:
  - `transcriptionSettingsSchema = { method: enum['ask','whisper','openai','elevenlabs','never'] default 'ask'; model: enum['small','large-v3-turbo'] default 'small'; custom: { program: string (absolute); engine: WhisperEngine; modelFile?: string (absolute) } | null default null }`; `type WhisperEngine = 'whisper.cpp' | 'openai-whisper' | 'faster-whisper'`. App-wide (§6): stored in `config.json` through `AppConfigStore.setTranscription(patch)`; older files parse with the defaults.
  - `VideoAnalysisPending` + `{ kind: 'transcription'; audioSec: number; whisper: { available: boolean /*engine found*/; installed: boolean /*model present*/; sizeBytes: number; canInstall: boolean /*bundled binary*/ }; openai: { costUsd: number } | null; elevenlabs: { costUsd: number } | null }`.
  - `transcriptionChoiceSchema = { file: string; choice: enum['whisper','openai','elevenlabs','none']; remember: boolean; sizeBytes?: number /*consent for a model download*/ }`.
  - `interface WhisperFound { engine: WhisperEngine; program: string; version: string | null; model: string; gpu: boolean | null; source: 'settings' | 'bundled' | 'detected' }`; `interface TranscriptionStatus { settings; models: Array<{ id: 'small'|'large-v3-turbo'; sizeBytes; installed: boolean; bytesOnDisk: number }>; whisper: WhisperFound | null; detected: WhisperFound[]; download: { state: 'idle'|'running'|'done'|'failed'; bytes; total; error? }; providers: { openai: boolean; elevenlabs: boolean } }`.
  - `JobWaitReason` + `'transcription-choice'`; `usageKindSchema` + `'transcription'`.
  - i18n `transcription.*`: the dialog and settings copy of Global Constraints; `transcription.why` (it "Con la trascrizione l'agente sa cosa viene detto e quando: può citarlo o sincronizzare i testi."); `transcription.leavesMac` (it "L'audio lascia il Mac."); `transcription.pythonCache` (it "Questo Whisper scarica i modelli nella sua cartella al primo uso."); `transcription.noBundled` (how to install or point to one); `jobs.waitReasons['transcription-choice']`; errors `whisperNotFound`, `whisperProbeFailed({ detail })`, `whisperModelMissing`, `transcriptionFailed({ reason })`, `downloadSizeChanged`.
- [ ] **Step 1: Write the failing tests**: defaults `{ method: 'ask', model: 'small', custom: null }` from an old `config.json`; `setTranscription({ method: 'never' })` keeps `language`; a relative `custom.program` refused.
- [ ] **Step 2: Run** both files — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** + typecheck + i18n — Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): transcription settings and types`.

### Task 12: Engine runners and parsers

**Files:**
- Create: `packages/core/src/transcription/child-run.ts`, `packages/core/src/transcription/engines.ts`, fixtures `packages/core/test/fixtures/whisper/{whisper-cpp.json, openai-whisper.json, faster-whisper.json}`; Test: `packages/core/test/transcription-engines.test.ts`

**Interfaces:**
- Produces:
  - `runChild(cmd: string, args: string[], o: { timeoutMs: number; signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean }>` — `spawn` with `shell: false`, output capped at 10 MB, on timeout/abort kills only its own child PID (SIGTERM, SIGKILL after 3 s); never `pkill`.
  - `parseWhisperCpp(json): TranscriptSegment[]` (`transcription[].offsets.from/to` ms → s, text trimmed, empty dropped); `parseOpenAiWhisper(json)` (`segments[].start/end/text`, `language`); `parseFasterWhisper(json)` (the `whisper-ctranslate2` JSON, same shape; the builder records the fixture from the CLI's documented output); each returns `{ segments; language: string | null }`.
  - `whisperArgs(e: WhisperEngine, i: { program; wav; outDir; model: string /*file for whisper.cpp, name for Python*/; vadModel?: string; language: string | null }): string[]` — whisper.cpp: `-m <model> -f <wav> -oj -of <outDir>/out -np -sns` + `--vad --vad-model <vadModel>` when given + `-l <lang|auto>`; openai-whisper: `<wav> --model <name> --output_format json --output_dir <outDir>` + `--language` when set; faster-whisper (`whisper-ctranslate2`): same flags.
  - `runWhisper(found: WhisperFound & { vadModel?: string }, wav, o: { language; signal; timeoutMs }): Promise<{ segments; language }>` — temp `outDir`, `runChild`, parse the engine's JSON file, clean up.
  - Python model names (spec 1490): `small` → `small`, `large-v3-turbo` → `large-v3-turbo` (the builder checks `turbo` vs `large-v3-turbo` per CLI and maps).

- [ ] **Step 1: Write the failing tests**: each parser on its fixture → the expected first segment (from/to/text) and count; `whisperArgs` exact arrays for the three engines; `runWhisper` against a **fake engine script** (a temp executable `#!/usr/bin/env node` that copies the fixture to the `-of`/`--output_dir` path) → segments; a fake that sleeps → `timeoutMs: 200` gives `timedOut` and the child PID is gone; abort → `cancelled`. No real whisper binary is ever run (decision 1506; resolves spec §12 "PATH binary in tests").
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/transcription-engines.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): whisper.cpp, openai-whisper and faster-whisper runners`.

### Task 13: Finding a Whisper and the test-run

**Files:**
- Create: `packages/core/src/transcription/detect.ts`; Test: `packages/core/test/transcription-detect.test.ts`
- Modify: `packages/core/src/server/main.ts` (`StartServerOptions.whisperDir?: string`, passed to `buildServer` deps)

**Interfaces:**
- Produces:
  - `WHISPER_NAMES: Record<WhisperEngine, string[]>` = whisper.cpp `['whisper-cli','whisper-cpp','main']` (`main` only if `--help` mentions whisper), openai-whisper `['whisper']`, faster-whisper `['whisper-ctranslate2','faster-whisper']`.
  - `detectWhispers(o: { pathEnv: string /*LoginShellPath.path*/; extraDirs?: string[] /*default ['/opt/homebrew/bin','/usr/local/bin']*/; probe: (program, engine) => Promise<WhisperFound | null> }): Promise<WhisperFound[]>`.
  - `probeWhisper(program, engine, o: { modelFile?; modelName; vadModel?; signal? }): Promise<WhisperFound | { problem: string }>` — runs the engine on one second of audio generated with `silentAudioInput` into a temp wav; version from `--version`/`--help` output; `gpu` from whisper.cpp stderr (`use gpu = 1` / `ggml_metal_init`), null for Python.
  - `resolveWhisper(o: { settings: TranscriptionSettings; whisperDir?: string /*bundled*/; appDataDir: string; detected: () => Promise<WhisperFound[]> }): Promise<(WhisperFound & { vadModel?: string; modelFile?: string }) | null>` — lookup order (§7): settings path → bundled `<whisperDir>/whisper-cli` with `<appDataDir>/whisper/ggml-<model>.bin` (+ bundled `ggml-silero-v6.2.0.bin`) → detected; a whisper.cpp without a model file present counts as not available.
- [ ] **Step 1: Write the failing tests** (fake executables in temp dirs, never real ones): a fake `whisper-cli` on a temp PATH and a fake `whisper` in an extra dir are both found with their engines; a `main` not mentioning whisper is ignored; `probeWhisper` on a fake that prints `use gpu = 1` → `gpu: true`, on a fake exiting 1 → `{ problem }` with its stderr's last line; `resolveWhisper` order: settings custom wins over bundled; bundled without the model file → falls to detected; nothing → null.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): find an installed Whisper and test-run it`.

### Task 14: Model download with sha256

**Files:**
- Create: `packages/core/src/transcription/models.ts`; Test: `packages/core/test/whisper-models.test.ts`
- Modify: `packages/core/src/render/cft-download.ts:121-172` (extract `streamDownload(o: { url; expectedBytes; maxBytes; dest; fetchImpl; signal; onProgress; sha256?: string; allowRedirectHosts?: string[] }): Promise<void>` used by `installCft` unchanged in behaviour), `packages/core/test/render-cft.test.ts` (stays green)

**Interfaces:**
- Produces:
  - `WHISPER_MODELS` manifest (hardcoded): `small`, `large-v3-turbo`, `silero` with the Global Constraints sizes and hashes and URLs `https://huggingface.co/ggerganov/whisper.cpp/resolve/<commit>/ggml-….bin` (silero: `https://huggingface.co/ggml-org/whisper-vad/resolve/<commit>/ggml-silero-v6.2.0.bin`) pinned to commit hashes the builder looks up and re-verifies (decision 1507).
  - `streamDownload` adds: streaming sha256 compared before the rename (mismatch → `CftError('sizeMismatch')`-like `'hashMismatch'` and the staging file removed); redirects followed manually only to `https:` hosts in `allowRedirectHosts`, at most 3 hops (Hugging Face `resolve` answers 302 to its CDN; `installCft` keeps `redirect: 'error'`). Allowed hosts: `huggingface.co`, `cdn-lfs.hf.co`, `cdn-lfs-us-1.hf.co`, `cas-bridge.xethub.hf.co` (decision 1508).
  - `installWhisperModel(o: { id; appDataDir; consent: true; sizeBytes: number; fetchImpl?; signal?; onProgress?; manifest?: typeof WHISPER_MODELS /*tests*/ })` → `<appDataDir>/whisper/ggml-<id>.bin` (folder 0700, file 0600); `sizeBytes` must equal the manifest's (409 `download-size-changed`); `removeWhisperModel(id, appDataDir)`; `installedModels(appDataDir)`.
- [ ] **Step 1: Write the failing tests** (loopback `node:http` server + `guardedFetch` as `render-cft.test.ts`, a 64 KB fake model and a test manifest): installs with progress and the right file mode; wrong hash → no file left, error `hashMismatch`; a 302 to a host not allowed → refused; a 302 to an allowed test host alias → followed; `consent` missing → `consentRequired`; size mismatch → refused; remove deletes it; `render-cft.test.ts` unchanged and green.
- [ ] **Step 2: Run** both files — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): Whisper models downloaded with consent and a sha256 check`.

### Task 15: OpenAI and ElevenLabs transcription, pricing, usage

**Files:**
- Create: `packages/core/src/transcription/openai-stt.ts`, `elevenlabs-stt.ts`, `pricing.ts`; Test: `packages/core/test/transcription-providers.test.ts`
- Modify: `packages/core/src/usage/usage-ledger.ts` (nothing if `append` takes the record), `docs/providers.md` (a "Transcription" section)

**Interfaces:**
- Produces:
  - `STT_PRICES_USD_PER_MIN = { openai: { model: 'whisper-1', usdPerMin: 0.006 }, elevenlabs: { model: 'scribe_v1', usdPerMin: <list price> } }` (the builder confirms model ids, segment-timestamp support and list prices at build time and records them, decision 1509); `estimateSttCost(provider, audioSec): number` (rounded up to whole minutes as billed).
  - `openaiTranscribe(deps: HttpDeps & { apiKey }, wav: string, o: { language: string | null; signal }): Promise<{ segments; language }>` — `POST https://api.openai.com/v1/audio/transcriptions` multipart (`model`, `response_format=verbose_json`, `timestamp_granularities[]=segment`, `language` when set), via `requestJson` with `secrets: [apiKey]`; audio over 600 s is cut into 600 s 16 kHz mono WAV pieces (≈ 19.2 MB, under the 25 MB limit) and segment times are offset (decision 1510).
  - `elevenlabsTranscribe(deps, wav, o)` — `POST https://api.elevenlabs.io/v1/speech-to-text` multipart (`model_id`, `file`, `language_code` when set, `timestamps_granularity=word`), header `xi-api-key`; words grouped into segments at sentence punctuation or gaps ≥ 0.8 s.
  - `recordTranscriptionUsage(ledger, projectDir, i: { jobId; provider; model; audioSec; costUsd })` — one `usage.jsonl` line `kind: 'transcription'`, zero tokens, `costUsd`, `models: [{ model, tokens: zeros, costUsd }]`, `outcome`.
- [ ] **Step 1: Write the failing tests** (fake `fetch` capturing the request; never the network): OpenAI request URL, `Authorization: Bearer k`, form fields; verbose_json fixture → segments; a 1300 s wav (generated `anullsrc`) → three requests and the third's segments offset by 1200; ElevenLabs words fixture → two segments split at a 1 s gap; a 401 error message never contains the key; `estimateSttCost('openai', 61) === 0.012`; the usage line parses with `usageRecordSchema`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): transcription with OpenAI and ElevenLabs, cost and usage`.

### Task 16: Method resolution, the dialog API and the settings routes

**Files:**
- Create: `packages/core/src/transcription/transcriber.ts`, `packages/core/src/server/transcription-routes.ts`; Test: `packages/core/test/transcription-flow.test.ts`
- Modify: `packages/core/src/analysis/video-analysis.ts` (pre-flight before enqueue), `server/app.ts`, `server/analysis-routes.ts`

**Interfaces:**
- Produces:
  - `interface Transcriber { plan(audioSec): Promise<{ run: TranscribeMethod } | { ask: VideoAnalysisPending & { kind: 'transcription' } } | { skip: true }>; transcribe(m: TranscribeMethod, wav, o: { jobId; projectDir; language; signal }): Promise<{ segments; language; kind: TranscriptKind }> }`; `type TranscribeMethod = 'whisper' | 'openai' | 'elevenlabs'`.
  - Resolution (§6): `never` → skip; `whisper` / `openai` / `elevenlabs` available (engine resolved and model present / key saved in the vault) → run; `ask` or the saved method unavailable → ask. Language: auto-detect, app language as fallback when the engine reports none (decision 1511; spec 1484 reads "app language, auto-detect fallback": the orchestrator confirms the reading with the user before Phase 2).
  - Pre-flight in `ensure`: probe `hasAudio`; with audio, `extractWav` + `silenceRatio` happen before enqueue (cheap); no speech → no ask; ask → enqueue with `hold: 'transcription-choice'` and `pending` of kind `transcription` (one dialog per analysis).
  - `POST /api/projects/:slug/video-analyses/transcription-choice` body `transcriptionChoiceSchema` → view: `whisper` with the model missing requires `sizeBytes` = manifest size (else 409) and starts the download, the hold is released when it ends (failed download → hold stays, view `error` message, dialog again); `openai`/`elevenlabs` only with a saved key (else 409); `none` → `none-skipped`; `remember: true` writes `method` (`none` → `never`).
  - `GET /api/transcription` → `TranscriptionStatus`; `PUT /api/transcription` body partial settings — a `custom` program is test-run (`probeWhisper`) first and refused 400 with the problem when it fails; `POST /api/transcription/probe` body `{ program, engine?, modelFile? }` → `WhisperFound | { problem }`; `POST /api/transcription/models/:id/download` body `{ consent: true, sizeBytes }` → 202 (one download at a time, progress in the GET); `DELETE /api/transcription/models/:id` → 204.
  - Paid methods run only after the choice click or a saved method (no broker card); their cost goes to `recordTranscriptionUsage`.
- [ ] **Step 1: Write the failing tests** (fake Whisper script through settings `custom`, fake fetch, `MemoryVault`): `ask` with no engine and an OpenAI key → held job, view `pending.openai.costUsd` = estimate, `elevenlabs: null`, `whisper.canInstall: false` (no bundled dir); choice `openai` → the fake fetch got one request, sidecar `transcript: 'openai'`, a `transcription` usage line; choice `none` + remember → settings `never`, sidecar `none-skipped`, the next video is not held; settings `whisper` with the fake engine → no hold, sidecar `transcript: 'whisper-small'` and the timeline holds a speech line; a saved `elevenlabs` method with the key deleted → asks; silent track → `none-no-speech`, never asks; `PUT` custom with a failing fake → 400 naming the problem; model download route with a wrong `sizeBytes` → 409.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** it and `video-analysis.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): transcription choice, settings and routes`.

### Task 17: Docs, decisions, Phase 2 verification

- [ ] **Step 1:** `docs/providers.md` Transcription section (endpoints, prices, what leaves the Mac); decisions 1506–1520 (fake engines only in tests; pinned HF commits; CDN redirect allowlist; model ids and prices; 600 s WAV chunks; language auto-detect with app-language fallback; app-wide settings in `config.json`; costs shown in USD like the rest of the app; pre-flight before enqueue; download failure keeps the dialog).
- [ ] **Step 2: Run** the full suite once, typecheck, i18n, personal-data scan — Expected: green.
- [ ] **Step 3: Commit** `docs: transcription, decisions 1506-1520`.

---

# Phase 3 — UI, CI build and packaging (`feat/video-analysis-ui`)

## File Structure (Phase 3)

- Web: `packages/web/src/api.ts` (calls), `packages/web/src/state/useVideoAnalyses.ts` (live views from `video-analysis` / `analysis-wait` messages via `eventsReducer.ts`), `screens/assets/AnalysisSection.tsx` (+ `analysis.css`), `screens/assets/AssetDetail.tsx`, `screens/Assets.tsx` (`AssetCard` mark), `components/TranscriptionDialog.tsx`, `components/LongVideoDialog.tsx`, `components/TranscriptionCard.tsx` (brief chat), `screens/NewCreative.tsx`, `screens/new-creative/BriefSessionPanel.tsx`, `components/Conversation.tsx` (wait line), `screens/AppSettings.tsx` + `routes.ts` (`'transcription'` section), `shell/ActivityCenter.tsx`.
- Packaging: `.github/workflows/release.yml` (job `whisper`), `.github/workflows/ci.yml` (nothing unless the build script gets a test), `scripts/build-whisper.sh`, `apps/desktop/scripts/prepare-resources.mjs` (replaces the inline `prepare-resources` script), `apps/desktop/electron-builder.yml`, `apps/desktop/src/main.ts` (`resourcePaths().whisperDir`), `apps/desktop/THIRD_PARTY_NOTICES.md` (new, whisper.cpp MIT licence).

### Task 18: Web data layer

**Files:**
- Modify: `packages/web/src/api.ts`, `packages/web/src/state/eventsReducer.ts`; Create: `packages/web/src/state/useVideoAnalyses.ts`; Test: `packages/web/test/video-analyses-state.test.ts`

**Interfaces:**
- Produces: `api.listVideoAnalyses(slug)`, `api.videoAnalysis(slug, file)`, `api.analyzeVideo(slug, file, overwrite?)`, `api.confirmLongVideo(slug, file, density)`, `api.saveAnalysisBody(slug, file, body)`, `api.cancelVideoAnalysis(slug, file)`, `api.transcriptionChoice(slug, body)`, `api.skipAnalysisWait(slug, creative)`, `api.analysisWait(slug, creative)`, `api.getTranscription()`, `api.saveTranscription(patch)`, `api.probeWhisper(body)`, `api.downloadWhisperModel(id, sizeBytes)`, `api.removeWhisperModel(id)`; `useVideoAnalyses(slug): { byFile: Record<string, VideoAnalysisView>; pending: VideoAnalysisView[] /*with pending*/ }`; `useAnalysisWait(slug, creative): string[]`.
- [ ] **Step 1: Write the failing test**: the reducer applies a `video-analysis` message over the listed view; `analysis-wait` with `files: []` clears the wait.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(web): video analysis data and live state`.

### Task 19: Library "Analisi" section and the tile mark

**Files:**
- Create: `packages/web/src/screens/assets/AnalysisSection.tsx`, `analysis.css`; Modify: `screens/assets/AssetDetail.tsx` (videos only, under the player), `screens/Assets.tsx:423` (`AssetCard`), `ui/VideoPlayer.tsx` (an imperative `seek(sec)` through a ref, if it has none)
- Test: `packages/web/test/analysis-section.test.tsx`, layout `packages/web/test/analysis-section-layout.test.tsx`

**Interfaces / behaviour (§9):** state pill from `videoAnalysis.states`; Pronta shows Summary, the timeline rows `[mm:ss–mm:ss] onScreen` with on-screen text and speech (click → `seek(from)`), the transcript (click → seek), tags — parsed from `body` by the section headings, with the raw body shown when parsing finds no `## Timeline` (an edited file); buttons **Analizza** (none/error/stale), **Rianalizza** (ready; an `edited` sidecar opens a confirm "L'analisi è stata modificata: sovrascriverla?" before `overwrite: true`), **Modifica** (textarea of the body, Save → `saveAnalysisBody`); a pending item shows its dialog button (Task 20). `AssetCard`: a small "analizzato" mark (icon + `aria-label`) when `ready`. Motion only via tokens; no literal colours.
- [ ] **Step 1: Write the failing tests**: jsdom — ready view renders summary and a timeline row; clicking it calls `seek(12)`; Rianalizza on an edited view asks first and then calls `analyzeVideo(slug, file, true)`; Modifica saves the edited text; the tile shows the mark only for `ready`. Chrome layout at 1024 × 700 and 1440 × 900, light and dark: the section fits the details column with no horizontal scroll, timeline rows do not overflow with a 300-character on-screen text.
- [ ] **Step 2: Run** both — FAIL. **Step 3: Implement.** **Step 4: Run** (`MS_REQUIRE_CHROME=1`) — PASS.
- [ ] **Step 5: Commit** `feat(web): the video analysis in the library`.

### Task 20: The transcription dialog, the long-video dialog, the brief chat card

**Files:**
- Create: `packages/web/src/components/TranscriptionDialog.tsx`, `LongVideoDialog.tsx`, `TranscriptionCard.tsx` (shared body `TranscriptionChoices`); Modify: `screens/NewCreative.tsx`, `screens/new-creative/BriefSessionPanel.tsx`, `screens/assets/AnalysisSection.tsx`
- Test: `packages/web/test/transcription-dialog.test.tsx`, layout `packages/web/test/transcription-dialog-layout.test.tsx`

**Behaviour (§6, §5.1):** `TranscriptionChoices` lists, in order: "Installa Whisper (gratis, sul tuo Mac) · {size}" (only `whisper.canInstall` or `available`; size formatted from `sizeBytes`, hidden when installed), "Trascrivi con OpenAI · ~{cost}" / "… ElevenLabs · ~{cost}" (only non-null, cost formatted as the app formats USD in `shell/Tokens.tsx`, with `transcription.leavesMac`), "Continua senza trascrizione", the "Ricorda la scelta" checkbox, `transcription.why` text, `transcription.noBundled` when nothing local is possible; Install shows a `ProgressBar` from the status poll until the hold is released. `TranscriptionDialog` = `Modal` around it; shown in NewCreative (form) for pending analyses of its brief's videos and from the library section; in the brief agent panel the same body renders as a `TranscriptionCard` in the conversation (spec 1479), never a modal. `LongVideoDialog`: frames and estimated tokens for both densities, "Analizza tutto" / "Analizza a densità ridotta".
- [ ] **Step 1: Write the failing tests**: no keys and no bundled Whisper → only "Continua senza trascrizione" and the explanation; OpenAI key → the OpenAI line with the cost and the leaves-the-Mac text, a click posts `{ choice: 'openai', remember: false }`; Install posts `sizeBytes`; remember ticked is sent; the brief panel renders a card, not a modal; LongVideoDialog posts `reduced`. Chrome layout: the dialog at 1024 × 700 fits without scroll; the card fits the 448 px panel.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(web): transcription and long-video choices`.

### Task 21: The wait line with "Salta" and the activity centre

**Files:**
- Modify: `packages/web/src/components/Conversation.tsx:198,478-514,823` (system item gains `analysisWait`), `shell/ActivityCenter.tsx:75` (`video-analysis` → Assets, with the file selected), `labels.ts`
- Test: `packages/web/test/conversation-analysis-wait.test.tsx`

**Behaviour:** a system entry with `analysisWait` renders "Analisi del video in corso (clip.mp4)… · Salta" with **Salta** as a link-button only while `useAnalysisWait` lists files; Salta calls `skipAnalysisWait`; afterwards the line stays as plain text. Activity rows for `video-analysis` jobs show the file and their wait reason labels.
- [ ] **Step 1: Write the failing test**: waiting → Salta visible and calls the API; wait over → no Salta; the activity link targets the Assets screen.
- [ ] **Step 2–4:** run FAIL, implement, run PASS.
- [ ] **Step 5: Commit** `feat(web): the creative waits for its video analyses, with Salta`.

### Task 22: Settings → Trascrizione video

**Files:**
- Modify: `packages/web/src/routes.ts:3-4` (`SettingsSection` + `'transcription'`), `screens/AppSettings.tsx:80` (section switch), create `screens/settings/TranscriptionSettings.tsx`
- Test: `packages/web/test/transcription-settings.test.tsx`, layout `packages/web/test/transcription-settings-layout.test.tsx`

**Behaviour (§6, §7):** method radio (the five labels); model Small / Large v3 Turbo each with installed state, size on disk, **Installa** (with size, the `RenderEngine` consent → progress pattern of `AppSettings.tsx:217`) and **Rimuovi**; the explanation; "Usa un Whisper già installato": the found/detected list, "Scegli…" for the program (and for whisper.cpp the model file) through the desktop file picker the app already uses (fallback: a path field in the browser), test-run on save showing "Whisper trovato: …" or the problem, and `transcription.pythonCache` for Python engines.
- [ ] **Step 1: Write the failing tests**: switching to OpenAI saves `{ method: 'openai' }`; Installa posts the manifest size and shows progress; a failing probe shows its problem and saves nothing. Chrome layout at 1024 × 700, light and dark.
- [ ] **Step 2–4:** run FAIL, implement, run PASS.
- [ ] **Step 5: Commit** `feat(web): the transcription settings`.

### Task 23: whisper-cli in CI and in the desktop app; docs; Phase 3 verification

**Files:**
- Create: `scripts/build-whisper.sh`, `apps/desktop/scripts/prepare-resources.mjs`, `apps/desktop/THIRD_PARTY_NOTICES.md`; Modify: `.github/workflows/release.yml` (job `desktop`), `apps/desktop/package.json` (`prepare-resources` → the script), `apps/desktop/electron-builder.yml`, `apps/desktop/src/main.ts:50-71`, `packages/core/src/server/main.ts` (`whisperDir`); Test: `apps/desktop/test/electron-paths.test.ts`, `apps/desktop/test/prepare-resources.test.ts`

**Interfaces / behaviour:**
- `scripts/build-whisper.sh <arch> <outDir>`: clones whisper.cpp at tag `v1.9.5` (verifying the tag's commit hash recorded in the script), `cmake -B build -DGGML_METAL_EMBED_LIBRARY=ON -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DCMAKE_OSX_ARCHITECTURES=<arm64|x86_64> -DCMAKE_BUILD_TYPE=Release`, builds `whisper-cli`, checks `otool -L` shows only system libraries, downloads `ggml-silero-v6.2.0.bin` and checks its sha256, copies both plus whisper.cpp's `LICENSE` into `<outDir>/<arch>/`.
- `release.yml` job `desktop`, macOS leg only: a step before "Package and publish draft release" runs the script for `arm64` and `x64` into `apps/desktop/vendor/whisper/` (cached by tag); Windows/Linux legs skip it (spec 1483).
- `prepare-resources.mjs`: does what the inline script did, plus copies `vendor/whisper/<arch>` to `resources/whisper/<arch>` when present (missing → no folder, the app falls back to installed Whispers).
- `electron-builder.yml` `mac.extraResources: [{ from: resources/whisper/${arch}, to: whisper }]` (signed and notarized with the app); `resourcePaths()` returns `whisperDir: join(process.resourcesPath, 'whisper')` when packaged, and in dev `apps/desktop/vendor/whisper/<process.arch>` when it exists; passed as `startServer({ whisperDir })`.
- Notices: whisper.cpp MIT licence text and the Silero VAD model licence.
- [ ] **Step 1: Write the failing tests**: `electron-paths.test.ts` packaged → `whisperDir` under `resourcesPath`; `prepare-resources.test.ts` (temp tree) copies `vendor/whisper/arm64` when present and succeeds without it.
- [ ] **Step 2: Run** `pnpm --filter motion-studio-desktop vitest run test/electron-paths.test.ts test/prepare-resources.test.ts` — FAIL.
- [ ] **Step 3: Implement**; check `release.yml` with `actionlint` if available, else by reading.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5:** decisions 1521–1535 (contact-sheet choice "single images", the wait line, dialogs placement, settings section, CI layout, notices); `docs/agent-backends.md` / `docs/providers.md` touch-ups; full suite once with `MS_REQUIRE_CHROME=1`, typecheck, i18n, personal-data scan.
- [ ] **Step 6: Commit** `build: whisper-cli built in CI and shipped with the macOS app` and `docs: video analysis UI, decisions 1521-1535`.
