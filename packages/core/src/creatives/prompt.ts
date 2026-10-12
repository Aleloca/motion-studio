import type { CreativeFile, FormatPreset, Pin } from '@motion-studio/shared';
import { formatLabel, videoTargetBitrateKbps, type BrandKit, type Locale } from '@motion-studio/shared';
import { replyInstruction } from '../i18n.ts';
import { findPreset } from '../formats/format-catalog.ts';

export interface CreativeContext {
  kit: BrandKit; hasGuidelines: boolean; assets: number; references: number;
  codebases: Array<{ path: string; note?: string }>; missingCodebases: string[];
  /** English lines describing the MCP tools available this turn (empty without MCP). */
  tools: string[];
}

export type PromptKind = 'first' | 'iteration' | 'fix';
export type AgentContract = 'compositions' | 'media';
export interface PromptInput {
  slug: string; creative: CreativeFile; presets: FormatPreset[]; version: number; kind: PromptKind;
  userText?: string; pins?: Pin[]; attachments?: string[]; problems?: string[];
  context?: CreativeContext;
  /** Language of the user's texts, captured when the job started: a running job keeps it even if the setting changes. */
  locale: Locale;
  /** True when the job really runs in the sandbox: only then the prompt describes sandbox limits. */
  sandboxed?: boolean;
  /**
   * What the agent delivers (default `compositions`, output contract v2, Task 5b): one composition folder per format, never
   * rendered media. `media` is the phase 9 contract (rendered files plus manifest v1), kept only for the legacy test suites
   * (`ServerDeps.agentContract`).
   */
  contract?: AgentContract;
  /**
   * The formats the agent delivers this turn (spec §2.3, §2.5): primaries only, in the brief's order. Default: every brief
   * format. When some brief formats are left out (carried over or followers), the prompt says Motion Studio handles them.
   */
  formats?: string[];
}
export interface StudioBlock {
  outputDir: string; workDir: string; durationSec: number | null;
  formats: Array<{ id: string; width: number; height: number; kind: 'video' | 'image'; extensions: string[]; compositionDir?: string; maxDurationSec?: number }>;
  /** Output contract v2: `2`, and the JSON Schema of `composition.json` (project path). Absent: the media contract. */
  contract?: 2;
  schema?: string;
}

/** Self-contained section: encoding guidance for the delivered files (prompts are English; only the reply is localized). */
const ENCODING_SECTION = [
  '## Encoding',
  '- Video: H.264 (libx264), `-pix_fmt yuv420p`, CRF 18-23, `-movflags +faststart`; AAC 128k audio only when the video has sound.',
  '- Each video format lists its target bitrate and the ffmpeg flags to use: stay at or below that bitrate (raise the CRF rather than lowering the resolution); a file far above it is flagged as too large. These flags are for mp4/mov (H.264); gif and webm have no target.',
  '- Images: optimized PNG, or JPEG at quality 85-90.',
];

/** Per-format ffmpeg flags: CRF 20 capped at 1.5x the target bitrate with a 2x buffer. */
const encodeFlags = (kbps: number) =>
  `-c:v libx264 -crf 20 -maxrate ${Math.round(kbps * 1.5)}k -bufsize ${Math.round(kbps * 2)}k -pix_fmt yuv420p -movflags +faststart (with audio add -c:a aac -b:a 128k)`;

/** Sandbox facts for the agent, shared by every prompt (the short form is for jobs without network or rendering). Relative paths only. */
export const SANDBOX_SECTION_SHORT = [
  '## Sandbox environment',
  '- You run in a sandbox: you can write only in the project (except `.git`, `.claude`, `.studio`, `CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json` and `.gitattributes`), in $TMPDIR and in the tool temp dirs, nowhere else. Package caches are already configured; do not change them.',
  '- Do not mention these limitations to the user; they are known.',
];
export const SANDBOX_SECTION = [
  '## Sandbox environment',
  '- Writable: the project (your work goes in `creatives/<slug>/work/`, deliveries in `outputs/`), except the protected `.git`, `.claude`, `.studio`, `CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json` and `.gitattributes`; plus $TMPDIR and the tool temp dirs. Nowhere else.',
  "- Put check frames and scratch files in `creatives/<slug>/work/tmp/`, not $TMPDIR — reading files outside the project needs the user's approval.",
  '- Package caches (npm, pnpm, yarn, pip, XDG) are already configured and writable: install dependencies normally, without setting cache folders.',
  '- Network access is limited to the allowlisted domains (package registries and a few others); anything else fails.',
  '- Headless Chromium, Puppeteer and Playwright cannot run here and their browser downloads are disabled. Use a working engine from the start: ffmpeg, node-canvas or skia-canvas, Pillow or cairo. Browser-based rendering comes later and is managed by Motion Studio.',
  '- Do not mention these limitations to the user; they are known.',
];

