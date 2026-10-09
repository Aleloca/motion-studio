// Creative · canvas (spec §6.2 #6, §6.1 creative bar), ported from the prototype's CanvasView / VersionsPopover /
// PinComposer and the Canvas boards: formats column by channel, the boards in proportion on a dotted canvas (zoom,
// safe zones with a legend, V/C/H tools), Figma-style comments that become chips of the composer, the Chat · Comments ·
// Brief panel, the version history with Compare, and Export. Replaces the interim CreativePage. A board opens in the
// format view (screens/FormatView.tsx) with T3.
import { channelName, formatName, type ConversationEntry, type CreativeStatus, type FormatPreset, type Pin, type VersionEntry } from '@motion-studio/shared';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.ts';
import { BriefEditor } from '../components/BriefEditor.tsx';
import { Conversation } from '../components/Conversation.tsx';
import type { EventsState } from '../eventsReducer.ts';
import { formatDate, formatNumber, TIME_OF_DAY, useLocale, useT } from '../i18n.tsx';
import { D, enter, flip, pulse, stagger, usePageShortcut } from '../motion/index.ts';
import { href, routeKey } from '../routes.ts';
import { useBarClaim } from '../shell/barSlots.ts';
import { setFrameOrigin, setShownVersion, takeFrameOrigin, takeShownVersion } from '../shell/intents.ts';
import { go, ShellContext } from '../shell/ShellContext.tsx';
import { Button, ChannelMark, Empty, Icon, Input, Pill, Spinner, Tabs, Tag, Toggle, cx, toast } from '../ui/index.ts';
import { useCreative } from '../useCreative.ts';
import { boardLabel, CanvasBoard, type Draft, type Tool } from './CanvasBoard.tsx';
import { boardsOf, fitZoom, isTall, ratioText, worldFixed, worldSize, type BoardModel } from './canvasModel.ts';
import { CompareDialog } from './CompareDialog.tsx';
import { channelOf, lastStep } from './creativeState.ts';
import { ExportDialog } from './ExportDialog.tsx';
import { activatesControl, bare, inOverlay, isTyping } from './keys.ts';
import { pinsKey, usePendingPins } from './pendingPins.ts';
import { useNewVersionNotice, VersionControl } from './VersionControl.tsx';
import './canvas.css';
import { message } from './common.tsx';
import { isVideoFile } from '../media.ts';

const ZOOM_MIN = 0.5;
/** T4 only while the player's rect is fresh (boards that arrive later cascade in). */
const FLIP_WINDOW_MS = 400;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
const TOOL_KEYS: Record<string, Tool> = { v: 'select', c: 'comment', h: 'hand' };


export interface CreativeCanvasProps {
  slug: string;
  creative: string;
  live: EventsState;
}

