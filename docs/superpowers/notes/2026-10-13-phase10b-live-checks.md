# Phase 10b — live verification of the composition editor (Task 11)

Date: 2026-10-13. Claude Code 2.1.296, model `haiku` (`claude-haiku-5-5`), macOS (Darwin 25.6), Node 24.9, system Chrome 155.0.8059.40 (UI and render engine). Branch `feat/phase10b-editor` at `9028c98`, then with the three fixes of this task (see "Defects").

**Verdict:** the editor works end to end live. Direct edits of text, font (a brand font with a file), colour, position, rotation, entry preset, timing with ripple, media replacement (library and upload), trim and volume, layer visibility on a still, undo and redo, the leave guard, the base check against a concurrent agent turn, and comments on a clip and on a time range all behave as specified. Editor saves launched no agent and wrote no usage line. Three small defects were found and fixed with tests (F1–F3). Four findings are recorded and not fixed (D1–D4); D2 needs a decision.

The machine was quiet this time: the 1-minute load average stayed between 5 and 17.

| Check | Result |
|---|---|
| 1. Creative with Reel + TikTok (linked) + Image 1:1; Edit opens on the Reel | **PASS** |
| 2. Title text, brand font with a file, colour; logo moved and rotated; entry preset; Save → v2 `origin: editor` | **PASS** |
| 2. … TikTok follows, storyboard updated, no claude spawned, no usage line | **PASS** |
| 2. … summary in the chat | **PARTIAL**: only the "v2 · Ready" card, see D1 |
| 3. Scene 2 extended by about 1 s with ripple; a follower over its maximum is unlinked with the warning | **PASS** (findings D2, D3) |
| 4. Background video replaced from the library and by an upload; trim start; volume | **PASS** |
| 4. Render ★ and export: mp4 valid, BT.709 | **PASS** (★ had to be set by hand, D2) |
| 5. Undo and redo across 20 steps; ⌘Z while typing leaves the draft alone | **PASS** |
| 5. Leave guard on Back and on the browser's back; reload loses the draft after the browser prompt | **PASS** |
| 6. Agent turn on another format while a draft is open: Save succeeds on top of it | **PASS** |
| 6. Agent turn on the edited format: Save refused (`editor-base-changed`), draft kept | **PASS** |
| 7. Image: layers panel, hide a layer, change a text, Save, Render png | **PASS** |
| 8. Clip comment and range comment sent to Haiku: prompt lines right, the agent edits that clip | **PASS** after fix F1 |
| Spawns of `claude` during editor actions (steps 2–5 and 7) | **0** |
| Approval requests | **0** |
| Screenshots light and dark | **PASS** (kept in the scratchpad) |
| Real folders unchanged | **PASS** |

## Setup

