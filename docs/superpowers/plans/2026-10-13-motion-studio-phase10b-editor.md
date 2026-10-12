# Motion Studio — Phase 10b: Composition editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user can change a composition directly, for video and images: timeline, stage with handles, inspector, and the image layers panel. "Save as vN" writes a new version **without the agent and without tokens**. Comments can target a clip or a time range.

**Architecture:**
- **`packages/shared`:**
  - pure, tested **edit operations** on a `Composition` (`applyEdit`) and their human summary (`describeEdits`);
  - snapping and ripple helpers;
  - schema additions: clip `hidden`/`locked`, `Pin.clipId`/`Pin.range`.
- **Runtime:** a new preview command, `setComposition`, re-mounts the composition inside the same iframe and keeps time and selection. The draft preview is live with no new session.
- **Core:**
  - a route that returns a version's composition with its file list (the browser validates with the same `validateComposition`);
  - a **staging overlay** per preview session: library assets and brand fonts the draft uses, copied confined, served under the session token, copied into the new version at save;
  - **`DirectEditService.save`**: writes vN+1 from the draft, under the creative lock, through the same validation as the agent. It carries the other formats, recomputes followers, commits, regenerates storyboards and adds the conversation entry.
- **Web:**
  - an editor mode of the format view (video and image);
  - a draft store with undo/redo;
  - stage handles driven by `clipBounds`;
  - timeline with zoom and snap;
  - inspector, asset picker, layers panel;
  - "Draft · Save as vN" pill;
  - comments on clips and ranges.

**Tech Stack:** TypeScript, zod, Fastify, React 19, the existing UI kit and `motion/`. No new runtime dependencies (no drag-and-drop or colour-picker libraries): pointer events and small in-house controls.

**Spec:** `docs/superpowers/specs/2026-10-10-motion-studio-phase10-compositions-design.md` §6 (editor) and §9 (10b). The prototype is `docs/design/redesign-prototype/creative.js` (`VideoEditor`, `ImageEditor`). The prototype has no drag, resize, rotate, timeline zoom, snap, edge drag or undo: those come from the spec and this plan.

## Global Constraints

**No agent.**
- Nothing in this phase launches `claude`. Every save, staging and validation runs in the core. Tests assert the fake claude was never started for an editor save.
- An editor save uses no tokens and adds no usage ledger entry.

**One validation.**
- The browser validates the draft with `validateComposition` from `packages/shared`, against the version's file list plus the staged files.
- The core validates again at save with the same function plus `loadComposition`, and refuses anything the agent would be refused.
- The inspector never lets a value out of the schema: numbers are clamped to the schema bounds, enums come from the schema constants.

**What the editor may change** (spec §6). Exactly this list, nothing else:
- text: content, font (brand or composition fonts), size, weight, colour, alignment;
- shapes: fill and radius;
- assets: replace image, svg, video or audio from the Assets library or an upload;
- video: trim start and volume;
- audio: volume, fade in and fade out;
- clip: start and duration (edge drag), with optional ripple of the scene;
- scenes: order and duration;
- visibility: hide and lock tracks and clips;
- box: position, size, rotation, opacity;
- animations: entry and exit preset and their durations;
- html layers: their declared `params` only.

**What stays with the agent:** new clips, new layers, new custom animations, new scenes, effects. The UI says so where the user would look for it ("Ask the agent to add…").

**Security.**
- The editor never writes composition files from the web. Only the core writes, confined (`realDirChain`, `copyVerified`, atomic writes) into the new version folder.
- The staging overlay accepts only library assets (`assets/…` of the project, registered in the library) and brand font files. Paths are checked with the existing confinement helpers, never a raw path from the client.
- `setComposition` is accepted by the runtime only from the parent window, in preview mode, and goes through the existing `parseIncoming` validation. Render mode refuses it.
- A draft cannot add or change html layer `src` or any `src` outside `assets/`.

**Concurrency.**
- A save takes the same per-creative lock as turns. It is refused with a translated 409 while a turn or render job is active for the creative, and the draft is kept.
- A save names its base (`baseVersion`, `baseHash`). If the format's latest composition hash is no longer the base, the save is refused with `editor.baseChanged` and the draft is kept.

