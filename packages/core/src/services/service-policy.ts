// Brief services → the provider an agent tool may use (Phase 11, Task 7). The core decides, never the agent: a kind turned
// off is refused before any confirmation or request, a provider the brief names wins over the one the agent asked for,
// and a named provider without its key is refused (never a silent switch to another one). `auto` is the behaviour from
// before briefs had services. The Generate dialog (a direct user action) does not go through here (decisions log 293).
import { effectiveServices, type BriefServices, type ProviderId, type ServiceKind } from '@motion-studio/shared';
import { t } from '../i18n.ts';

export type ServiceDecision =
  | { ok: true; provider: string }
  | { ok: false; reason: 'disabled' | 'noKey'; messageKey: string }
  /** F5: the provider's key is known to lack this kind's capability (the permission to enable; none: the key is refused). */
  | { ok: false; reason: 'missingPermission'; messageKey: string; provider: ProviderId; permission?: string };

/** Per provider, what the key checks know against this kind's capability (`missingCapability`); absent: nothing. */
export type MissingCapabilities = ReadonlyMap<ProviderId, { permission?: string }>;

/** The providers an agent tool can name per kind (images: `stock` stands for the stock tools, which pick Pexels or Unsplash). */
const PROVIDERS: Record<ServiceKind, readonly string[]> = {
  images: ['openai', 'stock'], voice: ['openai', 'elevenlabs'], music: ['elevenlabs'], sfx: ['elevenlabs'],
};
/** `auto` with no provider asked: the first one with a key, else the first one (whose missing key the tool then reports, as before). */
const AUTO_ORDER: Record<ServiceKind, readonly ProviderId[]> = {
  images: ['openai'], voice: ['openai', 'elevenlabs'], music: ['elevenlabs'], sfx: ['elevenlabs'],
};

const OFF: ServiceDecision = { ok: false, reason: 'disabled', messageKey: 'providers.serviceOff' };
const STOCK_ONLY: ServiceDecision = { ok: false, reason: 'disabled', messageKey: 'providers.serviceStockOnly' };
const NO_KEY: ServiceDecision = { ok: false, reason: 'noKey', messageKey: 'providers.serviceNoKey' };
const MISSING = (provider: ProviderId, m: { permission?: string }): ServiceDecision =>
  ({ ok: false, reason: 'missingPermission', messageKey: 'providers.serviceMissingPermission', provider, ...(m.permission ? { permission: m.permission } : {}) });

/**
 * What an agent tool of `kind` may use under the brief's `services` (absent: all `auto`). `requested` is the provider the
 * tool call named (undefined: none; for images, `stock` from the stock tools); one the kind does not know counts as none.
 * `configured` is the set of providers whose key is in the vault.
 */
export function resolveService(services: BriefServices | undefined, kind: ServiceKind, requested: string | undefined, configured: ReadonlySet<ProviderId>, missing: MissingCapabilities = new Map()): ServiceDecision {
  const choice = effectiveServices({ services })[kind];
  const asked = requested !== undefined && PROVIDERS[kind].includes(requested) ? requested : undefined;
  // F5: a configured provider whose capability is known `missing` is unavailable (`unverified` and `error` stay usable).
  const blocked = (p: ProviderId) => (configured.has(p) ? missing.get(p) : undefined);
  if (choice === 'none') return OFF;
  // The stock tools are free: allowed under every images choice but `none`.
  if (kind === 'images' && asked === 'stock') return { ok: true, provider: 'stock' };
  if (choice === 'stock') return STOCK_ONLY; // only images offer it
  if (choice === 'auto') {
    if (asked) {
      const m = blocked(asked as ProviderId);
      return m ? MISSING(asked as ProviderId, m) : { ok: true, provider: asked };
    }
    const order = AUTO_ORDER[kind];
    const usable = order.find((p) => configured.has(p) && !blocked(p));
    if (usable) return { ok: true, provider: usable };
    // Keys set, but each one known to lack the capability: refused with the first one's reason, before any confirmation.
    const first = order.find((p) => configured.has(p));
    if (first) return MISSING(first, blocked(first)!);
    return { ok: true, provider: order[0]! };
  }
  if (!configured.has(choice)) return NO_KEY;
  const m = blocked(choice);
  return m ? MISSING(choice, m) : { ok: true, provider: choice };
}

const LABEL: Record<string, string> = { openai: 'OpenAI', elevenlabs: 'ElevenLabs', pexels: 'Pexels', unsplash: 'Unsplash', stock: 'stock only', auto: 'auto', none: 'none' };

/** The prompt line (agent English): `Services for this creative: images stock only; voice ElevenLabs; music none; sound effects auto.` */
export function servicesLine(services: BriefServices | undefined): string {
  const s = effectiveServices({ services });
  return `Services for this creative: images ${LABEL[s.images]}; voice ${LABEL[s.voice]}; music ${LABEL[s.music]}; sound effects ${LABEL[s.sfx]}.`;
}

/** The translated text of a refusal (in the core's language), for the tool result the agent reads. */
export function refusalText(d: Extract<ServiceDecision, { ok: false }>, kind: ServiceKind, services: BriefServices | undefined): string {
  const p = t().providers;
  if (d.messageKey === 'providers.serviceStockOnly') return p.serviceStockOnly;
  if (d.reason === 'missingPermission') {
    return p.serviceMissingPermission({ service: p.serviceFor[kind], provider: LABEL[d.provider] ?? d.provider, permission: d.permission ?? null });
  }
  if (d.messageKey === 'providers.serviceNoKey') return p.serviceNoKey({ service: p.serviceFor[kind], provider: LABEL[effectiveServices({ services })[kind]] ?? '' });
  return p.serviceOff[kind];
}

/** The note a tool result carries when the brief's provider replaced the one the agent asked for. */
export function overrideNote(kind: ServiceKind, requested: string, provider: string): string {
  return t().providers.serviceOverridden({ service: t().providers.serviceFor[kind], provider: LABEL[provider] ?? provider, requested: LABEL[requested] ?? requested });
}

/** Whether the brief turns a kind off for the agent (prompt and tool list). */
export function serviceOff(services: BriefServices | undefined, kind: ServiceKind): boolean {
  return effectiveServices({ services })[kind] === 'none';
}
