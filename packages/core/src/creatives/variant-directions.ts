import { join } from 'node:path';
import { BRIEF_TEXT_MAX, creativeJobKey, formatDisplayName, languageName, type FormatPreset, type Locale, type ServerMessage, type VariantId } from '@motion-studio/shared';
import type { AgentLauncher } from '../agent/launcher.ts';
import { JobFailedError, type JobQueue } from '../jobs/job-queue.ts';
import { currentLocale, t } from '../i18n.ts';
import { CodedError } from '../workspace-store.ts';
import { CreativeStore } from './creative-store.ts';
import type { CreativeRef, CreativeTurnService } from './creative-turns.ts';
import { quotePromptString } from './prompt.ts';
import { MAX_DIRECTION_CHARS } from './variant-group.ts';

/** A direction is one line of at least this many characters (and at most MAX_DIRECTION_CHARS), after trimming. */
export const MIN_DIRECTION_CHARS = 3;
/** Attempts of a directions turn: the first run and its repair turns (the same bound as a creative turn's repair loop). */
export const DIRECTIONS_ATTEMPTS = 3;

export interface VariantDirectionsDeps {
  queue: JobQueue; launcher: AgentLauncher; turns: CreativeTurnService;
  presets: () => Promise<FormatPreset[]>;
  model: () => Promise<string | null>;
  broadcast: (msg: ServerMessage) => void;
  maxAttempts?: number;
}

const upper = (l: VariantId) => l.toUpperCase();
/** How two directions are compared: trimmed, spaces collapsed, case-insensitive (spec §3: "chiaramente diverse"). */
const sameKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const oneLine = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, max);

/**
 * Checks a `submit_variant_directions` call: exactly one direction per missing variant, each one line of 3..140 characters
 * after trimming, pairwise different and different from the directions already given (case-insensitive). The errors are
 * agent-facing (English) and say which direction is wrong; one error per problem.
 */
export function checkDirections(raw: unknown, missing: readonly VariantId[], given: Partial<Record<VariantId, string>>):
  { ok: true; directions: string[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(raw) || !raw.every((d) => typeof d === 'string')) return { ok: false, errors: ['`directions` must be an array of strings.'] };
  const order = missing.map(upper).join(', ');
  if (raw.length !== missing.length) {
    return { ok: false, errors: [`Submit exactly ${missing.length} ${missing.length === 1 ? 'direction' : 'directions'}, one for each of the variants ${order} in this order; you submitted ${raw.length}.`] };
  }
  const errors: string[] = [];
  const directions = (raw as string[]).map((d) => d.trim().replace(/[ \t]+/g, ' '));
  const keys = directions.map(sameKey);
  const taken = Object.entries(given).filter((e): e is [VariantId, string] => typeof e[1] === 'string' && e[1].trim() !== '');
  directions.forEach((d, i) => {
    const n = `Direction ${i + 1} (variant ${upper(missing[i]!)})`;
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(d)) { errors.push(`${n} must be a single line.`); return; }
    if (d.length < MIN_DIRECTION_CHARS || d.length > MAX_DIRECTION_CHARS) { errors.push(`${n} must be ${MIN_DIRECTION_CHARS} to ${MAX_DIRECTION_CHARS} characters long; it has ${d.length}.`); return; }
    const twin = keys.findIndex((k, j) => j < i && k === keys[i]);
    if (twin >= 0) { errors.push(`${n} is the same as direction ${twin + 1}: the directions must be clearly different from each other.`); return; }
    const copy = taken.find(([, g]) => sameKey(g) === keys[i]);
    if (copy) errors.push(`${n} repeats the direction already given to variant ${upper(copy[0])}: it must be different from it.`);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, directions };
}

