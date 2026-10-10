# Phase 9 — live verification (Task 7)

Date: 2026-10-10. Claude Code 2.1.295, model `haiku`, macOS (Darwin 25.6), Node 24.9. Branch `feat/phase9-format-versions` at `3d27584`, web built with `pnpm --filter @motion-studio/web build` in the phase 9 worktree.

**Verdict:** every check passes except one. The export of formats added without the agent fails (defect, decisions log 138). Nothing was fixed in this task.

| Check | Result |
|---|---|
| Change with "Applies to: Reel": post unchanged, its history doesn't grow, tokens only for the Reel | **PASS** |
| Add TikTok and Shorts: new version in seconds, zero `claude` runs, zero ledger lines | **PASS** |
| Star an older Reel version | **PASS** |
| Export the ★ with `{channel}-{ratio}-v{v}`: primaries | **PASS** |
| Export the ★ with `{channel}-{ratio}-v{v}`: the followers just added (TikTok, Shorts) | **FAIL**, see "Defect found" |
| Name collision refused before any copy | **PASS** |
| Compare two Reel versions side by side, synced playback in a visible window | **PASS** (max drift 0.2 ms) |
| Task 0c: sandboxed write to the `conversation.jsonl` of a creative created during the job | **PASS** (refused) |
| Task 0c: sandboxed write to a brand proposal `log.jsonl` | **PASS** (refused) |
| Task 3: sandboxed write into an earlier `outputs/v1/` (and `outputs/v2/`) | **PASS** (refused); the new `outputs/vN/` stayed writable |

## Setup

- Throwaway core: `startServer({ port: 0, configDir, vault: new MemoryVault(), claudeCommand: [wrapper], webDir: <worktree>/packages/web/dist, systemLocales: ['en'] })`, run with `node --experimental-transform-types` from a driver under the session scratchpad. The driver refused to start unless the config dir and the workspace were inside the scratchpad and `MOTION_STUDIO_CONFIG_DIR` pointed at the temp config.
- The calling session's Claude Code variables were removed from the driver's environment; the user's `CLAUDE_CONFIG_DIR` login stayed, as in phase 8.
- The wrapper around the real `claude` recorded cwd and argv and tee'd the stream-json. `claude auth` calls passed straight through and were never logged.
- A watcher polled `GET /api/approvals` and would have answered `once`. It received **0** requests, so no approval reached the user in the whole run.
- Settings: `model: haiku`, `sandboxMode: auto`, `autoApproveSandboxed: true`. One project, `demo`.
- Screenshots came from a plain Electron 44.7.0 window (`show: true`, 1440×900 content, so 2880×1800 PNG at 2×), using the worktree's extracted binary, with a temp `userData`/`sessionData` in the scratchpad, captured with `webContents.capturePage`. Light and dark come from `nativeTheme.themeSource`. `screencapture` isn't usable: the terminal has no Screen Recording permission.
- Afterwards the core, the watcher and Electron were stopped, and the scratch folder (config, workspace, exports, Electron data) was deleted. The screenshots are kept outside the repo.
- User folders, mtime before → after:
  - `~/Library/Application Support/Motion Studio`: 1791461297 → 1791461297 (unchanged);
  - `~/MotionStudio`: 1791538433 → 1791538433 (unchanged);
  - `~/Library/Application Support/Electron` was never created.

## The creative

"Autumn sale", 6 s: Instagram Story/Reel 9:16, Post 1:1 and **Image 1:1**. The image format is not in the brief's Step 1. It was added so that the image Compare had two image versions without a second creative (one turn fewer). Notes: flat orange background, one line of white text, no audio, Pillow + ffmpeg.

| Version | How | Formats rendered by the agent | Notes |
|---|---|---|---|
| v1 | generation from the brief | all 3 | |
| v2 | turn with `formats: ['instagram-reel-9x16']` + sandbox probes | Reel only | Reel burgundy background |
| v3 | turn with `formats: ['instagram-image-1x1']` + brand-log probe | Image only | burgundy text on cream |
| v4 | brief save adding TikTok 9:16 and YouTube Shorts 9:16, then a turn with no text | none (no agent) | |

## 1. "Applies to: Reel" (v2)

- The manifest written by the agent listed only the Reel. The core carried the post and the image from v1.
- sha256 per format:

  | Format | v1 | v2 | v3 | v4 |
  |---|---|---|---|---|
  | Reel 9:16 | `8d1e8d8a…` | `670a6fa3…` | `670a6fa3…` | `670a6fa3…` |
  | Post 1:1 | `f74f19a4…` | `f74f19a4…` | `f74f19a4…` | `f74f19a4…` |
  | Image 1:1 | `759f9bd2…` | `759f9bd2…` | `78fd77fb…` | `78fd77fb…` |
  | TikTok 9:16 | — | — | — | `670a6fa3…` |
  | Shorts 9:16 | — | — | — | `670a6fa3…` |

