# Motion Studio — Fase 9: Versioni per formato — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each format gets its own history, its own ★ export pick and an optional link to an identical format. Changes can target specific formats. Adding a compatible format costs zero tokens. Exporting the ★ versions uses a configurable name pattern. Compare puts synced side-by-side players for video.

**Architecture:**
- **Creative versions stay as they are**: `outputs/vN/`, `versions.json` and a commit per version.
- **Per-format history** is derived from content hashes (`OutputFileInfo.sha256`).
- **New optional data**:
  - in `creative.json`: `exportPicks`;
  - in the brief: `links`;
  - in the turn request: `formats`;
  - in the workspace settings: `exportNamePattern`.
- **Core**:
  - carries unchanged outputs over;
  - materializes linked formats by copy;
  - adds formats without the agent when possible.
- **Web**:
  - per-board version badge and popover;
  - "Applies to" in the composer;
  - Link and Unlink;
  - new Compare and Export dialogs, ported from the prototype.

**Tech Stack:** TypeScript, zod, Fastify, React 19, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-motion-studio-phase9-format-versions-design.md`, together with the program spec, the phase 7 UI conventions and the phase 8 usage data.

## Global Constraints

- **Version identity.** `vN` (the creative version number) stays the only version identifier everywhere: UI, API, export names. No per-format renumbering.
- **No migration rewrites.**
  - `sha256` is optional, computed lazily for old versions, and cached in memory and in a sidecar file `outputs/vN/.hashes.json`, written by the core and ignored by validation.
  - Old `versions.json`, `creative.json` and briefs stay valid.
- **Copies, never hard links.** The `nlink > 1` checks of confined reads stay unchanged.
- **Carry-over and materialization.**
  - They happen in the core, after the agent's validation and before the commit, inside the same version folder.
  - A carried or materialized file is byte-identical to its source: verify with sha256 after copying.
  - Validation of carried files checks presence and dimensions, and never asks the agent to fix a file it didn't make.
- **The ★ rule** (spec §2.2):
  - the default is the latest problem-free version in the format's history;
  - a manual pick sticks until the user picks the latest again, which clears it;
  - followers have no ★ of their own.
- **Adding formats without the agent** (spec §2.4) is allowed **only** if every added format can follow a primary present in the latest version. It must start **zero** `claude` processes: assert this in tests with the fake runner.
- **Export name pattern.**
  - Tokens: `{title} {channel} {format} {ratio} {v} {date}`.
  - The result is slugified per token and limited to 120 characters before the extension.
  - Collisions inside one export are refused before any copy.
  - Safety rules are unchanged: no overwrite (suffix `-2`), confinement, workspace destinations refused.
- **UI and text.**
  - Phase 7 rules apply: no native controls, no literal colors, motion only from `motion/`, AA contrast.
  - All text comes from the `en`/`it` catalogs.
- **Safety.**
  - Live checks run in a temporary environment with Haiku and keep the real folders untouched (check mtimes).
  - No push, PR, release or publish.
  - Commit trailers as usual.
  - Every commit keeps `pnpm test`, `pnpm typecheck` and `pnpm check:i18n` green.

## Review Focus

1. **Targeted turns and the fix loop.**
   - A fix attempt in a `formats: ['reel']` turn must not re-ask for, or overwrite, the carried post.
   - If the agent nonetheless writes a file for a non-target format, the core keeps the **carried** file, and records a note.
   - Covered in Task 3.
2. **Followers with mismatching durations.**
   - The primary is 75 s and Shorts is limited to 60 s: Shorts is not linkable, the UI explains why, and the agent gets Shorts as its own format.
   - The link is re-checked at each version. If the primary grows past the follower's limit, the follower is unlinked automatically for that turn and the chat says so.
   - Covered in Tasks 2 and 3.
3. **★ with incomplete versions and deleted or missing files.**
   - A manual pick on a version whose file is missing on disk: export reports it as skipped.
   - The default ★ never points at a version with problems when a clean one exists.
   - Covered in Task 2.
4. **Synced players.**
   - Different durations, a seek while playing, rate changes, one video failing to load.
   - Drift correction must not cause jitter: correct only beyond 1 frame, at most every 250 ms.
   - Covered in Task 6.
5. **Export name pattern edge cases.**
   - Empty pattern, only `{v}`, emoji titles, very long titles, two formats producing the same name, `/` or `..` in the title.
   - Covered in Task 5.

---

### Task 0: Board polish from the user's feedback (2026-10-09)

**Files:**
- Modify: `screens/CreativeCanvas.tsx`
- Modify: `screens/ProjectCreatives.tsx` (if the same bar exists there)
- Test: extend the canvas test

**Requirements:**
- **Remove the per-board progress bar during generation.** It shows under only one board, which looks as if only that format is being worked on. Progress is already visible in the chat and as "Rendering…" on every board.
- **Board header on two lines on every board**, vertical or horizontal:
  - line 1: the format name (channel · name) and, from Task 4, the version badge;
  - line 2, as a muted subtitle: ratio · duration · state ("Rendering…", "Ready", warnings).
  
  Today these elements share one line, which wraps on vertical boards but not on horizontal ones. With the phase 7 screen-space labels, the header keeps a constant size at any zoom.

- [ ] **Step 1. Failing tests:**
  - no progressbar inside boards while a job runs;
  - each board header has a title row and a subtitle row containing the state.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `fix(web): board headers on two lines, no per-board progress bar`.

---

### Task 0b: Integrated desktop title bar (user feedback, 2026-10-09)

Today the desktop window uses the default system frame: a system title bar holding only the window controls, with the app's own top bar below it, so the app looks like it sits "inside a window". Users expect what other macOS apps do: window controls inside the app's own top bar.

**Files:**
- Modify: `apps/desktop/src/window.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `packages/web/src/desktop.ts`
- Modify: `packages/web/src/shell/TopBars.tsx` (and the creative and format top bars)
- Modify: `ui.css`
- Test: `apps/desktop/test/window.test.ts`
- Test: extend the shell tests

