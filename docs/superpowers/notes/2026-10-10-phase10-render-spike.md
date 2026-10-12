# Phase 10 render engine — technical spike

Date: 2026-10-10. Branch `spike/phase10-render` from `main` at `a484c50`. Decisions log 127 (own web composition, headless Chromium + ffmpeg, outside the sandbox, no Remotion).

Machine: Apple M1 Pro, 10 CPUs, 16 GB, macOS (Darwin 25.6), Node 24.9 (arm64).
- Google Chrome 154.0.8037.98 (universal binary). Electron 44.7.0 (Chromium 152.0.7977.130). chrome-headless-shell 154.0.8037.98 (Chrome for Testing, downloaded for the beginFrame check).
- ffmpeg 8.0.1 at `/usr/local/bin/ffmpeg` is an **x86_64 binary running under Rosetta**, so encoding numbers are pessimistic.
- **Load average 100 to 245 during every measurement** (other work on the machine), with 10 cores. Every table gives the 1-minute load average at the start and end of the measurement. Absolute times are pessimistic: compare the rows with each other, not with a quiet machine.

Spike code: `spike/` in this branch (zero-dependency CDP client over `--remote-debugging-pipe`, confined server, runtime, benches, hostile pages, Electron probe, schema draft). Media and outputs live in the session scratchpad and are not committed.

## Verdict, one line per question

| # | Question | Recommendation | Key number |
|---|---|---|---|
| 1 | Deterministic capture | **Explicit seek(t)** driven by the core, **plus a timesnap-style virtual clock** injected into every frame for free JS. No CDP virtual time, no beginFrame. | seek + clock: **180/180 frames bit-identical** across two renders (CSS, WAAPI, GSAP, canvas rAF), video frame exact 180/180 |
| 2 | Performance | `Page.captureScreenshot` **JPEG q85, streamed to ffmpeg stdin**, one page per render by default; parallel pages only when cores are free. Concat with the concat demuxer is seamless. | 15 s: 150 s with 1 page, **67 s with 4 pages**; JPEG pipe 65 s vs PNG pipe 71 s for 6 s (load 140–190) |
| 3 | Chromium source | Desktop: **Electron's own Chromium** in an offscreen, sandboxed `BrowserWindow` with a confined custom protocol. CLI/npx: **system Chrome found on disk**, fallback **chrome-headless-shell downloaded on demand** (≈95–115 MB zip); talk CDP over the pipe ourselves, **no puppeteer**. | Electron CDP screenshot 6.3 fps, `capturePage` ≈10 fps vs headless Chrome 3.6 fps (180 frames, load ≈140–150) |
| 4 | Isolation | Four layers together: confined token-prefixed server (or custom protocol), **CSP header**, **Fetch interception allowlist**, **dead proxy + NOTFOUND resolver** flags; plus temp profile, per-frame `Runtime.evaluate` timeout, `--max-old-space-size`, and a **footprint watchdog that kills the process group**. No single layer is enough. | every hostile probe blocked with all layers; each layer alone leaks something (table §4) |
| 5 | Audio | ffmpeg `atrim → volume → afade → adelay → amix(normalize=0) → alimiter`, then 2-pass `loudnorm` if a target loudness is wanted. Adequate. | onset error **1 sample @48 kHz** (0.02 ms), same after AAC/mp4 mux |
| 6 | Format | JSON timeline (tracks → clips, props, simple animations) that the editor owns; free HTML only inside `html` clips, reached by the editor only through declared `params`. | schema draft in `spike/schema/composition.schema.json` |

## 1. Deterministic frame capture

### Setup

- Runtime (`spike/runtime/runtime.js`) turns the JSON into DOM. Each clip is an absolutely positioned element.
  - JSON animations become **paused WAAPI** animations (`translate`, `scale`, `rotate`, `opacity` as separate properties).
  - Ken Burns is a paused WAAPI animation on the `<img>`.
  - Video is a muted `<video>`; seeking sets `currentTime` and awaits `seeked`.
  - An `html` clip is a same-origin `<iframe>`. On seek the runtime pauses every `document.getAnimations()` in it and sets `currentTime`, calls `msTimeline.seek(t)` (GSAP contract) and `msSeek(t)` if present.
- `window.__ms.seek(t)` returns when every layer is positioned; the driver then calls `Page.captureScreenshot`.
- Test composition (6 s, 1080×1920, 30 fps, 3 scenes):
  - background H.264 video (testsrc2) with a **frame-code strip**: five grey blocks encoding the source frame number in base 4. Grey survives the BT.601/709 matrix mismatch; an earlier RGB code was decoded wrong by 8 frames.
  - title/subtitle text in a local web font (Chalkduster copied to `assets/spikefont.ttf`), a card shape, an SVG logo with rotate + pop;
  - photo with Ken Burns + sliding caption;
  - outro `html` layer: CSS `@keyframes` pulse, a GSAP 3.15 timeline (bars + word), and a **canvas animated with rAF + `performance.now()`**.
