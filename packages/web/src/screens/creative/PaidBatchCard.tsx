// The confirmation of several paid calls made together (Phase 12, spec §3.2): the translated voices of a localize turn. One card
// lists the provider, every call with the characters it sends, and the estimate when the provider's price is known; Approve,
// "Always" (the project's rule for that provider, when offered) and Decline. Same behaviour and look as the approval card: it
// is shown in the approvals center, in the conversation and in the Languages panel.
import type { ApprovalDecision, ApprovalRequest, ProviderId } from '@motion-studio/shared';
import { useLayoutEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api.ts';
import { ruleLabel } from '../../components/ruleLabel.ts';
import { message } from '../../errors.ts';
import { formatNumber, useLocale, useT } from '../../i18n.tsx';
import { collapse, enter, pulse } from '../../motion/index.ts';
import { Button, CountdownRing, Tag, toast } from '../../ui/index.ts';

const PROVIDER_NAME: Record<ProviderId, string> = { openai: 'OpenAI', elevenlabs: 'ElevenLabs', pexels: 'Pexels', unsplash: 'Unsplash' };
const ms = (iso: string) => new Date(iso).getTime();

export interface PaidBatchCardProps {
  approval: ApprovalRequest;
  context?: string;
  leaving?: boolean;
  onGone?(id: string): void;
}

export function PaidBatchCard({ approval, context, leaving = false, onGone }: PaidBatchCardProps) {
  const t = useT();
  const a = t.web.approvalUi;
  const b = t.web.paidBatch;
  const locale = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leavingRef = useRef(leaving);
  leavingRef.current = leaving;
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;
  const batch = approval.paidBatch;

  useLayoutEffect(() => {
    const el = ref.current;
    void enter(el, { y: 10 }).then(async () => {
      for (let i = 0; i < 2 && !leavingRef.current && el?.isConnected; i++) await pulse(el);
    });
  }, []);
  const wasLeaving = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!leaving) {
      if (wasLeaving.current) { setDecided(false); void enter(el, { y: 0, ms: 200 }); }
      wasLeaving.current = false;
      return;
    }
    wasLeaving.current = true;
    let live = true;
    void collapse(el).then((finished) => { if (finished && live && leavingRef.current) onGoneRef.current?.(approval.id); });
    return () => { live = false; };
  }, [leaving, approval.id]);

  const scope = approval.alwaysRule ? ruleLabel(approval.alwaysRule, t) : null;
  const decide = async (d: ApprovalDecision) => {
    setBusy(true); setError(null);
    try {
      await api.decideApproval(approval.id, d);
      if (d === 'always' && scope) toast.show(a.alwaysSaved({ label: scope }), { tone: 'ok' });
      setDecided(true);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? a.alreadyHandled : message(e));
    } finally { setBusy(false); }
  };

  if (!batch) return null;
  const created = ms(approval.createdAt);
  const ttl = (ms(approval.expiresAt) - created) / 1000;
  const disabled = busy || decided || leaving;
  const chars = batch.calls.reduce((n, c) => n + c.chars, 0);
  const provider = PROVIDER_NAME[batch.provider];
  // Phase 15 (decision 843): a variant run's card lists the calls per variant, may name several providers, and never shows a
  // price: the calls are an estimate and no price is known. A phase 12 batch (no `items`) is exactly as before.
  const items = batch.items;
  const providers = batch.total?.providers ?? [];
  const intro = providers.length > 1
    ? b.introMixed({ count: batch.total?.calls ?? batch.calls.length, list: providers.map((p) => `${PROVIDER_NAME[p.provider]} ${p.calls}`).join(', ') })
    : b.intro({ provider: providers.length === 1 ? PROVIDER_NAME[providers[0]!.provider] : provider, count: batch.total?.calls ?? batch.calls.length });
  return (
    <div ref={ref} role="group" aria-label={approval.title} className="ms-approval ms-batch" data-approval={approval.id}>
      <div className="ms-approval-head">
        <span className="ms-approval-dot" aria-hidden="true" />
        <b className="ms-approval-title">{approval.title}</b>
        {Number.isFinite(created) && Number.isFinite(ttl) && ttl > 0 && <CountdownRing createdAt={created} ttlSec={ttl} />}
      </div>
      {context && <span className="ms-approval-context">{context}</span>}
      <span className="ms-approval-text">{items ? intro : b.intro({ provider, count: batch.calls.length })}</span>
      <div className="ms-approval-chips">
        <Tag>{b.provider({ provider: items && providers.length > 0 ? providers.map((p) => PROVIDER_NAME[p.provider]).join(', ') : provider })}</Tag>
        {!items || chars > 0 ? <Tag>{b.total({ chars: formatNumber(locale, chars) })}</Tag> : null}
        <Tag>{items ? b.estimatedCalls : batch.estimate ? b.estimate({ estimate: batch.estimate }) : b.noEstimate}</Tag>
      </div>
      {items ? (
        <ul className="ms-batch-calls ms-batch-variants" aria-label={b.variantItems}>
          {items.map((it, i) => (
            <li key={`${i}-${it.variant}-${it.capability}`}>
              <span className="ms-batch-label">{batch.calls[i]?.label ?? `${it.variant.toUpperCase()} · ${it.capability}`}</span>
              <span className="ms-batch-chars">{it.chars ? b.chars({ chars: formatNumber(locale, it.chars) }) : it.seconds ? b.itemSeconds({ seconds: formatNumber(locale, it.seconds) }) : ''}</span>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="ms-batch-calls" aria-label={b.calls}>
          {batch.calls.map((c, i) => (
            <li key={`${i}-${c.label}`}><span className="ms-batch-label">{c.label}</span><span className="ms-batch-chars">{b.chars({ chars: formatNumber(locale, c.chars) })}</span></li>
          ))}
        </ul>
      )}
      <div className="ms-approval-actions">
        <Button size="sm" variant="ink" className="ms-grow" disabled={disabled} onClick={() => void decide('once')}>{b.approve}</Button>
        {approval.alwaysRule && <Button size="sm" variant="outline" disabled={disabled} title={approval.alwaysRule} onClick={() => void decide('always')}>{a.alwaysHere}</Button>}
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void decide('deny')}>{b.decline}</Button>
      </div>
      {scope ? <span className="ms-approval-scope">{a.alwaysScope({ label: scope })}</span> : null}
      {error && <p role="alert" className="ms-approval-error">{error}</p>}
    </div>
  );
}
