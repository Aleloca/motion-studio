# Video analysis for the agent (user request of 2026-10-21)

Status: design, awaiting the user's approval; not built. Decisions: 1468–1490 in `docs/decisions-log.md`.
Inspiration: CDAF, "Cached Descriptive Asset Files" (https://github.com/UditAkhourii/cdaf, MIT). We take its ideas, not
its tool nor, strictly, its format (§4).

## 1. Why

Reference assets can be videos (a product demo, a screen recording, an old ad, a talking head). Today the agent gets only the
video's path. The library knows only its duration and size; "Descrivi con l'agente" writes 1–2 sentences without extracting
frames, and nothing transcribes speech. So the agent either works blind or re-watches the file on every turn, spending tokens
each time and still missing what is said.

Goal: analyse a video **once**, store a clear text description of its content next to it, and have every agent that works
with that video read the description instead of the footage.

## 2. The user's calls

| # | Call |
|---|---|
| 1468 | Take CDAF's idea (a text sidecar with hash, summary, timed segments, transcript, on-screen text, tags), not its tool: CDAF sends videos to Google Gemini with its own key and needs Python. The analysis runs in the app, with Claude Code for vision. |
| 1469 | A video is analysed when it **enters a brief** (not on upload, not only on demand): only the videos actually used get a sidecar. |
| 1470 | Speech is transcribed with **Whisper on the Mac** (whisper.cpp). Model chosen in Settings: **Small** by default (~490 MB), **Large v3 Turbo** (~1.6 GB) as the precise option. |
| 1486 | Our own format, inspired by CDAF, improved for the agent (§4). |
| 1487 | No fixed frame cap: one per scene plus one every 10 s in static scenes; analysis in chunks of ~40 frames; videos over 20 min ask first. |
| 1488 | An already installed Whisper is found by itself (login-shell PATH, Homebrew folders) or pointed to in Settings, program and model; test-run before saving. |
| 1489 | The Python Whisper engines are supported too (openai-whisper, faster-whisper), beside whisper.cpp. |
| 1471 | Transcription is **never mandatory**. The rest of the analysis (scenes, frames, on-screen text, summary) always runs. When a video has an audio track and no transcription method is available, a dialog explains what transcription is for and offers: **Install Whisper** (free, local, shows the download size), **OpenAI** or **ElevenLabs** (paid, estimated cost shown, audio leaves the Mac; only providers with a saved key are offered), **Continue without transcription**. |

## 3. Goals, non-goals, anti-goals

**Goals**
- Each video in a brief has a sidecar the agent reads first: what is on screen scene by scene with times, what is said with
  times, on-screen text, a summary, tags.
- One analysis per video content: the sidecar carries the video's sha256; the same file is never analysed twice; a changed
  file is analysed again.
- Works for the creative agent (every turn, every variant) and the brief agent.
- The user sees the analysis in the library and can correct it.

**Non-goals**
- No analysis of images or audio-only assets (later, if asked).
- No bundled Whisper for Linux/Windows in this round (an installed one works there; §7).
- No speaker identification, no translation of the transcript.
- No MCP server or external CDAF tool integration.

**Anti-goals** (would make it a failure even if it works)
- Downloading anything, or spending money, without an explicit click that showed size or cost.
- Blocking a user who just wants to generate: the dialog always has "Continue without transcription", and a failed
  analysis never stops a creative.
- Sending video frames or audio anywhere except Claude Code (frames) and the transcription method the user chose (audio).

## 4. The analysis file (our format, CDAF-inspired)

The user's call 1486: since we do not use the CDAF tool, we are not bound to its format; we keep its ideas (hash for
freshness, summary, timed segments, transcript, on-screen text, tags) and improve where it helps the agent.

- **Where:** `assets/.analysis/<asset file name>.md` (e.g. `assets/.analysis/clip.mp4.md`). One hidden folder: no basename
  collisions, the asset grid stays clean, rename/delete follow the asset. Versioned with git. Read-only for the creative agent.
