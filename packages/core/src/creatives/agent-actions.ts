import { INSTANCE_ID_RE, SUPPORTED_LOCALES, VARIANT_LETTERS, briefSchema, formatDisplayName, issuesText, presetOf, type Brief, type BriefServices, type FormatPreset, type VariantLetter } from '@motion-studio/shared';
import { z } from 'zod';
import type { AppScope, BridgeContext } from '../bridge/bridge.ts';
import type { BridgeHandler } from '../bridge/bridge-routes.ts';
import { findPreset } from '../formats/format-catalog.ts';
import { currentLocale, t } from '../i18n.ts';
import type { LocalizeService } from '../localization/localize-turn.ts';
import { checkedLocale } from '../localization/validate.ts';
import { CodedError } from '../workspace-store.ts';
import { CreativeStore } from './creative-store.ts';
import type { BriefPatch, CreativeRef, CreativeTurnService, TurnSettled } from './creative-turns.ts';
import type { DirectEditService } from './direct-edit.ts';
import { prepareExportRenders } from './export-prepare.ts';
import type { RenderJobService } from './render-jobs.ts';
import type { VariantFanout } from './variant-fanout.ts';
import { MAX_DIRECTION_CHARS, VariantGroupService } from './variant-group.ts';
import { pendingByMember, planGroupExport } from './variant-export.ts';

/**
 * Decision 917 (user note 6): the agent's actions on the app, as the user would do them, with no confirmation card. Each
 * `studio` tool here is a thin call into the SAME function the UI's route calls (same checks, locks, 409s and side effects);
 * see docs/superpowers/specs/2026-10-17-agent-app-actions-design.md.
 *
 * - **Scope.** Everything comes from the bridge context's `appScope` (the turn's creative and the version it makes, set by
 *   the core): no argument names a project, a creative or a job. Variant letters are mapped to slugs from the stored group.
 * - **During the agent's own turn.** Brief edits become the creative's pending brief (applied when the turn ends; in a
 *   group, the group's edit); a new duration applies to the turn's own checks at once. Actions that need the turn to be
 *   over (a duplicate, the render or ★ of "current", the export renders, the follow-up turn of new formats, a translation)
 *   are kept in memory per job and run when the turn settles, in a fixed order; dropped when it saved no version.
 * - **Bounds.** 30 calls per turn; new variants: the group's own cap (MAX_VARIANTS members, discarded ones included, never
 *   freed), so at most 4 variant turns ever per group; one follow-up turn per turn, never from a follow-up turn; one
 *   translation job per turn.
 * - **Chat.** Every action writes a system line with `origin: 'agent'` through the turn's ordered writer.
 */

/** App actions per turn (the chat and git history are never flooded). */
export const APP_ACTIONS_PER_TURN = 30;

export interface AgentActionDeps {
  turns: CreativeTurnService;
  edits: DirectEditService;
  renders: RenderJobService;
  localize: LocalizeService;
  variantRuns: VariantFanout;
  presets: () => Promise<FormatPreset[]>;
}

/** What waits for the end of the turn, in the order it runs (`ORDER`). `what`: the chat's short name of it (already translated). */
type Deferred =
  | { kind: 'duplicate'; format: string; label?: string; what: string }
  | { kind: 'pick'; format: string; what: string }
  | { kind: 'render'; formats?: string[]; shown: string; what: string }
  | { kind: 'export'; what: string }
  | { kind: 'followUp'; formats: string[]; what: string }
  | { kind: 'localize'; locales: string[]; formats?: string[]; what: string };
const ORDER: ReadonlyArray<Deferred['kind']> = ['duplicate', 'pick', 'render', 'export', 'followUp', 'localize'];

const now = () => new Date().toISOString();
const upper = (l: string) => l.toUpperCase();
const localeName = (tag: string) => SUPPORTED_LOCALES.find((x) => x.tag === tag)?.name ?? tag;
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();