**Requirements:**
- **macOS:** `titleBarStyle: 'hiddenInset'` with `trafficLightPosition` vertically centred in the 48 px top bar.
- **Windows and Linux:** `titleBarStyle: 'hidden'` plus `titleBarOverlay`:
  - `{ color, symbolColor, height: 48 }` taken from the current theme tokens;
  - updated with `win.setTitleBarOverlay` when the theme changes, through a small validated IPC from the renderer: `ms:titlebar-theme`, with `'light' | 'dark'` only.
- **`backgroundColor`** uses the new tokens (dark `#0F0F0F`, and the light `--bg`), no longer the old values.
- **Web top bars:**
  - every top bar is a drag region (`-webkit-app-region: drag`), and every interactive element in it is `no-drag`;
  - double-click on an empty area of the bar keeps the OS behaviour (zoom or maximize);
  - when `desktop()?.platform === 'darwin'` and the window is not fullscreen, the bar gets left padding (about 78 px) so the traffic lights don't overlap the logo;
  - on Windows and Linux, right padding equals the overlay width.
- **Fullscreen:** main sends `ms:fullscreen` (a boolean) on `enter-full-screen` and `leave-full-screen`, exposed in the preload as `onFullscreenChange(cb)`. The bar drops the traffic-light padding in fullscreen.
- **Web (non-desktop):** no change.

- [ ] **Step 1. Failing tests:**
  - `windowOptions('darwin')` has hiddenInset and the traffic light position;
  - `windowOptions('win32')` has the overlay with the dark-theme colours;
  - the IPC rejects values other than light or dark;
  - the top bar has the drag class and buttons are no-drag;
  - darwin non-fullscreen padding is applied, and removed in fullscreen.
- [ ] **Steps 2–4.** FAIL → implement → PASS. Run the desktop smoke test with a temporary config. Take a screenshot of the window in light and dark (dev build) to check the traffic lights' alignment.
- [ ] **Step 5. Commit:** `feat(desktop): integrated title bar with native window controls in the app bar`.

---

### Task 1: Shared types, the catalog link rule and hashes

**Files:**
- Modify: `packages/shared/src/creative.ts` (`OutputFileInfo.sha256?`, `CreativeFile.exportPicks?`, `Brief.links?`, manifest file entry `followsFormat?`)
- Modify: `packages/shared/src/schemas.ts` (`exportNamePattern`)
- Modify: the format catalog types
- Create: `packages/shared/src/formats/link.ts`
- Test: `packages/shared/test/format-link.test.ts`
- Test: extend the schema tests

