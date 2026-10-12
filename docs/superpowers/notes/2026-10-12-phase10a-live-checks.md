# Phase 10a — live verification (Task 9)

Date: 2026-10-12. Claude Code 2.1.296, model `haiku`, macOS (Darwin 25.6), Node 24.9, Electron 44.7.0. Branch `feat/phase10a-compositions-render` at `592ca46`, built in the phase 10a worktree (`pnpm build`, then `pnpm --filter motion-studio-desktop build`).

**Verdict:** the phase works end to end live: the agent delivers compositions and never renders, the storyboards and the live preview show in the desktop app, Render produces valid mp4 and png files, the ★ export copies them, a change request keeps the phase 9 history, a creative made by the phase 9 build converts, the CLI renders with system Chrome, and the Chrome for Testing consent flow works against a fake endpoint. Two defects were found and not fixed (a live preview that sometimes stops at a session renewal, and a misleading per-board progress during a multi-format render). The packaged app could not be isolated from the real Electron data folder: its launch wrote there (see "Incident").

The machine was **not quiet**: the 1-minute load average stayed between 140 and 270 for the whole run (other projects). The timings below are recorded with it.

| Check | Result |
|---|---|
| New creative (Reel 9:16, Post 1:1, Image 1:1): the agent delivers compositions, no render, no installs | **PASS** |
| Storyboards appear on the boards and in the format view's scene strip | **PASS** |
| Live preview plays in the desktop app (other origin, `sandbox="allow-scripts"`) | **PASS** |
| Render ★: valid mp4 (1080×1920, 1080×1080) and png (1080×1080) | **PASS** |
| Export of the ★ versions: byte-identical copies | **PASS** |
| Change request "Applies to: Reel": history as in phase 9 | **PASS** |
| Legacy creative made by the phase 9 build (main `a4230fc`) converts on the next change | **PASS** |
| Render timings 6 s and 15 s at 1080×1920 | **RECORDED** (machine not quiet) |
| CLI bundle with system Chrome renders; it finds the runtime dist | **PASS** |
| Chrome for Testing consent flow against a fake loopback endpoint | **PASS** |
| Preview keeps playing across a session renewal | **FAIL (intermittent)**, see D1 |
| Quit during a render: close prompt, no output, no temp files, job cancelled | **PASS** |
| Packaged build (`electron-builder --dir`, unsigned): `Resources/runtime` present | **PASS** |
| Packaged app finds the runtime at run time (preview or storyboard) | **NOT VERIFIED**, stopped: see "Incident" |
| Screenshots light and dark | **PARTIAL**: render progress only in light; one minor UI defect, D2 |

## Setup

- Everything lived in the session scratchpad, `phase10a-live/`: config, workspace, Electron data, exports, the packaged app, logs.
- **Throwaway core** (CfT and session-renewal checks): `startServer({ port: 0, configDir, vault: new MemoryVault(), claudeCommand: [wrapper], webDir: <worktree>/packages/web/dist, systemLocales: ['en'] })`, run with `node --experimental-transform-types` from a driver under the scratchpad that refused to start unless the config dir was inside it. Two test-only load hooks changed constants in the loaded source and nothing on disk: the Chrome for Testing manifest URL (pointed at the fake endpoint) and the preview session TTL (90 s instead of 30 min).
- **Desktop app**: the built `apps/desktop/dist/main.cjs`, started by a bootstrap in the scratchpad with the worktree's Electron binary, `--use-mock-keychain`. Before `main.cjs` loaded, the bootstrap:
  - pointed `appData`, `userData`, `sessionData`, `logs` and `crashDumps` at the scratchpad (the app then put its own `Motion Studio Electron` folder there);
  - replaced `@napi-rs/keyring` with an in-memory stand-in (Node `module.registerHooks`), so the core's keychain was never the real one;
  - recorded the app's message boxes and answered them;
  - exposed a loopback control port for `executeJavaScript` and `capturePage`.
