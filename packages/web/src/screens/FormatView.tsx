// Creative · format view (spec §6.2 #7), the editor preview: ported from the prototype's VideoEditor / ImageEditor
// and the Editor / ImageEditor boards without what belongs to Phase 10 (inspector, timeline, layers, direct edits).
// Video: a large player with play/pause (Space), a scrub bar with the comment markers, frame by frame (←/→, 1/30 s),
// comments on the exact frame (a click on the paused picture; markers visible only within ±0.5 s of their time,
// point 38) and the "Scenes" column that says the timeline is coming. Image: zoom (Fit, −/+, 100%) and comments. The
// Chat panel on the right; "← All formats", the format with its ★ badge (or its link chip), the Versions timeline and
// Export in the bar. T3 on the way in (the
// board grows into the player), T4 on the way out. Replaces the interim FocusView.
//
// The playhead moves at frame rate: its time lives in a small store (`Clock`, ui/clock.ts) that only the transport
// (Transport.tsx, shared with Compare), the comment layer and the hint read, so the page (bar, chat) does not
// re-render while the video plays.
import { IntegrityNotice, useIntegrity } from '../components/IntegrityNotice.tsx';
import { channelName, isDurationOffBrief, pinClipName, DEFAULT_EXPORT_NAME_PATTERN, DEFAULT_FORMATS, type Composition, type FormatPreset, type Pin, type StoryboardView, type VersionEntry, type WorkspaceSettings } from '@motion-studio/shared';
import {
  useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.ts';
import { CompositionPlayer, type CompositionMedia } from '../components/CompositionPlayer.tsx';
import { posterOf, usePreviewSession, useStoryboard, type StoryboardState } from '../components/compositionPreview.ts';
import { frameFor, rowAt, sceneRows, SceneThumb } from '../components/SceneThumb.tsx';
import { Conversation } from '../components/Conversation.tsx';
import type { EventsState } from '../eventsReducer.ts';
import { formatNumber, useLocale, useT } from '../i18n.tsx';
import { D, enter, flip, usePageShortcut } from '../motion/index.ts';
import { href, routeKey } from '../routes.ts';
import { useBarClaim } from '../shell/barSlots.ts';
import { setFrameOrigin, setShownVersions, takeFrameOrigin, takeShownVersions } from '../shell/intents.ts';
import { go, ShellContext } from '../shell/ShellContext.tsx';
import { Button, ChannelMark, Empty, Icon, Pill, Select, Spinner, Toggle, cx, toast } from '../ui/index.ts';
import { useCreative } from '../useCreative.ts';
import { boardLabel, PinBubble, SafeZoneBands, type Draft } from './CanvasBoard.tsx';
import { instanceName, presetFor } from '../instances.ts';
import { outputUrl, pointIn, ratioText } from './canvasModel.ts';
import { CompareDialog } from './CompareDialog.tsx';
import { channelOf, lastStep } from './creativeState.ts';
import { ExportDialog, type ExportSnapshot } from './ExportDialog.tsx';
import { activatesControl, bare, inOverlay, isTyping } from './keys.ts';
import { pinsKey, usePendingPins } from './pendingPins.ts';
import { LanguagesButton } from './creative/LanguagesButton.tsx';
import { creativeLocales } from './creative/languagesModel.ts';
import { LocaleOutline, LocaleSwitcher } from './creative/LocaleSwitcher.tsx';
import { localePreviewSource, useLocalePreview } from './creative/useLocalePreview.ts';
import { RangeDialog } from './editor/RangeDialog.tsx';
import { clipLabel, clipPin, clipsAt, rangePin, rangeTimes } from './pinModel.ts';
import { RenderStatus } from './RenderStatus.tsx';
import { FollowerChip, FormatBadge, useNewVersionNotice, useVersionActions, VersionTimeline } from './FormatVersions.tsx';
import { boardSource, entryAt, followersOf, formatStates, isRendering, renderingOf, shownOf, type FormatState } from './versionModel.ts';
import { compositionOf } from './renderModel.ts';
import './canvas.css';
import './format.css';
import { message } from './common.tsx';
import { isVideoFile } from '../media.ts';
import { createClock, useClock, type Clock } from '../ui/clock.ts';
import { FPS, PLAYER_CONTROLS, round3, timecode, Transport, type Mark, type Speed } from './Transport.tsx';

/** A comment shows on the picture within this distance of its time (point 38). */
const PIN_WINDOW = 0.5;
const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/** T3 only while the board's rect is fresh: a frame that shows up later than this simply appears. */
const FLIP_WINDOW_MS = 400;

/** The comment being written, with the time it is on (videos). */
type FDraft = Draft & { timeSec: number | null; clip?: { id: string; name: string }; range?: { start: number; end: number } };
/** What the transport drives: the <video> of a legacy version, or the live composition player (v2). */
type PlayerMedia = Pick<HTMLVideoElement, 'currentTime' | 'playbackRate' | 'defaultPlaybackRate' | 'pause'> & { play(): Promise<void> | void };

export interface FormatViewProps {
  slug: string;
  creative: string;
  format: string;
  live: EventsState;
  /** The workspace's export file name pattern (Export starts with it); the default one when unknown. */
  exportNamePattern?: string;
  /** The workspace settings after Export's "Save as default". */
  onSettings?(next: WorkspaceSettings): void;
}

export function FormatView({ slug, creative, format, live, exportNamePattern, onSettings }: FormatViewProps) {
  const t = useT();
  const integrity = useIntegrity(slug, live);
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
  // T3: the rect of the board this view grows from, taken once, and when the page mounted.
  const [origin] = useState(() => takeFrameOrigin(`format:${slug}/${creative}/${format}`));
  const [mountedAt] = useState(() => performance.now());

  // Format catalog. Until it arrives, the built-in catalog gives the frame its proportions (T3 starts at once).
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

  // Versions (spec §3.1): the format's ★ (a follower: its primary's file and ★), or the version viewed on its board, which
  // comes along with T3 and goes back with T4.
  const versions = useMemo(() => detail?.versions ?? [], [detail]);
  const latest = versions.at(-1) ?? null;
  const states = useMemo<Record<string, FormatState>>(() => (detail ? formatStates(detail, presets) : {}), [detail, presets]);
  const [viewing, setViewing] = useState<Record<string, number>>(() => takeShownVersions(`${slug}/${creative}`));
  const source = boardSource(states, format, viewing);
  const version = source.n !== null ? versions.find((v) => v.n === source.n) ?? null : null;
  const view = useCallback((f: string, n: number) => setViewing((v) => {
    const next = { ...v };
    if (n === states[f]?.star.version) delete next[f]; else next[f] = n;
    return next;
  }), [states]);
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
  const rendering = isRendering(renderingOf(job, states), format);
  const step = job && working ? (job.state === 'queued' ? t.web.creatives.queued : lastStep(live.events[job.id]) ?? t.web.creatives.working) : null;

  // The format and what this version made of it.
  const loading = !detail || !presetsLoaded;
  const preset = presetFor(presets, format) ?? (presetsLoaded ? null : presetFor(DEFAULT_FORMATS, format));
  const labels = detail?.creative.brief.formatLabels;
  const out = version?.outputs.find((o) => o.format === source.format) ?? null;
  const known = Boolean(detail && (detail.creative.brief.formats.includes(format) || versions.some((v) => v.outputs.some((o) => o.format === format))));
  // A v2 version (Task 8): the live player replaces the <video>; a legacy version (no session, 404) keeps its media.
  const comp = compositionOf(version, source.format);
  const preview = usePreviewSession({ slug, creative, n: version?.n ?? null, format: source.format, enabled: comp !== null });
  const livePlayer = comp !== null && preview.state.kind !== 'legacy';
  const { storyboard, state: storyboardState } = useStoryboard({ slug, creative, n: version?.n ?? null, format: source.format, hash: comp?.hash ?? null, enabled: comp !== null });
  const sbPoster = posterOf(storyboard);
  const video = livePlayer ? preset?.kind !== 'image' : out ? isVideoFile(out.file) : preset?.kind === 'video';
  // Proportions: the preset, the output, or (an unknown custom preset still loading) the board it grows from.
  const width = preset?.width ?? out?.width ?? (origin?.width ? Math.round(origin.width) : 1080);
  const height = preset?.height ?? out?.height ?? (origin?.height ? Math.round(origin.height) : 1080);
  const label = boardLabel({ id: format, preset, out: null, labels }, locale);
  const src = out && version ? outputUrl(slug, creative, version.n, out.file) : null;
  const poster = out?.preview && version ? outputUrl(slug, creative, version.n, out.preview) : undefined;

  // Comments: the pending pins of the creative (shared with the canvas and the composer). The core crops pin frames
  // from its pin source (the version resumed from, else the latest): comments are placed only on that version.
  const pinSource = detail ? detail.creative.resumeFrom?.version ?? latest?.n ?? null : null;
  // Comments go on the file the pin source has for this format (a follower: its primary's).
  const canComment = version !== null && (Boolean(out) || comp !== null) && entryAt(versions, states[source.format], pinSource) === version.n;
  const [stored, setStored] = usePendingPins(pinsKey(slug, creative));
  const sourcePins = useMemo(() => stored.flatMap((p, i) => (p.version === pinSource ? [{ pin: p.pin, at: i }] : [])), [stored, pinSource]);
  const pins = useMemo(() => sourcePins.map((p) => p.pin), [sourcePins]);
  const marks = useMemo<Mark[]>(() => pins.map((pin, i) => ({ pin, number: i + 1 })).filter((m) => m.pin.format === format), [pins, format]);
  const [draft, setDraft] = useState<FDraft | null>(null);
  /** A band is shown on the transport: the comment hint, which can sit over its Comment bubble, steps aside. */
  const [bandShown, setBandShown] = useState(false);
  useEffect(() => { if (!canComment) setDraft(null); }, [canComment]);
  useEffect(() => { setDraft(null); }, [pinSource]);

  // The version's composition (Phase 10b; UX feedback 1, Task 2): the Scenes column lists its scenes at once (the storyboard's
  // thumbnails fill in later), and the picker of "Comment on clip" lists the clips playing at the playhead (on the pin source
  // only). A version without an editable composition (a legacy one) simply has neither.
  const compOf = livePlayer && version ? version.n : null;
  // Keyed by what it was read for: another version (or format) shows nothing of the previous one, from its first render.
  const compKey = compOf === null ? null : `${slug}/${creative}/${compOf}/${source.format}`;
  const [readComp, setReadComp] = useState<{ key: string; comp: Composition | 'failed' } | null>(null);
  useEffect(() => {
    if (compOf === null || compKey === null) return;
    let alive = true;
    Promise.resolve().then(() => api.getEditorComposition(slug, creative, compOf, source.format)).then(
      (v) => { if (alive) setReadComp({ key: compKey, comp: v.composition }); },
      () => { if (alive) setReadComp({ key: compKey, comp: 'failed' }); });
    return () => { alive = false; };
  }, [slug, creative, compOf, source.format, compKey]);
  const viewComp = readComp && readComp.key === compKey ? readComp.comp : null;
  const loadedComp = viewComp === 'failed' ? null : viewComp;
  const clipComp = canComment ? loadedComp : null;

  // Playback (video). jsdom and some codecs never fire `play`: the state follows the call and the media events.
  const [clock] = useState(createClock);
  const media = useRef<PlayerMedia | null>(null);
  const [player, setPlayer] = useState<CompositionMedia | null>(null);
  const [playerReady, setPlayerReady] = useState(false);
  // The language shown (Phase 12): a creative without languages in its brief has no switcher.
  const localeSource = useMemo(() => (version ? localePreviewSource(versions, version, source.format) : null), [versions, version, source.format]);
  const localePreview = useLocalePreview({
    slug, creative, n: livePlayer && localeSource ? localeSource.n : null, format: source.format, rows: localeSource?.rows ?? [], player,
    token: preview.state.kind === 'ready' ? preview.state.session.token : null, original: () => clipComp,
  });

  const [playing, setPlaying] = useState(false);
  const [metaDuration, setMetaDuration] = useState<number | null>(null);
  const duration = metaDuration ?? out?.durationSec ?? 0;
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Loop and speed (visual test point 39): kept across versions and a replaced <video> (Try again).
  const [loop, setLoop] = useState(false);
  const [rate, setRate] = useState<Speed>('1');
  // A new element (src or attempt) starts at its default rate: apply ours on mount, on change and on metadata.
  const applyRate = useCallback((v: PlayerMedia | null) => {
    if (!v) return;
    v.defaultPlaybackRate = Number(rate);
    v.playbackRate = Number(rate);
  }, [rate]);
  useEffect(() => { applyRate(media.current); }, [applyRate, src, attempt, player]);
  /** A time to show once the (new) video is loaded: a chip opened on another version. */
  const pendingSeek = useRef<number | null>(null);
  const liveKey = livePlayer && version ? `${version.n}/${source.format}` : null;
  useEffect(() => { setFailed(false); setPlaying(false); clock.set(0, true); setMetaDuration(null); setPlayerReady(false); }, [src, liveKey, clock]);
  // The live player as the media: the same events as the <video> below.
  useEffect(() => {
    if (!player) return;
    media.current = player;
    const off: Array<() => void> = [];
    const on = (type: string, f: () => void) => { player.addEventListener(type, f); off.push(() => player.removeEventListener(type, f)); };
    on('timeupdate', () => clock.set(player.currentTime, true));
    const meta = () => {
      applyRate(player);
      setPlayerReady(true);
      setFailed(false);
      if (Number.isFinite(player.duration) && player.duration > 0) setMetaDuration(player.duration);
      if (pendingSeek.current !== null) { player.currentTime = pendingSeek.current; clock.set(pendingSeek.current, true); pendingSeek.current = null; }
    };
    on('loadedmetadata', meta);
    // Ready before this page listened (the player reports itself from its own effect): catch up.
    if (Number.isFinite(player.duration)) { meta(); clock.set(player.currentTime, true); }
    on('play', () => setPlaying(true));
    on('pause', () => setPlaying(false));
    on('ended', () => setPlaying(false));
    on('error', () => { setFailed(true); setPlaying(false); });
    return () => { for (const f of off) f(); if (media.current === player) media.current = null; };
  }, [player, clock, applyRate]);
  useEffect(() => { if (player) player.loop = loop; }, [player, loop]);
  const seek = useCallback((to: number) => {
    const v = media.current;
    if (!v) return;
    const max = metaDuration ?? out?.durationSec ?? 0;
    const next = Math.max(0, max ? Math.min(max, to) : to);
    v.currentTime = next;
    clock.set(next, true);
  }, [clock, metaDuration, out?.durationSec]);
  const pause = useCallback(() => {
    const v = media.current;
    v?.pause();
    setPlaying(false);
    if (v) clock.set(v.currentTime, true);
  }, [clock]);
  const play = useCallback(() => {
    const v = media.current;
    if (!v || failed) return;
    if (duration && v.currentTime >= duration - 1 / FPS / 2) seek(0);
    // An empty bubble goes away when the picture moves; one with text stays until it is sent or cancelled.
    setDraft((d) => (d && d.text.trim() ? d : null));
    setPlaying(true);
    const r = v.play() as Promise<void> | undefined;
    if (r && typeof r.catch === 'function') r.catch(() => setPlaying(false));
  }, [duration, failed, seek]);
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
      if (v) clock.set(v.currentTime, false);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, clock]);
  // A page that is leaving stops playing.
  useEffect(() => { if (!active) pause(); }, [active, pause]);

  // Keyboard: Space plays/pauses, ←/→ one frame (never while typing, never on another focused control, never from
  // a page that is leaving).
  const keysOn = (e: KeyboardEvent) => bare(e) && !e.shiftKey && !isTyping(e) && !inOverlay(e) && !activatesControl(e, PLAYER_CONTROLS) && video && (livePlayer ? playerReady : Boolean(out)) && !failed;
  usePageShortcut(root, (e) => (e.key === ' ' || e.code === 'Space') && keysOn(e), toggle);
  usePageShortcut(root, (e) => (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && keysOn(e), (e) => stepFrame(e.key === 'ArrowRight' ? 1 : -1));
  const [rangeOpen, setRangeOpen] = useState(false);
  const commentTopRef = useRef<() => void>(() => {});
  usePageShortcut(root, (e) => e.key.toLowerCase() === 'r' && keysOn(e) && canComment && !draft && duration > 0 && !playing, () => setRangeOpen(true));
  usePageShortcut(root, (e) => e.key.toLowerCase() === 'c' && keysOn(e) && canComment && !draft && clipComp !== null && !playing, () => commentTopRef.current());

  // Zoom (image): Fit follows the stage; a number is the scale of the picture's own pixels.
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [fitScale, setFitScale] = useState(0);
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el || video || zoom !== 'fit') return;
    const measure = () => setFitScale(el.offsetWidth / width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [video, zoom, width, loading]);
  const scale = zoom === 'fit' ? fitScale : zoom;
  const zoomBy = (dir: 1 | -1) => {
    const base = scale || 1;
    const next = dir > 0 ? ZOOMS.find((z) => z > base + 1e-3) : [...ZOOMS].reverse().find((z) => z < base - 1e-3);
    setZoom(next ?? (dir > 0 ? ZOOMS.at(-1)! : ZOOMS[0]!));
  };
  const [safe, setSafe] = useState(false);

  // T3: the frame is on the page from the first render (sized from the catalog), so the board grows into it at once
  // (FLIP, l, out); the side columns arrive from ±16 px and the transport from +24 px, 160 ms later. A frame that
  // shows up late (FLIP_WINDOW_MS) or a visit without a board simply arrives.
  const hasFrame = !(error && !detail) && !(!loading && !known);
  const appeared = useRef(false);
  useLayoutEffect(() => {
    if (appeared.current || !hasFrame || !root.current) return;
    appeared.current = true;
    const fresh = origin && performance.now() - mountedAt <= FLIP_WINDOW_MS ? origin : null;
    if (fresh) void flip(frame.current, fresh, D.l);
    root.current.querySelectorAll<HTMLElement>('[data-part]').forEach((el) => {
      const part = el.dataset.part;
      void enter(el, { x: part === 'l' ? -16 : part === 'r' ? 16 : 0, y: part === 'b' ? 24 : 0, delay: fresh ? 160 : 0 });
    });
  }, [hasFrame]); // eslint-disable-line react-hooks/exhaustive-deps

  // T4: back to the canvas; the board grows back from the player there.
  const shownKey = `${slug}/${creative}`;
  const keepVersion = (v: Record<string, number>) => setShownVersions(shownKey, v);
  const back = () => {
    pause();
    if (frame.current) setFrameOrigin(`canvas:${slug}/${creative}/${format}`, frame.current.getBoundingClientRect());
    keepVersion(viewing);
    go(href.creative(slug, creative));
  };

  // The direct editor (Phase 10b): a v2 version with no agent or render at work. The version on screen is the one it opens.
  const openEditor = () => {
    pause();
    keepVersion(viewing);
    go(href.edit(slug, creative, format));
  };

  // Duplicate format (Phase 12): the next free instance of this format, copied from the version on screen; opens the new one.
  const [duplicating, setDuplicating] = useState(false);
  const duplicate = async () => {
    if (!version || duplicating) return;
    setDuplicating(true);
    setActionError(null);
    try {
      const r = await api.duplicateFormat(slug, creative, version.n, { instanceId: format });
      pause();
      keepVersion({});
      reload();
      toast.show(t.web.instances.duplicated({ label: instanceName(preset, r.instanceId, locale, labels) }), { tone: 'ok' });
      go(href.format(slug, creative, r.instanceId));
    } catch (e) {
      setActionError(t.web.instances.duplicateFailed({ detail: message(e) }));
    }
    setDuplicating(false);
  };

  // Comments.
  const place = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const pt = pointIn(e.currentTarget.getBoundingClientRect(), e);
    const at = video ? round3(media.current?.currentTime ?? clock.get().time) : null;
    setDraft((d) => ({ format, x: pt.x, y: pt.y, text: d && d.index === null ? d.text : '', index: null, timeSec: at }));
  };
  /** "Comment on clip": the clip's centre at the current time. */
  const commentClip = (id: string) => {
    const clip = clipComp ? clipsAt(clipComp, round3(media.current?.currentTime ?? clock.get().time)).find((x) => x.id === id) : null;
    if (!clipComp || !clip) return;
    if (playing) pause();
    const time = round3(media.current?.currentTime ?? clock.get().time);
    const pin = clipPin({ format, comp: clipComp, clip, time });
    setDraft({ format, x: pin.x, y: pin.y, text: '', index: null, timeSec: time, clip: { id: clip.id, name: clipLabel(clip) } });
  };
  /** The range of a Shift + drag on the transport. */
  const commentRange = (r: { start: number; end: number }) => {
    const pin = rangePin({ format, start: r.start, end: r.end, duration });
    if (!pin) return;
    if (playing) pause();
    setDraft({ format, x: pin.x, y: pin.y, text: '', index: null, timeSec: pin.timeSec, range: pin.range });
  };
  /** `C`: comments on the clip on top at the playhead. */
  const commentTopClip = () => {
    if (!clipComp) return;
    const at = clipsAt(clipComp, round3(media.current?.currentTime ?? clock.get().time));
    // The track list runs bottom to top; audio is heard, not seen, so the top clip is the last one with a picture.
    const top = at.filter((x) => x.type !== 'audio').at(-1) ?? at.at(-1);
    if (top) commentClip(top.id);
  };
  commentTopRef.current = commentTopClip;
  /** Opens comment `number` (1-based among the pin source's): here, on its version and time, or in its format. */
  const openPin = (number: number) => {
    const pin = pins[number - 1];
    if (!pin) return;
    if (pin.format !== format) {
      // Its format opens on the file the comment is on.
      const target = boardSource(states, pin.format, {}).format;
      const entry = entryAt(versions, states[target], pinSource);
      const next = { ...viewing };
      if (entry !== null && entry !== states[target]?.star.version) next[target] = entry; else delete next[target];
      keepVersion(next);
      go(href.format(slug, creative, pin.format));
      return;
    }
    const d: FDraft = { format, x: pin.x, y: pin.y, text: pin.note ?? '', index: number - 1, timeSec: pin.timeSec, ...(pin.clipId ? { clip: { id: pin.clipId, name: pin.clipName ?? pin.clipId } } : {}), ...(pin.range ? { range: pin.range } : {}) };
    if (!canComment) {
      // Another version is on screen: go to the one comments apply to, then open it there.
      const entry = entryAt(versions, states[source.format], pinSource);
      if (entry === null) return;
      view(source.format, entry);
      if (video && pin.timeSec !== null) pendingSeek.current = pin.timeSec;
      setDraft(d);
      return;
    }
    if (video) {
      if (playing) pause();
      if (pin.timeSec !== null && Math.abs(pin.timeSec - clock.get().time) > 1e-3) seek(pin.timeSec);
    }
    setDraft(d);
  };
  const openPinRef = useRef(openPin);
  openPinRef.current = openPin;
  const commitDraft = () => {
    if (!draft) return;
    const note = draft.text.trim();
    if (!note) return;
    if (draft.index === null) {
      const pin: Pin = { format, x: draft.x, y: draft.y, timeSec: video ? draft.timeSec ?? 0 : null, note, ...(draft.clip ? { clipId: draft.clip.id, clipName: pinClipName(draft.clip.name) } : {}), ...(draft.range ? { range: draft.range } : {}) };
      if (pinSource !== null) setStored((ps) => [...ps, { pin, version: pinSource }]);
    } else {
      const at = sourcePins[draft.index]?.at;
      setStored((ps) => ps.map((p, k) => (k === at ? { ...p, pin: { ...p.pin, note } } : p)));
    }
    setDraft(null);
  };
  const removePin = useCallback((i: number) => {
    const at = sourcePins[i]?.at;
    setStored((ps) => ps.filter((_, k) => k !== at));
    setDraft((d) => (d && d.index !== null ? (d.index === i ? null : d.index > i ? { ...d, index: d.index - 1 } : d) : d));
  }, [sourcePins, setStored]);

  // Chat callbacks are stable: the panel re-renders only when the conversation or the comments change.
  const onEditChip = useCallback((i: number) => openPinRef.current(i + 1), []);
  const formatLabel = useCallback((id: string) => boardLabel({ id, preset: presetFor(presets, id), out: null, labels }, locale), [presets, locale, labels]);
  const onSent = useCallback(({ pins: sent }: { pins: Pin[] }) => { setStored((ps) => ps.filter((p) => !sent.includes(p.pin))); setViewing({}); reload(); }, [setStored, reload]);
  // "View vN" of a version card: this format's file as it was in vN.
  const onSelectVersion = useCallback((v: number) => {
    const entry = entryAt(versions, states[source.format], v);
    if (entry !== null) view(source.format, entry);
  }, [versions, states, source.format, view]);
  const actions = useVersionActions({ slug, creative, states, labelOf: formatLabel, resumeFrom: detail?.creative.resumeFrom?.version ?? null, onChanged: reload, onError: setActionError });
  const primaries = (detail?.creative.brief.formats ?? []).filter((f) => states[f] && !states[f]!.follows);
  const appliesTo = useMemo(() => (versions.length && primaries.length > 1 ? {
    primaries: primaries.map((id) => ({ id, label: formatLabel(id), followers: followersOf(states, id).map(formatLabel) })),
    followerOf: (id: string) => states[id]?.follows ?? null,
    // In the editor of one format, a change applies to that format unless the user widens it.
    fallback: primaries.includes(source.format) ? [source.format] : null,
  } : undefined), [versions.length, primaries.join(','), states, formatLabel, source.format]); // eslint-disable-line react-hooks/exhaustive-deps
  const chatLive = useMemo(() => (job ? live.events[job.id] ?? [] : []), [job, live.events]);

  const [compare, setCompare] = useState<{ open: boolean; init: [number, number] } | null>(null);
  /** Compare (the badge): the version on screen against the entry before it in the format's history. */
  const openCompare = () => {
    const s = states[source.format];
    const shown = shownOf(s, viewing[source.format]);
    if (!s || shown === null || s.history.length < 2) return;
    const i = s.history.indexOf(shown);
    const other = s.history[i - 1] ?? s.history[i + 1]!;
    setCompare({ open: true, init: other < shown ? [other, shown] : [shown, other] });
  };
  // Export keeps the version it opened with, even if a new one lands meanwhile.
  const [exporting, setExporting] = useState<{ open: boolean; snapshot: ExportSnapshot } | null>(null);

  if (error && !detail) {
    return (
      <div className="ms-cv-state">
        <Empty icon="warn" title={c.tryAgain} sub={<span role="alert">{c.loadFailed({ detail: error })}</span>}
          action={<Button variant="ink" onClick={reload}><Icon name="refresh" size={13} />{c.tryAgain}</Button>} />
      </div>
    );
  }

  const backButton = <Button className="ms-back ms-fold-3" aria-label={t.web.shell.backAllFormats} title={t.web.shell.backAllFormats} onClick={back}><Icon name="back" size={16} strokeWidth={1.5} /><span className="ms-bar-label">{t.web.shell.backAllFormats}</span></Button>;
  if (!loading && !known) {
    return (
      <div ref={root} className="ms-cv-state">
        {bar?.start ? createPortal(backButton, bar.start) : null}
        <Empty icon="grid" title={f.unknownTitle({ id: format })} sub={f.unknownSub}
          action={<Button variant="ink" onClick={back}><Icon name="back" size={13} />{t.web.shell.backAllFormats}</Button>} />
      </div>
    );
  }

  const cr = detail?.creative ?? null;
  const n = version?.n ?? null;
  // The version's duration against the brief's (decisions log 262): a discreet note, never a change of the brief.
  const briefSec = cr?.brief.durationSec ?? null;
  const offBrief = video && duration > 0 && briefSec !== null && isDurationOffBrief(duration, briefSec)
    ? (version?.origin === 'editor' ? f.briefDurationEdited : f.briefDuration)({ n: formatNumber(locale, briefSec, { maximumFractionDigits: 1 }) })
    : null;
  const meta = [`${width}×${height}`, ratioText({ width, height }), video && duration ? c.seconds({ n: formatNumber(locale, duration, { maximumFractionDigits: 1 }) }) : null, offBrief].filter(Boolean).join(' · ');
  const frameStyle: CSSProperties = zoom === 'fit' || video
    ? { width: `min(100cqw, calc(100cqh * ${width / height}))`, aspectRatio: `${width} / ${height}` }
    : { width: Math.round(width * zoom), aspectRatio: `${width} / ${height}` };
  const lock = !loading && !canComment && version && (out || comp) && pinSource !== null;
  const state = states[format];
  const primaryLabel = state?.follows ? formatLabel(state.follows) : null;
  const primaryStar = state?.follows ? states[state.follows]?.star.version ?? null : null;
  const ready = !loading && (livePlayer ? playerReady : Boolean(out)) && !failed;
  /** The bubble's second line: the time of a frame comment, the clip too, or the range. */
  const bubbleTime = (d: FDraft): string | undefined => {
    if (d.range) return t.web.conversation.noteTitleRange(rangeTimes(locale, d.range));
    const at = video && d.timeSec !== null ? f.pinAt({ time: timecode(d.timeSec) }) : undefined;
    return d.clip ? [t.web.conversation.noteTitleClip({ name: d.clip.name }), at].filter(Boolean).join(' · ') : at;
  };

  return (
    <div ref={root} className={cx('ms-fv', video ? 'ms-fv-video' : 'ms-fv-image')} aria-busy={loading || undefined}>
      {bar?.start ? createPortal(backButton, bar.start) : null}
      {bar?.title ? createPortal(
        <>
          <span className="ms-crumb ms-last ms-fv-crumb">
            <span className="ms-faint" aria-hidden="true">/</span>
            {preset ? <ChannelMark channel={channelOf(preset.channel)} /> : null}
            <b aria-current="page" title={preset ? channelName(preset.channel, locale) : undefined}>{instanceName(preset, format, locale, labels)}</b>
          </span>
          <span className="ms-fv-meta">{meta}</span>
          {out && !out.verified ? <Pill tone="warn" className="ms-cv-state-pill">{t.web.formatUi.unverified}</Pill> : null}
        </>,
        bar.title,
      ) : null}
      {bar?.end ? createPortal(
        <>
          {state && cr && state.follows && primaryLabel ? (
            <span className="ms-fv-badge">
              <FollowerChip label={label} primary={primaryLabel} primaryStar={primaryStar} follower={format} actions={actions} busy={working} />
              <span className="ms-fv-follows">{primaryStar !== null ? t.web.formatVersions.followsStar({ primary: primaryLabel, n: primaryStar }) : t.web.formatVersions.follows({ primary: primaryLabel })}</span>
            </span>
          ) : state && cr ? (
            <span className="ms-fv-badge">
              <FormatBadge slug={slug} creative={creative} label={label} state={state} versions={versions} shown={source.n} resumeFrom={cr.resumeFrom?.version ?? null}
                labelOf={formatLabel} actions={actions} busy={working} onView={(v) => view(format, v)} onCompare={openCompare} />
            </span>
          ) : null}
          {versions.length && cr ? (
            <VersionTimeline slug={slug} creative={creative} versions={versions} resumeFrom={cr.resumeFrom?.version ?? null} actions={actions} buttonRef={versionButton} />
          ) : null}
          {video && cr && detail ? (
            <RenderStatus slug={slug} creative={creative} version={version} format={source.format} label={label} jobs={Object.values(live.jobs)} jobKey={detail.jobKey} busy={working} />
          ) : null}
          <LanguagesButton slug={slug} creative={creative} detail={detail} version={version ?? latest} presets={presets} live={live} onChanged={reload} />
          {comp !== null && !working ? (
            <Button variant="outline" className="ms-fv-duplicate ms-fold-2" aria-label={t.web.instances.duplicate} title={t.web.instances.duplicateHint({ label })} loading={duplicating} onClick={() => void duplicate()}>
              <Icon name="copy" size={13} strokeWidth={1.7} /><span className="ms-bar-label">{t.web.instances.duplicate}</span>
            </Button>
          ) : null}
          {comp !== null && !working && preview.state.kind !== 'legacy' ? (
            <Button variant="outline" className="ms-cv-edit ms-fold-2" aria-label={t.web.editor.editOf({ label })} title={t.web.editor.edit} onClick={openEditor}>
              <Icon name="edit" size={13} strokeWidth={1.7} /><span className="ms-bar-label">{t.web.editor.edit}</span>
            </Button>
          ) : null}
          <Button variant="ink" className="ms-cv-export" disabled={!latest} onClick={() => { if (latest) setExporting({ open: true, snapshot: { versions, states } }); }}>
            <Icon name="download" size={13} strokeWidth={1.7} />{c.export}
          </Button>
        </>,
        bar.end,
      ) : null}

      {video ? (
        <aside className="ms-fv-side ms-fv-scenes" aria-label={f.scenes} data-part="l">
          <div className="ms-fv-side-head"><b>{f.scenes}</b>{duration ? <span>{c.seconds({ n: formatNumber(locale, duration, { maximumFractionDigits: 1 }) })}</span> : null}</div>
          {livePlayer ? (
            <Storyboard comp={viewComp} storyboard={storyboard} state={storyboardState} clock={clock}
              onSeek={(time) => { if (playing) pause(); seek(time); }} disabled={!ready} />
          ) : (
            <div className="ms-fv-soon">
              <span className="ms-fv-soon-icon" aria-hidden="true"><Icon name="clock" size={14} /></span>
              <p>{f.scenesSoon}</p>
            </div>
          )}
        </aside>
      ) : null}

      <main className="ms-fv-main" aria-label={label}>
        <div className="ms-fv-notes">
          {integrity.state ? <IntegrityNotice slug={slug} state={integrity.state} reload={integrity.reload} /> : null}
          {presetsFailure ? <p role="alert" className="ms-cv-note ms-err">{t.web.creative.formatsLoadFailed({ detail: presetsFailure })}</p> : null}
          {cr?.resumeFrom ? <p className="ms-cv-note ms-info">{t.web.creative.resumeNote({ n: cr.resumeFrom.version })}</p> : null}
          {cr && (cr.status === 'error' || cr.status === 'interrupted') && cr.error && !working ? <p role="alert" className="ms-cv-note ms-err">{cr.error}</p> : null}
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
            <div className={cx('ms-fv-media', !loading && !out && !livePlayer && 'ms-empty-frame')} onClick={() => { if (video && (out || livePlayer) && !canComment) toggle(); else if (video && playing) pause(); }}>
              {loading ? (
                <span className="ms-cv-frame-note"><Spinner size={16} label={c.loading} /></span>
              ) : livePlayer && n !== null ? (
                <>
                  {sbPoster && !playerReady ? <img className="ms-fv-poster" src={sbPoster.url} alt="" draggable={false} /> : null}
                  {preview.state.kind === 'ready' ? (
                    <CompositionPlayer key={attempt} session={preview.state.session} title={t.web.render.playerFrame({ label: `${label} v${n}` })}
                      onMedia={setPlayer} onStall={preview.stalled} onShowing={preview.showing} />
                  ) : null}
                  <LocaleOutline player={player} preview={localePreview} />
                  {preview.state.kind === 'loading' || preview.state.kind === 'busy' || preview.state.kind === 'idle' ? (
                    <span className="ms-cplayer-state" role="status">{preview.state.kind === 'busy' ? t.web.render.busy : t.web.render.loading}</span>
                  ) : null}
                  {preview.state.kind === 'failed' ? (
                    <span className="ms-fv-failed" role="alert">
                      <span>{t.web.render.failed({ detail: preview.state.message })}</span>
                      <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); preview.retry(); }}><Icon name="refresh" size={12} />{t.web.render.retry}</Button>
                    </span>
                  ) : null}
                </>
              ) : src && n !== null && video ? (
                <video key={`${src}#${attempt}`} ref={(el) => { media.current = el; }} src={src} poster={poster} preload="auto" playsInline loop={loop} aria-label={`${label} v${n}`}
                  onTimeUpdate={(e) => clock.set(e.currentTarget.currentTime, true)}
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    applyRate(v);
                    if (Number.isFinite(v.duration) && v.duration > 0) setMetaDuration(v.duration);
                    if (pendingSeek.current !== null) { v.currentTime = pendingSeek.current; clock.set(pendingSeek.current, true); pendingSeek.current = null; }
                  }}
                  onDurationChange={(e) => { if (Number.isFinite(e.currentTarget.duration) && e.currentTarget.duration > 0) setMetaDuration(e.currentTarget.duration); }}
                  onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setFailed(true); setPlaying(false); }} />
              ) : src && n !== null ? (
                <img key={src} src={src} alt={`${label} v${n}`} draggable={false} />
              ) : (
                <span className="ms-cv-frame-note">{n !== null ? t.web.formatUi.missingIn({ n }) : latest ? t.web.formatUi.missingIn({ n: latest.n }) : c.notGenerated}</span>
              )}
              {rendering ? <span className="ms-shimmer" aria-hidden="true" /> : null}
              {safe && preset ? <SafeZoneBands preset={preset} /> : null}
              {failed ? (
                <span className="ms-fv-failed" role="alert">
                  <span>{f.videoFailed}</span>
                  <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setAttempt((a) => a + 1); setFailed(false); }}><Icon name="refresh" size={12} />{c.tryAgain}</Button>
                </span>
              ) : null}
              {video && ready && !playing && !canComment ? <span className="ms-fv-bigplay" aria-hidden="true"><Icon name="play" size={22} fill /></span> : null}
              {canComment && ready && (!video || !playing) ? (
                <HitArea clock={clock} video={video} label={label} onPlace={place} />
              ) : null}
            </div>
            {canComment && ready ? <PinLayer clock={clock} video={video} marks={marks} open={draft?.index ?? null} onOpen={openPin} /> : null}
            {draft && canComment ? (
              <PinBubble draft={draft} number={draft.index === null ? pins.length + 1 : draft.index + 1} video={video}
                time={bubbleTime(draft)}
                onText={(text) => setDraft((d) => (d ? { ...d, text } : d))} onCommit={commitDraft} onCancel={() => setDraft(null)}
                onDelete={() => { if (draft.index !== null) removePin(draft.index); }} />
            ) : null}
          </div>
        </section>
        {canComment && ready && !draft && !bandShown && (!video || !playing) ? <CommentHint clock={clock} video={video} /> : null}
        {rangeOpen ? <RangeDialog open playhead={media.current?.currentTime ?? clock.get().time} duration={duration} onSubmit={(r) => { setRangeOpen(false); commentRange(r); }} onCancel={() => setRangeOpen(false)} /> : null}
        {lock ? <div className="ms-cv-hint ms-lock ms-fv-hint" id="ms-fv-comment-lock" role="status">{c.versions.commentsOn({ n: pinSource })}</div> : null}
        {preset?.safeZone && (out || livePlayer) ? (
          <span className="ms-fv-safe-toggle"><Toggle size="sm" on={safe} onChange={setSafe} label={c.safeZones} /><span aria-hidden="true">{c.safeZones}</span></span>
        ) : null}
        {!video && (out || livePlayer) ? (
          <div className="ms-cv-toolbar ms-fv-zoom" role="toolbar" aria-label={f.zoom}>
            <button type="button" className="ms-cv-tool ms-sm" aria-label={c.zoomOut} disabled={scale > 0 && scale <= ZOOMS[0]! + 1e-3} onClick={() => zoomBy(-1)}><Icon name="minus" size={13} /></button>
            <span className="ms-fv-zoom-pct" role="status">{scale ? `${formatNumber(locale, Math.round(scale * 100))}%` : '—'}</span>
            <button type="button" className="ms-cv-tool ms-sm" aria-label={c.zoomIn} disabled={scale >= ZOOMS.at(-1)! - 1e-3} onClick={() => zoomBy(1)}><Icon name="plus" size={13} /></button>
            <span className="ms-cv-tool-sep" aria-hidden="true" />
            <button type="button" className={cx('ms-fv-zoom-btn', zoom === 'fit' && 'ms-on')} aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')}>{f.fit}</button>
            <button type="button" className={cx('ms-fv-zoom-btn', zoom === 1 && 'ms-on')} aria-pressed={zoom === 1} aria-label={f.actual} onClick={() => setZoom(1)}>100%</button>
          </div>
        ) : null}
        {livePlayer && cr ? <LocaleSwitcher brief={cr.brief} preview={localePreview} className="ms-fv-locales" /> : null}
        {video ? (
          <Transport clock={clock} duration={duration} playing={playing} disabled={!ready} marks={canComment ? marks : []} onRange={canComment ? commentRange : undefined} onBand={setBandShown} blocked={rangeOpen || draft !== null} hint={canComment ? f.keys : f.keysLocked}
            extra={canComment && ready ? (
              <>
                {clipComp ? <ClipPicker clock={clock} comp={clipComp} onPick={commentClip} /> : null}
                {duration > 0 ? (
                  <Button size="sm" variant="outline" icon className="ms-fv-rangebtn" aria-label={t.web.conversation.rangeComment} title={t.web.conversation.rangeTip({ keys: 'R' })} aria-keyshortcuts="R" disabled={draft !== null}
                    onClick={() => { if (playing) pause(); setRangeOpen(true); }}><Icon name="comment" size={13} /></Button>
                ) : null}
              </>
            ) : undefined}
            onToggle={toggle} onStep={stepFrame} onSeek={seek} onPause={pause} onResume={play}
            loop={loop} onLoop={setLoop} speed={rate} onSpeed={setRate} />
        ) : null}
      </main>

      <aside className="ms-fv-side ms-fv-panel" aria-label={c.panel} data-part="r">
        <div className="ms-tabs ms-panel ms-fv-tabs"><span className="ms-tab ms-on">{f.chat}</span></div>
        {detail ? (
          <Conversation slug={slug} creative={creative} entries={conversation} approvals={myApprovals} job={job} live={chatLive}
            pins={pins} onRemovePin={removePin} onEditPin={onEditChip} formatName={formatLabel}
            canGenerate={versions.length === 0} onSent={onSent} onSelectVersion={onSelectVersion} snapshots={live.snapshots} appliesTo={appliesTo}
            brief={detail.creative.brief} onBriefSaved={reload} queued={detail.creative.queued} onQueueChanged={reload}
            versionSummary={(vn) => { const v = versions.find((x) => x.n === vn); return v?.origin === 'editor' && v.request ? v.request : null; }} />
        ) : <div className="ms-cv-state"><Spinner size={16} label={c.loading} /></div>}
      </aside>

      {compare ? (
        <CompareDialog open={compare.open} onClose={() => setCompare((s) => (s ? { ...s, open: false } : s))} slug={slug} creative={creative}
          versions={versions} presets={presets} labels={cr?.brief.formatLabels} states={states} format={source.format} initial={compare.init} actions={actions} />
      ) : null}
      <ExportDialog open={Boolean(exporting?.open)} onClose={() => setExporting((s) => (s ? { ...s, open: false } : s))} slug={slug} creative={creative}
        title={cr?.title ?? ''} snapshot={exporting?.snapshot ?? null} presets={presets} labels={cr?.brief.formatLabels} pattern={exportNamePattern ?? DEFAULT_EXPORT_NAME_PATTERN} onSettings={onSettings}
        {...(cr && creativeLocales(cr.brief) ? { locales: creativeLocales(cr.brief)! } : {})} />
    </div>
  );
}

