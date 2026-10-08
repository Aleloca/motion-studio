// Creative · format view (spec §6.2 #7), the editor preview: ported from the prototype's VideoEditor / ImageEditor
// and the Editor / ImageEditor boards without what belongs to Phase 10 (inspector, timeline, layers, direct edits).
// Video: a large player with play/pause (Space), a scrub bar with the comment markers, frame by frame (←/→, 1/30 s),
// comments on the exact frame (a click on the paused picture; markers visible only within ±0.5 s of their time,
// point 38) and the "Scenes" column that says the timeline is coming. Image: zoom (Fit, −/+, 100%) and comments. The
// Chat panel on the right; "← All formats", the format, the version menu and Export in the bar. T3 on the way in (the
// board grows into the player), T4 on the way out. Replaces the interim FocusView.
import { channelName, formatName, type FormatPreset, type Pin } from '@motion-studio/shared';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.ts';
import { Conversation } from '../components/Conversation.tsx';
import type { EventsState } from '../eventsReducer.ts';
import { formatNumber, useLocale, useT } from '../i18n.tsx';
import { D, enter, flip, usePageShortcut } from '../motion/index.ts';
import { href, routeKey } from '../routes.ts';
import { useBarClaim } from '../shell/barSlots.ts';
import { setFrameOrigin, setShownVersion, takeFrameOrigin, takeShownVersion } from '../shell/intents.ts';
import { go, ShellContext } from '../shell/ShellContext.tsx';
import { Button, ChannelMark, Empty, Icon, Pill, Spinner, Toggle, cx } from '../ui/index.ts';
import { useCreative } from '../useCreative.ts';
import { boardLabel, PinBubble, SafeZoneBands, type Draft } from './CanvasBoard.tsx';
import { pointIn, ratioText, VIDEO_FILE } from './canvasModel.ts';
import { CompareDialog } from './CompareDialog.tsx';
import { channelOf, lastStep } from './creativeState.ts';
import { ExportDialog } from './ExportDialog.tsx';
import { bare, inOverlay, isTyping } from './keys.ts';
import { pinsKey, usePendingPins } from './pendingPins.ts';
import { useNewVersionNotice, VersionControl } from './VersionControl.tsx';
import './canvas.css';
import './format.css';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Frame step of ←/→ (spec: 1/30 s). */
const FPS = 30;
/** A comment shows on the picture within this distance of its time (point 38). */
const PIN_WINDOW = 0.5;
const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** `00:04.50` (prototype timecode: minutes, seconds, hundredths). */
export function timecode(s: number): string {
  const v = Math.max(0, s);
  const cs = Math.floor(round3(v) * 100 + 1e-6);
  const mm = Math.floor(cs / 6000);
  const ss = Math.floor((cs % 6000) / 100);
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** A pending comment of this format with its number among the comments that go out (the chips use the same). */
interface Mark { pin: Pin; number: number }
/** The comment being written, with the time it is on (videos). */
type FDraft = Draft & { timeSec: number | null };

export interface FormatViewProps {
  slug: string;
  creative: string;
  format: string;
  live: EventsState;
}

export function FormatView({ slug, creative, format, live }: FormatViewProps) {
  const t = useT();
  const f = t.web.formatView;
  const c = t.web.canvas;
  const locale = useLocale();
  const shell = useContext(ShellContext);
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const { detail, conversation, error, reload } = useCreative(slug, creative, live.creativeTicks[`${slug}/${creative}`] ?? 0);

  // The bar belongs to this page only while it is the route's page (a leaving page stays mounted ~200 ms).
  const ownKey = routeKey({ name: 'format', slug, creative, format });
  const active = !shell || routeKey(shell.route) === ownKey;
  const bar = useBarClaim(ownKey, active);
  // T3: the rect of the board this view grows from, taken once.
  const [origin] = useState(() => takeFrameOrigin(`format:${slug}/${creative}/${format}`));

  // Format catalog.
  const [presets, setPresets] = useState<FormatPreset[]>([]);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  const [presetsFailure, setPresetsFailure] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getFormats())
      .then((s) => { if (alive) { setPresets(s.presets); setPresetsLoaded(true); } })
      .catch((e: unknown) => { if (alive) { setPresetsFailure(message(e)); setPresetsLoaded(true); } });
    return () => { alive = false; };
  }, []);

  // Versions: the one picked on the canvas comes along (T3); otherwise the newest, followed until the user picks one.
  const versions = useMemo(() => detail?.versions ?? [], [detail]);
  const latest = versions.at(-1) ?? null;
  const [picked, setPicked] = useState<number | null>(() => takeShownVersion(`${slug}/${creative}`));
  const version = (picked !== null ? versions.find((v) => v.n === picked) : undefined) ?? latest;
  const versionButton = useRef<HTMLButtonElement>(null);
  useNewVersionNotice(Boolean(detail), latest?.n ?? null, active, versionButton);
  const [actionError, setActionError] = useState<string | null>(null);

  const myApprovals = useMemo(() => Object.values(live.approvals).filter((a) => a.projectSlug === slug && a.creativeSlug === creative), [live.approvals, slug, creative]);
  const job = useMemo(() => {
    if (!detail) return undefined;
    const mine = Object.values(live.jobs).filter((j) => j.key === detail.jobKey);
    return mine.find((j) => j.state === 'queued' || j.state === 'running') ?? mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }, [live.jobs, detail]);
  const working = job?.state === 'queued' || job?.state === 'running';
  const step = job && working ? (job.state === 'queued' ? t.web.creatives.queued : lastStep(live.events[job.id]) ?? t.web.creatives.working) : null;

  // The format and what this version made of it.
  const preset = presets.find((p) => p.id === format) ?? null;
  const out = version?.outputs.find((o) => o.format === format) ?? null;
  const known = Boolean(detail && (detail.creative.brief.formats.includes(format) || versions.some((v) => v.outputs.some((o) => o.format === format))));
  const video = out ? VIDEO_FILE.test(out.file) : preset?.kind === 'video';
  const width = preset?.width ?? out?.width ?? 1080;
  const height = preset?.height ?? out?.height ?? 1080;
  const label = boardLabel({ id: format, preset, out: null }, locale);
  const src = out && version ? api.fileUrl(slug, creative, `outputs/v${version.n}/${out.file}`) : null;
  const poster = out?.preview && version ? api.fileUrl(slug, creative, `outputs/v${version.n}/${out.preview}`) : undefined;

  // Comments: the pending pins of the creative (shared with the canvas and the composer). The core crops pin frames
  // from its pin source (the version resumed from, else the latest): comments are placed only on that version.
  const pinSource = detail ? detail.creative.resumeFrom?.version ?? latest?.n ?? null : null;
  const canComment = version !== null && version.n === pinSource && Boolean(out);
  const [stored, setStored] = usePendingPins(pinsKey(slug, creative));
  const sourcePins = useMemo(() => stored.flatMap((p, i) => (p.version === pinSource ? [{ pin: p.pin, at: i }] : [])), [stored, pinSource]);
  const pins = useMemo(() => sourcePins.map((p) => p.pin), [sourcePins]);
  const marks = useMemo<Mark[]>(() => pins.map((pin, i) => ({ pin, number: i + 1 })).filter((m) => m.pin.format === format), [pins, format]);
  const [draft, setDraft] = useState<FDraft | null>(null);
  useEffect(() => { if (!canComment) setDraft(null); }, [canComment]);
  useEffect(() => { setDraft(null); }, [pinSource]);

  // Playback (video). jsdom and some codecs never fire `play`: the state follows the call and the media events.
  const media = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [metaDuration, setMetaDuration] = useState<number | null>(null);
  const duration = metaDuration ?? out?.durationSec ?? 0;
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setFailed(false); setPlaying(false); setTime(0); setMetaDuration(null); }, [src]);
  const seek = (to: number) => {
    const v = media.current;
    if (!v) return;
    const next = Math.max(0, duration ? Math.min(duration, to) : to);
    v.currentTime = next;
    setTime(next);
  };
  const pause = () => { media.current?.pause(); setPlaying(false); };
  const play = () => {
    const v = media.current;
    if (!v || failed) return;
    if (duration && v.currentTime >= duration - 1 / FPS / 2) seek(0);
    // An empty bubble goes away when the picture moves; one with text stays until it is sent or cancelled.
    setDraft((d) => (d && d.text.trim() ? d : null));
    setPlaying(true);
    const r = v.play() as Promise<void> | undefined;
    if (r && typeof r.catch === 'function') r.catch(() => setPlaying(false));
  };
  const toggle = () => { if (playing) pause(); else play(); };
  const stepFrame = (dir: 1 | -1) => {
    const v = media.current;
    if (!v) return;
    if (playing) pause();
    seek(Math.round((v.currentTime + dir / FPS) * FPS) / FPS);
  };
  // The playhead follows the picture smoothly while playing (timeupdate fires only ~4 times a second).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = media.current;
      if (v) setTime((x) => (x === v.currentTime ? x : v.currentTime));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  // A page that is leaving stops playing.
  useEffect(() => { if (!active) pause(); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard: Space plays/pauses, ←/→ one frame (never while typing, never from a page that is leaving).
  const keysOn = (e: KeyboardEvent) => bare(e) && !e.shiftKey && !isTyping(e) && !inOverlay(e) && video && Boolean(out) && !failed;
  usePageShortcut(root, (e) => (e.key === ' ' || e.code === 'Space') && keysOn(e), toggle);
  usePageShortcut(root, (e) => (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && keysOn(e), (e) => stepFrame(e.key === 'ArrowRight' ? 1 : -1));

  // Zoom (image): Fit follows the stage; a number is the scale of the picture's own pixels.
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [fitScale, setFitScale] = useState(0);
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el || zoom !== 'fit') return;
    const measure = () => setFitScale(el.offsetWidth / width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });
  const scale = zoom === 'fit' ? fitScale : zoom;
  const zoomBy = (dir: 1 | -1) => {
    const base = scale || 1;
    const next = dir > 0 ? ZOOMS.find((z) => z > base + 1e-3) : [...ZOOMS].reverse().find((z) => z < base - 1e-3);
    setZoom(next ?? (dir > 0 ? ZOOMS.at(-1)! : ZOOMS[0]!));
  };
  const [safe, setSafe] = useState(false);

  // T3: the board grows into the player (FLIP, l, out); the side columns arrive from ±16 px and the transport from
  // +24 px, 160 ms later. Without a board to grow from they simply arrive.
  const ready = Boolean(detail && presetsLoaded && known);
  const appeared = useRef(false);
  useLayoutEffect(() => {
    if (appeared.current || !ready || !root.current) return;
    appeared.current = true;
    if (origin) void flip(frame.current, origin, D.l);
    root.current.querySelectorAll<HTMLElement>('[data-part]').forEach((el) => {
      const part = el.dataset.part;
      void enter(el, { x: part === 'l' ? -16 : part === 'r' ? 16 : 0, y: part === 'b' ? 24 : 0, delay: origin ? 160 : 0 });
    });
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // T4: back to the canvas; the board grows back from the player there.
  const shownKey = `${slug}/${creative}`;
  const keepVersion = () => setShownVersion(shownKey, picked !== null && version?.n === picked ? picked : null);
  const back = () => {
    pause();
    if (frame.current) setFrameOrigin(`canvas:${slug}/${creative}/${format}`, frame.current.getBoundingClientRect());
    keepVersion();
    go(href.creative(slug, creative));
  };

  // Comments.
  const place = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const pt = pointIn(e.currentTarget.getBoundingClientRect(), e);
    const at = video ? round3(media.current?.currentTime ?? time) : null;
    setDraft((d) => ({ format, x: pt.x, y: pt.y, text: d && d.index === null ? d.text : '', index: null, timeSec: at }));
  };
  const editPin = (number: number) => {
    const pin = pins[number - 1];
    if (!pin || !canComment) return;
    if (pin.format !== format) {
      // A chip of another format opens that format's view.
      keepVersion();
      go(href.format(slug, creative, pin.format));
      return;
    }
    if (video) {
      if (playing) pause();
      if (pin.timeSec !== null && Math.abs(pin.timeSec - time) > 1e-3) seek(pin.timeSec);
    }
    setDraft({ format, x: pin.x, y: pin.y, text: pin.note ?? '', index: number - 1, timeSec: pin.timeSec });
  };
  const commitDraft = () => {
    if (!draft) return;
    const note = draft.text.trim();
    if (!note) return;
    if (draft.index === null) {
      const pin: Pin = { format, x: draft.x, y: draft.y, timeSec: video ? draft.timeSec ?? 0 : null, note };
      if (pinSource !== null) setStored((ps) => [...ps, { pin, version: pinSource }]);
    } else {
      const at = sourcePins[draft.index]?.at;
      setStored((ps) => ps.map((p, k) => (k === at ? { ...p, pin: { ...p.pin, note } } : p)));
    }
    setDraft(null);
  };
  const removePin = (i: number) => {
    const at = sourcePins[i]?.at;
    setStored((ps) => ps.filter((_, k) => k !== at));
    setDraft((d) => (d && d.index !== null ? (d.index === i ? null : d.index > i ? { ...d, index: d.index - 1 } : d) : d));
  };

  const [compare, setCompare] = useState<{ open: boolean; init: [number, number] } | null>(null);
  const comparable = versions.filter((v) => v.outputs.some((o) => o.format === format)).length >= 2;
  const openCompare = () => {
    if (!version || versions.length < 2) return;
    const i = versions.findIndex((v) => v.n === version.n);
    const other = versions[i - 1] ?? versions[i + 1]!;
    setCompare({ open: true, init: other.n < version.n ? [other.n, version.n] : [version.n, other.n] });
  };
  const [exporting, setExporting] = useState(false);
  const formatLabel = (id: string) => boardLabel({ id, preset: presets.find((p) => p.id === id) ?? null, out: null }, locale);

  if (error && !detail) {
    return (
      <div className="ms-cv-state">
        <Empty icon="warn" title={c.tryAgain} sub={<span role="alert">{c.loadFailed({ detail: error })}</span>}
          action={<Button variant="ink" onClick={reload}><Icon name="refresh" size={13} />{c.tryAgain}</Button>} />
      </div>
    );
  }
  if (!detail || !presetsLoaded) return <div className="ms-cv-state" aria-busy="true"><Spinner size={18} label={c.loading} /></div>;

  const backButton = <Button className="ms-back" onClick={back}><Icon name="back" size={16} strokeWidth={1.5} />{t.web.shell.backAllFormats}</Button>;
  if (!known) {
    return (
      <div ref={root} className="ms-cv-state">
        {bar?.start ? createPortal(backButton, bar.start) : null}
        <Empty icon="grid" title={f.unknownTitle({ id: format })} sub={f.unknownSub}
          action={<Button variant="ink" onClick={back}><Icon name="back" size={13} />{t.web.shell.backAllFormats}</Button>} />
      </div>
    );
  }

  const cr = detail.creative;
  const n = version?.n ?? null;
  const visible = video ? marks.filter((m) => m.pin.timeSec === null || Math.abs(m.pin.timeSec - time) <= PIN_WINDOW + 1e-6) : marks;
  const nextNumber = pins.length + 1;
  const meta = [`${width}×${height}`, ratioText({ width, height }), video && duration ? c.seconds({ n: formatNumber(locale, duration, { maximumFractionDigits: 1 }) }) : null].filter(Boolean).join(' · ');
  const frameStyle: CSSProperties = zoom === 'fit' || video
    ? { width: `min(100cqw, calc(100cqh * ${width / height}))`, aspectRatio: `${width} / ${height}` }
    : { width: Math.round(width * zoom), aspectRatio: `${width} / ${height}` };
  const lock = !canComment && version && out && pinSource !== null && version.n !== pinSource;
  const commentHint = canComment && !draft && (!video || (!playing && !failed));

  return (
    <div ref={root} className={cx('ms-fv', video ? 'ms-fv-video' : 'ms-fv-image')}>
      {bar?.start ? createPortal(backButton, bar.start) : null}
      {bar?.title ? createPortal(
        <>
          <span className="ms-crumb ms-last ms-fv-crumb">
            <span className="ms-faint" aria-hidden="true">/</span>
            {preset ? <ChannelMark channel={channelOf(preset.channel)} /> : null}
            <b aria-current="page" title={preset ? channelName(preset.channel, locale) : undefined}>{preset ? formatName(preset, locale) : format}</b>
          </span>
          <span className="ms-fv-meta">{meta}</span>
          {out && !out.verified ? <Pill tone="warn" className="ms-cv-state-pill">{t.web.formatUi.unverified}</Pill> : null}
        </>,
        bar.title,
      ) : null}
      {bar?.end ? createPortal(
        <>
          {version ? (
            <VersionControl slug={slug} creative={creative} versions={versions} version={version} resumeFrom={cr.resumeFrom?.version ?? null} buttonRef={versionButton}
              onPick={setPicked} onCompare={openCompare} onChanged={reload} onError={setActionError} />
          ) : null}
          <Button variant="ink" className="ms-cv-export" disabled={!version} onClick={() => setExporting(true)}>
            <Icon name="download" size={13} strokeWidth={1.7} />{c.export}
          </Button>
        </>,
        bar.end,
      ) : null}

      {video ? (
        <aside className="ms-fv-side ms-fv-scenes" aria-label={f.scenes} data-part="l">
          <div className="ms-fv-side-head"><b>{f.scenes}</b>{duration ? <span>{c.seconds({ n: formatNumber(locale, duration, { maximumFractionDigits: 1 }) })}</span> : null}</div>
          <div className="ms-fv-soon">
            <span className="ms-fv-soon-icon" aria-hidden="true"><Icon name="clock" size={14} /></span>
            <p>{f.scenesSoon}</p>
          </div>
        </aside>
      ) : null}

      <main className="ms-fv-main" aria-label={label}>
        <div className="ms-fv-notes">
          {presetsFailure ? <p role="alert" className="ms-cv-note ms-err">{t.web.creative.formatsLoadFailed({ detail: presetsFailure })}</p> : null}
          {cr.resumeFrom ? <p className="ms-cv-note ms-info">{t.web.creative.resumeNote({ n: cr.resumeFrom.version })}</p> : null}
          {(cr.status === 'error' || cr.status === 'interrupted') && cr.error && !working ? <p role="alert" className="ms-cv-note ms-err">{cr.error}</p> : null}
          {actionError ? <p role="alert" className="ms-cv-note ms-err">{actionError}</p> : null}
          {working && step ? (
            <div className="ms-cv-note ms-info ms-fv-gen">
              <div className="ms-progress ms-indet" role="progressbar" aria-label={t.web.ui.progress}><i /></div>
              <span className="ms-cv-gen-step">{step}</span>
            </div>
          ) : null}
        </div>
        <section className="ms-fv-stage" aria-label={f.stage({ label })}>
          <div ref={frame} className="ms-fv-frame" style={frameStyle}>
            <div className={cx('ms-fv-media', !out && 'ms-empty-frame')} onClick={() => { if (video && out && !canComment) toggle(); else if (video && playing) pause(); }}>
              {src && n !== null && video ? (
                <video key={`${src}#${attempt}`} ref={media} src={src} poster={poster} preload="auto" playsInline aria-label={`${label} v${n}`}
                  onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                  onLoadedMetadata={(e) => { if (Number.isFinite(e.currentTarget.duration) && e.currentTarget.duration > 0) setMetaDuration(e.currentTarget.duration); }}
                  onDurationChange={(e) => { if (Number.isFinite(e.currentTarget.duration) && e.currentTarget.duration > 0) setMetaDuration(e.currentTarget.duration); }}
                  onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setFailed(true); setPlaying(false); }} />
              ) : src && n !== null ? (
                <img key={src} src={src} alt={`${label} v${n}`} draggable={false} />
              ) : (
                <span className="ms-cv-frame-note">{n === null ? c.notGenerated : t.web.formatUi.missingIn({ n })}</span>
              )}
              {working ? <span className="ms-shimmer" aria-hidden="true" /> : null}
              {safe && preset ? <SafeZoneBands preset={preset} /> : null}
              {failed ? (
                <span className="ms-fv-failed" role="alert">
                  <span>{f.videoFailed}</span>
                  <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setAttempt((a) => a + 1); setFailed(false); }}><Icon name="refresh" size={12} />{c.tryAgain}</Button>
                </span>
              ) : null}
              {video && out && !playing && !canComment && !failed ? <span className="ms-fv-bigplay" aria-hidden="true"><Icon name="play" size={22} fill /></span> : null}
              {canComment && (!video || (!playing && !failed)) ? (
                <button type="button" className="ms-cv-hit" aria-label={video ? f.commentFrame({ time: timecode(time) }) : c.commentOn({ label })} onClick={place} />
              ) : null}
            </div>
            {canComment ? visible.map(({ pin, number }) => (
              <button key={number} type="button" className={cx('ms-cv-pin', draft?.index === number - 1 && 'ms-on')} style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
                aria-label={c.pin.edit({ n: number })} title={pin.note} onClick={(e) => { e.stopPropagation(); editPin(number); }}>
                {number}
              </button>
            )) : null}
            {draft ? (
              <PinBubble draft={draft} number={draft.index === null ? nextNumber : draft.index + 1} video={video}
                time={video && draft.timeSec !== null ? f.pinAt({ time: timecode(draft.timeSec) }) : undefined}
                onText={(text) => setDraft((d) => (d ? { ...d, text } : d))} onCommit={commitDraft} onCancel={() => setDraft(null)}
                onDelete={() => { if (draft.index !== null) removePin(draft.index); }} />
            ) : null}
          </div>
        </section>
        {commentHint ? <div className="ms-cv-hint ms-fv-hint" role="status">{video ? f.commentAt({ time: timecode(time) }) : f.commentImage}</div> : null}
        {lock ? <div className="ms-cv-hint ms-lock ms-fv-hint" id="ms-fv-comment-lock" role="status">{c.versions.commentsOn({ n: pinSource })}</div> : null}
        {preset?.safeZone && out ? (
          <span className="ms-fv-safe-toggle"><Toggle size="sm" on={safe} onChange={setSafe} label={c.safeZones} /><span aria-hidden="true">{c.safeZones}</span></span>
        ) : null}
        {!video && out ? (
          <div className="ms-cv-toolbar ms-fv-zoom" role="toolbar" aria-label={f.zoom}>
            <button type="button" className="ms-cv-tool ms-sm" aria-label={c.zoomOut} disabled={scale > 0 && scale <= ZOOMS[0]! + 1e-3} onClick={() => zoomBy(-1)}><Icon name="minus" size={13} /></button>
            <span className="ms-fv-zoom-pct" role="status">{scale ? `${formatNumber(locale, Math.round(scale * 100))}%` : '—'}</span>
            <button type="button" className="ms-cv-tool ms-sm" aria-label={c.zoomIn} disabled={scale >= ZOOMS.at(-1)! - 1e-3} onClick={() => zoomBy(1)}><Icon name="plus" size={13} /></button>
            <span className="ms-cv-tool-sep" aria-hidden="true" />
            <button type="button" className={cx('ms-fv-zoom-btn', zoom === 'fit' && 'ms-on')} aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')}>{f.fit}</button>
            <button type="button" className={cx('ms-fv-zoom-btn', zoom === 1 && 'ms-on')} aria-pressed={zoom === 1} aria-label={f.actual} onClick={() => setZoom(1)}>100%</button>
          </div>
        ) : null}
        {video ? (
          <Transport time={time} duration={duration} playing={playing} disabled={!out || failed} marks={canComment ? marks : []}
            onToggle={toggle} onStep={stepFrame} onSeek={seek} onPause={pause} onResume={play} />
        ) : null}
      </main>

      <aside className="ms-fv-side ms-fv-panel" aria-label={c.panel} data-part="r">
        <div className="ms-tabs ms-panel ms-fv-tabs"><span className="ms-tab ms-on">{f.chat}</span></div>
        <Conversation slug={slug} creative={creative} entries={conversation} approvals={myApprovals} job={job} live={job ? live.events[job.id] ?? [] : []}
          pins={pins} onRemovePin={removePin} onEditPin={(i) => editPin(i + 1)} formatName={formatLabel}
          canGenerate={versions.length === 0} onSent={({ pins: sent }) => { setStored((ps) => ps.filter((p) => !sent.includes(p.pin))); setPicked(null); reload(); }}
          onSelectVersion={(v) => setPicked(v)} snapshots={live.snapshots} />
      </aside>

      {compare ? (
        <CompareDialog open={compare.open} onClose={() => setCompare((s) => (s ? { ...s, open: false } : s))} slug={slug} creative={creative}
          versions={versions} presets={presets} formats={comparable ? [format] : []} initialFormat={format} initial={compare.init} />
      ) : null}
      <ExportDialog open={exporting} onClose={() => setExporting(false)} slug={slug} creative={creative} title={cr.title} version={version} presets={presets} />
    </div>
  );
}

