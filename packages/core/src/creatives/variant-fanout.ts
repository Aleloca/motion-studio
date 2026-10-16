import { randomUUID } from 'node:crypto';
import {
  activeMembers, VARIANT_LETTERS,
  type BriefServices, type PaidBatch, type Pin, type ProviderId, type VariantGroup, type VariantLetter, type VariantMember, type WorkspaceSettings,
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
import { VariantGroupService } from './variant-group.ts';

/** What a variant run asks of each target: the same body as `POST …/turns` (text, pins, formats). */
export interface UserRequest { text?: string; pins?: Pin[]; formats?: string[] }

/**
 * What a fan-out did, by variant letter. `jobs`: the creative turn started in each member (running, or queued with the
 * reason `variant-slot`). `queued`: members that were already working; the request went into their own queue (spec §4:
 * queue and Stop are per variant). `skipped`: discarded or missing members, and working ones for a first generation (nothing
 * to queue). `failed`: members whose start was refused, with the reason. `directions`: what the directions turn proposed.
 */
export interface FanoutResult {
  jobs: Partial<Record<VariantLetter, string>>;
  queued: VariantLetter[];
  skipped: VariantLetter[];
  failed: Partial<Record<VariantLetter, string>>;
  directions?: Partial<Record<VariantLetter, string>>;
}

export interface VariantFanoutDeps {
  turns: CreativeTurnService; queue: JobQueue; approvals: ApprovalBroker;
  settings: () => Promise<WorkspaceSettings>;
  /** The paid services a turn under the brief's services may use now (`paidServicePlan`). */
  paidPlan: (services?: BriefServices) => Promise<PaidService[]>;
  directions: VariantDirections;
}

const PROVIDER_LABEL: Record<ProviderId, string> = { openai: 'OpenAI', elevenlabs: 'ElevenLabs', pexels: 'Pexels', unsplash: 'Unsplash' };
const letterIndex = (l: VariantLetter) => VARIANT_LETTERS.indexOf(l);
const upper = (l: VariantLetter) => l.toUpperCase();

/**
 * Phase 15 (spec §3 "Turni delle varianti", §4 "Tutte"): starts a request, or the first generation, in several variants of a
 * group. Each start is a normal creative turn of that member (`CreativeTurnService.start`: its own conversation, queue, Stop,
 * pending brief); the group's limit of MAX_RUNNING_VARIANTS running turns is the job queue's `slot` gate, which every turn of
 * a grouped member takes, so the next waiting variant starts when one finishes, fails or is stopped. A discarded variant is
 * skipped (it stays inert until restored). When two or more variants start, their paid services are confirmed together on
 * ONE `paid-batch` card (phase 12's mechanism): their turns' paid calls wait for that decision instead of asking each,
 * declining (or the card expiring) stops every job of the batch before anything is spent, and stopping one variant leaves the
 * others and the card alone.
 */
export class VariantFanout {
  constructor(private readonly deps: VariantFanoutDeps) {}

  private refFor(host: CreativeRef, slug: string): CreativeRef { return { root: host.root, projectSlug: host.projectSlug, projectDir: host.projectDir, creativeSlug: slug }; }

  /** The group of `ref` and the target members: discarded and missing ones set aside. 409 outside a group or with nothing to start. */
  private async targetsOf(ref: CreativeRef, targets: VariantLetter[] | 'all-active'): Promise<{ host: CreativeRef; group: VariantGroup; members: VariantMember[]; skipped: VariantLetter[] }> {
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

  /**
   * `POST …/variants/run` (ruling R3): the targets without a direction get one from the directions turn first (skipped when
   * the user typed every one), stored with `directionSource: 'agent'`; then the fan-out. A direction the user typed while the
   * turn ran is kept (the user's always win).
   */
  async run(ref: CreativeRef, targets: VariantLetter[] | 'all-active', request: UserRequest | null): Promise<FanoutResult> {
    const { host, group, members } = await this.targetsOf(ref, targets);
    const missing = members.filter((m) => !m.direction).map((m) => m.letter);
    let directions: Partial<Record<VariantLetter, string>> | undefined;
    if (missing.length > 0) {
      const given = Object.fromEntries(group.members.filter((m) => m.direction).map((m) => [m.letter, m.direction!])) as Partial<Record<VariantLetter, string>>;
      directions = await this.deps.directions.runDirectionsTurn(host, missing, given);
      const svc = new VariantGroupService({ store: new CreativeStore(host.projectDir), turns: this.deps.turns });
      const now = (await svc.resolve(host)).group;
      for (const l of missing) {
        if (now?.members.find((m) => m.letter === l)?.direction) continue;
        await svc.setDirection(host, l, directions[l]!, 'agent');
      }
    }
    const out = await this.start(ref, targets, request);
    return directions ? { ...out, directions } : out;
  }

  /** Starts `request` (or the first generation when null) in each target member, at most MAX_RUNNING_VARIANTS at once. */
  async start(ref: CreativeRef, targets: VariantLetter[] | 'all-active', request: UserRequest | null): Promise<FanoutResult> {
    const { host, members, skipped } = await this.targetsOf(ref, targets);
    const { turns, queue, approvals } = this.deps;
    const out: FanoutResult = { jobs: {}, queued: [], skipped: [...skipped], failed: {} };
    const text = request?.text?.trim() ?? '';
    const pins = request?.pins ?? [];
    const message = text || pins.length ? { text, pins } : undefined;
    const idle: VariantMember[] = [];
    for (const m of members) {
      const mref = this.refFor(host, m.slug);
      if (!turns.turnActive(mref)) { idle.push(m); continue; }
      // Already working: the request waits in that variant's own queue (it starts after its turn, per Ruling U).
      if (!message) { out.skipped.push(m.letter); continue; }
      try {
        await turns.postMessage(mref, { clientId: randomUUID(), text, pins, mode: 'queued' });
        out.queued.push(m.letter);
      } catch (err) { out.failed[m.letter] = err instanceof Error ? err.message : String(err); }
    }
    const batch = idle.length >= 2 ? await this.paidBatch(host, idle) : null;
    let first: unknown = null;
    for (const m of idle) {
      try {
        const job = await turns.start(this.refFor(host, m.slug), message, request?.formats?.length ? { formats: request.formats } : {});
        out.jobs[m.letter] = job.id;
        if (batch) {
          approvals.cover(job.id, batch.rules, batch.decision);
          void queue.whenSettled(job.id).then(() => approvals.uncover(job.id));
        }
      } catch (err) {
        first ??= err;
        out.failed[m.letter] = err instanceof Error ? err.message : String(err);
      }
    }
    const ids = Object.values(out.jobs);
    if (batch) {
      // Declined, expired or cancelled: every job of the batch stops before it spends anything (its covered calls are waiting).
      void batch.decision.then((ok) => { if (!ok) for (const id of ids) stopJob({ queue, approvals }, id); });
      // Once every job of the batch is over, an undecided card has nothing left to confirm.
      void Promise.all(ids.map((id) => queue.whenSettled(id))).then(() => approvals.cancelJob(batch.id));
    }
    if (ids.length === 0 && out.queued.length === 0 && first) throw first;
    return out;
  }

  /**
   * The one confirmation of a fan-out (spec §3): the paid services each starting variant may use, as the tools would decide
   * them now, without those a project "Always" rule already allows. None (or the confirmation off): no card, and the turns'
   * paid calls go as they always do.
   */
  private async paidBatch(host: CreativeRef, members: VariantMember[]): Promise<{ id: string; rules: string[]; decision: Promise<boolean> } | null> {
    if (!(await this.deps.settings()).confirmPaidProviders) return null;
    const store = new CreativeStore(host.projectDir);
    const permissions = new PermissionsStore(host.projectDir);
    const allowed = async (rule: string) => isAllowedRule(rule) && await permissions.has(rule).catch(() => false);
    const items: NonNullable<PaidBatch['items']> = [];
    const rules = new Set<string>();
    for (const m of members) {
      const c = await store.get(m.slug);
      for (const s of await this.deps.paidPlan(c.brief.services)) {
        const open: string[] = [];
        for (const r of s.rules) if (!(await allowed(r))) open.push(r);
        if (open.length === 0) continue;
        for (const r of open) rules.add(r);
        items.push({ variant: m.letter, provider: s.provider, capability: s.kind, ...(s.kind === 'music' && c.brief.durationSec ? { seconds: c.brief.durationSec } : {}) });
      }
    }
    if (items.length === 0) return null;
    const a = t().approvals;
    const label = (i: (typeof items)[number]) => a.variantBatchItem({ letter: upper(i.variant), service: a.serviceNames[i.capability], provider: PROVIDER_LABEL[i.provider] });
    const variants = new Set(items.map((i) => i.variant)).size;
    const seconds = items.reduce((n, i) => n + (i.seconds ?? 0), 0);
    const paidBatch: PaidBatch = {
      provider: items[0]!.provider,
      calls: items.map((i) => ({ label: label(i), chars: i.chars ?? 0 })),
      items,
      total: { variants, calls: items.length, ...(seconds > 0 ? { seconds } : {}) },
    };
    const id = randomUUID();
    const list = items.slice(0, 8).map(label).join('; ') + (items.length > 8 ? '; …' : '');
    const pending = this.deps.approvals.request({
      jobId: id, projectSlug: host.projectSlug, projectDir: host.projectDir, creativeSlug: host.creativeSlug, kind: 'paid-batch',
      toolName: 'provider:variant-batch', input: {}, title: a.variantBatchTitle({ count: variants }), detail: a.variantBatchDetail({ count: items.length, list }), paidBatch,
    });
    const decision = pending.then((o) => o.decision === 'once' || o.decision === 'always', () => false);
    return { id, rules: [...rules], decision };
  }
}