**Interfaces (Produces):**
```ts
export function canFollow(primary: FormatPreset, follower: FormatPreset, primaryDurationSec: number | null): { ok: true } | { ok: false; reason: 'kind'|'size'|'extension'|'duration'|'safeZone' };
export function defaultLinks(formats: FormatPreset[]): Record<string, string>; // follower → first compatible primary, stable order
export function formatHistory(versions: VersionEntry[], formatId: string): number[]; // version numbers where the file is new or changed (by sha256; a missing hash counts as changed)
export function starOf(versions: VersionEntry[], formatId: string, picks: Record<string, number> | undefined, links: Record<string, string> | undefined): { version: number | null; manual: boolean; newer: number | null; follows: string | null };
```
- `exportNamePattern: z.string().min(1).max(200).default('{title}-{format}-v{v}')`.
- Safe zone compatibility: the follower's safe area must contain the primary's safe area, so content placed safely for the primary is also safe on the follower. If the catalog lacks the data, use the size check only, and document it.

- [ ] **Step 1. Failing tests**, table-driven:
  - `canFollow`:
    - Reel→TikTok ok;
    - Reel→Shorts ok at 30 s, `duration` at 75 s;
    - 9:16→1:1 `size`;
    - video→image `kind`;
  - `defaultLinks` on [Reel, TikTok, Shorts, Post 1:1] links TikTok and Shorts to the Reel;
  - `formatHistory`: changes at v1, v3 and v5 give [1, 3, 5];
  - `starOf`:
    - the default picks the latest clean version;
    - a manual pick reports `newer`;
    - a follower reports `follows`.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(shared): per-format history, star rule and format linking`.

---

### Task 2: Core — hashes, picks and links in the store and API

**Files:**
- Modify: `packages/core/src/creatives/creative-store.ts`
- Modify: the version recording in `creative-turns.ts`
- Modify: `creative-routes.ts`
- Modify: `packages/web/src/api.ts`
- Test: `packages/core/test/format-versions.test.ts`

**Interfaces:**
- When a version is recorded:
  - compute `sha256` for every output by streaming;
  - store it in `OutputFileInfo`.
- For old versions, `GET` of a creative fills the missing hashes lazily:
  - in parallel, limited to 2;
  - cached in `.hashes.json`, keyed by file size and mtime;
  - a missing file gets `sha256: null`.
- Routes:
  - `PUT /api/projects/:slug/creatives/:c/export-picks`, body `{ format, version | null }`:
    - `null` clears the pick;
    - picking the latest also clears it;
    - validate that the format is in the brief, that it is not a follower, and that the version is in the format's history;
  - `PUT /api/projects/:slug/creatives/:c/links`, body `{ follower, primary | null }`:
    - validate with `canFollow` against the primary's latest duration;
    - on failure respond 400 with a translated reason.
- The creative `GET` response gains a per-format summary computed in the core:
  `formats: { id; history: number[]; star: ReturnType<typeof starOf>; linkable: { primary: string; ok: boolean; reason? }[] }[]`.
- New creatives get `brief.links = defaultLinks(...)`.

- [ ] **Step 1. Failing tests:**
  - hashes are recorded;
  - old versions get lazy hashes, and the cache is reused;
  - pick routes (set, clear, latest clears, follower refused, version not in the history refused);
  - link routes, including a duration failure;
  - the creative GET summary;
  - Review Focus 3: a pick on a missing file is reported.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): output hashes, per-format summary, export picks and links`.

---

### Task 3: Core — targeted turns, carry-over, materialized followers, formats added without the agent

**Files:**
- Modify: `creative-turns.ts`
- Modify: the delivery prompt
- Modify: `output-contract.ts`
- Modify: the turn route (`formats?`)
- Test: `packages/core/test/targeted-turns.test.ts`
- Test: `packages/core/test/add-formats-no-agent.test.ts`

**Interfaces:**
- **The turn request** accepts `formats?: string[]` (target formats). Normalization:
  - remove unknown formats;
  - map followers to their primaries;
  - an empty or absent list means all primaries.