export function CreativeCanvas({ slug, creative, live }: CreativeCanvasProps) {
  const t = useT();
  const c = t.web.canvas;
  const locale = useLocale();
  const shell = useContext(ShellContext);
  const root = useRef<HTMLDivElement>(null);
  const { detail, conversation, error, reload } = useCreative(slug, creative, live.creativeTicks[`${slug}/${creative}`] ?? 0);

  // This page owns the creative bar only while it is the route's page (a leaving page stays mounted ~200 ms).
  const ownKey = routeKey({ name: 'creative', slug, creative });
  const active = !shell || routeKey(shell.route) === ownKey;
  const bar = useBarClaim(ownKey, active);

  // Format catalog.
  const [presets, setPresets] = useState<FormatPreset[]>([]);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [presetsFailure, setPresetsFailure] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getFormats())
      .then((s) => { if (alive) { setPresets(s.presets); setCatalogError(s.error); setPresetsLoaded(true); } })
      .catch((e: unknown) => { if (alive) { setPresetsFailure(message(e)); setPresetsLoaded(true); } });
    return () => { alive = false; };
  }, []);

  // Versions: the canvas follows the newest until the user picks one (sending a change follows again). A version picked
  // in the format view comes back with T4.
  const versions = useMemo(() => detail?.versions ?? [], [detail]);
  const latest = versions.at(-1) ?? null;
  const [picked, setPicked] = useState<number | null>(() => takeShownVersion(`${slug}/${creative}`));
  const version = (picked !== null ? versions.find((v) => v.n === picked) : undefined) ?? latest;
  const versionButton = useRef<HTMLButtonElement>(null);
  // T11: a new version → toast and a spring on the version badge (the frames reveal themselves on load).
  useNewVersionNotice(Boolean(detail), latest?.n ?? null, active, versionButton);

  const myApprovals = useMemo(() => Object.values(live.approvals).filter((a) => a.projectSlug === slug && a.creativeSlug === creative), [live.approvals, slug, creative]);
  const job = useMemo(() => {
    if (!detail) return undefined;
    const mine = Object.values(live.jobs).filter((j) => j.key === detail.jobKey);
    return mine.find((j) => j.state === 'queued' || j.state === 'running') ?? mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }, [live.jobs, detail]);
  const working = job?.state === 'queued' || job?.state === 'running';
  const step = job && working ? (job.state === 'queued' ? t.web.creatives.queued : lastStep(live.events[job.id]) ?? t.web.creatives.working) : null;

  // Boards.
  const boards = useMemo<BoardModel[]>(() => {
    if (!detail || !presetsLoaded || presetsFailure) return [];
    return boardsOf(detail.creative.brief.formats, presets, version ?? null);
  }, [detail, presets, presetsLoaded, presetsFailure, version]);
  const [sel, setSel] = useState<string | null>(null);

  // Tools, zoom, safe zones.
  const [tool, setTool] = useState<Tool>('select');
  const [zoom, setZoom] = useState(1);
  const [safe, setSafe] = useState(false);

  // Comments: pending pins (shared with the format view), the bubble being written. The core crops pin frames from
  // its pin source (core creative-turns: the version resumed from, else the latest): comments are placed, shown and
  // sent only on that version. `sourcePins` are the pending pins of the source, with their place in the store; a draft's
  // `index` is a position in `sourcePins`.
  const pinSource = detail ? detail.creative.resumeFrom?.version ?? latest?.n ?? null : null;
  const canComment = version !== null && version.n === pinSource;
  const [stored, setStored] = usePendingPins(pinsKey(slug, creative));
  const sourcePins = useMemo(() => stored.flatMap((p, i) => (p.version === pinSource ? [{ pin: p.pin, at: i }] : [])), [stored, pinSource]);
  const pins = useMemo(() => sourcePins.map((p) => p.pin), [sourcePins]);
  const [draft, setDraft] = useState<Draft | null>(null);
  // Another version on screen (or a new pin source): no comment tool, no bubble.
  useEffect(() => {
    if (canComment) return;
    setDraft(null);
    setTool((tl) => (tl === 'comment' ? 'select' : tl));
  }, [canComment]);
  useEffect(() => { setDraft(null); }, [pinSource]);
  const boardEl = (id: string) => [...(root.current?.querySelectorAll<HTMLElement>('[data-board]') ?? [])].find((el) => el.dataset.board === id) ?? null;
  const reveal = (id: string) => {
    const el = boardEl(id);
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    void pulse(el?.querySelector('.ms-cv-frame') ?? el);
  };
  const place = (format: string, x: number, y: number) => {
    setSel(format);
    setDraft((d) => ({ format, x, y, text: d && d.index === null ? d.text : '', index: null }));
  };
  const editPin = (number: number) => {
    const pin = pins[number - 1];
    if (!canComment) return;
    if (!pin) return;
    setSel(pin.format);
    setDraft({ format: pin.format, x: pin.x, y: pin.y, text: pin.note ?? '', index: number - 1 });
    reveal(pin.format);
  };
  const commitDraft = () => {
    if (!draft) return;
    const note = draft.text.trim();
    if (!note) return;
    if (draft.index === null) {
      const out = boards.find((b) => b.id === draft.format)?.out;
      // On the canvas a video comment is at 0 s; frame-accurate comments come with the format view.
      const pin: Pin = { format: draft.format, x: draft.x, y: draft.y, timeSec: out && isVideoFile(out.file) ? 0 : null, note };
      if (pinSource !== null) setStored((ps) => [...ps, { pin, version: pinSource }]);
    } else {
      const at = sourcePins[draft.index]?.at;
      setStored((ps) => ps.map((p, k) => (k === at ? { ...p, pin: { ...p.pin, note } } : p)));
    }
    setDraft(null);
    setTool('select');
  };
  const removePin = (i: number) => {
    const at = sourcePins[i]?.at;
    setStored((ps) => ps.filter((_, k) => k !== at));
    setDraft((d) => (d && d.index !== null ? (d.index === i ? null : d.index > i ? { ...d, index: d.index - 1 } : d) : d));
  };

  // Keyboard: V / C / H, Esc, F2 (never while typing, never from a page that is leaving).
  usePageShortcut(root, (e) => bare(e) && !isTyping(e) && !inOverlay(e) && !activatesControl(e) && e.key.toLowerCase() in TOOL_KEYS && Boolean(detail) && (canComment || TOOL_KEYS[e.key.toLowerCase()] !== 'comment'),
    (e) => setTool(TOOL_KEYS[e.key.toLowerCase()]!));
  usePageShortcut(root, (e) => e.key === 'Escape' && !isTyping(e) && !inOverlay(e) && (tool !== 'select' || draft !== null), () => { setDraft(null); setTool('select'); });
  const [renaming, setRenaming] = useState<string | null>(null);
  const startRename = useCallback(() => { if (detail) setRenaming(detail.creative.title); }, [detail]);
  usePageShortcut(root, (e) => e.key === 'F2' && bare(e) && !e.shiftKey && !isTyping(e) && !inOverlay(e) && Boolean(detail), startRename);

  // Title.
  const [savedTitle, setSavedTitle] = useState<string | null>(null);
  useEffect(() => { setSavedTitle(null); }, [detail]);
  const title = savedTitle ?? detail?.creative.title ?? '';
  const saveTitle = async (next: string) => {
    setRenaming(null);
    const value = next.trim();
    if (!detail || !value || value === detail.creative.title) return;
    setSavedTitle(value);
    try {
      await api.updateCreative(slug, creative, { title: value });
      shell?.catalog.refresh();
      reload();
    } catch (e) {
      setSavedTitle(null);
      toast.show(c.title.saveFailed({ detail: message(e) }));
    }
  };

  // Version actions.
  const [actionError, setActionError] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ open: boolean; init: [number, number]; format: string } | null>(null);
  const comparable = useMemo(() => boards.filter((b) => versions.some((v) => v.outputs.some((o) => o.format === b.id))).map((b) => b.id), [boards, versions]);
  const openCompare = () => {
    if (!version || versions.length < 2) return;
    const i = versions.findIndex((v) => v.n === version.n);
    const other = versions[i - 1] ?? versions[i + 1]!;
    const format = sel && comparable.includes(sel) ? sel : version.outputs[0]?.format ?? comparable[0] ?? '';
    const pair: [number, number] = other.n < version.n ? [other.n, version.n] : [version.n, other.n];
    setCompare({ open: true, init: pair, format });
  };
  const [exporting, setExporting] = useState<{ open: boolean; version: VersionEntry } | null>(null);

  // Open a board in the format view (T3): its rect goes along for the shared-element transition.
  const openEditor = (id: string, frame: HTMLElement) => {
    setFrameOrigin(`format:${slug}/${creative}/${id}`, frame.getBoundingClientRect());
    setShownVersion(`${slug}/${creative}`, picked !== null && version?.n === picked ? picked : null);
    go(href.format(slug, creative, id));
  };

  // First appearance: back from the format view (T4) the board grows back from the player; otherwise the boards
  // cascade in (T14). The player's rect is taken on mount and used only while fresh: boards that arrive late (a slow
  // load) cascade in instead of flying from a stale spot.
  const appeared = useRef(false);
  const [mountedAt] = useState(() => performance.now());
  useLayoutEffect(() => {
    if (appeared.current || !boards.length || !root.current) return;
    appeared.current = true;
    const els = [...root.current.querySelectorAll('.ms-cv-board')];
    const rects = boards.map((b) => ({ id: b.id, rect: takeFrameOrigin(`canvas:${slug}/${creative}/${b.id}`) }));
    const back = performance.now() - mountedAt <= FLIP_WINDOW_MS ? rects.find((x) => x.rect) : undefined;
    if (back?.rect) {
      const frame = boardEl(back.id)?.querySelector('.ms-cv-frame') ?? null;
      void flip(frame, back.rect, D.m);
      els.forEach((el, i) => { if (!el.contains(frame)) void enter(el, { y: 0, scale: 0.98, delay: 80 + i * 30 }); });
      root.current.querySelectorAll('.ms-cv-side').forEach((el, i) => void enter(el, { x: i ? 16 : -16, y: 0, delay: 160 }));
    } else void stagger(els, { y: 12 }, 40);
  }, [boards.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hand tool: drag the canvas.
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const v = viewport.current;
    if (!v || !(tool === 'hand' && e.button === 0) && e.button !== 1) return;
    e.preventDefault();
    drag.current = { x: e.clientX, y: e.clientY, left: v.scrollLeft, top: v.scrollTop };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setGrabbing(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const v = viewport.current;
    const d = drag.current;
    if (!v || !d) return;
    v.scrollLeft = d.left - (e.clientX - d.x);
    v.scrollTop = d.top - (e.clientY - d.y);
  };
  const endDrag = () => { drag.current = null; setGrabbing(false); };

  // The canvas opens fitted: every board visible in the viewport (never above 100%). Until the user zooms, it refits
  // when the viewport or the boards change size (a window resize, a format added); after that the zoom is theirs.
  const userZoomed = useRef(false);
  const fitKey = boards.map((b) => `${b.id}:${b.preset?.width ?? 0}x${b.preset?.height ?? 0}`).join('|');
  useLayoutEffect(() => {
    const v = viewport.current;
    if (!v || !boards.length) return;
    const fit = () => {
      if (userZoomed.current) return;
      const z = fitZoom(worldSize(boards), { width: v.clientWidth, height: v.clientHeight }, ZOOM_MIN, worldFixed(boards));
      if (z !== null) setZoom((cur) => (Math.abs(cur - z) < 1e-6 ? cur : z));
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); });
    ro.observe(v);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, [fitKey, Boolean(detail)]); // eslint-disable-line react-hooks/exhaustive-deps
  const zoomBy = (next: (z: number) => number) => { userZoomed.current = true; setZoom(next); };

  // Generate (no version yet).
  const [starting, setStarting] = useState(false);
  const generate = () => {
    setStarting(true);
    Promise.resolve().then(() => api.sendCreativeTurn(slug, creative, {}))
      .then(() => { setPicked(null); reload(); })
      .catch((e: unknown) => toast.show(c.generateFailed({ detail: message(e) })))
      .finally(() => setStarting(false));
  };

  const formatLabel = (id: string) => boardLabel({ id, preset: presets.find((p) => p.id === id) ?? null, out: null }, locale);
  const [tab, setTab] = useState<'chat' | 'comments' | 'brief'>('chat');
  const sent = useMemo(() => sentComments(conversation), [conversation]);

  if (error && !detail) {
    return (
      <div className="ms-cv-state">
        <Empty icon="warn" title={c.tryAgain} sub={<span role="alert">{c.loadFailed({ detail: error })}</span>}
          action={<Button variant="ink" onClick={reload}><Icon name="refresh" size={13} />{c.tryAgain}</Button>} />
      </div>
    );
  }
  if (!detail) return <div className="ms-cv-state" aria-busy="true"><Spinner size={18} label={c.loading} /></div>;

  const cr = detail.creative;
  const n = version?.n ?? null;
  const tall = boards.filter(isTall);
  const rest = boards.filter((b) => !isTall(b));
  const zones = boards.some((b) => b.preset?.safeZone);
  const pinsOf = (id: string) => pins.map((pin, i) => ({ pin, number: i + 1 })).filter((x) => x.pin.format === id);
  const board = (b: BoardModel, first: boolean) => (
    <CanvasBoard key={b.id} slug={slug} creative={creative} board={b} n={n} tool={tool} zoom={zoom} selected={sel === b.id} working={working} safe={safe}
      pins={canComment ? pinsOf(b.id) : []} draft={canComment ? draft : null} nextNumber={pins.length + 1}
      onSelect={() => setSel(b.id)} onOpen={(el) => { if (tool === 'select') openEditor(b.id, el); }} onPlace={(x, y) => place(b.id, x, y)} onEditPin={editPin}
      onDraftText={(text) => setDraft((d) => (d ? { ...d, text } : d))} onDraftCommit={commitDraft} onDraftCancel={() => setDraft(null)}
      onDraftDelete={() => { if (draft?.index !== null && draft?.index !== undefined) removePin(draft.index); }}
      footer={first && working && step ? (
        <div className="ms-cv-gen">
          <div className="ms-progress ms-indet" role="progressbar" aria-label={t.web.ui.progress}><i /></div>
          <span className="ms-cv-gen-step">{step}</span>
        </div>
      ) : null}
    />
  );

  return (
    <div ref={root} className="ms-cv">
      {bar?.title ? createPortal(
        <BarTitle title={title} renaming={renaming} onStart={startRename} onChange={setRenaming} onSave={(v) => void saveTitle(v)} onCancel={() => setRenaming(null)}
          state={<StatePill status={cr.status} needs={myApprovals.length > 0} working={working} />} />,
        bar.title,
      ) : null}
      {bar?.end ? createPortal(
        <>
          {version ? (
            <VersionControl slug={slug} creative={creative} versions={versions} version={version} resumeFrom={cr.resumeFrom?.version ?? null} buttonRef={versionButton}
              onPick={setPicked} onCompare={openCompare} onChanged={reload} onError={setActionError} />
          ) : null}
          <Button variant="ink" className="ms-cv-export" disabled={!version} onClick={() => { if (version) setExporting({ open: true, version }); }}>
            <Icon name="download" size={13} strokeWidth={1.7} />{c.export}
          </Button>
        </>,
        bar.end,
      ) : null}

      <aside className="ms-cv-side ms-cv-formats" aria-label={c.formatsAria}>
        <div className="ms-cv-formats-head"><b>{c.formats}</b><span>{boards.length}</span></div>
        {groupByChannel(boards).map(([channel, items]) => (
          <div key={channel} className="ms-cv-group">
            <div className="ms-cap ms-cv-group-head">{channel !== '' ? <ChannelMark channel={channelOf(channel)} /> : null}{channel !== '' ? channelName(channel, locale) : t.web.formatUi.other}</div>
            {items.map((b) => (
              <button key={b.id} type="button" className={cx('ms-navitem ms-cv-fmt', sel === b.id && 'ms-on')} aria-pressed={sel === b.id}
                onClick={() => { setSel(b.id); reveal(b.id); }}>
                <Icon name={b.preset?.kind === 'image' ? 'image' : 'video'} size={14} />
                <span className="ms-navitem-label">{b.preset ? formatName(b.preset, locale) : b.id}</span>
                <span className="ms-cv-fmt-side">{b.out || !n ? (b.preset ? ratioText(b.preset) : '') : '—'}</span>
              </button>
            ))}
          </div>
        ))}
      </aside>

      <main className="ms-cv-main" aria-label={c.canvasAria}>
        <Notes>
          {presetsFailure ? <p role="alert" className="ms-cv-note ms-err">{t.web.creative.formatsLoadFailed({ detail: presetsFailure })}</p> : null}
          {catalogError ? <p className="ms-cv-note">{catalogError}</p> : null}
          {cr.resumeFrom ? <p className="ms-cv-note ms-info">{t.web.creative.resumeNote({ n: cr.resumeFrom.version })}</p> : null}
          {(cr.status === 'error' || cr.status === 'interrupted') && cr.error && !working ? <p role="alert" className="ms-cv-note ms-err">{cr.error}</p> : null}
          {version?.status === 'incomplete' ? (
            <div className="ms-cv-note">
              <b>{t.web.creative.versionIncomplete({ n: version.n })}</b>
              <ul>{version.problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          ) : null}
          {actionError ? <p role="alert" className="ms-cv-note ms-err">{actionError}</p> : null}
        </Notes>
        <div
          ref={viewport}
          className={cx('ms-cv-viewport', `ms-tool-${tool}`, grabbing && 'ms-grabbing')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onClick={(e) => {
            if ((e.target as Element).closest('.ms-cv-board')) return;
            // A bubble with typed text stays open: only an empty one closes on a click outside.
            setDraft((d) => (d && d.text.trim() ? d : null));
            setSel(null);
          }}
        >
          {/* The world is not zoomed: each board scales its frame, and its spacing follows --cv-z (canvas.css). */}
          <div className="ms-cv-world" style={{ '--cv-z': zoom } as CSSProperties}>
            {tall.map((b, i) => board(b, i === 0))}
            {rest.length ? <div className="ms-cv-stack">{rest.map((b, i) => board(b, !tall.length && i === 0))}</div> : null}
          </div>
        </div>
        {!versions.length && !working ? (
          <div className="ms-cv-nothing">
            <div className="ms-card ms-cv-nothing-card">
              <span className="ms-cv-nothing-icon" aria-hidden="true"><Icon name="sparkle" size={16} /></span>
              <b>{c.nothingTitle}</b>
              <p>{c.nothingBody}</p>
              <Button variant="ink" aria-label={c.generate} loading={starting} onClick={generate}><Icon name="sparkle" size={13} />{c.generate}</Button>
            </div>
          </div>
        ) : null}
        {tool === 'comment' ? <div className="ms-cv-hint" role="status">{c.commentHint}</div> : null}
        {!canComment && version && pinSource !== null ? <div className="ms-cv-hint ms-lock" id="ms-cv-comment-lock" role="status">{c.versions.commentsOn({ n: pinSource })}</div> : null}
        {safe ? (
          <div className="ms-cv-legend" role="note">
            <b>{c.safeTitle}</b>
            <span>{zones ? c.safeBody : c.safeNone}</span>
            {zones ? <span className="ms-cv-legend-keys"><i aria-hidden="true" />{c.safeTop} · {c.safeBottom} · {c.safeSide}</span> : null}
          </div>
        ) : null}
        <div className="ms-cv-toolbar" role="toolbar" aria-label={c.tools}>
          {([['select', 'cursor', c.select], ['comment', 'comment', c.comment], ['hand', 'hand', c.hand]] as const).map(([k, icon, label]) => (
            <button key={k} type="button" className={cx('ms-cv-tool', tool === k && 'ms-on')} aria-label={label} title={k === 'comment' && !canComment && pinSource !== null ? c.versions.commentsOn({ n: pinSource }) : label} aria-pressed={tool === k}
              disabled={k === 'comment' && !canComment} aria-describedby={k === 'comment' && !canComment && pinSource !== null ? 'ms-cv-comment-lock' : undefined}
              aria-keyshortcuts={k === 'select' ? 'V' : k === 'comment' ? 'C' : 'H'} onClick={() => setTool(k)}>
              <Icon name={icon} size={15} strokeWidth={1.5} />
            </button>
          ))}
          <span className="ms-cv-tool-sep" aria-hidden="true" />
          <button type="button" className="ms-cv-tool ms-sm" aria-label={c.zoomOut} disabled={zoom <= ZOOM_MIN + 1e-6} onClick={() => zoomBy((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 20) / 20))}><Icon name="minus" size={13} /></button>
          <button type="button" className="ms-cv-zoom" aria-label={c.zoomReset({ pct: Math.round(zoom * 100) })} onClick={() => zoomBy(() => 1)}>{formatNumber(locale, Math.round(zoom * 100))}%</button>
          <button type="button" className="ms-cv-tool ms-sm" aria-label={c.zoomIn} disabled={zoom >= ZOOM_MAX - 1e-6} onClick={() => zoomBy((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 20) / 20))}><Icon name="plus" size={13} /></button>
          <span className="ms-cv-tool-sep" aria-hidden="true" />
          <span className="ms-cv-safe-toggle"><Toggle size="sm" on={safe} onChange={setSafe} label={c.safeZones} /><span aria-hidden="true">{c.safeZones}</span></span>
        </div>
      </main>

      <aside className="ms-cv-side ms-cv-panel" aria-label={c.panel}>
        <Tabs label={c.panel} value={tab} onChange={setTab}
          tabs={[{ value: 'chat', label: c.tabs.chat }, { value: 'comments', label: c.tabs.comments, count: sent.count }, { value: 'brief', label: c.tabs.brief }]} />
        {tab === 'chat' ? (
          <Conversation slug={slug} creative={creative} entries={conversation} approvals={myApprovals} job={job} live={job ? live.events[job.id] ?? [] : []}
            pins={pins} onRemovePin={removePin} onEditPin={(i) => editPin(i + 1)} formatName={formatLabel}
            canGenerate={versions.length === 0} onSent={({ pins: sent }) => { setStored((ps) => ps.filter((p) => !sent.includes(p.pin))); setPicked(null); reload(); }}
            onSelectVersion={(v) => setPicked(v)} snapshots={live.snapshots} />
        ) : null}
        {tab === 'comments' ? <CommentsTab sent={sent} working={working} formatLabel={formatLabel} onStart={() => { setTool('comment'); }} /> : null}
        {/* Kept mounted while hidden, so an unsaved brief draft survives tab switches. */}
        <div className="ms-cv-brief-wrap" hidden={tab !== 'brief'}>
          <BriefTab project={slug} detail={detail} presets={presets} disabled={working} formatLabel={formatLabel} onChanged={reload} />
        </div>
      </aside>

      {compare ? (
        <CompareDialog open={compare.open} onClose={() => setCompare((s) => (s ? { ...s, open: false } : s))} slug={slug} creative={creative}
          versions={versions} presets={presets} formats={comparable} initialFormat={compare.format} initial={compare.init} />
      ) : null}
      <ExportDialog open={Boolean(exporting?.open)} onClose={() => setExporting((s) => (s ? { ...s, open: false } : s))} slug={slug} creative={creative}
        title={title} version={exporting?.version ?? null} presets={presets} />
    </div>
  );
}

