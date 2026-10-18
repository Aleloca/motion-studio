import { randomUUID } from 'node:crypto';
import {
  activeMembers, variantIndex,
  servicesForFormats, type BriefServices, type FormatPreset, type JobWaitReason, type PaidBatch, type Pin, type ProviderId, type VariantGroup, type VariantId, type VariantMember, type WorkspaceSettings,
} from '@motion-studio/shared';
import type { ApprovalBroker } from '../approvals/broker.ts';
import { isAllowedRule, PermissionsStore } from '../approvals/permissions-store.ts';
import type { PaidService } from '../bridge/provider-tools.ts';
import type { JobQueue } from '../jobs/job-queue.ts';
import { stopJob } from '../jobs/stop.ts';
import { t } from '../i18n.ts';
import { CodedError } from '../workspace-store.ts';
import { CreativeStore } from './creative-store.ts';
import type { CreativeRef, CreativeTurnService } from './creative-turns.ts';
import type { VariantDirections } from './variant-directions.ts';
import { memberRef, VariantGroupService } from './variant-group.ts';

/** What a variant run asks of each target: the same body as `POST …/turns` (text, pins, formats). */
export interface UserRequest { text?: string; pins?: Pin[]; formats?: string[] }

/**
 * What `POST …/variants/run` answers at once (202), by variant letter. `jobs`: the creative turn of each idle target, made
 * now and held (`waitReason` `variant-directions` or `variant-confirm`) until the run's directions and card allow it, then
 * queued with `variant-slot` while two variants already work. `queued`: targets that were working: the request waits in
 * that variant's own queue (spec §4), held the same way. `skipped`: discarded or missing targets, and working ones for a
 * first generation (nothing to queue). `failed`: targets refused now, with the reason. `directionsJobId`: the directions
 * turn, when one runs. `batchId`: the `jobId` of the paid-services card, when one will be shown (after the directions).
 */
export interface FanoutResult {
  jobs: Partial<Record<VariantId, string>>;
  queued: VariantId[];
  skipped: VariantId[];
  failed: Partial<Record<VariantId, string>>;
  directionsJobId?: string;
  batchId?: string;
}

export interface VariantFanoutDeps {
  turns: CreativeTurnService; queue: JobQueue; approvals: ApprovalBroker;
  settings: () => Promise<WorkspaceSettings>;
  /** The paid services a turn under the brief's services may use now (`paidServicePlan`). */
  paidPlan: (services?: BriefServices) => Promise<PaidService[]>;
  /** The format presets now: the plan lists only the services a creative's formats can use (decision 1125). */
  presets: () => Promise<FormatPreset[]>;
  directions: VariantDirections;
}

const PROVIDER_LABEL: Record<ProviderId, string> = { openai: 'OpenAI', elevenlabs: 'ElevenLabs', pexels: 'Pexels', unsplash: 'Unsplash' };
const letterIndex = (l: VariantId) => variantIndex(l);
const upper = (l: VariantId) => l.toUpperCase();

/**
 * One target of a run: its held turn (`jobId`), or its queued request (`clientId`) until that becomes a turn. `gone` resolves
 * when that work is over without the run's say: the turn settled (stopped by hand), or the request was taken out of the queue.
 */
interface Entry {
  letter: VariantId; ref: CreativeRef; jobId?: string; clientId?: string;
  /** Applied to the queued request's turn when it starts (the cover). */ onStart?: (jobId: string) => void;
  gone?: Promise<void>; markGone?: () => void; /** Set once `gone` resolved: nothing more is set for it (no hold, no cover, no hook). */ ended?: boolean; /** Told the turn's id when a queued request starts: `gone` follows that turn. */ watch?: (jobId: string) => void;
}
/** The hook of a queued request: its current hold, what its turn gets when it starts, and what happens if it is removed by hand. */
const hookOf = (e: Entry, hold: JobWaitReason | null) => ({ hold, started: (id: string) => { e.jobId = id; e.watch?.(id); e.onStart?.(id); }, removed: () => e.markGone?.() });
interface PaidPlan { items: NonNullable<PaidBatch['items']>; rules: string[]; /** The rules still open per variant, to recompute `rules` for the variants that really start. */ byVariant: Partial<Record<VariantId, string[]>> }
type DirectionsRun = Awaited<ReturnType<VariantDirections['begin']>>;

