// Brief services (Phase 11, Task 7): which external services the agent may use for a creative, per kind. The same
// selector sits in the brief editor, in New creative and, behind the "Services" chip, in the chat composer. The core
// enforces the choice in every agent tool; this UI only chooses it (and disables providers without a key).
import { effectiveServices, missingCapability, SERVICE_CHOICES, SERVICE_KINDS, serviceCapability, type Brief, type BriefServices, type KeyCheckResult, type Messages, type ProviderId, type ServiceKind } from '@motion-studio/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api.ts';
import { href } from '../routes.ts';
import { message } from '../errors.ts';
import { useT } from '../i18n.tsx';
import { Button, Icon, Popover, Segmented } from '../ui/index.ts';
import './services.css';

type Choice = (typeof SERVICE_CHOICES)[ServiceKind][number];
/** The keys a choice needs (stock: either stock provider). */
const NEEDS: Partial<Record<Choice, ProviderId[]>> = { openai: ['openai'], elevenlabs: ['elevenlabs'], stock: ['pexels', 'unsplash'] };
const PROVIDER_LABEL: Record<ProviderId, string> = { openai: 'OpenAI', elevenlabs: 'ElevenLabs', pexels: 'Pexels', unsplash: 'Unsplash' };

/**
 * The providers whose key is set, read once; null while loading or when the list cannot be read (then nothing is
 * disabled: the core still refuses a provider without its key).
 */
export function useConfiguredProviders(): ReadonlySet<ProviderId> | null {
  const [configured, setConfigured] = useState<ReadonlySet<ProviderId> | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getSecrets())
      .then((list) => { if (alive) setConfigured(new Set(list.filter((s) => s.configured).map((s) => s.provider))); })
      .catch(() => { /* unknown: nothing disabled */ });
    return () => { alive = false; };
  }, []);
  return configured;
}

/** What the core knows about each key (checks and real calls), keyed by provider. */
export type KeyChecks = Partial<Record<ProviderId, KeyCheckResult | null>>;

/**
 * What the core knows about the keys, read once; null while loading or when it cannot be read (then nothing more is
 * disabled than the providers without a key). F5: a capability checked `missing` makes its provider unavailable.
 */
export function useKeyChecks(): KeyChecks | null {
  const [checks, setChecks] = useState<KeyChecks | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getKeyChecks())
      .then((x) => { if (alive) setChecks(x); })
      .catch(() => { /* unknown: nothing more disabled */ });
    return () => { alive = false; };
  }, []);
  return checks;
}

/** The providers `auto` can use per kind (stock is a tool choice, not one `auto` picks for generation). */
const AUTO_PROVIDERS: Record<ServiceKind, ProviderId[]> = { images: ['openai'], voice: ['openai', 'elevenlabs'], music: ['elevenlabs'], sfx: ['elevenlabs'] };

/**
 * The providers `auto` skips for a kind because the key checks know the key lacks the capability (F5, fix round 2): their
 * key is set (or unknown), but the capability is `missing`. Empty when nothing is known.
 */
export function autoSkipped(kind: ServiceKind, configured: ReadonlySet<ProviderId> | null, checks: KeyChecks | null | undefined): Array<{ provider: ProviderId; permission?: string }> {
  return AUTO_PROVIDERS[kind].flatMap((p) => {
    if (configured && !configured.has(p)) return [];
    const m = missingCapability(checks?.[p], serviceCapability(kind, p));
    return m ? [{ provider: p, ...(m.permission ? { permission: m.permission } : {}) }] : [];
  });
}

/** The short summary of the chip: the kinds that are not `auto` ("Voice Off · Images Stock only"), else "all auto". */
export function servicesSummary(services: BriefServices | undefined, t: Messages, skipped?: (kind: ServiceKind) => Array<{ provider: ProviderId }>): string {
  const sv = t.web.services;
  const s = effectiveServices({ services });
  const parts = SERVICE_KINDS.filter((k) => s[k] !== 'auto').map((k) => sv.summaryPart({ kind: sv.kinds[k], choice: sv.choices[s[k]] }));
  // Under auto, a provider skipped for a missing permission is said on the chip too (the selector says why).
  const skips = skipped ? SERVICE_KINDS.filter((k) => s[k] === 'auto').flatMap((k) => skipped(k).map((x) => sv.summarySkipped({ kind: sv.kinds[k], provider: PROVIDER_LABEL[x.provider] }))) : [];
  const all = [...parts, ...skips];
  return all.length ? all.join(' · ') : sv.summaryAuto;
}

export interface ServicesSelectorProps {
  value: BriefServices | undefined;
  onChange(next: BriefServices): void;
  /** Providers with a key (null: unknown, nothing disabled). */
  configured: ReadonlySet<ProviderId> | null;
  /** What is known about the keys (absent or null: unknown): a capability checked `missing` disables its provider (F5). */
  checks?: KeyChecks | null;
  disabled?: boolean;
}

/**
 * Four rows (images, voice, music, sound effects), each a segmented choice. A provider is disabled with the reason when it
 * has no key, or when the key check found the capability `missing` (F5); `unverified` and `error` stay available.
 */