function groupByChannel(boards: BoardModel[]): Array<[string, BoardModel[]]> {
  const m = new Map<string, BoardModel[]>();
  for (const b of boards) {
    const ch = b.preset?.channel ?? '';
    m.set(ch, [...(m.get(ch) ?? []), b]);
  }
  return [...m.entries()];
}

function Notes({ children }: { children: ReactNode }) {
  const list = (Array.isArray(children) ? children : [children]).filter(Boolean);
  return list.length ? <div className="ms-cv-notes">{list}</div> : null;
}

/** Title (click or F2 to rename) and state, after the bar's breadcrumb. */
function BarTitle({ title, renaming, onStart, onChange, onSave, onCancel, state }: {
  title: string; renaming: string | null; onStart(): void; onChange(v: string): void; onSave(v: string): void; onCancel(): void; state: ReactNode;
}) {
  const t = useT();
  const c = t.web.canvas.title;
  const done = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (renaming === null) return;
    done.current = false;
    field.current?.focus();
    field.current?.select();
  }, [renaming === null]); // eslint-disable-line react-hooks/exhaustive-deps
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) onSave(renaming ?? title); else onCancel();
  };
  return (
    <>
      <span className="ms-crumb ms-last ms-cv-crumb">
        <span className="ms-faint" aria-hidden="true">/</span>
        {renaming !== null ? (
          <Input ref={field} className="ms-cv-title-input" aria-label={c.field} value={renaming} spellCheck={false}
            onChange={(e) => onChange(e.target.value)} onBlur={() => finish(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); finish(true); }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
            }} />
        ) : (
          <button type="button" className="ms-cv-title" aria-label={c.rename({ title })} aria-keyshortcuts="F2" title={c.rename({ title })} onClick={onStart}>
            <b aria-current="page">{title}</b><Icon name="edit" size={12} />
          </button>
        )}
      </span>
      {state}
    </>
  );
}