/**
 * Phase 15 (spec §3 "Turni delle varianti", §4 "Tutte"): starts a request, or the first generation, in several variants of a
 * group. Each start is a normal creative turn of that member (`CreativeTurnService.start`: its own conversation, queue, Stop,
 * pending brief); the group's limit of MAX_RUNNING_VARIANTS running turns is the job queue's `slot` gate, so the next
 * waiting variant starts when one finishes, fails or is stopped. A discarded variant is skipped (inert until restored).
 *
 * The run answers at once; then, in the background: the directions turn (when a target has no direction), then ONE
 * `paid-batch` card for every target (idle or working) when their services can cause a paid call, then the start. Until
 * then no turn of the run starts (orchestrator, fix round 1): approving starts them under the card's cover (their paid
 * calls ask nothing more); declining, the card expiring or the directions failing cancels every turn of the run and takes
 * its requests out of the working variants' queues, so nothing ran and nothing was spent, Claude Code tokens included.
 */
export class VariantFanout {
  constructor(private readonly deps: VariantFanoutDeps) {}

  private async targetsOf(ref: CreativeRef, targets: VariantId[] | 'all-active'): Promise<{ host: CreativeRef; group: VariantGroup; members: VariantMember[]; skipped: VariantId[] }> {
    const e = t().errors;
    const r = await new VariantGroupService({ store: new CreativeStore(ref.projectDir), turns: this.deps.turns }).resolve(ref);
    if (r.orphan) throw new CodedError(409, e.variantOrphan, 'variant-orphan');
    if (!r.group) throw new CodedError(409, e.variantNoGroup, 'variant-no-group');
    const g = r.group;
    const chosen = targets === 'all-active' ? activeMembers(g) : [...new Set(targets)].map((l) => {
      const m = g.members.find((x) => x.letter === l);
      if (!m) throw new CodedError(404, e.variantUnknown({ letter: upper(l) }), 'variant-unknown');
      return m;
    });
    chosen.sort((a, b) => letterIndex(a.letter) - letterIndex(b.letter));
    const members = chosen.filter((m) => m.status === 'active' && !r.missing.includes(m.slug));
    const skipped = chosen.filter((m) => !members.includes(m)).map((m) => m.letter);
    if (members.length === 0) {
      if (chosen.some((m) => m.status === 'discarded')) throw new CodedError(409, e.variantDiscardedTurn, 'variant-discarded');
      throw new CodedError(409, e.variantUnknown({ letter: chosen.map((m) => upper(m.letter)).join(', ') }), 'variant-missing');
    }
    return { host: r.host, group: g, members, skipped };
  }