- **The agent's prompt** lists only the target formats. It says the other formats are kept unchanged by Motion Studio and must not be touched.
- **After the agent's attempt and its validation:**
  1. copy the non-target primaries from the base version (`resumeFrom` or the latest), verifying sha256 after the copy;
  2. if the agent wrote a file for a non-target format, replace it with the carried file and add a note to the version: `outputs.keptUnchanged` with params `{format}`;
  3. re-check each link with `canFollow`:
     - if a link fails, the follower is **not** materialized for this turn;
     - the turn message explains it;
     - the next turn treats the follower as its own primary;
  4. materialize each linked follower by copying the primary's file into `<follower>.<ext>`;
  5. update the manifest, with `followsFormat` on followers;
  6. validate the whole version and commit.
- **The fix loop** only re-asks about the target formats.
- **Adding formats** (a brief update with more formats, then Generate). If every new format `canFollow` a primary of the latest version:
  - do not start the agent;
  - create `v(N+1)` by copying the latest outputs and materializing the new followers;
  - set `request` to "Added TikTok, Shorts using the Reel (v5)";
  - set usage to none;
  - emit the chat entry;
  - in tests, assert that the fake runner was never called.
  
  Otherwise, run the normal turn with the non-linkable new formats as targets. The linkable ones are materialized.

- [ ] **Step 1. Failing tests:**
  - `formats: ['reel']`:
    - the prompt lists only the reel;
    - the post is carried with the same sha256;
    - the post's history doesn't grow;
  - the agent overwrites the post → the post is kept and a note is added (Review Focus 1);
  - fix loop on the reel only;
  - follower materialization and the manifest `followsFormat`;
  - a link broken by duration is not materialized and the message is shown (Review Focus 2);
  - adding TikTok and Shorts → `v(N+1)` with zero runner calls;
  - adding TikTok and a 16:9 → the agent runs for the 16:9 only and TikTok is materialized.
- [ ] **Steps 2–4.** FAIL → implement → PASS. Update `docs/output-contract.md`:
  - targeted turns;
  - carried and followed files;
  - `followsFormat`.
- [ ] **Step 5. Commit:** `feat(core): targeted turns, carried outputs, linked formats and agent-free format additions`.

---

### Task 4: Web — badges, popovers, ★, links and "Applies to"

**Files:**
- Modify: `screens/CreativeCanvas.tsx`
- Modify: `screens/FormatView.tsx`
- Modify: the composer in `components/Conversation.tsx`
- Modify: `screens/NewCreative.tsx` (link icons become real toggles)
- Modify: the catalogs
- Test: extend the canvas, format view, conversation and NewCreative tests

**Requirements (spec §3.1 and §2.5, porting the prototype `VersionsPopover`, the board header and the format column):**
- **Board badge** "★ v5 ▾":
  - a popover with the format's history: thumbnail, `vN`, time, note and tokens (phase 8 data), plus a clickable ★;
  - footer: Compare and Restart from here;
  - "viewing v3" when the user views a non-★ version.
- **Format column rows** show "★ v5" or "follows Reel".
- **Follower boards** show the primary's file, with the chip "Linked to Reel" and a menu holding "Unlink — make a dedicated version". Unlinked compatible formats offer "Link to Reel".
- **The top-bar version selector** becomes "Versions": the creative timeline, with "Restart from here" and "Show in Finder".
- **Composer "Applies to"**:
  - chips for the primaries plus "All formats";
  - default: the formats of the attached pins, else All;
  - followers can't be chosen and show a tooltip;
  - the value is sent as `formats`.
- **New creative**: the link icon on linkable tiles is now a real toggle, on by default, with a tooltip giving the reason when not linkable. It's sent as `brief.links`.

