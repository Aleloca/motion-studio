# Motion Studio — Fase 10a: Composizioni e render — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent delivers editable compositions instead of rendered media. Motion Studio validates them and makes storyboards. It previews them live in an isolated iframe. It renders them to mp4 or png **only when the user asks**, with a core-controlled Chromium and ffmpeg. Old creatives convert on their next change.

**Architecture:**
- **`packages/shared`:**
  - the composition schema (zod, plus exported JSON Schema);
  - path rules;
  - the canonical composition hash;
  - manifest v2 types.
- **New `packages/composition-runtime`:** the browser runtime (mount, WAAPI compile, `seek`, virtual clock, html-layer contract, play and pause), built to a single static bundle the core serves.
- **Core:**
  - an isolated composition server;
  - a `Renderer` with two Chromium providers (Electron offscreen via the desktop, and system Chrome or on-demand chrome-headless-shell for the CLI);
  - a CDP pipe client, isolation layers, a watchdog, parallel segment capture, the ffmpeg encode and the audio mix;
  - a render job queue;
  - agent integration: prompt, `.studio/context.md`, MCP `validate_composition` and `preview_frames`, output contract v2;
  - legacy conversion.
- **Desktop:** an offscreen render utility window.
- **Web:**
  - the live preview player;
  - storyboards;
  - Render buttons, states and progress;
  - export auto-render;
  - the Chrome download consent dialog.

**Tech Stack:** TypeScript, zod, Fastify, React 19, Electron, ffmpeg and Chromium via the DevTools protocol over pipe. No puppeteer, no GSAP and no new runtime animation libraries. Allowed dev or test deps must be MIT, BSD or Apache, and justified in the commit.

**Spec:** `docs/superpowers/specs/2026-10-10-motion-studio-phase10-compositions-design.md`. Read the spike report too, `docs/superpowers/notes/2026-10-10-phase10-render-spike.md` (merged with this plan). Its code is in the `spike/phase10-render` branch, as a reference to port, not to merge as is.

## Global Constraints

**Security first.**
- The composition page is agent-written code running **outside** the sandbox. All four isolation layers (spec §5.2) are mandatory, and the hostile tests from the spike become permanent tests.
- The live preview iframe runs on a **different origin** from the UI, with `sandbox="allow-scripts"` and no `allow-same-origin`.
- Every core API requires the token. Nothing trusts the loopback origin.
- No `file://` loading.

**Determinism.**
- `seek(t)` waits for video seeked at the frame centre (`(i + 0.5) / fps`), for an explicit `FontFace.load()` (not `document.fonts.ready`), and for the layers' `msReady` and `msSeek`.
- The virtual clock is injected into every frame.
- Tests compare frames **with a tolerance**: there is no bit-identical promise.

**Processes.**
- Every Chromium launch is killed as a **whole process group**, on cancel, timeout or crash.
- Each `Runtime.evaluate` has a timeout.
- The watchdog enforces memory and time limits.

**Chrome for Testing.**
- Downloaded **only on demand** with explicit user consent, after showing its size, into the app data folder.
- Never bundled or redistributed.
- System Chrome is preferred when found.

**Agent.**
- The agent no longer renders.
- Prompts and `.studio/context.md` drop `renderCommand`, setup and encoding instructions for final media.
- Encoding targets from phase 8 are now applied by the core renderer.

**Data.**
- `manifest.json` v2 is additive: v1 manifests stay readable (legacy).
- Per-format history (phase 9) switches to the composition hash for v2 versions and keeps file hashes for legacy versions.
- Old data stays valid.

**Real folders.** The real user folders (`~/Library/Application Support/Motion Studio` and `~/MotionStudio`) stay untouched, and the global test isolation guard stays on. Check the mtime before and after every live check.

**UI.** Phase 7 rules apply (no native controls, no literal colours, motion only from `motion/`, AA contrast). All text comes from the `en`/`it` catalogs.