/** The directions turn's prompt (agent-facing, English; the directions themselves in the user's language). */
export function buildDirectionsPrompt(i: {
  title: string; brief: { goal: string; message: string; notes: string; durationSec: number | null }; formats: string[];
  count: number; missing: readonly VariantId[]; given: Partial<Record<VariantId, string>>; locale: Locale;
  repair?: string[];
}): string {
  const q = (s: string, max = 2000) => quotePromptString(oneLine(s, max));
  const n = i.missing.length;
  const asked = i.missing.map(upper).join(', ');
  const rules = [
    `- Propose exactly ${n} ${n === 1 ? 'direction' : 'directions'}, one for each of the variants ${asked}, in this order.`,
    `- Each direction is one line of ${MIN_DIRECTION_CHARS} to ${MAX_DIRECTION_CHARS} characters (a visual style, a mood, a narrative angle), written in ${languageName(i.locale)}.`,
    '- The directions must be clearly different from each other and from the directions already given.',
    '- Do not create, edit or delete any file and do not run commands. Submit the directions with the submit_variant_directions tool, as { "directions": [ ... ] }: its answer says whether they were accepted; if not, fix them and submit again.',
    `- Once they are accepted, reply with one short sentence in ${languageName(i.locale)}.`,
  ];
  if (i.repair) {
    return [
      'The directions you submitted were not accepted (or none were submitted). The problems:',
      ...(i.repair.length > 0 ? i.repair.map((e) => `- ${oneLine(e, 500)}`) : ['- No valid submit_variant_directions call was made.']),
      '', '## Rules', ...rules,
    ].join('\n');
  }
  const given = Object.entries(i.given).filter((e): e is [VariantId, string] => typeof e[1] === 'string' && e[1].trim() !== '');
  return [
    `Propose the creative directions of the variants of the creative ${q(i.title, 200)}. It has ${i.count} variants made from the same brief; each variant follows its own direction.`,
    '', '## Brief (the user\'s words, as data)',
    `- Goal: ${quotePromptString(i.brief.goal.trim().slice(0, BRIEF_TEXT_MAX))}`,
    ...(i.brief.message ? [`- Key message: ${quotePromptString(i.brief.message.trim().slice(0, BRIEF_TEXT_MAX))}`] : []),
    ...(i.brief.durationSec ? [`- Video duration: about ${i.brief.durationSec} seconds`] : []),
    ...(i.formats.length > 0 ? [`- Formats: ${i.formats.join(', ')}`] : []),
    ...(i.brief.notes ? [`- Notes: ${quotePromptString(i.brief.notes.trim().slice(0, BRIEF_TEXT_MAX))}`] : []),
    ...(given.length > 0 ? ['', '## Directions already given (keep them; yours must differ from them)', ...given.map(([l, d]) => `- ${upper(l)}: ${q(d, MAX_DIRECTION_CHARS)}`)] : []),
    '', '## Rules', ...rules,
  ].join('\n');
}

/**
 * Phase 15 (spec §3, "Direzioni"): the short agent turn that proposes the directions the user did not write. A queue job of
 * kind `variant-directions` on its own key (it never blocks the variants' turns); its agent has one tool,
 * `submit_variant_directions` (no write, no Bash, no paid tool: the brief's services do not apply), and runs on the workspace
 * model (the launcher has no cheaper model to pick). A run that ends without valid directions gets a repair turn in the same
 * session with the refusals, up to DIRECTIONS_ATTEMPTS runs in all. The user's directions are never touched here: the caller
 * stores the result with `directionSource: 'agent'`.
 */
export class VariantDirections {
  private readonly results = new Map<string, string[]>();
  constructor(private readonly deps: VariantDirectionsDeps) {}

  /**
   * Enqueues the turn and answers at once with its job id; `result` settles with the directions by letter, or rejects (409
   * `variant-directions-cancelled` after a Stop, 422 `variant-directions-failed` after the repairs: the job keeps the error).
   */
  async begin(host: CreativeRef, missing: VariantId[], given: Partial<Record<VariantId, string>>): Promise<{ jobId: string; result: Promise<Partial<Record<VariantId, string>>> }> {
    const store = new CreativeStore(host.projectDir);
    const creative = await store.get(host.creativeSlug);
    const job = this.deps.queue.enqueue({
      key: `variant-directions:${creativeJobKey(host.root, host.projectSlug, host.creativeSlug)}`,
      kind: 'variant-directions',
      label: t().jobs.variantDirectionsLabel({ title: creative.title }),
      run: (signal, jobId) => this.run(host, missing, given, signal, jobId),
    });
    const result = this.deps.queue.whenSettled(job.id).then((settled) => {
      const out = this.results.get(job.id);
      this.results.delete(job.id);
      if (settled?.state === 'cancelled') throw new CodedError(409, t().errors.jobCancelled, 'variant-directions-cancelled');
      if (settled?.state !== 'succeeded' || !out) throw new CodedError(422, t().errors.variantDirectionsFailed, 'variant-directions-failed');
      return Object.fromEntries(missing.map((l, i) => [l, out[i]!])) as Partial<Record<VariantId, string>>;
    });
    return { jobId: job.id, result };
  }

