# Phase 11 — live verification of brand, assets and external services (Task 9)

Date: 2026-10-13. Claude Code 2.1.296, model `haiku` (`claude-haiku-5-5`), macOS (Darwin 25.6), Node 24.9, system Chrome 155.0.8059.40 (headless, for the UI). Branch `feat/phase11-brand-assets-services` at `3a5d331`.

**Verdict:** the phase works end to end live.
- **Fonts:** the Google Fonts picker searches, previews and adds a family. The files land in `assets/fonts/` with origin `google-fonts`, and the brand font is linked.
- **Brand analysis:** a real analysis with Haiku reported its phases, called `inspect_site_fonts`, found the site's two Google families and fetched them.
- **Assets:** audio and video play; renaming a logo the brand uses keeps it in the brand; sorting by duration works.
- **Services:** with voice off, the agent declined the voice-over and pointed at the Services button. After the switch to OpenAI from the chip, the next prompt carried it.
- **Key checks:** a fake key showed `missing` and then `error`, as the scripted endpoint answered.
- **Generate:** without keys, every tab of the dialog is disabled.

**No paid provider was contacted.** The test hook answered the key checks, and a process-wide guard refused every request to the paid hosts. The guard log shows no refused request, so nothing tried. No fix was needed. One layout defect is recorded and not fixed (D1). Five findings are listed in "Findings".

| Check | Result |
|---|---|
| 1. Brand → Typography → Add from Google Fonts: search "Inter", previews, 400 + 700 | **PASS** |
| 1. … files `assets/fonts/Inter-400.ttf`, `Inter-700.ttf`, origin `google-fonts`, brand font linked | **PASS** (the kit links one file, see F1) |
| 2. Brand analysis of `https://squidfunk.github.io/mkdocs-material/` with Haiku: phases shown | **PASS** (Haiku reported 3 of the 6 phases, see F2) |
| 2. … `inspect_site_fonts` used; Roboto and Roboto Mono (Google) found and fetched with `fonts_fetch` | **PASS** |
| 3. Assets: play an audio and a video | **PASS** |
| 3. … rename the logo the brand uses; the brand still shows it | **PASS** |
| 3. … sort by duration ("Longest first") | **PASS** |
| 4. Brief Services: voice Off; ask for a voice-over → the agent says it is off and points at the Services button | **PASS** |
| 4. … switch to OpenAI from the chip → the next turn's prompt says `voice OpenAI`; no paid call | **PASS** (after step 5, see "Order") |
| 5. Settings: save a fake OpenAI key → `missing` (fake 401 `invalid_api_key`); Test → `error` (fake 503) | **PASS** |
| 6. Generate dialog without keys: the four tabs and Generate disabled, link to Settings | **PASS** |
| Requests to paid providers (OpenAI, ElevenLabs, Pexels, Unsplash) | **0** |
| Approval requests | **0** |
| UI resources from hosts other than the core | **0** |
| Real folders unchanged | **PASS** |
| Composer footer while the agent works, with a long Services summary | **D1** (layout) |

## Setup

Everything lived in the session scratchpad, `phase11-live/`: config, workspace, Chrome profile, logs, screenshots and the media made for step 3.

### The throwaway core

The 10b driver used `startServer`, which has no way to inject the key-check network. This driver built the core with `buildServer`, wired as `startServer` does:
- the `claude` wrapper and the `studio` MCP server;
- the worktree's `packages/web/dist`, rebuilt first;
- `systemLocales: ['en']`;
- an in-memory vault (`MemoryVault`) with no keys;
- `openPath` replaced by a logger.

It was run with `node --experimental-transform-types`, from a driver that refused to start unless the config dir was inside the scratchpad. The workspace was a folder next to it.

### Network hooks

- **`keyCheckHttp`:** a fake `fetch` that never opens a socket. A mode file chose its answer:
  - `invalid`: 401 with `invalid_api_key` / "Incorrect API key";
  - `down`: 503.

  Every call was logged with its URL.