**Process.**
- No push, PR, release or publish.
- Commit trailers exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01KxKL6zuy8dbnJieqN1eCNg`
- `pnpm test`, `pnpm typecheck` and `pnpm check:i18n` stay green.

## Review Focus

1. **Escaping the composition page.** The page tries `fetch` to the core API on loopback, WebSocket, `new Worker`, `import('http…')`, `<img src=file://>`, `../` paths, a symlink in `assets/` pointing outside, `window.top` access from the iframe, `postMessage` spoofing to the UI, an infinite loop, a 2 GB ArrayBuffer and `history.pushState` to another origin.

   Every attempt must be blocked or contained. These are permanent tests in Task 3 and Task 4.
2. **Process leaks.** Cancel mid-render, a Chromium crash, the ffmpeg exit code ≠ 0 and app quit during a render must leave no orphan Chromium or ffmpeg processes and no partial output files. A retry must start clean.

   Tests in Task 4.
3. **Media timing.** Exercise:
   - source videos at 24 or 25 fps in a 30 fps composition;
   - variable frame rate;
   - trimStart;
   - audio longer or shorter than its clip;
   - a clip ending exactly at the composition end;
   - a zero-duration image composition.

   Frames and audio must line up within one frame and one sample. Tests in Tasks 2 and 4.
4. **Composition validation.** Overlapping scenes, gaps, clips outside the duration, unknown fonts, oversized assets (limit configurable, default 500 MB per composition), html layers using forbidden APIs (static check) and a non-UTF-8 JSON must give clear, translated problems the agent can fix. Validation itself must stay linear and bounded.

   Tests in Task 1 and Task 5.
5. **Legacy and mixed creatives.** A creative with v1–v3 legacy (media) and v4 composition must handle:
   - history per format across the boundary;
   - ★ on a legacy version and export of it (no render);
   - ★ on v4 with export (auto-render);
   - Compare between legacy v3 and v4 (renders v4 for compare, or compares v3 against the storyboard frame);
   - restart from a legacy version: the next turn converts.

   Tests in Tasks 6 and 9.

---

### Task 0: Housekeeping

- [ ] Merge the spike report into this branch from `spike/phase10-render`: only `docs/superpowers/notes/2026-10-10-phase10-render-spike.md` and `spike/schema/composition.schema.json`, as `docs/design/composition.schema.draft.json`.
- [ ] Make the `creative-turns` test "restores work/ to a past version and forks its session" robust under load. Use an explicit, generous timeout or lighten the fixture. Tests only.
- [ ] Commit: `chore: phase 10 references and a robust creative-turns test`.

---

### Task 1: Shared — composition schema, paths, hash, manifest v2

**Files:**
- Create: `packages/shared/src/composition/{schema.ts,paths.ts,hash.ts,validate.ts,index.ts}`
- Create: `packages/shared/src/composition/composition.schema.json` (generated, checked in, with a test that it matches)
- Modify: `packages/shared/src/creative.ts` (manifest v2: `compositions[]`, `renders[]`, render state)
- Modify: the catalogs
- Test: `packages/shared/test/composition-*.test.ts`

**Interfaces (Produces):**
```ts
export const compositionSchema: z.ZodType<Composition>; // spec §3.2
export type Composition = { $schema: 'motion-studio/composition@1'; width: number; height: number; fps: number; duration: number; background: string; fonts: FontRef[]; scenes: Scene[]; tracks: Track[] };
export function validateComposition(c: unknown, ctx: { format: FormatPreset; files: Map<string, { size: number }>; maxBytes: number }): { ok: boolean; problems: Problem[] }; // structural + semantic checks (contiguous scenes, clips in range, assets present, size limits, format size/duration)
export function staticLayerCheck(html: string): Problem[];   // forbidden APIs (fetch, XMLHttpRequest, WebSocket, EventSource, Worker, SharedWorker, importScripts, import( with a non-relative specifier, navigator.sendBeacon, AudioContext, <video autoplay>, http(s):// URLs); bounded and linear
export function isCompositionPath(p: string): boolean;     // ^(assets|layers)/ … no scheme, no .., no backslash, no NUL
export function compositionHash(entries: { path: string; sha256: string }[]): string; // canonical: sorted paths, '\n'-joined "path\tsha"
export type ManifestV2 = { schemaVersion: 2; compositions: { format: string; dir: string; hash: string; followsFormat?: string }[]; renders: { format: string; file: string; width: number; height: number; durationSec: number | null; sha256: string; renderedAt: string }[] };
```
- Problems are `{ key, params }` and get translated.
- The static layer check is advisory defence in depth. The real boundary is runtime isolation (Task 3).

