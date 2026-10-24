# Motion Studio site

The project's GitHub Pages site: a home page in `src/` with live Motion Studio compositions from `compositions/`, and a
user guide (`src/guide.html`, served at `/motion-studio/guide.html`) with screenshots of the app. The compositions are
played by the product's own runtime (`packages/composition-runtime`) and checked by its own validator (`packages/shared`).
Deployed by `.github/workflows/pages.yml`.

## Build and preview

```bash
pnpm install --filter "@motion-studio/composition-runtime..."
pnpm --filter @motion-studio/composition-runtime build
node site/build.mjs                 # → site/_site (git-ignored)
node site/scripts/serve.mjs         # → http://127.0.0.1:4400/motion-studio/
node --test 'site/test/*.test.mjs'
```

`build.mjs` fails on any composition the product would reject.

## Compositions

Each folder in `compositions/` is a regular Motion Studio composition (`composition.json` and `assets/`) plus:
- `meta.json`: `format` (a preset id), `posterTime` (seconds) and `label` (the description used as alt text);
- `poster.webp`: the frame at `posterTime`, shown before the runtime is ready, under reduced motion and without JS;
- `subtitles.json` (only with a `subtitles` clip): the subtitle set, times in ms, inlined in the runtime page as the core does.

The site's fonts (`src/assets/fonts/`) are copied into every composition's `assets/fonts/` at build time.

The home is a story on the app's canvas (`index.html`, `css/story.css`, `js/story.js`): Motion Studio makes its own launch
video in ten steps. Each `.step` of the page holds its exchange (`.msg--you`, `.msg--agent`, `.msg--event`) and the posters
of its result: that is the page without JS and under reduced motion. With motion, `story.js` builds the chat panel from
the steps and drives the canvas (`[data-stage]`): a world of boards and panels placed with `--x/--y/--w/--h` (and
`--px/--py/--pw/--ph` on narrow screens), each shown in its `data-steps`; one GSAP timeline scrubbed by the scroll moves
the camera and brings each change in place, and the boards' players are driven by step (only the step's boards play). The
final cut (`figure[data-final-cut]`) is a composition player with controls (`js/final-cut.js`).

The hero creatives (`kova-*`, `tidefall-*`, `fernwise-*`) and the story's boards (`story-*`, `story.mjs`) are generated:
change `scripts/hero-gen/`, not their JSON.

```bash
node site/build.mjs                         # once: the width measurer uses the built site's fonts
node site/scripts/hero-gen/build.mjs        # → site/compositions/<id>/composition.json, meta.json, assets/*.svg
node site/build.mjs && node site/scripts/posters.mjs kova-9x16 …   # then the posters of what changed
```

`kova.mjs`, `tidefall.mjs`, `fernwise.mjs` and `story.mjs` lay out each creative per format with the builders of `lib.mjs`. Text
widths come from `widths.json` (measured in Chrome with the site's fonts by `measure.mjs`, which the build runs by itself
for a new string), so generating needs plain node only. A site test regenerates everything and fails on any difference
from the checked-in files.

After changing a composition, render its poster again (headless Chrome with a throwaway profile):

```bash
node site/build.mjs && node site/scripts/posters.mjs <id>   # no id: all; `og` also writes src/assets/og-image.png
```

## Checks in a real browser

```bash
node site/scripts/check.mjs --out /tmp/site-check
```

At 360, 768, 1440 and 2000 px, with and without reduced motion: no horizontal scroll, no errors or failed requests, every
composition live or on its poster, nothing told to play under reduced motion, every link with its target or file, the
final cut's slot and controls, and no poster a near-blank frame (luminance deviation under 12). With motion, scrolled to
each step, the story shows that step, every board it plays has a runtime, at most 9 runtimes are on the canvas, and none
plays once the story has scrolled away; under reduced motion every step is a static block with its messages and its
result loaded. Then the guide at the same widths: no
horizontal scroll, every screenshot loaded and with alt text, every in-page link with its target, the contents collapsed
below 1000 px. Set `CHROME` if Chrome is not in a standard place.

## Guide screenshots

The guide's screenshots (`src/assets/guide/*.webp`, 1440×900 or a panel of it, light theme with two dark ones) are taken
from the real app:

```bash
pnpm install && pnpm build                 # the web UI the demo serves (packages/web/dist)
node site/scripts/guide-shots.mjs          # all of them, about 15 minutes
node site/scripts/guide-shots.mjs --only editor,export   # only these images (every step still runs)
```

`guide-shots.mjs` starts the real core and web UI (`scripts/guide/demo-server.ts`, under the core's `tsx`) on a demo
folder whose path names no user (`/private/tmp/ms-guide-demo`, or `GUIDE_DEMO`), with an in-memory keychain and no
keys, and `scripts/guide/demo-agent.mjs` in place of Claude Code: it speaks Claude Code's stream-json and answers each
job with fixed work, in the brand of the project it runs in (the site's hero creatives KOVA Air, TIDEFALL and Fernwise as
compositions, a brand proposal, a filled brief, a video analysis written from its frames, a permission request). No model,
no paid service and no real configuration is used. It seeds three projects (KOVA, TIDEFALL, Fernwise) through the app's
API and its UI, renders an identity set with the app's own Chrome renderer, seeds a subtitle set with the app's own
writer (`scripts/guide/seed-subtitles.ts`: there is no transcription engine), and drives headless Chrome
(`scripts/chrome.mjs`: throwaway profile, mock keychain) with `scripts/guide/browser.mjs`. The steps are in
`scripts/guide/shots.mjs`, in order: each builds on the state the previous ones left. It needs macOS `say` for the spoken
clips (a tone elsewhere). It never deletes anything: the demo folder must be empty or absent at the start and is left in
place (remove it by hand, or set `GUIDE_DEMO` to a new folder); a failed step leaves `<demo>-failure.webp`. Look at every
image before committing: none may show a path, a name, a key or a token.

## Third parties

None at runtime. GSAP 3.13.0 (ScrollTrigger, SplitText) is vendored in `src/vendor/gsap/` under its no-charge standard
licence; the fonts (Bricolage Grotesque, Instrument Sans, JetBrains Mono) are self-hosted under the SIL Open Font
License, with their licence files.
