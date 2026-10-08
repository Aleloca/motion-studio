import type { FormatPreset, Pin } from '@motion-studio/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { Conversation } from '../components/Conversation.tsx';
import { BriefEditor } from '../components/BriefEditor.tsx';
import { FocusView } from '../components/FocusView.tsx';
import { ExportDialog } from '../components/ExportDialog.tsx';
import { FormatBoard } from '../components/FormatBoard.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import type { EventsState } from '../eventsReducer.ts';
import { useT } from '../i18n.tsx';
import { href } from '../routes.ts';
import { useCreative } from '../useCreative.ts';
import { Tabs } from '../ui/index.ts';

export function CreativePage({ slug, creative, live }: { slug: string; creative: string; live: EventsState }) {
  const t = useT();
  const { detail, conversation, error, reload } = useCreative(slug, creative, live.creativeTicks[`${slug}/${creative}`] ?? 0);
  const [presets, setPresets] = useState<FormatPreset[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  // Set when the user explicitly picks a version: from then on new versions no longer steal the selection.
  const [userPicked, setUserPicked] = useState(false);
  const pick = (n: number) => { setUserPicked(true); setSelected(n); };
  const [compareN, setCompareN] = useState<number | null>(null);
  const [safeZone, setSafeZone] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [pins, setPins] = useState<Pin[]>([]);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [presetsFailure, setPresetsFailure] = useState<string | null>(null);
  // Version number pinned when the export dialog opens: new live versions must not retarget it.
  const [exporting, setExporting] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'chat' | 'brief'>('chat');

  useEffect(() => { api.getFormats()
      .then((s) => { setPresets(s.presets); setCatalogError(s.error); setPresetsLoaded(true); })
      .catch((e: unknown) => { setPresetsFailure(e instanceof Error ? e.message : String(e)); setPresetsLoaded(true); });
   }, []);
  const versions = detail?.versions ?? [];
  const latest = versions.at(-1) ?? null;
  // Follow new versions automatically until the user picks one.
  useEffect(() => { if (!userPicked) setSelected(latest?.n ?? null); }, [latest?.n, userPicked]);
  const version = versions.find((v) => v.n === selected) ?? latest;
  const compare = compareN !== null && compareN !== version?.n ? versions.find((v) => v.n === compareN) ?? null : null;
  useEffect(() => { if (compareN !== null && compareN === version?.n) setCompareN(null); }, [compareN, version?.n]);
  const myApprovals = useMemo(() => Object.values(live.approvals).filter((a) => a.creativeSlug === creative && a.projectSlug === slug), [live.approvals, creative, slug]);
  const job = useMemo(() => Object.values(live.jobs).find((j) => j.key === detail?.jobKey && (j.state === 'queued' || j.state === 'running'))
    ?? Object.values(live.jobs).filter((j) => j.key === detail?.jobKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0], [live.jobs, detail?.jobKey]);
  const fileUrl = (n: number, file: string) => api.fileUrl(slug, creative, `outputs/v${n}/${file}`);
  const act = (p: Promise<unknown>) => { setActionError(null); p.then(reload).catch((e: unknown) => setActionError(e instanceof Error ? e.message : String(e))); };

  if (error) return <main className="page"><p role="alert" className="error">{error}</p></main>;
  if (!detail) return <main className="page muted">{t.common.loading}</main>;
  const c = detail.creative;
  const focusPreset = focus ? presets.find((p) => p.id === focus) : undefined;
  const outFor = (v: typeof version, id: string) => v?.outputs.find((o) => o.format === id);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 57px)' }}>
      <header className="topbar" style={{ position: 'static' }}>
        <a href={href.project(slug)} className="muted">{t.web.newCreative.back}</a>
        <strong>{c.title}</strong>
        <StatusBadge status={c.status} waiting={myApprovals.length > 0} />
        <div style={{ flex: 1 }} />
        {versions.length > 0 && (
          <div role="radiogroup" aria-label={t.web.creative.version} className="row" style={{ gap: 4 }}>
            {versions.map((v) => (
              <button key={v.n} type="button" role="radio" aria-checked={version?.n === v.n} className={version?.n === v.n ? 'primary' : ''} onClick={() => pick(v.n)}>
                v{v.n}{v.status === 'incomplete' ? ' ⚠' : ''}
              </button>
            ))}
          </div>
        )}
        {versions.length > 1 && (
          <label className="row" style={{ gap: 6 }}>{t.web.creative.compareWith}
            <select value={compare?.n ?? ''} onChange={(e) => setCompareN(e.target.value ? Number(e.target.value) : null)} style={{ minHeight: 36, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}>
              <option value="">—</option>
              {versions.filter((v) => v.n !== version?.n).map((v) => <option key={v.n} value={v.n}>v{v.n}</option>)}
            </select>
          </label>
        )}
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={safeZone} onChange={(e) => setSafeZone(e.target.checked)} style={{ width: 16, height: 16 }} />{t.web.creative.safeZone}</label>
        {version && <button type="button" onClick={() => act(api.revealVersion(slug, creative, version.n))}>{t.web.common.revealFolder}</button>}
        <button type="button" disabled={!version} onClick={() => version && setExporting(version.n)}>{t.web.creative.export}</button>
        {version && latest && version.n !== latest.n && (
          <button type="button" onClick={() => act(api.restoreVersion(slug, creative, version.n))}>{t.web.creative.restartFrom({ n: version.n })}</button>
        )}
      </header>
      {c.resumeFrom && <p className="warn" style={{ margin: 12 }}>{t.web.creative.resumeNote({ n: c.resumeFrom.version })}</p>}
      {(c.status === 'error' || c.status === 'interrupted') && c.error && <p role="alert" className="error" style={{ margin: 12 }}>{c.error}</p>}
      {version?.status === 'incomplete' && (
        <div className="warn" style={{ margin: 12 }}>
          <strong>{t.web.creative.versionIncomplete({ n: version.n })}</strong>
          <ul style={{ margin: '4px 0 0' }}>{version.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      {presetsFailure && <p role="alert" className="error" style={{ margin: 12 }}>{t.web.creative.formatsLoadFailed({ detail: presetsFailure })}</p>}
      {catalogError && <p className="warn" style={{ margin: 12 }}>{catalogError}</p>}
      {actionError && <p role="alert" className="error" style={{ margin: 12 }}>{actionError}</p>}
      <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', minHeight: 0 }}>
        <main className="dots" style={{ flex: '999 1 560px', minWidth: 0, overflow: 'auto' }}>
          <FormatBoard presets={presets} formats={presetsLoaded && !presetsFailure ? c.brief.formats : []} version={version ?? null} compare={compare} fileUrl={fileUrl} pins={pins} showSafeZone={safeZone} onOpen={setFocus} />
        </main>
        <div style={{ flex: '1 1 360px', maxWidth: 440, minWidth: 0, display: 'flex' }}>
          {/* Interim side panel until Task 12: the new Conversation plus the existing brief editor. */}
          <aside aria-label={t.web.conversation.aria} style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, background: 'var(--panel)', borderLeft: '1px solid var(--line)' }}>
            <Tabs label={t.web.conversation.panel} value={panel} onChange={setPanel}
              tabs={[{ value: 'chat', label: t.web.conversation.tabs.chat }, { value: 'brief', label: t.web.conversation.tabs.brief }]} />
            {panel === 'chat' && (
              <Conversation slug={slug} creative={creative} entries={conversation} approvals={myApprovals} job={job} live={job ? live.events[job.id] ?? [] : []}
                pins={pins} onRemovePin={(i) => setPins((p) => p.filter((_, k) => k !== i))} formatName={(id) => presets.find((p) => p.id === id)?.name ?? id}
                canGenerate={versions.length === 0} onSent={() => { setPins([]); setUserPicked(false); reload(); }} onSelectVersion={pick} snapshots={live.snapshots} />
            )}
            {/* Kept mounted while hidden, so an unsaved brief draft survives tab switches. */}
            <div hidden={panel !== 'brief'} style={{ display: panel === 'brief' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              <BriefEditor slug={slug} detail={detail} presets={presets} disabled={job?.state === 'queued' || job?.state === 'running'} onChanged={reload} />
            </div>
          </aside>
        </div>
      </div>
      {exporting !== null && <ExportDialog key={exporting} slug={slug} creative={creative} version={exporting} onClose={() => setExporting(null)} />}
      {focusPreset && (
        <FocusView preset={focusPreset}
          src={version && outFor(version, focusPreset.id) ? fileUrl(version.n, outFor(version, focusPreset.id)!.file) : null}
          compareSrc={compare ? (outFor(compare, focusPreset.id) ? fileUrl(compare.n, outFor(compare, focusPreset.id)!.file) : '') : null}
          versionN={version?.n ?? null} compareN={compare?.n ?? null}
          verified={(version && outFor(version, focusPreset.id)?.verified) !== false}
          pins={pins.filter((p) => p.format === focusPreset.id)}
          pinNumbers={pins.flatMap((p, i) => (p.format === focusPreset.id ? [i + 1] : []))}
          onAddPin={(pin) => setPins((p) => [...p, pin])} onClose={() => setFocus(null)} />
      )}
    </div>
  );
}