- **`voicesHttp` and `generateHttp`:** a `fetch` that refuses and logs.
- **Process-wide guard:** a guard like the test one was installed in the driver process, over `fetch`, `http(s).request` and `http(s).get`. It refused `api.openai.com`, `api.elevenlabs.io`, `api.pexels.com`, `api.unsplash.com` and the Pexels and Unsplash image hosts, and logged every other outbound host. It covers the provider tools, whose `fetch` cannot be injected.
- Google Fonts and the analysed site went through. Their hosts are in the network log.

### Browser

Headless system Chrome (`--headless=new`, own profile in the scratchpad, `--use-mock-keychain`), driven over CDP by the 10b driver: real mouse and key events, file inputs through `DOM.setFileInputFiles`, screenshots. **No window was shown and Electron was not launched**, so no Electron data folder was involved.

### The `claude` wrapper

The wrapper recorded every call in `spawns.log` with the current step, and tee'd stdin (the prompt) and stdout. Its mode was `forbid` outside steps 2 and 4 and `real` (Haiku) in them. `claude --version` and `claude auth status` went to the real CLI (status probes, no tokens).

### Environment and approvals

- The calling session's Claude Code variables were removed; the user's `CLAUDE_CONFIG_DIR` login stayed (as in phases 8 to 10b).
- The core driver answered approvals `once`: it received **0** requests.

### Settings and media

Settings: `model: haiku`, `sandboxMode: auto`, English. The audio (7 s mp3), the video (3 s, 640×360, with audio) and the logo (400×400 png) were made locally with ffmpeg.

### Order

Steps ran in the order 1, 2, 3, 4 (voice off), 6, 5, 4 (switch to OpenAI). The Services chip disables a provider whose key is not set (Task 7, by design). Switching to OpenAI therefore needs a key in the vault: the fake key of step 5. Step 6 needs no keys, so it ran before step 5. The fake key was removed at the end, through the API.

### Cleanup

Every process was stopped by its own recorded PID: Chrome through `Browser.close`, the core with SIGTERM. Nothing was killed by pattern.

## 1. Google Fonts in the brand

- **Opening the picker.** "Add from Google Fonts" showed the first 24 families of the catalog, each in its own face. The catalog came from `fonts.google.com`; the previews were fetched by the core from `fonts.googleapis.com` and `fonts.gstatic.com` and served to the page through signed URLs.
- **Search and weights.** Typing "Inter" left "Inter" and "Inter Tight". Picking Inter showed the weights 100–900 (400 preselected), "Include italic", the role and "Open license (OFL or Apache 2.0): free for commercial use." 700 was ticked.
- **Add to the brand.** The toast said "Inter added to the brand". Typography showed the card "Inter 400 · 700 · File in the project" in Inter, and Brand health turned "Font files in the project" green.
- **On disk.**
  - Files: `assets/fonts/Inter-400.ttf` (324,820 bytes) and `Inter-700.ttf` (326,468 bytes).
  - In `assets.json`, both have `origin: "google-fonts"`, `sourceUrl: https://fonts.google.com/specimen/Inter`, `attribution: "Google Fonts · OFL / Apache 2.0"` and `bytes`.
  - Commit "Add Google Fonts font Inter" with the two files, `assets.json` and `brand/brand-kit.json`.
  - The kit entry: `{ family: "Inter", role: "body", weights: [400, 700], file: "assets/fonts/Inter-400.ttf", source: manual }` (F1).
- **The page loaded nothing from outside.** Every resource the page loaded came from the core's own origin, checked with the Performance API.

## 2. Brand analysis of a real site (Haiku)

**The run.** Website source `https://squidfunk.github.io/mkdocs-material/` (Material for MkDocs, which loads Roboto and Roboto Mono from Google Fonts), then **Analyze**. The job took 87 s and 19 turns, cost $0.0244 and asked for 0 approvals.

**The stepper.** It showed Starting ✓, Reading ✓, Fonts (current), then Writing. The step list showed the agent's three messages: "Reading the website and inspecting its fonts.", "Fetching the Google fonts (Roboto, Roboto Mono)…", "Writing the brand kit proposal…". Haiku sent `report_progress` with `reading`, `fonts` and `writing` only; the stepper ticked the skipped Colors, Logos and Tone when Writing arrived (F2).

