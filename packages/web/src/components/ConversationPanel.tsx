import type { AgentEvent, Brief, ConversationEntry, CreativeDetail, FormatPreset, JobSummary, Pin } from '@motion-studio/shared';
import { useState } from 'react';
import { api } from '../api.ts';
import { ExpertLine } from './AgentConsole.tsx';
import { FormatPicker } from './FormatPicker.tsx';

export interface ConversationPanelProps {
  slug: string; detail: CreativeDetail; conversation: ConversationEntry[]; presets: FormatPreset[];
  job: JobSummary | undefined; liveEvents: AgentEvent[]; expert: boolean;
  pins: Pin[]; onRemovePin(index: number): void; onSent(): void; onSelectVersion(n: number): void; onChanged(): void;
}

type Tab = 'chat' | 'brief' | 'expert';
const pinLabel = (p: Pin, k: number) => `${k + 1} · ${p.format}${p.timeSec !== null ? ` @ ${p.timeSec.toFixed(1)}s` : ''}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function BriefEditor({ slug, detail, presets, disabled, onChanged }: { slug: string; detail: CreativeDetail; presets: FormatPreset[]; disabled: boolean; onChanged(): void }) {
  const c = detail.creative;
  const [title, setTitle] = useState(c.title);
  const [brief, setBrief] = useState<Brief>(c.brief);
  const [assets, setAssets] = useState(c.brief.assets.join(', '));
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Brief>(k: K, v: Brief[K]) => setBrief((b) => ({ ...b, [k]: v }));
  const save = async (regenerate: boolean) => {
    setError(null);
    try {
      await api.updateCreative(slug, detail.slug, { title, brief: { ...brief, assets: assets.split(',').map((a) => a.trim()).filter(Boolean) } });
      if (regenerate) await api.sendCreativeTurn(slug, detail.slug, {});
      onChanged();
    } catch (e) { setError(message(e)); }
  };
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(false); }} style={{ padding: 14, overflow: 'auto' }}>
      <label htmlFor="b-title">Titolo</label><input id="b-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <label htmlFor="b-goal">Obiettivo</label><textarea id="b-goal" rows={3} value={brief.goal} onChange={(e) => set('goal', e.target.value)} />
      <label htmlFor="b-msg">Messaggio chiave</label><input id="b-msg" value={brief.message} onChange={(e) => set('message', e.target.value)} />
      <label htmlFor="b-dur">Durata (secondi, vuoto = nessuna)</label>
      <input id="b-dur" type="number" min={1} max={600} value={brief.durationSec ?? ''} onChange={(e) => set('durationSec', e.target.value ? Number(e.target.value) : null)} />
      <label htmlFor="b-assets">Asset (separati da virgola)</label><input id="b-assets" value={assets} onChange={(e) => setAssets(e.target.value)} />
      <label htmlFor="b-notes">Note</label><input id="b-notes" value={brief.notes} onChange={(e) => set('notes', e.target.value)} />
      <strong>Formati</strong>
      <FormatPicker presets={presets} selected={brief.formats} onToggle={(id) => set('formats', brief.formats.includes(id) ? brief.formats.filter((x) => x !== id) : [...brief.formats, id])} />
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
      <div className="row">
        <button type="submit" disabled={disabled}>Salva</button>
        <button type="button" className="primary" disabled={disabled} onClick={() => void save(true)}>Salva e rigenera</button>
      </div>
    </form>
  );
}

export function ConversationPanel(props: ConversationPanelProps) {
  const { slug, detail, conversation, job, liveEvents, expert, pins } = props;
  const [tab, setTab] = useState<Tab>('chat');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const active = job && (job.state === 'queued' || job.state === 'running') ? job : undefined;
  const persistedAgent = (e: ConversationEntry) => e.type === 'agent' && e.jobId !== active?.id;

  const send = async (body: { text?: string; pins?: Pin[] }) => {
    setError(null);
    try {
      await api.sendCreativeTurn(slug, detail.slug, body);
      setText('');
      props.onSent();
      props.onChanged();
    } catch (e) { setError(message(e)); }
  };

  const tabs: Array<[Tab, string]> = [['chat', 'Conversazione'], ['brief', 'Brief'], ...(expert ? [['expert', 'Esperto'] as [Tab, string]] : [])];
  const allAgentEvents = [
    ...conversation.filter((e): e is Extract<ConversationEntry, { type: 'agent' }> => persistedAgent(e)).map((e) => e.event),
    ...(active ? liveEvents : []),
  ];

  return (
    <aside aria-label="Conversazione" style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--surface)', borderLeft: '1px solid var(--border)', minHeight: 0 }}>
      <div role="tablist" aria-label="Pannello" className="tabs" style={{ padding: '0 10px' }}>
        {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}
      </div>

      {tab === 'chat' && (
        <div className="stack" style={{ flex: 1, overflow: 'auto', padding: 14, gap: 10 }}>
          {conversation.map((e, i) => {
            if (e.type === 'user') return (
              <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '88%', padding: '10px 12px', borderRadius: '14px 14px 4px 14px', background: 'var(--text)', color: 'var(--bg)' }}>
                {e.pins.length > 0 && <div className="row" style={{ gap: 4, marginBottom: 6 }}>{e.pins.map((p, k) => <span key={k} className="badge run">{pinLabel(p, k)}</span>)}</div>}
                <span style={{ whiteSpace: 'pre-wrap' }}>{e.text}</span>
              </div>
            );
            if (e.type === 'agent') return persistedAgent(e) && e.event.kind === 'text'
              ? <p key={i} style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{e.event.text}</p> : null;
            if (e.type === 'version') return (
              <div key={i} className="card row" style={{ padding: 10, background: 'var(--surface-2)' }}>
                <span className={`badge ${e.status === 'complete' ? 'ok' : 'warn-badge'}`}>v{e.n} · {e.status === 'complete' ? 'Pronta' : 'Incompleta'}</span>
                <div style={{ flex: 1 }} />
                <button type="button" onClick={() => props.onSelectVersion(e.n)}>Vedi v{e.n}</button>
              </div>
            );
            return e.level === 'error'
              ? <p key={i} role="alert" className="error" style={{ margin: 0 }}>{e.text}</p>
              : <p key={i} className="muted" style={{ margin: 0, fontSize: 13 }}>{e.text}</p>;
          })}
          {active && (
            <div className="card stack" style={{ padding: 12, gap: 6, background: 'var(--surface-2)' }}>
              <div className="row"><span className="badge run">In lavorazione</span><div style={{ flex: 1 }} /><button type="button" onClick={() => void api.cancelJob(active.id).catch((e: unknown) => setError(message(e)))}>Annulla</button></div>
              {liveEvents.filter((e) => e.kind === 'text').map((e, k) => <p key={k} style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{e.kind === 'text' ? e.text : ''}</p>)}
              {liveEvents.filter((e) => e.kind === 'tool_use').slice(-5).map((e, k) => <span key={k} className="muted" style={{ fontSize: 13 }}>Usa lo strumento {e.kind === 'tool_use' ? e.name : ''}</span>)}
            </div>
          )}
        </div>
      )}

      {tab === 'brief' && <BriefEditor slug={slug} detail={detail} presets={props.presets} disabled={Boolean(active)} onChanged={props.onChanged} />}

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
                <span key={k} className="badge run row" style={{ gap: 4 }}>{pinLabel(p, k)}
                  <button type="button" aria-label={`Rimuovi commento ${k + 1}`} onClick={() => props.onRemovePin(k)} style={{ minHeight: 20, padding: '0 6px', border: 0, background: 'transparent' }}>×</button>
                </span>
              ))}
            </div>
          )}
          <label htmlFor="cp-text" className="muted" style={{ fontSize: 12 }}>Chiedi una modifica</label>
          <textarea id="cp-text" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Es. rallenta il finale e alza la CTA nel 9:16" />
          {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
          <div className="row">
            {detail.versions.length === 0 && <button type="button" disabled={Boolean(active)} onClick={() => void send({})}>Genera</button>}
            <div style={{ flex: 1 }} />
            <button type="submit" className="primary" disabled={Boolean(active) || (!text.trim() && pins.length === 0)}>Invia</button>
          </div>
        </form>
      )}
    </aside>
  );
}
