import type { CreativeFile, FormatPreset, Pin } from '@motion-studio/shared';
import { findPreset } from '../formats/format-catalog.ts';

export type PromptKind = 'first' | 'iteration' | 'fix';
export interface PromptInput {
  slug: string; creative: CreativeFile; presets: FormatPreset[]; version: number; kind: PromptKind;
  userText?: string; pins?: Pin[]; attachments?: string[]; problems?: string[];
}
export interface StudioBlock {
  outputDir: string; workDir: string; durationSec: number | null;
  formats: Array<{ id: string; width: number; height: number; kind: 'video' | 'image'; extensions: string[] }>;
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
  parts.push(
    '', '## Formati richiesti', ...formatLines,
    '', '## Dove lavorare',
    `- Spazio di lavoro: ${base}/work/ (sorgenti, script, dipendenze locali)`,
    `- Consegna: ${outputDir}/ con un file per formato (\`<id>.<estensione>\`) e manifest.json, come da contratto in .studio/context.md`,
    '- Ogni formato è una ricomposizione dedicata, non un ritaglio.',
    '', 'Rispondi sempre in italiano.',
    '', '```motion-studio', JSON.stringify(block), '```',
  );
  return parts.filter((l, idx, arr) => !(l === '' && arr[idx - 1] === '')).join('\n');
}

export function parseStudioBlock(prompt: string): StudioBlock | null {
  const m = prompt.match(/```motion-studio\n([\s\S]*?)\n```/);
  if (!m?.[1]) return null;
  try { return JSON.parse(m[1]) as StudioBlock; } catch { return null; }
}