- Fidelity bench: render all 180 frames in a fresh browser, twice, PNG; compare SHA-1 per frame and decode the video strip from each screenshot.

### Results (180 frames, 2 renders each, fresh browser and profile per render)

| Mode | Load (start→end) | Intro (text/SVG) identical | Photo (Ken Burns) identical | Outro (CSS+GSAP+canvas) identical | Video frame exact |
|---|---|---|---|---|---|
| seek, run A | 126→162 | 60/60 | **25/60** | **0/60** | 180/180, 180/180 |
| seek, run B | 194→172 | 60/60 | 60/60 | **0/60** | 180/180, 180/180 |
| seek + virtual clock | 205→239 | 60/60 | 60/60 | **60/60** | 180/180, 180/180 |
| seek + clock, video seek at half-frame, no rVFC wait | 157→172 | 60/60 | 60/60 | 60/60 | 180/180, 180/180 |
| seek + clock, video seek **exactly on the frame boundary** | 171→162 | 59/60 | 60/60 | 60/60 | **118/180** (others −1 frame) |
| CDP virtual time (`Emulation.setVirtualTimePolicy`, page playing) | ≈160 | — | — | — | first frame showed video frame **108** instead of 0; the 2nd budget never expired (hang) |
| `HeadlessExperimental.beginFrame` (chrome-headless-shell 154) | — | — | — | — | `Target.createTarget: BeginFrameControl is not supported on MacOS yet` |

Pixel diff of the outro in seek mode (`bench/diff.mjs`): every difference is inside the canvas bounding box (`4,1192–1074,1427`). **CSS `@keyframes`, WAAPI and the GSAP timeline were bit-identical in every mode.** Only free JS that reads the clock is non-deterministic, and the virtual clock fixes it.

The Ken Burns differences in seek run A were intermittent (0 in four other renders of the same frames, including two clock runs). They look like raster/decode timing of the 2400×3600 JPEG under load. A real render can only *detect* this, by rendering a frame twice (see risks).

Video:
- Seeking to `t + 0.5/fps` (middle of the source frame) is frame-exact. Seeking exactly to `i/fps` shows the previous frame about 1 time in 3.
- Waiting for `requestVideoFrameCallback` after `seeked` adds nothing. In headless it only fires when a frame is produced, so it mostly hit the 200 ms fallback: seek time 68–73 s vs 5–6 s for 180 frames, same correctness. It is now opt-in (`rvfc=1`).
- No drift: the strip matched the expected source frame on 180/180 frames in every seek mode, over 6 s. The 15 s renders in §2 checked 450/450 output frames.

Fonts (3 renders each, first captured frame with visible text = 20, outro frame 150):

| Variant | `document.fonts.status` / FontFace status before 1st frame | Frames identical to the waited render |
|---|---|---|
| JSON fonts loaded with `FontFace.load()` (default) | `loaded` / `loaded` | 3/3 |
| no font wait (`nofontwait=1`) | **`loaded` / `unloaded`** | 3/3 |
| iframe `@font-face` not force-loaded | iframe face `unloaded` | 3/3 |

- **`document.fonts.ready` is not a font gate.** It resolved with the face still `unloaded`, because nothing had requested it yet. A hidden iframe's `@font-face` is lazy the same way.
- The frames came out right anyway: the font is local and Chrome hides text during the font block period. That is a race, not a guarantee.
- The runtime now calls `FontFace.load()` for JSON fonts and for every face declared inside each html layer before `ready` resolves.

**Recommendation (Q1).**
- Seek-driven rendering. The core owns time; the page exposes `seek(t)`.
- Inject the virtual clock (`spike/runtime/clock.js`, ≈50 lines) with `Page.addScriptToEvaluateOnNewDocument` so free JS in html layers is deterministic too. It freezes `Date`, `performance.now`, rAF and timers, and the runtime advances them per frame in every frame.
- Video: seek to mid-frame, await `seeked`, no rVFC.
- Do not build on CDP virtual time: it does not govern media and it hung. Do not build on beginFrame: it is Linux-only.
- GSAP is used through a `msTimeline` contract (paused timeline), not by driving its ticker.

## 2. Performance

Setup (`spike/bench/perf.mjs`):
- The same 3-scene composition, stretched to 6 s (180 frames) or 15 s (450 frames). 1080×1920, 30 fps, seek mode, video seek at mid-frame without the rVFC wait.
- Encoded with x86 ffmpeg: `libx264 -preset veryfast -crf 20 -pix_fmt yuv420p`. JPEG quality 85, `optimizeForSpeed: true`.
- **total** = launch browser → open page(s) → capture → encode → concat → close; **ready** = open + `__ms.ready` (launch excluded).
- N pages = N tabs in one browser, each rendering a contiguous segment into its own ffmpeg, then `ffmpeg -f concat -c copy`.
- **seamless**: the frame code of *every* frame of the final mp4 was decoded and compared with 0…N−1. Every run matched exactly: no duplicated or missing frames at the joins.