  /** `POST …/variants/run` (ruling R3): the targets' turns and queued requests are made now (held); the rest goes on in the background. */
  async run(ref: CreativeRef, targets: VariantId[] | 'all-active', request: UserRequest | null): Promise<FanoutResult> {
    const { host, group, members, skipped } = await this.targetsOf(ref, targets);
    const { turns } = this.deps;
    const out: FanoutResult = { jobs: {}, queued: [], skipped: [...skipped], failed: {} };
    const text = request?.text?.trim() ?? '';
    const pins = request?.pins ?? [];
    const message = text || pins.length ? { text, pins } : undefined;
    const formats = request?.formats?.length ? request.formats : undefined;
    // Who gets a turn now and who gets the request in its own queue (it is working).
    const idle: VariantMember[] = [];
    const busy: VariantMember[] = [];
    for (const m of members) {
      if (!turns.turnActive(memberRef(host, m.slug))) idle.push(m);
      else if (!message) out.skipped.push(m.letter);
      // A queued request has no formats of its own: refused, with the reason, rather than widened to every format.
      else if (formats) out.failed[m.letter] = t().errors.variantBusyFormats({ letter: upper(m.letter) });
      else busy.push(m);
    }
    const candidates = [...idle, ...busy].sort((a, b) => letterIndex(a.letter) - letterIndex(b.letter));
    // Decision 1153: one request id for every share of the request, and the variant whose turn may add variants
    // (`CreativeTurnService.addRefusal`); kept with a queued share on disk.
    const fanout = message && candidates[0] ? { id: randomUUID(), lead: candidates[0].letter } : undefined;
    const missing = candidates.filter((m) => !m.direction).map((m) => m.letter);
    const wholePlan = candidates.length >= 2 ? await this.paidPlan(host, candidates) : null;
    const first: JobWaitReason | null = missing.length > 0 ? 'variant-directions' : wholePlan ? 'variant-confirm' : null;
    const entries: Entry[] = [];
    let error: unknown = null;
    for (const m of candidates) {
      const mref = memberRef(host, m.slug);
      try {
        if (idle.includes(m)) {
          const job = await turns.start(mref, message, { ...(formats ? { formats } : {}), ...(first ? { hold: first } : {}), ...(fanout ? { fanout } : {}) });
          const held: Entry = { letter: m.letter, ref: mref, jobId: job.id };
          held.gone = this.deps.queue.whenSettled(job.id).then(() => { held.ended = true; });
          entries.push(held);
          out.jobs[m.letter] = job.id;
        } else {
          const entry: Entry = { letter: m.letter, ref: mref, clientId: randomUUID() };
          entry.gone = new Promise<void>((resolve) => { entry.markGone = () => { entry.ended = true; resolve(); }; });
          // Looked up after the current step: the turn is told its id right BEFORE it is enqueued.
          entry.watch = (id) => { void Promise.resolve().then(() => this.deps.queue.whenSettled(id)).then(() => entry.markGone?.()); };
          if (first) turns.setQueuedHook(mref, entry.clientId!, hookOf(entry, first));
          try {
            await turns.postMessage(mref, { clientId: entry.clientId!, text, pins, mode: 'queued' }, fanout ? { fanout } : {});
          } catch (err) { turns.setQueuedHook(mref, entry.clientId!, null); throw err; }
          entries.push(entry);
          out.queued.push(m.letter);
        }
      } catch (err) {
        error ??= err;
        out.failed[m.letter] = err instanceof Error ? err.message : String(err);
      }
    }
    if (entries.length === 0 && error) throw error;
    // Minor (Task 3): the card lists only the targets that really started; one whose start failed has nothing to confirm.
    const startedLetters = new Set(entries.map((e) => e.letter));
    const started = wholePlan ? {
      ...wholePlan, items: wholePlan.items.filter((i) => startedLetters.has(i.variant)),
      // The cover's rules too: a rule only a failed variant needed is not covered.
      rules: [...new Set([...startedLetters].flatMap((l) => wholePlan.byVariant[l] ?? []))],
    } : null;
    const plan = started && started.items.length > 0 ? started : null;
    if (entries.length === 0 || !first) return out;
    // The background part: directions, then the card, then the start.
    let directions: DirectionsRun | null = null;
    const runMissing = missing.filter((l) => entries.some((e) => e.letter === l));
    if (runMissing.length > 0) {
      const given = Object.fromEntries(group.members.filter((m) => m.direction).map((m) => [m.letter, m.direction!])) as Partial<Record<VariantId, string>>;
      try {
        directions = await this.deps.directions.begin(host, runMissing, given);
      } catch (err) {
        await this.cancelAll(entries);
        throw err;
      }
      out.directionsJobId = directions.jobId;
    }
    const batchId = plan ? randomUUID() : undefined;
    if (batchId) out.batchId = batchId;
    void this.background(host, entries, runMissing, directions, plan, batchId).catch((err: Error) => {
      console.warn(`Motion Studio: a variant run of ${host.creativeSlug} did not start: ${err.message}`);
    });
    return out;
  }

