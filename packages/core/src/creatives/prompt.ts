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
export interface PromptInput {
  slug: string; creative: CreativeFile; presets: FormatPreset[]; version: number; kind: PromptKind;
  userText?: string; pins?: Pin[]; attachments?: string[]; problems?: string[];
  context?: CreativeContext;
  /** Language of the user's texts, captured when the job started: a running job keeps it even if the setting changes. */
  locale: Locale;
  /** True when the job really runs in the sandbox: only then the prompt describes sandbox limits. */
  sandboxed?: boolean;
}
export interface StudioBlock {
  outputDir: string; workDir: string; durationSec: number | null;
  formats: Array<{ id: string; width: number; height: number; kind: 'video' | 'image'; extensions: string[] }>;
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
  '- You run in a sandbox: you can write only in the project (except `.git`, `.claude`, `.studio`, `CLAUDE.md`, `CLAUDE.local.md` and `.mcp.json`), in $TMPDIR and in the tool temp dirs, nowhere else. Package caches are already configured; do not change them.',
  '- Do not mention these limitations to the user; they are known.',
];
export const SANDBOX_SECTION = [
  '## Sandbox environment',
  '- Writable: the project (your work goes in `creatives/<slug>/work/`, deliveries in `outputs/`), except the protected `.git`, `.claude`, `.studio`, `CLAUDE.md`, `CLAUDE.local.md` and `.mcp.json`; plus $TMPDIR and the tool temp dirs. Nowhere else.',
  '- Package caches (npm, pnpm, yarn, pip, XDG) are already configured and writable: install dependencies normally, without setting cache folders.',
  '- Network access is limited to the allowlisted domains (package registries and a few others); anything else fails.',
  '- Headless Chromium, Puppeteer and Playwright cannot run here and their browser downloads are disabled. Use a working engine from the start: ffmpeg, node-canvas or skia-canvas, Pillow or cairo. Browser-based rendering comes later and is managed by Motion Studio.',
  '- Do not mention these limitations to the user; they are known.',
];

function contextSections(c: CreativeContext): string[] {
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
  if (c.tools.length) out.push('', '## Motion Studio tools (MCP)', ...c.tools, 'Call report_progress at the start of each phase and validate_output before ending the turn.');
  return out;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function buildCreativePrompt(i: PromptInput): string {
  const { locale } = i;
  const { brief } = i.creative;
  const base = `creatives/${i.slug}`;
  const outputDir = `${base}/outputs/v${i.version}`;
  const known = brief.formats.map((id) => [id, findPreset(i.presets, id)] as const);
  const block: StudioBlock = {
    outputDir, workDir: `${base}/work`, durationSec: brief.durationSec,
    formats: known.flatMap(([, p]) => (p ? [{ id: p.id, width: p.width, height: p.height, kind: p.kind, extensions: p.extensions }] : [])),
  };
  // Agent-facing text: format names are always the English ones, whatever the user's language; the id identifies the preset.
  const formatLines = known.map(([id, p]) => p
    ? `- ${p.id}: ${formatLabel(p, 'en')} — ${p.width}×${p.height}, ${p.kind}${p.maxDurationSec ? `, max ${p.maxDurationSec}s` : ''}${p.safeZone ? `, safe zone px (top ${p.safeZone.top}, bottom ${p.safeZone.bottom}, left ${p.safeZone.left}, right ${p.safeZone.right})` : ''}${p.maxFileMB ? `, hard limit ${p.maxFileMB} MB` : ''}${p.kind === 'video' ? `, target ~${p.targetBitrateKbps ?? videoTargetBitrateKbps(p.width, p.height)} kbps, encode mp4/mov: ${encodeFlags(p.targetBitrateKbps ?? videoTargetBitrateKbps(p.width, p.height))}` : ''} — extensions: ${p.extensions.join(', ')}`
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
  } else {
    parts.push(
      `The outputs of version ${i.version} do not meet the contract. Fix these problems and deliver again in the same folder (${outputDir}/), updating manifest.json:`,
      ...(i.problems ?? []).map((p) => `- ${p}`),
    );
  }
  if (i.context && i.kind !== 'fix') parts.push(...contextSections(i.context));
  parts.push(
    '', '## Required formats', ...formatLines,
    '', ...ENCODING_SECTION,
    ...(i.sandboxed ? ['', ...SANDBOX_SECTION] : []),
    '', '## Where to work',
    `- Workspace: ${base}/work/ (sources, scripts, local dependencies)`,
    `- Delivery: ${outputDir}/ with one file per format (\`<id>.<extension>\`) and manifest.json, as per the contract in .studio/context.md`,
    '- Each format is a dedicated recomposition, not a crop.',
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