/**
 * Under the player: play/pause, the timecode, frame by frame and the scrub bar with a ruler and the comment markers
 * (a marker seeks to its comment). Dragging pauses and resumes afterwards if it was playing.
 */
function Transport({ time, duration, playing, disabled, marks, onToggle, onStep, onSeek, onPause, onResume }: {
  time: number; duration: number; playing: boolean; disabled: boolean; marks: Mark[];
  onToggle(): void; onStep(dir: 1 | -1): void; onSeek(t: number): void; onPause(): void; onResume(): void;
}) {
  const t = useT();
  const f = t.web.formatView;
  const locale = useLocale();
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ resume: boolean } | null>(null);
  const pct = (s: number) => (duration ? Math.min(100, Math.max(0, (s / duration) * 100)) : 0);
  const at = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || !r.width || !duration) return null;
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { resume: playing };
    if (playing) onPause();
    const s = at(e.clientX);
    if (s !== null) onSeek(s);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const s = at(e.clientX);
    if (s !== null) onSeek(s);
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.resume) onResume();
  };
  const keys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === 'Home') { e.preventDefault(); onSeek(0); }
    if (e.key === 'End') { e.preventDefault(); onSeek(duration); }
    if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); onSeek(time + (e.key === 'PageUp' ? 1 : -1)); }
  };
  // Ruler: at most ~10 labels.
  const every = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => duration / s <= 10) ?? 600;
  // The last label would be cut by the end of the bar.
  const ticks = duration ? Array.from({ length: Math.floor(duration / every + 1e-6) + 1 }, (_, i) => i * every).filter((s) => s / duration <= 0.94) : [];
  return (
    <section className="ms-fv-transport" aria-label={f.transport} data-part="b">
      <div className="ms-fv-controls">
        <button type="button" className="ms-fv-play" aria-label={playing ? f.pause : f.play} aria-keyshortcuts="Space" disabled={disabled} onClick={onToggle}>
          <Icon name={playing ? 'pause' : 'play'} size={13} fill={!playing} strokeWidth={playing ? 2 : 1.4} />
        </button>
        <span className="ms-fv-tc">{timecode(time)}<span className="ms-faint"> / {timecode(duration)}</span></span>
        <Button size="sm" variant="outline" icon aria-label={f.prevFrame} title={f.prevFrame} aria-keyshortcuts="ArrowLeft" disabled={disabled} onClick={() => onStep(-1)}><Icon name="back" size={13} /></Button>
        <Button size="sm" variant="outline" icon aria-label={f.nextFrame} title={f.nextFrame} aria-keyshortcuts="ArrowRight" disabled={disabled} onClick={() => onStep(1)}><Icon name="forward" size={13} /></Button>
        <span className="ms-grow" />
        <span className="ms-fv-keys">{f.keys}</span>
      </div>
      <div className="ms-fv-scrubwrap">
        <div ref={track} className={cx('ms-fv-scrub', disabled && 'ms-off')} role="slider" tabIndex={disabled ? -1 : 0} aria-label={f.position} aria-disabled={disabled || undefined}
          aria-valuemin={0} aria-valuemax={round3(duration)} aria-valuenow={round3(time)} aria-valuetext={f.positionText({ time: timecode(time), total: timecode(duration) })}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={keys}>
          <div className="ms-fv-ruler" aria-hidden="true">
            {ticks.map((s) => <span key={s} style={{ left: `${pct(s)}%` }}>{t.web.canvas.seconds({ n: formatNumber(locale, s) })}</span>)}
          </div>
          <div className="ms-fv-track" aria-hidden="true"><i style={{ width: `${pct(time)}%` }} /></div>
          <span className="ms-fv-head" style={{ left: `${pct(time)}%` }} aria-hidden="true" />
        </div>
        <div className="ms-fv-marks">
          {marks.filter((m) => m.pin.timeSec !== null).map(({ pin, number }) => (
            <button key={number} type="button" className="ms-fv-mark" style={{ left: `${pct(pin.timeSec!)}%` }} title={pin.note}
              aria-label={f.marker({ n: number, time: timecode(pin.timeSec!) })} disabled={disabled} onClick={() => { if (playing) onPause(); onSeek(pin.timeSec!); }}>
              {number}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