const letter = z.enum(VARIANT_LETTERS as unknown as [VariantLetter, ...VariantLetter[]]);
const version = z.union([z.number().int().min(1).max(999_999), z.literal('current')]);
const formatId = z.string().min(1).max(200);
const label = z.string().trim().min(1).max(60);
const servicesSchema = z.strictObject({
  images: briefSchema.shape.services.unwrap().shape.images, voice: briefSchema.shape.services.unwrap().shape.voice,
  music: briefSchema.shape.services.unwrap().shape.music, sfx: briefSchema.shape.services.unwrap().shape.sfx,
});
const inputs = {
  update_brief: z.strictObject({
    durationSec: z.number().int().min(1).max(600).nullable().optional(),
    goal: z.string().trim().min(1).max(2000).optional(), message: z.string().max(500).optional(), notes: z.string().max(10_000).optional(),
    services: servicesSchema.optional(),
  }).refine((a) => Object.keys(a).length > 0, { message: 'issue.nothingToChange' }),
  add_format: z.strictObject({ format: formatId, label: label.optional() }),
  duplicate_format: z.strictObject({ format: z.string().regex(INSTANCE_ID_RE), label: label.optional() }),
  add_language: z.strictObject({ locale: z.string().min(1).max(40), primary: z.string().min(1).max(40).optional(), formats: z.array(z.string().regex(INSTANCE_ID_RE)).min(1).max(100).optional() }),
  add_variant: z.strictObject({ direction: z.string().trim().min(3).max(MAX_DIRECTION_CHARS) }),
  variant: z.strictObject({ variant: letter }),
  set_pick: z.strictObject({ format: formatId, version, variant: letter.optional() }),
  render_version: z.strictObject({ version, formats: z.array(formatId).min(1).max(100).optional() }),
  prepare_export: z.strictObject({}),
};

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const r = schema.safeParse(args ?? {});
  if (!r.success) {
    if (r.error.issues.some((i) => i.message === 'issue.nothingToChange')) throw new CodedError(400, t().agentActions.nothingToChange, 'invalid-request');
    throw new CodedError(400, t().errors.invalidRequestDetail({ detail: issuesText(r.error, currentLocale()) }), 'invalid-request');
  }
  return r.data;
}

interface Scope { ref: CreativeRef; version: number; jobId: string }

export class AgentActionService {
  /** Calls so far, by job. */
  private readonly calls = new Map<string, number>();
  /** What waits for the end of each turn, by job. In memory only (like the queue's auto-start): nothing on disk starts it. */
  private readonly deferred = new Map<string, Deferred[]>();
  /** Turns started as the follow-up of new formats: they never start another one (depth 1). */
  private readonly followUps = new Set<string>();

  constructor(private readonly deps: AgentActionDeps) {
    deps.turns.onTurnSettled((ref, jobId, outcome) => this.settled(ref, jobId, outcome));
  }

  /** The bridge handlers, by tool name (`APP_ACTION_TOOLS`). */
  tools(): Record<string, BridgeHandler> {
    const on = (fn: (s: Scope, args: Record<string, unknown>) => Promise<unknown>): BridgeHandler => async (c: BridgeContext, args) => fn(this.scopeOf(c), args);
    return {
      update_brief: on((s, a) => this.updateBrief(s, parse(inputs.update_brief, a))),
      add_format: on((s, a) => this.addFormat(s, parse(inputs.add_format, a))),
      duplicate_format: on((s, a) => this.duplicateFormat(s, parse(inputs.duplicate_format, a))),
      add_language: on((s, a) => this.addLanguage(s, parse(inputs.add_language, a))),
      add_variant: on((s, a) => this.addVariant(s, parse(inputs.add_variant, a))),
      discard_variant: on((s, a) => this.discardOrRestore(s, parse(inputs.variant, a).variant, 'discard')),
      restore_variant: on((s, a) => this.discardOrRestore(s, parse(inputs.variant, a).variant, 'restore')),
      set_pick: on((s, a) => this.setPick(s, parse(inputs.set_pick, a))),
      render_version: on((s, a) => this.render(s, parse(inputs.render_version, a))),
      prepare_export: on((s, a) => { parse(inputs.prepare_export, a); return this.prepareExport(s); }),
    };
  }