| Duration | Capture | Sink | Pages | Browser | runs | total s (median) | total s (all) | capture fps (median) | ready s | encode tail s | seamless | load range |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 6 s | PNG | pipe | 1 | Chrome | 3 | **71.3** | 70.3 / 71.3 / 72 | 3.24 | 9 | 0.5 | yes (180/180) | 148–171 |
| 6 s | JPEG | pipe | 1 | Chrome | 3 | **65.4** | 63.8 / 71.6 / 65.4 | 3.62 | 8.6 | 0.3 | yes (180/180) | 137–148 |
| 6 s | PNG | files | 1 | Chrome | 3 | **70.3** | 77.9 / 68.5 / 70.3 | 3.48 | 8.7 | 3.7 | yes (180/180) | 135–141 |
| 6 s | JPEG | files | 1 | Chrome | 3 | **67** | 85.4 / 66.6 / 67 | 3.73 | 9.4 | 3.5 | yes (180/180) | 135–153 |
| 6 s | JPEG | none | 1 | Chrome | 3 | **63** | 60.7 / 77.7 / 63 | 3.73 | 8.6 | 0 | n/a | 140–145 |
| 6 s | JPEG | pipe | 1 | headless-shell | 3 | **56.6** | 58.6 / 55.8 / 56.6 | 3.22 | 0.2 | 0.4 | yes (180/180) | 127–145 |
| 6 s | PNG | pipe | 1 | headless-shell | 3 | **59.1** | 55.7 / 59.1 / 59.9 | 3.09 | 0.1 | 0.5 | yes (180/180) | 129–136 |
| 6 s | JPEG | pipe | 2 | Chrome | 3 | **42.7** | 40.4 / 42.7 / 44.6 | 7.66 | 9.9 | 0.3 | yes (180/180) | 131–139 |
| 6 s | JPEG | pipe | 4 | Chrome | 3 | **38.5** | 38.5 / 38.7 / 38 | 9.43 | 12.4 | 0.4 | yes (180/180) | 139–186 |
| 15 s | JPEG | pipe | 1 | Chrome | 3 | **150.5** | 150.6 / 150.5 / 147.4 | 3.33 | 8.5 | 0.4 | yes (450/450) | 152–186 |
| 15 s | JPEG | pipe | 4 | Chrome | 3 | **67.2** | 60.9 / 68.7 / 67.2 | 10.09 | 13 | 0.5 | yes (450/450) | 151–169 |

Variants (single runs):

| Duration | Capture | Sink | Pages | Browser | runs | total s (median) | total s (all) | capture fps (median) | ready s | encode tail s | seamless | load range |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 6 s | JPEG | pipe | 1 | Chrome `--use-angle=metal --enable-gpu` | 1 | **69.5** | 69.5 | 3.53 | 9.3 | 0.3 | yes (180/180) | 144–150 |
| 6 s | JPEG | pipe | 1 | Chrome `--use-angle=swiftshader` | 1 | **124.3** | 124.3 | 1.66 | 9.4 | 0.3 | yes (180/180) | 146–149 |

| Other measurements | Result |
|---|---|
| Same 6 s JPEG/PNG pipe with the `requestVideoFrameCallback` wait after each video seek (first batch, load 166–214) | capture **1.9–2.0 fps**, total 108–165 s: the wait mostly hits its 200 ms fallback in headless. Removed. |
| Launch + first page ready, system Chrome `--headless=new` vs chrome-headless-shell (`bench/ready.mjs`, load ≈150) | Chrome: launch **6.1–6.4 s**, first open 5.5–11.8 s, second open 1.3–4.3 s. headless-shell: launch **0.12–0.34 s**, first open 0.08–0.13 s. |
| `Page.startScreencast` (PNG) as the source: seek, then take the next screencast frame (90 frames, load 173→179) | **0.53 fps**; 50 seeks produced **no frame within 3 s** (no damage → no screencast frame); 3 of the 40 delivered frames were the wrong source frame. Not usable for frame-accurate capture. |
| `HeadlessExperimental.beginFrame` | not available on macOS (§1) |
| Output size | 6 s ≈ 5.0 MB (JPEG source), 3.8 MB (PNG source); 15 s ≈ 11.7 MB |

Reading:
- **Capture is the bottleneck**: about 0.27–0.30 s per 1080×1920 frame at this load.
  - Encoding with streaming adds 0.3–0.5 s after the last frame: x264 keeps up while frames arrive.
  - Writing files costs 3.5–3.7 s of extra encoding at the end, plus disk: about 1 GB of PNG for 15 s.
- **JPEG vs PNG**: JPEG capture is ≈10 % faster (3.62 vs 3.24 fps), and PNG costs only 0.2 s more to decode in ffmpeg. JPEG q85 is fine as an *intermediate* for H.264 output. Keep PNG for alpha or ProRes 4444 exports and for tests.
- **Parallel pages scale even on this overloaded machine**: capture fps 3.6 → 7.7 (N=2) → 9.4 (N=4); a 15 s render takes 150 s → 67 s (×2.2). Each page pays its own ready time (9–13 s on Chrome), so short renders gain less.
- **chrome-headless-shell** captures slightly slower (3.1–3.2 fps) but starts ≈15 s faster than full Chrome headless, so it wins on 6 s renders.
- Headless Chrome already uses the GPU by default (forcing ANGLE/Metal changed nothing); forcing SwiftShader halves the speed.