- Histories after v4: Reel `[1, 2]`, Post `[1]` (it didn't grow), Image `[1, 3]`, TikTok `[4]`, Shorts `[4]` (followers of the Reel).
- Tokens were spent only on the formats the request named, since the agent produced only those (see the token table).
- `git ls-files` in the project lists **0** files under `outputs/` (decisions log 131).
- No sidecar was written in `.studio/cache/hashes/`: every version here was hashed by the core right after its turn, so the lazy cache for old versions was not exercised.

## 2. Sandbox probes (Task 0c and Task 3)

The agent was told to run the commands literally, one Bash call each, and to report the output. The answers were quoted from the tool results in the stream.

**Turn v2.** Creative `2026-10-10-probe` was created through `POST /api/projects/demo/creatives` **0.4 s after the wrapper saw `claude` start**. So it was not in the job's concrete `denyWrite` list (checked in the `--settings` argv: only `autumn-sale`'s three files are listed concretely, plus the globs).

| Command | Result |
|---|---|
| `echo x >> creatives/2026-10-10-autumn-sale/outputs/v1/probe.txt` | `operation not permitted`, exit 1 — **refused** |
| `mkdir -p …/outputs/v2 && echo x > …/outputs/v2/probe.txt && rm … && echo v2-writable` | `v2-writable` — the new version folder is writable |
| `mkdir -p brand/proposals/probe && echo x >> brand/proposals/probe/log.jsonl` | `mkdir: brand/proposals: Operation not permitted` — refused, but already at the `mkdir` (no proposals folder existed) |
| `echo x >> creatives/2026-10-10-probe/conversation.jsonl` | `operation not permitted`, exit 1 — **refused**; the file stayed 0 bytes |

**Turn v3.** To test the log write itself, the folder `brand/proposals/probe/` was created **from outside** (the harness, not the agent) before the turn, standing in for an existing proposal.

| Command | Result |
|---|---|
| `echo x >> brand/proposals/probe/log.jsonl` | `operation not permitted`, exit 1 — **refused** |
| `echo x > brand/proposals/probe/control.txt && echo control-ok` | `control-ok` — the folder itself is writable, so the refusal above is the `log.jsonl` rule |
| `echo x >> creatives/2026-10-10-autumn-sale/outputs/v2/probe.txt` | `operation not permitted`, exit 1 — **refused** (v2 is an earlier version during the v3 turn) |

The sandbox `denyWrite` passed for v2 was the project files (`CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json`, `.git`, `.claude`, `.studio`), the edited creative's three core files, `creatives/2026-10-10-autumn-sale/outputs/v1`, and the globs `creatives/*/{conversation.jsonl,versions.json,creative.json}` and `brand/proposals/*/log.jsonl`.

## 3. TikTok and Shorts added without the agent (v4)

- `PUT /api/projects/demo/creatives/<c>` added the two formats to the brief. The core stored default links `tiktok-9x16 → instagram-reel-9x16` and `youtube-shorts-9x16 → instagram-reel-9x16`. The save alone creates no version: the UI then starts a turn.
- `POST …/turns {}`: the job **succeeded in 2.4 s**, measured from the request to `succeeded` while polling every 0.2 s.
- **Zero runs:** the wrapper's run count stayed at 3, `<project>/.studio/usage.jsonl` stayed at 3 lines, and v4 has no `usage`.
- Chat: "Added TikTok · Video 9:16 and YouTube · Shorts 9:16 using the Instagram · Story/Reel 9:16 (v3) · no agent needed".
  - The `(v3)` is the creative version the outputs were copied from. The Reel's own file (and ★) is v2, which can confuse a reader. See "Concerns".

## 4. ★ on an older Reel version

`PUT …/export-picks {format: instagram-reel-9x16, version: 1}` → `exportPicks: {instagram-reel-9x16: 1}`, star `{version: 1, manual: true, newer: 2}`. In the UI the badge reads "★ v1", and the popover shows "Your pick" on v1, "Auto" on v2, "v2 newer" in the header and "Reset to Auto" at the bottom.

## 5. Export with `{channel}-{ratio}-v{v}`

- Picks Reel v1, Post v1, Image v3 → `instagram-9x16-v1.mp4`, `instagram-1x1-v1.mp4`, `instagram-1x1-v3.png`. Each is byte-identical to its source (sha256 compared).
- Pattern `{channel}-v{v}` with Reel and Post → 400 `export-name-collision`, "Two formats would get the same file name (instagram-v1.mp4): add {format} to the name pattern". Nothing was copied.
- The dialog showed the same names, the live preview `instagram-9x16-v1.mp4`, and "Export 3 files".