/** The sandbox facts of a composition turn: no rendering engine advice (Motion Studio renders). */
export const SANDBOX_SECTION_COMPOSITIONS = [
  '## Sandbox environment',
  '- Writable: the project (your workspace is `creatives/<slug>/work/`, deliveries in `outputs/`), except the protected `.git`, `.claude`, `.studio`, `CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json` and `.gitattributes`; plus $TMPDIR and the tool temp dirs. Nowhere else (`.studio/` is readable).',
  "- Put scratch files in `creatives/<slug>/work/tmp/`, not $TMPDIR — reading files outside the project needs the user's approval.",
  '- Network access is limited to the allowlisted domains; anything else fails.',
  '- Do not mention these limitations to the user; they are known.',
];

function contextSections(c: CreativeContext, contract: AgentContract = 'compositions'): string[] {
  const k = c.kit;
  const brand = [
    ...k.colors.map((x) => `- Color ${x.name} (${x.role}): ${x.hex}`),
    ...k.fonts.map((x) => `- Font ${x.role}: ${x.family}${x.weights.length ? ` (weights ${x.weights.join(', ')})` : ''}${x.file ? ` — file ${x.file}` : ''}`),
    ...k.logos.map((x) => `- Logo ${x.variant} (background ${x.background}): ${x.file}`),
    ...(k.tone ? [`- Tone: ${k.tone.text}`] : []),
    ...k.dos.map((x) => `- Do: ${x.text}`),
    ...k.donts.map((x) => `- Avoid: ${x.text}`),
    ...(k.photoStyle ? [`- Photo style: ${k.photoStyle.text}`] : []),
    ...(c.hasGuidelines ? ['- Full guidelines: brand/guidelines.md'] : []),
    ...(c.assets ? [`- Available assets: ${c.assets} (list in assets/assets.json)`] : []),
    ...(c.references ? [`- References: ${c.references} (references/references.json)`] : []),
  ];
  const out: string[] = [];
  if (brand.length) out.push('', '## Brand', ...brand);
  if (c.codebases.length || c.missingCodebases.length) {
    out.push('', '## Reference codebases (read-only)',
      ...c.codebases.map((x) => `- ${x.path}${x.note ? `: ${x.note}` : ''}`),
      ...c.missingCodebases.map((p) => `- ${p}: not available in this turn`),
      'Never modify files in these folders: only read them.',
      'The rules block the editing tools, but interpreters might still write: Motion Studio detects and reports changes in git repos.');
  }
  if (c.tools.length) {
    out.push('', '## Motion Studio tools (MCP)', ...c.tools, contract === 'compositions'
      ? 'Call report_progress at the start of each phase. Look at your work with preview_frames (a few PNG frames of a format\'s composition), and call validate_composition for every format before ending the turn.'
      : 'Call report_progress at the start of each phase.');
  }
  return out;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * The composition format in short (the full JSON Schema is `.studio/composition.schema.json`, about 27 KB, so it is not
 * inlined). The examples are minimal and valid; `.studio/context.md` has more.
 */
export const COMPOSITION_SECTION = [
  '## What to deliver: compositions (never rendered media)',
  '- For each format, write a composition folder `<outputs>/compositions/<format-id>/` with `composition.json`, plus `assets/` (images, video, audio, fonts, SVG) and `layers/` (html layers) when used. Motion Studio validates it, shows a live preview and renders the final video or image itself, on demand.',
  '- NEVER render final media (no mp4, png or jpg deliverables; no Remotion, Playwright, Puppeteer or ffmpeg renders of the creative) and NEVER install renderers, browsers or animation libraries. Do not write manifest.json: Motion Studio writes it.',
  '- You may prepare assets: ffmpeg to trim a video, extract or convert audio, resize an image; the Motion Studio tools for images, voice-overs, stock media and fonts; scripts that write SVG. Put every file the composition uses inside its own folder (`assets/…`): copy project assets there, never reference files outside it.',
  '- Schema `motion-studio/composition@1` (full JSON Schema: `.studio/composition.schema.json`; details and more examples: `.studio/context.md`):',
  '  - root `{ "$schema": "motion-studio/composition@1", width, height, fps (24|25|30|50|60), duration (seconds; 0 for an image format: a still), background "#rrggbb", fonts[], scenes[], tracks[] }`; width and height are the format\'s;',
  '  - `fonts[]`: `{ family, src: "assets/<file>.woff2|ttf|otf|woff", weight?, style? }`; every text clip names a declared `fontFamily` (no generic families);',
  '  - `scenes[]`: `{ id, name?, start, duration }`, contiguous from 0, covering the whole duration (a still has none);',
  '  - `tracks[]`: bottom to top, `{ id, kind: visual|video|text|audio, clips[] }`; a clip is `{ id, type, start, duration, scene?, props, animations? }` with absolute times in seconds, inside its scene;',
  '  - clip types: `text` (props text, fontFamily, fontSize, fontWeight, color, align), `shape` (fill, radius), `image`/`svg` (src, props fit, kenBurns {from, to}), `video` (src, trimStart, volume), `html` (src `layers/x.html`, params), `audio` (src, volume, fadeIn, fadeOut, role voice|music|sfx; on audio tracks only, no props);',
  '  - every visual clip has a box in props: x, y, width, height, rotation, scale, opacity (composition pixels);',
  '  - animations (times relative to the clip): `{ preset: fadeIn|fadeOut|slideUp|slideDown|slideLeft|slideRight|popIn|scaleIn|wipe, duration, start?, ease? }`, `{ prop, from, to, duration, start?, ease? }` or `{ prop, keyframes: [{ t: 0..1, v }], duration }`; props: opacity, x, y, scale, rotation, color, blur;',
  '  - paths are relative, under `assets/` or `layers/`, without `..`, schemes or absolute paths.',
  '- html layers (`layers/*.html`) are for effects the clips cannot express: pure in time (CSS/WAAPI animations, or `window.msSeek = (t) => …` / `window.msTimeline`), signal loading with `window.msReady` (a promise), read `window.msParams`; no network, no Worker, no AudioContext, no media playing on its own.',
  '- Minimal example (a 1080×1920, 6 s video):',
  '```json',
  '{ "$schema": "motion-studio/composition@1", "width": 1080, "height": 1920, "fps": 30, "duration": 6, "background": "#101828",',
  '  "fonts": [{ "family": "Inter", "src": "assets/Inter-700.woff2", "weight": 700 }],',
  '  "scenes": [{ "id": "intro", "start": 0, "duration": 3 }, { "id": "cta", "start": 3, "duration": 3 }],',
  '  "tracks": [',
  '    { "id": "bg", "kind": "visual", "clips": [{ "id": "photo", "type": "image", "src": "assets/photo.jpg", "start": 0, "duration": 6, "props": { "x": 0, "y": 0, "width": 1080, "height": 1920, "fit": "cover", "kenBurns": { "from": { "scale": 1 }, "to": { "scale": 1.15 } } } }] },',
  '    { "id": "text", "kind": "text", "clips": [',
  '      { "id": "title", "type": "text", "scene": "intro", "start": 0.3, "duration": 2.7, "props": { "text": "Book in 3 taps", "x": 90, "y": 760, "width": 900, "fontFamily": "Inter", "fontSize": 110, "color": "#ffffff", "align": "center" }, "animations": [{ "preset": "slideUp", "duration": 0.6 }, { "preset": "fadeIn", "duration": 0.4 }] },',
  '      { "id": "cta-text", "type": "text", "scene": "cta", "start": 3, "duration": 3, "props": { "text": "Download now", "x": 90, "y": 1500, "width": 900, "fontFamily": "Inter", "fontSize": 80, "color": "#fbbf24", "align": "center" }, "animations": [{ "preset": "popIn", "duration": 0.5 }] }] },',
  '    { "id": "music", "kind": "audio", "clips": [{ "id": "bed", "type": "audio", "src": "assets/music.mp3", "start": 0, "duration": 6, "volume": 0.4, "fadeOut": 1, "role": "music" }] }',
  '  ] }',
  '```',
  '- An image format is a still: `"duration": 0`, no scenes, every clip starting at 0.',
];

export function buildCreativePrompt(i: PromptInput): string {
  const { locale } = i;
  const contract = i.contract ?? 'compositions';
  const { brief } = i.creative;
  const base = `creatives/${i.slug}`;
  const outputDir = `${base}/outputs/v${i.version}`;
  const targets = i.formats ?? brief.formats;
  const known = targets.map((id) => [id, findPreset(i.presets, id)] as const);
  const othersKept = brief.formats.some((id) => !targets.includes(id));
  const block: StudioBlock = {
    outputDir, workDir: `${base}/work`, durationSec: brief.durationSec,
    formats: known.flatMap(([, p]) => (p ? [{ id: p.id, width: p.width, height: p.height, kind: p.kind, extensions: p.extensions }] : [])),
  };
  // Agent-facing text: format names are always the English ones, whatever the user's language; the id identifies the preset.
  const formatLines = known.map(([id, p]) => p
    ? `- ${p.id}: ${formatLabel(p, 'en')} — ${p.width}×${p.height}, ${p.kind}${p.maxDurationSec ? `, max ${p.maxDurationSec}s` : ''}${p.safeZone ? `, safe zone px (top ${p.safeZone.top}, bottom ${p.safeZone.bottom}, left ${p.safeZone.left}, right ${p.safeZone.right})` : ''}${p.maxFileMB ? `, hard limit ${p.maxFileMB} MB` : ''}${p.kind === 'video' && p.extensions.some((e) => e === 'mp4' || e === 'mov') ? `, target ~${p.targetBitrateKbps ?? videoTargetBitrateKbps(p.width, p.height)} kbps, encode mp4/mov: ${encodeFlags(p.targetBitrateKbps ?? videoTargetBitrateKbps(p.width, p.height))}` : ''} — extensions: ${p.extensions.join(', ')}`
    : `- ${id}: unknown preset, ignore it and mention it in your reply`);

  const parts: string[] = [];
  if (i.kind === 'first') {
    const briefLines = [
      `- Goal: ${brief.goal}`,
      brief.message && `- Key message: ${brief.message}`,
      brief.durationSec && `- Video duration: about ${brief.durationSec} seconds`,
      brief.assets.length > 0 && `- Assets to use (project paths): ${brief.assets.join(', ')}`,
      brief.notes && `- Notes: ${brief.notes}`,
    ].filter((l): l is string => typeof l === 'string' && l !== '');
    parts.push(`Create the creative "${i.creative.title}" (version ${i.version}).`, '', '## Brief', ...briefLines);
    if (i.userText) parts.push('', '## Additional notes', i.userText);
  } else if (i.kind === 'iteration') {
    parts.push(`New request for the creative "${i.creative.title}": produce version ${i.version}.`, '', '## Request', i.userText ?? '');
    if (i.pins?.length) {
      parts.push('', '## Pinned comments');
      for (const p of i.pins) parts.push(`- ${p.format}${p.timeSec !== null ? ` @ ${p.timeSec.toFixed(1)}s` : ''}, point (${pct(p.x)}, ${pct(p.y)})${p.note ? `: ${p.note}` : ''}`);
    }
    if (i.attachments?.length) parts.push('', '## Attached frames (read them)', ...i.attachments.map((a) => `- ${a}`));
  } else if (contract === 'compositions') {
    parts.push(
      `The compositions of version ${i.version} do not meet the contract. Fix these problems in the same folders (${outputDir}/compositions/<format-id>/), then call validate_composition again:`,
      ...(i.problems ?? []).map((p) => `- ${p}`),
    );
  } else {
    parts.push(
      `The outputs of version ${i.version} do not meet the contract. Fix these problems and deliver again in the same folder (${outputDir}/), updating manifest.json:`,
      ...(i.problems ?? []).map((p) => `- ${p}`),
    );
  }
  if (i.context && i.kind !== 'fix') parts.push(...contextSections(i.context, contract));
  if (contract === 'compositions') {
    // Agent-facing: the format's own facts only (Motion Studio renders, so no extensions, bitrates or encoding flags).
    const compositionLines = known.map(([id, p]) => p
      ? `- ${p.id}: ${formatLabel(p, 'en')} — ${p.width}×${p.height}, ${p.kind === 'image' ? 'image (a still: duration 0)' : 'video'}${p.maxDurationSec ? `, max ${p.maxDurationSec}s` : ''}${p.safeZone ? `, safe zone px (top ${p.safeZone.top}, bottom ${p.safeZone.bottom}, left ${p.safeZone.left}, right ${p.safeZone.right})` : ''} — folder ${outputDir}/compositions/${p.id}/`
      : `- ${id}: unknown preset, ignore it and mention it in your reply`);
    const v2Block: StudioBlock = {
      ...block, contract: 2, schema: '.studio/composition.schema.json',
      formats: block.formats.map((f) => {
        const p = findPreset(i.presets, f.id)!;
        return { ...f, compositionDir: `${outputDir}/compositions/${f.id}`, ...(p.maxDurationSec ? { maxDurationSec: p.maxDurationSec } : {}) };
      }),
    };
    parts.push(
      '', '## Required formats', ...compositionLines,
      '', ...COMPOSITION_SECTION,
      ...(i.sandboxed ? ['', ...SANDBOX_SECTION_COMPOSITIONS] : []),
      '', '## Where to work',
      `- Workspace: ${base}/work/ (sources, scripts, drafts)`,
      `- Delivery: ${outputDir}/compositions/<format-id>/ for each format above, as per the contract in .studio/context.md`,
      `- Never write into the other \`${base}/outputs/v*\` folders: they hold earlier versions.`,
      '- Each format is a dedicated recomposition (layout, text sizes and safe zones adapted), not a crop.',
      ...(othersKept ? ['- Deliver only the formats listed above. Motion Studio keeps the other formats of this creative unchanged and puts their compositions in the delivery folder itself: do not create, edit or delete compositions for them.'] : []),
      '', replyInstruction(locale),
      '', '```motion-studio', JSON.stringify(v2Block), '```',
    );
    return parts.filter((l, idx, arr) => !(l === '' && arr[idx - 1] === '')).join('\n');
  }
  parts.push(
    '', '## Required formats', ...formatLines,
    '', ...ENCODING_SECTION,
    ...(i.sandboxed ? ['', ...SANDBOX_SECTION] : []),
    '', '## Where to work',
    `- Workspace: ${base}/work/ (sources, scripts, local dependencies)`,
    `- Delivery: ${outputDir}/ with one file per format (\`<id>.<extension>\`) and manifest.json, as per the contract in .studio/context.md`,
    `- Never write into the other \`${base}/outputs/v*\` folders: they hold earlier versions.`,
    '- Each format is a dedicated recomposition, not a crop.',
    // The kept formats are not named: the agent has nothing to deliver for them.
    ...(othersKept ? ['- Deliver only the formats listed above. Motion Studio keeps the other formats of this creative unchanged and puts their files in the delivery folder itself: do not create, edit or delete files for them, and list only your formats in manifest.json.'] : []),
    '', replyInstruction(locale),
    '', '```motion-studio', JSON.stringify(block), '```',
  );
  // Collapses only the separators between sections: user text is a single element and keeps its own blank lines.
  return parts.filter((l, idx, arr) => !(l === '' && arr[idx - 1] === '')).join('\n');
}

/** The LAST motion-studio fence: Motion Studio appends its block after any user text, which may contain a fake one. */
export function parseStudioBlock(prompt: string): StudioBlock | null {
  const m = [...prompt.matchAll(/```motion-studio\n([\s\S]*?)\n```/g)].at(-1);
  if (!m?.[1]) return null;
  try { return JSON.parse(m[1]) as StudioBlock; } catch { return null; }
}
