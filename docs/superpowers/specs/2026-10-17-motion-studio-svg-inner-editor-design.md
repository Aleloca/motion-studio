# Motion Studio: editing inside SVGs (spec)

> **Sources:**
> - **user note 3, 2026-10-16:** on logo, favicon and app icon, "I see the image but I can't change its content without going through the chat". The user wants to work on it "as in Photoshop", especially on SVGs: changing colours, texts and so on without regenerating everything;
> - the user then handed this note over to the orchestrator, on 2026-10-17: "proceed autonomously on all the points and note down the choices". **Every choice in this document is the orchestrator's** and is marked "decisione: orchestratore (2026-10-17)" in the decisions log, to be reviewed with the user;
> - **current state:**
>   - the editor changes the composition (`composition.json`) and the clips, not the inside of the files;
>   - the runtime draws an `svg` clip as an `<img>`;
>   - an editor save may copy only files from the base or staged files (`direct-edit.ts`);
>   - `checkVectorSvg` (`identity/svg-check.ts`) is the strict check on SVGs.

## 1. Purpose

- The user changes the colours, the texts and the visibility of the elements of an SVG directly in the editor. No agent turn is needed, so there are no Claude costs and the change is immediate.
- Every save creates a new version, as today.
- **This applies to every `svg` clip**, not only to identity formats: logo, favicon, app icon, and the SVGs inside images and videos. It's the same panel, so the extra cost is minimal, and the user's question "does it apply to other formats too?" gets a yes.

## 2. What the user can do

When an `svg` clip is selected, the Inspector shows a new section, **"Contenuto SVG"**, with three parts:

1. **Colori**
   - The list of distinct colours in the SVG: fill, stroke, gradient stop-color, and colours in `style` and `<style>`. Each colour shows its swatch and how many times it appears.
   - Changing a colour (with the existing `ColorField`, including the brand and composition swatches) replaces **every occurrence** of that colour in the file.
   - This is the main operation: recolouring a logo with the brand colours in one click.
2. **Testi**
   - Each `<text>` (and `<tspan>`) with its content, editable as plain text.
   - Only the content changes, not the font, size or position.
   - The existing "text in the SVG" warning stays.
3. **Elementi**
   - The SVG's element tree: groups and shapes, with names taken from `id`, `<title>` or the type and position, e.g. "Gruppo 2 › Tracciato 5".
   - Selecting an element in the list:
     - highlights it on the stage;
     - shows its own fill and stroke, editable for that element only;
     - shows a **visibility** switch (hide or show the element).
   - **Clicking an element directly on the stage** selects it too. This is the "Photoshop" part.

Undo and redo work as for any other edit. The draft pill and "leave without saving" behave as they do today.

## 3. Not included (YAGNI, possible follow-up)

- Moving, scaling or rotating elements inside the SVG; drawing new shapes; changing fonts.
- Editing PNG or JPG images: they aren't vector.
- Gradients beyond their stop colours.
- Merging two colours that differ by a few points: each distinct literal value is its own entry.

## 4. How it works

### 4.1 In the browser (packages/web)

- **Reading the file.** The editor reads the clip's SVG text from the composition asset, through the existing preview route. It parses it with `DOMParser` (`image/svg+xml`) into an XML document that is **never inserted into the page**.
- **Model.** A pure module in `shared` (for example `packages/shared/src/svg-edit/`), so the core can test it and reuse it:
  - `listColors(doc)`: distinct colours, normalised to `#rrggbb`/`#rrggbbaa` for display. Each colour knows its occurrences (attribute, style property, `<style>` text). It ignores `none`, `currentColor`, `inherit`, `transparent` and `url(#…)`.
  - `replaceColor(doc, from, to)`: replaces every occurrence. In the CSS (style attributes and `<style>`), only the colour literals change, never the rest of the text.
  - `listTexts(doc)` and `setText(doc, path, text)`.
  - `listElements(doc)`, with stable paths (child indexes), `setElementPaint(doc, path, {fill?, stroke?})` and `setHidden(doc, path, hidden)` (the `display="none"` attribute, removed on show).
  - `serialize(doc)` with `XMLSerializer`.