- `MOTION_STUDIO_CONFIG_DIR` pointed at the scratch config and `MOTION_STUDIO_CLAUDE_COMMAND` at a wrapper of the real `claude` that recorded cwd and argv and tee'd the stream-json; `claude auth` passed straight through.
- The calling session's Claude Code variables were removed; the user's `CLAUDE_CONFIG_DIR` login stayed (as in phases 8 and 9).
- An approvals watcher would have answered `once`: it received **0** requests in the whole run.
- Settings: `model: haiku`, `sandboxMode: auto`, `autoApproveSandboxed: true`, language English (the first turn ran in Italian, the system language, before the switch). One project, `demo`.
- Every process was stopped by its own recorded PID, after checking its command line. Nothing was killed by pattern.

## 1. New creative and the agent's turn

"Autumn sale", 6 s: Story/Reel 9:16, Post 1:1 and **Image 1:1**. The image format is not in the brief's Step 1. It was added so that one render produced a png as well.

- The turn took 70 s (one run, no fix attempt). Tools: `report_progress`, `read_brand_kit`, `fonts_fetch` (Inter from Google Fonts, through the core's tool), three Bash calls (`ls`, `mkdir -p`, `cp` of the font files into each composition's `assets/`), three `Write` of `composition.json`, `validate_composition`, four `preview_frames`.
- **No render, no installs:** no npm, pip, venv, Python or ffmpeg call. The prompt has no `renderCommand`, and `versions.json` records `renderCommand: null`.
- `outputs/v1/` held only `compositions/<id>/{composition.json,assets/}` and the core's `manifest.json` (`schemaVersion: 2`, three compositions, `renders: []`).
- Boards after the turn: "★ v1 · Not rendered" with a storyboard image each. The storyboards were in `.studio/cache/storyboards/<creative>/v1/<format>/` (two frames for each video, one for the image).

## 2. Live preview

- Format view of the Reel: the scene strip shows the storyboard thumbnail; Play loads the live player. It played (`00:02.95 / 00:06.00` in the capture) with the text animating in.
- The frame: `http://127.0.0.1:<composition server port>/<token>/runtime/index.html?mode=preview…`, a different origin from the UI (`:4318`), `sandbox="allow-scripts"`, `allow="autoplay"`.

## 3. Render ★ and export

- "Render ★" on the canvas started one render job for the three formats (toast "Rendering 3 formats"). It finished in **39.1 s**.
- Outputs (ffprobe, then a full ffmpeg decode with no errors):

  | Format | File | Stream |
  |---|---|---|
  | Reel 9:16 | `instagram-reel-9x16.mp4`, 479 KB | H.264 yuv420p 1080×1920, 30 fps, 180 frames, 6.000 s, BT.709 primaries/transfer/matrix, limited range |
  | Post 1:1 | `instagram-post-1x1.mp4`, 568 KB | H.264 yuv420p 1080×1080, 30 fps, 180 frames, 6.000 s, BT.709 |
  | Image 1:1 | `instagram-image-1x1.png`, 53 KB | PNG 1080×1080 RGB |

- `manifest.json` `renders[]` and `versions.json` `outputs` record each file with `sha256` and `fromComposition` equal to the composition hash.
- Export of the ★ (v1 of each) to a scratch folder: `autumn-sale-instagram-reel-9x16-v1.mp4`, `…-post-1x1-v1.mp4`, `…-image-1x1-v1.png`, each byte-identical to its render (sha256 compared).

## 4. Change request (phase 9 history)

- Turn with `formats: ['instagram-reel-9x16']`: "15 seconds long and a burgundy background".
  - The agent edited only the Reel's `composition.json` (`Edit`).
  - The output check refused 15 s, because the brief says 6 s ("The composition lasts 15s, but about 6s were requested"). The fix attempt set 6 s back and kept the burgundy. This is the contract working; the agent explained it and offered to change the brief.
