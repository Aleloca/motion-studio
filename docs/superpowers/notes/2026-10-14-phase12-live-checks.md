# Phase 12 — live verification of variants (Task 8)

Date: 2026-10-14. Claude Code 2.1.296, model `haiku` (`claude-haiku-5-5`), macOS (Darwin 25.6), Node 24.9, system Chrome (headless, for the UI), ffmpeg/ffprobe from `/usr/local/bin`. Branch `feat/phase12-variants` at `5ad40e6`.

**Verdict:** the six checks pass. Four product findings and one harness note are listed in "Findings"; none was fixed here.

| Check | Result |
|---|---|
| 1. Duplicate a format, iterate only the instance (Haiku); the other instances byte-identical | **PASS** |
| 2. German and Japanese, two formats, voice "Keep original": overlays, Noto Sans JP fallback, localized preview and render | **PASS** (F3 limits the preview of an unchanged format) |
| 3. Edit a translation by hand: overflow shown, then fixed with `fit` | **PASS** (F2: wording) |
| 4. A new iteration changes one title: stale in the UI and the render | **PASS** (F4: the problem message) |
| 5. App Store pack, 3 screenshots + preview: render, export, ffprobe and IHDR | **PASS** |
| 6. Batch voice approval with an injected fake `fetch`: one approval, voices written, hashes recorded | **PASS** |
| Requests to OpenAI, ElevenLabs, Pexels, Unsplash | **0** (guard log: 0 refused; the fake TTS fetch never opened a socket) |
| Real folders unchanged | **PASS** |

## Setup

Everything lived in the session scratchpad, `phase12-live/` (config, workspace, Chrome profile, logs, screenshots, media, export output). The method is phase 11's, with these changes:
- **Throwaway core:** `buildServer` from a driver (`core-driver.mts`), `MOTION_STUDIO_CONFIG_DIR` inside the scratchpad (the driver refuses otherwise), `MemoryVault` with no keys, `openPath` logged. The worktree's `packages/web/dist` and the composition runtime were rebuilt first.
- **Process-wide network guard** as in phase 11 (refuses `fetch`, `http`, `https` to OpenAI, ElevenLabs, Pexels, Unsplash and their image hosts, logs every other outbound host).
- **Fake TTS (check 6):** `localizeHttp: { fetch, lookup }` with a `fetch` that never opens a socket. It answers `https://api.openai.com/v1/audio/speech` with a local 1.5 s mp3 and logs every call (URL and the text, never a key). The key-check endpoint (`keyCheckHttp`) answered `ok` from a fake; the OpenAI key was a made-up string saved to the in-memory vault and removed at the end.
- **Approvals:** the driver logged every approval and did not answer any. The one approval of the session (check 6) was answered in the UI.
- **`claude` wrapper:** `real` (Haiku) in every phase that runs an agent, `forbid` otherwise; every spawn is in `spawns.log` with its phase (10 agent runs).
- **Browser:** headless system Chrome over CDP, own profile, no Electron, no packaged app.
- **Settings:** `model: haiku`, `sandboxMode: auto`, English.

## 1. Duplicate and iterate one instance

Brief: Instagram Post 1:1 and Post 4:5, 3 s, two text clips (`title`, `subtitle`). v1 (Haiku, one turn) made both.
- **Duplicate.** `POST …/versions/1/duplicate-format {instanceId: "instagram-post-1x1", label: "Square - green variant"}` made v2 (origin `editor`, request "Duplicated Square - green variant", no agent). The brief became `[instagram-post-1x1, instagram-post-1x1@2, instagram-post-4x5]` with the label on `@2`. v2's `@2` has the same composition hash as the bare instance (`9dc5b890…`).
- **Iterate only the instance.** A Haiku turn with `formats: ["instagram-post-1x1@2"]` ("background #14301f, title Fresh roast") made v3.
- **Byte-identical check** (content hash of every file of each composition folder; `bin/hashes.sh`):

  | Folder | v2 | v3 |
  |---|---|---|
  | `instagram-post-1x1` | `458308f8fc1091e2` | `458308f8fc1091e2` |
  | `instagram-post-1x1@2` | `458308f8fc1091e2` | `3818a6ec6e1a564d` (changed) |
  | `instagram-post-4x5` | `bcd0287eccaf7f4f` | `bcd0287eccaf7f4f` |

  v3's `@2`: `background: #14301f`, title "Fresh roast"; the others still `#2b1a12` and "Brew the day". Recorded hashes in `versions.json`: bare `9dc5b890…`, 4x5 `97e6f8f9…` unchanged.
- **UI.** The board lists "Post 1:1 · v1", "Square - green variant · v3", "Post 4:5 · v1" and the three live previews show the brown, green and brown cards (`shots/c1-overview.png`, `c2-brief-edit.png`).
- Cost: the duplicate 0; the iteration turn $0.0096.