- **Shape:** YAML front matter written by the core (machine-readable), then a markdown body meant to be read top-down and
  stopped early:
  - front matter: `format: motion-studio-video-analysis/1`, `asset`, `sha256`, `bytes`, `durationSec`, `width`, `height`,
    `fps`, `hasAudio`, `transcript: whisper-small | whisper-large-v3-turbo | openai | elevenlabs | none-skipped | none-no-speech`,
    `language`, `generator`, `createdAt`, `edited: false`.
  - `## Summary` — 3–5 lines: what the video is, its style, what it is good for in a creative.
  - `## Timeline` — **one** timeline instead of separate segment and transcript lists: each scene `[00:12–00:18]` with what is
    on screen, the on-screen text in it, and the speech said during it (quoted, with its own times when a scene holds several
    sentences). This is what the agent needs to cut, quote or sync texts without cross-referencing two lists.
  - `## Usable moments` — clips worth reusing in a motion graphic (logo reveal, clean product shot, a strong quote) with
    exact in/out times and why. New, not in CDAF.
  - `## Look` — dominant colours (hex), typography seen, framing (screen recording, talking head, b-roll…), audio character
    (voice, music, silence).
  - `## Transcript` — the full transcript with times, kept for search and quoting; marked automatic.
  - `## Tags`.
- **Key frames:** the frames used for the analysis are kept as a cache in `.studio/cache/analysis/<sha>/` (not versioned,
  regenerable), named by timestamp, and the timeline references them, so the agent can look at an exact frame without running
  ffmpeg. Missing cache → the agent extracts the frame itself as today.
- **Freshness:** valid while `sha256` matches the video; stale files are replaced on the next analysis (an `edited` one asks
  first, §9).

## 5. The analysis pipeline

