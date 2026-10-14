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
  return (
    <div ref={ref} role="group" aria-label={approval.title} className="ms-approval ms-batch" data-approval={approval.id}>
      <div className="ms-approval-head">
        <span className="ms-approval-dot" aria-hidden="true" />
        <b className="ms-approval-title">{approval.title}</b>
        {Number.isFinite(created) && Number.isFinite(ttl) && ttl > 0 && <CountdownRing createdAt={created} ttlSec={ttl} />}
      </div>
      {context && <span className="ms-approval-context">{context}</span>}
      <span className="ms-approval-text">{b.intro({ provider, count: batch.calls.length })}</span>
      <div className="ms-approval-chips">
        <Tag>{b.provider({ provider })}</Tag>
        <Tag>{b.total({ chars: formatNumber(locale, chars) })}</Tag>
        <Tag>{batch.estimate ? b.estimate({ estimate: batch.estimate }) : b.noEstimate}</Tag>
      </div>
      <ul className="ms-batch-calls" aria-label={b.calls}>
        {batch.calls.map((c, i) => (
          <li key={`${i}-${c.label}`}><span className="ms-batch-label">{c.label}</span><span className="ms-batch-chars">{b.chars({ chars: formatNumber(locale, c.chars) })}</span></li>
        ))}
      </ul>
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