export function ServicesSelector({ value, onChange, configured, checks, disabled }: ServicesSelectorProps) {
  const t = useT();
  const sv = t.web.services;
  const id = useId();
  const s = effectiveServices({ services: value });
  const unavailable = (kind: ServiceKind, c: Choice): string | null => {
    const needs = NEEDS[c];
    if (!needs) return null;
    const provider = c === 'stock' ? sv.stockProviders : PROVIDER_LABEL[needs[0]!];
    const keyed = configured ? needs.filter((p) => configured.has(p)) : needs;
    if (configured && keyed.length === 0) return sv.needsKey({ choice: sv.choices[c], provider });
    // With a key: usable unless what is known says every keyed provider lacks the capability.
    const missing = keyed.map((p) => missingCapability(checks?.[p], serviceCapability(kind, p)));
    if (missing.some((m) => m === null)) return null;
    const permissions = [...new Set(missing.flatMap((m) => (m?.permission ? [m.permission] : [])))];
    return permissions.length
      ? sv.missingPermission({ choice: sv.choices[c], provider, permission: permissions.join(', ') })
      : sv.keyRefused({ choice: sv.choices[c], provider });
  };
  return (
    <div className="ms-services">
      {SERVICE_KINDS.map((kind) => {
        const choices = SERVICE_CHOICES[kind] as readonly Choice[];
        const reasons = choices.map((c) => unavailable(kind, c)).filter((r): r is string => r !== null);
        // Under auto, say which provider it skips for a missing permission, and where to fix it (fix round 2).
        const skipped = s[kind] === 'auto' ? autoSkipped(kind, configured, checks) : [];
        const noteId = `${id}-${kind}-why`;
        return (
          <div key={kind} className="ms-services-row">
            <span className="ms-services-kind" aria-hidden="true">{sv.kinds[kind]}</span>
            <Segmented<Choice> className="ms-services-seg" label={sv.group({ kind: sv.kinds[kind] })} value={s[kind]} disabled={disabled}
              describedBy={reasons.length || skipped.length ? noteId : undefined}
              onChange={(c) => onChange({ ...value, [kind]: c })}
              options={choices.map((c) => {
                const why = unavailable(kind, c);
                return { value: c, label: sv.choices[c], ...(why ? { disabled: true, title: why } : {}) };
              })} />
            {reasons.length || skipped.length ? (
              <p id={noteId} className="ms-services-why">
                {skipped.map((x) => sv.autoSkipped({ kind: sv.kinds[kind], provider: PROVIDER_LABEL[x.provider], why: x.permission ? sv.whyPermission({ permission: x.permission }) : sv.whyKeyRefused })).join(' ')}
                {skipped.length ? <> <a href={href.settings('paid')}>{sv.testInSettings}</a> </> : null}
                {choices.filter((c) => !skipped.some((x) => x.provider === c)).map((c) => unavailable(kind, c)).filter((r): r is string => r !== null).join(' ')}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The composer's "Services" chip: a compact summary that opens the selector in a popover. Each change saves the brief at
 * once (a normal brief update, so a commit) and applies from the next message. Off while a turn runs (the core refuses
 * brief changes then).
 */
export function ServicesChip({ slug, creative, brief, busy, onSaved }: { slug: string; creative: string; brief: Brief; busy: boolean; onSaved(): void }) {
  const t = useT();
  const sv = t.web.services;
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown at once while the save runs; the brief from the server wins as soon as it arrives.
  const [pending, setPending] = useState<BriefServices | null>(null);
  const configured = useConfiguredProviders();
  const checks = useKeyChecks();
  const current = pending ?? brief.services;
  useEffect(() => { setPending(null); }, [brief]);
  const summary = servicesSummary(current, t, (k) => autoSkipped(k, configured, checks));
  const save = async (services: BriefServices) => {
    setError(null); setSaving(true); setPending(services);
    try {
      await api.updateCreative(slug, creative, { brief: { ...brief, services } });
      onSaved();
    } catch (e) {
      setPending(null);
      setError(sv.saveFailed({ detail: message(e) }));
    } finally { setSaving(false); }
  };
  return (
    <>
      <Button ref={anchor} size="sm" variant="ghost" className="ms-services-chip" aria-haspopup="dialog" aria-expanded={open}
        aria-label={sv.chipAria({ summary })} title={busy ? sv.busy : undefined} onClick={() => setOpen((o) => !o)}>
        <Icon name="key" size={12} /><span>{sv.chip}</span><span className="ms-services-chip-sum">{summary}</span>
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="top-start" width={420} label={sv.title}>
        <div className="ms-services-pop">
          <b>{sv.title}</b>
          <p className="ms-services-hint">{sv.hint}</p>
          <ServicesSelector value={current} configured={configured} checks={checks} disabled={busy || saving} onChange={(next) => void save(next)} />
          <p className="ms-services-hint" role="status">{busy ? sv.busy : saving ? sv.saving : sv.nextTurn}</p>
          {error ? <p role="alert" className="ms-services-error">{error}</p> : null}
        </div>
      </Popover>
    </>
  );
}
