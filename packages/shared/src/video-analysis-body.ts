/**
 * Reads back the body of a video analysis file as the core writes it (`renderBody` in core `analysis/sidecar.ts`), for the
 * library's Analisi section. Sections are found by their headings; a body without `## Timeline` (an edited file reshaped by
 * the user) is not parsed: `parseAnalysisBody` returns null and the screen shows the text as it is.
 */
export interface AnalysisBodyScene {
  from: number;
  to: number;
  onScreen: string;
  onScreenText: string[];
  frame: string | null;
  speech: Array<{ at: number; text: string }>;
}
export interface AnalysisBody {
  summary: string;
  timeline: AnalysisBodyScene[];
  usableMoments: Array<{ from: number; to: number; why: string }>;
  transcript: Array<{ from: number; to: number; text: string }>;
  tags: string[];
}

/** `mm:ss`, `hh:mm:ss`, each with optional tenths (`01:15.4`) → seconds; null when it is not a time. */
export function parseClock(text: string): number | null {
  const m = /^(?:(\d{1,3}):)?(\d{1,3}):(\d{2})(?:\.(\d))?$/.exec(text.trim());
  if (!m) return null;
  const sec = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(m[4]) / 10 : 0);
  return Number.isFinite(sec) ? sec : null;
}

const SPAN = /^\[([\d:.]+)[–-]([\d:.]+)\]\s*(.*)$/;
const unquote = (s: string) => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);
/** The `"a", "b"` list of an on-screen text line. */
function quotedList(s: string): string[] {
  const out = [...s.matchAll(/"([^"]*)"/g)].map((m) => m[1]!.trim()).filter(Boolean);
  return out.length ? out : s.trim() ? [s.trim()] : [];
}

function sections(body: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { current = []; out.set(h[1]!.toLowerCase(), current); continue; }
    current?.push(line);
  }
  return out;
}

function spans(lines: string[]): Array<{ from: number; to: number; text: string }> {
  const out: Array<{ from: number; to: number; text: string }> = [];
  for (const line of lines) {
    const m = /^-\s+(.*)$/.exec(line);
    const s = m ? SPAN.exec(m[1]!) : null;
    if (!s) continue;
    const from = parseClock(s[1]!), to = parseClock(s[2]!);
    if (from !== null && to !== null) out.push({ from, to, text: s[3]!.trim() });
  }
  return out;
}

export function parseAnalysisBody(body: string): AnalysisBody | null {
  const sec = sections(body);
  const timelineLines = sec.get('timeline');
  if (!timelineLines) return null;
  const timeline: AnalysisBodyScene[] = [];
  for (const line of timelineLines) {
    const top = /^-\s+(.*)$/.exec(line);
    if (top) {
      const s = SPAN.exec(top[1]!);
      const from = s ? parseClock(s[1]!) : null, to = s ? parseClock(s[2]!) : null;
      if (s && from !== null && to !== null) timeline.push({ from, to, onScreen: s[3]!.trim(), onScreenText: [], frame: null, speech: [] });
      continue;
    }
    const sub = /^\s+-\s+(.*)$/.exec(line);
    const scene = timeline.at(-1);
    if (!sub || !scene) continue;
    const item = sub[1]!;
    const text = /^On-screen text:\s*(.*)$/i.exec(item);
    if (text) { scene.onScreenText.push(...quotedList(text[1]!)); continue; }
    const frame = /^Frame:\s*(.*)$/i.exec(item);
    if (frame) { scene.frame = frame[1]!.trim() || null; continue; }
    const speech = /^\[([\d:.]+)\]\s*(.*)$/.exec(item);
    const at = speech ? parseClock(speech[1]!) : null;
    if (speech && at !== null) scene.speech.push({ at, text: unquote(speech[2]!.trim()) });
  }
  const summary = (sec.get('summary') ?? []).map((l) => l.trim()).filter((l) => l && l !== '-').join('\n');
  const tags = (sec.get('tags') ?? []).join(',').split(',').map((x) => x.trim()).filter((x) => x && x !== '-');
  return {
    summary,
    timeline,
    usableMoments: spans(sec.get('usable moments') ?? []).map((m) => ({ from: m.from, to: m.to, why: m.text })),
    transcript: spans(sec.get('transcript') ?? []),
    tags,
  };
}
