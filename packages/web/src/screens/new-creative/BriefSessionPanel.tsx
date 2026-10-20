import type { AssetEntry, BriefContext, BriefField, BriefForm, JobSummary, QueuedRequest } from '@motion-studio/shared';
import { useMemo, useRef, useState, type Ref } from 'react';
import { api } from '../../api.ts';
import { Conversation, type ConversationTransport } from '../../components/Conversation.tsx';
import { message as errText } from '../../errors.ts';
import type { EventsState } from '../../eventsReducer.ts';
import { useT } from '../../i18n.tsx';
import { desktop } from '../../desktop.ts';
import { Button, Icon, Input, Pill, cx } from '../../ui/index.ts';
import { AddContextMenu, ContextPins, ContextRow, folderProblem, type ContextPin } from './BriefContext.tsx';
import { LibraryPicker, assetPath } from './LibraryPicker.tsx';
import type { BriefSession } from './useBriefSession.ts';
import './briefsession.css';

export interface BriefSessionPanelProps {
  slug: string;
  projectName: string;
  brief: BriefSession;
  live: EventsState | undefined;
  /** The form as it is now, the fields the user owns and the revision the form adopted (sent with every message). */
  snapshot(): { form: BriefForm; userEdited: BriefField[]; baseRevision: number };
  /** Whether the core took the form a message carried (its edits are then answered, as by a save). */
  onCarried?(ok: boolean): void;
  /** Text put in the composer once per nonce ("Fallo compilare all'agente"). */
  draft?: { text: string; nonce: number };
  library: { value: AssetEntry[] | null; error: string | null };
  onRetryLibrary(): void;
  /** An upload added files to the library (the form reloads it). */
  onLibraryChanged(): void;
  /** Closed ("Compila tu"): kept mounted (the chat keeps its state) but hidden from everyone. */
  hidden?: boolean;
  panelRef?: Ref<HTMLElement>;
  className?: string;
  /** Opens a creative the session half moved into (decision 1423, `handedOffTo`). */
  onOpenCreative?(creative: string): void;
}

const ACTIVE = new Set<JobSummary['state']>(['queued', 'running']);

/**
 * Decisions 1412–1414: the brief session as a floating glass card: a header with its state, the session's chat
 * (`<Conversation>` with the brief's transport), the "+" menu and the pins inside the composer, the context row below.
 */
