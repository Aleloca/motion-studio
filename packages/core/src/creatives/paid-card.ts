import { servicesForFormats, variantIndex, type BriefServices, type FormatPreset, type PaidBatch, type ProviderId, type VariantId, type WorkspaceSettings } from '@motion-studio/shared';
import type { ApprovalBroker } from '../approvals/broker.ts';
import { isAllowedRule, PermissionsStore } from '../approvals/permissions-store.ts';
import type { PaidService } from '../bridge/provider-tools.ts';
import { t } from '../i18n.ts';
import { CreativeStore } from './creative-store.ts';
import type { CreativeRef } from './creative-turns.ts';

/**
 * Phase 15 (spec §3, "Servizi a pagamento") and phase 4 of the single agent (spec §9): ONE `paid-batch` card for the work of
 * several variants, before any of it starts. Shared by the fan-out of phase 15 (`VariantFanout`) and the group turn's plan
 * (`GroupTurnService`). The card lists, per variant, the paid services its turn may use now (`paidServicePlan`: the brief's
 * choices, the keys, the key checks), narrowed to what the formats it works on can use (decision 1125), without those a
 * project "Always" rule already allows.
 */

export interface PaidCardDeps {
  settings: () => Promise<WorkspaceSettings>;
  /** The paid services a turn under the brief's services may use now (`paidServicePlan`). */
  paidPlan: (services?: BriefServices) => Promise<PaidService[]>;
  presets: () => Promise<FormatPreset[]>;
}

export interface PaidPlan {
  items: NonNullable<PaidBatch['items']>;
  rules: string[];
  /** The rules still open per variant, to recompute `rules` for the variants that really start. */
  byVariant: Partial<Record<VariantId, string[]>>;
}

/** One variant of the card: its member's creative and the formats its work targets (absent: every format of its brief). */
export interface PaidTarget { letter: VariantId; slug: string; formats?: string[] }

const PROVIDER_LABEL: Record<ProviderId, string> = { openai: 'OpenAI', elevenlabs: 'ElevenLabs', pexels: 'Pexels', unsplash: 'Unsplash' };
const upper = (l: VariantId) => l.toUpperCase();

/** The card's items, or null (no card: the confirmation is off or nothing paid can be called). */
export async function paidCardPlan(deps: PaidCardDeps, host: CreativeRef, targets: readonly PaidTarget[]): Promise<PaidPlan | null> {
  if (!(await deps.settings()).confirmPaidProviders) return null;
  const store = new CreativeStore(host.projectDir);
  const permissions = new PermissionsStore(host.projectDir);
  const allowed = async (rule: string) => isAllowedRule(rule) && await permissions.has(rule).catch(() => false);
  const items: PaidPlan['items'] = [];
  const rules = new Set<string>();
  const byVariant: PaidPlan['byVariant'] = {};
  const presets = await deps.presets();
  for (const m of [...targets].sort((a, b) => variantIndex(a.letter) - variantIndex(b.letter))) {
    const c = await store.get(m.slug);
    // Decision 1125: only what the formats can use (no voice for a still image, no raster images for an identity pack);
    // phase 4 of the single agent: the formats this variant's work targets, when it names some.
    const formats = m.formats?.length ? c.brief.formats.filter((f) => m.formats!.includes(f)) : c.brief.formats;
    for (const s of await deps.paidPlan(servicesForFormats(c.brief.services, formats.length ? formats : c.brief.formats, presets))) {
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

/** `plan` for the variants in `letters` only (those whose work really starts); null when none is left. */
export function planFor(plan: PaidPlan, letters: ReadonlySet<VariantId>): PaidPlan | null {
  const items = plan.items.filter((i) => letters.has(i.variant));
  if (items.length === 0) return null;
  return { ...plan, items, rules: [...new Set([...letters].flatMap((l) => plan.byVariant[l] ?? []))] };
}

/**
 * Shows the card under job `jobId` (its approvals: Stop on that job cancels it) and waits for it: approved, declined, expired
 * or cancelled (the card went away without an answer).
 */
export async function askPaidCard(approvals: ApprovalBroker, host: CreativeRef, plan: PaidPlan, jobId: string): Promise<'approved' | 'declined' | 'expired' | 'cancelled'> {
  const a = t().approvals;
  const { items } = plan;
  const label = (i: (typeof items)[number]) => a.variantBatchItem({ letter: upper(i.variant), service: a.serviceNames[i.capability], provider: PROVIDER_LABEL[i.provider] });
  const variants = [...new Set(items.map((i) => i.variant))];
  const providers = [...new Set(items.map((i) => i.provider))].map((p) => ({ provider: p, calls: items.filter((i) => i.provider === p).length }));
  const seconds = items.reduce((n, i) => n + (i.seconds ?? 0), 0);
  const paidBatch: PaidBatch = {
    // Today's card names one provider: the one with the most calls (`total.providers` lists them all).
    provider: [...providers].sort((x, y) => y.calls - x.calls)[0]!.provider,
    calls: items.map((i) => ({ label: label(i), chars: i.chars ?? 0 })),
    items,
    total: { variants: variants.length, calls: items.length, providers, ...(seconds > 0 ? { seconds } : {}) },
  };
  const detail = a.variantBatchDetail({
    providers: providers.map((p) => `${PROVIDER_LABEL[p.provider]} ${p.calls}`).join(', '),
    variants: variants.map((v) => `${upper(v)} ${items.filter((i) => i.variant === v).length}`).join(', '),
  });
  const o = await approvals.request({
    jobId, projectSlug: host.projectSlug, projectDir: host.projectDir, creativeSlug: host.creativeSlug, kind: 'paid-batch',
    toolName: 'provider:variant-batch', input: {}, title: a.variantBatchTitle({ count: variants.length }), detail, paidBatch,
  });
  if (o.decision === 'once' || o.decision === 'always') return 'approved';
  return o.decision === 'deny' ? 'declined' : o.decision;
}
