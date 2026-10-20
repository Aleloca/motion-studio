import { BRIEF_FIELDS, BRIEF_VARIANTS_MAX, type BriefField, type BriefForm, type LinkedCodebase } from '@motion-studio/shared';

/** The video lengths of the form: presets in seconds, or a custom number. */
export const LENGTHS = ['6', '15', '30', '60', 'custom'] as const;
export type LengthChoice = (typeof LENGTHS)[number];

/** The New creative form's own state, as the brief session sees it. */
export interface FormState {
  goal: string; message: string; length: LengthChoice; customSec: string;
  picked: string[]; codebases: LinkedCodebase[]; notes: string; selected: string[]; variantCount: number;
}

/** The video length the form says (null: not a valid length). */
export function durationOf(length: LengthChoice, customSec: string): number | null {
  const n = length === 'custom' ? Number(customSec) : Number(length);
  return Number.isInteger(n) && n >= 1 && n <= 600 ? n : null;
}

/** The form as the brief session takes it (sent with every message and saved when it changes). */
export function formSnapshot(s: FormState): BriefForm {
  return {
    goal: s.goal, message: s.message, notes: s.notes,
    durationSec: durationOf(s.length, s.customSec),
    assets: s.picked, linkedCodebases: s.codebases, formats: s.selected,
    variants: Math.min(BRIEF_VARIANTS_MAX, Math.max(1, Math.round(s.variantCount))),
  };
}

/** The length control for a duration: a preset when it is one, else `custom` with the seconds (the "use N s" rule). */
export function lengthOf(durationSec: number | null): { length: LengthChoice; customSec: string } {
  // No duration: the custom choice with no seconds (the form's own "no length" state), so it equals the session's null.
  if (durationSec === null) return { length: 'custom', customSec: '' };
  const preset = LENGTHS.find((v) => v !== 'custom' && Number(v) === durationSec);
  return preset ? { length: preset, customSec: '' } : { length: 'custom', customSec: String(durationSec) };
}

/** The fields of a fill the form takes: what the agent wrote, minus the fields the user owns here. */
export function fieldsToApply(written: readonly BriefField[], userEdited: ReadonlySet<BriefField>): BriefField[] {
  return written.filter((f) => !userEdited.has(f));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Who owns each field on this side: the user's (`userEdited`) and the agent's marks (`agentFields`). */
export interface Ownership { userEdited: ReadonlySet<BriefField>; agentFields: ReadonlySet<BriefField> }

/**
 * Decision 1422: the form after a view of the session (a refetch, a save's answer, a fill): every field takes the session's
 * value and owner, except a field with an edit the session has not answered yet (`pending`: changed by hand since the last save
 * went out, or in a save still out) whose value differs: it keeps the user's text and stays theirs, and the next save carries it.
 * A field the agent rewrote on the user's request (`reclaimed`) always takes the session's value: the core dropped the older
 * edit. A field the user owns here but the session no longer lists as theirs, with nothing pending, takes the session's value
 * (a rewrite the user asked for, even when the fill that said so was missed). `taken`: the fields that took the session's value
 * and owner; `changed`: those of them whose value differs from the form's.
 */
export function mergeView(
  local: { form: BriefForm; pending: ReadonlySet<BriefField> } & Ownership,
  server: { form: BriefForm; userEdited: readonly BriefField[]; agentFields: readonly BriefField[] },
  reclaimed: readonly BriefField[] = [],
): { form: BriefForm; userEdited: Set<BriefField>; agentFields: Set<BriefField>; taken: BriefField[]; changed: BriefField[] } {
  const form = { ...local.form } as Record<BriefField, unknown>;
  const userEdited = new Set<BriefField>();
  const agentFields = new Set<BriefField>();
  const taken: BriefField[] = [];
  const changed: BriefField[] = [];
  for (const f of BRIEF_FIELDS) {
    const differs = !same(local.form[f], server.form[f]);
    if (local.pending.has(f) && differs && !reclaimed.includes(f)) {
      userEdited.add(f);
      continue;
    }
    taken.push(f);
    if (differs) { changed.push(f); form[f] = server.form[f]; }
    if (server.userEdited.includes(f)) userEdited.add(f);
    if (server.agentFields.includes(f) && !server.userEdited.includes(f)) agentFields.add(f);
  }
  return { form: form as BriefForm, userEdited, agentFields, taken, changed };
}