/** The paused picture takes the click that places a comment (point 38: on the frame at the current time). */
function HitArea({ clock, video, label, onPlace }: { clock: Clock; video: boolean; label: string; onPlace(e: MouseEvent<HTMLButtonElement>): void }) {
  const t = useT();
  const { settled } = useClock(clock);
  return (
    <button type="button" className="ms-cv-hit" aria-label={video ? t.web.formatView.commentFrame({ time: timecode(settled) }) : t.web.canvas.commentOn({ label })} onClick={onPlace} />
  );
}

/** The comment markers on the picture: on a video only within ±0.5 s of their time (point 38). */
function PinLayer({ clock, video, marks, open, onOpen }: { clock: Clock; video: boolean; marks: Mark[]; open: number | null; onOpen(number: number): void }) {
  const c = useT().web.canvas;
  const { time } = useClock(clock);
  const visible = video ? marks.filter((m) => m.pin.timeSec === null || (m.pin.range ? time >= m.pin.range.start - 1e-6 && time <= m.pin.range.end + 1e-6 : Math.abs(m.pin.timeSec - time) <= PIN_WINDOW + 1e-6)) : marks;
  return (
    <>
      {visible.map(({ pin, number }) => (
        <button key={number} type="button" className={cx('ms-cv-pin', open === number - 1 && 'ms-on')} style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
          aria-label={c.pin.edit({ n: number })} title={pin.note} onClick={(e) => { e.stopPropagation(); onOpen(number); }}>
          {number}
        </button>
      ))}
    </>
  );
}