  /** Directions → card → start; anything that does not end in "go" cancels the whole run. */
  private async background(host: CreativeRef, entries: Entry[], missing: VariantId[], directions: DirectionsRun | null, plan: PaidPlan | null, batchId: string | undefined): Promise<void> {
    try {
      if (directions) {
        const found = await directions.result;
        const svc = new VariantGroupService({ store: new CreativeStore(host.projectDir), turns: this.deps.turns });
        const now = (await svc.resolve(host)).group;
        for (const l of missing) {
          // A direction the user typed meanwhile wins.
          if (now?.members.find((m) => m.letter === l)?.direction) continue;
          await svc.setDirection(host, l, found[l]!, 'agent');
        }
      }
      if (plan && batchId) {
        this.setHold(entries, 'variant-confirm');
        const answer = await this.ask(host, entries, plan, batchId);
        if (answer === 'stopped') { await this.cancelAll(entries); return; }
        // Decision 1126: Decline is "no paid services", not "no generation": the variants start with paid services off.
        if (answer === 'declined') this.coverOff(entries);
        else this.cover(entries, plan.rules);
      }
      this.setHold(entries, null);
    } catch (err) {
      await this.cancelAll(entries);
      throw err;
    }
  }

  /** The current hold of every target: its held turn, or its queued request's turn when it starts. */
  private setHold(entries: Entry[], reason: JobWaitReason | null): void {
    for (const e of entries) {
      if (e.ended) continue; // gone by hand: a hook set now would never be consumed
      if (e.jobId) { this.deps.queue.setHold(e.jobId, reason); continue; }
      this.deps.turns.setQueuedHook(e.ref, e.clientId!, hookOf(e, reason));
    }
  }

  /** After an approval: every turn of the run (and each queued request's, when it starts) asks nothing more for these rules. */
  private cover(entries: Entry[], rules: string[]): void {
    const { approvals, queue } = this.deps;
    const apply = (id: string) => {
      approvals.cover(id, rules, Promise.resolve(true));
      // Looked up after the current step: a queued request's turn is told its id right BEFORE it is enqueued.
      void Promise.resolve().then(() => queue.whenSettled(id)).then(() => approvals.uncover(id));
    };
    for (const e of entries) {
      if (e.ended) continue;
      if (e.jobId) { apply(e.jobId); continue; }
      // Keyed by member + clientId: applied when that queued request becomes a turn (right before it is enqueued).
      e.onStart = apply;
    }
  }

  /** After a decline: every turn of the run (and each queued request's, when it starts) has paid services off, and any paid call is refused without a card. */
  private coverOff(entries: Entry[]): void {
    const { approvals, queue } = this.deps;
    const apply = (id: string) => {
      approvals.coverOff(id);
      void Promise.resolve().then(() => queue.whenSettled(id)).then(() => approvals.uncover(id));
    };
    for (const e of entries) {
      if (e.ended) continue;
      if (e.jobId) { apply(e.jobId); continue; }
      e.onStart = apply;
    }
  }

  /** Nothing of the run goes on: its held turns are cancelled (they never ran), its queued requests leave their queues. */
  private async cancelAll(entries: Entry[]): Promise<void> {
    const { queue, approvals, turns } = this.deps;
    for (const e of entries) {
      if (e.clientId && !e.jobId) {
        // The hook stays (held, no cover) until the removal is through: `removeQueued` takes the variant's lock, so a start of
        // this request already in flight finishes first, enqueued held, and records its id here to be stopped below.
        e.onStart = undefined;
        turns.setQueuedHook(e.ref, e.clientId, hookOf(e, 'variant-confirm'));
        try {
          await turns.removeQueued(e.ref, e.clientId);
          turns.setQueuedHook(e.ref, e.clientId, null);
        } catch (err) {
          if ((err as { apiCode?: string }).apiCode === 'not-queued') turns.setQueuedHook(e.ref, e.clientId, null); // started meanwhile (stopped below) or gone
          else {
            // Still queued (the removal failed): it must not run later as if nothing was decided. The hook stays; its turn is
            // stopped as soon as it is made, before it can run.
            await new CreativeStore(e.ref.projectDir).appendConversation(e.ref.creativeSlug, { type: 'system', at: new Date().toISOString(), level: 'warning', text: t().jobs.variantRequestWillStop }).catch(() => {});
            console.warn(`Motion Studio: a declined variant request of ${e.ref.creativeSlug} could not be removed from its queue: ${err instanceof Error ? err.message : String(err)}`);
            turns.setQueuedHook(e.ref, e.clientId, { hold: 'variant-confirm', started: (id) => { void Promise.resolve().then(() => stopJob({ queue, approvals }, id)); } }); // after the step: the turn is enqueued right after this call
          }
        }
      }
      // A held turn, or the turn a queued request became (still held: it never ran).
      if (e.jobId) stopJob({ queue, approvals }, e.jobId);
    }
  }