  /** The turn's scope; refused for any other job, and past the per-turn limit (the call counts even when it then fails). */
  private scopeOf(c: BridgeContext): Scope {
    const a: Readonly<AppScope> | undefined = c.appScope;
    if (c.kind !== 'creative' || !a) throw new CodedError(403, t().errors.toolUnavailable, 'tool-unavailable');
    const count = (this.calls.get(c.jobId) ?? 0) + 1;
    if (count > APP_ACTIONS_PER_TURN) throw new CodedError(429, t().agentActions.limit({ max: APP_ACTIONS_PER_TURN }), 'actions-limit');
    this.calls.set(c.jobId, count);
    return { ref: { root: a.root, projectSlug: a.projectSlug, projectDir: a.projectDir, creativeSlug: a.creativeSlug }, version: a.version, jobId: c.jobId };
  }

  private store(s: Scope) { return new CreativeStore(s.ref.projectDir); }
  private variants(s: Scope) { return new VariantGroupService({ store: this.store(s), turns: this.deps.turns }); }
  private note(s: Scope, text: string, ref: CreativeRef = s.ref): Promise<void> {
    return this.deps.turns.noteFromTurn(s.jobId, ref, { type: 'system', at: now(), level: 'info', text, origin: 'agent' });
  }
  private async labelOf(s: Scope): Promise<(id: string) => string> {
    const presets = await this.deps.presets();
    const brief = await this.briefNow(s);
    return (id) => formatDisplayName(presets, id, currentLocale(), brief.formatLabels);
  }
  /** The creative's brief as it will be when the turn ends (its pending brief, else the stored one). */
  private async briefNow(s: Scope): Promise<Brief> {
    return (await this.deps.turns.side.pendingBrief(s.ref.projectDir, s.ref.creativeSlug))?.brief ?? (await this.store(s).get(s.ref.creativeSlug)).brief;
  }
  private defer(s: Scope, d: Deferred): void {
    const list = this.deferred.get(s.jobId) ?? [];
    // One follow-up turn and one translation per turn: what is asked again joins them.
    const same = list.find((x) => x.kind === d.kind && (d.kind === 'followUp' || d.kind === 'localize'));
    if (same && same.kind === 'followUp' && d.kind === 'followUp') same.formats = [...new Set([...same.formats, ...d.formats])];
    else if (same && same.kind === 'localize' && d.kind === 'localize') {
      same.locales = [...new Set([...same.locales, ...d.locales])];
      same.formats = same.formats && d.formats ? [...new Set([...same.formats, ...d.formats])] : undefined;
      same.what = `${same.what}, ${d.what}`;
    } else list.push(d);
    this.deferred.set(s.jobId, list);
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // The brief.

  private async updateBrief(s: Scope, a: z.infer<typeof inputs.update_brief>) {
    const { before, after } = await this.deps.turns.briefFromAgent(s.ref, (current) => {
      const fields: BriefPatch['fields'] = {
        ...(a.durationSec !== undefined ? { durationSec: a.durationSec } : {}), ...(a.goal !== undefined ? { goal: a.goal } : {}),
        ...(a.message !== undefined ? { message: a.message } : {}), ...(a.notes !== undefined ? { notes: a.notes } : {}),
      };
      return { fields, ...(a.services ? { services: { ...current.services, ...a.services } } : {}) };
    });
    if (a.durationSec !== undefined) this.deps.turns.setTurnDuration(s.jobId, after.durationSec);
    const x = t().agentActions;
    const sec = (v: number | null) => (v === null ? x.durationNone : x.seconds({ n: v }));
    const lines: string[] = [];
    if (before.durationSec !== after.durationSec) lines.push(x.briefDuration({ from: sec(before.durationSec), to: sec(after.durationSec) }));
    if (before.goal !== after.goal) lines.push(x.briefGoal);
    if (before.message !== after.message) lines.push(x.briefMessage);
    if (before.notes !== after.notes) lines.push(x.briefNotes);
    const sv = t().web.services;
    const kinds = Object.keys(sv.kinds) as Array<keyof BriefServices>;
    const changed = kinds.filter((k) => (before.services?.[k] ?? 'auto') !== (after.services?.[k] ?? 'auto'));
    if (changed.length > 0) lines.push(x.briefServices({ list: changed.map((k) => sv.summaryPart({ kind: sv.kinds[k], choice: sv.choices[after.services?.[k] ?? 'auto'] })).join(', ') }));
    for (const line of lines) await this.note(s, `${line} · ${x.afterTurn}`);
    return {
      ok: true, brief: { durationSec: after.durationSec, goal: after.goal, message: after.message, notes: after.notes, services: after.services ?? {} },
      note: `The brief changes when this turn ends${a.durationSec !== undefined ? `; this turn's output checks use durationSec ${after.durationSec ?? 'none'} from now on` : ''}. Services stay as they were for this turn.`,
    };
  }

  private async addFormat(s: Scope, a: z.infer<typeof inputs.add_format>) {
    const presets = await this.deps.presets();
    const preset = findPreset(presets, a.format);
    const x = t().agentActions;
    if (!preset || preset.id !== a.format) throw new CodedError(400, x.formatUnknown({ format: oneLine(a.format).slice(0, 100) }), 'format-unknown');
    if (preset.identity) throw new CodedError(400, x.formatIdentity, 'format-identity');
    const name = formatDisplayName(presets, preset.id, currentLocale());
    await this.deps.turns.briefFromAgent(s.ref, (current) => {
      if (current.formats.some((f) => presetOf(f) === preset.id)) throw new CodedError(409, x.formatInBrief({ format: name }), 'format-in-brief');
      return { brief: { ...current, formats: [...current.formats, preset.id], ...(a.label ? { formatLabels: { ...current.formatLabels, [preset.id]: a.label } } : {}) } };
    });
    this.defer(s, { kind: 'followUp', formats: [preset.id], what: name });
    await this.note(s, `${x.formatAdded({ format: a.label ? `${name} (${a.label})` : name })} · ${x.afterTurn}`);
    return { ok: true, format: preset.id, note: 'The format is in the brief when this turn ends; Motion Studio then makes it in a turn of its own (not this one): do not write its composition now.' };
  }

  private async duplicateFormat(s: Scope, a: z.infer<typeof inputs.duplicate_format>) {
    const brief = await this.briefNow(s);
    const label = await this.labelOf(s);
    if (!brief.formats.includes(a.format)) throw new CodedError(400, t().errors.formatNotInBrief({ format: label(a.format) }), 'format-not-in-brief');
    const what = t().agentActions.duplicateQueued({ format: label(a.format) });
    this.defer(s, { kind: 'duplicate', format: a.format, ...(a.label ? { label: a.label } : {}), what });
    await this.note(s, what);
    return { ok: true, note: `Duplicated from version ${s.version} after this turn ends (a new version made by Motion Studio, no agent).` };
  }

  private async addLanguage(s: Scope, a: z.infer<typeof inputs.add_language>) {
    const ui = currentLocale();
    const tag = checkedLocale(a.locale, ui);
    const primary = a.primary !== undefined ? checkedLocale(a.primary, ui) : undefined;
    const x = t().agentActions;
    await this.deps.turns.briefFromAgent(s.ref, (current) => {
      const loc = current.locales;
      if (!loc) {
        if (!primary) throw new CodedError(400, x.primaryNeeded, 'locale-primary-needed');
        if (primary === tag) throw new CodedError(409, x.languageInBrief({ language: localeName(tag) }), 'locale-in-brief');
        return { fields: { locales: { primary, extra: [tag] } } };
      }
      if (loc.primary === tag) throw new CodedError(409, x.languageInBrief({ language: localeName(tag) }), 'locale-in-brief');
      // Already one of the brief's languages: nothing to change, the translation still starts.
      return { fields: loc.extra.includes(tag) ? {} : { locales: { primary: loc.primary, extra: [...loc.extra, tag] } } };
    });
    this.defer(s, { kind: 'localize', locales: [tag], ...(a.formats ? { formats: a.formats } : {}), what: localeName(tag) });
    await this.note(s, x.languageAdded({ language: localeName(tag) }));
    return { ok: true, locale: tag, note: 'The language is in the brief when this turn ends; Motion Studio then starts its translation (a turn of its own).' };
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Variants.

  private async addVariant(s: Scope, a: z.infer<typeof inputs.add_variant>) {
    const direction = oneLine(a.direction);
    const svc = this.variants(s);
    const r = await svc.resolve(s.ref);
    if (r.orphan) throw new CodedError(409, t().errors.variantOrphan, 'variant-orphan');
    // The canvas's "+ Variante": a creative outside a group becomes A of a group of two (A's direction left as it is). The
    // group's cap (409 `variants-full`) bounds every variant turn these calls can start: discarded members still count.
    const g = await svc.addVariants(r.host, (existing) => (existing === null ? { specs: [{ direction }], hostDirection: null } : { specs: [{ direction }] }));
    const added = g.members.at(-1)!;
    await this.note(s, t().agentActions.variantAdded({ letter: upper(added.letter), direction }));
    const run = await this.deps.variantRuns.run(s.ref, [added.letter], null);
    return { ok: true, variant: added.letter, started: Boolean(run.jobs[added.letter]), ...(run.failed[added.letter] ? { error: run.failed[added.letter] } : {}) };
  }

  private async discardOrRestore(s: Scope, l: VariantLetter, action: 'discard' | 'restore') {
    const svc = this.variants(s);
    if (action === 'discard') await svc.discard(s.ref, l);
    else await svc.restore(s.ref, l);
    const x = t().agentActions;
    await this.note(s, action === 'discard' ? x.variantDiscarded({ letter: upper(l) }) : x.variantRestored({ letter: upper(l) }));
    return { ok: true };
  }

  private async setPick(s: Scope, a: z.infer<typeof inputs.set_pick>) {
    const svc = this.variants(s);
    const r = await svc.resolve(s.ref);
    const label = await this.labelOf(s);
    const x = t().agentActions;
    const self = r.group?.members.find((m) => m.slug === s.ref.creativeSlug);
    if (a.variant !== undefined && !r.group) throw new CodedError(409, t().errors.variantNoGroup, 'variant-no-group');
    const member = a.variant !== undefined ? r.group!.members.find((m) => m.letter === a.variant) : self;
    if (a.variant !== undefined && !member) throw new CodedError(404, t().errors.variantUnknown({ letter: upper(a.variant) }), 'variant-unknown');
    if (a.version === 'current') {
      if (member && member.slug !== s.ref.creativeSlug) throw new CodedError(400, x.currentOwnOnly, 'current-own-only');
      const what = x.pickQueued({ format: label(a.format) });
      this.defer(s, { kind: 'pick', format: a.format, what });
      await this.note(s, what);
      return { ok: true, note: 'The ★ is set on the version this turn makes, when it ends.' };
    }
    if (r.group && member) await svc.setPick(s.ref, a.format, { slug: member.slug, version: a.version });
    else await this.deps.turns.setExportPick(s.ref, a.format, a.version);
    await this.note(s, x.pickSet({ format: label(a.format), version: `${r.group && member ? `${upper(member.letter)} ` : ''}v${a.version}` }));
    return { ok: true };
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Render and export.

  private async render(s: Scope, a: z.infer<typeof inputs.render_version>) {
    const x = t().agentActions;
    const label = await this.labelOf(s);
    const formats = a.formats ? a.formats.map(label).join(', ') : x.allFormats;
    if (a.version === 'current') {
      const what = x.renderQueued({ formats });
      this.defer(s, { kind: 'render', ...(a.formats ? { formats: a.formats } : {}), shown: formats, what });
      await this.note(s, what);
      return { ok: true, note: 'Rendered when this turn ends (the version you are making).' };
    }
    const job = await this.renderNow(s.ref, a.version, a.formats);
    await this.note(s, x.renderStarted({ n: a.version, formats }));
    return { ok: true, jobId: job.id };
  }

  /** The render route's body (decisions log 866: a discarded variant is read-only). */
  private renderNow(ref: CreativeRef, n: number, formats?: string[]) {
    const { turns, renders } = this.deps;
    return turns.runLocked(ref, async () => {
      await turns.assertNotDiscarded(ref);
      return renders.start(ref, n, formats);
    });
  }

  private async prepareExport(s: Scope) {
    const what = t().agentActions.exportQueued;
    this.defer(s, { kind: 'export', what });
    await this.note(s, what);
    return { ok: true, note: 'When this turn ends, Motion Studio renders what the ★ export needs; the user then exports (you cannot write outside the project).' };
  }

  /** The renders the ★ export needs, started (the group's selection in a group, else the creative's ★); the formats counted. */
  private async exportRenders(ref: CreativeRef): Promise<number> {
    const store = new CreativeStore(ref.projectDir);
    const svc = new VariantGroupService({ store, turns: this.deps.turns });
    const { turns, renders } = this.deps;
    if ((await svc.resolve(ref)).group) {
      let count = 0;
      for (const [slug, versions] of pendingByMember(await planGroupExport(svc, store, ref))) {
        const mref = { ...ref, creativeSlug: slug };
        await turns.runLocked(mref, () => turns.assertNotDiscarded(mref));
        for (const [n, formats] of versions) { await renders.ensureJob(mref, n, formats, { wait: false }); count += formats.length; }
      }
      return count;
    }
    const r = await prepareExportRenders({ turns, renders, presets: this.deps.presets }, { ...ref, store }, {}, { stars: true });
    return r.renders.reduce((k, x) => k + x.formats.length, 0);
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // When the turn settles.

  private async settled(ref: CreativeRef, jobId: string, o: TurnSettled): Promise<void> {
    this.calls.delete(jobId);
    const followUp = this.followUps.delete(jobId);
    const list = this.deferred.get(jobId) ?? [];
    this.deferred.delete(jobId);
    if (list.length === 0) return;
    const x = t().agentActions;
    const say = (text: string, level: 'info' | 'warning' = 'info') => this.deps.turns.noteFromTurn(jobId, ref, { type: 'system', at: now(), level, text, origin: 'agent' });
    const n = o.savedVersion;
    if (o.state !== 'succeeded' || n === null || o.stopped) {
      await say(x.dropped({ list: list.map((d) => d.what).join('; ') }), 'warning');
      return;
    }
    const sorted = [...list].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    const store = new CreativeStore(ref.projectDir);
    const { turns } = this.deps;
    for (const [i, d] of sorted.entries()) {
      try {
        if (d.kind === 'duplicate') {
          const r = await this.deps.edits.duplicate(ref, n, { instanceId: d.format, ...(d.label ? { label: d.label } : {}) }, currentLocale());
          const presets = await this.deps.presets();
          const brief = (await store.get(ref.creativeSlug)).brief;
          await say(x.duplicateDone({ format: formatDisplayName(presets, r.instanceId, currentLocale(), brief.formatLabels), n: r.version.n }));
        } else if (d.kind === 'pick') {
          const svc = new VariantGroupService({ store, turns });
          if ((await svc.resolve(ref)).group) await svc.setPick(ref, d.format, { slug: ref.creativeSlug, version: n });
          else await turns.setExportPick(ref, d.format, n);
        } else if (d.kind === 'render') {
          await this.renderNow(ref, n, d.formats);
          await say(x.renderStarted({ n, formats: d.shown }));
        } else if (d.kind === 'export') {
          const count = await this.exportRenders(ref);
          await say(count === 0 ? x.exportNothing : x.exportRendering({ count }));
        } else if (d.kind === 'followUp') {
          // "Save and regenerate" of the new formats: a turn with no message (it targets only the formats its base lacks), once.
          const queued = (await turns.side.read(ref.projectDir, ref.creativeSlug)).queued?.length ?? 0;
          if (followUp || queued > 0) { await say(x.formatMadeNext({ formats: d.what })); continue; }
          const job = await turns.start(ref);
          this.followUps.add(job.id);
          // What is left (a translation) waits for that turn, on the version it makes.
          const rest = sorted.slice(i + 1);
          if (rest.length > 0) this.deferred.set(job.id, rest);
          return;
        } else {
          const latest = (await store.readVersions(ref.creativeSlug)).at(-1)?.n ?? n;
          await this.deps.localize.start(ref, latest, { locales: d.locales, ...(d.formats ? { formats: d.formats } : {}) });
        }
      } catch (err) {
        await say(x.failed({ action: d.what, reason: err instanceof Error ? err.message : String(err) }), 'warning');
      }
    }
  }
}