/** "Comment on a clip": the clips playing at the playhead, topmost last; choosing one starts a comment on it (`C` takes the topmost). */
function ClipPicker({ clock, comp, onPick }: { clock: Clock; comp: Composition; onPick(id: string): void }) {
  const cv = useT().web.conversation;
  const { settled } = useClock(clock);
  const clips = clipsAt(comp, settled);
  return (
    <span className="ms-fv-clippick" data-part="clip-picker">
      <Select<string> variant="pill" icon="comment" label={cv.clipPick} value="" display={clips.length ? cv.clipPick : cv.clipPickNone} disabled={clips.length === 0}
        options={[{ value: '', label: cv.clipPick, disabled: true }, ...[...clips].reverse().map((x) => ({ value: x.id, label: clipLabel(x) }))]}
        onChange={(id) => { if (id) onPick(id); }} />
    </span>
  );
}

function CommentHint({ clock, video }: { clock: Clock; video: boolean }) {
  const f = useT().web.formatView;
  const { settled } = useClock(clock);
  return <div className="ms-cv-hint ms-fv-hint" role="status">{video ? f.commentAt({ time: timecode(settled) }) : f.commentImage}</div>;
}

/**
 * The Scenes column of a v2 version (Task 8; UX feedback 1, Task 2): one row per scene of the composition, in time order (a
 * composition without scenes: one "Whole video" row), built from the composition at once; a click seeks there and the
 * scene the playhead is in is marked. The storyboard's thumbnails fill the rows in when they arrive (a skeleton until then,
 * a placeholder when there is none): the list never waits for them.
 */