**Recommendation (Q2).**
- `Page.captureScreenshot` JPEG q85 (`optimizeForSpeed`), streamed into ffmpeg's stdin (`image2pipe`, `-c:v mjpeg` input).
- N = min(4, free cores / 2) contiguous segments joined with the concat demuxer, verified seamless.
- Default N=1 for previews or when the machine is busy.
- Show progress per frame; budget ≈0.3 s per frame per page on a loaded M1 Pro, faster when idle (to be re-measured).


## 3. Where Chromium comes from

### (a) Desktop: Electron's Chromium

Probe: `spike/electron/main.cjs`.
- One app process with an offscreen `BrowserWindow` (`show:false`, `offscreen:true`, `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`) on an in-memory session partition.
- Composition served by `ses.protocol.handle('ms-comp')`, with path confinement and Range support (needed for video seeking).
- Same runtime and seek loop as Chrome.
- Network blocked with `webRequest.onBeforeRequest`, permissions denied, `setWindowOpenHandler` deny, `will-navigate` prevented.

Two runs of each method, the second batch over the whole 6 s composition (180 frames), seek mode **without** the virtual clock:

| Method | 60 frames (intro only), load 101–114 | 180 frames, load 133–154 | Identical across 2 runs (180 frames) |
|---|---|---|---|
| `webContents.capturePage()` after seek | 3.3–3.4 fps* | **9.8–10.4 fps** | 112/180 |
| `webContents.debugger` → `Page.captureScreenshot` PNG | 2.7–2.8 fps* | 6.0–6.2 fps | 119/180 |
| `debugger` → `Page.captureScreenshot` JPEG | 2.8–3.0 fps* | 6.3 fps | 120/180 |
| offscreen `paint` event after `invalidate()` | 4.3–4.4 fps* | 46–49 fps | **17/180** |
| page ready (load + `__ms.ready`) | 0.27–0.67 s | 0.17–0.42 s | — |

\* The first batch still waited for `requestVideoFrameCallback` after each video seek (≈200 ms per frame, see §1), so only its relative order counts.

- The 60 frames that differ in the CDP rows are the outro canvas: no virtual clock was injected in Electron. The same as Chrome seek mode, and fixable the same way.
- `capturePage` lost 8 more frames, and `paint` is not tied to the seek at all: it returns whatever was last painted.
- Electron's CDP screenshot was ≈1.7× faster than headless Chrome's at a similar load (6.3 vs 3.6 fps), and `capturePage` ≈2.8× faster.
- Electron needs no browser launch: page ready in 0.2–0.7 s vs 6 s launch + 9 s ready for Chrome.

Findings:
- It runs fully hidden inside the app process: no dock icon or window was shown. `capturePage` and `debugger` CDP screenshots of a seeked page are deterministic.
- The `paint` event is not suitable: it is frame-rate driven, and 50/60 frames were identical across runs.
- Gotcha: `win.destroy()` immediately followed by a new window's `loadURL` fails with `ERR_FAILED (-2)` in Electron 44. `close()` and awaiting `closed` fixes it. Use one window per render, or reuse it.
- Electron 44 ships Chromium 152 (Chrome is at 154); H.264 decodes fine (proprietary codecs included).
- Running the render in the main app means a render competes with the UI process for CPU. A dedicated utility/hidden renderer is fine, but cancelling must kill its renderer.

### (b) CLI / npx