- [ ] **Step 1. Failing tests:**
  - the schema accepts the spike example;
  - it rejects each Review Focus 4 case with the expected keys;
  - the paths table;
  - the hash is stable under path order;
  - the static check catches every forbidden API in a 30-case table;
  - 1 MB of hostile HTML takes under 50 ms;
  - the JSON Schema file equals the generated one.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(shared): composition schema, validation, paths and manifest v2`.

---

### Task 2: Composition runtime package

**Files:**
- Create: `packages/composition-runtime/` (TS source, a build to `dist/runtime.js` and `dist/index.html`, tests)
- Modify: the workspace config

**Requirements (spike §1 and §6):**
- **`mount(root, composition, { mode: 'preview' | 'render' })`** builds the DOM:
  - text, shape, image, svg and video elements, positioned in composition pixels and scaled to fit the viewport in preview;
  - html clips as iframes on the same isolated origin, with `msParams` injected.
- **Animations:** JSON animations and Ken Burns compile to paused WAAPI. Presets are defined in one table.
- **`seek(t)`** sets the time on every animation, the video `currentTime` at the frame centre awaiting `seeked`, and clip visibility by start and duration. It then awaits fonts via `FontFace.load()`, the layers' `msReady` and `msSeek(t)`, and two rAFs.
- **Virtual clock**, in render mode, inside the runtime and every layer: Date, performance.now, rAF, setTimeout and setInterval are driven by `seek`.
- **`play()` and `pause()`** in preview mode run in real time with loop. Audio plays in preview through `<audio>` elements synced to the timeline, with a sync tolerance of 1 frame.
- **`postMessage` protocol to the parent UI** (preview only): `{ type: 'time' | 'ready' | 'error' | 'clipBounds', … }`. It validates the parent origin given at load, and accepts only `seek`, `play`, `pause`, `select` and `setScale` from the parent.
- **No network APIs in the runtime itself.**

- [ ] **Step 1. Failing tests:**
  - jsdom unit tests: compile presets to keyframes, clip visibility at boundaries, frame-centre math for 24 and 25 fps sources;
  - integration tests with a real headless Chrome (system Chrome, or the CI runner's Chrome; skip with a clear message if none is available locally, but **required on CI**): two seeks to the same t give frames within tolerance, and the html layer `msSeek` is called.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat: composition runtime with deterministic seek and live preview`.

---

### Task 3: Core — isolated composition server

**Files:**
- Create: `packages/core/src/compositions/{composition-server.ts,serve-token.ts}`
- Test: `packages/core/test/composition-server.test.ts`

**Requirements:**
- A **separate HTTP listener** on its own random port, never the UI port. Paths are `/<sessionToken>/<versionDir>/compositions/<format>/…` plus `/<sessionToken>/runtime/…`.
- Session tokens are minted per preview or render session, expire, and are scoped to one composition folder (read-only).
- Files are resolved with realpath inside the folder, `O_NOFOLLOW`, no symlinks out, a regular-file check and a size limit.
- Headers:
  - CSP `default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; frame-ancestors <ui origin>; base-uri 'none'; form-action 'none'`;
  - `X-Content-Type-Options: nosniff`;
  - `Cross-Origin-Resource-Policy: same-origin`, with an exception for frame-ancestors.
- Any write method gets 405. The listener never exposes core APIs.