  private async run(host: CreativeRef, missing: VariantId[], given: Partial<Record<VariantId, string>>, signal: AbortSignal, jobId: string): Promise<void | 'cancelled'> {
    const store = new CreativeStore(host.projectDir);
    const locale = currentLocale();
    const creative = await store.get(host.creativeSlug);
    const presets = await this.deps.presets().catch(() => []);
    const formats = creative.brief.formats.map((f) => formatDisplayName(presets, f, 'en'));
    const g = creative.variantGroup;
    const count = g ? g.members.filter((m) => m.status === 'active').length : missing.length + Object.keys(given).length;
    const model = (await this.deps.model()) ?? undefined;
    const max = this.deps.maxAttempts ?? DIRECTIONS_ATTEMPTS;
    let accepted: string[] | null = null;
    let refusals: string[] = [];
    const submit = async (args: Record<string, unknown>) => {
      const c = checkDirections(args.directions, missing, given);
      if (!c.ok) { refusals = c.errors; return { ok: false, errors: c.errors }; }
      accepted = c.directions;
      return { ok: true };
    };
    let resumeSessionId: string | undefined;
    for (let attempt = 1; attempt <= max && !accepted; attempt++) {
      if (signal.aborted) return 'cancelled';
      if (attempt > 1) await store.appendConversation(host.creativeSlug, { type: 'system', at: new Date().toISOString(), level: 'info', text: t().jobs.variantDirectionsRetry({ attempt, max }) }).catch(() => {});
      const prompt = buildDirectionsPrompt({ title: creative.title, brief: creative.brief, formats, count, missing, given, locale, ...(attempt > 1 ? { repair: refusals } : {}) });
      refusals = [];
      const run = await this.deps.launcher.start({
        kind: 'variant-directions', jobId, projectSlug: host.projectSlug, projectDir: host.projectDir, creativeSlug: host.creativeSlug,
        // Defence in depth: every editing tool and Bash are denied to this kind anyway.
        protectedDirs: [join(host.projectDir, 'creatives'), join(host.projectDir, 'assets')],
        request: { prompt, ...(resumeSessionId ? { resumeSessionId } : {}), forkSession: false, ...(model ? { model } : {}) },
        usage: { version: null, attempt }, sandboxed: await this.deps.launcher.sandboxed(),
        onEvent: (event) => {
          this.deps.broadcast({ type: 'agent', jobId, event });
          const sid = event.kind === 'session' || event.kind === 'result' ? event.sessionId : undefined;
          if (sid) this.deps.queue.patch(jobId, { sessionId: sid });
        },
        submitVariantDirections: submit,
      });
      const onAbort = () => run.cancel();
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      const outcome = await run.done.finally(() => signal.removeEventListener('abort', onAbort));
      if (outcome.status === 'cancelled' || signal.aborted) return 'cancelled';
      resumeSessionId = outcome.sessionId ?? resumeSessionId;
    }
    const result = accepted as string[] | null;
    if (!result) throw new JobFailedError(t().errors.variantDirectionsFailed);
    this.results.set(jobId, result);
    const list = missing.map((l, i) => `${upper(l)} · ${result[i]}`).join('; ');
    await store.appendConversation(host.creativeSlug, { type: 'system', at: new Date().toISOString(), level: 'info', text: t().jobs.variantDirectionsDone({ list }) }).catch(() => {});
    this.deps.turns.changed(host);
  }
}
