# @motion-studio/composition-runtime

The browser runtime of a composition (spec §3 and §5.1). It mounts `composition.json` in the DOM, compiles its animations to
paused WAAPI, seeks to any time deterministically, runs a virtual clock, drives html layers through their contract, and plays in
real time in the live preview. It uses no network API: the page gets the composition inlined, and every file is loaded by the
browser through `<img>`, `<video>`, `<audio>`, `FontFace` and `<iframe>`, from the composition server only.

```
pnpm --filter @motion-studio/composition-runtime build   # → dist/index.html, runtime.js, layer.js, clock.js, preview.js
```

`dist/` holds three classic scripts (IIFE: no imports, no chunks) and one page, built with tsup:

| File | What it is |
|---|---|
| `index.html` | The runtime page. It contains the placeholder `<!--ms-composition-->` that the core replaces. |
| `runtime.js` | The runtime, and the only script of `index.html`. |
| `layer.js` | The html layer bootstrap. The core injects it as the first script of every layer. |
| `clock.js` | The virtual clock alone, for `Page.addScriptToEvaluateOnNewDocument` (optional, belt and braces). |
| `preview.js` | The draft parser (`parseDraft`: zod, jitless, and the composition schema). `runtime.js` adds it to the page in preview mode only, so a render page never loads zod. |

Node-side helpers for the core: `@motion-studio/composition-runtime/page` (`renderRuntimePage`, `injectLayerBootstrap`,
`RUNTIME_FILES`) and `@motion-studio/composition-runtime/dist` (`RUNTIME_DIST_DIR`). Protocol types for the web:
`@motion-studio/composition-runtime/protocol`.

## Contracts

### 1. URL layout (served by the core's composition server, Task 3)

Everything lives under one token prefix on the composition server's own origin (`http://127.0.0.1:<port>`):

| Request | Response |
|---|---|
| `GET /<token>/runtime/index.html?mode=render` | the page for the token's composition: `renderRuntimePage(read(dist/index.html), { base, composition })` |
| `GET /<token>/runtime/index.html?mode=preview&parentOrigin=<urlencoded UI origin>` | the same page, in preview mode |
| `GET /<token>/runtime/{runtime,layer,clock}.js` | the files of `RUNTIME_DIST_DIR` |
| `GET /<token>/<versionDir>/compositions/<format>/<path>` | the composition folder (`assets/…`, `layers/…`) |
| `GET /<token>/<versionDir>/compositions/<format>/layers/<name>.html` | the layer, with `injectLayerBootstrap(html, '/<token>/runtime/layer.js')` applied |

- **The composition is inlined, never fetched.** A token is scoped to one composition folder, so the server knows which
  composition the page belongs to:
  - `base` is the folder relative to the page, `../<versionDir>/compositions/<format>/`, and it must end in `/`;
  - `composition` is the parsed, normalised and validated `composition.json`;
  - `renderRuntimePage` writes them into an inert `<script type="application/json" id="ms-composition">`. The block is never
    executed, so it needs no CSP exception. `<`, `>`, `&`, U+2028 and U+2029 are escaped.
- **Assets resolve against `base`.** The runtime refuses any `src` that does not resolve inside `base` on the page origin.
  This gives the error `assetPathRejected`. A `src` must start with `assets/` or `layers/`; a video clip may also start
  with `media/`.
