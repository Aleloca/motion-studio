# SVG inner editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the user can edit the colours, texts and element visibility inside any `svg` clip from the editor, and saving creates a new version, with no agent turn.

**Architecture:**
- A pure SVG-edit model in `packages/shared` works on an XML DOM (DOMParser/XMLSerializer); jsdom provides them in tests.
- The core gets a new staging kind `svgEdit`: it checks the SVG with `checkVectorSvg` and stores it under a content-addressed name, so the existing save path accepts it unchanged.
- The web editor adds an Inspector section "Contenuto SVG". It also adds a shadow-root overlay on the stage, for highlighting and selecting elements by click.

**Tech Stack:** TypeScript, React, fastify, zod, vitest (jsdom for web/shared DOM tests), the project's Chrome harness for layout.

**Spec:** `docs/superpowers/specs/2026-10-17-motion-studio-svg-inner-editor-design.md`

## Global Constraints

- **Edited SVGs must pass `checkVectorSvg`** (packages/core/src/identity/svg-check.ts). Size: 512 KB at most.
- **Untrusted text:**
  - edited SVG text goes into the page DOM only inside a shadow root, and only after the core check has passed;
  - never `innerHTML`/`dangerouslySetInnerHTML` with unchecked text.
- **No runtime change:** playback and the render keep drawing `svg` clips as `<img>`.
- **Identity formats:** the `svg` clip keeps the `checkVectorComposition` rules. Only its `src` file changes.
- **Discarded variants (phase 15) are read-only:** the section is disabled.
- **UI copy:** Italian and English through the existing i18n catalogs; `pnpm -s check:i18n` must pass.
- **Decisions:** in `docs/decisions-log.md`, marked "decisione: orchestratore (2026-10-17)".
- **Commit trailers, exactly:**
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_019pFVuDZefGiQPfptrkkr1A`

## Review Focus

1. **The same colour written in several ways** (`#FFF`, `#ffffff`, `white`, `rgb(255,255,255)`) is one entry, and replacing it changes every spelling. Test in Task 1.
2. **Colours inside `<style>` and `style=""`**: only the colour literal changes. Selectors, other properties and `url(#id)` stay byte-identical. Test in Task 1.
3. **Two clips share one SVG file:** editing one gives only that clip a new file. Test in Task 3.
4. **An edited SVG the core refuses** (for example, the user's text produces nothing invalid, but the base was already over the limit): the section shows the reason and the editor still works. Test in Task 3.
5. **Undo after a colour change restores the previous file and `src`, so saving creates no new file.** Test in Task 3.

---

### Task 1: SVG-edit model (shared)

**Files:**
- Create: `packages/shared/src/svg-edit/index.ts` (with `colors.ts`, `texts.ts` and `elements.ts` alongside it if that's clearer)
- Modify: `packages/shared/src/index.ts` (export)
- Test: `packages/shared/test/svg-edit.test.ts` (with the jsdom environment, as the other DOM tests in the repo; check how shared runs its tests)

**Interfaces (Produces):**
```ts
export type SvgDoc = XMLDocument;
export function parseSvg(text: string): { ok: true; doc: SvgDoc } | { ok: false; reason: 'parse' | 'not-svg' };
export function serializeSvg(doc: SvgDoc): string;

export interface SvgColor { hex: string; count: number; }          // hex = '#rrggbb' or '#rrggbbaa', lower case
export function listColors(doc: SvgDoc): SvgColor[];              // ordered by count desc, then first appearance
export function replaceColor(doc: SvgDoc, fromHex: string, toHex: string): number; // returns occurrences changed

export interface SvgText { path: string; text: string; }          // path = child-index path, e.g. "0/2/1"
export function listTexts(doc: SvgDoc): SvgText[];                // <text> elements; tspans are joined
export function setText(doc: SvgDoc, path: string, text: string): void;

export interface SvgElement { path: string; tag: string; label: string; depth: number; fill?: string; stroke?: string; hidden: boolean; }
export function listElements(doc: SvgDoc): SvgElement[];          // g, path, rect, circle, ellipse, line, polyline, polygon, text, use
export function setElementPaint(doc: SvgDoc, path: string, paint: { fill?: string; stroke?: string }): void;
export function setHidden(doc: SvgDoc, path: string, hidden: boolean): void; // display="none" on, attribute removed off
export function elementAt(doc: SvgDoc, path: string): Element | null;
export function pathOf(root: Element, el: Element): string | null;  // for click mapping (works on a cloned DOM with the same structure)
```

Colour sources:
- the attributes `fill`, `stroke`, `stop-color`, `flood-color`, `lighting-color`, `color`;
- the same properties in `style=""`;
- colour literals in `<style>` text.

Parse: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`, and the CSS named colours (keep a table of the 148 names). Skip `none`, `currentColor`, `inherit`, `transparent` and `url(...)`.

Replacement writes the new value as hex, in place of the original token only.

- [ ] Write failing tests:
  - colours from attributes, style, `<style>` and stop-color;
  - normalisation (`#FFF` = `white` = `rgb(255,255,255)`);
  - exclusions;
  - replacement count;
  - CSS untouched except the colour tokens (compare strings);
  - texts with tspans;
  - element list labels (id, then `<title>`, then tag plus index, e.g. "Tracciato 5"; the labels are returned as keys or English text and the web translates them, so pick one and document it);
  - setElementPaint;
  - setHidden on and off;
  - pathOf/elementAt round trip;
  - serialisation round trip of an untouched doc keeps it equivalent (re-parse and compare the canonical form).
- [ ] Run: `cd packages/shared && pnpm -s vitest run test/svg-edit.test.ts`. Expected: FAIL.
- [ ] Implement.
- [ ] Run again. Expected: PASS. Then `pnpm -r typecheck`.
- [ ] Commit: `feat(shared): SVG edit model (colours, texts, elements, visibility)`.

### Task 2: core staging `svgEdit`

**Files:**
- Modify: `packages/shared/src/render-views.ts` (the stage body union, ~:75)
- Modify: the staging route in `packages/core/src/server/creative-routes.ts` (~:995) and the editor staging implementation it calls (find it from the route)
- Modify, only if needed: `packages/core/src/creatives/direct-edit.ts` (`editorRefusals` ~:103-130 and the post-check ~:399-408 must accept an `svgEdit` staged file the same way as a staged library file)
- Test: `packages/core/test/direct-edit-svg.test.ts` (new), using the existing direct-edit test helpers

**Interfaces:**
- Body: `{ kind: 'svgEdit', clipId: string, baseSrc: string, content: string }`.
  - zod: content up to 512 KB (UTF-8 bytes); `baseSrc` must be an `assets/…svg` path of the base composition.
- Answer 200: `{ path: 'assets/<base-stem>-e<8 hex of sha256(content)>.svg', warnings: string[] }`.
- Answer 400: `{ error: 'svg-edit-refused', reasons: string[] }`, using the same reason codes as `checkVectorSvg`.
- The staged file goes where staged library files go, so `/edits` with `staged: [path]` and the clip `src` set to it is accepted.

Steps:
- [ ] Write failing tests:
  - stage ok returns the content-addressed path and the same content gives the same path;
  - refused: `<script>`, an external `href`, over 512 KB, and a non-svg `baseSrc`;
  - save with the new `src` creates a version whose `assets/` has the new file and still has the old one if another clip uses it;
  - an identity logo recoloured and saved gives a complete version (no identity problems);
  - a discarded variant (phase 15) refuses staging with the existing `variant-discarded` 409.
- [ ] Run, FAIL. Implement. Run, PASS. `pnpm -r typecheck`.
- [ ] Commit: `feat(core): editor staging of checked SVG edits`.

### Task 3: web Inspector section "Contenuto SVG"

**Files:**
- Create: `packages/web/src/screens/editor/inspector/SvgContentSection.tsx`
- Modify: `packages/web/src/screens/editor/Inspector.tsx` (show it for `svg` clips; disabled when read-only)
- Modify: `packages/web/src/screens/editor/draftStore.ts`:
  - the edited SVG text lives in the draft per clip, together with the staged path;
  - undo and redo restore both;
  - a new `EditOp` kind `svgContent { clipId, colors: number, texts: number, hidden: number }`, used for the summary only.
- Modify: `packages/shared/src/composition/edit/*` if `EditOp` lives there (it does: `apply.ts`); the `svgContent` op must not change the composition. The `src` change goes through the existing `clipMedia` op.
- Modify: `opsCompact.ts` and the change-summary strings
- Modify: `packages/web/src/api.ts` (`stageSvgEdit`)
- Modify: the i18n catalogs (it, en)
- Test: `packages/web/test/svg-content-section.test.tsx`

Behaviour:
- **Loading.** On selecting an `svg` clip, the section fetches its current text (the composition asset URL the editor already uses for the stage) and parses it.
- **Edits.** Colours use `ColorField` with `colorGroups(e, ctl)` (brand plus composition swatches). Texts use text inputs that commit on blur or Enter. Elements are a list with indentation, a visibility toggle and fill/stroke `ColorField`s for the selected element.
- **Staging.** Each committed change is debounced 300 ms, then serialised and staged through `stageSvgEdit`. On success it applies `clipMedia` (src → staged path) plus `svgContent`. On a refusal it shows the reasons inline and keeps the previous `src`.
- **Hidden identity clips.** `small` and `dark` get names in LayersPanel ("Versione piccola", "Negativo per sfondo scuro"), plus the hint from spec 4.3.

Steps:
- [ ] Write failing tests (mock the api), covering:
  - colours listed with counts;
  - a colour change stages and updates `src`;
  - undo restores the previous `src` and text;
  - a text change;
  - toggling an element's visibility;
  - a refusal message;
  - read-only disabled;
  - two clips sharing a file: only the selected one changes `src`.
- [ ] Run, FAIL. Implement. Run, PASS. Typecheck, i18n.
- [ ] Commit: `feat(web): edit colours, texts and visibility inside an SVG clip`.

### Task 4: stage overlay with click selection

**Files:**
- Create: `packages/web/src/screens/editor/SvgOverlay.tsx`
- Modify: `packages/web/src/screens/editor/Stage.tsx`
- Modify: `editorContext.ts` (the selected SVG element path)
- Test: `packages/web/test/svg-overlay.test.tsx`

Behaviour:
- **When it appears:** only when an `svg` clip is selected in the editor and its current text has passed the core check. That is the base file, which was checked when it was created, or the last staged text.
- **Drawing:** a host element exactly over the clip box, with `attachShadow({mode:'open'})`. The SVG text is parsed with DOMParser and the node is imported with `importNode` (no innerHTML); `preserveAspectRatio` follows the clip's `fit`.
- **Hover and click:** hover outlines the element under the pointer; click selects it, mapping through `pathOf`. The selection syncs with the section's element list both ways.
- **Off states:** the overlay is hidden during playback and is not used in the render.

Steps:
- [ ] Write failing tests:
  - the overlay renders inside a shadow root;
  - a `<style>` in the SVG does not change the styles of an element outside the overlay (compare computed styles, or check that the style lives in the shadow root);
  - clicking a shape selects its path;
  - the list selection highlights it;
  - no overlay for a clip whose text was refused.
- [ ] Run, FAIL. Implement. Run, PASS.
- [ ] Commit: `feat(web): select SVG elements on the stage`.

### Task 5: layout check, docs, live notes

- [ ] Add a case to an existing Chrome layout test of the editor (or a new one) with the Inspector section at 1280 and 1024 px. Long colour lists scroll inside the section, and nothing overflows. Run it with `MS_REQUIRE_CHROME=1` and a temp config.
- [ ] Add a short "Modificare un SVG" subsection to README.md and README.it.md, in the editor part.
- [ ] Record the decisions in `docs/decisions-log.md`.
- [ ] Commit: `docs: SVG inner editor in the README; decisions`.