- v2: Reel hash `1c763c2a…` (new), Post `0993f109…` and Image `a12a37af…` identical to v1. The Post and Image renders were carried with their sha256 (`9424698c…`, `10803bda…`), not rendered again.
- Histories: Reel `[1, 2]` (★ v2, "Not rendered"), Post `[1]`, Image `[1]`: as in phase 9.

## 5. Legacy creative

- Made with the **phase 9 build**: a detached `git worktree add` of main `a4230fc` under the scratchpad, `pnpm install --offline` (9 s), its core run from the sources on the same throwaway config and workspace. One Haiku turn: "Legacy promo", Reel 9:16, 4 s; the agent rendered with Pillow and ffmpeg (v1 manifest, an mp4). The worktree was then removed, `git worktree list` showed only the three earlier worktrees, and no branch was created (detached).
- In the phase 10a app the board showed the legacy mp4 ("4 s · Ready"). A change request ("text colour warm yellow") posted "Converting to the editable format · costs more tokens this once", and v2 is a composition (`schemaVersion: 2`, 4 s, the same text and colours, `#FFD25A`). History `[1, 2]` (a legacy → v2 boundary counts as changed), ★ v2 "Not rendered". A later render of v2 produced a valid 4 s mp4.
- The phase 9 build had posted, during the legacy creative's very first turn, "Warning: during this run, folders that hold Motion Studio's records changed in a way Motion Studio did not make (creatives/2026-10-12-legacy-promo)". Nothing was moved. This is the phase 9 build's tripwire, not phase 10a, and no 10a turn showed it. See "Concerns".

## 6. Render timings (1080×1920, 30 fps)

