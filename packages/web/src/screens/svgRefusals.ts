// SVG refusals in the problems the user sees (Phase 14, decision 767): the core writes one problem per reason, in English
// after the file name ("logo.svg was refused by the SVG check: <reason>"). The user sees one translated summary per file
// ("logo.svg did not pass the SVG safety check (2 reasons)") and the reasons only behind "Details".
import { messages, type Locale } from '@motion-studio/shared';

export type ProblemItem = { kind: 'plain'; text: string } | { kind: 'svg'; file: string; reasons: string[] };

const LOCALES: Locale[] = ['en', 'it'];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FILE = '\u0001';
const REASON = '\u0002';

/** One matcher per language the core writes problems in: the catalog's own sentence with the file and reason cut out. */
const MATCHERS: RegExp[] = LOCALES.flatMap((l) => {
  const sample = messages(l).composition.svgRefused({ file: FILE, reason: REASON });
  const [pre, rest] = sample.split(FILE);
  const [mid, post] = (rest ?? '').split(REASON);
  if (pre === undefined || mid === undefined || post === undefined) return [];
  // A problem may carry the format's name before a colon (shortProblems strips the same prefix).
  return [new RegExp(`^(?:[^:]{1,200}:\\s*)?${esc(pre)}(.{1,300}?)${esc(mid)}([\\s\\S]+?)${esc(post)}$`)];
});

/** The problems as items: plain texts as they are, the SVG refusals of one file gathered (at the place of the first). */
export function groupProblems(problems: readonly string[]): ProblemItem[] {
  const out: ProblemItem[] = [];
  const byFile = new Map<string, Extract<ProblemItem, { kind: 'svg' }>>();
  for (const p of problems) {
    let hit: RegExpMatchArray | null = null;
    for (const re of MATCHERS) { hit = p.match(re); if (hit) break; }
    if (!hit) { out.push({ kind: 'plain', text: p }); continue; }
    const file = hit[1]!;
    const reason = hit[2]!;
    const item = byFile.get(file);
    if (item) { if (!item.reasons.includes(reason)) item.reasons.push(reason); continue; }
    const created = { kind: 'svg' as const, file, reasons: [reason] };
    byFile.set(file, created);
    out.push(created);
  }
  return out;
}