function Storyboard({ comp, storyboard, state, clock, onSeek, disabled }: {
  comp: Composition | 'failed' | null; storyboard: StoryboardView | null; state: StoryboardState; clock: Clock; onSeek(t: number): void; disabled: boolean;
}) {
  const t = useT();
  const r = t.web.render;
  const locale = useLocale();
  const { time } = useClock(clock);
  const rows = useMemo(() => (comp && comp !== 'failed' ? sceneRows(comp, r) : []), [comp, r]);
  if (comp === null) return <p className="ms-fv-sb-note" role="status">{r.scenesLoading}</p>;
  if (comp === 'failed') return <p className="ms-fv-sb-note" role="status">{r.scenesUnavailable}</p>;
  const current = rowAt(rows, time);
  const waiting = state === 'loading' || state === 'busy';
  return (
    <>
      <ol className="ms-fv-sb" aria-label={r.storyboard}>
        {rows.map((row, i) => (
          <li key={row.id ?? 'whole'}>
            <button type="button" className={cx('ms-fv-sb-item', i === current && 'ms-on')} aria-current={i === current || undefined} disabled={disabled}
              aria-label={r.sceneAt({ name: row.name, time: timecode(row.start) })} onClick={() => onSeek(row.start)}>
              <SceneThumb frame={frameFor(storyboard, row)} state={state} width={comp.width} height={comp.height} />
              <span className="ms-fv-sb-text"><b>{row.name}</b><span>{timecode(row.start)} · {t.web.editor.sceneLength({ seconds: formatNumber(locale, row.duration, { maximumFractionDigits: 2 }) })}</span></span>
            </button>
          </li>
        ))}
      </ol>
      <span className="ms-sr" role="status" aria-live="polite">{waiting ? r.storyboardLoading : ''}</span>
    </>
  );
}