function StatePill({ status, needs, working }: { status: CreativeStatus; needs: boolean; working: boolean }) {
  const t = useT();
  const c = t.web.canvas.state;
  if (needs) return <Pill tone="warn" dot className="ms-cv-state-pill">{c.needs}</Pill>;
  if (working) return <Pill spinner className="ms-cv-state-pill">{c.working}</Pill>;
  switch (status) {
    case 'ready': return <Pill tone="ok" dot className="ms-cv-state-pill">{t.web.status.ready}</Pill>;
    case 'incomplete': case 'error': case 'interrupted': return <Pill tone="warn" className="ms-cv-state-pill">{t.web.status[status]}</Pill>;
    case 'working': return <Pill spinner className="ms-cv-state-pill">{c.working}</Pill>;
    default: return <Pill className="ms-cv-state-pill">{t.web.status.draft}</Pill>;
  }
}

interface SentComment { pin: Pin; at: string }
interface SentComments { applied: Array<{ n: number; items: SentComment[] }>; open: SentComment[]; count: number }

/** Comments the user sent, grouped by the version that applied them (the next version after the message). */
function sentComments(entries: ConversationEntry[]): SentComments {
  const applied: SentComments['applied'] = [];
  let open: SentComment[] = [];
  let count = 0;
  for (const e of entries) {
    if (e.type === 'user' && e.pins.length) { open = [...open, ...e.pins.map((pin) => ({ pin, at: e.at }))]; count += e.pins.length; }
    if (e.type === 'version' && open.length) { applied.push({ n: e.n, items: open }); open = []; }
  }
  return { applied: applied.reverse(), open, count };
}