- **Normalised media** (Task 5). The core prepares a render version of every video clip source and the composition
  server rewrites the clip in the inlined copy (never in the agent's `composition.json`): `src` becomes
  `media/<i>.mp4`, with the probed `sourceFps`, `sourceStart`, `sourceVideoEnd` and `sourceTrusted: true`. The server maps
  exactly those paths, under `base`, to the session's files in `<project>/.studio/cache/media/`. `media/` is never a
  composition path (those start with `assets/` or `layers/`), so it cannot collide with the agent's files.
  - The normalised file has no audio. The core also sets `audioSrc` (the original `assets/…` file, served as before) and
    `audioStart` (where the original's first video frame sits on its media timeline). In **preview** mode the runtime
    mutes the clip's `<video>` and plays `audioSrc` in an `<audio>` element kept on the timeline like an audio clip, at
    `audioStart + trimStart + (t − start)`, with the clip's volume and its track's mute. In **render** mode nothing
    changes: the core mixes the sound from the original with ffmpeg, aligned to the first video frame the same way.
- **Hidden clips and tracks** (`hidden: true`, the editor's eye) are not mounted, in either mode: not drawn, not heard. The
  core's audio mix skips them too. A `muted` track is silent in the preview and left out of the mix.
- **No `<base>` element** is used, so `base-uri 'none'` stays.

### Headers the runtime needs (learned in real Chrome, see the integration test)

- **CSP.** Task 3's CSP works as specified (`connect-src 'none'`, `script-src 'self' 'unsafe-inline'`, `font-src 'self'`…), with
  one exception: **`frame-ancestors` goes only on `runtime/index.html`.**
  - In the preview, a layer's parent is the runtime page, whose origin is opaque.
  - Chrome matches no `frame-ancestors` source against an opaque ancestor. Tried: `'self'`, the server origin,
    `http://127.0.0.1:*` and even `*`.
  - So any `frame-ancestors` on a layer response blocks the layer.
- **CORS for fonts.** The preview document and every layer have opaque origins (`Origin: null`), and fonts are always
  fetched in CORS mode.
  - When a request carries `Origin: null`, answer `Access-Control-Allow-Origin: null`. Otherwise every font fails
    (`fontLoadFailed`).
- **CORP.** `Cross-Origin-Resource-Policy: same-origin` blocks even `runtime.js` in the preview (`ERR_BLOCKED_BY_RESPONSE`).
  - Send `cross-origin`, or no CORP header. The per-session token is what guards the files.
- **Media.** Serve `Range` requests (`206`), so videos can seek.

### 2. Render-mode API: `window.__ms` (driven over CDP, Task 4)

| Member | Meaning |
|---|---|
| `__ms.ready(): Promise<{ duration, fps, width, height, frames, errors }>` | Resolves when all of this is done: mounted, every declared font `FontFace.load()`ed, images decoded, videos loaded (`loadeddata`), every layer connected with its fonts loaded and `msReady` awaited, and t = 0 shown. It rejects only on a fatal error (no composition data, a bad base, a malformed composition or one the mount cannot handle, or a `frameTimeout` on the first frame). Asset problems appear in `errors`: Task 4 decides whether they fail the render. |
| `__ms.seek(t): Promise<void>` | Shows composition time `t` in seconds, clamped to `[0, duration]` (a still is always 0). See "Seek" below. It rejects with `frameTimeout` when no frame was painted; the renderer must then fail, never capture. |
| `__ms.duration`, `__ms.fps`, `__ms.width`, `__ms.height` | From the composition. `duration` is 0 for a still. |
| `__ms.mode` | `'render'` or `'preview'`. |
| `__ms.errors` | Every `RuntimeError` reported so far. |

- **The frames.** Capture `frames = round(duration × fps)` frames (one for a still) at `t = i / fps`.
- **Clip visibility.** A clip is visible when `start ≤ t < start + duration`, with 1 µs of tolerance.
  - At `t = duration`, the clips that end with the composition stay visible.
  - In a still, every visual clip is visible.

**Seek** (`mount.ts`, `doSeek`) runs these steps in order:
1. The virtual clock goes to `t`.
2. Fonts are awaited.
3. Clip visibility is set, and every JSON animation gets `currentTime = (t − clip.start − anim.start) × 1000`.
4. In parallel:
   - every visible video seeks to the **centre of its source frame**: `(i + 0.5) / sourceFps`, where
     `i = floor((trimStart + t − start) × sourceFps)`. Without `sourceFps` (VFR or unknown), it seeks to the source time plus
     1 ms. The last video frame is held past the end of the video: the end is `sourceVideoEnd` when given (the video
     track can end before the audio), else the element's duration. Each seek awaits `seeked`, with no
     `requestVideoFrameCallback` (spike §1);
   - **render mode draws each video's frame into a `<canvas>`** (the `<video>` itself stays hidden). Measured in Chrome 154
     with 4 pages seeking at once: a video layer shown for the first time attaches to the compositor asynchronously, and a
     screenshot then showed the frame decoded at load (source frame 0) in 11–13 of ~100 first-visible frames, even after
     `seeked`, two animation frames and `requestVideoFrameCallback` reporting the right frame; extra frames or keeping the
     layer at opacity 0 did not help. The canvas holds the source region shown (`object-fit: cover`) at the clip's
     effective on-screen scale, never more pixels than that region has. The preview keeps the `<video>` (it plays);
   - **which frame is drawn** (`frameVerdict` and `pickVideoFrame` in `timing.ts`): the frame is read as a WebCodecs
     `VideoFrame` and checked by its timestamp and duration, in whole microseconds, because `drawImage` right after
     `seeked` can still read the previous frame. A frame covers `[ts, ts + duration)`:
     - **drawn** when it covers the target (`ts ≤ target + ε` and `ts + duration > target − ε`, ε = 100 µs): a frame is
       past only when it ended at least ε before the target;
     - **the last video frame is drawn** for a target past the video's end: with `sourceVideoEnd`, a frame at or before
       the target that reaches it; without it, a frame at or before the target that is the same on two reads while the
       element sits at the end of the media;
     - **strict rule, trusted sources** (`sourceTrusted: true` and a positive frame duration): a frame that ended before
       the target is never drawn. If no right frame comes before the seek's deadline, the runtime reports
       `videoSeekTimeout` and `seek(t)` **rejects at once** (fail fast): the renderer stops on the first such seek instead
       of waiting out the 60 s deadline of every later one;
     - **lenient rule, untrusted sources** (no `sourceTrusted`: agent-declared values, a source the core could not
       normalise, or a frame with no duration): container durations can be wrong (Chrome reports a WebM's default frame
       duration, 1/30 s, for frames that last longer), so a correct frame must never fail the render. A frame that does
       not cover the target is drawn once it reads the same twice, one animation frame apart, with a **non-fatal
       `videoFrameMismatch`** warning (the renderer returns it in `warnings`). This proves the frame stopped changing,
       not that it is the right one. The first-seek protection still holds: the frame held before a video's first seek
       (the load frame) is recognised by its timestamp, and while the target is more than one frame after it the frame is
       read again until it changes; only at the seek's deadline is it drawn, with a warning, instead of failing;
   - **source fields** (all optional, next to `sourceFps`; not in the agent's schema). From Task 5 the core normalises
     every video clip (H.264, constant frame rate equal to the composition's, short GOP), probes the result with ffprobe
     and sets them after validation, overriding anything the agent declared, so every normalised clip gets the strict
     rule:
     - `sourceStart` (seconds): where the source's first frame sits on the media timeline (a file whose first timestamp
       is 0.1 s);
     - `sourceVideoEnd` (seconds): the end of the video track on the media timeline;
     - `sourceTrusted` (`true`): the core probed the source and vouches for these values. It counts only together with a
       usable `sourceVideoEnd` (`sourceTrustedOf`): a trusted clip without it would fail for targets between the end of
       its video and the end of a longer audio track, so it gets the lenient rule instead. The core always sets both;
   - **colour:** measured in Chrome 154 (a one-off check of a `<video>` element against `drawImage(VideoFrame)` into a
     canvas, four flat patches). Chrome reads an untagged source as BT.709, and its two paths differ: the `<video>`
     (preview) converts the BT.709 transfer to sRGB, the canvas (render) does not, so mid-tones were up to 10 levels apart
     (red patch 211 vs 205; a BT.709-tagged file: 198 vs 190). The core's normalised files (Task 5) are therefore read as
     BT.709 when untagged (Chrome's own assumption: the result shows exactly what the render canvas showed for the
     original) and tagged BT.709 matrix and primaries, limited range, with an **sRGB transfer** (IEC 61966-2-1). With that
     tag both paths show the same values (0 difference measured);
   - every visible layer gets `seek(t − clip.start)` (see 4).
5. Two **native** animation frames.
   - **Render mode:** each frame may take as long as the seek timeout. If the native frame never arrives, the runtime
     reports `frameTimeout` and `seek(t)` rejects, so the renderer never captures a frame that was not painted. A layer
     does the same inside its own frame, with half the layer timeout, and its `frameTimeout` fails the seek too.
   - **Preview:** each frame falls back to a 100 ms native timer, because a hidden or throttled frame produces none.

**Time limits.** The runtime has generous native-time limits: load 120 s, video seek 60 s (one deadline for the `seeked`
wait and the frame check together), layer 60 s. When one runs out, the
runtime reports an error and goes on (render mode: a video frame that could not be drawn rejects the seek, see above). It
never hangs. Task 4 still puts its own timeout on each `Runtime.evaluate`.

**The virtual clock** (`clock.ts`):
- In render mode, `runtime.js` installs it as its very first statement. It is the only script of the page.
- It freezes `Date` (epoch 2026-01-01T00:00:00Z plus t), `performance.now`, `requestAnimationFrame`, `setTimeout` and
  `setInterval`.
- `advanceTo(ms)` fires the timers that are due, in order, then one animation frame at `ms`.
- String timer handlers are ignored.
- **No deadlock.** The runtime and `layer.js` keep the native functions and never wait on virtual ones. The two animation
  frames after a seek are native, and so are their time limits, so a frozen clock cannot stall a seek.

### 3. html layers (spec §3.2 contract)

- **The iframe.** A layer is `<iframe sandbox="allow-scripts" src="<base>layers/x.html" name="ms-layer:{json}">`, in both modes.
  - It has its own opaque origin, so it cannot reach the runtime or the UI.
  - The runtime never touches its document. Render and preview behave the same way.
- **Clock injection.** The core injects `layer.js` as the **first script** of the layer: `injectLayerBootstrap` puts it right
  after the doctype, or at the start. It runs before any layer code and does three things:
  - it installs the **virtual clock** in the layer, in both modes. In the preview, the runtime advances it on every animation
    frame, so rAF, `Date` and timer code follows the timeline, pauses and scrubs;
  - it defines a frozen `window.msParams` from the iframe's `name`, which is readable before any script runs. An `image`
    param becomes an absolute URL inside the composition;
  - it adds the composition's fonts to the layer document.

  Task 4 may also inject `clock.js` with `Page.addScriptToEvaluateOnNewDocument`. Installing the clock is idempotent.
- **The private channel.** After the iframe's `load`, the runtime posts `{ type: 'ms-layer-connect', v: 1 }` with a
  transferred `MessagePort`. `layer.js` accepts it only from `window.parent` and answers `hello`.
  - The runtime validates every reply with `parseLayerReply`: `ok` must be a boolean, and `warnings` must hold at most 20
    strings, each cut to 300 characters. Anything else is ignored, and the request times out like an unanswered one.
  - So a hostile layer can only spoil its own clip. It cannot make `__ms.ready()` reject.
- **Ready.** Every font face of the layer (its own `@font-face` rules and the composition fonts) is `FontFace.load()`ed, then
  `msReady` is awaited.
- **Seek(t),** where `t` is the layer's local time in seconds:
  1. the clock goes to `t`;
  2. every `document.getAnimations()` is paused at `t`;
  3. `msTimeline` goes to `t`: `seek(t, false)` (GSAP style), or `currentTime = t × 1000` (WAAPI style);
  4. `msSeek(t)` is awaited;
  5. then two native animation frames.

  While `msSeek` or `msReady` is pending, the frozen clock is **pumped at the current time**, once per native macrotask:
  - the timers that are due fire first;
  - an animation frame fires only after a macrotask in which no timer fired.

  So layer code that awaits `setTimeout(0)` or `requestAnimationFrame` cannot deadlock, and time does not move.
- **What is deterministic:**
  - CSS animations and transitions, WAAPI animations that exist when a seek starts, `msTimeline`, and `msSeek` are set from `t` alone;
  - `Date`, `performance.now`, timers and rAF read the virtual clock;
  - code that only depends on these values is deterministic. Pumping fires timers and frames at the same `t`, so a time-pure
    callback draws the same thing however many times it runs.
- **What is not deterministic:**
  - state that builds up from timer or rAF history (counters, simulations, a flag set by a timer). It depends on the seek
    history and on how many pump rounds an `msSeek` needed. Renders seek forward within each segment, but layers must still
    be **time-pure**;
  - **animations created after the seek began.** `layer.js` sets every animation found at the start of the seek and after
    `msSeek`, and nothing later. A layer that creates animations late, from a timer, a rAF or an event, must drive them
    itself through `msTimeline` or `msSeek(t)`.
- **Clock bypasses.** These are residuals, and each one only affects the layer's own rendering: a layer is a sandboxed
  frame with its own opaque origin, so it can never reach the runtime, the composition timeline or the UI.
  - `window.__msClock.native` exposes the real timing functions, and code that uses them is not frozen;
  - a nested `srcdoc` or `about:blank` iframe inside a layer has a fresh, unpatched realm. Task 4's CDP
    `addScriptToEvaluateOnNewDocument(clock.js)` also covers nested frames;
  - Workers, AudioContext time, media playback, `requestIdleCallback` and `document.timeline` are not virtualised. The
    spec forbids Workers, AudioContext and autoplaying media in layers, and `staticLayerCheck` flags them.

### 4. Preview `postMessage` protocol (Task 8)

The types and validators are in `src/protocol.ts`, imported as `@motion-studio/composition-runtime/protocol`.

- **The page URL** is `…/runtime/index.html?mode=preview&parentOrigin=<origin>`. `parentOrigin` must be an exact serialized
  `http(s)` origin. Otherwise there is no messaging at all.
- **The iframe.** The UI embeds it as `<iframe sandbox="allow-scripts" allow="autoplay" src=…>`, without `allow-same-origin`.
  - `allow="autoplay"` lets audio play; when it is blocked, the runtime plays muted and reports `audioBlocked`.
- **The runtime's side:**
  - it posts only to `window.parent`, with `targetOrigin = parentOrigin`;
  - it accepts a command only when `event.origin === parentOrigin && event.source === window.parent`, and the command passes
    `parseIncoming`;
  - it ignores everything else: unknown types, extra fields, bad values.
- **The UI's side:**
  - it accepts a message only when `event.source === iframe.contentWindow`. The origin is `"null"`, and a layer, a grandchild
    frame, could post to the top window too;
  - it validates the message with `parseOutgoing`;
  - it sends commands with `iframe.contentWindow.postMessage(cmd, '*')`, because an opaque origin cannot be targeted. Commands
    carry no secrets.

| Direction | Message |
|---|---|
| out | `{ type: 'ready', version: 1, duration, fps, width, height, scenes, errors }`, once, after loading. Load errors are in `errors`. Nothing except fatal errors goes out before `ready`, and commands sent before it are dropped. |
| out | `{ type: 'time', t, playing }`, on every animation frame while playing, and after each seek or pause. |
| out | `{ type: 'error', error: { code, message, clipId? } }`. `code` is one of `RUNTIME_ERROR_CODES`; the UI translates it, and `message` is an English developer detail. |

`parseOutgoing` returns a clean copy of each message: it drops unknown keys and checks every string's type. Error messages are
cut to 2000 characters. An id longer than 64 characters or a scene name longer than 200 rejects the message, and so do more
than 200 scenes or errors.
| out | `{ type: 'clipBounds', clipId, bounds: { x, y, width, height } \| null, scale }`, in iframe CSS pixels, with animations included. It is sent after `select`, after each seek or pause, and on a scale or viewport change. |
| in | `{ type: 'seek', t }` pauses, then does a full deterministic seek. Seeks coalesce to the latest. |
| in | `{ type: 'play', loop?: boolean = true, rate?: 0.1–4 = 1 }` plays in real time. Video and audio are synced to the timeline within one frame, and audio volume follows `volume` and the fades, clamped to 1. |
| in | `{ type: 'pause' }` |
| in | `{ type: 'select', clipId: string \| null }` |
| in | `{ type: 'setScale', scale: 'fit' \| 0.01–8 }`. `fit` letterboxes the stage in the viewport. A number zooms and keeps the stage centred. |
| in | `{ type: 'mute', muted }` silences every sound of the preview, or restores each one's own setting. |
| in | `{ type: 'setComposition', composition, keepTime?, seq }` (Phase 10b, preview only; render mode never listens). `parseIncoming` needs the draft parser (`./draft`, loaded from `preview.js`; without it the draft is refused): it serialises the draft once, refuses it above `COMPOSITION_LIMITS.jsonBytes` (UTF-8) and checks it with `compositionSchema` (structure only). The runtime mounts it below the mount shown, in the same document, loads it, seeks it to the kept time (clamped; 0 without `keepTime`), then swaps it in and destroys the old mount (animations cancelled, media and layer frames released, fonts deleted). Scale, mute, play state and the selection (when its clip still exists) carry over. Drafts that arrive during a re-mount wait; only the latest is mounted next. A video clip whose `src` is a source the session normalised (`originalSrc` in the inlined copy) plays the same `media/<i>.mp4`. |
| in | `{ type: 'sessionMedia', src, index, sourceFps, sourceStart, sourceVideoEnd, audioStart? }` (Phase 10b, preview only): a video the core staged for the draft (`assets/lib/…`) was normalised and added to the session's media. A draft video clip whose `src` is `src` then plays `media/<index>.mp4` with these source fields (trusted), and its sound, when `audioStart` is given, from `src` itself. The core serves only the indices it added to that session. Applies to the drafts that follow. |
| out | `{ type: 'compositionApplied', seq, errors }` after a draft is shown (its `time` and `clipBounds` go first), or after it failed to mount (the old one stays). `errors` are the draft's load problems; they are not also sent one by one. |

## Animations

There is one table of presets, `PRESET_TABLE` in `animations.ts`. The slides move by a tenth of the composition.

| Preset | What it animates |
|---|---|
| `fadeIn` | opacity 0 → 1 |
| `fadeOut` | opacity 1 → 0, ending with the clip unless a start is given |
| `slideUp`, `slideDown`, `slideLeft`, `slideRight` | the y or x offset, from that side to 0 |
| `popIn` | scale 0.5 → 1 with an overshoot, plus opacity 0 → 1 |
| `scaleIn` | scale 0 → 1 |
| `wipe` | a left-to-right `clip-path` reveal |

**Defaults.** Presets and tweens default to `ease-out`. Keyframes are linear unless a keyframe sets its own `ease`, which
applies from that keyframe on. Ken Burns is linear over the whole clip.

**The two elements of a clip.** The box (`x`, `y`, `width`, `height`, `rotation`, `scale`, `opacity`) sits on the clip
element. Animations run on the clip's content element, so they combine with the box:
- `x` and `y` are offsets (`--ms-x` and `--ms-y`);
- `scale` and `opacity` multiply the box values;
- `rotation` adds to the box rotation.

`color` animates the text colour, and the shape fill, which is `currentColor`. `blur` is a `filter`.

**Several animations on one property** are ordered by start, and the latest started one wins. Only the first fills
backwards, so a delayed `fadeIn` keeps the clip hidden, and a later `fadeOut` never hides it early.

## Tests

- **jsdom unit tests** cover: preset keyframes, visibility boundaries, the video frame centre at 24, 25 and 30 fps with
  `trimStart`, the virtual clock, the page and bootstrap helpers, the message protocol (wrong origin, wrong source and unknown
  types are ignored), the mount, and a static check that no network API is used.
- **`test/chrome.integration.test.ts`** runs the built bundle in headless Chrome. It uses system Chrome or `CHROME_PATH`, and
  never downloads one. A tiny 127.0.0.1 server serves the URL layout above. Chrome runs with `--headless=new`, a temporary
  `--user-data-dir` under the OS temp folder, network lockdown flags, and its own process group, which is killed afterwards.
  - Without Chrome, the test is skipped with a message. **`MS_REQUIRE_CHROME=1`** (CI) turns the skip into a failure.
  - The video check also needs ffmpeg: `FFMPEG_PATH` or the usual places.
  - The test font is vendored: `test/fixtures/fonts/jetbrains-mono-latin-400-normal.woff2`, JetBrains Mono, SIL Open Font
    License 1.1. Its licence is in `test/fixtures/fonts/OFL.txt`.
