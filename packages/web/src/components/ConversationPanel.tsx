import type { AgentEvent, ApprovalRequest, Locale, Messages, ConversationEntry, CreativeDetail, FormatPreset, JobSummary, Pin } from '@motion-studio/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { formatNumber, useLocale, useT } from '../i18n.tsx';
import { ApprovalCard } from './ApprovalCard.tsx';
import { ExpertLine } from './AgentConsole.tsx';
import { BriefEditor } from './BriefEditor.tsx';
import { mergeJobEvents } from './Conversation.tsx';

export interface ConversationPanelProps {
  slug: string; detail: CreativeDetail; conversation: ConversationEntry[]; presets: FormatPreset[];
  job: JobSummary | undefined; liveEvents: AgentEvent[]; expert: boolean;
  approvals: ApprovalRequest[]; pins: Pin[]; onRemovePin(index: number): void; onSent(): void; onSelectVersion(n: number): void; onChanged(): void;
}

type Tab = 'chat' | 'brief' | 'expert';
const pinLabel = (p: Pin, k: number, t: Messages, locale: Locale) =>
  `${k + 1} · ${p.format}${p.timeSec !== null ? ` ${t.web.conversation.atSeconds({ time: formatNumber(locale, p.timeSec, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}` : ''}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// One implementation, in Conversation.tsx; re-exported for this panel's tests until Task 16 removes the panel.
export { mergeJobEvents };

export function ConversationPanel(props: ConversationPanelProps) {
  const t = useT();
  const locale = useLocale();
  const { slug, detail, conversation, job, liveEvents, expert, pins } = props;
  const [selectedTab, setTab] = useState<Tab>('chat');
  // The expert tab disappears when expert mode is turned off: fall back to the conversation.
  const tab: Tab = selectedTab === 'expert' && !expert ? 'chat' : selectedTab;
  useEffect(() => { if (!expert) setTab((t) => (t === 'expert' ? 'chat' : t)); }, [expert]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const active = job && (job.state === 'queued' || job.state === 'running') ? job : undefined;
  const jobApprovals = active ? props.approvals.filter((a) => a.jobId === active.id) : [];
  const persistedAgent = (e: ConversationEntry) => e.type === 'agent' && e.jobId !== active?.id;
  const activeEvents = useMemo(() => (active
    ? mergeJobEvents(conversation.flatMap((e) => (e.type === 'agent' && e.jobId === active.id ? [e.event] : [])), liveEvents)
    : []), [active, conversation, liveEvents]);

  const send = async (body: { text?: string; pins?: Pin[] }) => {
    setError(null);
    try {
      await api.sendCreativeTurn(slug, detail.slug, body);
      setText('');
      props.onSent();
      props.onChanged();
    } catch (e) { setError(message(e)); }
  };

  const tabs: Tab[] = expert ? ['chat', 'brief', 'expert'] : ['chat', 'brief'];
  const allAgentEvents = [
    ...conversation.filter((e): e is Extract<ConversationEntry, { type: 'agent' }> => persistedAgent(e)).map((e) => e.event),
    ...activeEvents,
  ];

  return (
    <aside aria-label={t.web.conversation.aria} style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--surface)', borderLeft: '1px solid var(--border)', minHeight: 0 }}>
      <div role="tablist" aria-label={t.web.conversation.panel} className="tabs" style={{ padding: '0 10px' }}>
        {tabs.map((id) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{t.web.conversation.tabs[id]}</button>)}
      </div>

      {tab === 'chat' && (
        <div className="stack" style={{ flex: 1, overflow: 'auto', padding: 14, gap: 10 }}>
          {conversation.map((e, i) => {
            if (e.type === 'user') return (
              <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '88%', padding: '10px 12px', borderRadius: '14px 14px 4px 14px', background: 'var(--text)', color: 'var(--bg)' }}>
                {e.pins.length > 0 && <div className="row" style={{ gap: 4, marginBottom: 6 }}>{e.pins.map((p, k) => <span key={k} className="badge run">{pinLabel(p, k, t, locale)}</span>)}</div>}
                <span style={{ whiteSpace: 'pre-wrap' }}>{e.text}</span>
              </div>
            );
            if (e.type === 'agent') return persistedAgent(e) && e.event.kind === 'text'
              ? <p key={i} style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{e.event.text}</p> : null;
            if (e.type === 'version') return (
              <div key={i} className="card row" style={{ padding: 10, background: 'var(--surface-2)' }}>
                <span className={`badge ${e.status === 'complete' ? 'ok' : 'warn-badge'}`}>v{e.n} · {e.status === 'complete' ? t.web.status.ready : t.web.status.incomplete}</span>
                <div style={{ flex: 1 }} />
                <button type="button" onClick={() => props.onSelectVersion(e.n)}>{t.web.conversation.viewVersion({ n: e.n })}</button>
              </div>
            );
            return e.level === 'error'
              ? <p key={i} role="alert" className="error" style={{ margin: 0 }}>{e.text}</p>
              : <p key={i} className="muted" style={{ margin: 0, fontSize: 13 }}>{e.text}</p>;
          })}
          {active && (
            <div className="card stack" style={{ padding: 12, gap: 6, background: 'var(--surface-2)' }}>
              <div className="row"><span className={`badge ${jobApprovals.length > 0 ? 'warn-badge' : 'run'}`}>{jobApprovals.length > 0 ? t.web.conversation.waitingApproval : active.state === 'queued' ? t.web.jobState.queued : t.web.jobState.running}</span><div style={{ flex: 1 }} /><button type="button" onClick={() => void api.cancelJob(active.id).catch((e: unknown) => setError(message(e)))}>{t.common.cancel}</button></div>
              {jobApprovals.map((a) => <ApprovalCard key={a.id} approval={a} />)}
              {activeEvents.filter((e) => e.kind === 'text').map((e, k) => <p key={k} style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{e.kind === 'text' ? e.text : ''}</p>)}
              {activeEvents.filter((e) => e.kind === 'progress').slice(-5).map((e, k) => <span key={k} className="muted" style={{ fontSize: 13 }}>→ {e.kind === 'progress' ? e.text : ''}</span>)}
              {activeEvents.filter((e) => e.kind === 'tool_use').slice(-5).map((e, k) => <span key={k} className="muted" style={{ fontSize: 13 }}>{e.kind === 'tool_use' ? t.web.usesTool({ name: e.name }) : ''}</span>)}
            </div>
          )}
        </div>
      )}

      {/* Kept mounted while hidden, so an unsaved brief draft survives tab switches. */}
      <div hidden={tab !== 'brief'} style={{ display: tab === 'brief' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <BriefEditor slug={slug} detail={detail} presets={props.presets} disabled={Boolean(active)} onChanged={props.onChanged} />
      </div>

      {tab === 'expert' && (
        <div className="mono stack" style={{ flex: 1, overflow: 'auto', padding: 14, gap: 4 }}>
          {allAgentEvents.map((e, i) => <ExpertLine key={i} e={e} />)}
        </div>
      )}

      {tab === 'chat' && (
        <form className="stack" style={{ padding: 12, borderTop: '1px solid var(--border)', gap: 8 }} onSubmit={(e) => { e.preventDefault(); void send({ text: text.trim(), pins }); }}>
          {pins.length > 0 && (
            <div className="row" style={{ gap: 4 }}>
              {pins.map((p, k) => (
                <span key={k} className="badge run row" style={{ gap: 4 }}>{pinLabel(p, k, t, locale)}
                  <button type="button" aria-label={t.web.conversation.removeComment({ n: k + 1 })} onClick={() => props.onRemovePin(k)} style={{ minHeight: 20, padding: '0 6px', border: 0, background: 'transparent' }}>×</button>
                </span>
              ))}
            </div>
          )}
          <label htmlFor="cp-text" className="muted" style={{ fontSize: 12 }}>{t.web.conversation.requestChange}</label>
          <textarea id="cp-text" rows={2} maxLength={10_000} value={text} onChange={(e) => setText(e.target.value)} placeholder={t.web.conversation.changePlaceholder} />
          {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
          <div className="row">
            {detail.versions.length === 0 && <button type="button" disabled={Boolean(active)} onClick={() => void send({})}>{t.web.newCreative.generate}</button>}
            <div style={{ flex: 1 }} />
            <button type="submit" className="primary" disabled={Boolean(active) || (!text.trim() && pins.length === 0)}>{t.web.common.send}</button>
          </div>
        </form>
      )}
    </aside>
  );
}
