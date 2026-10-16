# Motion Studio GitHub Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a static, animated, one-page English site in `site/` that explains Motion Studio, plays real Motion Studio compositions live through the product's own runtime, and deploys to GitHub Pages with `.github/workflows/pages.yml`.

**Architecture:**
- `site/src/` holds the hand-written page: HTML, CSS, JS and vendored GSAP.
- `site/compositions/<id>/` holds the hand-written `composition.json` files, their `assets/` and a `meta.json`.
- `node site/build.mjs` builds the site:
  - it validates every composition with the real `validateComposition` from `packages/shared`;
  - it inlines each one into a runtime page with the real `renderRuntimePage` from `packages/composition-runtime`;
  - it copies `runtime.js`, `preview.js` and `layer.js` from the runtime's `dist/`;
  - it writes everything to `site/_site/`, which is git-ignored. Pages uploads that folder.
- The page plays each composition in an iframe (`runtime/<id>.html?mode=preview&parentOrigin=<origin>`). It drives the iframe with the runtime's existing preview protocol: `play {loop:true}`, `pause`, `seek` and `setScale 'fit'`. **No change in `packages/`** is needed for this.

**Tech Stack:**
- plain HTML, CSS and ES modules;
- GSAP 3.13.0 with ScrollTrigger and SplitText, vendored;
- Node 24 (runs the repo's `.ts` sources natively) and `node:test`;
- headless Chrome over CDP for posters and checks;
- GitHub Actions: `actions/upload-pages-artifact@v3`, `actions/deploy-pages@v4`.

**Spec:** `docs/superpowers/specs/2026-10-16-github-page-design.md`

## Global Constraints

- **Language and content:**
  - English only.
  - Every claim comes from `README.md`, `docs/` or `docs/superpowers/specs/`. No invented features or numbers.
  - Variants (block 9) are described as available, from the phase 15 spec as of today.
- **Palette** (exact values):
  - stage `#0F0F0F`; surface `#171717`; hairline `#262626`; dashed grey `#6B6B6B` (decoration only);
  - text `#F5F1EC`; muted `#A3A3A3`;
  - orange `#FF5A1F`; deep orange `#C2410C` (only text ≥24px or decoration).
- **Category colours:**
  - Formats teal `#2DD4BF`; Brand `#FF5A1F`; Store/identity violet `#A78BFA`; Languages blue `#60A5FA`; Agent yellow `#FACC15`.
  - Blocks 7–9: block 7 (git) → Agent; block 8 (services) → Brand; block 9 (variants) → Formats.
- **Fonts:**
  - Bricolage Grotesque 700/800 (display); Instrument Sans 400/500 (body); JetBrains Mono 400 (eyebrows and code).
  - Self-hosted woff2 in `site/src/assets/fonts/`, with their OFL licence files. No request to Google at runtime.
- **Display type:**
  - hero size `clamp(64px, 15vw, 224px)`, letter-spacing `-0.04em`, line-height `0.9`;
  - the title bleeds past the viewport edge and is clipped with `overflow: clip` on its section.
- **GSAP style only:**
  - not its colours, the Mori font, its copy or its names;
  - no drop shadows (depth from gradients only);
  - exactly one primary orange button, **Get started**; every other button is an outlined pill;
  - section eyebrows are written `{ name }`.
- **Static site:** GitHub Pages serves it under `/motion-studio/`, so every URL in the page is relative.
- **Allowed third parties:** none at runtime. GSAP and the fonts are vendored. No analytics, trackers or embeds.
- **Accessibility and layout:**
  - `prefers-reduced-motion: reduce` gives a still, readable page: compositions are paused on their poster time;
  - no horizontal scroll from 360px to 1440px and wider;
  - WCAG AA contrast;
  - visible focus ring `2px solid #FF5A1F`, offset 3px;
  - all text is real HTML that reads without JS.
- **No product changes:** nothing under `packages/` or `apps/` changes. If the runtime cannot be embedded without a change, stop and ask the orchestrator (claude-motion-graphics-77).
- **Working rules:**
  - work in the worktree `../claude-motion-graphics-site`, branch `feat/github-page`;
  - never push, open PRs or touch repo settings;
  - no stash, reset, restore, clean, amend or rebase;
  - kill only PIDs you started;
  - Chrome only with a temp `--user-data-dir`, `--use-mock-keychain` and `--password-store=basic`;
  - no heavy test suites (no root `pnpm test`): run only `node --test site/test`.
- **Commit trailers, exactly:**
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01KxKL6zuy8dbnJieqN1eCNg`
- **No local paths:** no local home path and no user e-mail anywhere in the diff.

## Review Focus

- **The page served under a sub-path (`/motion-studio/`)** must load every asset, font, runtime page and composition. Pinned by the Task 1 test `no root-absolute URLs in _site` and by Task 7's local server at a `/motion-studio/` prefix.
- **A composition that fails to load** (runtime `error` message, or no `ready` within 8 s) must leave its poster image in place, never a blank or broken frame. Pinned by the Task 3 test `fallback to poster on error and timeout`.
- **Reduced motion on**: no autoplay, no scroll-scrubbed motion, the hero brief shown fully typed and every composition seeked to its `posterTime`. Pinned by the Task 3 test `reduced motion seeks to posterTime and never plays` and the Task 7 Chrome check.
- **A 360px wide phone**: the bleeding title, the two-column blocks and the showcase cards must not cause horizontal scroll. Pinned by the Task 7 check `document.documentElement.scrollWidth <= innerWidth` at 360, 768 and 1440.
- **Many compositions on one page**: only the iframes near the viewport are mounted, and off-screen ones pause. Pinned by the Task 3 test `mounts within 1 viewport margin, pauses when hidden`.

---

## File Structure

```
site/
  build.mjs                     # build: validate + render runtime pages + copy → site/_site/
  lib/compositions.mjs          # loadCompositions(), validateAll(), runtimePageFor()  (used by build and tests)
  scripts/posters.mjs           # dev-time: headless Chrome renders each composition's poster (webp), committed
  scripts/serve.mjs             # dev-time: static server of site/_site at /motion-studio/ (for checks)
  compositions/<id>/            # composition.json, assets/, meta.json, poster.webp
  src/
    index.html                  # the whole page (real text, no JS needed to read)
    css/tokens.css              # palette, fonts, sizes
    css/site.css                # layout, components, sections
    js/main.js                  # boot: players, choreography
    js/player.js                # CompositionPlayer: iframe lifecycle + preview protocol
    js/player-logic.js          # pure decision logic (unit-tested)
    js/motion.js                # GSAP choreography (hero sequence, reveals)
    vendor/gsap/                # gsap.min.js, ScrollTrigger.min.js, SplitText.min.js (3.13.0)
    assets/                     # logo (+ light variant), favicon set, og-image, fonts/
  test/*.test.mjs               # node:test
.github/workflows/pages.yml
.gitignore                      # + site/_site/
```

`meta.json` per composition: `{ "format": "<preset id from DEFAULT_FORMATS>", "posterTime": <seconds>, "label": "<accessible description>" }`.

---

### Task 1: Build pipeline and composition validation

**Files:**
- Create: `site/build.mjs`, `site/lib/compositions.mjs`, `site/test/build.test.mjs`, `site/compositions/smoke/` (one tiny 16:9 video composition: a text and a rectangle with one animation; it is replaced in Task 4), `site/src/index.html` (a stub)
- Modify: `.gitignore` (add `site/_site/`)

**Interfaces:**
- Produces:
  - `loadCompositions(dir: string): Promise<Array<{ id: string, dir: string, composition: object, meta: { format: string, posterTime: number, label: string } }>>`;
  - `validateAll(items): Promise<Array<{ id: string, problems: object[], warnings: object[] }>>`. It uses `validateComposition` from `packages/shared/src/composition/validate.ts`, with `DEFAULT_FORMATS` and `instancePreset` from `packages/shared/src/formats.ts`, and the real file sizes;
  - `runtimePageFor(item, indexHtml: string): string` = `renderRuntimePage(indexHtml, { base: '../compositions/<id>/', composition: normalizeComposition(item.composition) })`;
  - `build({ root = 'site', out = 'site/_site' } = {}): Promise<void>`. It fails with a readable list when any composition has problems. It copies `src/**` → `_site/`, `compositions/<id>/**` → `_site/compositions/<id>/` (without `meta.json`) and `runtime.js`, `preview.js`, `layer.js` from `packages/composition-runtime/dist/` → `_site/runtime/`. It writes `_site/runtime/<id>.html` and `_site/compositions.json` (`[{ id, width, height, duration, posterTime, label }]`). It skips `.DS_Store`.
- Import the `.ts` sources with relative paths (Node 24 strips types). If an import fails on Node 22, the workflow pins Node 24.

- [ ] **Step 1: Write the failing tests** in `site/test/build.test.mjs`:
  - `validates the smoke composition with no problems`;
  - `rejects a composition with an unknown format` (temp copy, `meta.format: 'nope'` → build throws, message contains the id);
  - `writes a runtime page per composition with base ../compositions/<id>/` (the page contains `id="ms-composition"` and `"base":"../compositions/smoke/"`);
  - `copies runtime.js, preview.js and layer.js`;
  - `no root-absolute URLs in _site`: no `src="/`, `href="/` or `url(/` in any `.html` or `.css` of `_site`;
  - `no .DS_Store and no meta.json in _site`.
- [ ] **Step 2: Run them to see them fail.** First run `pnpm install --frozen-lockfile` (if `node_modules` is missing) and `pnpm --filter @motion-studio/composition-runtime build`, then `node --test site/test`. Expected: FAIL (`build.mjs` missing).
- [ ] **Step 3: Implement** `site/lib/compositions.mjs` and `site/build.mjs` (CLI: `node site/build.mjs` → `build()`).
- [ ] **Step 4: Run** `node --test site/test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(site): build pipeline that validates and embeds real compositions`.

### Task 2: Identity, tokens and base styles

**Files:**
- Create: `site/src/assets/` (logo, light logo, favicon set, fonts with OFL), `site/src/css/tokens.css`, `site/src/css/site.css` (base, buttons, eyebrow, focus, hairlines), `site/test/identity.test.mjs`
- Modify: `site/src/index.html` (head: title, description, Open Graph and Twitter card meta pointing to `assets/og-image.png` (created in Task 4), favicon snippet, fonts preload)

**Asset copies:** copy them once, by hand, from the main checkout's `branding/` (never modify that folder):
- `…identity-logo-4-v2/logo.svg` and `logo.png` → `site/src/assets/logo.svg` and `logo.png`;
- a copy `logo-light.svg` in which `#171717` becomes `#F5F1EC`;
- the favicon set `…identity-favicon-v2/*` → `site/src/assets/favicon/`, with every `/…` path in `head-snippet.html` and `site.webmanifest` made relative (the manifest's `start_url` and `scope` become `./`);
- `…identity-app-icon-v2/AppIcon-1024.png` → `site/src/assets/app-icon.png`.

**Fonts:** download the woff2 files (latin subset) of the weights in Global Constraints from Google Fonts once, with the OFL text, into `site/src/assets/fonts/`.

- [ ] **Step 1: Write the failing tests:**
  - `tokens match the spec palette`: parse `tokens.css` `:root` custom properties and assert the exact hex values from Global Constraints;
  - `text pairs pass AA`: compute WCAG contrast for text/stage, muted/stage, orange/stage and text/surface (all ≥ 4.5), and deep orange/stage (≥ 3, large-text only);
  - `favicon paths are relative`: no `"/` or `href="/` in `head-snippet.html` or `site.webmanifest`;
  - `fonts are local`: `index.html` and the CSS contain no `fonts.googleapis.com` or `fonts.gstatic.com`;
  - `only one primary button`: `index.html` has exactly one `.btn--primary`.
- [ ] **Step 2: Run** `node --test site/test/identity.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Tokens:** `--c-stage --c-surface --c-line --c-dash --c-text --c-muted --c-orange --c-orange-deep --c-formats --c-brand --c-store --c-lang --c-agent`, `--f-display --f-body --f-mono` and `--hero-size`.
  - **Base styles:** `body` on `--c-stage`, the `.btn` pill (1px border, radius 999px) with `.btn--primary` in orange fill and stage-coloured text, `.eyebrow` (mono, braces from the markup), `:focus-visible` from Global Constraints, hairline `hr` and a `.section` rhythm.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(site): Motion Studio identity, tokens and base styles`.

### Task 3: Composition player

**Files:**
- Create: `site/src/js/player-logic.js`, `site/src/js/player.js`, `site/test/player.test.mjs`

**Interfaces:**
- Produces:
  - `decide(state: { visible: boolean, near: boolean, reducedMotion: boolean, ready: boolean, failed: boolean }): 'unmounted' | 'mount' | 'play' | 'pause' | 'still' | 'poster'` (pure, in `player-logic.js`):
    - `failed` → `poster`;
    - not `near` → `unmounted`;
    - `near` and not `ready` → `mount`;
    - `ready` and `reducedMotion` → `still`;
    - `ready` and `visible` → `play`;
    - `ready` and not `visible` → `pause`.
  - `class CompositionPlayer` (in `player.js`):
    - constructed with `(figure: HTMLElement)`. The figure has `data-composition="<id>"`, `data-poster-time` and an `<img class="poster">` child;
    - methods `update(state)`, `play()`, `pause()`, `seek(t)` and `destroy()`;
    - mounts an `<iframe src="runtime/<id>.html?mode=preview&parentOrigin=<encodeURIComponent(location.origin)>" title="<label>" loading="lazy">`;
    - accepts messages only when `ev.source === iframe.contentWindow`, `ev.origin === location.origin` and they are of `type` `ready`, `time` or `error`;
    - on `ready` it sends `{type:'setScale', scale:'fit'}`, `{type:'mute', muted:true}`, then `play {loop:true}` or, under reduced motion, `seek posterTime`; it also fades the poster out;
    - on `error`, or with no `ready` after 8000 ms, it removes the iframe and keeps the poster.
  - `mountPlayers(root: Document): CompositionPlayer[]`: one IntersectionObserver with `rootMargin: '100% 0px'` for `near` and one with `threshold: 0.25` for `visible`; it reads `matchMedia('(prefers-reduced-motion: reduce)')` live.

- [ ] **Step 1: Write the failing tests** (pure logic plus `CompositionPlayer` with a fake iframe window and a fake `postMessage`, no jsdom):
  - `decide` table: one assertion per row above;
  - `reduced motion seeks to posterTime and never plays`;
  - `fallback to poster on error and timeout` (use an injectable clock: `new CompositionPlayer(figure, { now, setTimeout })`);
  - `ignores messages from other sources or origins`;
  - `mounts within 1 viewport margin, pauses when hidden`: drive `update()` through `near` → `visible` → hidden and assert the posted commands `[setScale, mute, play]`, then `[pause]`.
- [ ] **Step 2: Run** `node --test site/test/player.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules. Keep the DOM in `player.js` behind a small seam so the tests can pass fakes.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(site): composition player over the runtime's preview protocol`.

### Task 4: The compositions

**Files:**
- Create: `site/compositions/<id>/` for each id below; delete `site/compositions/smoke/` (and update Task 1's tests to use `hero-16x9`)
- Create: `site/scripts/serve.mjs`, `site/scripts/posters.mjs`; one `poster.webp` per composition

**Rules:**
- Hand-written to `docs/output-contract.md`.
- Only text, shapes, SVG and JSON animations, plus the self-hosted fonts copied into each composition's `assets/fonts/`.
- No video or audio clips.
- Each composition is 4–8 s and loops cleanly: the last frame matches the first.
- Palette and fonts follow Global Constraints.
- These are **stylized motion pieces, not UI mock-ups** (user's decision).

| id | format (preset id) | idea |
|---|---|---|
| `hero-9x16` | `instagram-reel-9x16` | the launch teaser of the hero brief ("Launch teaser for a coffee app, bold and warm"), recomposed for the vertical frame |
| `hero-1x1` | `instagram-post-1x1` | the same teaser, recomposed for the square |
| `hero-16x9` | `youtube-16x9` | the same teaser, recomposed for the wide frame |
| `formats` | `youtube-16x9` | one tile reflows into 9:16, 1:1 and 16:9 frames with channel labels |
| `editor` | `youtube-16x9` | a title being moved and resized, timeline bars trimming, "Save as v3" |
| `brand` | `instagram-post-1x1` | swatches and a font specimen pulled out of a page or code outline, then assembled into a card |
| `identity` | `instagram-post-1x1` | the logo mark becoming a favicon, an app icon and store screenshots |
| `languages` | `youtube-16x9` | one headline cycling EN, IT, JA and DE while staying inside its box |
| `agent` | `youtube-16x9` | a queue of request chips: Stop, then Stop and redirect, then "Delivered" |
| `git` | `youtube-16x9` | v1 → v2 → v3 version dots on a line, an export file name being built from a pattern |
| `services` | `instagram-post-1x1` | image, voice and music tiles each gated by a "Confirm" chip |
| `variants` | `youtube-16x9` | the three logo frames multiplying into variants A–E, a ★ chosen per format |
| `og` | `og-image-1200x630` | still: logo, display title and the three frames; `posters.mjs` also writes it as `site/src/assets/og-image.png` (the Open Graph image) |

The showcase (Task 5) reuses `hero-*`, `brand`, `identity` and `languages`.

- **`serve.mjs`:** `serve({ dir = 'site/_site', prefix = '/motion-studio/', port = 0 }): Promise<{ url: string, close(): Promise<void> }>`. It uses `node:http`, the right MIME types (`.woff2`, `.webp`, `.svg`, `.json`) and Range support. The CLI prints the URL.
- **`posters.mjs`:**
  - it starts `serve()`;
  - it launches Chrome (`CHROME` env or the system Chrome) with `--headless=new`, a temp `--user-data-dir` (removed afterwards), `--use-mock-keychain`, `--password-store=basic` and `--remote-debugging-port=0`;
  - over CDP, using Node's global `WebSocket`, it opens `runtime/<id>.html` (render mode), awaits `__ms.ready()`, calls `__ms.seek(meta.posterTime)`, takes a screenshot at the composition's size and writes `site/compositions/<id>/poster.webp`;
  - it kills only the Chrome PID it spawned.

- [ ] **Step 1: Write the failing test** `site/test/compositions.test.mjs`:
  - `every listed composition exists and validates with no problems`, using the table above as the expected id → format map;
  - `every composition has a poster.webp of its own size`: read the webp header (VP8, VP8L or VP8X chunk) and compare with the composition's width and height;
  - `no video or audio clips`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Author the 13 compositions.** Preview each through `node site/build.mjs && node site/scripts/serve.mjs` in the temp-profile Chrome and look at it before moving on.
- [ ] **Step 4: Run** `node site/build.mjs && node site/scripts/posters.mjs && node --test site/test`. Expected: PASS, and the runtime reports no errors (the poster script fails on any `__ms.errors`).
- [ ] **Step 5: Commit** `feat(site): thirteen hand-written Motion Studio compositions with posters`.

### Task 5: Page content and layout

**Files:**
- Modify: `site/src/index.html`, `site/src/css/site.css`
- Create: `site/test/page.test.mjs`

**Structure:**
- `<header>`: logo-light and nav (Features, Showcase, Install, GitHub).
- `<main>`:
  - `#hero` with the `{ new creative }` eyebrow:
    - a brief field (static text in the HTML);
    - format chips: Instagram Reel 9:16, Instagram Post 1:1, YouTube 16:9;
    - the three hero figures;
    - an `h1` with the display title;
    - one line of subtitle;
    - **Get started** (`href="#install"`, `.btn--primary`) and **Star on GitHub** (`https://github.com/Aleloca/motion-studio`).
  - `#features`: nine `<article class="feature" data-category="…">` blocks in this order: formats, editor, brand, identity, languages, agent, git, services, variants. Each has:
    - eyebrow `{ category }`;
    - `h2`;
    - 2–3 sentences;
    - an outlined pill to the README section on `main` (`https://github.com/Aleloca/motion-studio#<anchor>`) or, for variants, to the phase 15 spec in the repo;
    - one figure. Blocks alternate sides.
  - `#showcase`: 6 cards (`hero-9x16`, `hero-1x1`, `hero-16x9`, `brand`, `identity`, `languages`), each with its format label in the category colour; the art overflows the card by 8–12px.
  - `#install`: from source (copyable `pnpm install` / `pnpm motion-studio` block), desktop app and npm marked "once published" as in the README, and the requirements list from the README.
- `<footer>`: repository, README, docs, MIT licence and the logo.

**Figures:** each composition figure is `<figure class="comp" data-composition="<id>" data-poster-time="…"><img class="poster" src="compositions/<id>/poster.webp" alt="<meta.label>" width height loading="lazy"></figure>`. The hero figures are not lazy.

**Copy:** the builder writes it from the README sections. For each block, record the README heading used as a comment in the HTML (`<!-- source: README "Languages" -->`).

- [ ] **Step 1: Write the failing tests** (parse `index.html` with regexes or a tiny tokenizer; no new dependency):
  - `one h1, and h2/h3 never skip a level`;
  - `nine feature blocks in order with the right data-category`;
  - `every README anchor link resolves`: slugify each heading of `README.md` the GitHub way and check every `#anchor` used;
  - `every figure has a poster with alt, width and height`;
  - `every data-composition id exists in site/compositions`;
  - `no forbidden words`: no `GSAP`, `Mori` or `greensock` in the visible text;
  - `install section mentions "once published"` for the desktop app and npm, and contains `pnpm motion-studio`;
  - `no external URLs other than github.com/Aleloca/motion-studio`.
- [ ] **Step 2: Run** `node --test site/test/page.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the markup and layout:
  - feature blocks in two columns at ≥ 900px, one column below;
  - showcase grid `repeat(auto-fit, minmax(min(100%, 320px), 1fr))`;
  - the hero title bleeding off the edge;
  - gradients for depth;
  - `overflow-x: clip` on sections.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(site): page content, features, showcase and install`.

### Task 6: Motion and choreography

**Files:**
- Create: `site/src/js/motion.js`, `site/src/js/main.js`, `site/src/vendor/gsap/` (the `gsap.min.js`, `ScrollTrigger.min.js` and `SplitText.min.js` files of `gsap@3.13.0` from npm, plus the licence header file)
- Modify: `site/src/index.html` (deferred classic scripts for the vendor files, then `type="module"` for `main.js`)

**Interfaces:**
- Consumes: `mountPlayers(document)` (Task 3).
- Produces: `startMotion({ reducedMotion: boolean, players: CompositionPlayer[] }): void`.
  - **Hero:**
    1. SplitText types the brief character by character (≈ 2 s);
    2. the chips pop in;
    3. an inline SVG of the logo's three frames draws dashed → outlined → filled with the play triangle;
    4. the three hero figures enter staggered and their players start;
    5. the h1 rises word by word.
  - **Features:** each block reveals on scroll with ScrollTrigger (`start: 'top 80%'`): the eyebrow, h2 and body rise, and the figure's frame draws.
  - **Showcase:** cards slide up in a stagger, and the art offsets on scroll (parallax 8–12px).
  - **Reduced motion:** no timelines are created, the final states are already set in CSS, and the hero brief is fully visible.
  - **Without JS:** the CSS default is the final state; `main.js` adds `html.js-motion` before it hides anything.

- [ ] **Step 1: Write the failing test** `site/test/motion.test.mjs`:
  - `final states are the CSS default`: `site.css` hides nothing (no `opacity: 0` / `visibility: hidden`) outside `.js-motion` selectors;
  - `vendor files are pinned 3.13.0`: each vendored file's header contains `3.13.0`;
  - `index.html loads no script from another origin`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `motion.js` and `main.js` (boot: detect reduced motion, add `js-motion` only when motion is allowed, `mountPlayers`, `startMotion`).
- [ ] **Step 4: Run** `node --test site/test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(site): hero and scroll choreography`.

### Task 7: Pages workflow and real-browser verification

**Files:**
- Create: `.github/workflows/pages.yml`, `site/scripts/check.mjs`, `site/README.md` (how to build, preview and regenerate posters)

**`pages.yml`:**
- **Triggers:** `push` to `main` with paths `site/**`, `packages/composition-runtime/**`, `packages/shared/**` and `.github/workflows/pages.yml`; plus `workflow_dispatch`.
- **Permissions:** `contents: read`, `pages: write`, `id-token: write`.
- **Concurrency:** group `pages`, `cancel-in-progress: false`.
- **Build job:**
  - checkout, `pnpm/action-setup@v4`, `actions/setup-node@v4` (Node 24, pnpm cache);
  - `pnpm install --frozen-lockfile`;
  - `pnpm --filter @motion-studio/composition-runtime build`;
  - `node site/build.mjs`, then `node --test site/test`;
  - `actions/upload-pages-artifact@v3` with `path: site/_site`.
- **Deploy job:** `needs: build`, `environment: github-pages`, `actions/deploy-pages@v4`.
- It does not enable Pages: the user does that in the repo settings.

**`check.mjs`:**
- it builds, then serves the site at `/motion-studio/` and launches the same temp-profile Chrome as `posters.mjs` (it shares a helper, `site/scripts/chrome.mjs`, extracted here);
- it checks widths 360, 768 and 1440, each with reduced motion off and then on (`Emulation.setEmulatedMedia` with `prefers-reduced-motion`);
- at each width it asserts:
  - `scrollWidth <= innerWidth`;
  - no console errors and no failed requests;
  - after scrolling through, every figure near the viewport has either a ready iframe or its poster;
  - with reduced motion, no player sent `play`. It reads this from `window.__siteDebug.commands`, which `player.js` records only when the page is served with `?debug`.
- it saves full-page screenshots to the scratch folder given as `--out`.

- [ ] **Step 1: Write** `pages.yml` and validate its YAML with `node -e` plus a tiny YAML check, or by reading it carefully. No repo setting changes and no push.
- [ ] **Step 2: Run** `node site/scripts/check.mjs --out <scratchpad>/site-check`. Expected: every assertion passes. Look at the 360px and 1440px screenshots and fix anything that looks off: clipping, overlaps, contrast.
- [ ] **Step 3: Run** `node --test site/test` and `git diff main --stat`, then grep the diff for the local home path and the user's e-mail: it must find nothing. Confirm nothing under `packages/` or `apps/` changed.
- [ ] **Step 4: Commit** `ci: GitHub Pages workflow for the site; site checks`.
- [ ] **Step 5: Report** the branch HEAD to claude-motion-graphics-77, with the note that block 9 presents phase 15 variants as available, so the merge should go with or after phase 15.
