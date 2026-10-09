/** Agent-supplied text shown in the UI: no control, zero-width or bidi characters (they could disguise the text), single spaces. */
export const cleanProgress = (text: string) => text
  .replace(/[\t\n\v\f\r]/g, ' ')
  .replace(/[\p{Cc}​-‏‪-‮⁦-⁩؜﻿]/gu, '')
  .replace(/\s+/g, ' ')
  .trim();

export const MAX_AGENT_REASON = 300;

/**
 * The agent's stated reason for a tool call (e.g. Bash `description`), shown on approval cards only as a quote.
 * Every format character (bidi, zero-width, tags) and control character goes, whitespace collapses, at most
 * MAX_AGENT_REASON code points (an ellipsis marks a cut). null when absent, not a string or blank.
 */
export function cleanAgentReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '') // lone surrogates
    .replace(/[\t\n\v\f\r]/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const chars = Array.from(text);
  if (chars.length <= MAX_AGENT_REASON) return text;
  return `${chars.slice(0, MAX_AGENT_REASON - 1).join('').trimEnd()}…`;
}