- **Draft.** The draft stores the edited SVGs as staged files. The draft's `files` map gets the new text, and the clip's `src` points at the new content.
  - The new `EditOp` `svgContent { clipId, summary }` feeds only the change summary ("Logo: 2 colori cambiati, 1 testo").
  - Undo and redo save the previous text.
- **Stage.**
  - To highlight and select by click, the editor draws the edited SVG **inline inside a shadow root** (`attachShadow`), over the clip and only in the editor. The SVG's `<style>` then stays confined and doesn't affect the app's CSS.
  - Only text that has been checked goes in: the editor first calls the core check (4.2) and draws inline only an SVG that passed, otherwise it keeps the `<img>`.
  - Clicking an element inside the shadow root maps it back to its path.
  - Playback and the render keep using `<img>`, with no change to the runtime.

### 4.2 In the core (packages/core)

- **Staging.** A new kind of staging: `POST …/editor/stage` with `{ kind: 'svgEdit', clipId, baseSrc, content }`. The core:
  - checks that the size is at most 512 KB and that it's text;
  - runs `checkVectorSvg(content)`. It refuses it with the reasons in a short Italian message, using the same refusal mapping as `svgRefusals.ts`. Warnings (text) are allowed;
  - writes it to the editor's staging area under a new name `assets/<base-name>-e<short-hash>.svg`. Content-addressed: the same content gives the same name;
  - answers `{ path, warnings }`.
- **Save.**
  - `/edits` accepts the clip whose `src` changes to a staged `svgEdit` file, exactly as it accepts staged library files today.
  - The post-check (`direct-edit.ts` ~399-408) stays as it is: the new file is staged, so it is allowed.
  - **Identity formats:** `checkComposition` already re-checks the SVG in `finishCompositions`. The set of PNGs, favicons and icons is rebuilt at the next render, as today. After the save, FormatView offers the existing "Renderizza" as it does after any editor save.
- **Clip lock.** For identity formats, the `svg` clip keeps the `checkVectorComposition` rules: no transformations, `fit: contain`. Only the file changes.

### 4.3 Hidden identity clips

- The hidden `small` clips (and `dark`, if note 9 has introduced it) appear in the layer list with readable names: "Versione piccola" and "Negativo per sfondo scuro". They can be selected and edited like the main clip.
- Each clip is edited on its own. Changing the main logo's colours does not change the negative, which by design has different colours.
- A hint above the section reminds the user of this when the other clips exist: "Le altre versioni del logo non cambiano: modificale dall'elenco dei livelli".

## 5. Edge cases

- **Invalid or too-large SVG (over 512 KB):** the section shows "Questo SVG non si può modificare qui" with the reason. The rest of the editor works.
- **Changed text with a glyph missing from the font:** that's the browser's problem; nothing to do.
- **Two clips sharing the same SVG file:** the edit gives a new file only to the selected clip; the other keeps the original.
- **Same colour written in different ways** (`#fff` and `white`): normalised into one entry; the replacement covers both spellings.
- **Discarded variant (phase 15):** read-only, as today. The section is shown disabled.
- **The agent works on the creative while the editor is open:** the existing `editor-busy`/`editor-base-changed` rules apply.

## 6. Security

- An SVG edited in the browser is untrusted text. The core checks it with `checkVectorSvg` before staging, and again in `finishCompositions` for identity formats.
- Inline drawing in the editor happens only in a shadow root and only after the core check passes. No `innerHTML` with unchecked text.
- No new file path: the name is chosen by the core, inside the staging area.

## 7. Verification

- **Unit tests in shared:**
  - colours (attributes, style, `<style>`, stop-color, `#rgb`/named normalisation, exclusions);
  - replacement that leaves the rest of the CSS intact;
  - texts, elements, visibility, round-trip serialisation.
- **Core tests:**
  - staging `svgEdit` ok, refused (script, external href, too big), content-addressed name;
  - save with the new `src` creates a version;
  - identity format with a recoloured SVG: the version is complete and the render rebuilds the set.
- **Web tests:**
  - the section with colours, texts and elements;
  - colour change, then undo and redo;
  - selecting an element from the list highlights it;
  - an invalid SVG gives the message;
  - a discarded variant is disabled.
- **Chrome layout test** (harness) of the Inspector section at 1280.
- **Da verificare a mano dall'utente:** clicking elements on the stage in the real app, and a real logo recoloured with the brand colours, then rendered and exported.