**The tools.**
- `inspect_site_fonts` with the site URL answered:

  ```
  {"fonts":[{"family":"Roboto","roles":["body","other"],"weights":[300,400,700],"italic":true,"source":"google","files":[]},
            {"family":"Roboto Mono","roles":["other"],"weights":[400,700],"italic":true,"source":"google","files":[]}],"warnings":[]}
  ```

- Then `fonts_fetch` for each family:
  - Roboto 300/400/700 with italic: 6 files;
  - Roboto Mono 400/700 with italic: 4 files.

  All 10 were in `assets/fonts/` with origin `google-fonts`.
- `WebFetch` read the home page and one page of the same site. It also read one file from the project's GitHub repository, on `raw.githubusercontent.com`, looking for the palette's hex values (F3).

**Network seen by the core.** `squidfunk.github.io` (6 requests: the page and its stylesheets), `fonts.googleapis.com` (2) and `fonts.gstatic.com` (10). The `WebFetch` reads are made by Claude Code, not by the core.

**The proposal.** 15 suggestions:
- 5 colours;
- Roboto (body, 300/400/700, file `assets/fonts/Roboto-400.ttf`, source website) and Roboto Mono;
- tone, 3 dos, 2 don'ts, photo style and guidelines.

The review dialog showed the fonts in their own faces. The summary said the hex values came from the theme's palette, not from the rendered CSS. **Apply 15 of 15** applied it, and Brand health turned all green.

## 3. Assets

- **Upload.** The logo was uploaded through Brand → Logos ("Upload logo"): `assets/logo.png`, kit logo `logo-1`. The audio and the video were uploaded through Assets' file input. `assets.json` got `durationSec: 7` for `jingle.mp3` and `durationSec: 3` with 640×360 for `clip.mp4`. The tiles show "0:07" and "0:03 · 640×360".
- **Audio.** The detail panel has the player ("0:00 / 0:07", Play, a position slider). Play played the file to 7.00 s: the element read `paused=false`, then ended with `currentTime = 7`. The core served the waveform behind the scrub bar: 400 peaks, cached in `.studio/cache/waveforms/`, all between 0.124 and 0.129. That is a flat band, as expected for a constant test tone.
- **Video.** The detail panel's player ran (`currentTime` 2.07 s of 3 while playing). The tile then showed a frame of the clip.
- **Rename.** Detail → "Rename file". The driver's ⌘A did not select the field in headless Chrome (a harness limit), so the first rename made `logo.pngbrand-mark.png`; the second, with the text selected, made `brand-mark.png`. Each rename made one commit ("Rename asset logo.png to …"). Both times the kit followed:
  - `logos[0].file` became `assets/brand-mark.png`;
  - Brand → Logos showed the image, loaded from `/files/assets/brand-mark.png`, at 400 px wide;
  - Brand health still listed the logo.
- **Sort.** The sort menu offers "Newest first", "Name", "Type" and "Longest first". "Longest first" ordered `jingle.mp3` (7 s), `clip.mp4` (3 s), then the items without a duration by name. Leaving Assets and coming back reset the sort to "Newest first" (not kept; not required).

## 4. Brief services

### Voice off

**The brief.** In New creative → More options → Services, Voice was set to Off. OpenAI and ElevenLabs were disabled there, with "OpenAI needs the OpenAI key: add it in Settings → Paid services." The brief asked for a 6 s Story/Reel "…Add a voice-over that says 'Docs that simply work'."

**The prompt** (recorded stdin):

```
- tts: voice-over with OpenAI or ElevenLabs (off for this creative)
- list_voices: ElevenLabs voices of the account (free) (off for this creative)
Services for this creative: images auto; voice none; music auto; sound effects auto.
If the user asks for a disabled service, tell them it is off and that they can change it with the Services button.
```

