/**
 * User note 6: the duration a brief's text states ("60-second", "30 s", "1 minute", "1 min 30 s", "30 secondi", "un
 * minuto"…), English and Italian. The New creative form warns when it differs from the duration field, and the agent's
 * prompt says so. Null when the text states none, states different ones (e.g. "a 15 s cut and a 30 s cut"), or only
 * values outside the brief's range (1..600 s). A hint only: never a value the core enforces.
 */
const WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, un: 1, uno: 1, two: 2, due: 2, three: 3, tre: 3, four: 4, quattro: 4, five: 5, cinque: 5,
};
const NUM = String.raw`(\d{1,4}(?:[.,]\d)?|an?|one|uno?|two|due|three|tre|four|quattro|five|cinque)`;
const MIN = String.raw`(?:minutes?|mins?|minut[oi])`;
const SEC = String.raw`(?:seconds?|secs?|second[oi]|s)`;
// Letters on both sides of a match, Latin accents included (\b is ASCII only).
const L = String.raw`a-zà-öø-ÿ`;
const HALF = new RegExp(String.raw`(?<![${L}\d])(?:half\s+an?|mezzo)[\s-]*${MIN}(?![${L}])`, 'giu');
const MINUTES = new RegExp(String.raw`(?<![${L}\d])${NUM}[\s-]*${MIN}(?![${L}])(?:\s*(?:,|and|e)?\s*(\d{1,3})[\s-]*${SEC}(?![${L}]))?`, 'giu');
const SECONDS = new RegExp(String.raw`(?<![${L}\d.,])(\d{1,4})[\s-]*${SEC}(?![${L}])`, 'giu');

const numberOf = (raw: string): number => WORDS[raw.toLowerCase()] ?? Number(raw.replace(',', '.'));

export function statedDurationSec(text: string): number | null {
  if (!text) return null;
  let rest = text;
  const found: number[] = [];
  // Each pattern blanks what it read, so "half a minute" is not read again as "a minute", nor "1 min 30 s" as "30 s".
  const take = (re: RegExp, value: (m: RegExpExecArray) => number) => {
    rest = rest.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      found.push(value(m));
      return ' '.repeat(String(args[0]).length);
    });
  };
  take(HALF, () => 30);
  take(MINUTES, (m) => numberOf(m[1]!) * 60 + (m[2] ? Number(m[2]) : 0));
  take(SECONDS, (m) => Number(m[1]));
  const values = new Set(found.map((v) => Math.round(v)).filter((v) => v >= 1 && v <= 600));
  return values.size === 1 ? [...values][0]! : null;
}
