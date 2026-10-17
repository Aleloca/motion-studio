import { z } from 'zod';

/**
 * User note 8: Claude Code's built-in `AskUserQuestion` tool, answered from a question card instead of a permission card.
 * Input shape and limits as documented for the Agent SDK (https://code.claude.com/docs/en/agent-sdk/user-input, "Question
 * format"): 1–4 questions, each with a header, the question text, 2–4 options (`label`, `description`) and `multiSelect`.
 */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/**
 * Sanity limits of the texts the core accepts. A text over its limit makes the request invalid (denied, no card): the core
 * never cuts one, since the answer is keyed by the exact question text and names the exact label. The UI shortens long
 * texts for display only (`QUESTION_DISPLAY`).
 */
export const QUESTION_LIMITS = { questions: 4, minOptions: 2, options: 4, question: 4000, header: 200, label: 500, description: 4000, other: 2000 } as const;
/** Characters the card shows before "…" (the whole text stays in the tooltip). */
export const QUESTION_DISPLAY = { question: 600, header: 40, label: 120, description: 300 } as const;

const option = z.object({
  label: z.string().min(1).max(QUESTION_LIMITS.label).refine((s) => s.trim() !== ''),
  description: z.string().max(QUESTION_LIMITS.description).optional().default(''),
});
/**
 * Texts that name a property every object has: as a key of `answers` they would read or write `Object.prototype` in a
 * careless consumer (ours or Claude Code's). Such a question is refused (review fix).
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const question = z.object({
  question: z.string().min(1).max(QUESTION_LIMITS.question).refine((s) => s.trim() !== '' && !RESERVED_KEYS.has(s.trim())),
  header: z.string().max(QUESTION_LIMITS.header).optional().default(''),
  options: z.array(option).min(QUESTION_LIMITS.minOptions).max(QUESTION_LIMITS.options)
    // Two options with the same label could not be told apart in the answer.
    .refine((o) => new Set(o.map((x) => x.label)).size === o.length),
  multiSelect: z.boolean().optional().default(false),
});

/** The part of the agent's input the card needs (other fields are ignored here and passed back untouched). */
export const askUserQuestionInputSchema = z.object({
  questions: z.array(question).min(1).max(QUESTION_LIMITS.questions)
    // The answers are keyed by the question text: two equal questions would share one answer.
    .refine((q) => new Set(q.map((x) => x.question)).size === q.length),
});
export type AgentQuestion = z.output<typeof question>;

/**
 * What the card sends back (POST /api/approvals/:id/answer), one item per question in order: the indexes of the chosen
 * options and the "Other" text. The core turns it into the labels; the browser never sends a label of its own.
 */
export const questionAnswersSchema = z.array(z.object({
  selected: z.array(z.number().int().min(0).max(QUESTION_LIMITS.options - 1)).max(QUESTION_LIMITS.options),
  other: z.string().max(QUESTION_LIMITS.other).optional(),
}).strict()).min(1).max(QUESTION_LIMITS.questions);
export type QuestionAnswers = z.infer<typeof questionAnswersSchema>;

/**
 * The `answers` object Claude Code expects (documented for the SDK's `canUseTool`): question text → chosen label, several
 * labels joined with ", ", the user's own text for "Other". Null when the answers do not fit the questions: a single-choice
 * question needs exactly one of an option or a text, a multiple-choice one at least one; indexes must exist and not repeat.
 */
export function answersFor(questions: readonly AgentQuestion[], given: QuestionAnswers): Record<string, string> | null {
  if (given.length !== questions.length) return null;
  // Built with `Object.fromEntries` (own data properties): a key like `__proto__` is never the prototype setter.
  const out: Array<[string, string]> = [];
  for (const [i, q] of questions.entries()) {
    const a = given[i]!;
    if (new Set(a.selected).size !== a.selected.length || a.selected.some((k) => k >= q.options.length)) return null;
    const other = a.other?.trim() ?? '';
    const parts = [...a.selected].sort((x, y) => x - y).map((k) => q.options[k]!.label);
    if (other) parts.push(other);
    if (parts.length === 0 || (!q.multiSelect && parts.length !== 1)) return null;
    out.push([q.question, parts.join(', ')]);
  }
  return Object.fromEntries(out);
}