**The turn.** Haiku took 95 s and 11 turns, cost $0.0137 and asked for 0 approvals. It made v1 (indigo background, brand mark, headline in Inter 700) and did not call `tts`. Its reply:

> **Voice-over not added.** The `tts` service is off for this creative. You can turn it on with the Services button and I'll add the line.

The composer showed the chip "Services · Voice Off"; its popover had OpenAI and ElevenLabs disabled, with the reason.

### Switch to OpenAI

**The switch.** After step 5 (fake OpenAI key saved; check `missing`), the chip's popover offered OpenAI for voice; ElevenLabs stayed disabled. Picking it saved `services: { voice: "openai" }` in the brief, with "Changes apply from the next message." The chip read "Services · Voice OpenAI".

**The next turn.** The message was "Which voice service is set for this creative now? Reply in one sentence. Do not generate any voice-over or change the composition in this turn." Its prompt (it resumed the v1 session):

```
- tts: voice-over with OpenAI or ElevenLabs (ready)
Services for this creative: images auto; voice OpenAI; music auto; sound effects auto.
```

Haiku answered in 4 s ($0.0166): "The voice service for this creative is now set to OpenAI, so the voice-over tool is available, but I have not generated anything or changed the composition."

### The repair turn

Because that turn delivered no version, the core started its usual repair turn: "The compositions of version 2 do not meet the contract…" ($0.0229, 37 s). In it Haiku called `tts` with `provider: "openai"` (F4). By then the fake key had been removed, so the core answered before any approval or request:

> This creative's brief chooses OpenAI for voice, but the OpenAI key is not set: add it in the Motion Studio settings, or the user can change the service with the Services button

The agent then delivered v2 without audio.

**No request reached a provider.** The guard log has no refused request and the approvals log is empty. Had the key still been set, the call would have asked for approval and then hit the guard, but only because confirmations were on and no "Always for this project" rule existed for `provider:tts-*`. With such a rule, or with "Ask before using paid providers" off, the repair turn would have spent money against the user's explicit "no voice-over" without any prompt (final review M8). The final wave fixed F4: the repair turn now carries the user's words verbatim and must respect them.

## 5. Key checks (fake endpoint)

- **Before.** Settings → Paid services: "Keys are stored in the system keychain and never shown to the agent." All four providers: "Not connected · Add key".
- **Saving the key.** OpenAI → Add key → a fake key → Save. The fake endpoint was in `invalid` mode and logged three probes:
  - `GET https://api.openai.com/v1/models`;
  - `GET https://api.openai.com/v1/models/gpt-image-2`;
  - `GET https://api.openai.com/v1/models/gpt-4o-mini-tts`.

  The row: "Key saved in the Keychain · The service does not accept this key: check it or replace it." `GET /api/secrets/checks`: key, images and tts `missing`, with no permission.
- **Test with the endpoint down.** In `down` mode, **Test** made the chips "Key · error", "Images · error" and "Voice-over · error", with "Some checks did not finish (The service answered 503). Press Test to try again."
- **Back to `invalid`.** Another **Test** brought back `missing`.
- **Removal.** At the end, `DELETE /api/secrets/openai` left all four "not configured".

These requests never left the process: the fake `fetch` answered them.

## 6. Generate dialog without keys

Assets → **Generate** opened "Generate an asset":
- the tabs Image, Voice-over, Sound effect and Music, all `disabled`;
- "No provider key is set yet, so nothing can be generated. Open Settings";
- the note "Every generation is a paid call to your provider account: Motion Studio asks you to confirm it first, and the result is added to this library.";
- Generate disabled.

Screenshots in both themes.

## Defects

**D1 — composer footer squeezes the "working" hint (layout, not fixed).** While a turn runs, the composer footer holds:
- the Services chip with a long summary ("Services · Voice OpenAI");
- the hint "The agent is working on the last request";
- Cancel;
- Send.