function CommentsTab({ sent, working, formatLabel, onStart }: { sent: SentComments; working: boolean; formatLabel(id: string): string; onStart(): void }) {
  const t = useT();
  const c = t.web.canvas.comments;
  const locale = useLocale();
  if (!sent.count) {
    return (
      <div className="ms-cv-tabbody ms-cv-tabempty">
        <Empty icon="comment" title={c.emptyTitle} sub={c.emptySub} action={<Button variant="outline" onClick={onStart}><Icon name="comment" size={13} />{c.start}</Button>} />
      </div>
    );
  }
  const card = (k: SentComment, i: number, state: ReactNode) => (
    <div key={i} className="ms-card ms-cv-comment">
      <span className="ms-cv-comment-head">{state}<span className="ms-cv-comment-where">{formatLabel(k.pin.format)}{k.pin.timeSec ? ` · ${t.web.conversation.atSeconds({ time: formatNumber(locale, k.pin.timeSec, { maximumFractionDigits: 1 }) })}` : ''}</span>
        <span className="ms-cv-comment-at">{formatDate(locale, k.at, TIME_OF_DAY)}</span></span>
      <span className={cx('ms-cv-comment-text', !k.pin.note && 'ms-faint')}>{k.pin.note || c.noText}</span>
    </div>
  );
  return (
    <div className="ms-cv-tabbody ms-cv-comments">
      {sent.open.length ? (
        <section className="ms-cv-cgroup">
          <span className="ms-cap">{working ? c.working : c.open}</span>
          {sent.open.map((k, i) => card(k, i, <Pill tone="accent">{working ? c.working : c.open}</Pill>))}
        </section>
      ) : null}
      {sent.applied.map((g) => (
        <section key={g.n} className="ms-cv-cgroup">
          <span className="ms-cap">{c.applied({ n: g.n })}</span>
          {g.items.map((k, i) => card(k, i, <Pill tone="ok" dot>v{g.n}</Pill>))}
        </section>
      ))}
    </div>
  );
}

