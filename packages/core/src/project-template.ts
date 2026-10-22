import { compositionJsonSchema } from '@motion-studio/shared';
// Agent-facing: written in English. The agent answers in the language the prompt asks for.
export const CONTEXT_MD = `# Motion Studio context

This folder is a **Motion Studio** project: a local app that uses a coding agent to produce motion-graphics videos and images.

## Structure
- \`project.json\` — project metadata (do not edit it by hand).
- \`brand/\` — brand kit (\`brand-kit.json\`), guidelines (\`guidelines.md\`), analysed sources.
- \`assets/\` — project assets with metadata in \`assets.json\`.
- \`references/\` — reference images with notes in \`references.json\`.
- \`creatives/<slug>/\` — one folder per creative: \`work/\` is your workspace, \`outputs/vN/\` holds the delivered outputs.

## Rules
- Work only inside the folder of the creative you are given.
- Linked codebase folders are read-only.
- Install dependencies only locally, in the work folder, and only to prepare assets: never renderers or browsers.
- Do not use git in the project: Motion Studio manages the versions.

## Output contract (v2: compositions)
Motion Studio renders the final videos and images itself. You deliver **compositions**: never rendered media.

At the end of every turn deliver, in \`creatives/<slug>/outputs/vN/\` (the exact folder is given in the request), one folder per format listed under "Required formats" in the turn prompt (the \`formats\` of the motion-studio block):
\`\`\`
outputs/vN/compositions/<preset-id>/
  composition.json          the composition (schema motion-studio/composition@1)
  assets/...                every image, video, audio, font and SVG it uses (copies: never reference files outside the folder)
  layers/*.html             optional html layers
\`\`\`
- Do not write \`manifest.json\`, media files or anything else in \`outputs/vN/\`: Motion Studio writes the manifest and makes the renders. Files you put there are removed.
- Motion Studio itself puts the compositions of the creative's other formats (kept or linked) into the folder: do not create, edit or delete them, and never write into earlier \`outputs/v*\` folders.
- Each format is a dedicated **recomposition** (adapted layout, resized text, safe zones respected), never a crop of a master: width and height are the format's.
- **Never render final media and never install renderers** (Remotion, Playwright, Puppeteer, headless browsers, animation libraries). You may still prepare assets: ffmpeg to trim a video, extract or convert audio, resize an image; the Motion Studio tools for images, voice-overs, stock media and fonts; scripts that generate SVG.
- Motion Studio checks the compositions after the turn (\`validate_composition\` runs the same checks): when something is wrong you receive the list of problems to fix. Advisory warnings (e.g. a layer that looks like it uses the network) are reported but do not block.

### The composition (\`composition.json\`)
The full JSON Schema is \`.studio/composition.schema.json\`. In short:
- Root: \`{ "$schema": "motion-studio/composition@1", width, height, fps, duration, background, fonts[], scenes[], tracks[] }\`. \`fps\` is 24, 25, 30, 50 or 60. \`duration\` is in seconds; an image format is a **still**: \`duration: 0\`, no scenes, every clip starting at 0 (one frame at t = 0).
- **Scenes** \`{ id, name?, start, duration }\`: contiguous from 0 and covering the whole duration. They are the storyboard: one thumbnail per scene start.
- **Tracks** are listed bottom to top: \`{ id, kind: visual|video|text|audio, name?, muted?, hidden?, locked?, clips[] }\`. Audio clips go on audio tracks only.
- **Clips** \`{ id, type, start, duration, scene?, props, animations? }\`, with absolute times in seconds (inside their scene when \`scene\` is set). Ids: lowercase letters, digits and hyphens, unique.
  - \`text\`: props \`text, fontFamily, fontSize, fontWeight, color, align\`;
  - \`shape\`: props \`fill, radius\`;
  - \`image\`, \`svg\`: \`src\` and props \`fit (cover|contain|fill), kenBurns { from: { scale, x, y }, to: { … } }\`;
  - \`video\`: \`src, trimStart, volume\`;
  - \`html\`: \`src: "layers/<name>.html"\` and \`params\` \`{ key: { type: text|color|number|image, value, label? } }\` (the only values the editor exposes; the layer reads \`window.msParams\`);
  - \`audio\`: \`src, trimStart, volume, fadeIn, fadeOut, role (voice|music|sfx)\`, no props.
  - Every visual clip has a box in \`props\`: \`x, y, width, height, rotation, scale, opacity\` (composition pixels; rotation and scale around the centre).
- **Animations** (times relative to the clip start): a preset \`{ preset, duration, start?, ease? }\` (fadeIn, fadeOut, slideUp, slideDown, slideLeft, slideRight, popIn, scaleIn, wipe), a tween \`{ prop, from, to, duration, start?, ease? }\` or keyframes \`{ prop, keyframes: [{ t: 0..1, v, ease? }], duration, start? }\`. Props: opacity, x, y, scale, rotation, color (hex), blur. Several animations combine (e.g. slideUp + fadeIn).
- **Paths** are relative to the composition folder, under \`assets/\` or \`layers/\`: no \`..\`, no absolute paths, no URLs.
- **Fonts**: every font is a local file under \`assets/\` (.woff2, .woff, .ttf, .otf) declared in \`fonts[]\` as \`{ family, src, weight?, style? }\`; Motion Studio loads it with \`FontFace\` before every frame. Text clips name a declared \`fontFamily\`: generic families (sans-serif…) are not allowed. Use the brand fonts (\`fonts_fetch\` downloads Google Fonts into the project \`assets/fonts/\`: copy the file into the composition's \`assets/\`).
- **\`assets/lib/\`** inside a composition folder is reserved for the files Motion Studio's editor adds (library assets and brand fonts the user picked in a direct edit): keep them and their names when you build on that composition, and never put your own files there. A version made in the editor names it in the next request, and an exact copy of its compositions is in \`creatives/<slug>/work/editor/<format-id>/\`.

### html layers (\`layers/*.html\`)
For effects the clips cannot express (particles, charts, custom typography). A layer runs in an isolated frame, in time with the composition:
- it must be **pure in time**: CSS animations and transitions and WAAPI animations are seeked automatically; or expose \`window.msTimeline\` (a paused timeline) or \`window.msSeek = async (t) => { … }\` (t: seconds from the clip start) and draw the frame for t;
- signal loading with \`window.msReady = (async () => { … })()\` (images and fonts loaded);
- \`msReady\` and \`msSeek\` must never wait on time: no \`setTimeout\`, \`setInterval\`, \`Date\` or \`performance.now\` waits (time does not pass while Motion Studio renders a frame, so such a layer fails the render);
- read its parameters from \`window.msParams\`;
- never put \`will-change\` (nor \`translateZ\`/\`translate3d\` hacks) on elements that scale or rotate, such as a camera rig: Motion Studio rasterises every frame at the output size, and the hint only freezes the raster scale and blurs the text;
- **forbidden**: network (fetch, XMLHttpRequest, WebSocket, external URLs), Worker, AudioContext, \`<video>\`/\`<audio>\` playing on their own. Put files in \`assets/\` and reference them relatively (\`../assets/x.png\`).

### Common cases
- **Animated text**: a \`text\` clip with \`[{ "preset": "slideUp", "duration": 0.6 }, { "preset": "fadeIn", "duration": 0.4 }]\`, and a \`fadeOut\` with \`start\` near the clip's end.
- **Photo with Ken Burns**: an \`image\` clip with \`"fit": "cover"\` and \`"kenBurns": { "from": { "scale": 1 }, "to": { "scale": 1.2, "x": -40 } }\`.
- **Logo**: an \`svg\` (or \`image\`) clip with \`"fit": "contain"\` and \`popIn\`, usually on the top track for the whole duration or the last scene.
- **Transitions between scenes**: overlap the outgoing and incoming clips by a few tenths of a second inside the scenes and use fadeOut/fadeIn, slides or \`wipe\`.
- **Voice-over**: an \`audio\` clip with \`"role": "voice"\` (from \`tts\`); music on another audio track with \`"role": "music"\` is ducked under the voice.
- **Subtitles**: call \`start_subtitles\`; never one text clip per sentence.

Example (a 1080×1080 still):
\`\`\`json
{ "$schema": "motion-studio/composition@1", "width": 1080, "height": 1080, "fps": 30, "duration": 0, "background": "#0b1020",
  "fonts": [{ "family": "Inter", "src": "assets/Inter-700.woff2", "weight": 700 }], "scenes": [],
  "tracks": [
    { "id": "bg", "kind": "visual", "clips": [{ "id": "photo", "type": "image", "src": "assets/photo.jpg", "start": 0, "duration": 0, "props": { "x": 0, "y": 0, "width": 1080, "height": 1080, "fit": "cover" } }] },
    { "id": "text", "kind": "text", "clips": [{ "id": "title", "type": "text", "start": 0, "duration": 0, "props": { "text": "Book in 3 taps", "x": 80, "y": 820, "width": 920, "fontFamily": "Inter", "fontSize": 96, "fontWeight": 700, "color": "#ffffff", "align": "left" } }] }
  ] }
\`\`\`

## Brand and assets
- \`brand/brand-kit.json\`: colors, fonts, logos, tone, dos and don'ts (each entry with its source).
- \`brand/guidelines.md\`: narrative guidelines.
- \`assets/assets.json\`: list of the assets with description, tags and origin; the files are in \`assets/\`.
- \`references/references.json\`: reference images with notes; the files are in \`references/\`.
Brand rules take precedence over generic choices. Use the project's assets before generating new ones.

## Motion Studio tools
When the request lists the Motion Studio tools (MCP) you can use them: generate images (gpt-image-2), voice-overs, search and download stock photos/videos, download Google Fonts. The files end up in \`assets/\` and are already registered in \`assets/assets.json\`. Keep the attribution of stock assets (\`attribution\` field). Use \`report_progress\` to say where you are. In creatives, \`validate_composition\` (optionally \`{ "format": "<preset-id>" }\`) checks your compositions and \`preview_frames\` (\`{ "format": "<preset-id>", "times": [0, 1.5, 4] }\`, at most 6 times, a few calls per turn) shows you rendered frames of a composition as images: look at them to check your work before ending the turn.
`;

export const CLAUDE_MD = `@.studio/context.md
`;

/** The JSON Schema of `composition.json`, written to `.studio/composition.schema.json` before every creative turn. */
let schemaFile: string | null = null;
export function compositionSchemaFile(): string {
  schemaFile ??= `${JSON.stringify(compositionJsonSchema(), null, 2)}\n`;
  return schemaFile;
}

export const GITIGNORE = `outputs/
creatives/*/work/out/
node_modules/
.venv/
.cache/
creatives/*/work/tmp/
*.tmp
.DS_Store
.*.part
assets/.describe/
.studio/cache/
`;

/** The usage ledger stays versioned; a merge of two histories keeps both sides' lines (append-only JSONL). */
export const GITATTRIBUTES = `.studio/usage.jsonl merge=union
`;

export const PROJECT_DIRS = ['brand', 'assets', 'references', 'creatives'] as const;