- Everything lived in the session scratchpad, `phase10b-live/`: config, workspace, Chrome profile, logs, screenshots, exports.
- **Throwaway core:** `startServer({ port: 0, configDir, vault: new MemoryVault(), claudeCommand: [wrapper], webDir: <worktree>/packages/web/dist, systemLocales: ['en'] })`, run with `node --experimental-transform-types` from a driver that refused to start unless the config dir was inside the scratchpad. The web and runtime dists were built in the worktree first.
- **Browser:** headless system Chrome (`--headless=new`, its own profile in the scratchpad, `--use-mock-keychain`), driven over CDP by a small driver with a loopback control port: real mouse and key events (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`), file inputs through `DOM.setFileInputFiles`, the `beforeunload` prompt through `Page.javascriptDialogOpening`, screenshots through `Page.captureScreenshot`, and the colour scheme through `Emulation.setEmulatedMedia`. **No window was shown and Electron was not launched**, so no Electron data folder was involved.
- **The `claude` wrapper** recorded every call in `spawns.log` with the current step, and tee'd stdin (the prompt) and stdout. Its mode file decided what ran:
  - `forbid` during every editor action: a call would have been recorded and refused;
  - `fake` for the setup turn and the two turns of step 6: a scratch stand-in that writes compositions from the prompt's machine block, no tokens;
  - `real` only for step 8 (Haiku).

  `claude --version` and `claude auth status` went to the real CLI (status probes, no tokens) and were recorded apart.
- The calling session's Claude Code variables were removed; the user's `CLAUDE_CONFIG_DIR` login stayed (as in phases 8 to 10a).
- The core driver answered approvals `once`: it received **0** requests.
- Settings: `model: haiku`, `sandboxMode: auto`, English. One project with:
  - a brand kit with three colours and the font "Schibsted Grotesk" (700) whose file is `assets/fonts/schibsted-700.woff2`;
  - a library video `video/beach.mp4` (6 s);
  - a custom format "Test · Short 9:16 (6 s max)", same size, extensions and safe zone as the Reel, `maxDurationSec: 6`, so that a 1 s extension pushes a follower over its limit. TikTok's real limit (180 s) is far beyond any test duration.

  All media were made locally with ffmpeg; the fonts are the OFL `@fontsource` files already in `node_modules`. Nothing was downloaded.
- Every process was stopped by its own recorded PID (the core with SIGTERM, Chrome through `Browser.close`); nothing was killed by pattern and nothing of the run was left.

## 1. The creative

"Autumn promo", 6 s: Story/Reel 9:16, TikTok 9:16 and the Short test format (both following the Reel), Image 1:1. The stand-in wrote two compositions: the Reel with two scenes ("Intro" 0–3 s, "Offer" 3–6 s), a background video with audio, an SVG logo, the title and the offer text in JetBrains Mono; the Image with a photo, a band, the logo, a title and a subtitle. v1 complete, "Not rendered". **Edit** in the Reel's format view opened the editor ("Also used by TikTok · Video 9:16, Test · Short 9:16 (6 s max)").

## 2. Text, font, colour, logo, preset

- The title was selected in the timeline and edited in the inspector:
  - text "Autumn deals";
  - the font select listed "JetBrains Mono" (composition) and "Schibsted Grotesk" (brand); picking it staged the brand file, declared it (weight 700) and set the weight to 700;
  - the colour came from the brand palette swatch `#E4572E`.
- The logo was picked in "In this scene", dragged on the stage (x 440 → 679.143, y 260 → 452.857) and rotated with the handle, Shift snapping to 30°; its entry preset became "Pop in" (0.4 s).
- **Save as v2** → v2 `complete`, `origin: editor`, `basedOn: 1`, no `usage`, request "Direct edits: Title text, Title style, font Schibsted Grotesk and 2 more".
  - TikTok and the Short format followed (same hash `59f7d260…`).
  - v2's folder had the brand font at `assets/lib/d656a2dc-schibsted-700.woff2`.
  - The v2 storyboard (new hash) shows the coral title in the brand font and the rotated logo.
  - `usage.jsonl` stayed at 4 lines; no `claude` call.
- The chat shows the "v2 · Ready" card but not the edit summary: D1.

## 3. Ripple

- With the ripple toggle on, the Offer text's end edge was dragged right: scene 2, the logo and the background video grew with it and the composition became 7.021 s (pointer drags are not frame-rounded and, at the Fit zoom, overshoot: D3).
- **Save as v3** → v3 `origin: editor`, the Short format left out and the chat warning: "Test · Short 9:16 (6 s max) was not delivered: it cannot follow Instagram · Story/Reel 9:16 (the main format is longer than its maximum duration). It is no longer linked, so the next turn makes a dedicated version." TikTok still followed.
- v3 was **incomplete**: "The composition lasts 7s, but about 6s were requested". This is D2.

## 4. Media, render and export

- Background video → **Replace…** → `beach.mp4` from the library:
  - staged in 3 s;
  - the inspector warned "This video lasts 6 s, but the clip needs 7.021 s from its trim start…" with "Fit clip to video".
- **Replace…** → **Upload…** with a 10 s clip with audio: uploaded, registered in the library, staged and picked in 9 s. Then trim start 1.5 s and volume 0.5 in the inspector.
- **Save as v4**: the composition names `assets/lib/73e0076d-upload-clip.mp4`. Only that staged file was copied into the version; the unused library pick was not.
- **Render ★** rendered v2, not v4: the ★ default is "the newest version without problems" and v3/v4 are incomplete (D2). After "Use v4 for export", Render ★ rendered v4 in 14.6 s:

  | File | Stream |
  |---|---|
  | `v4/instagram-reel-9x16.mp4`, 4.7 MB | H.264 yuv420p 1080×1920, 30 fps, 211 frames, BT.709 primaries/transfer/matrix, limited range; AAC 48 kHz stereo |
  | `v4/tiktok-9x16.mp4` | byte-identical copy (follower) |
  | `v2/instagram-reel-9x16.mp4` | H.264 1080×1920, 180 frames, BT.709 |

  - Every file decoded with no errors.
  - The volume edit is audible: −30.1 dB mean against −24.1 dB for v2 at volume 1 (−6 dB).
- **Export** of the four ★ files to a scratch folder: byte-identical copies (sha256 compared): Reel and TikTok v4, Short v2, Image v1.

## 5. Undo, redo and leaving

- 20 edits of the logo's X (101 to 120, Enter each). 20 × ⌘Z went back through 119…101 to the base 679.143 (no draft, Undo disabled), and 20 × ⇧⌘Z forward to 120.
- ⌘Z while typing in a field changed only the field: the draft kept its 20 edits.
- **Back to the preview** → "Save your edits first? You have 20 edits that are not saved as a version." [Keep editing] [Discard] [Save as v5].
- `history.back()` (the browser's back) put the address back and opened the same dialog. At the first try the dialog was not there yet after 1.2 s; the second try showed it at once. Not reproduced.
- Reload → a `beforeunload` prompt:
  - dismissed: the page and the 20 edits stayed;
  - accepted: the editor reopened on v4 with no draft.

## 6. A concurrent agent turn

- **Another format.** Draft on the Reel (title text). From the driver (the "second window"), a turn with `formats: ['instagram-image-1x1']` made v5. **Save** then made v6 on top of v5, `basedOn: 4`: the Reel from the draft, the Image from v5 (nothing overwritten).
- **The edited format.** Draft on the Reel (logo rotation −15). A turn with `formats: ['instagram-reel-9x16']` made v7.
  - The editor showed at once "This format changed while you were editing · Instagram · Story/Reel 9:16 has a newer version (v7). Your draft is kept: it cannot be saved on top of it." [Keep editing] [Reopen on the latest version].
  - After Keep editing, Save was disabled with that reason and the draft stayed.
  - A save posted straight to the core with the stale base answered `409 editor-base-changed` and made no version.
  - "Reopen on the latest version" asked "Discard the draft and reopen?" before discarding.
- The v7 turn went through three attempts because of D2: the duration check asked the agent to fix the 7 s composition.

## 7. The image

The Image's editor showed the layers panel (Front: Subtitle, Title, Logo; Background: Band, Photo).
- Hiding Band and changing the title to "Autumn deals" made a 2-edit draft. **Save as v8** → v8 `origin: editor` (`band.hidden: true`).
- **Render v8** came from the canvas's version menu: the format view's menu of a still has no Render entry. It gave a png, 1080×1080 RGB, 1.5 s, with no band.

## 8. Comments to the agent

- The Reel's ★ was v7 and the pin source v8, which carried the Reel unchanged. The editor refused both comments: "Comments apply to v8: open that version to comment". The format view, which maps the pin source to the format's history entry, allowed them. This is **F1**, fixed. With the fix, the editor (on v7) accepted:
  - a clip comment on Offer: "Change this text to: Up to 40% off";
  - a range comment 3.0–5.0 s (from the range dialog): "In this range the background video should be a bit darker (opacity 0.8)."
- Before the change, the brief's duration was set to 7 s (D2: otherwise the turn would be asked to undo the editor's extension).
- The prompt (recorded from stdin) had:

  ```
  ## Pinned comments
  - instagram-reel-9x16 @ 3.0s, point (50%, 48%), clip offertext "Offer": Change this text to: Up to 40% off
  - instagram-reel-9x16 @ 3.0s, point (50%, 50%), range 3.0–5.0s: In this range the background video should be a bit darker (opacity 0.8).
  - .studio/cache/pin-frames/2026-10-13-autumn-promo/v9/9-1.jpg
  - .studio/cache/pin-frames/2026-10-13-autumn-promo/v9/9-2.jpg
  - .studio/cache/pin-frames/2026-10-13-autumn-promo/v9/9-2e.jpg
  ```
- Haiku (43 s, 10 turns, 0 approvals) made v9, complete:
  - it changed `offertext` to "Up to 40% off";
  - it split the background video into three back-to-back segments with the middle one (3–5 s) at opacity 0.8;
  - nothing else changed. It validated the composition and looked at four preview frames.
- **Harness artefact.** The first send failed with 0 tokens: the core resumed the stand-in's session id, which the real CLI rejects ("--resume requires a valid session ID"). The latest version's `sessionId` was set to null in the scratch `versions.json`, and the comments were made again.
- After the turn, the chat showed the tripwire notice "after this run there is an unexpected file or folder … (creatives/2026-10-13-autumn-promo)". The cause is an empty `.claude/.cc-writes/` folder that Claude Code created in the creative folder after the agent's `cd` there: D4.

## Spawns, approvals and usage

| Step | Agent calls | Status probes (`--version`, `auth status`) |
|---|---|---|
| setup (two creatives; the first had a fixture bug) | 4 fake | 5 |
| 2, 3 | **0** | 0 |
| 4 | **0** | 1 |
| 5 | **0** | 4 (two page reloads) |
| 6 | 4 fake (1 + 3 attempts, D2) | 0 |
| 7 | **0** | 1 |
| 8 | 2 real (one refused resume with 0 tokens, one turn) | 8 |

- **Editor actions launched no agent.** The status probes come from the page's System/login checks on load, not from the editor; they use no tokens.
- **Approvals:** 0.
- **Usage ledger:** 4 lines before the first editor save. The editor saves (v2, v3, v4, v6, v8) added none; only agent turns did.

| Run | Version | input | output | cache write | cache read | shown | cost at API prices | wall time |
|---|---|---|---|---|---|---|---|---|
| Haiku, two comments | v9 | 12 | 4,696 | 48,705 | 201,630 | 53,413 | $0.0141 | 43 s |

## Render timings (1080×1920, 30 fps; load average about 6)

| Render | Time |
|---|---|
| Reel v2 (6 s) with the TikTok and Short copies | 10.9 s |
| Reel v4 (7.02 s, a staged video with audio) with the TikTok copy | 14.6 s |
| Image v1 / v8 (png) | 1.3 s / 1.5 s |

## Screenshots

There are 39 screenshots at 1440×900 from the headless Chrome, in the session scratchpad (`phase10b-live/shots/`, 9 MB). They are not committed.

- **Dark** (headless Chrome's default scheme), every step: the editor open, the font select with the brand group, the logo moved and rotated, the drafts with the pill, the chat after each save, the ripple draft, the asset picker, the media section with the staged upload, the canvas after the renders, the versions menu ("Starred automatically: the newest version without problems"), the export dialog, the leave guard, the base-changed dialog, the image editor and its draft, the comment dialogs and chips. Also the image editor and the canvas again at the end.
- **Light** (`prefers-color-scheme: light`): the video editor with the inspector, the editor chat after v9, the asset picker, the leave guard, the video editor after the fixes, the image editor (caught while still loading) and the canvas.

Contrast looked right in both themes and the strings were catalog text.

Small things seen (not defects of the brief, not fixed):
- The format view's scene strip names scenes by id ("intro"); the editor uses the names ("Intro").
- The inspector's DUR and OUT fields cut off a value like 7.021 ("7.02:").
- A stage drag writes fractional coordinates (679.143).
- Clips that overlap on one track hide each other in the timeline lane (the stand-in's logo was under the title and the offer).
- Nothing warns before Save that a follower will be unlinked; the chat says so afterwards.

## Defects

Fixed, each with a test:
- **F1. The editor refused comments when the pin source carried the format unchanged.** The editor compared the opened version with the pin source (`n === pinSource`); the format view maps the pin source to the format's history entry (`entryAt`). The editor now does the same.
- **F2. The scene reorder reason said "Scenes can't be reordered" twice and named the clip by id.** The note now reads "Scenes cannot be reordered: clip Logo is not inside a single scene". The unused `reorderBlocked` strings were removed from both catalogs.
- **F3. One drag could become several undo steps.** Edits joined into one step only when they came less than 500 ms apart. A timeline drag held still (the timeline had no heartbeat) or a busy main thread split it: live, a 4-frame logo drag was 4 steps. Pointer gestures now pass `hold`, so their edits join until the gesture ends, and a new gesture closes any earlier run. The stage handles' heartbeat is no longer needed and was removed. Verified live after the fix: a ripple drag with two 900 ms rests is one edit and one undo.

Recorded, not fixed:
- **D1. No edit summary in the chat.** An editor version appears only as "vN · Ready"; its summary ("Direct edits: …") is in the version menu and `versions.json`. Showing it needs the versions in `Conversation` (canvas, format view and editor), which is a UI choice.
- **D2. An editor change of duration is judged against the brief.** The brief-duration check ("lasts 7s, but about 6s were requested") applies to editor saves, so:
  - the version is incomplete;
  - the ★ default skips it, so Render ★ and Export pick an older version;
  - the next agent turn is asked to "fix" the duration, which may undo the user's edit (the step 6 stand-in turn went through three attempts).

  Options: skip that check for editor saves, or update the brief's duration with the save. Either is a product decision.
- **D3. Ripple drags at the Fit zoom overshoot, and pointer drags are not frame-rounded.**
  - The scale is recomputed while the composition grows: 212 px meant to be 1 s gave 1.18 s.
  - Trims and moves by pointer keep sub-frame times (7.021426 s, rendered as 211 frames). The keyboard path rounds to frames.
- **D4. Claude Code's `.claude/.cc-writes/` trips the run tripwire.** Claude Code 2.1.296 creates this empty folder in the directory a Bash command `cd`s into, here the creative folder. The tripwire then posts "an unexpected file or folder". This is not an editor defect. The 10a notes saw the same notice on a phase 9 build; this is a likely cause. Changing the tripwire's allowlist is security-sensitive and was left to a review.

## Concerns

- `assets/lib/` is reserved for the editor's files by convention only: the agent's context does not mention it and no check enforces it (see `docs/output-contract.md`).
- The core accepts editor saves whose base hash is current even when `brief.durationSec` differs a lot from the composition (D2); a decision should cover both the save and the next turn.
- The live check used headless Chrome instead of the desktop app: the desktop-only paths of the editor (the native close dialog with unsaved drafts) were covered by the unit tests only.

## Second live check: agent turn after a direct edit (final wave)

**Result: PASS. Resumed: yes.** After an editor save (v2), a real Haiku turn on the same format resumed the session and made v3. v3 keeps the title text and both positions from v2 and changes only the background (and, on its own initiative, the two text colours).

### Setup

Same method as the check above, in a fresh scratch folder:
- a throwaway core started by the 10b driver, with an in-memory vault, a config dir inside the scratch folder, and the worktree's existing `packages/web/dist` (not rebuilt);
- the 10b `claude` wrapper, which logs every spawn and tees stdin and stdout; mode `real` for the two agent turns and `forbid` during the editor save;
- model `haiku`, `sandboxMode: auto`, the calling session's Claude Code variables stripped;
- one project, one format (`instagram-reel-9x16`), 4 s, text clips only; no browser and no app, everything through the API.

### Steps

1. **v1 (real Haiku).** Light grey background `#e5e7eb`, title "Autumn sale" at x 60, y 840, label "SHOP" at x 60, y 260. The `sessionId` was kept. 10 turns, 32 s.
2. **Direct save, v2.** `POST …/edits` with `baseVersion: 1` and three `clipProps` ops: title text "Zebra Moonlight 7731", title position x 137, y 1333, label position x 211, y 455. Response `{"version":2}`. The entry has `origin: "editor"`, `basedOn: 1`, no `usage`, the `sessionId` carried over from v1 and no `userDuration`. No spawn during the save and no ledger line. `work/editor/<format>/` is an exact copy of v2.
3. **Agent turn, v3.** "Change the background colour to dark blue." on the same format. The argv has `--resume` with the v1 session, and the stream reports the same session. 9 turns, 20 s, 0 approvals, `basedOn: 2`.

### Evidence

- **Titles and positions identical** in v2 and v3: text "Zebra Moonlight 7731" at x 137, y 1333; "SHOP" at x 211, y 455.
- **Background changed:** `#e5e7eb` to `#0b1f4a`.
- **`diff v2 v3` has 3 lines:** the background, and both text colours `#111827` to `#ffffff`. Everything else is byte for byte the same.
- **Prompt section**, from the recorded stdin:

```
## Direct edits by the user
v2 contains direct edits by the user: Direct edits: title text, title position, shop-label position. Build on v2; keep those edits unless the user asks to change them.
- `creatives/2026-10-13-edit-keep/work/editor/<format-id>/` is the current source of that format (instagram-reel-9x16): an exact copy of `creatives/2026-10-13-edit-keep/outputs/v2/compositions/<format-id>/` with the user's edits. Build on it; any other copy of its composition elsewhere in `creatives/2026-10-13-edit-keep/work/` is superseded.
- Your generators and scripts in `creatives/2026-10-13-edit-keep/work/` predate these edits: if you run one again, reapply the edits to what it produces; otherwise edit the composition directly.
- Keep the values the user set (texts, colours, fonts, positions, timing, durations) and keep the files under `assets/lib/` of those compositions: copy them with the composition.
```

The agent compared the editor copy with `outputs/v2/`, copied from `outputs/v2/` (the two are identical), made three `Edit` calls, then ran `validate_composition` (no problems) and `preview_frames`. It wrote no generator script.

### Cost

$0.0207 in total: v1 $0.0139, v3 $0.0068. The editor save cost nothing.

### mtimes

Unchanged before and after, for `~/Library/Application Support/Motion Studio`, `~/MotionStudio` and `~/Library/Application Support/Motion Studio Electron`; `~/Library/Application Support/Electron` was absent both times.

### Concerns

- The agent changed more than it was asked: it set both text colours to white for contrast. A colour the user had set in the editor would be at risk from the same reasoning on a background change; the prompt's "keep the values the user set" is the only guard.
- This is a single Haiku sample on a simple text-only composition. It does not measure reliability on complex compositions or with generator scripts in `work/`.
- The prompt names `work/editor/<format-id>/` as the source, but the agent copied from `outputs/v2/`. The result is the same here because the two are identical.
- After the v3 turn the editor copy still holds v2. This is by design: `alignEditorCopies` removes it at the start of the next turn, and nothing reads it in between.
- Claude Code again created the empty `.claude/.cc-writes/` in the creative folder (D4 above); this time the conversation has no tripwire notice.