## 2. German and Japanese, voice "Keep original"

- **Brief.** In the brief editor, Languages: the original English and the extra German and Japanese (saved; no new version). The picker lists the four right-to-left languages as disabled, with the reason "Right-to-left languages are not supported yet…" (`c2-lang-rtl-disabled.png`, `c2-lang-english.png`).
- **Translate (UI).** Languages button → ticked Post 1:1 and Post 4:5 (not the variant), German and Japanese, voice "Keep original" (the panel says "The voice cannot be translated: there is no key for the voice service") → **Translate 2 languages** on v3 (`c2-languages-two-formats.png`, `c2-translating.png`). The turn made 2 attempts (the agent's first answer had overflow problems, see F5), then saved. Cost $0.0101 (two runs).
- **Overlays.** `outputs/v3/locales/{de,ja}/{instagram-post-1x1,instagram-post-4x5}.json` exist (`motion-studio/localization@1`), each with `texts` carrying the source text next to the translation (title "Brüh den Tag" / "一日を淹れる", subtitle…), empty `voices`, and, for `ja`, `fonts: [{ family: "Noto Sans JP", files: [assets/fonts/NotoSansJP-400.ttf, …-700.ttf] }]`.
- **Fallback font.** The product downloaded it through the Google Fonts path: 3 requests (`fonts.googleapis.com`, 2 × `fonts.gstatic.com`, phase `check2-translate`). Files in `assets/fonts/`: `NotoSansJP-400.ttf` sha256 `f037d714…2021`, `NotoSansJP-700.ttf` sha256 `59bb5d29…e799`, registered in `assets/assets.json` with origin `google-fonts`; the rows' `assetHashes` carry the same hashes.
- **Localized render.** `POST …/versions/3/render {formats: [1x1, 4x5], locales: [de, ja]}` → `instagram-post-{1x1,4x5}.{de,ja}.mp4`: h264, 1080×1080 / 1080×1350, 30 fps, 3.0 s. Frames at 1.8 s (`shots/frames/v3-montage.png`): German in Inter ("Brüh den Tag", "Specialty Coffee, sorgfältig geröstet"), Japanese in Noto Sans JP with no missing glyphs; the layout is identical to the original. `manifest.json` lists the four renders with `locale`, `forced: false`, `stale: []`, and the sha256 of each file. The localized renders are not in `outputs[]`, so the ★ and the primary render state did not move.
- **Localized preview.** The player's language switcher on `Square - green variant` (translated afterwards in a second Haiku turn, $0.0049, formats `["instagram-post-1x1@2"]`): Japanese on the live preview at 1.79 s shows "焙煎したて" and the subtitle in Noto Sans JP on the green background (`c2-preview-ja-at2.png`). See F3 for the bare 1:1.
- The review table opens per language and format (`c3-review-ja-1x1.png`).

## 3. Edit a translation by hand

- **Overflow.** A very long German title through the review table's endpoint: state "Outside the box", "1 problem", message "The translation of "title" does not fit its box, even at 70% size", the core having chosen fit 70% (`c3-overflow-hard.png`). Then "Frischer Kaffee" with an explicit fit of 100%: "Outside the box" again (`c3-overflow-fit1.png`); the estimate says it fits at 85%.
- **Fix with `fit`.** In the UI, the "Text size of title" slider (keyboard, three steps down) to 85% and **Save translation**: state "OK", "Saved", the row `origin: "editor"`, `fit: {title: 0.85}`, `issues` empty (`c3-fixed-with-fit.png`). No new version was made (v3 stayed the latest until check 4).
- The text values and sliders were set through the PUT endpoint for the long strings (the textarea is a normal control; the slider and Save were driven in the UI).

## 4. A new iteration changes one title

Haiku turn with `formats: ["instagram-post-1x1"]` ("title: Brew the morning"), v4 ($0.0095).
- **Hashes.** `instagram-post-1x1` changed (`5c7a2a23…`); `instagram-post-1x1@2` and `instagram-post-4x5` identical to v3.
- **Carry.** v4's rows: `ja`/`de` Post 1:1 `stale: ["title"]`; Post 4:5 and the variant `stale: []`, `origin: agent`; the hand-edited `de` 1:1 keeps `origin: editor`.
- **UI.** The Languages panel on v4: German "1 outdated", Japanese "1 outdated · 1 problem"; the table marks the title "Outdated" next to the new original "Brew the morning" (`c4-stale-ui.png`).
- **Render.** `POST …/versions/4/render {formats: [1x1], locales: [ja]}` without `force` → 409 `localization-needs-force` ("These translations have open problems or outdated texts: Instagram · Post 1:1 (ja). Render anyway to go on"). With `force: true`: `instagram-post-1x1.ja.mp4`, manifest `locale: ja, forced: true, stale: ["title"]`. The frame at 1.8 s shows the English "Brew the morning" for the outdated clip and the Japanese subtitle (`shots/frames/v4-ja-1x1-forced.png`): the original text, never the old translation.

## 5. App Store pack

Created through `POST …/creatives/store-pack` (the wizard's endpoint): App Store, iPhone 6.9" only, three screenshots with captions, preview on, three 1170×2532 RGB PNGs from the library (`assets/screens/screen-N.png`, made with ffmpeg `testsrc2`). One Haiku turn ($0.0246) made v1 with four formats: `appstore-iphone-69`, `@2`, `@3`, `appstore-preview` (20 s, no audio clip). The UI shows the four labelled boards, rendered, and the **Export store pack** dialog (`c5-pack-export-dialog.png`).

**Export** (`POST …/versions/1/store-pack/export`, 23 s including the renders): `written` four files, `failed: []`. Layout:

```
acme-app-pack-store-pack/
  AppStore/iPhone-6.9/01-order-in-two-taps.png
  AppStore/iPhone-6.9/02-track-your-roast.png
  AppStore/iPhone-6.9/03-fresh-every-week.png
  AppStore/preview.mp4
  README.txt
```

- **PNG IHDR** (read with `struct.unpack`, not `file`): all three 1320×2868, bit depth 8, **colour type 2** (RGB, no alpha), no `tRNS` chunk.
- **ffprobe** of `preview.mp4`: video `h264` High, 886×1920, `r_frame_rate=30/1`, 20.000000 s; audio `aac` LC, 48000 Hz, 2 channels, 20.000000 s; container duration 20.000000 s. The composition had no audio, so the silent track is the core's.
- **README.txt**: title, date and version, the store limits with the check date 2026-10-14, the three source URLs, the upload order; no Google Play note (no Play in this pack).
- The frames show a coherent series: caption with "N / 03" eyebrow on top, the app screen inside a plain rounded device frame, no notch, buttons or logos (`shots/frames/pack-montage.png`).
- sha256: preview `fc0f4f9a…bdb`, screenshots `4465b21d…564`, `b17fbac5…c202`, `bbc06767…3e9a3916`.

## 6. Batch voice approval (fake `fetch`)

A creative with one voice clip (`vo`, role `voice`, script "Welcome to Acme Coffee", from the library file `narration.mp3`) made by Haiku (v1, $0.0133); the brief has `services.voice: openai` and languages German and French; a fake OpenAI key in the in-memory vault.
- **Turn.** `POST …/versions/1/localize {locales: [de, fr], voice: {de: translate, fr: translate}}`.
- **One approval.** `GET /api/approvals` showed a single card, kind `paid-batch`, "Generate 2 translated voices with OpenAI", `toolName` and `alwaysRule` `provider:tts-openai`, 2 calls (German · vo 26 characters, French · vo 26), "52 characters in all", "Estimate not available". It appears in the chat with **Approve / Always here / Decline** (`c6-approval-card.png`). Before the answer the fake fetch log was empty (0 calls).
- **After Approve** (in the UI): exactly two fake calls in `logs/tts.log` ("Willkommen bei Acme Coffee", "Bienvenue chez Acme Coffee"); no second approval; the job succeeded.
- **Voices written.** `assets/audio/2026-10-14-voice-demo-de-vo-3df3f3.mp3` and `…-fr-vo-3df3f3.mp3` (12,555 bytes each, the fake's mp3); each overlay has `voices.vo = {src, sourceScript: "Welcome to Acme Coffee", script: <translation>}`; both rows `voice: "translated"`.
- **Hashes recorded.** Both rows' `assetHashes` hold the sha256 of their file (`dfface53…6a49`, the same bytes).
- A localized render of `de` has a video and an AAC stream, 3.0 s.
- The key was removed at the end (`DELETE /api/secrets/openai`); no key check or provider request was made (the key was saved with `check: false`).

## Costs (Haiku, from `.studio/usage.jsonl`)

| Run | Cost |
|---|---|
| v1 Coffee launch | $0.0163 |
| v3 iterate the instance | $0.0096 |
| Translate (2 attempts) | $0.0084 + $0.0017 |
| Translate the variant | $0.0049 |
| v4 iterate the title | $0.0095 |
| Store pack | $0.0246 |
| Voice demo (create) | $0.0133 |
| Translate with voices (2 attempts) | $0.0046 + $0.0016 |
| **Total (10 runs)** | **$0.0945** (about 285k tokens, a subscription: the figure is at API prices) |

## Network used

| Host | Who | Phase | Requests |
|---|---|---|---|
| Anthropic API | Claude Code (Haiku) | 10 agent runs | $0.0945 |
| `fonts.googleapis.com`, `fonts.gstatic.com` | the agent's own fonts tool (Inter) | check 1 (v1) | 1 + 2 |
| `fonts.googleapis.com`, `fonts.gstatic.com` | the product's fallback font (Noto Sans JP) | check 2 | 1 + 2 |
| OpenAI, ElevenLabs, Pexels, Unsplash | none | — | 0 (0 refused by the guard) |

The Inter download was made by Haiku in the first turn (its Google Fonts tool, the same product path), not by this harness; it is not Noto, so it is reported here.

## Real folders (mtimes)

| Folder | Before | After |
|---|---|---|
| `~/Library/Application Support/Motion Studio` | 1791621882 | 1791621882 |
| `~/MotionStudio` | 1791538433 | 1791538433 |
| `~/Library/Application Support/Motion Studio Electron` | 1791822737 | 1791822737 |
| `~/Library/Application Support/Electron` | absent | absent |

Processes: the core (PID 7944, SIGTERM, "STOPPING approvals=1"), the browser driver (11925) and Chrome (11927, `Browser.close`) were stopped by their own recorded PIDs; nothing was killed by pattern.

## Findings (product, not fixed)

- **F1 — false "project files changed" warning on translate turns.** Each localize job ended with "Warning: project files changed during the translation turn (creatives/2026-10-14-coffee-launch). A translation turn only reads: check these changes if nobody else made them." (seen on the German/Japanese turn and on the variant's turn). The path is the creative's own folder. `snapshotProject` (`localize-turn.ts`) fingerprints directories by `mtime` and inode; the core's own writes into the creative folder during the turn (atomic writes of `versions.json`, the conversation, `locales/`) change the folder's mtime even though the files it skips are excluded. The warning is shown in the chat and in the job notes, and it would make a real stray write indistinguishable from it.
- **F2 — overflow message says "even at 70% size" at any fit.** With an explicit fit of 100% the row says "does not fit its box, even at 70% size" although the text fits at 85%; the sentence is fixed. The state and the slider are right.
- **F3 — the language switcher is disabled for a format whose last own version is older than the translated one.** The bare "Post 1:1" board and format view show v1 (its composition did not change in v3), and the switcher offers German and Japanese disabled, although the Languages panel (v3) lists translations of Post 1:1 and the preview/render of v3 work. Only formats that changed in the translated version can be previewed in another language from their own view. Rendering and export are unaffected.
- **F4 — the measured-overflow problem of a stale clip blames the translation.** After the forced render of v4, the Japanese row reads "1 outdated · 1 problem" with "The translation of "title" overflows its box in the render, at 100% size", but the clip rendered with the original English text (the stale rule), which is the text that overflows (the new English title wraps into the subtitle in v4's own composition). The overflow belongs to the new source, not to the translation.
- **F5 — translate turns needed a second attempt on trivial compositions.** The German/Japanese turn and the voice-demo turn each showed "N translation problems to fix: attempt 2 of 3" (a second Haiku run, $0.0017 and $0.0016). The agent's own reply in the voice demo says the French and German texts were close to the original length and should fit the 920 px box; the browser-measured result is in the job's conversation, not analysed further here. It may point at a strict overflow check (the pre-check calls "Kaffee des Tages" an overflow at 85%). The outcome was correct.

Harness note: the preview of a composition at t=0 is blank (text fades in from 0), which looks like a failure; seek into the clip before judging.

## Concerns

- The checks used one small Haiku sample per feature and simple compositions (text only); the translate, voice and pack paths with real images, long voice clips and several instances per device were covered by tests only.
- The App Store pack was created through the wizard's endpoint, not by clicking through the wizard (its tests cover the clicks); the export dialog was opened but the export was made through the endpoint.
- Translation overflow was shown both ways (UI and endpoint), but the very long German string was set through the endpoint.
- The fake TTS returns a 1.5 s file for any text, so "voice longer than the clip" was not exercised live.

## Screenshots

In the scratchpad, `phase12-live/shots/`: `c1-overview`, `c2-brief-edit`, `c2-lang-rtl-disabled`, `c2-lang-english`, `c2-languages-two-formats`, `c2-translating`, `c2-translated`, `c3-review-ja-1x1`, `c3-overflow-hard`, `c3-overflow-fit1`, `c3-fixed-with-fit`, `c2-preview-ja-at2`, `c4-stale-ui`, `c5-pack-export-dialog`, `c6-approval-card`; frames in `shots/frames/` (`v3-montage`, `v4-ja-1x1-forced`, `pack-montage`).