export function BriefSessionPanel({ slug, projectName, brief, live, snapshot, onCarried, draft, library, onRetryLibrary, onLibraryChanged, hidden, panelRef, className, onOpenCreative }: BriefSessionPanelProps) {
  const t = useT();
  const b = t.web.briefSession;
  const [pins, setPins] = useState<ContextPin[]>([]);
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderPath, setFolderPath] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerAnchor = useRef<HTMLElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const session = brief.session;
  const job = brief.job;
  const working = Boolean(job && ACTIVE.has(job.state));
  const asked = brief.entries.some((e) => e.type === 'user');
  const state = working ? b.state.working : (session?.agentFields.length ?? 0) > 0 ? b.state.filled : b.state.new;

  const addPin = (pin: ContextPin) => setPins((list) => (list.some((p) => p.kind === pin.kind && p.path === pin.path) ? list : [...list, pin]));
  const removePin = (pin: ContextPin) => setPins((list) => list.filter((p) => !(p.kind === pin.kind && p.path === pin.path)));
  const linkFolder = (raw: string) => {
    const path = raw.trim();
    const why = folderProblem(path, t);
    if (why) { setProblem(why); return false; }
    setProblem(null);
    addPin({ kind: 'folder', path });
    return true;
  };
  const onFolder = async () => {
    const bridge = desktop();
    if (!bridge) { setFolderOpen(true); setProblem(null); return; }
    try { const picked = await bridge.pickFolder(b.folder.title); if (picked) linkFolder(picked); }
    catch (e) { setProblem(errText(e)); }
  };
  const onUpload = async (files: File[]) => {
    if (files.length === 0) return;
    setProblem(null);
    try {
      const r = await api.uploadFiles(slug, 'assets', files);
      for (const a of r.assets ?? []) addPin({ kind: 'asset', path: assetPath(a.file) });
      onLibraryChanged();
    } catch (e) { setProblem(b.uploadFailed({ detail: errText(e) })); }
  };

  /** The session's context with this message's pins added (a pin already in the context adds nothing). */
  const contextWith = (base: BriefContext, list: readonly ContextPin[]): { context: BriefContext; added: boolean } => {
    const codebases = [...base.codebases];
    const assets = [...base.assets];
    for (const p of list) {
      if (p.kind === 'folder' && !codebases.some((c) => c.path === p.path)) codebases.push({ path: p.path });
      if (p.kind === 'asset' && !assets.includes(p.path)) assets.push(p.path);
    }
    return { context: { codebases, assets }, added: codebases.length > base.codebases.length || assets.length > base.assets.length };
  };
  // The pins go with the message; they leave the composer only once the core took it (kept on a refusal).
  const transport = useMemo<ConversationTransport>(() => ({
    start: async ({ clientId, text }) => {
      const now = snapshot();
      const had = brief.session;
      try {
        const view = await brief.ensure({ form: now.form, userEdited: now.userEdited });
        const sent = pinsRef.current;
        const r = await brief.send({ clientId, text, context: contextWith(view.context, sent).context, form: now.form, userEdited: now.userEdited, baseRevision: had ? now.baseRevision : view.revision }, view.id);
        onCarried?.(true);
        setPins((list) => list.filter((p) => !sent.includes(p)));
        return r.outcome === 'started' ? r.job : null;
      } catch (e) { onCarried?.(false); throw e; }
    },
    post: async ({ clientId, text, mode }) => {
      const now = snapshot();
      const view = brief.session;
      if (!view) throw new Error(t.errors.briefSessionGone);
      const sent = pinsRef.current;
      let r;
      try {
        r = await brief.send({ clientId, text, context: contextWith(view.context, sent).context, form: now.form, userEdited: now.userEdited, baseRevision: now.baseRevision, mode });
      } catch (e) { onCarried?.(false); throw e; }
      onCarried?.(true);
      setPins((list) => list.filter((p) => !sent.includes(p)));
      return { outcome: r.outcome === 'started' ? 'delivered-pending' : r.outcome };
    },
  }), [brief, snapshot, onCarried, t]); // eslint-disable-line react-hooks/exhaustive-deps -- contextWith is pure

  const approvals = useMemo(() => Object.values(live?.approvals ?? {}).filter((a) => job && a.jobId === job.id), [live?.approvals, job]);
  const queued = useMemo<QueuedRequest[]>(() => (session?.queued ?? []).map((q) => ({ clientId: q.clientId, text: q.text, pins: [], at: q.at })), [session?.queued]);
  const thumb = (path: string) => {
    const entry = library.value?.find((a) => assetPath(a.file) === path);
    return entry && (entry.kind === 'image' || entry.kind === 'svg') ? api.projectFileUrl(slug, path) : null;
  };
  const pinnedAssets = pins.filter((p) => p.kind === 'asset').map((p) => p.path);

  return (
    <aside ref={panelRef} className={cx('ms-brief-panel ms-chat-card', className)} aria-label={b.panelLabel} aria-hidden={hidden || undefined} inert={hidden || undefined}>
      <header className="ms-brief-head">
        <span className="ms-brief-avatar" aria-hidden="true"><Icon name="sparkle" size={12} /></span>
        <b className="ms-brief-title">{b.title}</b>
        <Pill tone="neutral" className="ms-brief-state">{state}</Pill>
      </header>
      {brief.status === 'unreadable' ? (
        <div className="ms-brief-alert" role="alert">
          <span>{t.errors.briefSessionUnreadable}</span>
          <Button size="sm" variant="outline" onClick={() => void brief.discard().catch((e: unknown) => setProblem(errText(e)))}>{b.startOver}</Button>
        </div>
      ) : brief.conflict || session?.handedOffTo !== undefined ? (
        // Decision 1423: half moved into a creative (named or not), or gone: the core's words, and what can be done.
        <div className="ms-brief-alert" role="alert">
          <span>{brief.conflict?.message ?? t.errors.briefHandedOff}</span>
          {brief.conflict?.code !== 'brief-session-gone' ? (
            <>
              {session?.handedOffTo && onOpenCreative ? <Button size="sm" variant="outline" onClick={() => onOpenCreative(session.handedOffTo!)}>{b.openCreative}</Button> : null}
              <Button size="sm" variant="ghost" onClick={() => void brief.discard().catch((e: unknown) => setProblem(errText(e)))}>{b.discard}</Button>
            </>
          ) : null}
        </div>
      ) : brief.status === 'failed' ? (
        // The first read failed: nothing is known yet (a session left from before must be asked about), so nothing can be sent.
        <div className="ms-brief-alert" role="alert">
          <span>{b.loadFailed({ detail: brief.error ?? '' })}</span>
          <Button size="sm" variant="outline" onClick={() => void brief.refresh()}>{t.web.newCreative.tryAgain}</Button>
        </div>
      ) : brief.error ? <p className="ms-brief-alert" role="alert">{brief.error}</p> : null}
      <Conversation
        slug={slug} creative="" entries={brief.entries} approvals={approvals} job={job} live={brief.live} snapshots={live?.snapshots}
        queued={queued} queueOps={{ remove: brief.removeQueued }} onQueueChanged={() => void brief.refresh()}
        transport={transport} draft={draft} composerLabel={b.composerLabel} placeholder={asked ? b.placeholderFollowUp : b.placeholderFirst}
        extraContent={pins.length > 0} composerDisabled={brief.status === 'failed'}
        intro={b.intro}
        composerTop={
          <>
            {folderOpen ? (
              <div className="ms-brief-folder-form" role="group" aria-label={b.folder.title}>
                <Input className="ms-brief-folder-input" aria-label={b.folderPath} placeholder={t.web.codebase.pathPlaceholder} value={folderPath} autoFocus
                  onChange={(e) => { setFolderPath(e.target.value); setProblem(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (linkFolder(folderPath)) { setFolderPath(''); setFolderOpen(false); } } if (e.key === 'Escape') { e.preventDefault(); setFolderOpen(false); } }} />
                <Button size="sm" variant="ghost" onClick={() => { setFolderOpen(false); setProblem(null); }}>{b.cancel}</Button>
                <Button size="sm" variant="ink" onClick={() => { if (linkFolder(folderPath)) { setFolderPath(''); setFolderOpen(false); } }}>{b.link}</Button>
              </div>
            ) : null}
            {problem ? <p className="ms-composer-error" role="alert">{problem}</p> : null}
            <ContextPins pins={pins} onRemove={removePin} thumb={thumb} />
          </>
        }
        composerTools={
          <>
            <AddContextMenu disabled={brief.status === 'failed'} onFolder={() => void onFolder()} onLibrary={(el) => { pickerAnchor.current = el; setPickerOpen(true); }} onUpload={() => fileInput.current?.click()} />
            <input ref={fileInput} type="file" multiple hidden aria-hidden="true" tabIndex={-1}
              onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; void onUpload(files); }} />
          </>
        }
        composerBelow={session ? <ContextRow context={session.context} onChange={(c) => void brief.setContext(c).catch((e: unknown) => setProblem(errText(e)))} /> : <ContextRow context={{ codebases: [], assets: [] }} onChange={() => {}} disabled />}
      />
      <LibraryPicker slug={slug} projectName={projectName} open={pickerOpen} onClose={() => setPickerOpen(false)} anchor={pickerAnchor} placement="top-start" library={library}
        onRetry={onRetryLibrary} chosen={pinnedAssets}
        onToggle={(path) => (pinnedAssets.includes(path) ? removePin({ kind: 'asset', path }) : addPin({ kind: 'asset', path }))} />
    </aside>
  );
}