When a video enters a brief (brief editor, "Nuova creatività" form, the brief agent's `fill_brief`, adding an asset to an
existing creative's brief), the core queues an analysis for it unless a fresh sidecar exists. One queue per project, one
video at a time, deduplicated by sha256.

1. **Frames (no agent).** No fixed cap (the user's call 1487): ffmpeg scene detection picks the cuts, one frame per scene,
   plus one every 10 s inside long static scenes (a screen recording that barely changes still gets frames), scaled to
   768 px on the long side, into `.studio/cache/analysis/<sha>/` named by timestamp. A video with no detectable cuts gets one
   frame every 10 s. Videos over 20 minutes ask first (frames and estimated tokens, "Analizza tutto" / "Analizza a densità
   ridotta" = one frame per scene, at most one every 30 s).
2. **Audio (no agent).** If the video has an audio stream: `ffmpeg -nostdin -i in -vn -map 0:a:0 -ac 1 -ar 16000 -c:a
   pcm_s16le -f wav out.wav`. Silence-only audio (ffmpeg `silencedetect` covering ≥ 95%) counts as "no speech" and skips
   transcription and the dialog.
3. **Transcript (no agent)**, with the method resolved in §6: whisper.cpp with built-in Silero VAD and `-sns`, JSON segments;
   or the provider's API with segment timestamps. Language: the project/app language, with auto-detect as fallback.
4. **Description (agent), in chunks.** Frames go to the agent in chunks of about 40 (with their timestamps and the
   transcript of that span); each chunk writes its part of the timeline; a last pass writes Summary, Usable moments, Look and
   Tags over the whole timeline. A short video is one chunk plus nothing else. A new job kind `video-analysis`: read-only, no network, no Bash, sees only the frames (with their
   timestamps), the transcript and the video's metadata. It writes the body sections through one MCP tool
   `write_video_analysis` (structured: summary, timeline[{from,to,onScreen,onScreenText,frame}], usableMoments[{from,to,why}],
   look{colours,typography,framing,audio}, tags; the core merges the transcript into the timeline by time). The core
   writes the sidecar (header computed by the core, never by the agent). Its usage goes to `usage.jsonl` like the other jobs.
5. Temp files are deleted after the sidecar is written or the job fails.

**Generate while an analysis is running:** the creative's first turn waits for the analyses of its brief's videos, with a
line in the chat "Analisi del video in corso (clip.mp4)… · Salta". "Salta" starts the turn without that sidecar (orchestrator's
call 1478). A failed analysis is shown on the asset and never blocks the turn; the agent then gets the plain path as today.

## 6. Transcription method

Setting **Impostazioni → Trascrizione video** (app-wide):
- Method: **Chiedi ogni volta** (default) · **Whisper sul Mac** · **OpenAI** · **ElevenLabs** · **Mai**.
- Whisper model: Small (default) · Large v3 Turbo. Shows installed / size on disk, **Installa** (with size), **Rimuovi**.
- A short explanation of what transcription gives the agent.

**The dialog** (when the method is "Chiedi ogni volta", or the chosen method is not available — Whisper removed, key deleted):
shown once per analysis that needs it, in the screen where the video entered the brief (the brief agent's chat shows it as a
card in the conversation, orchestrator's call 1479). Text: what transcription is for (the agent knows what is said and when,
can quote it or sync texts to it). Choices:
- **Installa Whisper (gratis, sul tuo Mac) · 488 MB** — the model of the setting; download with progress, then continues.
- **Trascrivi con OpenAI · ~0,0X €** / **Trascrivi con ElevenLabs · ~0,0X €** — only for providers with a saved key; the cost
  is estimated from the audio duration with the provider's list price (kept in the pricing table the TTS providers use);
  the line says the audio leaves the Mac.
- **Continua senza trascrizione**.
- Checkbox **Ricorda la scelta** → writes the method into the setting.

Paid transcription runs only after a click in this dialog or because the user saved that method in Settings. Its cost goes
to `usage.jsonl` like the other provider calls.

**Providers.** OpenAI: the current transcription model with segment timestamps (the builder checks the model id and its
timestamp support at build time); files over the API's upload limit are sent as compressed audio chunks with offsets.
ElevenLabs: Scribe (speech-to-text) with word/segment timestamps. Both reuse the existing key storage, `requestJson`, secret
redaction and the fake fetch in tests. No real calls in tests.

## 7. Whisper on the Mac

- **Binary:** `whisper-cli` from whisper.cpp pinned to v1.9.5 (MIT), built in our CI for darwin-arm64 and darwin-x64 with Metal
  embedded and static libs (`-DGGML_METAL_EMBED_LIBRARY=ON -DBUILD_SHARED_LIBS=OFF`), shipped in the desktop app's
  `extraResources` so it is signed and notarized with the app. The Silero VAD model (`ggml-silero-v6.2.0.bin`, 885 KB) ships
  with it. whisper.cpp's licence goes into the app's third-party notices.
- **An existing Whisper (the user's call 1488–1489):** the app finds one by itself, or the user points to it.
  - Auto-detect: whisper.cpp under its usual names (`whisper-cli`, older `whisper-cpp` / `main`) and the Python CLIs
    (`whisper` from openai-whisper, `faster-whisper` / `whisper-ctranslate2`), on the login-shell PATH the app already
    resolves (`LoginShellPath`) and in the Homebrew folders (`/opt/homebrew/bin`, `/usr/local/bin`).
  - Settings → Trascrizione video → **Usa un Whisper già installato**: "Scegli…" for the program and, for whisper.cpp, for a
    ggml model file the user already has (no re-download). Python engines use their own model names (small,
    large-v3-turbo…), picked from the same Small / Large v3 Turbo setting; they download models into their own cache, which
    the app says before the first run.
  - Before saving, the app test-runs it on one second of generated audio and shows "Whisper trovato: engine, version, model,
    Metal/GPU yes/no" or what is wrong. Works on macOS, Linux and Windows.
  - Each engine has its own runner and output parser (whisper.cpp JSON `transcription[].offsets`; openai-whisper
    `--output_format json` `segments[].start/end`; faster-whisper CLI JSON), all mapped to one segment list; tests use
    recorded output fixtures, never real models.
- **Lookup order:** the path set in Settings → the bundled binary → auto-detected. With none, "Installa Whisper" downloads the
  model for the bundled binary; where there is no bundled binary (dev app, npm CLI, Linux, Windows) the dialog explains how to
  install or point to one.
- **Models:** downloaded only from the dialog or Settings, after showing the size, into `<appData>/whisper/`, reusing the
  Chrome for Testing download flow (`render/cft-download.ts`: consent required, https only, no redirects, exact
  Content-Length, progress, staging then rename) **plus a streaming sha256 check** before the rename. Manifest hardcoded, URLs
  pinned to a Hugging Face commit, not `main`:
  - `ggml-small.bin` 487,601,967 B, sha256 `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`
  - `ggml-large-v3-turbo.bin` 1,624,555,275 B, sha256 `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69`
  - `ggml-silero-v6.2.0.bin` 885,098 B, sha256 `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987` (only if not
    bundled, e.g. PATH binary)
  The builder re-verifies sizes and hashes against the pinned revision.
- **Runs** in the core as a child process with a timeout, cancellable, never in the agent sandbox's reach; its own PID only.

## 8. What the agents get

- **Creative prompt**, line "Assets to use": each video with a fresh sidecar becomes `assets/clip.mp4 (analysis:
  assets/.analysis/clip.mp4.md — read it before opening the video)`. The prompt adds one rule: read the sidecar first; open the video or
  extract frames only for what the sidecar does not answer (e.g. an exact frame to reuse). A transcript marked automatic may
  contain errors in names.
- **Brief agent:** same line for videos in its context; analysis starts when the user adds a video to the session.
- **Variants and later turns** reuse the same sidecar (same hash).

## 9. Library UI

- A video asset's details get an **Analisi** section: state (Non analizzato · In corso · Pronta · Non aggiornata · Errore),
  the summary, the segments with times (click → seek the player), the transcript with times (click → seek), on-screen text,
  tags. Buttons: **Analizza** / **Rianalizza**, **Modifica** (edit the body as text; the header stays core-owned; an edited
  sidecar is marked `edited` and Rianalizza asks before overwriting it — orchestrator's call 1480).
- The asset tile shows a small "analizzato" mark.
- Analysis progress also appears in the activity centre.

## 10. Orchestrator's calls (for the user's review)

- 1476 Analysis files in `assets/.analysis/<file name>.md`; key frames cached unversioned.
- 1477 Frames at 768 px; chunks of ~40 frames; the 20-minute threshold; 10 s static interval.
- 1490 Python engines use the Small / Large v3 Turbo setting by model name and their own model cache.
- 1478 Generate waits for the brief's analyses with "Salta".
- 1479 In the brief agent the dialog is a card in the chat.
- 1480 The sidecar is editable; Rianalizza asks before overwriting an edited one.
- 1481 Analysis queue per project, one at a time, dedup by sha256.
- 1482 Silence-only audio skips transcription and the dialog.
- 1483 The bundled Whisper only on macOS in this round; an installed one works anywhere.
- 1484 Transcription language = app language, auto-detect fallback.
- 1485 The creative agent cannot write analysis files.

## 11. Left to the builder

Scene-detection threshold, the frame contact-sheet layout (single images vs a grid), the exact OpenAI transcription model id,
the chunk size for provider uploads, the CI job layout for the whisper binary, and copy wording within the i18n catalogs.

## 12. Phases

1. Core: sidecar format (read/write/validate/freshness), frames + audio extraction, `video-analysis` job and MCP tool, queue,
   triggers from briefs, prompt lines, rename/delete with the asset, "without transcription" path. Tests with the fake Claude
   CLI and ffmpeg fixtures.
2. Transcription: whisper.cpp runner (PATH binary in tests, skipped if absent), model download with sha256, settings, the
   dialog, OpenAI and ElevenLabs with the fake fetch, cost estimate and usage.
3. UI: library Analisi section, tile mark, Generate wait line with Salta, brief-agent card; CI build of `whisper-cli` and
   packaging in `extraResources`.