  /** Shows the card and waits for it: approved, declined (the run goes on without paid services), or stopped (expired, or every target gone by hand). */
  private async ask(host: CreativeRef, entries: Entry[], plan: PaidPlan, batchId: string): Promise<'approved' | 'declined' | 'stopped'> {
    const a = t().approvals;
    const { items } = plan;
    const label = (i: (typeof items)[number]) => a.variantBatchItem({ letter: upper(i.variant), service: a.serviceNames[i.capability], provider: PROVIDER_LABEL[i.provider] });
    const variants = [...new Set(items.map((i) => i.variant))];
    const providers = [...new Set(items.map((i) => i.provider))].map((p) => ({ provider: p, calls: items.filter((i) => i.provider === p).length }));
    const seconds = items.reduce((n, i) => n + (i.seconds ?? 0), 0);
    const paidBatch: PaidBatch = {
      // Today's card names one provider: the one with the most calls (`total.providers` lists them all, for Task 5).
      provider: [...providers].sort((x, y) => y.calls - x.calls)[0]!.provider,
      calls: items.map((i) => ({ label: label(i), chars: i.chars ?? 0 })),
      items,
      total: { variants: variants.length, calls: items.length, providers, ...(seconds > 0 ? { seconds } : {}) },
    };
    const detail = a.variantBatchDetail({
      providers: providers.map((p) => `${PROVIDER_LABEL[p.provider]} ${p.calls}`).join(', '),
      variants: variants.map((v) => `${upper(v)} ${items.filter((i) => i.variant === v).length}`).join(', '),
    });
    const pending = this.deps.approvals.request({
      jobId: batchId, projectSlug: host.projectSlug, projectDir: host.projectDir, creativeSlug: host.creativeSlug, kind: 'paid-batch',
      toolName: 'provider:variant-batch', input: {}, title: a.variantBatchTitle({ count: variants.length }), detail, paidBatch,
    });
    // Every target gone by hand (its turn stopped, its queued request removed): the card has nothing left to confirm.
    void Promise.all(entries.map((e) => e.gone)).then(() => this.deps.approvals.cancelJob(batchId));
    const o = await pending;
    if (o.decision === 'once' || o.decision === 'always') return 'approved';
    return o.decision === 'deny' ? 'declined' : 'stopped';
  }

  /**
   * The services of the card (spec §3): per target variant, the paid services its agent may use, as the tools would decide them
   * now (`paidServicePlan`: the brief's choices, the keys, the key checks), without those a project "Always" rule already
   * allows. Null (no card, start at once) when the confirmation is off or nothing paid can be called.
   */
  private async paidPlan(host: CreativeRef, members: VariantMember[]): Promise<PaidPlan | null> {
    if (!(await this.deps.settings()).confirmPaidProviders) return null;
    const store = new CreativeStore(host.projectDir);
    const permissions = new PermissionsStore(host.projectDir);
    const allowed = async (rule: string) => isAllowedRule(rule) && await permissions.has(rule).catch(() => false);
    const items: PaidPlan['items'] = [];
    const rules = new Set<string>();
    const byVariant: PaidPlan['byVariant'] = {};
    const presets = await this.deps.presets();
    for (const m of members) {
      const c = await store.get(m.slug);
      // Decision 1125: only what the creative's formats can use (no voice for a still image, no raster images for an identity pack).
      for (const s of await this.deps.paidPlan(servicesForFormats(c.brief.services, c.brief.formats, presets))) {
        const open: string[] = [];
        for (const r of s.rules) if (!(await allowed(r))) open.push(r);
        if (open.length === 0) continue;
        for (const r of open) rules.add(r);
        byVariant[m.letter] = [...new Set([...(byVariant[m.letter] ?? []), ...open])];
        items.push({ variant: m.letter, provider: s.provider, capability: s.kind, ...(s.kind === 'music' && c.brief.durationSec ? { seconds: c.brief.durationSec } : {}) });
      }
    }
    return items.length === 0 ? null : { items, rules: [...rules], byVariant };
  }
}
