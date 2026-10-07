import type { CreativeFile, FormatPreset, Pin } from '@motion-studio/shared';
import type { BrandKit } from '@motion-studio/shared';
import { findPreset } from '../formats/format-catalog.ts';

export interface CreativeContext {
  kit: BrandKit; hasGuidelines: boolean; assets: number; references: number;
  codebases: Array<{ path: string; note?: string }>; missingCodebases: string[];
}

export type PromptKind = 'first' | 'iteration' | 'fix';
export interface PromptInput {
  slug: string; creative: CreativeFile; presets: FormatPreset[]; version: number; kind: PromptKind;
  userText?: string; pins?: Pin[]; attachments?: string[]; problems?: string[];
  context?: CreativeContext;
}
export interface StudioBlock {
  outputDir: string; workDir: string; durationSec: number | null;
  formats: Array<{ id: string; width: number; height: number; kind: 'video' | 'image'; extensions: string[] }>;
}

function contextSections(c: CreativeContext): string[] {
  const k = c.kit;
  const brand = [
    ...k.colors.map((x) => `- Colore ${x.name} (${x.role}): ${x.hex}`),
    ...k.fonts.map((x) => `- Font ${x.role}: ${x.family}${x.weights.length ? ` (pesi ${x.weights.join(', ')})` : ''}${x.file ? ` — file ${x.file}` : ''}`),
    ...k.logos.map((x) => `- Logo ${x.variant} (sfondo ${x.background}): ${x.file}`),
    ...(k.tone ? [`- Tono: ${k.tone.text}`] : []),
    ...k.dos.map((x) => `- Fare: ${x.text}`),
    ...k.donts.map((x) => `- Evitare: ${x.text}`),
    ...(k.photoStyle ? [`- Stile fotografico: ${k.photoStyle.text}`] : []),
    ...(c.hasGuidelines ? ['- Linee guida complete: brand/guidelines.md'] : []),
    ...(c.assets ? [`- Asset disponibili: ${c.assets} (elenco in assets/assets.json)`] : []),
    ...(c.references ? [`- Riferimenti: ${c.references} (references/references.json)`] : []),
  ];
  const out: string[] = [];
  if (brand.length) out.push('', '## Brand', ...brand);
  if (c.codebases.length || c.missingCodebases.length) {
    out.push('', '## Codebase di riferimento (sola lettura)',
      ...c.codebases.map((x) => `- ${x.path}${x.note ? `: ${x.note}` : ''}`),
      ...c.missingCodebases.map((p) => `- ${p}: non disponibile in questo turno`),
      'Non modificare mai file in queste cartelle: leggile soltanto.',
      'Le regole bloccano gli strumenti di modifica; gli interpreti potrebbero scrivere: Motion Studio rileva e segnala le modifiche nei repo git.');
  }
  return out;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function buildCreativePrompt(i: PromptInput): string {
  const { brief } = i.creative;
  const base = `creatives/${i.slug}`;
  const outputDir = `${base}/outputs/v${i.version}`;
  const known = brief.formats.map((id) => [id, findPreset(i.presets, id)] as const);
  const block: StudioBlock = {
    outputDir, workDir: `${base}/work`, durationSec: brief.durationSec,
    formats: known.flatMap(([, p]) => (p ? [{ id: p.id, width: p.width, height: p.height, kind: p.kind, extensions: p.extensions }] : [])),
  };
  const formatLines = known.map(([id, p]) => p
    ? `- ${p.id}: ${p.channel} · ${p.name} — ${p.width}×${p.height}, ${p.kind}${p.maxDurationSec ? `, max ${p.maxDurationSec}s` : ''}${p.safeZone ? `, safe zone px (alto ${p.safeZone.top}, basso ${p.safeZone.bottom}, sx ${p.safeZone.left}, dx ${p.safeZone.right})` : ''} — estensioni: ${p.extensions.join(', ')}`
    : `- ${id}: preset sconosciuto, ignoralo e segnalalo nella risposta`);

  const parts: string[] = [];
  if (i.kind === 'first') {
    const briefLines = [
      `- Obiettivo: ${brief.goal}`,
      brief.message && `- Messaggio chiave: ${brief.message}`,
      brief.durationSec && `- Durata dei video: circa ${brief.durationSec} secondi`,
      brief.assets.length > 0 && `- Asset da usare (percorsi nel progetto): ${brief.assets.join(', ')}`,
      brief.notes && `- Note: ${brief.notes}`,
    ].filter((l): l is string => typeof l === 'string' && l !== '');
    parts.push(`Realizza la creatività "${i.creative.title}" (versione ${i.version}).`, '', '## Brief', ...briefLines);
    if (i.userText) parts.push('', '## Indicazioni aggiuntive', i.userText);
  } else if (i.kind === 'iteration') {
    parts.push(`Nuova richiesta sulla creatività "${i.creative.title}": produci la versione ${i.version}.`, '', '## Richiesta', i.userText ?? '');
    if (i.pins?.length) {
      parts.push('', '## Commenti puntuali');
      for (const p of i.pins) parts.push(`- ${p.format}${p.timeSec !== null ? ` @ ${p.timeSec.toFixed(1)}s` : ''}, punto (${pct(p.x)}, ${pct(p.y)})${p.note ? `: ${p.note}` : ''}`);
    }
    if (i.attachments?.length) parts.push('', '## Fotogrammi allegati (leggili)', ...i.attachments.map((a) => `- ${a}`));
  } else {
    parts.push(
      `Gli output della versione ${i.version} non rispettano il contratto. Correggi questi problemi e riconsegna nella stessa cartella (${outputDir}/), aggiornando manifest.json:`,
      ...(i.problems ?? []).map((p) => `- ${p}`),
    );
  }
  if (i.context && i.kind !== 'fix') parts.push(...contextSections(i.context));
  parts.push(
    '', '## Formati richiesti', ...formatLines,
    '', '## Dove lavorare',
    `- Spazio di lavoro: ${base}/work/ (sorgenti, script, dipendenze locali)`,
    `- Consegna: ${outputDir}/ con un file per formato (\`<id>.<estensione>\`) e manifest.json, come da contratto in .studio/context.md`,
    '- Ogni formato è una ricomposizione dedicata, non un ritaglio.',
    '', 'Rispondi sempre in italiano.',
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
