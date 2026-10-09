/** Agent-supplied text shown in the UI: no control, zero-width or bidi characters (they could disguise the text), single spaces. */
export const cleanProgress = (text: string) => text
  .replace(/[\t\n\v\f\r]/g, ' ')
  .replace(/[\p{Cc}\u200B-\u200F\u202A-\u202E\u2066-\u2069\u061C\uFEFF]/gu, '')
  .replace(/\s+/g, ' ')
  .trim();

export const MAX_AGENT_REASON = 300;

/** Single code point tests (anchored, no quantifier): constant time each. */
const FORMAT_OR_CONTROL = /^[\p{Cc}\p{Cf}]$/u;
const WHITESPACE = /^\s$/u;
let work = 0;
/** Steps taken by cleanAgentReason, for linear-time tests (no wall clock). */
export const displayTextWork = { reset: () => { work = 0; }, get: () => work };

/**
 * The agent's stated reason for a tool call (e.g. Bash `description`), shown on approval cards only as a quote.
 * Every format character (bidi, zero-width, tags) and control character goes, whitespace collapses, at most
 * MAX_AGENT_REASON code points (an ellipsis marks a cut). null when absent, not a string or blank.
 */
export function cleanAgentReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // One pass over the code points (linear by construction; displayTextWork counts the steps).
  let out = '';
  let space = false;
  for (const ch of value) {
    work++;
    const code = ch.codePointAt(0)!;
    if (ch.length === 1 && code >= 0xD800 && code <= 0xDFFF) continue; // lone surrogate
    if (code >= 0x09 && code <= 0x0D) { space = true; continue; } // \t \n \v \f \r
    if (FORMAT_OR_CONTROL.test(ch)) continue;
    if (WHITESPACE.test(ch)) { space = true; continue; }
    if (space && out !== '') out += ' ';
    space = false;
    out += ch;
  }
  if (!out) return null;
  const chars = Array.from(out);
  if (chars.length <= MAX_AGENT_REASON) return out;
  return `${chars.slice(0, MAX_AGENT_REASON - 1).join('').trimEnd()}…`;
}