- [ ] **Step 1. Failing tests:**
  - badge and popover per board;
  - ★ click → API call and toast;
  - "viewing";
  - follower board chip and Unlink → API;
  - "Applies to" defaults to the pin formats and sends `formats`;
  - the New creative link toggle sends `links`;
  - a non-linkable tile shows the reason.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(web): per-format versions, star picks, linked formats and targeted requests`.

---

### Task 5: Core and web — exporting the ★ versions with a name pattern

**Files:**
- Modify: `packages/core/src/creatives/export.ts`
- Modify: the export route
- Modify: `packages/web/src/screens/ExportDialog.tsx`
- Modify: `api.ts`
- Modify: the catalogs
- Test: extend `export.test.ts` and `ExportDialog.test.tsx`

**Interfaces:**
- `exportVersion` becomes `exportPicks({ creativeDir, picks: Record<formatId, number>, pattern, title, slug, destination, forbiddenRoot })`. Followers resolve to their primary's ★ file but are named after the follower.
- `renderName(pattern, vars)`:
  - slugifies each token value;
  - joins the literals;
  - collapses separators;
  - limits the result to 120 characters;
  - returns an error key for an empty result.
- Collisions are detected before copying, and the call responds 400 with the colliding names.
- **Dialog** (porting the prototype `ExportDialog`): "Export the starred versions", with rows for:
  - thumbnail;
  - final name;
  - "★ v5", plus "v7 newer" when there is one;
  - a checkbox;
  - "follows Reel" for followers.
  
  Plus:
  - a name pattern field with token chips to insert, a live preview of the first name, and "Save as default", which calls `updateSettings({exportNamePattern})`;
  - an inline collision error;
  - the rest as in phase 7: folder, progress, success, Show in Finder.

- [ ] **Step 1. Failing tests:**
  - Review Focus 5 cases;
  - followers named after themselves with the primary's file;
  - a pick pointing to a missing file is skipped;
  - the dialog preview updates and saving the default calls the API.
- [ ] **Steps 2–4.** FAIL → implement → PASS. Update the README export section.
- [ ] **Step 5. Commit:** `feat: export starred versions with a configurable name pattern`.

---

### Task 6: Web — the new Compare (synced video)

**Files:**
- Modify: `packages/web/src/screens/CompareDialog.tsx`
- Create: `packages/web/src/ui/useSyncedMedia.ts`
- Modify: the catalogs
- Test: `test/compare-video.test.tsx`
- Test: extend `CompareDialog.test.tsx`

**Requirements (spec §3.2):**
- Pick two versions from the format's history with chips. The ★ version is marked.
- **Images:** the slider overlay stays the default, plus a "Side by side" toggle.
- **Video:**
  - "Side by side" is the default, with two `<video>` elements labelled with their versions;
  - one shared transport: play and pause (Space), a scrub bar over the longer duration, frame step ←/→ at 1/30 s, loop and rate (shared code with FormatView where possible);
  - an "Overlay" mode: the slider over the two paused frames.
- **`useSyncedMedia(leader, follower)`**:
  - the follower mirrors play, pause, rate and seek;
  - on `timeupdate` it corrects drift beyond 1/30 s, at most every 250 ms;
  - past the follower's duration, it holds the last frame;
  - if one video fails to load, it shows an error on that side and the other keeps working.
- Actions: "★ Use vA for export" and "★ Use vB for export".

- [ ] **Step 1. Failing tests**, with fake media elements whose currentTime and paused are controllable:
  - play and pause propagate;
  - seek syncs;
  - drift beyond the threshold is corrected, within the threshold it isn't, and correction is throttled;
  - different durations hold the last frame;
  - an error on one side;
  - Space and the arrows;
  - the ★ actions call the API;
  - the image slider stays the default.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(web): compare videos side by side with a shared synced transport`.

---

### Task 7: Live verification and docs

- [ ] **Step 1. Live check.** In a throwaway environment, with Haiku and the built UI, create a creative with Reel 9:16 and Post 1:1 at 6 s. Then:
  - request a change with "Applies to: Reel": the post's sha256 is unchanged and its history doesn't grow, and tokens are spent only on the reel;
  - add TikTok and Shorts: a new version within seconds, zero `claude` runs and zero tokens in the ledger;
  - star an older Reel version;
  - export with the pattern `{channel}-{ratio}-v{v}` and check the names;
  - compare two Reel versions side by side, then check that the sync works when played in a visible browser window. Screenshot it.
- [ ] **Step 2. Screenshots** in light and dark, at 1440 px:
  - the board badge and popover;
  - the follower board;
  - Applies to;
  - Export;
  - Compare for video and for image.
- [ ] **Step 3. Docs.** Update `docs/visual-test-2026-10-08.md` (point 42 and the configurable names) and `docs/decisions-log.md` with the phase 9 decisions. Check the real folders' mtimes.
- [ ] **Step 4. Commit:** `docs: phase 9 verification and decisions`.