The hint is `flex: 1; min-width: 0`, so it wraps one word per line in a narrow column next to the chip (screenshot `04f-next-turn.png`, chat panel about 350 px wide).
- *Cause:* the chip came with Task 7 and does not shrink before the hint.
- *Fix:* a CSS-only change (for example `white-space: nowrap` with an ellipsis on the hint, and letting the chip summary ellipsize first).
- *Why not fixed here:* no meaningful jsdom test can cover it, and the rule for this task is a fix commit only with a test.

## Findings (not defects)

- **F1 — the kit links one file per family.** The brand font entry has a single `file`: for Inter it is `Inter-400.ttf`; `Inter-700.ttf` is in the library but not named by the kit. Renders that need 700 find it in `assets/fonts/` (the agent copied `Inter-700.ttf` into v1). The kit entry's source stays `manual` for a picker add (known, decisions log 308).
- **F2 — Haiku skipped three phases.** The stepper went Reading → Fonts → Writing and ticked Colors, Logos and Tone as done. The prompt asks for every phase; the stepper's behaviour is as designed (decisions log 315).
- **F3 — the agent's `WebFetch` left the site.** To find hex values it read a file on `raw.githubusercontent.com` (the project's own repository). This is outside the one-site scope this check intended. The core's own requests stayed on the site and Google Fonts. The sandbox gives the analysis no network; `WebFetch` is Claude Code's tool and is not limited to the source's host.
- **F4 — the repair turn ignores the user's last words.** A turn that delivers no version gets a repair turn, which does not carry the user's request. Here the user had said "Do not generate any voice-over", and the repair turn called `tts`. This predates phase 11. With a working key it would have asked for approval (a paid tool always does when confirmations are on).
- **F5 — prompt and chip trust a key the check called `missing`.** With the fake key saved, the chip enabled OpenAI and the prompt said `tts … (ready)`, although the key check said `missing`. The core still refuses or reports at call time. The UI and the prompt look only at "key configured", as in the Task 7 deferred minor ("the prompt may show tts ready").

## Network used

| Host | Who | Step | Requests |
|---|---|---|---|
| `fonts.google.com` | core (catalog) | 1 | 1 |
| `fonts.googleapis.com` | core (previews, css2) | 1, 2 | 26 + 2 |
| `fonts.gstatic.com` | core (preview and font files) | 1, 2 | 27 + 10 |
| `squidfunk.github.io` | core (`inspect_site_fonts`) | 2 | 6 |
| `squidfunk.github.io`, `raw.githubusercontent.com` | agent `WebFetch` (Claude Code) | 2 | 3 + 1 |
| Anthropic API | Claude Code (Haiku turns) | 2, 4 | 4 runs, $0.0776 in total |
| OpenAI, ElevenLabs, Pexels, Unsplash | none | — | 0 (guard log: 0 refused) |

## mtimes

Unchanged before and after:

| Folder | mtime |
|---|---|
| `~/Library/Application Support/Motion Studio` | 1791621882 |
| `~/MotionStudio` | 1791538433 |
| `~/Library/Application Support/Motion Studio Electron` | 1791822737 |

`~/Library/Application Support/Electron` was absent both times.

## Screenshots

These are kept in the scratchpad (`phase11-live/shots/`), not in the repository:
- `01c-picker`, `01d-inter-weights`, `01e-added` (and light);
- `02-ph-3`, `02-ph-14`, `02-ph-17`, `02c-after`;
- `03a-assets`, `03c-audio-playing`, `03d-video-playing`, `03g-brand-logo`, `03h-sorted-duration`;
- `04b-new-filled`, `04c-voice-off-reply`, `04e-chip-openai`, `04f-next-turn`;
- `05b-key-missing`, `05c-key-error`;
- `06a-generate-no-keys` (and light).

## Concerns

- The key checks, voice previews and Generate were verified only against fakes. The real providers' answers to the probes (their error wording, OpenAI's model visibility) remain untested live, as `docs/providers.md` says.
- The live check used headless Chrome, not the desktop app.
- The analysis is one Haiku sample on one site whose fonts are all on Google Fonts: the self-hosted and Adobe paths of `inspect_site_fonts` were covered by the unit tests only.