### Defect found: the followers just added can't be exported

- TikTok and Shorts follow the Reel's ★. That ★ is either v1 (manual) or v2 (default rule: v4 is byte-identical, so it is not in the Reel's history). Neither version has a TikTok or Shorts file: they exist only from v4.
- Results:
  - the dialog disables both rows with "v1 of the Story/Reel 9:16 has no file for this format";
  - `POST …/export` with `follow: {tiktok-9x16: 2, youtube-shorts-9x16: 2}` and Reel pick 2 → 409 `export-file-missing` "…nothing was exported: TikTok · Video 9:16 v2";
  - with `follow` as a list (core resolves the ★) → 409 for v1.
- This happens with the default ★ too, not only after a manual pick. So the point-42 flow (add TikTok and Shorts, then export) cannot export them until the Reel gets a new version.
- The only way out today is a ★ on v4 through the API (accepted by the ruling on identical repeats). With it, `tiktok-9x16-v4.mp4`, `youtube-9x16-v4.mp4` and `instagram-9x16-v4.mp4` were exported, all sha256 `670a6fa3…`. The UI does not offer v4.
- Recorded as decisions log 138, not fixed here.

## 6. Compare (video and image)

- Reel, from the badge popover → Compare: side by side by default, v1 ★ (Your pick) on the left, v2 (Auto) on the right, one shared transport.
- **Sync in a visible window** (Electron, `show: true`, `backgroundThrottling: false`): the run pressed play and sampled both `<video>` `currentTime` values 10 times, every 250 ms, through `executeJavaScript`.
  - Light run: 1.564/1.564 … 4.201/4.201 s. **Max drift 0.0002 s.**
  - Dark run: 1.551/1.551 … 4.140/4.140 s. **Max drift 0.0002 s.**
  - Both videos were playing (`paused: [false, false]`). A capture was taken mid-play (`*-07-compare-video-playing.png`, transport at 00:02.55).
- Image 1:1 → Compare opens on Overlay (slider), v1 left, v3 ★ Auto right; "Side by side" switches to two panes.

## Tokens per turn (usage ledger)

| Run | Version | input | output | cache write | cache read | shown (in + out + cw) | cost at API prices |
|---|---|---|---|---|---|---|---|
| 1 generation | v1 | 14 | 6,015 | 42,244 | 219,513 | 48,273 | $0.0137 |
| 2 Reel only + probes | v2 | 20 | 5,975 | 13,439 | 496,398 | 19,434 | $0.0106 |
| 3 Image only + probe | v3 | 16 | 5,230 | 13,795 | 507,532 | 19,041 | $0.0105 |
| — add TikTok + Shorts | v4 | 0 | 0 | 0 | 0 | 0 | $0 (no run) |
| **Total** | | 50 | 17,220 | 69,478 | 1,223,443 | **86,748** | **$0.0347** |

`GET /api/usage?project=demo` gave the same total (86,748 tokens, $0.0347). The top bar showed "86.7k tokens". The cost counts against the plan.

## Screenshots

There are 18 screenshots, 9 views × light/dark, at 1440 CSS px (2880×1800 PNG). They are saved in the session scratchpad, `phase9-screens/`, and not committed:

1. canvas;
2. Reel badge popover (Auto, Your pick ★, Reset to Auto);
3. follower link menu;
4. Applies to (Reel chosen, follower notes);
5. Export with the custom pattern and the preview;
6. Compare video, side by side;
7. Compare video, mid-play;
8. Compare image, Overlay;
9. Compare image, side by side.

What looks wrong:
- **Overlap.** The canvas banner "Comments apply to v4 — use Restart from here to comment on this version." sits over the board headers of the 2nd and 3rd boards, which are TikTok and Shorts. It hides their names, their meta and the **"Linked to …" follower chip**. The chip exists in the DOM (two `.ms-fv-linkchip` at y≈70), but it can't be seen in any canvas screenshot. The banner appears because the boards show the ★ versions (v1) and not the latest (v4).
- **Clipping.**
  - The format column truncates the follower names to "Vi…" and "Sh…" next to "follows Story/Reel 9:16".
  - In the Reel's Compare, the long request note pushes "★ Use v2 for export" to the bottom edge of the dialog, where it is cut at 900 px height.
  - In the version popover, the v1 row's time wraps onto two lines ("04:32 / AM") because of the "Your pick" label.
- **Misleading state.** The follower boards show the Reel's v1 file and "Linked to" with no hint that they can't be exported (see the defect).
- Contrast looked fine in both themes, and all strings were English catalog text (no keys or untranslated text seen). The "Auto" label and the ★ marks rendered as specified.
