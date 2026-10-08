import type { ApprovalDecision, ApprovalRequest, Messages } from '@motion-studio/shared';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { formatNumber, useLocale, useT } from '../i18n.tsx';
import { collapse, enter, pulse } from '../motion/index.ts';
import { Button, CountdownRing, Icon, Tag } from '../ui/index.ts';

/**
 * Lengths at which the core cuts the detail, mirrored from packages/core/src/approvals/broker.ts (`describeRequest`
 * cuts a generic tool's JSON input to 500 characters; `request` cuts every detail to 2000). At these lengths the card
 * says the text was shortened. Keep in sync with broker.ts.
 */
export const DETAIL_LIMITS = { tool: 500, any: 2000 } as const;
/** Lines that fit the command box before it scrolls (max-height in conversation.css). */
const VISIBLE_LINES = 10;

type Category = keyof Messages['web']['approvalUi']['kinds'];

/** Plain-language category of the request, from the tool the core reports (logic never reads the localized title). */
export function approvalCategory(a: Pick<ApprovalRequest, 'kind' | 'toolName'>): Category {
  if (a.kind === 'provider') return 'provider';
  if (a.toolName === 'Bash') return 'command';
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(a.toolName)) return 'edit';
  if (a.toolName === 'Read') return 'read';
  if (a.toolName === 'WebFetch') return 'web';
  return 'tool';
}

const lineCount = (s: string) => s.replace(/\n$/, '').split('\n').length;
const ms = (iso: string) => new Date(iso).getTime();

export interface ApprovalCardProps {
  approval: ApprovalRequest;
  /** Where the request comes from (project · creative), shown under the title. */
  context?: string;
  /** The request is no longer pending: the card collapses (T15) and then calls `onGone`. */
  leaving?: boolean;
  onGone?(id: string): void;
}

/**
 * Approval card (spec §6.3, T8, T15). The detail is agent-controlled text: it is rendered as plain text only, never as
 * HTML, and always in full behind "Show command" (wrapped, with its line count and visible scrolling, point 6).
 */
export function ApprovalCard({ approval, context, leaving = false, onGone }: ApprovalCardProps) {
  const t = useT();
  const a = t.web.approvalUi;
  const locale = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const cmdId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overflows, setOverflows] = useState(false);
  const leavingRef = useRef(leaving);
  leavingRef.current = leaving;
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;

  // T8: enters from below, then two halo pulses (skipped if it starts leaving meanwhile).
  useLayoutEffect(() => {
    const el = ref.current;
    void enter(el, { y: 10 }).then(async () => {
      for (let i = 0; i < 2 && !leavingRef.current && el?.isConnected; i++) await pulse(el);
    });
  }, []);

  // T15: collapse when resolved; an approval that comes back is revived (the entrance cancels the collapse).
  const wasLeaving = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!leaving) {
      if (wasLeaving.current) {
        // Pending again (e.g. the decision did not take): it can be decided anew.
        setDecided(false);
        void enter(el, { y: 0, ms: 200 });
      }
      wasLeaving.current = false;
      return;
    }
    wasLeaving.current = true;
    let live = true;
    void collapse(el).then((finished) => {
      if (finished && live && leavingRef.current) onGoneRef.current?.(approval.id);
    });
    return () => { live = false; };
  }, [leaving, approval.id]);

  // Whether the opened command box scrolls (wrapped long lines count too); the line count covers jsdom/no layout.
  useEffect(() => {
    const pre = preRef.current;
    setOverflows(Boolean(pre && pre.scrollHeight > pre.clientHeight + 1));
  }, [open, approval.detail]);

  const decide = async (d: ApprovalDecision) => {
    setBusy(true); setError(null);
    try {
      await api.decideApproval(approval.id, d);
      // The card leaves when the core confirms (approval_resolved); until then it cannot be decided twice.
      setDecided(true);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? a.alreadyHandled : e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const category = approvalCategory(approval);
  const provider = category === 'provider';
  const lines = lineCount(approval.detail);
  const created = ms(approval.createdAt);
  const ttl = (ms(approval.expiresAt) - created) / 1000;
  const limit = category === 'tool' ? DETAIL_LIMITS.tool : DETAIL_LIMITS.any;
  const disabled = busy || decided || leaving;

  return (
    <div ref={ref} role="group" aria-label={approval.title} className="ms-approval" data-approval={approval.id}>
      <div className="ms-approval-head">
        <span className="ms-approval-dot" aria-hidden="true" />
        <b className="ms-approval-title">{approval.title}</b>
        {Number.isFinite(created) && Number.isFinite(ttl) && ttl > 0 && <CountdownRing createdAt={created} ttlSec={ttl} />}
      </div>
      {context && <span className="ms-approval-context">{context}</span>}
      {provider
        ? <span className="ms-approval-text">{approval.detail}</span>
        : <span className="ms-approval-text">{a.describe[category]}</span>}
      <div className="ms-approval-chips">
        <Tag>{a.kinds[category]}</Tag>
        {!provider && approval.detail && (
          <button type="button" className="ms-chip ms-approval-toggle" aria-expanded={open} aria-controls={cmdId} onClick={() => setOpen((o) => !o)}>
            <Icon name="code" size={11} />
            {category === 'command' ? (open ? a.hideCommand : a.showCommand) : (open ? a.hideDetails : a.showDetails)}
            <span className="ms-approval-lines">{a.lines({ count: lines })}</span>
          </button>
        )}
      </div>
      {!provider && open && (
        <div id={cmdId} className="ms-approval-cmd">
          <pre ref={preRef} className="ms-approval-pre" tabIndex={0} aria-label={category === 'command' ? a.fullCommand : a.fullDetails}>{approval.detail}</pre>
          {(overflows || lines > VISIBLE_LINES) && <span className="ms-approval-note">{a.scrollMore}</span>}
          {approval.detail.length >= limit && <span className="ms-approval-note ms-warn">{a.shortened({ count: formatNumber(locale, limit) })}</span>}
          {approval.alwaysRule && <span className="ms-approval-note">{a.alwaysRule({ rule: approval.alwaysRule })}</span>}
        </div>
      )}
      <div className="ms-approval-actions">
        <Button size="sm" variant="ink" className="ms-grow" disabled={disabled} onClick={() => void decide('once')}>{provider ? a.generate : a.allow}</Button>
        {approval.alwaysRule && <Button size="sm" variant="outline" disabled={disabled} title={approval.alwaysRule} onClick={() => void decide('always')}>{a.alwaysHere}</Button>}
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void decide('deny')}>{a.deny}</Button>
      </div>
      {error && <p role="alert" className="ms-approval-error">{error}</p>}
    </div>
  );
}
