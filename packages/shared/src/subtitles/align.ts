// Aligns the heard words to a known script (decision 1639): the script's words win, the heard times are kept.
import { normalizeToken } from './cues.ts';
import type { TimedWord } from './cues.ts';

const MATCH = 2;
const MISMATCH = -1;
const GAP = -1;

export function alignToScript(words: TimedWord[], script: string, span: { start: number; end: number }): TimedWord[] {
  const target = script.split(/\s+/).filter((w) => w !== '');
  if (target.length === 0) return [];
  const heard = words.filter((w) => w.start >= span.start && w.start < span.end);
  const a = heard.map((w) => normalizeToken(w.text));
  const b = target.map(normalizeToken);
  const n = a.length;
  const m = b.length;
  const score = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) score[i]![0] = i * GAP;
  for (let j = 1; j <= m; j++) score[0]![j] = j * GAP;
  const pair = (i: number, j: number): number => (a[i] !== '' && a[i] === b[j] ? MATCH : MISMATCH);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      score[i]![j] = Math.max(score[i - 1]![j - 1]! + pair(i - 1, j - 1), score[i - 1]![j]! + GAP, score[i]![j - 1]! + GAP);
    }
  }
  // Trace back: heardOf[j] is the heard word paired with script word j.
  const heardOf: (TimedWord | null)[] = new Array<TimedWord | null>(m).fill(null);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (score[i]![j] === score[i - 1]![j - 1]! + pair(i - 1, j - 1)) { heardOf[j - 1] = heard[i - 1]!; i--; j--; }
    else if (score[i]![j] === score[i - 1]![j]! + GAP) i--;
    else j--;
  }
  const out: TimedWord[] = target.map((text, k) => ({ text, start: heardOf[k]?.start ?? -1, end: heardOf[k]?.end ?? -1 }));
  // Unmatched words share the room between their matched neighbours (or the whole span).
  for (let k = 0; k < m; k++) {
    if (heardOf[k]) continue;
    let e = k;
    while (e < m && !heardOf[e]) e++;
    const lo = k > 0 ? out[k - 1]!.end : span.start;
    const hi = Math.max(e < m ? out[e]!.start : span.end, lo);
    const count = e - k;
    for (let t = 0; t < count; t++) {
      out[k + t]!.start = lo + Math.round(((hi - lo) * t) / count);
      out[k + t]!.end = lo + Math.round(((hi - lo) * (t + 1)) / count);
    }
    k = e - 1;
  }
  return out;
}
