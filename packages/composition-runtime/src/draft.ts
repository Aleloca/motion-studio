/**
 * The validation of an editor draft (`setComposition`, Phase 10b), apart from protocol.ts so that only the preview carries
 * zod: the web imports it directly, the runtime loads it from `preview.js` (entry/preview.ts) in preview mode only.
 */
import { COMPOSITION_LIMITS, compositionSchema, type Composition } from '@motion-studio/shared/composition/schema';

/** Whether the UTF-8 length of `s` passes `max` (stops as soon as it does). */
function utf8Exceeds(s: string, max: number): boolean {
  if (s.length > max) return true; // every UTF-16 unit is at least one byte
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { bytes += 4; i++; }
    else bytes += 3;
    if (bytes > max) return true;
  }
  return false;
}

/**
 * A draft composition: serialised once (which also refuses cycles, BigInts and anything JSON cannot hold), bounded by
 * `COMPOSITION_LIMITS.jsonBytes`, parsed back into a fresh plain copy and checked with `compositionSchema` (structure only:
 * the semantic rules are the editor's and the core's). Null when any step fails.
 */
export function parseDraft(v: unknown): Composition | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  let text: string;
  try { text = JSON.stringify(v); } catch { return null; }
  if (typeof text !== 'string' || utf8Exceeds(text, COMPOSITION_LIMITS.jsonBytes)) return null;
  const r = compositionSchema.safeParse(JSON.parse(text));
  return r.success ? r.data : null;
}