| Source | Size | License / terms | Notes |
|---|---|---|---|
| System Chrome on disk | 0 download (app is 2.1 GB installed) | Google Chrome ToS (we only launch the user's own install) | macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (+ `~/Applications`), Chromium/Edge/Brave as fallbacks. Linux: `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser` on PATH. Windows: `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%LocalAppData%\Google\Chrome\Application\chrome.exe`. Must run with `--headless=new` (old headless is gone from Chrome). |
| chrome-headless-shell (Chrome for Testing) on demand | zip: mac-arm64 **99.3 MB**, mac-x64 104.6 MB, linux64 120.6 MB, win64 120.6 MB; unzipped mac-arm64 211 MB | Binary says "Google Chrome … See the Terms of Service at chrome://terms"; bundled `LICENSE.headless_shell` = Chromium BSD + third-party (39k lines). | Download into the app's cache dir on first render, verify, never redistribute in our package. URL pattern `storage.googleapis.com/chrome-for-testing-public/<ver>/<platform>/chrome-headless-shell-<platform>.zip`. |
| puppeteer-core 25.13.0 | 6.0 MB unpacked, no browser | Apache-2.0 | Not needed: our own CDP client is ≈100 lines over `--remote-debugging-pipe` (`spike/lib/cdp.mjs`). |
| chrome-remote-interface 0.34.0 | 2.0 MB | MIT | Not needed for the same reason; it needs a TCP debugging port, which the pipe avoids. |
| @puppeteer/browsers 3.2.4 | 0.45 MB | Apache-2.0 | Handy downloader for CfT if we don't want to write ours. |
| playwright-core 1.64.0 | 13.7 MB | Apache-2.0 | Not considered further. |

The pipe matters for isolation too: no DevTools TCP port is opened, so no other local process can attach to the render browser.

**Recommendation (Q3).**
- Desktop: Electron's Chromium (zero extra download, version pinned with the app), in a hidden sandboxed window on a throwaway partition.
- CLI: detect system Chrome; if absent (or with a `--browser=download` flag), fetch chrome-headless-shell for the pinned version into the cache, with user-visible size and consent.
- Same runtime and the same CDP-level commands in both: the Electron path uses `webContents.debugger`, the CLI path uses the pipe.

## 4. Isolation

Hostile pages (`spike/hostile/pages`) try:
- `fetch`, `<img>`, `sendBeacon`, `WebSocket`, an iframe, a Worker `fetch` and a WebRTC STUN gather, all against `canary.test`;
- `fetch`/`WebSocket` to another loopback port, `window.open`;
- `file:///etc/passwd` (fetch, iframe, img), `../` and encoded traversals, a symlink pointing out of the folder, a path outside the token prefix, and escaping the runtime root;
- an infinite loop in `seek`, and huge heap and ArrayBuffer allocations.

`canary.test` is mapped by `--host-resolver-rules` to a **local canary server**, so a leak shows up as a hit on the canary and nothing reaches the internet. `https://example.com` / `wss://example.com` were requested **only** in configurations with the dead proxy + NOTFOUND resolver active (and in Electron, which also had them). No request left the machine.

Results (Chrome 154, `--headless=new`, temp `--user-data-dir`):

| Probe | none | CSP only | Fetch interception only | flags only (dead proxy + NOTFOUND resolver) | **all layers** |
|---|---|---|---|---|---|
| fetch / img / beacon / iframe / worker → canary | **leaked** (all hit the canary) | blocked | blocked (intercepted) | blocked | blocked |
| WebSocket → canary.test | **leaked** | blocked | **leaked** (Fetch does not see WebSockets) | blocked | blocked |
| fetch/WS → another loopback port | **leaked** | blocked | WS **leaked**, fetch blocked | **leaked** (loopback bypasses the proxy) | blocked |
| example.com fetch / wss | not run | not run | not run | blocked (no DNS, dead proxy) | blocked |
| WebRTC ICE candidates | host, host (local IPs exposed) | host, host | host, host | none | none |
| `window.open` | null (popup blocker) | null | null | null | null |
| `file:///etc/passwd` fetch / img / iframe | failed / failed / no load | same | same | same | same |
| `../`, `%2e%2e`, `..%2f`, `..%5c`, symlink out, no token, runtime-root escape | 403 from the server | 403 | intercepted or 403 | 403 | intercepted or 403 |

- The server confines paths three ways: a random per-render token prefix, `resolve` + prefix check, and `realpath` (symlinks).
- Electron (all its layers on) blocked everything as well. `webRequest.onBeforeRequest` *does* see `ws://` and `wss://` (listed as blocked), `window.open` was denied by the handler, a foreign host on the custom scheme was refused, and `file://` failed. In the page, `typeof require`, `process`, `module` and `window.electron` were all `undefined`.
- Electron still exposed `host` WebRTC candidates. Add `webrtc-ip-handling-policy` or deny it in the session.

CPU and memory:

| Probe | What stopped it | Time |
|---|---|---|
| `while(true){}` inside `seek` | `Runtime.evaluate { timeout: 2000 }` terminated it; the page stayed usable (`1+1` answered) | 2.2 s |
| same, via our own frame timer + `Runtime.terminateExecution` | terminated; page alive afterwards | 12 ms after the call |
| browser kill (last resort) | `Browser.close` + SIGKILL of the process group | 0.5 s |
| JS heap growth, `--js-flags=--max-old-space-size=256` | renderer OOM → `Inspector.targetCrashed` | 19 s, footprint peak 384 MB |
| 3 GB of `Uint8Array` (outside the V8 heap) | **not** stopped by `max-old-space-size` (1.5 GB allocated fine); stopped by our watchdog on the renderer's physical footprint (`top` MEM, includes compressed pages) > 1200 MB → kill | 16.6 s |

- On macOS `ps` RSS undercounts badly: it showed 354 MB for 3 GB allocated, because the memory compressor holds the pages. The watchdog must read the physical footprint.
- **Orphaned renderers**: after `Browser.close`/SIGKILL, Chrome helper renderers re-parented to launchd and survived (10 found after the first runs, ≈1 MB each). Spawn the browser `detached` (own process group), kill the group, then sweep by the unique profile path.

**Recommendation (Q4).**
- Serve from a localhost server bound to 127.0.0.1, with a random port and per-render token prefix, path confinement plus realpath, and a strict CSP header on every response. In Electron, use a custom protocol on a non-persistent partition.
- Add Fetch interception that allows only `base` and fails everything else (in Electron: `webRequest`).
- Launch Chrome with `--proxy-server=127.0.0.1:9 --host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1" --force-webrtc-ip-handling-policy=disable_non_proxied_udp`, a temp `--user-data-dir`, and `--remote-debugging-pipe`.
- Enforce a per-frame evaluate timeout, a total render deadline, `--max-old-space-size`, a footprint watchdog, and a process-group kill.
- **What is guaranteed**: with the flags, nothing non-loopback can leave Chrome even if CSP and interception were bypassed. Loopback is covered by CSP + interception only, so another local service (including the Motion Studio core API) is protected by two layers, not three.
- Our own API should also require a token, so it does not depend on the render page being well-behaved.

## 5. Audio

`spike/bench/audio.mjs` builds one filter graph from the timeline's audio clips. Tones were generated with ffmpeg: voice 300 Hz pulsed, peak −5.5 dBFS; music 220+330 Hz, −3.5 dBFS; sfx 1.5 kHz × 0.15 s, −1.2 dBFS. Load ≈240.

```
[i:a]atrim=0:DUR,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,
     volume=V,afade=t=in:st=0:d=FI,afade=t=out:st=DUR-FO:d=FO,adelay=START_MS:all=1[ai];
[a0][a1]…amix=inputs=N:duration=longest:dropout_transition=0:normalize=0,apad,atrim=0:COMP_DUR,
     alimiter=limit=0.89:level=false[out]
```

| Check | Result |
|---|---|
| Sync: sfx onsets at 2.000 s and 4.000 s, WAV | **+1 sample** at 48 kHz (threshold detection), both |
| Same mix muxed as AAC 192k into mp4 with video, decoded back | +1 sample (0.02 ms): the mp4 edit list compensates AAC priming |
| `amix` default `normalize=1` | everything divided by the input count: voice −24.2 dB RMS vs −12.2 with `normalize=0` (alone −12.8). Music at 4.6–5 s (when it is the only active input) is −21.25 dB in both, i.e. **levels jump when other clips start or stop** |
| `normalize=0`, realistic volumes | peak −0.72 dBFS, no clipping |
| "hot" mix (all clips ×1.5), no limiter | peak **+6.1 dBFS**, 12,460 samples > 0 dBFS, −3.8 LUFS |
| + `alimiter=limit=0.89` | peak −1.01 dBFS, true peak −1.0 dBTP, −6.8 LUFS; 0.46 s |
| + `loudnorm` 1-pass (I=−14, TP=−1.5) | −14.2 LUFS, TP −2.7; 1.2 s; onset shift 1 sample |
| + `loudnorm` 2-pass | −13.7 LUFS, TP −2.3; 1.4 s total; still "dynamic" mode |
| Mix time, 4 clips, 6 s | 0.37–0.47 s (x86 ffmpeg under Rosetta) |

Gotchas found:
- `amix` normalization, above.
- My first level checks used `-ac 1`, which downmixes stereo with +3 dB. Measure one channel.
- `loudnorm` upsamples to 192 kHz internally, so force `-ar 48000`.
- Even 2-pass `loudnorm` fell back to dynamic mode here. Use `linear=true` and accept the fallback, or prefer limiter + gain.

**Recommendation (Q5).** Adequate. Sample-accurate placement and fades from the timeline, with `normalize=0` always and a limiter on the master bus. Loudness normalization is an export option (2-pass `loudnorm`, −14 LUFS for social). Ducking music under voice later can be done with `sidechaincompress` keyed on the voice bus, which is why the schema carries `role`.

## 6. Composition format

Schema draft: `spike/schema/composition.schema.json` (JSON Schema 2020-12). Example: `spike/example/composition.json` (the 6 s spike composition) and `spike/example/layers/outro.html`.

Shape:
- `{ width, height, fps, duration, background, fonts[], scenes[], tracks[] }`.
- `scenes[]`: named time ranges `{id, name, start, duration}`. The editor draws them as segments; a clip may carry `scene` so moving a scene moves its clips.
- `tracks[]`: ordered bottom → top `{id, kind: visual|video|text|audio, muted, hidden, locked, clips[]}`.
- A clip is `{id, type, start, duration, scene?, props, animations[]}` with absolute seconds. Types:
  - `text` (`text`, `fontFamily`, `fontSize`, `fontWeight`, `color`, `align`);
  - `shape` (`fill`, `radius`);
  - `image`/`svg` (`src`, `fit`, `kenBurns{from,to}`);
  - `video` (`src`, `trimStart`, `sourceFps`, `volume`);
  - `html` (`src`, `params`);
  - `audio` (`src`, `trimStart`, `volume`, `fadeIn`, `fadeOut`, `role`).
- Every visual clip has the box `x, y, width, height, rotation, scale, opacity` in composition pixels.
- `animations[]` (times relative to the clip):
  - a preset `{preset: fadeIn|fadeOut|slideUp|popIn, duration}`;
  - or `{prop, from, to, start, duration, ease}`;
  - or `{prop, keyframes:[{t (0..1), v, ease}], duration}`.

  Props: `opacity, x, y, scale, rotation, color, blur`. Easing is a CSS easing string. These compile 1:1 to paused WAAPI, which made them deterministic for free.
- Asset paths must match `^(assets|layers)/…` (relative, no scheme, no `..`), which lines up with the server confinement.

Easy for an agent:
- flat absolute times;
- presets for the common cases;
- CSS vocabulary (colours `#rrggbb`, CSS easings);
- one file;
- free-form creativity goes into `html` layers instead of stretching the schema.

### Boundary: JSON (editor) vs free HTML (agent)

| Lives in the JSON — the editor edits it | Lives in an `html` layer — the editor does not touch it |
|---|---|
| Canvas size, fps, duration, background, fonts | Arbitrary DOM/CSS/SVG/canvas inside the layer's box |
| Scenes, tracks, track order, mute/hide/lock | CSS `@keyframes`, transitions, WAAPI inside the layer (driven automatically by the runtime) |
| Each clip's start, duration, trim, scene | GSAP or other libraries, exposed only via `msTimeline` (paused) or `msSeek(t)` |
| Each clip's box: position, size, rotation, scale, opacity | rAF/Date/timer-based JS (made deterministic by the virtual clock) |
| Text content, font, size, colour, alignment of text clips | Internal layout and choreography of the layer |
| Fill/radius of shapes, image fit and Ken Burns, video trim/volume | Assets referenced by the layer (must be inside the composition folder) |
| JSON animations (presets, from/to, keyframes, easing) | — |
| Audio clips: start, trim, volume, fades, role | — |
| **`params` of an html clip** (e.g. `{ "headline": "Grazie!", "accent": "#fbbf24" }`) — the only knobs the editor exposes for a free layer; the layer reads `window.msParams` | how the layer uses its params |

Contract for an html layer:
- It is time-pure: what is on screen at local time t depends only on t and `params`.
- It may use CSS/WAAPI freely.
- It hands a paused GSAP timeline to `msTimeline`, or implements `msSeek(t)` (may be async).
- It may set `msReady` (a promise) for its own loading.
- It never touches the network, and never reads the real clock in a way that the virtual clock does not cover (Workers, AudioContext time and video playback are not covered).

### Example (abridged from `spike/example/composition.json`)

```json
{
  "$schema": "motion-studio/composition@0",
  "width": 1080, "height": 1920, "fps": 30, "duration": 6, "background": "#0b1020",
  "fonts": [{ "family": "SpikeFont", "src": "assets/spikefont.ttf" }],
  "scenes": [
    { "id": "intro", "name": "Intro", "start": 0, "duration": 2 },
    { "id": "photo", "name": "Foto", "start": 2, "duration": 2 },
    { "id": "outro", "name": "Outro", "start": 4, "duration": 2 }
  ],
  "tracks": [
    { "id": "bg", "kind": "video", "clips": [
      { "id": "bgv", "type": "video", "src": "assets/bg.mp4", "start": 0, "duration": 6,
        "props": { "x": 0, "y": 0, "width": 1080, "height": 1920 } } ] },
    { "id": "visual", "kind": "visual", "clips": [
      { "id": "photo1", "type": "image", "scene": "photo", "src": "assets/photo.jpg", "start": 2, "duration": 2,
        "props": { "x": 60, "y": 300, "width": 960, "height": 1300,
                   "kenBurns": { "from": { "scale": 1.0 }, "to": { "scale": 1.25, "x": -40, "y": -60 } } },
        "animations": [{ "preset": "fadeIn", "duration": 0.25 }] },
      { "id": "outro-html", "type": "html", "scene": "outro", "src": "layers/outro.html", "start": 4, "duration": 2,
        "props": { "x": 0, "y": 400, "width": 1080, "height": 1100 }, "params": { "headline": "Grazie!" } } ] },
    { "id": "text", "kind": "text", "clips": [
      { "id": "title", "type": "text", "scene": "intro", "start": 0.2, "duration": 1.8,
        "props": { "text": "Motion Studio", "x": 90, "y": 640, "width": 900, "fontFamily": "SpikeFont",
                   "fontSize": 120, "color": "#ffffff", "align": "center" },
        "animations": [{ "preset": "slideUp", "duration": 0.6 }, { "preset": "fadeIn", "duration": 0.5 }] } ] },
    { "id": "audio", "kind": "audio", "clips": [
      { "id": "music", "type": "audio", "src": "assets/music.wav", "start": 0, "duration": 6,
        "volume": 0.35, "fadeIn": 0.5, "fadeOut": 1.0, "role": "music" },
      { "id": "vo", "type": "audio", "src": "assets/voice.wav", "start": 0.5, "duration": 4, "role": "voice" } ] }
  ]
}
```

(`params`/`msParams` and `role` are in the schema but were not exercised by the spike runtime.)

## Risks and open questions

1. **Speed.** See §2. Seek + screenshot of a 1080×1920 page is the bottleneck; at this load a 15 s video takes minutes. Needs a re-measure on a quiet machine before setting user expectations, and a progress UI with cancel. Headless Chrome already rasterizes on the GPU (SwiftShader is 2× slower); not measured: WebP/raw capture, an idle machine.
2. **Intermittent raster differences** (Ken Burns frames, 1 render in 6). The output still looks right, but "bit-identical re-render" is not a promise we can make. Do not use frame hashes as a correctness check in tests without a tolerance.
3. **Virtual clock coverage.** Workers, `AudioContext.currentTime`, CSS `transition` started by JS, `<video>` playing inside html layers, and `requestIdleCallback` are not covered. The layer contract must forbid them, or the runtime must patch more. A malicious layer can also restore the native functions; that is fine because determinism is not a security boundary.
4. **Video.** Only H.264 at the composition fps was tested. Variable frame rate, other fps (24 → 30), long GOPs and 4K sources need tests. For heavy or long videos, pre-extracting frames with ffmpeg and showing them as an image sequence may be faster and more robust than `<video>` seeks.
5. **beginFrame is Linux-only**, so there is no per-frame compositor control on macOS. If a Linux server renderer ever exists, it can be reconsidered.
6. **GSAP license.** GSAP 3.15.0 ships under GreenSock's "Standard 'no charge' license" (package.json and file headers; the license text is only at gsap.com, not fetched here). From memory, that license restricts use in tools that compete with Webflow's visual animation builder, and Motion Studio is arguably such a tool. **Have the actual text reviewed before shipping GSAP or recommending it to the agent.** Our runtime does not need GSAP; it was only a determinism test.
7. **Chrome for Testing terms.** The binary declares Google Chrome ToS, so download it on demand to the user's machine and do not redistribute it. Get a legal read on CfT for a commercial CLI; the alternative is pointing at the user's own Chrome.
8. **Loopback exposure.** With the flags, loopback is still reachable at the network level; only CSP + interception stop the page from calling local services. The core's HTTP API must not trust localhost callers without a token.
9. **Memory watchdog on macOS** depends on `top`'s MEM column (physical footprint). It is slow (≈1 s per sample) and not portable; Windows/Linux need their own source (job objects, cgroups/`/proc/<pid>/status`).
10. **Electron path.** Renders inside the desktop app compete with the UI. Consider a separate hidden utility window or process, and measure on a quiet machine. The `destroy()` + `loadURL` race is a footgun.
11. **ffmpeg here is x86_64 under Rosetta.** Ship or detect an arm64 ffmpeg; `h264_videotoolbox` is available and was not measured.

## Reproducing

- Scripts hard-code the scratchpad path in `spike/lib/cdp.mjs` (`SCRATCH`). The media is not committed.
- `comp/` = `spike/example/*`, plus `assets/` generated with ffmpeg:
  - `bg.mp4`: testsrc2 1080×1920 30 fps 16 s with the 5-block grey frame code (`geq=lum='64*mod(floor(N/pow(4,floor(X/216))),4)+32'` on a 1080×120 strip), libx264 `-g 30`, tagged bt709;
  - `photo.jpg`: testsrc2 2400×3600;
  - `voice.wav`, `music.wav`, `sfx.wav`: `sine` sources;
  - `spikefont.ttf`: a copy of a system font;
  - `gsap.min.js`: from the gsap package.
- Benches: `bench/fidelity.mjs <seek|clock|vt> 180 [query]`, `bench/perf-batch.sh`, `bench/fonts.mjs`, `bench/screencast.mjs`, `bench/audio.mjs`, `hostile/run.mjs` (`ONLY=` filter), and the Electron probe `electron/main.cjs <comp> <runtime> <out.json> <frames> <hostileDir>`.

## Packages, downloads, network

- npm (scratchpad only, not in the repo): `gsap@3.15.0`, license "Standard 'no charge' license". `npm view` metadata queries for puppeteer-core, chrome-remote-interface, @puppeteer/browsers, playwright-core, electron.
- Download: chrome-headless-shell 154.0.8037.98 mac-arm64, 99.3 MB, from `storage.googleapis.com/chrome-for-testing-public` (plus HEAD requests for sizes of other platforms and the full CfT Chrome: mac-arm64 191 MB).
- Electron 44.7.0 binary extracted into the worktree's `node_modules` from the local cache (`~/Library/Caches/electron/…/electron-v44.7.0-darwin-arm64.zip`); no download.
- No other network. The hostile tests never reached the internet: canary hostnames resolved to a local server, and external names were only used with the dead proxy + NOTFOUND resolver active.
- Protected folders, mtime before / after: `~/Library/Application Support/Motion Studio` 1791621882 / 1791621882 (unchanged); `~/MotionStudio` 1791538433 / 1791538433 (unchanged).