| Render | Engine | Duration | Time | Load average (1 min) at start → end |
|---|---|---|---|---|
| Reel v1 inside the 3-format job (the job's first format) | Electron (desktop) | 6 s | 24.8 s | 176 → 172 |
| Reel v2 alone | Electron (desktop) | 6 s | 14.8 s | 268 → 251 |
| "Long reel" v1 alone | Electron (desktop) | 15 s | 32.3 s | 201 → 182 |
| "Long reel" v3 alone (CLI bundle) | system Chrome 154 | 15 s | 47.0 s | 173 → 210 |

- The 15 s compositions come from a second small creative ("Long reel", Reel only, 15 s), because the brief of the first one fixes 6 s.
- Job times are `startedAt → finishedAt`. Inside the 3-format job, the Post 1:1 took 12.7 s and the png 1.7 s.
- ffmpeg is x86_64 under Rosetta (the System check says so). A quiet machine should be much faster; these figures are an upper bound.

## 7. CLI path

- `node apps/cli/dist/main.js --no-open --port 4399` on the same throwaway config (the desktop app stopped first). The provider key variables were set to dummy values, so the CLI's vault never read the keychain.
- `GET /api/render-engine` → `{ kind: "system", version: "154.0.8037.98" }`.
- It rendered "Long reel" v3 (the version whose render had been cancelled by the quit test, still "Not rendered"): a valid 15 s 1080×1920 mp4, 450 frames. The bundled core found the composition runtime next to it (`dist/runtime`, the Task 7 fix).

## 8. Chrome for Testing consent flow (fake endpoint)

- Throwaway core with `CHROME_PATH=/nonexistent/chrome` (no system Chrome) and the manifest URL pointed at a loopback server. The server answered the manifest (`131.0.6778.85`) and a 469-byte zip with `chrome-headless-shell-mac-arm64/chrome-headless-shell`, a script that hands over to the system Chrome.
- System check: "Render engine · Not available", "Live previews, storyboards and renders need Chrome…", button "Download Chrome for Testing (about 100 MB)".
- The click fetched only metadata (`GET /manifest.json`, `HEAD /cft.zip`) and showed "Download Chrome for Testing? … 131.0.6778.85 (0.0 MB) … Nothing is downloaded until you agree" with Cancel and "Download 0.0 MB".
- `POST /api/render-engine/download {}` → 400 `consent-required`, with no request to the endpoint.
- "Download" → one `GET /cft.zip`; the state became `done` (469/469 bytes), the engine `{ kind: "cft", version: "131.0.6778.85" }`, installed in `<config>/chromium/131.0.6778.85/chrome-headless-shell-mac-arm64/`.
- No real download was made.

## 9. Session renewal (D1)

- The throwaway core with a 90 s preview TTL: the page renews the session about every 30 s (60 s before expiry). Format view of the Reel v2, Loop on, playing; the transport time and the frame's URL were sampled every 2–3 s.
- Renewals happened on time (eleven sessions in about five minutes), each mounting a new frame (the `src` never changes in place).
- **Playback continued across most renewals** (the time kept advancing over the new frame), **but it stopped at 2 of about 10**:
  - once at 5.98 s, at the loop's end;
  - once at 1.39 s.

  The transport then showed Play, and Play resumed it.
- With the real 30 min TTL this means a continuously playing preview may pause about once in ~29 minutes. Recorded as **D1**, not fixed (the cause is a race between the new frame's `ready`/seek/play and the transport state; not a small, clear fix).

## 10. Quit during a render

- "Long reel" v3 (15 s) rendering from the canvas (Render ★), at frame 0–30 of 450.
- Quit → message box "A render is still running" / "Quitting stops them: nothing half-done is kept, and you can render again later." [Stop and quit] [Keep rendering].
  - **Keep rendering**: the app stayed and the render continued (in an earlier run that render then completed normally).
  - **Stop and quit**: the app quit.
- Afterwards `outputs/v3/` held only `compositions/` and `manifest.json`: no mp4, no `.tmp`, no hidden temp output. There was no `ms-render-*` folder left in the OS temp folder and no process of the run left. On the next start the Reel v3 was "Not rendered", so the job had been cancelled, not completed. It then rendered normally from the CLI (section 7).
- Electron's own exit took 20–100 s after `exit` under this load. A minimal Electron app showed the same (23 s), so this is the machine, not the app. One early run needed a SIGKILL of its own PID after 100 s.

## 11. Packaged build

- `electron-builder --dir --publish never -c.electronDist=node_modules/electron/dist -c.npmRebuild=false` with `CSC_IDENTITY_AUTO_DISCOVERY=false`, output in the scratchpad. It took 26 s and downloaded nothing (the local Electron distribution, no rebuild).
- `Motion Studio.app/Contents/Resources/` has `app.asar`, `app.asar.unpacked`, `web/`, `mcp-studio.mjs` and `runtime/{index.html,runtime.js,layer.js,clock.js}`.
- `default_app.asar` is there too, because of `electronDist`. It is an artefact of this offline build, not of the real build.

### Incident: the packaged launch wrote to the real Electron data folder

- To check the runtime at run time, the packaged app was started with a `NODE_OPTIONS=--require <bootstrap>` meant to redirect its data folders, and with dummy provider keys.
- Electron ignores `NODE_OPTIONS` in packaged apps ("Most NODE_OPTIONs are not supported in packaged apps"). So the app used its real data folder, `~/Library/Application Support/Motion Studio Electron`.
- It was stopped (SIGTERM, own PID) after about 90 s, before any preview was opened.
- Changed entries:
  - `Network Persistent State`, `blob_storage/`, `Local Storage/leveldb/{000003.log,LOG}`;
  - the GPU and Dawn caches;
  - folder mtime 1791569359 → 1791822737.
- The localStorage is for the origin `http://127.0.0.1:4318`, the same origin as the user's real app, so it may hold UI conveniences written by this run.
- What was not touched:
  - the config folder (the run used the scratch one through `MOTION_STUDIO_CONFIG_DIR`) and `~/MotionStudio`;
  - the real keychain for provider keys (the dummy keys answer first). Chromium's own storage had `--use-mock-keychain`.
- Nothing was deleted or restored, to avoid damaging the user's data. The runtime-at-run-time check was not done: `HOME` does not move Electron's `appData` either (measured), so a packaged app cannot be isolated without an app option for its data folder.

## Tokens per run (usage ledger)

| Run | Version | input | output | cache write | cache read | shown (in + out + cw) | cost at API prices | wall time |
|---|---|---|---|---|---|---|---|---|
| Legacy promo, generation (phase 9 build) | v1 | 16 | 5,681 | 29,874 | 266,428 | 35,571 | $0.0115 | 75 s |
| Autumn sale, generation | v1 | 18 | 7,961 | 35,588 | 340,215 | 43,567 | $0.0145 | 70 s |
| Autumn sale, Reel only | v2 | 10 | 4,020 | 14,775 | 292,990 | 18,805 | $0.0079 | 41 s |
| Autumn sale, fix attempt (duration) | v2 | 6 | 1,924 | 8,590 | 206,717 | 10,520 | $0.0047 | 18 s |
| Long reel, generation | v1 | 12 | 5,597 | 33,623 | 219,388 | 39,232 | $0.0117 | 48 s |
| Legacy promo, conversion | v2 | 16 | 5,672 | 23,709 | 462,459 | 29,397 | $0.0122 | 59 s |
| Long reel, colour change | v2 | 10 | 1,504 | 11,210 | 279,795 | 12,724 | $0.0058 | 25 s |
| Long reel, title size | v3 | 10 | 1,685 | 10,447 | 333,219 | 12,142 | $0.0063 | 25 s |
| **Total** | | | | | | **201,958** | **$0.0746** | |

The conversion turn used more cache reads than a plain change (462k against about 300k), as the chat warns.

## Screenshots

There are 25 screenshots, at 1440 CSS px (2880×1800 PNG), from the desktop app and, for Chrome for Testing and the renewal, from a plain Electron window on the throwaway core. They are saved in the session scratchpad, `phase10a-live/shots/`, and not committed.

- **Light and dark:** canvas after v2 (boards "Rendered" / "Not rendered" with storyboards), converted legacy creative, Post format view with the scene (storyboard) strip, live player playing, System check, Chrome for Testing installed.
- **Light only:**
  - the agent working (still in Italian, before the language switch);
  - canvas v1 "Not rendered";
  - Reel format view and live player;
  - render started and in progress (three captures);
  - legacy creative before conversion;
  - CfT offer and consent;
  - renewal test.

  Render progress was not captured in dark: by the time the light/dark pass ran, every composition was rendered, and the scratch data was deleted before the gap was noticed.

What looks wrong:
- **D2, misleading progress.** During the 3-format Render ★, the boards of the Reel (already rendered) and of the Post (in progress) read "Rendering 0%", while the Image read "Rendering 99%". Only the format being rendered gets a figure, and finished ones do not say so until the job ends. Minor; not fixed.
- The first turn's chat is in Italian (the system language at the time), the later ones in English: expected.
- "3 commands ran in the sandbox · Details" wraps "Details" onto its own line in the narrow format-view chat (cosmetic).
- Contrast looked fine in both themes, and the strings were catalog text.

## Concerns

- **The packaged app has no isolated launch.** A smoke-style option to put its Electron data folder elsewhere would make the run-time packaged check possible without touching the user's folder.
- **Phase 9 tripwire warning** on the first generation of a new creative (main build). Nothing was moved. Not seen in phase 10a turns; worth a look on main.
- **Workspace theme.** The scratch workspace's theme setting became `light` at 17:54:59, shortly after the first desktop start, with no click on the theme control. It was set back to `system` through the API. It could not be reproduced.
- The agent's first turn fetched Inter from Google Fonts through the core's `fonts_fetch` tool. This is product behaviour, not a download by the checks.