- [ ] **Step 1. Failing tests:**
  - path traversal, a symlink out, a hardlink check (`nlink > 1`, consistent with the protected-file rules), a FIFO, an oversized file, an expired token and a wrong-folder token are all refused;
  - the CSP header is present;
  - core API paths return 404 on this listener.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): isolated composition server`.

---

### Task 4: Core — renderer (CDP client, providers, isolation, capture, encode, audio)

**Files:**
- Create: `packages/core/src/render/{cdp-pipe.ts,chromium-provider.ts,system-chrome.ts,cft-download.ts,isolation.ts,watchdog.ts,capture.ts,encode.ts,audio-mix.ts,renderer.ts}`
- Test: `packages/core/test/render-*.test.ts`

**Interfaces:**
```ts
export interface ChromiumProvider { kind: 'electron' | 'system' | 'cft'; open(opts: { width: number; height: number; url: string; signal: AbortSignal }): Promise<RenderPage>; close(): Promise<void> }
export interface RenderPage { seek(t: number): Promise<void>; capture(format: 'jpeg' | 'png', quality?: number): Promise<Buffer>; close(): Promise<void> }
export function renderComposition(o: { dir: string; composition: Composition; format: FormatPreset; out: string; provider: ChromiumProvider; parallel: number; signal: AbortSignal; onProgress(p: { frames: number; total: number }): void }): Promise<{ file: string; sha256: string; width: number; height: number; durationSec: number | null }>;
```

**Requirements:**
- **CDP over pipe** (`--remote-debugging-pipe`), about 100 lines with no puppeteer, and a timeout on every call.
- **Launch flags:**
  - `--headless=new` for system Chrome, plain for chrome-headless-shell;
  - a temporary `--user-data-dir`;
  - `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE <composition-server-host>"`;
  - `--proxy-server` pointing to a dead port with `--proxy-bypass-list` covering only the composition server;
  - `--disable-background-networking`;
  - extensions, sync and the first-run experience disabled;
  - no `--no-sandbox`: Chromium's own sandbox stays on.
- **`Fetch.enable` interception** allows only `http://127.0.0.1:<compPort>/<token>/…` and fails everything else. The **watchdog** samples memory with `ps`/footprint on macOS and `/proc` on Linux, enforces the time limit, and kills the process group.
- **Capture:** `seek` then `Page.captureScreenshot`. Segments across N pages in parallel, each piping JPEG q90 to its own ffmpeg (image2pipe) and writing a segment file; then the concat demuxer. Images are a single PNG capture.
- **Encode:**
  - H.264 `yuv420p` with phase 8 targets (`-crf 20 -maxrate -bufsize`), `+faststart`;
  - try `h264_videotoolbox` on macOS behind a quality check, falling back to libx264;
  - all output goes to a temp file, renamed into `outputs/vN/<format>.<ext>` only on success.
- **Audio:** `adelay` per clip, fades, `amix normalize=0`, then `alimiter`; muxed AAC 128k.
- **System Chrome discovery:** standard macOS, Windows and Linux paths plus `CHROME_PATH`, with a version check.
- **Chrome for Testing:**
  - fetch the manifest from the official JSON endpoint;
  - download the zip for the platform into `<appData>/chromium/<version>/`, verify the size, unzip safely (no `..`, no symlinks out);
  - only after a consent flag passed from the UI (Task 8);
  - never in tests (mock it).

**Steps:**
- [ ] **Step 1. Failing tests:**
  - CDP pipe framing and timeouts;
  - Review Focus 1, with the spike's hostile pages as permanent integration tests: each must be blocked;
  - Review Focus 2: cancel and crash leave no processes (assert with `ps` on the process group) and no output file;
  - Review Focus 3, frame and sample alignment;
  - segment concat seams are clean (frame count is exact);
  - CfT download with a fake server: consent required, path safety, size check.
- [ ] **Steps 2–4.** FAIL → implement → PASS. Integration tests need Chrome, which is required on CI. Add a step to the CI workflow that ensures Chrome is present on both runners.
- [ ] **Step 5. Commit:** `feat(core): isolated Chromium renderer with parallel capture, encode and audio mix`.

---

### Task 5: Core — agent integration, output contract v2, versions, render jobs

**Files:**
- Modify: the prompt builder and `project-template.ts` (`.studio/context.md`)
- Modify: `output-contract.ts` (v2)
- Modify: `creative-turns.ts`
- Modify: the MCP bridge (`validate_composition` and `preview_frames`)
- Modify: `packages/mcp-studio/src/server.mjs`
- Create: a render job kind in the job queue
- Modify: the export from phase 9 (auto-render)
- Modify: `docs/output-contract.md`
- Test: extend the turns, contract and export tests, plus `render-jobs.test.ts`