**Data.**
- The new version is a normal v2 version (`manifest.json` schemaVersion 2). `request` is the edit summary; a new optional `VersionEntry.origin: 'agent' | 'editor'` (default `'agent'` when absent) marks editor versions.
- Pins stay backward compatible: `clipId` and `range` are optional.

**Real folders.** `~/Library/Application Support/Motion Studio`, `~/Library/Application Support/Motion Studio Electron` and `~/MotionStudio` stay untouched; the test isolation guard stays on. Check mtimes before and after every live check. Any Electron launch uses `MOTION_STUDIO_USER_DATA_DIR` and logs and verifies its userData before acting.

**UI.**
- Phase 7 rules: no native controls, no literal colours outside `// color-data` lines, motion only from `motion/`, AA contrast, both themes.
- All text from the `en`/`it` catalogs.
- Keyboard: every editor action reachable by keyboard; ⌘Z / ⇧⌘Z (Ctrl on other platforms) for undo/redo inside the draft, never while typing in a text field (the field's own undo wins).

**Process.**
- No push, PR, release or publish. Never kill processes by pattern; only by PID of processes you started.
- Commit trailers exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01KxKL6zuy8dbnJieqN1eCNg`
- `pnpm test`, `pnpm typecheck` and `pnpm check:i18n` stay green. Per-file timeouts only, never global.
- Decisions go into `docs/decisions-log.md` from entry 196 on.

## Review Focus

1. **The base moves under the draft.** The user edits Reel v4 while an agent turn (started from another window, or a render) is running, or another format's turn finishes and makes v5. Save must refuse with a clear message, keep the draft, and offer "Reopen on the latest version" (which discards the draft only after confirmation). Never a silent overwrite, never a lost draft. Tests in Task 4 and Task 6.
2. **A follower that can no longer follow.** Changing a scene duration makes the composition longer than a linked follower allows (or a resize breaks its safe area). Save keeps the edit, unlinks that follower exactly as `assembleCompositions` does (warning in the chat, `unlinkFollowers`), and the follower keeps its previous version. Tests in Task 4.
3. **Leaving with an unsaved draft.** Back button, switching format or version, closing the window/app, a page reload, the agent's message composer. The user is asked (keep editing / discard / save). The draft survives a route change inside the app (module store), not a reload. Tests in Task 5.
4. **Edits that break the composition.** Shortening a scene so a clip falls outside it; dragging a clip edge past the composition end or to zero duration; a font weight the font file does not have; replacing a video with a shorter one than the clip; a locked clip or track being dragged. The UI clamps or refuses with the field's translated problem; Save is disabled while `validateComposition` reports problems; the core refuses the same. Tests in Tasks 1, 7 and 8.
5. **Precision of handles under scale and transforms.** The stage is scaled (fit, zoom), the clip is rotated and has `scale` ≠ 1 and an entry animation in progress. Dragging must move the clip by the pointer delta in composition pixels, resize from the right corner, and rotate around the box centre, with no drift after ten drags; undo restores exactly. Tests in Task 6.

---

### Task 0: Housekeeping

- [ ] Create the branch `feat/phase10b-editor` in a worktree from main `b3d3aa5` or later.
- [ ] Add icons to `packages/web/src/ui/icons.ts`: `undo`, `redo`, `unlock`, `eyeOff`, `rotate`, `music`, `scissors`, `magnet` (snap). Same drawing style as the existing set; test that `ICONS` has them.
- [ ] Commit: `chore(web): icons for the editor`.

---

### Task 1: Shared — schema additions and edit operations

**Files:**
- Modify: `packages/shared/src/composition/schema.ts` (clip `hidden?: boolean`, `locked?: boolean` on every clip type), regenerate `composition.schema.json` with `pnpm --filter @motion-studio/shared gen:composition-schema`
- Modify: `packages/shared/src/creative.ts` (`pinSchema`: `clipId?: string` (max 64), `range?: { start: number; end: number }` with `0 ≤ start < end`; `VersionEntry.origin?: 'agent' | 'editor'`)
- Create: `packages/shared/src/composition/edit/{ops.ts,apply.ts,describe.ts,snap.ts,index.ts}`
- Modify: catalogs (`editor.*` section, both locales)
- Test: `packages/shared/test/composition-edit-*.test.ts`

**Interfaces (Produces):**
```ts
export type EditOp =
  | { kind: 'clipProps'; clipId: string; props: Partial<BoxProps & TextProps & ShapeProps> }   // only the editable keys of §6
  | { kind: 'clipTiming'; clipId: string; start: number; duration: number; ripple: boolean }
  | { kind: 'clipMedia'; clipId: string; src?: string; trimStart?: number; volume?: number; fadeIn?: number; fadeOut?: number }
  | { kind: 'clipFlags'; clipId: string; hidden?: boolean; locked?: boolean }
  | { kind: 'trackFlags'; trackId: string; hidden?: boolean; locked?: boolean; muted?: boolean }
  | { kind: 'sceneDuration'; sceneId: string; duration: number }          // ripples later scenes and their clips
  | { kind: 'sceneOrder'; order: string[] }                               // permutation of scene ids
  | { kind: 'animationPreset'; clipId: string; slot: 'in' | 'out'; preset: AnimationPreset | null; duration: number }
  | { kind: 'htmlParam'; clipId: string; key: string; value: string | number }
  | { kind: 'addFont'; font: FontRef };                                   // only with a staged src (Task 3)

export type EditResult = { ok: true; composition: Composition } | { ok: false; problem: CompositionProblem };
export function applyEdit(c: Composition, op: EditOp): EditResult;        // pure; never mutates c; returns normalized output
export function describeEdits(ops: EditOp[], c: Composition, locale: Locale): string; // "Direct edits: title text, scene 2 duration…" (max 3 items + "and N more")
export function sceneOrderAllowed(c: Composition): { ok: true } | { ok: false; clipId: string }; // every clip inside exactly one scene
export function snapTime(t: number, targets: number[], thresholdSec: number): { t: number; snappedTo: number | null };
export function snapTargets(c: Composition, exceptClipId?: string): number[]; // scene bounds, clip edges, 0, duration
```
Rules:
- A locked clip, or a clip on a locked track, refuses every op except `clipFlags`/`trackFlags` (`editor.locked`).
- `clipTiming`: clamps to `[0, duration]`, minimum duration one frame (`1 / fps`); a clip with `scene` stays inside its scene unless `ripple` is set, in which case the scene grows and later scenes and clips shift. Images (duration 0) refuse timing ops.
- `sceneDuration`: shrinking below a contained clip's end refuses with `composition.clipOutsideScene` and the clip id, unless the clip can be clamped without dropping under one frame (then it is clamped). The composition `duration` follows the sum of scenes.
- `sceneOrder`: only when `sceneOrderAllowed`; moves each scene's clips with it; audio clips spanning several scenes stay in place (they belong to no scene) and are clamped to the new duration.
- `animationPreset` slot `in` = the preset animation with `start` 0 (or absent); slot `out` = the preset whose `start + duration` equals the clip duration. Only preset animations are touched; tweens and keyframes written by the agent are preserved, and if a non-preset animation occupies the slot the op refuses (`editor.customAnimation`).
- `htmlParam` checks the declared type (`text` max 2000, `color` a CSS hex, `number` finite, `image` a composition `assets/` path present in the files map passed via staging).
- `clipProps` accepts only the editable keys; unknown keys refuse.

- [ ] **Step 1. Failing tests** (table-driven, one file per op family):
  - each op on the spike fixture gives the expected composition (deep equal) and leaves the input untouched;
  - lock refusals; clamps at 0, duration and one frame; ripple shifts later scenes and clips; `sceneDuration` refusal with a clip outside; `sceneOrder` permutation and refusal; preset slots with custom animations present; `htmlParam` type checks;
  - every op result passes `validateComposition` with the fixture's file map (property-style loop over 200 random op sequences with a seeded PRNG: either a refusal or a valid composition, never an invalid one);
  - `describeEdits` en/it and the "and N more" cut;
  - `snapTime` threshold edges; the schema JSON file matches the generator; old pins without `clipId`/`range` still parse.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(shared): composition edit operations, clip flags and pins on clips and ranges`.

---

### Task 2: Runtime — `setComposition` and clip visibility

**Files:**
- Modify: `packages/composition-runtime/src/{protocol.ts,preview-bridge.ts,runtime-main.ts,mount.ts}`
- Modify: `packages/web/src/components/{CompositionPlayer.tsx,compositionPreview.ts}` (send the command, expose `setComposition(c)` on `CompositionMedia`)
- Test: `packages/composition-runtime/test/{protocol,mount,runtime-main}.test.ts`, `chrome.integration.test.ts`

**Interfaces:**
```ts
// PreviewIncoming gains:
{ type: 'setComposition'; composition: Composition; keepTime?: boolean }   // preview mode only
// PreviewOutgoing gains:
{ type: 'compositionApplied'; seq: number; errors: LayerError[] }          // after re-mount, with the same seq the UI sent
```
- The runtime re-mounts from the new composition **in the same document**: tears down the old mount (cancel WAAPI, release media and layer frames), mounts the new one, seeks to the current time clamped to the new duration (when `keepTime`), keeps the selection if the clip still exists and re-sends `clipBounds`.
- Size bound: the message is refused above `COMPOSITION_LIMITS.jsonBytes`; `parseIncoming` validates it with `compositionSchema` (structure only: semantic validation is the UI's and the core's job).
- `src` values must be paths the session can serve (base folder or the staging overlay from Task 3); an unknown asset shows the existing missing-asset placeholder, never a crash.
- Render mode ignores `setComposition` (test).
- Clip `hidden` and track `hidden` are not drawn; `muted` tracks are silent. Same in render (renderer reads the same mount).
- Re-mount must not leak: 200 consecutive `setComposition` calls keep the number of live media elements and layer frames constant (test in Chrome).
- Coalescing: `CompositionMedia.setComposition` sends at most one message per animation frame (latest wins).

- [ ] **Step 1. Failing tests:** protocol parse/refuse cases (oversized, render mode, malformed); mount teardown releases everything (jsdom counters); Chrome integration: set → frame changes at the same `t`, selection kept, 200 re-mounts without growth, hidden clip absent in the captured frame, render mode refusal.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(runtime): live composition updates in the preview and hidden clips`.

---

### Task 3: Core — editor data routes and the staging overlay

**Files:**
- Create: `packages/core/src/creatives/editor-staging.ts`
- Modify: `packages/core/src/compositions/composition-server.ts` (overlay lookup per session), `packages/core/src/creatives/previews.ts`, `packages/core/src/server/creative-routes.ts`
- Modify: `packages/shared/src/render-views.ts` (views below)
- Test: `packages/core/test/editor-staging.test.ts`, `packages/core/test/editor-routes.test.ts`

**Interfaces:**
```ts
// GET /api/projects/:slug/creatives/:c/versions/:n/compositions/:format
export type EditorCompositionView = { n: number; format: string; primaryFormat: string; hash: string; composition: Composition; files: { path: string; size: number }[]; fonts: EditorFontOption[] };
export type EditorFontOption = { family: string; weights: number[]; source: 'composition' | 'brand'; brandFontId?: string; staged: boolean };

// POST /api/projects/:slug/creatives/:c/editor/stage   body: { token: string; from: { kind: 'library'; file: string } | { kind: 'brandFont'; id: string } }
export type StagedAsset = { path: string; size: number; kind: 'image' | 'svg' | 'video' | 'audio' | 'font'; width?: number; height?: number; durationSec?: number | null };
```
- The view is for the **primary** composition: asking for a follower answers with its primary's composition and `primaryFormat` set (the UI says "Editing Reel · also used by TikTok, Shorts").
- Staging is tied to a live preview session token of the same creative and version. The core copies the library file (resolved from the library registry, confined to the project `assets/`) or the brand font file into `.studio/cache/editor-staging/<creative>/<token>/assets/lib/<sha8>-<safe-name>` with `realDirChain`, probes it with the existing `ffmpeg-exec` helper (images/video/audio) or `svg-size`, runs media normalization for video as at ingest, and returns the composition-relative path `assets/lib/<sha8>-<safe-name>`.
- The composition server serves a session's files from the base folder first, then from the session's staging folder for `assets/lib/…` paths missing from the base. Staged names carry the file's sha8, so a collision means the same name with different content: staging then picks a new name, and at save a staged path that exists in the base with a different sha256 is refused (`editor.stagedCollision`).
- Staging is removed when the session is revoked or expires, and by the cache sweep (age > 24 h).
- Uploads ("or uploading a file") reuse the library upload route first, then stage from the library: one path for both.
- Limits: 500 MB per staged file (same as compositions), 20 staged files per session; translated errors.

- [ ] **Step 1. Failing tests:** the view for a primary and for a follower; 404 for a legacy version; staging from library (image, svg, video normalized, audio, font) returns probe data; refusals: unregistered file, path traversal in `file`, symlink in the library pointing outside, unknown brand font, other creative's token, expired token, size and count limits; served through the session URL with the existing CORP and signed-URL rules; base file wins on collision; cleanup on revoke and sweep.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): editor composition view and staged assets for drafts`.

---

### Task 4: Core — `DirectEditService.save`

**Files:**
- Create: `packages/core/src/creatives/direct-edit.ts`
- Modify: `packages/core/src/creatives/{creative-turns.ts,composition-turn.ts}` (share the locks, the follower recompute and the commit/state steps; extract helpers instead of duplicating), `packages/core/src/server/creative-routes.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/direct-edit.test.ts`

**Interfaces:**
```ts
// POST /api/projects/:slug/creatives/:c/edits
export const directEditBodySchema = z.strictObject({
  baseVersion: z.number().int().positive(),
  format: z.string(),                      // the primary format edited
  baseHash: z.string(),                    // composition hash of the base
  composition: z.unknown(),                // validated in the core
  staged: z.array(z.string()).max(20),     // staged paths used by the draft
  ops: z.array(editOpSchema).max(500),     // for the summary and the log only; the composition is authoritative
  token: z.string(),                       // the preview session that owns the staging
});
export class DirectEditService {
  save(ref: CreativeRef, body: DirectEditBody, locale: Locale): Promise<{ version: number }>;
}
```
Steps inside the creative lock:
1. Refuse if a turn or render job is active (`editor.busy`, 409) or `baseHash` is not the latest composition hash of `format` (`editor.baseChanged`, 409).
2. `n = store.nextVersionNumber`. Copy the base composition folder with `copyVerified` into `outputs/v<n>/compositions/<format>/`, copy the **used** staged files (only those referenced by the composition; others are ignored), write `composition.json` normalized and atomically, then `loadComposition` (normalize, validate, hash). Any problem: remove `outputs/v<n>/` and answer 422 with the translated problems.
3. Carry the other primaries from the latest version exactly as a targeted turn does; recompute followers of `format` with `canFollow` against the new duration and size; unlink those that can no longer follow (same warning entry and `unlinkFollowers` as `assembleCompositions`).
4. Write `manifest.json` v2 (renders carried only for unchanged hashes), `git.commitAll(projectDir, '<title>: v<n>')`, `store.appendVersion({ …, origin: 'editor', request: describeEdits(ops), basedOn: baseVersion, usage: undefined })`, a `version` conversation entry, `commitState`, `changed(ref)`, then `storyboardsLater`.
5. Never launches `claude`, never appends to the usage ledger.

- [ ] **Step 1. Failing tests** (with the fake claude asserting it was never spawned):
  - a text edit makes v(n+1) with the edited composition, the same assets (hash-verified), other formats carried, renders carried only where unchanged, `origin: 'editor'`, the summary as `request`, a git commit, storyboards regenerated, one `creative` event;
  - a staged image replacement is copied into the version and unused staged files are not;
  - a follower that still fits follows the new composition; one that does not is unlinked with the chat warning (Review Focus 2);
  - 409 while a turn is running and while a render runs; 409 `baseChanged` after another version changed the format (Review Focus 1); 422 for an invalid composition with no `outputs/v<n>` left behind; a crash between copy and manifest (injected) leaves no version entry and the next save works;
  - a composition that tries a `src` outside `assets/`, an html `src` change, or a new html clip: refused (the editor may not do that);
  - no usage ledger line.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): direct edits save a new version without the agent`.

---

### Task 5: Web — editor shell, draft store, undo/redo, Draft pill

**Files:**
- Create: `packages/web/src/screens/editor/{draftStore.ts,EditorScreen.tsx,DraftPill.tsx,useEditorKeys.ts,editor.css}`
- Modify: `packages/web/src/screens/FormatView.tsx` (Edit button in `bar.end` next to Export, shown when the viewed version has a composition and no job is active), `packages/web/src/routes.ts` (`href.edit(slug, creative, format)`), `packages/web/src/api.ts`
- Test: `packages/web/test/editor-draft.test.ts`, `packages/web/test/EditorScreen.test.tsx`

**Interfaces:**
```ts
export type Draft = { key: string; base: { n: number; format: string; hash: string }; composition: Composition; files: Map<string, { size: number }>; staged: StagedAsset[]; ops: EditOp[]; past: Snapshot[]; future: Snapshot[]; problems: CompositionProblem[] };
export function useDraft(key: string): [Draft | null, DraftActions];
export type DraftActions = {
  open(view: EditorCompositionView): void;
  apply(op: EditOp, opts?: { coalesce?: string }): EditResult; // same coalesce key within 500 ms = one undo step (drags, typing)
  undo(): void; redo(): void; discard(): void;
  stage(asset: StagedAsset): void;
};
```
- Module store (`useSyncExternalStore`, like `pendingPins.ts`), keyed by project/creative/format; survives route changes, not reloads. History capped at 200 steps.
- Every `apply` revalidates with `validateComposition` (files map + staged) and pushes the composition to the player via `setComposition`.
- Editor layout (video): top bar (back, title, format crumb, `1080×1920 · 7.0 s · 30 fps`, "Also used by …" chip, version, Export); left scenes column; centre stage; right tabs Chat | Inspector; bottom timeline. Image: tool rail is **not** built (move only), layers panel left, stage, inspector right. Follow the prototype's sizes (`224px | 1fr | 288px`, timeline 262 px; image `248px | 1fr | 280px`).
- **DraftPill** at the top of the stage: `● Draft · N edits`, Save as vN (disabled with the first problem's text as its description when `problems.length > 0`), Discard (with confirm). After save: "✓ Saved as Reel vN" for 1.8 s, the editor reopens on the new version.
- Leave guard (Review Focus 3): back, format/version switch, sending a chat message, `beforeunload` in web and the desktop close confirm path: a translated dialog "Save as vN · Discard · Keep editing".
- Keys: ⌘Z/⇧⌘Z (Ctrl+Z/Ctrl+Shift+Z, Ctrl+Y), Space play/pause, arrows step a frame, Delete does nothing (clips cannot be removed: toast "Ask the agent to remove clips"), Esc deselects. Never while `isTyping`.

- [ ] **Step 1. Failing tests:** store open/apply/undo/redo/coalesce/cap/discard; invalid op leaves state unchanged; Save disabled with the problem text; save success flow (api mocked) and the 409 `baseChanged` dialog keeping the draft; leave guard on each exit path; keyboard map including typing guard; Edit button visibility (legacy version, active job, follower view says "Editing <primary>").
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(web): editor shell with drafts, undo and Save as vN`.

