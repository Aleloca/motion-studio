# Motion Studio site

The project's GitHub Pages site: one static page in `src/`, with live Motion Studio compositions from `compositions/`,
played by the product's own runtime (`packages/composition-runtime`) and checked by its own validator
(`packages/shared`). Deployed by `.github/workflows/pages.yml`.

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
- `poster.webp`: the frame at `posterTime`, shown before the runtime is ready, under reduced motion and without JS.

The site's fonts (`src/assets/fonts/`) are copied into every composition's `assets/fonts/` at build time.

The hero cycles through example creatives: each `.hero__set` in `index.html` holds one creative's three formats, with its
brief (`data-brief`) and format chips (`data-chips`). The first set is the one shown without JS and under reduced motion;
the others are hidden until the cycle reaches them, and each creative also has a card in the showcase.

After changing a composition, render its poster again (headless Chrome with a throwaway profile):

```bash
node site/build.mjs && node site/scripts/posters.mjs <id>   # no id: all; `og` also writes src/assets/og-image.png
```

## Checks in a real browser

```bash
node site/scripts/check.mjs --out /tmp/site-check
```

At 360, 768 and 1440 px, with and without reduced motion: no horizontal scroll, no errors or failed requests, every
composition live or on its poster, nothing told to play under reduced motion. Set `CHROME` if Chrome is not in a
standard place.

## Third parties

None at runtime. GSAP 3.13.0 (ScrollTrigger, SplitText) is vendored in `src/vendor/gsap/` under its no-charge standard
licence; the fonts (Bricolage Grotesque, Instrument Sans, JetBrains Mono) are self-hosted under the SIL Open Font
License, with their licence files.