**Requirements:**
- **The prompt and context** teach the schema (with the JSON Schema file copied into `.studio/composition.schema.json`), the layer contract, the font rules, examples, and "never render final media; never install renderers". `renderCommand` is removed from the v2 contract.
- **After the agent's attempt:**
  - validate each primary format's composition (`validateComposition` plus `staticLayerCheck`);
  - the fix loop uses these problems;
  - the core hashes the composition folder;
  - phase 9 carry-over and followers work with composition dirs;
  - write manifest v2;
  - render **storyboard frames** (scene starts plus the poster at 1 s; low resolution, 270 px wide) through the renderer into `.studio/cache/storyboards/<creative>/v<N>/<format>/` (protected, not in the version, regenerable);
  - commit.
- **MCP tools:**
  - `validate_composition({ format })` returns problems;
  - `preview_frames({ format, times })` takes at most 6 times, renders at most 540 px wide, returns PNG images to the agent, and is rate-limited per turn (default 10 calls).
- **The `render` job kind:**
  - `POST /api/projects/:slug/creatives/:c/versions/:n/render`, with body `{ formats?: string[] }` (default all primaries plus followers via copy);
  - one job per request;
  - progress events per format;
  - cancel;
  - results recorded in manifest v2 `renders[]` and `VersionEntry.outputs` (with phase 8 bitrate warnings);
  - no tokens and no ledger rows, or a zero row with kind `render` if useful for history (decide and note it).
- **Export (phase 9):** if a ★ pick has no render yet, export first enqueues the render, shows its progress, then copies. Legacy versions export their existing media.
- **Compare (phase 9) for v2:** live preview side by side for video (two isolated iframes driven by the synced transport) and storyboard or render frames for images.

**Steps:**
- [ ] **Step 1. Failing tests:**
  - the prompt contains the schema reference and no renderCommand;
  - a v2 turn with the fake agent writing a composition gives a validated version, a storyboard and manifest v2;
  - an invalid composition gets problems and a fix attempt;
  - `preview_frames` returns images and is rate-limited;
  - render job progress and cancel;
  - export auto-renders a missing ★ render;
  - phase 9 history uses the composition hash.

  Extend the fake claude with scenarios `composition`, `composition_invalid` and `composition_layer`.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): agents deliver compositions, storyboards, on-demand render jobs`.

---

### Task 6: Core — legacy conversion

**Files:**
- Modify: `creative-turns.ts`
- Modify: the prompt builder
- Test: `legacy-conversion.test.ts`

**Requirements (spec §7):**
- A creative is legacy if its latest (or resume-from) version has a v1 manifest.
- The next change turn becomes a conversion:
  - extract reference frames from the base version's media with ffmpeg (1 per second, at most 12, 540 px wide) into `creatives/<c>/work/reference/`;
  - the prompt asks to rebuild faithfully as compositions and to apply the user's request;
  - the chat entry reads "Converting to the editable format · costs more tokens this once".
- Image legacy versions convert the same way.

**Steps:**
- [ ] **Step 1. Failing tests:**
  - a legacy base triggers the conversion prompt and the reference frames;
  - a v2 base doesn't;
  - restart from a legacy version converts on the next turn;
  - Review Focus 5 history, ★ and export across the boundary.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): convert legacy creatives to compositions on their next change`.

---

### Task 7: Desktop — Electron render provider

**Files:**
- Modify: `apps/desktop/src/main.ts`
- Create: `apps/desktop/src/render-window.ts`
- Modify: the IPC between the core (in-process in desktop) and the provider
- Test: `apps/desktop/test/render-window.test.ts`

**Requirements:**
- The `ChromiumProvider` of kind `electron` uses a hidden `BrowserWindow` with:
  - `show: false`, `offscreen: true` in webPreferences, `sandbox: true`, `contextIsolation`, no preload and no node;
  - a separate session partition (`persist:false`), with proxy rules set to the dead proxy and `session.webRequest` allowing only the composition server;
  - CDP via `webContents.debugger`.