---

### Task 6: Web — stage with handles and the scenes column

**Files:**
- Create: `packages/web/src/screens/editor/{Stage.tsx,Handles.tsx,stageMath.ts,ScenesColumn.tsx}`
- Test: `packages/web/test/editor-stage-math.test.ts`, `packages/web/test/editor-stage.test.tsx`

- Selection comes from the timeline, the layers panel, the scenes column and the selected clip's handle box; clicking empty stage deselects. Hit testing clicks inside the sandboxed iframe is out of scope (decisions log).
- `Handles` draws the selected clip's `clipBounds` (iframe CSS pixels × player scale) as an overlay outside the iframe: move (drag inside), resize (four corners; Shift keeps aspect), rotate (a handle above the top edge; Shift snaps to 15°). Live coordinate label `x · y · w × h` in composition pixels.
- `stageMath.ts` converts pointer deltas to composition units, accounting for the player scale, the clip `scale` and `rotation` (resize in the clip's rotated frame), and **writes base props only** (animations are not baked in). Pure, tested.
- During a drag: `apply(op, { coalesce: 'drag:<clipId>' })` per animation frame; the playhead is paused.
- Locked clip/track: handles shown dashed, no drag, tooltip "Locked".
- Snap guides on the stage: centre and edges of the frame and of the safe area, 6 px threshold, toggled with the magnet button (shared with the timeline).
- Scenes column: scene cards (storyboard thumbnail, name, duration); click seeks to the scene start; "In this scene" lists the clips overlapping the current scene (click selects). Drag to reorder scenes when `sceneOrderAllowed`, otherwise the handle is disabled with the reason.

- [ ] **Step 1. Failing tests:** `stageMath` tables (scale 0.25–2, rotation 0/37/90/-120°, clip scale 0.5/1.5): move by delta, corner resize, aspect lock, rotation about the centre, ten drags round-trip with undo to the exact original (Review Focus 5); component: handles follow `clipBounds`, locked refusal, snap to the frame centre, scene reorder enabled/disabled.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(web): editor stage with move, resize and rotate handles`.

---

### Task 7: Web — timeline

**Files:**
- Create: `packages/web/src/screens/editor/{Timeline.tsx,timelineMath.ts,TrackHeader.tsx,ClipBar.tsx}`
- Test: `packages/web/test/editor-timeline-math.test.ts`, `packages/web/test/editor-timeline.test.tsx`

- Rows: transport (play, timecode `00:SS.ff / total`, frame step, zoom slider, snap toggle, ripple toggle), ruler with seconds and frame ticks at high zoom, a scenes lane (segments with storyboard thumbnails), then one lane per track **top-down in visual stacking order** (the schema's last track on top), with a header: name, kind icon, hide (eye/eyeOff), lock (lock/unlock), mute for audio.
- Clips as bars: name, kind colour from tokens, waveform not required. Click selects; drag edges to trim start/end (`clipTiming`), drag body to move (`clipTiming` with the same duration); snapping with `snapTime`/`snapTargets` (threshold 8 px converted to seconds at the current zoom); Alt disables snap. The ripple toggle applies `ripple: true`.
- Zoom: 1×–20× with ⌘+scroll and the slider, anchored at the pointer; horizontal scroll at zoom > 1.
- Playhead: drag on the ruler scrubs (`seek`), pins from the conversation as markers (existing marks), range comments as shaded spans (Task 10).
- Accessibility: clips are focusable; ←/→ move the focused clip by one frame, Shift by one second; `[`/`]` trim start/end to the playhead.
- Images (duration 0) show no timeline; the layers panel replaces it (Task 9).

- [ ] **Step 1. Failing tests:** `timelineMath` px↔s at zoom levels, snap within/out of threshold, anchored zoom; component: edge drag clamps at scene and composition bounds, body drag with snap to a scene boundary, ripple shifts the next scene, locked track refuses, hide/lock/mute toggles produce the right ops, keyboard moves and trims, Alt disables snap.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(web): editor timeline with scenes, tracks, trimming, zoom and snap`.

---

### Task 8: Web — inspector, controls, assets and fonts

**Files:**
- Create: `packages/web/src/ui/{NumberField.tsx,Slider.tsx,ColorField.tsx}` (in-house, keyboard-accessible, themed) and export them
- Create: `packages/web/src/screens/editor/{Inspector.tsx,inspector/*.tsx,AssetPicker.tsx}`
- Test: `packages/web/test/ui-editor-controls.test.tsx`, `packages/web/test/editor-inspector.test.tsx`

- Sections by clip type (only the §6 list): Timing (IN, DUR, OUT; images: none); Box (X, Y, W, H, rotation, opacity); Text (content textarea, font select with brand and composition fonts grouped, weight select from the font's weights, size, colour, align segmented); Shape (fill, radius); Media (Replace…, trim start, volume) for video; Audio (Replace…, volume, fade in/out); Animation (IN and OUT preset selects with duration; a custom animation in the slot shows "Custom animation · ask the agent to change it"); html params (one field per declared param by type, `image` uses the asset picker).
- Every field edits through `apply`; numeric fields clamp to schema bounds; per-field problems from `CompositionProblem.params.path` show under the field.
- `ColorField`: hex input plus swatches from the brand palette and the composition's colours (`// color-data` on literal lines); no native `<input type=color>`.
- `AssetPicker`: modal over the library (`listAssets`), filtered by the clip kind, with "Upload…" (existing upload, then register, then pick); picking calls the stage route and then `clipMedia { src }`. A replacement video shorter than `trimStart + clip duration` shows a warning and offers "Fit clip to video" (a `clipTiming` op) — never silently cuts.
- Brand font not in the composition: choosing it stages the font file and applies `addFont` then `clipProps { fontFamily }`; a brand font without a file is listed disabled ("No font file in the brand kit").
- Weight not available for the chosen font: the weight select only offers the declared weights (Review Focus 4).

- [ ] **Step 1. Failing tests:** controls (keyboard, clamp, both themes snapshot of tokens only, no literal colours); inspector per clip type renders only allowed fields; each field emits the expected op; problem under the field; asset picker filter, upload-then-pick, short video warning and fit; brand font staging and disabled no-file font; weights limited.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(web): editor inspector, asset replacement and brand fonts`.

---

### Task 9: Web — image editor (layers)

**Files:**
- Create: `packages/web/src/screens/editor/{LayersPanel.tsx,ImageEditor.tsx}`
- Test: `packages/web/test/editor-image.test.tsx`

- Layers = tracks of the still composition, top-down in stacking order; rows of 44 px with eye, thumbnail (kind icon is enough), name, kind caption, lock. Click selects the track's clip (a still has one clip per track as written by the agent; if a track has several, list clips nested under the track).
- Stage with handles (Task 6), zoom bar (fit, 50–400 %), inspector (Task 8) without timing and animation sections.
- No "+" add layer: the panel footer says "Ask the agent to add layers".

- [ ] **Step 1. Failing tests:** layer order matches stacking; hide/lock; selection drives handles and inspector; no timing/animation sections; save flow produces a new version for a png format.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(web): image editor with layers`.

---

### Task 10: Comments on clips and ranges

**Files:**
- Modify: `packages/web/src/screens/{FormatView.tsx,pendingPins.ts}`, the editor (Timeline, Stage), `packages/web/src/components/Conversation*`
- Modify: `packages/core/src/creatives/{prompt.ts,creative-turns.ts}` (pin lines and pin frames)
- Test: `packages/web/test/pins-clip-range.test.tsx`, `packages/core/test/prompt.test.ts`, `packages/core/test/pin-frames-route.test.ts`

- In the editor and the format view: "Comment on clip" (context action on a selected clip, also `C` key) creates a pin with `clipId` and the clip's centre as `x,y` at the current time; a drag with Shift on the ruler creates a `range` pin.
- Pins show in the conversation as `Reel · "Title" clip` / `Reel · 2.0–3.5 s` chips; range pins draw a shaded span on the timeline and the transport.
- Prompt line: `- <format> @ <t>s, point (x%, y%)[, clip <clipId> "<name>"][, range <a>–<b>s]: <note>`.
- Pin frames: a range pin gets the frame at the range start and at its end (two JPEGs, same cache rules); a clip pin gets the frame at its time as today, with no overlay drawn (the clip id and name in the prompt are enough).
- Old pins render as today.

- [ ] **Step 1. Failing tests:** pin creation with `clipId` and `range` (keyboard and pointer), chips text en/it, timeline span, prompt lines for all four shapes (plain, clip, range, both), two frames for a range pin, old conversation files still load.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat: comments on clips and time ranges`.

---

### Task 11: Live verification and docs

- [ ] Live check with the method of phases 9 and 10a: throwaway driver and core in the scratchpad, `MemoryVault`, real Chrome via the existing harness, fake claude that **fails the test if spawned** during editor actions; Electron only with `MOTION_STUDIO_USER_DATA_DIR`, verified before acting.
- [ ] Scenario (screenshots into `docs/superpowers/notes/2026-10-13-phase10b-live-checks.md`):
  1. a composition creative (Reel + TikTok linked + Post): open Edit on Reel;
  2. change the title text, font (a brand font with a file), colour; move and rotate the logo; set an entry preset; Save → v(n+1) with `origin: editor`, summary in the chat, storyboard updated, TikTok follows, no claude spawned, no usage line;
  3. extend scene 2 by 1 s with ripple; a follower whose max duration is exceeded gets unlinked with the warning;
  4. replace the background video from the library (and one via upload), trim start, volume; Render ★ and export: mp4 valid, BT.709;
  5. undo/redo across 20 steps; leave guard on Back; reload loses the draft with the browser prompt;
  6. start an agent turn from a second window while a draft is open → Save answers `baseChanged`, the draft is kept;
  7. Post (image): layers panel, hide a layer, change a text, Save, Render png;
  8. a clip comment and a range comment sent to the agent (haiku): the prompt lines are right and the agent edits that clip.
- [ ] Docs: README (en/it) editor section, `docs/output-contract.md` (`assets/lib/` reserved, clip `hidden`/`locked`, pin fields), decisions log entries.
- [ ] mtimes of the three real folders before and after.
- [ ] Commit: `docs: phase 10b live checks and editor docs`.
