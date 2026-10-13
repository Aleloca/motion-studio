// Brief services (Phase 11, Task 7): which external services the agent may use for a creative, per kind. The same
// selector sits in the brief editor, in New creative and, behind the "Services" chip, in the chat composer. The core
// enforces the choice in every agent tool; this UI only chooses it (and disables providers without a key).
import { effectiveServices, SERVICE_CHOICES, SERVICE_KINDS, type Brief, type BriefServices, type Messages, type ProviderId, type ServiceKind } from '@motion-studio/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api.ts';
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

/** The short summary of the chip: the kinds that are not `auto` ("Voice Off · Images Stock only"), else "all auto". */
export function servicesSummary(services: BriefServices | undefined, t: Messages): string {
  const sv = t.web.services;
  const s = effectiveServices({ services });
  const parts = SERVICE_KINDS.filter((k) => s[k] !== 'auto').map((k) => sv.summaryPart({ kind: sv.kinds[k], choice: sv.choices[s[k]] }));
  return parts.length ? parts.join(' · ') : sv.summaryAuto;
}

export interface ServicesSelectorProps {
  value: BriefServices | undefined;
  onChange(next: BriefServices): void;
  /** Providers with a key (null: unknown, nothing disabled). */
  configured: ReadonlySet<ProviderId> | null;
  disabled?: boolean;
}

/** Four rows (images, voice, music, sound effects), each a segmented choice; a provider without its key is disabled with the reason. */
export function ServicesSelector({ value, onChange, configured, disabled }: ServicesSelectorProps) {
  const t = useT();
  const sv = t.web.services;
  const id = useId();
  const s = effectiveServices({ services: value });
  const unavailable = (c: Choice): string | null => {
    const needs = NEEDS[c];
    if (!needs || !configured || needs.some((p) => configured.has(p))) return null;
    return sv.needsKey({ choice: sv.choices[c], provider: c === 'stock' ? sv.stockProviders : PROVIDER_LABEL[needs[0]!] });
  };
  return (
    <div className="ms-services">
      {SERVICE_KINDS.map((kind) => {
        const choices = SERVICE_CHOICES[kind] as readonly Choice[];
        const reasons = choices.map(unavailable).filter((r): r is string => r !== null);
        const noteId = `${id}-${kind}-why`;
        return (
          <div key={kind} className="ms-services-row">
            <span className="ms-services-kind" aria-hidden="true">{sv.kinds[kind]}</span>
            <Segmented<Choice> className="ms-services-seg" label={sv.group({ kind: sv.kinds[kind] })} value={s[kind]} disabled={disabled}
              describedBy={reasons.length ? noteId : undefined}
              onChange={(c) => onChange({ ...value, [kind]: c })}
              options={choices.map((c) => {
                const why = unavailable(c);
                return { value: c, label: sv.choices[c], ...(why ? { disabled: true, title: why } : {}) };
              })} />
            {reasons.length ? <p id={noteId} className="ms-services-why">{reasons.join(' ')}</p> : null}
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
  const current = pending ?? brief.services;
  useEffect(() => { setPending(null); }, [brief]);
  const summary = servicesSummary(current, t);
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
          <ServicesSelector value={current} configured={configured} disabled={busy || saving} onChange={(next) => void save(next)} />
          <p className="ms-services-hint" role="status">{busy ? sv.busy : saving ? sv.saving : sv.nextTurn}</p>
          {error ? <p role="alert" className="ms-services-error">{error}</p> : null}
        </div>
      </Popover>
    </>
  );
}