- One window per parallel segment, limited by settings.
- Avoid the `destroy()` and `loadURL` race: wait for `closed`, and create fresh windows.
- **Electron is the default provider in the desktop app.**

**Steps:**
- [ ] **Step 1. Failing tests:**
  - window options (offscreen, sandbox, no preload);
  - session rules block external requests;
  - the provider renders the spike composition in the smoke-test harness with a temporary config.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(desktop): offscreen Electron render provider`.

---

### Task 8: Web — live preview, storyboards, Render, progress, Chrome consent

**Files:**
- Create: `packages/web/src/components/CompositionPlayer.tsx`
- Modify: `screens/CreativeCanvas.tsx`
- Modify: `screens/FormatView.tsx`
- Modify: `screens/ExportDialog.tsx`
- Modify: `screens/CompareDialog.tsx`
- Modify: `shell/ActivityCenter.tsx`
- Modify: `screens/AppSettings.tsx` (System check: render engine)
- Modify: the catalogs
- Test: extend the canvas, format view, export, compare and activity tests, plus `composition-player.test.tsx`

**Requirements:**
- **`CompositionPlayer`:**
  - an iframe on the composition server origin with `sandbox="allow-scripts"`, driven by validated `postMessage`;
  - it exposes the same transport as phase 7 (play and pause, scrub, frame step, loop, speed), using the shared `useSyncedMedia` contract where possible;
  - errors from the runtime show inline.
- **Canvas boards:**
  - storyboard frames as posters;
  - live play on hover or on click;
  - the subtitle row shows the render state ("Not rendered", "Rendering 42%", "Rendered", "Render failed · Retry");
  - the board menu has "Render", and the top bar has "Render ★" (all formats at their ★).
- **Format view:**
  - the live player replaces the `<video>` for v2 versions;
  - a storyboard strip of the scenes, clickable to seek;
  - frame comments work as before.
- **Render progress:** in the activity center (Running), with frames done/total and cancel.
- **Export:** shows "Rendering 2 formats first…" with progress when needed.
- **Compare:** two `CompositionPlayer`s synced for v2.
- **System check:** shows the render engine (Electron, or system Chrome with its version, or "Not available · Download Chrome for Testing (about 100 MB)") with a consent button calling the core download endpoint and showing progress. The CLI only: on desktop, Electron is always available.

**Steps:**
- [ ] **Step 1. Failing tests:**
  - the player posts only allowed messages and ignores foreign-origin messages;
  - board states;
  - Render and Render ★ call the API;
  - progress and cancel;
  - export with a missing render shows the pre-render step;
  - the consent button is required before the download call.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(web): live composition preview, storyboards and on-demand render`.

---

### Task 9: Live verification and docs

- [ ] **Step 1. Live checks** in a throwaway environment with Haiku and the built desktop app (temporary userData):
  - a new creative with Reel 9:16 and Post 1:1: the agent delivers compositions (no render or dependency installs in its turn), the storyboard appears, the live preview plays in the app, Render produces a valid mp4 and png, then export the ★ versions;
  - a change request: the history behaves as in phase 9;
  - convert a legacy creative created with a phase 9 build in the same throwaway workspace;
  - **render timings on a quiet machine** (check the load) for 6 s and 15 s at 1080×1920, recorded in the decisions log.
- [ ] **Step 2. CLI path.** Run the CLI core in the throwaway environment with system Chrome. Test the Chrome for Testing consent flow against a local fake endpoint, not the real download, unless the orchestrator approves the download.
- [ ] **Step 3. Screenshots** in light and dark: board states, live player, storyboard strip, render progress, System check.
- [ ] **Step 4. Docs:**
  - README "How it works" and "Security" (composition isolation);
  - `docs/output-contract.md` v2;
  - the decisions log;
  - `docs/visual-test-2026-10-08.md` (points 23, 33 and 43 closed);
  - real folder mtimes.
- [ ] **Step 5. Commit:** `docs: phase 10a verification and decisions`.