function BriefTab({ project, detail, presets, disabled, formatLabel, onChanged }: {
  project: string; detail: NonNullable<ReturnType<typeof useCreative>['detail']>; presets: FormatPreset[]; disabled: boolean; formatLabel(id: string): string; onChanged(): void;
}) {
  const t = useT();
  const c = t.web.canvas.brief;
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const b = detail.creative.brief;
  if (editing) {
    return (
      <div className="ms-cv-tabbody ms-cv-brief-edit">
        <Button size="sm" variant="ghost" className="ms-cv-brief-back" onClick={() => setEditing(false)}><Icon name="back" size={13} />{c.back}</Button>
        <BriefEditor slug={project} detail={detail} presets={presets} disabled={disabled} onChanged={() => { setEditing(false); onChanged(); }} />
      </div>
    );
  }
  const row = (label: string, value: ReactNode) => (
    <div className="ms-cv-brief-row"><span className="ms-cap">{label}</span><div className="ms-cv-brief-value">{value}</div></div>
  );
  return (
    <div className="ms-cv-tabbody ms-cv-brief">
      {row(c.goal, b.goal || c.none)}
      {row(c.message, b.message || c.none)}
      {row(c.length, b.durationSec ? t.web.canvas.seconds({ n: formatNumber(locale, b.durationSec) }) : c.none)}
      {row(c.formats, <span className="ms-cv-brief-tags">{b.formats.map((f) => <Tag key={f}>{formatLabel(f)}</Tag>)}</span>)}
      {b.assets.length ? row(c.assets, <span className="ms-cv-brief-tags">{b.assets.map((a) => <Tag key={a}>{a.replace(/^assets\//, '')}</Tag>)}</span>) : null}
      {b.notes ? row(c.notes, b.notes) : null}
      <Button variant="outline" className="ms-cv-brief-edit-btn" onClick={() => setEditing(true)}><Icon name="edit" size={13} />{c.edit}</Button>
    </div>
  );
}
