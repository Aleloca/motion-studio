// Creative · canvas (spec §6.2 #6, §6.1 creative bar), ported from the prototype's CanvasView / VersionsPopover /
// PinComposer and the Canvas boards: formats column by channel, the boards in proportion on a dotted canvas, Figma-style
// comments that become chips of the composer, the Chat · Comments · Brief panel, the version history with Compare, and
// Export. Replaces the interim CreativePage. A board opens in the format view (screens/FormatView.tsx) with T3.
// Decision 973: no floating tool bar. The zoom follows the trackpad (pinch around the pointer, two-finger scroll pans) and
// ⌘+ / ⌘− / ⌘0; a comment starts from a board's own Comment button; safe zones are in the format view only. A variant group
// is a grid of cards, one per variant, to compare and choose ("Selezione finale" is the page's main action).
import { ProblemList } from '../components/ProblemList.tsx';
import { IntegrityNotice, useIntegrity } from '../components/IntegrityNotice.tsx';
import { entriesOfVariant, turnEndOf } from '@motion-studio/shared';
import { addTokens, channelName, DEFAULT_EXPORT_NAME_PATTERN, outputWarningText, shownTotal, packInstancesOf, type ConversationEntry, type JobSummary, type CreativeDetail, type CreativeStatus, type FormatPreset, type Pin, type UsageReport, type VariantId, type VariantMember, type VersionEntry, type WorkspaceSettings } from '@motion-studio/shared';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { api, type GroupExportPlanItem } from '../api.ts';
import { BriefEditor } from '../components/BriefEditor.tsx';
import { servicesSummary } from '../components/ServicesSelector.tsx';
import { Conversation } from '../components/Conversation.tsx';
import type { EventsState } from '../eventsReducer.ts';
import { formatDate, formatNumber, TIME_OF_DAY, useLocale, useT } from '../i18n.tsx';
import { D, enter, flip, pulse, stagger, usePageShortcut } from '../motion/index.ts';
import { instanceName, presetFor } from '../instances.ts';
import { href, routeKey } from '../routes.ts';
import { useBarClaim } from '../shell/barSlots.ts';
import { setFrameOrigin, setShownVersions, takeFrameOrigin, takeShownVersions } from '../shell/intents.ts';
import { go, ShellContext } from '../shell/ShellContext.tsx';
import { Button, ChannelMark, Empty, Icon, Input, NavItem, Pill, Popover, Spinner, Tabs, Tag, Toggle, cx, toast } from '../ui/index.ts';
import { CreativeActionsMenu, type RemovalDone } from './creative/CreativeRemoval.tsx';
import { useCreative } from '../useCreative.ts';
import { jobLiveTokens, jobUsagePartial } from '../usageLive.ts';
import { costText, TokenCount, UsageBadge } from '../shell/Tokens.tsx';
import { boardLabel, boardName, CanvasBoard, type Draft, type Tool } from './CanvasBoard.tsx';
import { appliesGroups, boardsWith, canvasGroups, canvasLines, fitBoards, FIT_MIN, groupByChannel, PACK_GROUP, ratioText, type BoardModel } from './canvasModel.ts';
import { CompareDialog } from './CompareDialog.tsx';
import { channelOf } from './creativeState.ts';
import { ExportDialog, type ExportSnapshot } from './ExportDialog.tsx';
import { ExportButton } from './ExportButton.tsx';
import { StorePackExport } from './creative/StorePackExport.tsx';
import { LanguagesButton } from './creative/LanguagesButton.tsx';
import { RenderLanguagesDialog } from './creative/RenderLanguagesDialog.tsx';
import { creativeLocales, packLanguageGaps } from './creative/languagesModel.ts';
import { activatesControl, bare, inOverlay, isTyping } from './keys.ts';
import { useChatPins } from './pendingPins.ts';
import { FollowerChip, FormatBadge, useNewVersionNotice, useVersionActions, VersionTimeline } from './FormatVersions.tsx';
import { boardSource, entryAt, followersOf, formatStates, isRendering, renderingOf, shownOf, type FormatState } from './versionModel.ts';
import { boardRender, compositionOf } from './renderModel.ts';
import './canvas.css';
import { message } from './common.tsx';
import { isVideoFile } from '../media.ts';
import { usePinFrames } from './pinFrames.ts';
import { rangeSeconds } from './pinModel.ts';
import { retryTurn } from './creativeState.ts';
import { chatTick, useGroupChat } from './variants/useGroupChat.ts';
import { AddVariantDialog, EditDirectionDialog, type BaseChoice } from './variants/AddVariantDialog.tsx';
import { FinalSelection, type ChooserFormat } from './variants/FinalSelection.tsx';
import { GroupStar } from './variants/GroupStar.tsx';
import { useVariantMembers } from './variants/useVariantMembers.ts';
import { VariantCard } from './variants/VariantCard.tsx';
import type { ChatTarget } from './variants/VariantSelector.tsx';
import { CARD_PAD, cardColumns, cardWidth, discardBlock, discardedSelf, fitCards, isRunning, memberLive, readyToChoose, rowState, selectionRows, shortName, shownMembers, thumbZoom, upper } from './variants/variantModel.ts';
import { pinchZoom, scrollAfterZoom, stepZoom, ZOOM_MIN, zoomKey } from './canvasZoom.ts';
import { setMenuZoomHandler } from '../shell/menuZoom.ts';
import './variants/variants.css';

/** T4 only while the player's rect is fresh (boards that arrive later cascade in). */
const FLIP_WINDOW_MS = 400;


export interface CreativeCanvasProps {
  slug: string;
  creative: string;
  live: EventsState;
  /** The workspace's export file name pattern (Export starts with it); the default one when unknown. */
  exportNamePattern?: string;
  /** The workspace settings after Export's "Save as default". */
  onSettings?(next: WorkspaceSettings): void;
}

/**
 * Phase 15: what the page remembers about a variant group while the open variant changes (the body remounts on a change).
 * `comment`: a format to start commenting on once the variant just opened is shown (its card's Comment, decision 973).
 */
interface VariantUi { route: string; focus: string | null; all: boolean; showDiscarded: boolean; comment: string | null }
type CanvasBodyProps = CreativeCanvasProps & { routeCreative: string; variantUi: VariantUi; onVariantUi(patch: Partial<Omit<VariantUi, 'route'>>): void };

/**
 * The canvas of a creative. Outside a variant group this is the creative's canvas and nothing else. In a group the same canvas
 * works on the variant the user picked (chat, versions, comments, brief), and shows the other variants' boards beside it.
 */
export function CreativeCanvas(props: CreativeCanvasProps) {
  const [ui, setUi] = useState<VariantUi>({ route: props.creative, focus: null, all: false, showDiscarded: false, comment: null });
  const own: VariantUi = ui.route === props.creative ? ui : { route: props.creative, focus: null, all: false, showDiscarded: false, comment: null };
  return (
    <CanvasBody key={own.focus ?? 'route'} {...props} creative={own.focus ?? props.creative} routeCreative={props.creative} variantUi={own}
      onVariantUi={(patch) => setUi({ ...own, ...patch })} />
  );
}

function CanvasBody({ slug, creative, routeCreative, live, exportNamePattern, onSettings, variantUi, onVariantUi }: CanvasBodyProps) {
  const t = useT();
  const integrity = useIntegrity(slug, live);
  const c = t.web.canvas;
  const locale = useLocale();
  const shell = useContext(ShellContext);
  const root = useRef<HTMLDivElement>(null);
  // Decision 980: a group's one chat is read again when any of its members changes.
  const { detail, conversation, error, reload } = useCreative(slug, creative, chatTick(live.creativeTicks, slug, creative));
  const groupChat = useGroupChat(live, slug, creative, detail);
  // Phase 15: the variant group of this creative; null outside any group, and for an orphan sister (it opens as a single creative).
  const vdetail = detail?.variants;
  const group = vdetail && !vdetail.orphan ? vdetail : null;
  const members = useVariantMembers(slug, group?.group ?? null, creative, group?.missing ?? [], live.creativeTicks);
  // "Selezione finale" (final wave I1): the core's group export plan, the selection the export copies. Read again after a
  // group change made here (`planSeq`) and whenever a member changes (its live tick).
  const [planSeq, setPlanSeq] = useState(0);
  const [groupPlan, setGroupPlan] = useState<GroupExportPlanItem[] | null>(null);
  // The group's canonical formats, as the core answers them with the plan (the host's pending brief, else its own); null: not known.
  const [planFormats, setPlanFormats] = useState<string[] | null>(null);
  const planKey = group ? group.group.members.map((m) => `${m.slug}:${live.creativeTicks[`${slug}/${m.slug}`] ?? 0}`).join('|') : '';
  useEffect(() => {
    if (!group) { setGroupPlan(null); setPlanFormats(null); return; }
    let alive = true;
    Promise.resolve().then(() => api.groupExportPlan(slug, creative))
      .then((r) => { if (alive) { setGroupPlan(r.items); setPlanFormats(r.formats ?? null); } }, () => { if (alive) { setGroupPlan([]); setPlanFormats(null); } });
    return () => { alive = false; };
  }, [slug, creative, Boolean(group), planKey, planSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  // This page owns the creative bar only while it is the route's page (a leaving page stays mounted ~200 ms).
  const ownKey = routeKey({ name: 'creative', slug, creative: routeCreative });
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

  // Versions (spec §3.1): every board shows its format's ★ (a follower: its primary's), or the version the user views on
  // it (`viewing`, format → vN, never the ★ itself). Sending a change shows the ★s again. What is viewed in the format view
  // comes back with T4.
  const versions = useMemo(() => detail?.versions ?? [], [detail]);
  const latest = versions.at(-1) ?? null;
  const states = useMemo<Record<string, FormatState>>(() => (detail ? formatStates(detail, presets) : {}), [detail, presets]);
  const [viewing, setViewing] = useState<Record<string, number>>(() => takeShownVersions(`${slug}/${creative}`));
  const view = (format: string, n: number) => setViewing((v) => {
    const next = { ...v };
    if (n === states[format]?.star.version) delete next[format]; else next[format] = n;
    return next;
  });
  /** "View vN" of a version card: every board shows its file as it was in vN (formats vN does not have keep theirs). */
  const viewAll = (n: number) => setViewing((v) => {
    const next = { ...v };
    for (const s of Object.values(states)) {
      if (s.follows) continue;
      const entry = entryAt(versions, s, n);
      if (entry === null) continue;
      if (entry === s.star.version) delete next[s.id]; else next[s.id] = entry;
    }
    return next;
  });
  const versionButton = useRef<HTMLButtonElement>(null);
  const [history, setHistory] = useState(false);
  // T11: a new version → toast and a spring on the version badge (the frames reveal themselves on load).
  useNewVersionNotice(Boolean(detail), latest?.n ?? null, active, versionButton);

  // Decision 980: the group's one chat shows every variant's approvals (the one paid-services card of a variant run included).
  const myApprovals = useMemo(() => Object.values(live.approvals).filter(groupChat.shows), [live.approvals, groupChat]);
  const job = useMemo(() => {
    if (!detail) return undefined;
    const mine = Object.values(live.jobs).filter((j) => j.key === detail.jobKey);
    return mine.find((j) => j.state === 'queued' || j.state === 'running') ?? mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }, [live.jobs, detail]);
  const working = job?.state === 'queued' || job?.state === 'running';
  // Phase 3 of the single agent: the chat follows the group's turn (the composer sends to the group).
  const chatJob = groupChat.single ? groupChat.groupJob : job;
  // Per board: a targeted job renders its formats and their followers only (spec §2.5).
  const rendering = useMemo(() => renderingOf(job, states), [job, states]);

  // Boards.
  const boards = useMemo(() => {
    if (!detail || !presetsLoaded || presetsFailure) return [];
    return boardsWith(detail.creative.brief.formats, presets, versions, (id) => boardSource(states, id, viewing), detail.creative.brief.formatLabels);
  }, [detail, presets, presetsLoaded, presetsFailure, versions, states, viewing]);
  const [sel, setSel] = useState<string | null>(null);

  // Comment mode and zoom (decision 973: no tool bar). `commentOn`: the one board a Comment button started on (null: every
  // board that takes comments, from the Comments tab). A variant opened by its card's Comment starts in comment mode.
  const [tool, setTool] = useState<Tool>(variantUi.comment ? 'comment' : 'select');
  const [commentOn, setCommentOn] = useState<string | null>(variantUi.comment);
  useEffect(() => { if (variantUi.comment) onVariantUi({ comment: null }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const startComment = (id: string | null) => { setDraft(null); setCommentOn(id); setTool('comment'); if (id) setSel(id); };
  const [zoom, setZoom] = useState(1);

  // Comments: pending pins (shared with the format view), the bubble being written. The core crops pin frames from
  // its pin source (core creative-turns: the version resumed from, else the latest): comments are placed, shown and
  // sent only on that version. `sourcePins` are the pending pins of the source, with their place in the store; a draft's
  // `index` is a position in `sourcePins`.
  const pinSource = detail ? detail.creative.resumeFrom?.version ?? latest?.n ?? null : null;
  // A board takes comments when its file is the one the pin source has for its format (a follower: its primary's).
  // A board shows a picture: its file, or (v2) its composition, rendered or not.
  const hasPicture = useCallback((b: BoardModel & { n: number | null }) => b.out !== null
    || compositionOf(versions.find((v) => v.n === b.n), boardSource(states, b.id, viewing).format) !== null, [versions, states, viewing]);
  const commentable = useMemo(() => new Set(boards.filter((b) => {
    const src = boardSource(states, b.id, viewing);
    return hasPicture(b) && b.n !== null && entryAt(versions, states[src.format], pinSource) === b.n;
  }).map((b) => b.id)), [boards, states, viewing, versions, pinSource, hasPicture]);
  const canComment = commentable.size > 0;
  const commentLock = pinSource !== null && boards.some((b) => hasPicture(b) && !commentable.has(b.id));
  // Phase 3 of the single agent: in a group with one agent the pending comments are the group's (each with its variant).
  const { stored, setStored, others: otherPins, drop: dropPins } = useChatPins(slug, creative, groupChat.pinScope);
  const sourcePins = useMemo(() => stored.flatMap((p, i) => (p.version === pinSource ? [{ pin: p.pin, at: i }] : [])), [stored, pinSource]);
  const pins = useMemo(() => sourcePins.map((p) => p.pin), [sourcePins]);
  const [draft, setDraft] = useState<Draft | null>(null);
  // Another version on screen (or a new pin source): no comment tool, no bubble. Not before the boards are known.
  useEffect(() => {
    if (canComment || !detail || !presetsLoaded) return;
    setDraft(null);
    setTool((tl) => (tl === 'comment' ? 'select' : tl));
  }, [canComment, Boolean(detail), presetsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setDraft(null); }, [pinSource]);
  // A bubble on a board that no longer takes comments (another version viewed there) closes.
  useEffect(() => { setDraft((d) => (d && !commentable.has(d.format) ? null : d)); }, [commentable]);
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
    if (!pin || pinSource === null) return;
    // Its board shows another version: back to the file the comment is on, then open it there.
    if (!commentable.has(pin.format)) {
      const src = boardSource(states, pin.format, viewing).format;
      const entry = entryAt(versions, states[src], pinSource);
      if (entry === null) return;
      view(src, entry);
    }
    setSel(pin.format);
    setDraft({ format: pin.format, x: pin.x, y: pin.y, text: pin.note ?? '', index: number - 1 });
    reveal(pin.format);
  };
  const commitDraft = () => {
    if (!draft) return;
    const note = draft.text.trim();
    if (!note) return;
    if (draft.index === null) {
      const b = boards.find((x) => x.id === draft.format);
      // On the canvas a video comment is at 0 s; frame-accurate comments come with the format view. A composition without
      // a render is a video when its format is.
      const isVideo = b?.out ? isVideoFile(b.out.file) : b?.preset?.kind === 'video';
      const pin: Pin = { format: draft.format, x: draft.x, y: draft.y, timeSec: isVideo ? 0 : null, note };
      if (pinSource !== null) setStored((ps) => [...ps, { pin, version: pinSource }]);
    } else {
      const at = sourcePins[draft.index]?.at;
      setStored((ps) => ps.map((p, k) => (k === at ? { ...p, pin: { ...p.pin, note } } : p)));
    }
    setDraft(null);
    setTool('select');
    setCommentOn(null);
  };
  const removePin = (i: number) => {
    const at = sourcePins[i]?.at;
    setStored((ps) => ps.filter((_, k) => k !== at));
    setDraft((d) => (d && d.index !== null ? (d.index === i ? null : d.index > i ? { ...d, index: d.index - 1 } : d) : d));
  };

  // Keyboard: Esc, F2, ⌘+ / ⌘− / ⌘0 (never while typing, but the zoom; never from a page that is leaving).
  usePageShortcut(root, (e) => e.key === 'Escape' && !isTyping(e) && !inOverlay(e) && (tool !== 'select' || draft !== null), () => { setDraft(null); setTool('select'); setCommentOn(null); });
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
  const formatLabel = (id: string) => boardLabel({ id, preset: presetFor(presets, id), out: null, labels: detail?.creative.brief.formatLabels }, locale);
  const actions = useVersionActions({ slug, creative, states, labelOf: formatLabel, resumeFrom: detail?.creative.resumeFrom?.version ?? null, onChanged: reload, onError: setActionError,
    // In a variant group the ★ is the group's: variant and version, written through the host.
    ...(group ? { groupPick: (format: string, n: number | null) => api.setVariantPick(slug, group.host, format, n === null ? null : { slug: creative, version: n }) } : {}) });
  // Renders of v2 versions (Task 8): a board's Retry and its menu's "Render vN" (decision 974: the bar has Export only).
  const jobList = useMemo(() => Object.values(live.jobs), [live.jobs]);
  // A creative with languages asks which ones first (Phase 12); the others render at once.
  const [renderPlan, setRenderPlan] = useState<Array<[number, string[]]> | null>(null);
  const renderNow = (list: Array<[number, string[]]>) => {
    if (detail?.creative.brief.locales?.extra.length) { setRenderPlan(list); return; }
    // One request per version: each starts or not on its own, and the toast says which.
    void Promise.allSettled(list.map(([n, formats]) => Promise.resolve().then(() => api.renderVersion(slug, creative, n, formats)))).then((results) => {
      const started = results.reduce((k, r, i) => k + (r.status === 'fulfilled' ? list[i]![1].length : 0), 0);
      const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [{ n: list[i]![0], formats: list[i]![1], detail: message(r.reason) }] : []));
      if (!failed.length) { toast.show(t.web.render.started({ count: started }), { tone: 'ok' }); return; }
      const what = failed.map((f) => `${f.formats.map(formatLabel).join(', ')} v${f.n}`).join('; ');
      toast.show(started > 0
        ? t.web.render.startedPartly({ count: started, list: what, detail: failed[0]!.detail })
        : t.web.render.startFailed({ detail: failed[0]!.detail }));
    });
  };

  const [compare, setCompare] = useState<{ open: boolean; init: [number, number]; format: string } | null>(null);
  /** Compare of a format (its badge): the version on screen against the entry before it in the format's history. */
  const openCompare = (format: string) => {
    const s = states[format];
    const shown = shownOf(s, viewing[format]);
    if (!s || shown === null || s.history.length < 2) return;
    const i = s.history.indexOf(shown);
    const other = s.history[i - 1] ?? s.history[i + 1]!;
    setCompare({ open: true, init: other < shown ? [other, shown] : [shown, other], format });
  };
  const [exporting, setExporting] = useState<{ open: boolean; snapshot: ExportSnapshot } | null>(null);
  const [packExport, setPackExport] = useState(false);
  // Phase 15: variant UI state: a selected board of another variant (`<letter>:<format>`), the dialogs, a busy member.
  const [vsel, setVsel] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [chooser, setChooser] = useState(false);
  const [editDir, setEditDir] = useState<VariantMember | null>(null);
  const [exportingMember, setExportingMember] = useState<{ open: boolean; detail: CreativeDetail; snapshot: ExportSnapshot } | null>(null);
  const [vbusy, setVbusy] = useState<string | null>(null);
  // Phase 14: the instances of the creative's store pack (`storePackFormats`); a store preset picked by hand is not one of them.
  const storePack = detail?.creative.brief.storePack;
  const packIds = useMemo(() => new Set(storePack ? packInstancesOf(storePack) : []), [storePack]);

  // Open a board in the format view (T3): its rect goes along for the shared-element transition.
  const openEditor = (id: string, frame: HTMLElement) => {
    setFrameOrigin(`format:${slug}/${creative}/${id}`, frame.getBoundingClientRect());
    setShownVersions(`${slug}/${creative}`, viewing);
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

  // A middle-button drag moves the canvas (the Hand tool left with the tool bar: two-finger scrolling does the same).
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const v = viewport.current;
    if (!v || e.button !== 1) return;
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
  // when the viewport or the boards change size (a window resize, a format added); after that the zoom is theirs (⌘0 fits
  // again). Decision 973: in a variant group the zoom fits the variants' cards side by side.
  const userZoomed = useRef(false);
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 });
  const viewW = viewSize.width;
  const modelOf = (d: CreativeDetail) => {
    const st = formatStates(d, presets);
    return { st, bs: boardsWith(d.creative.brief.formats, presets, d.versions, (id) => boardSource(st, id, {}), d.creative.brief.formatLabels) };
  };
  const shownMs = group ? shownMembers(group.group, variantUi.showDiscarded).filter((m) => !group.missing.includes(m.letter)) : [];
  const boardsOfMember = (m: VariantMember): Array<BoardModel & { n: number | null }> => (m.slug === creative ? boards : members[m.slug] ? modelOf(members[m.slug]!).bs : []);
  const cardCount = group ? shownMembers(group.group, variantUi.showDiscarded).length : 0;
  const fitKey = group ? `g:${cardCount}` : boards.map((b) => `${b.id}:${b.preset?.width ?? 0}x${b.preset?.height ?? 0}`).join('|');
  const fitNow = useRef<() => number | null>(() => null);
  fitNow.current = () => {
    const v = viewport.current;
    if (!v) return null;
    return group ? fitCards(cardCount, v.clientWidth, ZOOM_MIN) : fitBoards(canvasGroups(boards, packIds), { width: v.clientWidth, height: v.clientHeight }, FIT_MIN);
  };
  useLayoutEffect(() => {
    const v = viewport.current;
    if (!v || !boards.length) return;
    const fit = () => {
      setViewSize((w) => (w.width === v.clientWidth && w.height === v.clientHeight ? w : { width: v.clientWidth, height: v.clientHeight }));
      if (userZoomed.current) return;
      const z = fitNow.current();
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
  // Report 40: a canvas that opened below 50% (many boards) can be zoomed back down to where it opened.
  const zoomMin = () => Math.min(ZOOM_MIN, group ? ZOOM_MIN : fitNow.current() ?? ZOOM_MIN);
  // ⌘+ / ⌘− step, ⌘0 fits again (and lets the canvas refit on resize, as when it opened).
  const zoomStep = (k: 'in' | 'out' | 'fit') => {
    if (k === 'fit') { userZoomed.current = false; const z = fitNow.current(); if (z !== null) setZoom(z); return; }
    zoomBy((z) => stepZoom(z, k === 'in' ? 1 : -1, zoomMin()));
  };
  usePageShortcut(root, (e) => zoomKey(e) !== null && !inOverlay(e) && Boolean(detail), (e) => zoomStep(zoomKey(e)!));
  // Desktop: the View menu's ⌘+ / ⌘− / ⌘0 arrive over the bridge (on macOS the menu takes the keys first): the same path,
  // while this canvas is the page shown (decision 1055).
  const zoomStepNow = useRef(zoomStep);
  zoomStepNow.current = zoomStep;
  const canZoom = active && Boolean(detail);
  useEffect(() => (canZoom ? setMenuZoomHandler((kind) => zoomStepNow.current(kind === 'reset' ? 'fit' : kind)) : undefined), [canZoom]);
  // A trackpad pinch arrives as a wheel event with ctrlKey (Chromium, Electron): the canvas zooms around the pointer and the
  // page never zooms. Any other wheel (two-finger scroll) scrolls the canvas as usual.
  const zoomNow = useRef(zoom);
  zoomNow.current = zoom;
  const zoomMinNow = useRef(zoomMin);
  zoomMinNow.current = zoomMin;
  const pinchAnchor = useRef<{ scroll: { left: number; top: number }; pointer: { x: number; y: number }; from: number } | null>(null);
  useEffect(() => {
    const v = viewport.current;
    if (!v) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const from = zoomNow.current;
      const to = pinchZoom(from, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY, zoomMinNow.current());
      if (to === from) return;
      const r = v.getBoundingClientRect();
      // The first event of a gesture anchors it; the next ones (before a render) keep that anchor.
      pinchAnchor.current ??= { scroll: { left: v.scrollLeft, top: v.scrollTop }, pointer: { x: e.clientX - r.left, y: e.clientY - r.top }, from };
      zoomNow.current = to;
      zoomBy(() => to);
    };
    v.addEventListener('wheel', onWheel, { passive: false });
    return () => v.removeEventListener('wheel', onWheel);
  }, [Boolean(detail)]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const a = pinchAnchor.current;
    const v = viewport.current;
    pinchAnchor.current = null;
    if (!a || !v) return;
    const next = scrollAfterZoom(a.scroll, a.pointer, a.from, zoom);
    v.scrollLeft = next.left;
    v.scrollTop = next.top;
  }, [zoom]);

  // Generate (no version yet).
  const [starting, setStarting] = useState(false);
  const generate = () => {
    setStarting(true);
    // A group starts together (one paid-services card): the open variant and every other active one that has no version yet
    // (all of them, when the group has not started). A variant that already has versions is left alone.
    const activeMs = shownMs.filter((m) => m.status === 'active');
    const fresh = activeMs.filter((m) => m.slug === creative || members[m.slug]?.versions.length === 0); // a member not loaded yet is not known to be empty
    const fanOut = group !== null && fresh.length > 0 && (fresh.length === activeMs.length || fresh.length > 1);
    const targets = fresh.length === activeMs.length ? 'all-active' as const : fresh.map((m) => m.letter);
    Promise.resolve().then((): Promise<unknown> => (fanOut && group ? api.runVariants(slug, group.host, { targets, request: null }) : api.sendCreativeTurn(slug, creative, {})))
      .then(() => { setViewing({}); reload(); })
      .catch((e: unknown) => toast.show(c.generateFailed({ detail: message(e) })))
      .finally(() => setStarting(false));
  };

  const [tab, setTab] = useState<'chat' | 'comments' | 'brief'>('chat');
  // The Comments tab is this variant's (its versions applied them): its own entries of the group's one chat.
  const sent = useMemo(() => sentComments(group ? entriesOfVariant(conversation, group.letter) : conversation), [conversation, group]);

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
  const version = latest;
  // Phase 15 (final wave I2): a discarded variant is read-only until restored; its Brief tab too, except A's (the host
  // carries the group's brief, decisions log 830).
  const self = discardedSelf(detail.variants);
  const readOnly = self.discarded ? t.web.variantGroup.discardedReadOnly : null;
  const busyLinks = working;
  /** The format column (spec §3.1): "★ v5", or "—" before the format has a version. A follower has none (see `followsOf`). */
  const formatSide = (id: string, preset: FormatPreset | null) => {
    const s = states[id];
    // In a group the column reads the group's plan, not this variant's own star (see `groupSide`).
    if (group) {
      const host = group.group.members.find((m) => m.slug === creative);
      const n = boards.find((x) => x.id === id)?.n ?? null;
      if (host && n !== null) return groupSide(host, id, n).text;
    }
    if (s?.star.version != null) return `★ v${s.star.version}`;
    return versions.length ? '—' : preset ? ratioText(preset) : '';
  };
  /** The open variant's side text in a group also tells where its ★ comes from (`data-source`) and, for the default rule, why. */
  const sideAttrs = (b: BoardModel & { n: number | null }) => {
    const host = group?.group.members.find((m) => m.slug === creative);
    if (!host || b.n === null) return {};
    const sd = groupSide(host, b.id, b.n);
    return { ...(sd.source ? { 'data-source': sd.source } : {}), ...(sd.title ? { title: sd.title } : {}) };
  };
  /** "follows Story/Reel 9:16": a follower's second, muted line in the format column, under its never-truncated name. */
  const followsOf = (id: string) => {
    const primary = states[id]?.follows;
    if (!primary) return null;
    return t.web.formatVersions.follows({ primary: instanceName(presetFor(presets, primary), primary, locale, cr.brief.formatLabels) });
  };
  const primaries = cr.brief.formats.filter((f) => states[f] && !states[f]!.follows);
  const appliesTo = versions.length && primaries.length > 1 ? {
    primaries: primaries.map((id) => ({ id, label: formatLabel(id), followers: followersOf(states, id).map(formatLabel) })),
    followerOf: (id: string) => states[id]?.follows ?? null,
    groups: appliesGroups(primaries, presets, cr.brief, locale, t.web.formatUi.other),
  } : undefined;
  // The pack's group is there whenever the creative has a pack, even if its instances were all taken out by hand: the export stays reachable.
  const columnGroups = groupByChannel(boards, packIds);
  if (storePack && !columnGroups.some(([ch]) => ch === PACK_GROUP)) columnGroups.push([PACK_GROUP, []]);
  // Report 40: the canvas's lines follow the formats column's groups, wrapped at the zoom the canvas opens at (the user's zoom
  // scales them, it does not wrap them again).
  const lines = (() => {
    const groups = canvasGroups(boards, packIds);
    const at = fitBoards(groups, viewSize, FIT_MIN);
    return canvasLines(groups, at ?? 1, at === null ? null : viewSize.width);
  })();
  const pinsOf = (id: string) => pins.map((pin, i) => ({ pin, number: i + 1 })).filter((x) => x.pin.format === id);
  const badgeOf = (b: BoardModel & { n: number | null }) => {
    const s = states[b.id];
    if (!s) return { badge: null, note: null };
    // A follower of a variant's card: its plain version and "follows …" (it is chosen with its primary, never alone).
    if (group && s.follows) return { badge: b.n === null ? null : <span className="ms-vbadge ms-vver">v{b.n}</span>, note: followsOf(b.id) };
    if (s.follows) {
      const primary = formatLabel(s.follows);
      // In the narrow header the primary goes by its format name, as the column does (the menu keeps the full label).
      const short = instanceName(presetFor(presets, s.follows), s.follows, locale, cr.brief.formatLabels);
      const star = states[s.follows]?.star.version ?? null;
      return {
        badge: <FollowerChip label={formatLabel(b.id)} primary={primary} short={short} primaryStar={star} follower={b.id} actions={actions} busy={busyLinks}
          missing={s.starFileMissing} />,
        note: star !== null ? t.web.formatVersions.followsStar({ primary: short, n: star }) : t.web.formatVersions.follows({ primary: short }),
      };
    }
    const shownVersion = b.n !== null ? versions.find((v) => v.n === b.n) : undefined;
    const r = boardRender(shownVersion, b.id, jobList, detail.jobKey);
    const canRender = b.n !== null && r !== null && r.kind !== 'queued' && r.kind !== 'rendering';
    // Phase 15: in a group the card shows the GROUP's ★ ("Scegli" / "Scelta") and the same plain version badge on every
    // variant (decision 973); the version history of a format is in its format view.
    if (group) {
      const own = ownPick(b.id);
      return {
        badge: b.n === null ? null : (
          <>
            <span className="ms-vbadge ms-vver">v{b.n}</span>
            <GroupStar label={formatLabel(b.id)} variant={upper(group.letter)} n={b.n} picked={own === b.n} pending={actions.pending(b.id)}
              onToggle={() => { if (own === b.n) actions.resetStar(b.id); else actions.star(b.id, b.n!); }} />
          </>
        ),
        note: null,
      };
    }
    return {
      badge: (
        <FormatBadge slug={slug} creative={creative} label={formatLabel(b.id)} state={s}
          versions={versions} shown={b.n} resumeFrom={cr.resumeFrom?.version ?? null}
          labelOf={formatLabel} actions={actions} busy={busyLinks} onView={(v) => view(b.id, v)} onCompare={() => openCompare(b.id)}
          render={canRender ? { n: b.n!, run: () => renderNow([[b.n!, [b.id]]]) } : null} />
      ),
      note: null,
    };
  };
  /**
   * What the formats column shows for variant `m`'s row of `format` (shown version `n`): the SAME source as "Selezione finale", the
   * core's group export plan. The row is starred when the plan takes this variant for the format, with the plan's version (a pick
   * of v1 shows "★ v1" on a row that shows v2); a default-rule choice is starred too, marked `default` (muted, tooltip says so).
   * Until the plan is read, the group's stored picks stand in.
   */
  function groupSide(m: VariantMember, format: string, n: number): { text: string; source: 'pick' | 'default' | null; title?: string } {
    const item = groupPlan?.find((x) => x.format === format);
    if (item) {
      if (item.letter !== m.letter) return { text: `v${n}`, source: null };
      const title = item.source === 'default' ? vg.finalDefaultFrom({ format: formatLabel(format), variant: upper(m.letter), n: item.version }) : undefined;
      return { text: `★ v${item.version}`, source: item.source, ...(title ? { title } : {}) };
    }
    if (groupPlan === null) {
      const pick = group?.group.picks[format];
      if (pick?.slug === m.slug && pick.version === n) return { text: `★ v${n}`, source: 'pick' };
    }
    return { text: `v${n}`, source: null };
  }
  /** The group's ★ of `format` when it is this variant's, else null. */
  function ownPick(format: string): number | null {
    const p = group?.group.picks[format];
    return p && p.slug === creative ? p.version : null;
  }
  /** A v2 board: the composition it shows (a follower's primary's), its render state and Retry. */
  const compositionFor = (b: BoardModel & { n: number | null }) => {
    if (b.n === null) return null;
    const src = boardSource(states, b.id, viewing).format;
    const v = versions.find((x) => x.n === b.n);
    const comp = compositionOf(v, src);
    const render = boardRender(v, src, jobList, detail.jobKey);
    return comp && render ? { n: b.n, format: src, hash: comp.hash, render, onRender: () => renderNow([[b.n!, [src]]]) } : null;
  };
  /** A board of the open creative; in a group, a thumbnail of its card at the card's zoom (`z`). */
  const board = (b: BoardModel & { n: number | null }, z?: number) => {
    const wip = isRendering(rendering, b.id) ? inProgressOf(live, job, b.id) : null;
    return (
    <CanvasBoard key={b.id} slug={slug} creative={creative} board={b} n={b.n} {...(group ? { grouped: true, card: true } : {})}
      tool={tool === 'comment' && (commentOn === null || commentOn === b.id) ? 'comment' : 'select'} zoom={z ?? zoom} selected={sel === b.id} rendering={!wip && isRendering(rendering, b.id)}
      commentable={commentable.has(b.id)} missing={b.n === null ? latest?.n ?? null : null} {...badgeOf(b)} {...(wip ? { inProgress: true } : {})} composition={wip ?? compositionFor(b)}
      {...(commentable.has(b.id) && !readOnly ? { onComment: () => startComment(b.id) } : {})}
      pins={commentable.has(b.id) ? pinsOf(b.id) : []} draft={commentable.has(b.id) ? draft : null} nextNumber={pins.length + 1}
      onSelect={() => { setSel(b.id); setVsel(null); }} onOpen={(el) => { if (tool === 'select') openEditor(b.id, el); }} onPlace={(x, y) => place(b.id, x, y)} onEditPin={editPin}
      onDraftText={(text) => setDraft((d) => (d ? { ...d, text } : d))} onDraftCommit={commitDraft} onDraftCancel={() => setDraft(null)}
      onDraftDelete={() => { if (draft?.index !== null && draft?.index !== undefined) removePin(draft.index); }}
    />
    );
  };

  /** The formats column's channel groups of the open creative (a store pack's group included). */
  const renderColumn = (only?: 'pack') => columnGroups.filter(([ch]) => (only ? ch === PACK_GROUP : true)).map(([channel, items]) => {
          const fmt = (b: BoardModel & { n: number | null }) => (
            <button key={b.id} type="button" className={cx('ms-navitem ms-cv-fmt', sel === b.id && 'ms-on', followsOf(b.id) && 'ms-follower')} aria-pressed={sel === b.id}
              onClick={() => { setSel(b.id); reveal(b.id); }}>
              <Icon name={b.preset?.kind === 'image' ? 'image' : 'video'} size={14} />
              {followsOf(b.id) ? (
                <span className="ms-cv-fmt-text">
                  <span className="ms-navitem-label">{boardName(b, locale)}</span>
                  <span className="ms-cv-fmt-follows"><Icon name="link" size={11} />{followsOf(b.id)}</span>
                </span>
              ) : (
                <>
                  <span className="ms-navitem-label">{boardName(b, locale)}</span>
                  <span className="ms-cv-fmt-side" {...sideAttrs(b)}>{formatSide(b.id, b.preset)}</span>
                </>
              )}
            </button>
          );
          if (channel === PACK_GROUP) {
            // Phase 14: the store pack's instances are one group, with App Store and Google Play as sub-groups and the export in its header.
            const stores = groupByChannel(items, new Set()).map(([ch, list]) => [ch, list] as const);
            return (
              <div key={channel} className="ms-cv-group ms-cv-pack" role="group" aria-label={t.web.storePack.groupTitle}>
                <div className="ms-cap ms-cv-group-head ms-cv-pack-head">
                  <span className="ms-cv-pack-marks" aria-hidden="true"><ChannelMark channel="appstore" /><ChannelMark channel="googleplay" /></span>
                  <span className="ms-cv-pack-title">{t.web.storePack.groupTitle}</span>
                  <Button size="sm" variant="outline" className="ms-cv-pack-export" disabled={!version && !group} title={t.web.storePack.groupExportAria}
                    onClick={() => setPackExport(true)}>
                    <Icon name="download" size={12} strokeWidth={1.7} />{t.web.storePack.groupExport}
                  </Button>
                </div>
                {stores.map(([ch, list]) => (
                  <div key={ch} className="ms-cv-subgroup" role="group" aria-label={ch !== '' ? channelName(ch, locale) : t.web.formatUi.other}>
                    <div className="ms-cap ms-cv-subhead">{ch !== '' ? <ChannelMark channel={channelOf(ch)} /> : null}{ch !== '' ? channelName(ch, locale) : t.web.formatUi.other}</div>
                    {list.map(fmt)}
                  </div>
                ))}
              </div>
            );
          }
          return (
            <div key={channel} className="ms-cv-group" role="group" aria-label={channel !== '' ? channelName(channel, locale) : t.web.formatUi.other}>
              <div className="ms-cap ms-cv-group-head">{channel !== '' ? <ChannelMark channel={channelOf(channel)} /> : null}{channel !== '' ? channelName(channel, locale) : t.web.formatUi.other}</div>
              {items.map(fmt)}
            </div>
          );
        });

  // ---- Phase 15: the pieces of a variant group (never built outside one) ---------------------------------------------
  const vg = t.web.variantGroup;
  const hostSlug = group?.host ?? creative;
  const failToast = (make: (p: { detail: string }) => string) => (e: unknown) => toast.show(make({ detail: message(e) }));
  const afterGroupChange = () => { reload(); shell?.catalog.refresh(); setPlanSeq((n) => n + 1); };
  const detailOfMember = (sl: string): CreativeDetail | null => (sl === creative ? detail : members[sl] ?? null);
  const pickMember = (memberSlug: string, format: string, n: number | null) => {
    Promise.resolve().then(() => api.setVariantPick(slug, hostSlug, format, n === null ? null : { slug: memberSlug, version: n })).then(afterGroupChange).catch(failToast(vg.pickFailed));
  };
  const focusMember = (m: VariantMember) => onVariantUi({ focus: m.slug === routeCreative ? null : m.slug, all: false });
  const onChatSelect = (target: ChatTarget) => {
    if (target === 'all') { onVariantUi({ all: true }); return; }
    const m = group?.group.members.find((x) => x.letter === target);
    if (m) focusMember(m);
  };
  const liveOf = (m: VariantMember) => memberLive(live, slug, m.slug);
  const hasVersionsOf = (m: VariantMember) => (detailOfMember(m.slug)?.versions.length ?? 0) > 0;
  const memberActions = (m: VariantMember) => ({
    onFocus: () => focusMember(m),
    onUseForAll: () => {
      Promise.resolve().then(() => api.useVariantForAll(slug, hostSlug, m.letter))
        .then(() => { toast.show(vg.usedForAll({ letter: upper(m.letter) }), { tone: 'ok' }); afterGroupChange(); }).catch(failToast(vg.useForAllFailed));
    },
    onDiscard: () => {
      setVbusy(m.letter);
      Promise.resolve().then(() => api.discardVariant(slug, hostSlug, m.letter))
        .then(() => { afterGroupChange(); if (m.slug === creative && hostSlug !== creative) onVariantUi({ focus: hostSlug === routeCreative ? null : hostSlug }); })
        .catch(failToast(vg.discardFailed)).finally(() => setVbusy(null));
    },
    onRestore: () => {
      setVbusy(m.letter);
      Promise.resolve().then(() => api.restoreVariant(slug, hostSlug, m.letter)).then(afterGroupChange).catch(failToast(vg.restoreFailed)).finally(() => setVbusy(null));
    },
    onExport: () => {
      const d = detailOfMember(m.slug);
      if (d) setExportingMember({ open: true, detail: d, snapshot: { versions: d.versions, states: formatStates(d, presets) } });
    },
    onEditDirection: () => setEditDir(m),
    onRetry: () => {
      setVbusy(m.letter);
      Promise.resolve().then(async () => api.runVariants(slug, hostSlug, { targets: [m.letter], request: retryTurn(await api.getConversation(slug, m.slug), m.letter) }))
        .then(afterGroupChange).catch(failToast(vg.sendAllFailed)).finally(() => setVbusy(null));
    },
  });
  const stateOf = (m: VariantMember) => rowState(m, group!.missing.includes(m.letter), liveOf(m), detailOfMember(m.slug)?.creative.status ?? null);
  /** Decision 973: a variant's card, its formats' thumbnails inside it at the zoom that fits them in the card. */
  const card = (m: VariantMember, width: number) => {
    const lv = liveOf(m);
    const missingMember = group!.missing.includes(m.letter);
    const list = missingMember ? [] : boardsOfMember(m);
    const hero = list.length === 1;
    const make = missingMember ? null : makeFor(m);
    const col = cardColumns(width - 2 * CARD_PAD, list.length);
    return (
      <VariantCard key={m.letter} member={m} focused={m.slug === creative} hasVersions={hasVersionsOf(m)} busy={vbusy === m.letter} actions={memberActions(m)}
        removal={{ project: slug, onDone: (kind) => { if (kind === 'restored') return; if (m.slug === creative) go(href.creative(slug, hostSlug)); else afterGroupChange(); } }}
        state={stateOf(m)} discardBlock={discardBlock(group!.group, m.letter, isRunning(lv))} width={width} hero={hero}>
        {make ? list.map((b) => <div key={b.id} className="ms-vcard-cell" style={{ width: col.width }}>{make(b, thumbZoom(b, col.width, hero))}</div>) : null}
      </VariantCard>
    );
  };
  /**
   * A board of another variant: read-only on the canvas (its tools are on its own page), with the group ★ and its version.
   * Its Comment opens that variant (its chat takes the comment) and starts commenting on the same format there.
   */
  const memberBoard = (m: VariantMember, d: CreativeDetail, st: Record<string, FormatState>, b: BoardModel & { n: number | null }, z: number) => {
    const key = `${m.letter}:${b.id}`;
    const src = boardSource(st, b.id, {}).format;
    const v = d.versions.find((x) => x.n === b.n);
    const comp = b.n === null ? null : compositionOf(v, src);
    const render = comp ? boardRender(v, src, jobList, d.jobKey) : null;
    const pick = group!.group.picks[b.id];
    const isPick = pick?.slug === m.slug && pick.version === b.n;
    const mjob = Object.values(live.jobs).find((j) => j.key === d.jobKey && (j.state === 'queued' || j.state === 'running'));
    const mrendering = isRendering(renderingOf(mjob, st), b.id);
    const wip = mrendering ? inProgressOf(live, mjob, b.id) : null;
    return (
      <CanvasBoard key={key} boardKey={key} grouped card slug={slug} creative={m.slug} board={b} n={b.n} tool="select" zoom={z} selected={vsel === key}
        rendering={!wip && mrendering} {...(wip ? { inProgress: true } : {})} commentable={false} missing={b.n === null ? d.versions.at(-1)?.n ?? null : null}
        {...(m.status === 'active' && b.n !== null ? { onComment: () => onVariantUi({ focus: m.slug === routeCreative ? null : m.slug, all: false, comment: b.id }) } : {})}
        badge={b.n === null ? null : (
          <>
            <span className="ms-vbadge ms-vver">v{b.n}</span>
            {st[b.id]?.follows ? null : <GroupStar label={formatLabel(b.id)} variant={upper(m.letter)} n={b.n} picked={isPick} onToggle={() => pickMember(m.slug, b.id, isPick ? null : b.n)} />}
          </>
        )}
        note={st[b.id]?.follows ? t.web.formatVersions.follows({ primary: instanceName(presetFor(presets, st[b.id]!.follows!), st[b.id]!.follows!, locale, d.creative.brief.formatLabels) }) : null}
        pins={[]} draft={null} nextNumber={1}
        composition={wip ?? (comp && render ? { n: b.n!, format: src, hash: comp.hash, render, onRender: () => { void Promise.resolve().then(() => api.renderVersion(slug, m.slug, b.n!, [src])).catch(failToast(t.web.render.startFailed)); } } : null)}
        onSelect={() => { setSel(null); setVsel(key); }}
        onOpen={(el) => { setFrameOrigin(`format:${slug}/${m.slug}/${b.id}`, el.getBoundingClientRect()); go(href.format(slug, m.slug, b.id)); }}
        onPlace={() => {}} onEditPin={() => {}} onDraftText={() => {}} onDraftCommit={() => {}} onDraftCancel={() => {}} onDraftDelete={() => {}} />
    );
  };
  const makeFor = (m: VariantMember): ((b: BoardModel & { n: number | null }, z: number) => ReactNode) | null => {
    if (m.slug === creative) return (b, z) => board(b, z);
    const d = members[m.slug];
    if (!d) return null;
    const { st } = modelOf(d);
    return (b, z) => memberBoard(m, d, st, b, z);
  };
  /** Decision 973: one card per variant, side by side, wrapping (the grouping by format is the "Selezione finale" chooser). */
  const renderGroupedWorld = () => {
    if (!group) return null;
    const shown = shownMembers(group.group, variantUi.showDiscarded);
    const width = cardWidth(zoom, viewW, shown.length);
    return shown.map((m) => card(m, width));
  };
  /** The chooser's formats: each format of the group with the active variants' pictures of it, side by side. */
  const chooserFormats = (): ChooserFormat[] => {
    if (!group) return [];
    const active = shownMs.filter((m) => m.status === 'active');
    return (planFormats ?? cr.brief.formats).map((format) => {
      const preset = presetFor(presets, format);
      const options = active.flatMap((m) => {
        const d = detailOfMember(m.slug);
        if (!d) return [];
        const st = m.slug === creative ? states : modelOf(d).st;
        const b = boardsOfMember(m).find((x) => x.id === format);
        const n = b?.n ?? null;
        const src = boardSource(st, format, m.slug === creative ? viewing : {}).format;
        const comp = n === null ? null : compositionOf(d.versions.find((v) => v.n === n), src);
        return [{ letter: m.letter, slug: m.slug, name: shortName(m.direction), n, follows: Boolean(st[format]?.follows),
          thumb: n === null ? null : { creative: m.slug, n, format: src, hash: comp?.hash ?? null, out: b?.out ?? null } }];
      });
      return { format, label: formatLabel(format), width: preset?.width ?? 1, height: preset?.height ?? 1, options };
    });
  };
  const renderGroupedColumn = () => {
    if (!group) return null;
    const side = (m: VariantMember, b: BoardModel & { n: number | null }) => (b.n === null ? { text: '—', source: null } : groupSide(m, b.id, b.n));
    const item = (m: VariantMember, b: BoardModel & { n: number | null }, label: string) => {
      const key = m.slug === creative ? b.id : `${m.letter}:${b.id}`;
      const on = m.slug === creative ? sel === b.id : vsel === key;
      return (
        <button key={key} type="button" className={cx('ms-navitem ms-cv-fmt', on && 'ms-on')} aria-pressed={on}
          onClick={() => { if (m.slug === creative) { setSel(b.id); setVsel(null); } else { setSel(null); setVsel(key); } reveal(key); }}>
          <Icon name={b.preset?.kind === 'image' ? 'image' : 'video'} size={14} />
          <span className="ms-navitem-label">{label}</span>
          {(() => { const sd = side(m, b); return <span className="ms-cv-fmt-side" {...(sd.source ? { 'data-source': sd.source } : {})} {...('title' in sd && sd.title ? { title: sd.title } : {})}>{sd.text}</span>; })()}
        </button>
      );
    };
    return (
      <>
        {shownMembers(group.group, variantUi.showDiscarded).map((m) => (
        <div key={m.letter} className={cx('ms-cv-group', m.status === 'discarded' && 'ms-discarded')} role="group" aria-label={`${vg.letterLabel({ letter: upper(m.letter) })}${m.direction ? ` · ${m.direction}` : ''}`}>
          <div className="ms-cap ms-cv-group-head ms-vcol-head" title={m.direction ? `${upper(m.letter)} · ${m.direction}` : undefined}>
            <span className="ms-vcol-dir">{m.direction ? `${upper(m.letter)} · ${m.direction}` : upper(m.letter)}{group.missing.includes(m.letter) ? ` · ${vg.missing}` : ''}</span>
          </div>
          {m.slug === creative ? renderColumn() : boardsOfMember(m).map((b) => item(m, b, boardName(b, locale)))}
        </div>
        ))}
      </>
    );
  };
  const baseChoices: BaseChoice[] = group ? group.group.members.filter((m) => m.status === 'active' && !group.missing.includes(m.letter)).flatMap((m) => {
    const n = detailOfMember(m.slug)?.versions.at(-1)?.n;
    return n === undefined ? [] : [{ letter: m.letter, slug: m.slug, version: n }];
  }) : [];
  const addVariant = async (direction: string | null, baseFrom: { slug: string; version: number } | null) => {
    if (!group) return;
    const had = new Set(group.group.members.map((m) => m.letter));
    const d = await api.addVariants(slug, hostSlug, { count: 1, directions: [direction], ...(baseFrom ? { baseFrom } : {}) });
    const added = d.variants && !d.variants.orphan ? d.variants.group.members.find((m) => !had.has(m.letter)) : undefined;
    afterGroupChange();
    setAddOpen(false);
    if (added) await api.runVariants(slug, hostSlug, { targets: [added.letter], request: null }).catch(failToast(vg.startFailed));
  };
  /** An ungrouped creative becomes variant A of a new group of two (the total count, A's direction left as it is). */
  const addFirstVariant = async (direction: string | null, baseFrom: { slug: string; version: number } | null) => {
    const d = await api.addVariants(slug, creative, { count: 2, directions: [null, direction], ...(baseFrom ? { baseFrom } : {}) });
    const added = d.variants && !d.variants.orphan ? d.variants.group.members.find((m) => m.letter !== 'a') : undefined;
    afterGroupChange();
    setAddOpen(false);
    if (added) await api.runVariants(slug, creative, { targets: [added.letter], request: null }).catch(failToast(vg.startFailed));
  };
  // The rows follow the group's canonical formats, which the core says (never the open sister's own brief: it can lag or be frozen).
  const finalRows = group && groupPlan && planFormats ? selectionRows(planFormats, groupPlan) : null;
  // Decision 973: "Selezione finale" is the page's main action (filled); "Mostra scartate" and "+ Variante" are secondary.
  const variantBar = group ? (
    <div className="ms-vbar" role="toolbar" aria-label={vg.toolbarAria}>
      <span className="ms-vbar-toggle"><Toggle size="sm" on={variantUi.showDiscarded} onChange={(on) => onVariantUi({ showDiscarded: on })} label={vg.showDiscarded} /><span aria-hidden="true">{vg.showDiscarded}</span></span>
      <span className="ms-grow" />
      <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>{vg.addVariant}</Button>
      <Button size="sm" variant="accent" className="ms-vbar-final" aria-haspopup="dialog" onClick={() => setChooser(true)}><Icon name="star" size={13} fill />{vg.finalSelection}</Button>
    </div>
  ) : null;
  const toChoose = group ? readyToChoose(group.group, group.missing, (l) => { const m = group.group.members.find((x) => x.letter === l); return m ? stateOf(m).kind : 'missing'; }) : null;

  return (
    <div ref={root} className="ms-cv">
      {bar?.title ? createPortal(
        <BarTitle title={title} renaming={renaming} onStart={startRename} onChange={setRenaming} onSave={(v) => void saveTitle(v)} onCancel={() => setRenaming(null)}
          state={<>
            <StatePill status={cr.status} needs={myApprovals.length > 0} working={working} />
            {/* Live tokens of the job (all its runs); nothing until its first usage event, e.g. right after a reconnect. */}
            {working && job ? <TokenCount tokens={jobLiveTokens(live, job.id)} live partial={jobUsagePartial(live, job.id)} className="ms-cv-tokens" /> : null}
          </>} />,
        bar.title,
      ) : null}
      {bar?.end ? createPortal(
        <>
          <LanguagesButton slug={slug} creative={creative} detail={detail} version={version ?? latest} presets={presets} live={live} onChanged={reload} readOnly={readOnly} />
          {/* Decision 974: no "Render ★"; Export renders what it needs and shows an export or a render in progress. With
              variants "Selezione finale" is the page's primary action (decision 1045): Export is a secondary one here. */}
          <ExportButton jobs={jobList} jobKey={detail.jobKey} disabled={!version && !group} secondary={Boolean(group)}
            onClick={() => { if (version || group) setExporting({ open: true, snapshot: { versions, states } }); }} />
          {/* Decision 915: archive and delete; a group's menu acts on the whole group (its variant A). Decision 972: the
              version history of the creative (of the variant open in the chat) is a rare action of this menu. */}
          <CreativeMenu slug={slug} target={group ? hostSlug : creative} title={title} onAddVariant={!group && !vdetail ? () => setAddOpen(true) : null}
            buttonRef={versionButton} onHistory={versions.length ? { letter: group ? (/~([a-z])$/.exec(creative)?.[1] ?? 'a').toUpperCase() : null, run: () => setHistory(true) } : null}
            onRemoved={(kind) => { if (kind !== 'restored') go(href.project(slug)); }} />
          {versions.length ? (
            <VersionTimeline slug={slug} creative={creative} versions={versions} resumeFrom={cr.resumeFrom?.version ?? null} actions={actions}
              open={history} onClose={() => setHistory(false)} anchor={versionButton} />
          ) : null}
        </>,
        bar.end,
      ) : null}

      <aside className="ms-cv-side ms-cv-formats" aria-label={c.formatsAria}>
        <div className="ms-cv-formats-head"><b>{c.formats}</b><span>{boards.length}</span></div>
        {group ? renderGroupedColumn() : renderColumn()}
      </aside>

      <main className="ms-cv-main" aria-label={c.canvasAria}>
        {variantBar}
        <Notes>
          {integrity.state ? <IntegrityNotice key="integrity" slug={slug} state={integrity.state} reload={integrity.reload} /> : null}
          {presetsFailure ? <p role="alert" className="ms-cv-note ms-err">{t.web.creative.formatsLoadFailed({ detail: presetsFailure })}</p> : null}
          {catalogError ? <p className="ms-cv-note">{catalogError}</p> : null}
          {vdetail?.orphan ? <p className="ms-cv-note ms-info" role="status">{vg.orphanNotice}</p> : null}
          {cr.resumeFrom ? <p className="ms-cv-note ms-info">{t.web.creative.resumeNote({ n: cr.resumeFrom.version })}</p> : null}
          {(cr.status === 'error' || cr.status === 'interrupted') && cr.error && !working ? <p role="alert" className="ms-cv-note ms-err">{cr.error}</p> : null}
          {version?.status === 'incomplete' ? (
            <div className="ms-cv-note">
              <b>{t.web.creative.versionIncomplete({ n: version.n })}</b>
              <ProblemList problems={version.problems} />
            </div>
          ) : null}
          {actionError ? <p role="alert" className="ms-cv-note ms-err">{actionError}</p> : null}
          {toChoose !== null ? (
            <div key="choose" className="ms-cv-note ms-info ms-vready" role="status">
              <Icon name="star" size={13} /><b>{vg.readyBanner({ count: toChoose })}</b>
              <Button size="sm" variant="outline" onClick={() => setChooser(true)}>{vg.choose}</Button>
            </div>
          ) : null}
        </Notes>
        <div
          ref={viewport}
          className={cx('ms-cv-viewport', tool === 'comment' && 'ms-tool-comment', grabbing && 'ms-grabbing')}
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
          {/* The world is not zoomed: each board scales its frame, and its spacing follows --cv-z (canvas.css). A group's cards wrap. */}
          <div className={cx('ms-cv-world', group ? 'ms-cv-vworld' : 'ms-cv-lined')} style={{ '--cv-z': zoom } as CSSProperties}
            aria-busy={rendering === 'all' || rendering.size > 0 ? true : undefined}>
            {group ? renderGroupedWorld() : (
              <>
                {lines.map((line, i) => (
                  <div key={i} className="ms-cv-line">
                    {line.map((it) => (it.stack ? <div key={it.boards[0]!.id} className="ms-cv-stack">{it.boards.map((b) => board(b))}</div> : board(it.boards[0]!)))}
                  </div>
                ))}
              </>
            )}
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
        {/* A compact pill at the bottom, never over the boards' headers (live checks of phase 9). */}
        {commentLock && version && pinSource !== null ? <div className="ms-cv-lockpill" id="ms-cv-comment-lock" role="status" title={c.versions.commentsOn({ n: pinSource })}>{c.versions.commentsOn({ n: pinSource })}</div> : null}
      </main>

      <aside className="ms-cv-side ms-cv-panel" aria-label={c.panel}>
        <Tabs label={c.panel} value={tab} onChange={setTab}
          tabs={[{ value: 'chat', label: c.tabs.chat }, { value: 'comments', label: c.tabs.comments, count: sent.count }, { value: 'brief', label: c.tabs.brief }]} />
        {tab === 'chat' ? (
          <Conversation slug={slug} creative={creative} entries={conversation} approvals={myApprovals} job={chatJob} live={chatJob ? live.events[chatJob.id] ?? [] : []}
            pins={pins} onRemovePin={removePin} onEditPin={(i) => editPin(i + 1)} formatName={formatLabel}
            single={groupChat.single} otherPins={otherPins} onRemoveOtherPin={(p) => dropPins([p])}
            usageOf={(u) => <UsageBadge usage={u} billing={live.today?.billing ?? null} />}
            canGenerate={versions.length === 0} onSent={({ pins: sent }) => { dropPins(sent); setViewing({}); reload(); }}
            onSelectVersion={viewAll} snapshots={live.snapshots}
            appliesTo={appliesTo} brief={detail.creative.brief} onBriefSaved={reload} queued={detail.creative.queued} onQueueChanged={reload}
            self={groupChat.self} memberJobs={groupChat.memberJobs} onOpenVariant={(l) => { const m = group?.group.members.find((x) => x.letter === l); if (m) focusMember(m); }}
            {...(group ? { variants: { group: group.group, current: group.letter, all: variantUi.all, missing: group.missing, onSelect: onChatSelect,
              runAll: (body: { text?: string; pins?: Pin[]; formats?: string[] } | null) => api.runVariants(slug, hostSlug, { targets: 'all-active', request: body }) } } : {})}
            versionExtra={(n) => <UsageBadge usage={versions.find((v) => v.n === n)?.usage} billing={live.today?.billing ?? null} />}
            versionSummary={(n) => { const v = versions.find((x) => x.n === n); return v?.origin === 'editor' && v.request ? v.request : null; }}
            versionNote={(n) => <OutputWarnings outputs={versions.find((v) => v.n === n)?.outputs ?? []} formatLabel={formatLabel} />} />
        ) : null}
        {tab === 'comments' ? <CommentsTab slug={slug} creative={creative} sent={sent} working={working} formatLabel={formatLabel} onStart={() => startComment(null)} /> : null}
        {/* Kept mounted while hidden, so an unsaved brief draft survives tab switches. */}
        <div className="ms-cv-brief-wrap" hidden={tab !== 'brief'}>
          <BriefTab project={slug} detail={detail} presets={presets} disabled={working} readOnly={self.host ? null : readOnly} formatLabel={formatLabel} onChanged={reload} />
        </div>
      </aside>

      {!group && !vdetail && addOpen ? (
        <AddVariantDialog open onClose={() => setAddOpen(false)} onAdd={addFirstVariant}
          bases={latest ? [{ letter: 'a', slug: creative, version: latest.n }] : []} />
      ) : null}
      {group ? (
        <>
          <AddVariantDialog open={addOpen} onClose={() => setAddOpen(false)} bases={baseChoices} onAdd={addVariant} />
          <FinalSelection open={chooser} onClose={() => setChooser(false)} slug={slug} rows={finalRows} label={formatLabel} formats={chooser ? chooserFormats() : []}
            onPick={(memberSlug, format, n) => pickMember(memberSlug, format, n)} />
          {editDir ? (
            <EditDirectionDialog open onClose={() => setEditDir(null)} letter={editDir.letter} initial={editDir.direction ?? ''}
              onSave={async (text) => { await api.setVariantDirection(slug, hostSlug, editDir.letter, text); setEditDir(null); afterGroupChange(); }} />
          ) : null}
          {exportingMember ? (
            <ExportDialog open={exportingMember.open} onClose={() => setExportingMember((x) => (x ? { ...x, open: false } : x))} slug={slug} creative={exportingMember.detail.slug}
              title={exportingMember.detail.creative.title} snapshot={exportingMember.snapshot} presets={presets} labels={exportingMember.detail.creative.brief.formatLabels}
              pattern={exportNamePattern ?? DEFAULT_EXPORT_NAME_PATTERN} onSettings={onSettings} jobs={live.jobs}
              {...(creativeLocales(exportingMember.detail.creative.brief) ? { locales: creativeLocales(exportingMember.detail.creative.brief)! } : {})} />
          ) : null}
        </>
      ) : null}
      {compare ? (
        <CompareDialog open={compare.open} onClose={() => setCompare((s) => (s ? { ...s, open: false } : s))} slug={slug} creative={creative}
          versions={versions} presets={presets} labels={cr.brief.formatLabels} states={states} format={compare.format} initial={compare.init} actions={actions} />
      ) : null}
      <ExportDialog open={Boolean(exporting?.open)} onClose={() => setExporting((s) => (s ? { ...s, open: false } : s))} slug={slug} creative={hostSlug}
        title={title} snapshot={exporting?.snapshot ?? null} {...(group ? { group: true } : {})} presets={presets} labels={cr.brief.formatLabels} pattern={exportNamePattern ?? DEFAULT_EXPORT_NAME_PATTERN} onSettings={onSettings} jobs={live.jobs}
        {...(creativeLocales(cr.brief) ? { locales: creativeLocales(cr.brief)! } : {})} />
      {cr.brief.storePack && (version || group) ? (() => {
        // A group's pack is made from the group selection, not from one version: no per-version language gaps to mark.
        const packGaps = version && !group ? packLanguageGaps(cr.brief.formats.filter((f) => packIds.has(f)), version, creativeLocales(cr.brief)?.extra ?? []) : { untranslated: [], review: [] };
        return (
        <StorePackExport open={packExport} onClose={() => setPackExport(false)} slug={slug} creative={group ? hostSlug : creative} title={title} version={version?.n ?? 0}
          {...(group ? { group: true } : {})} untranslated={packGaps.untranslated} needsReview={packGaps.review}
          {...(creativeLocales(cr.brief) ? { locales: creativeLocales(cr.brief)! } : {})} />
        );
      })() : null}
      {renderPlan && creativeLocales(cr.brief) ? (
        <RenderLanguagesDialog open onClose={() => setRenderPlan(null)} slug={slug} creative={creative} plan={renderPlan} locales={creativeLocales(cr.brief)!}
          rowsOf={(n) => versions.find((v) => v.n === n)?.localizations ?? []} labelOf={formatLabel} />
      ) : null}
    </div>
  );
}

/**
 * The creative's menu: "+ Variant" for a creative that has no variants yet (phase 15: the only way to start its group from
 * the canvas), then Archive and Delete (decision 915) of the creative, or of the whole group from a group's canvas.
 */
function CreativeMenu({ slug, target, title, onAddVariant, onHistory, buttonRef, onRemoved }: {
  slug: string; target: string; title: string; onAddVariant: (() => void) | null;
  /** The version history item (`letter`: the variant open in the chat, in a group). */
  onHistory: { letter: string | null; run(): void } | null;
  buttonRef: RefObject<HTMLButtonElement | null>; onRemoved(kind: RemovalDone): void;
}) {
  const t = useT();
  const vg = t.web.variantGroup;
  const v = t.web.canvas.versions;
  return (
    <CreativeActionsMenu slug={slug} creative={target} label={t.web.shell.moreActions} className="ms-cv-more" variant="ghost" buttonRef={buttonRef} onDone={onRemoved}
      extra={onAddVariant || onHistory ? (close) => (
        <>
          {onAddVariant ? <NavItem data-row="" role="menuitem" icon="plus" onClick={() => { close(); onAddVariant(); }}>{vg.addVariantMenu}</NavItem> : null}
          {onHistory ? <NavItem data-row="" role="menuitem" icon="clock" onClick={() => { close(); onHistory.run(); }}>{onHistory.letter ? v.historyItemVariant({ letter: onHistory.letter }) : v.historyItem}</NavItem> : null}
        </>
      ) : undefined} />
  );
}

/** The output warnings of a version (spec §6), one line each with its format, as text; nothing without any. */
function OutputWarnings({ outputs, formatLabel }: { outputs: VersionEntry['outputs']; formatLabel(id: string): string }) {
  const locale = useLocale();
  const lines = outputs.flatMap((o) => (o.warnings ?? []).map((w) => ({ format: o.format, text: outputWarningText(w, locale) })));
  if (!lines.length) return null;
  return (
    <ul className="ms-convo-version-notes">
      {lines.map((l, i) => <li key={i}><Icon name="warn" size={12} /><span><b>{formatLabel(l.format)}</b> · {l.text}</span></li>)}
    </ul>
  );
}

/**
 * Report 41: the composition a board shows while creative turn `job` runs, once the core said this format of the version it
 * is writing passed the agent's check (`formatReady`): that unrecorded version and hash, no render state. Null otherwise
 * (job not running, format not checked, or taken back).
 */
function inProgressOf(live: EventsState, job: JobSummary | undefined, format: string): { n: number; format: string; hash: string; render: { kind: 'none' }; onRender(): void } | null {
  if (!job || job.kind !== 'creative' || job.state !== 'running') return null;
  const r = live.ready?.[job.id]?.[format];
  return r ? { n: r.n, format, hash: r.hash, render: { kind: 'none' }, onRender: () => {} } : null;
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
        <span className="ms-crumb-sep" aria-hidden="true">/</span>
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

/**
 * `frame`: the feedback frame the core cut for it (`<n>-<i>.jpg`, the i-th pin of its message, carry 9), known only for the
 * pins of the message the version answered (an earlier message whose turn made no version shares its number).
 */
interface SentComment { pin: Pin; at: string; frame?: string; /** A range comment's end frame (`<n>-<i>e.jpg`). */ frameEnd?: string }
interface SentComments { applied: Array<{ n: number; items: SentComment[] }>; open: SentComment[]; count: number }

/** Comments the user sent, grouped by the version that applied them (the next version after the message). */
export function sentComments(entries: ConversationEntry[]): SentComments {
  const applied: SentComments['applied'] = [];
  let open: Array<SentComment & { message: number; end?: boolean }> = [];
  let count = 0;
  let message = 0;
  for (const e of entries) {
    if (e.type === 'user' && e.pins.length) {
      message += 1;
      const m = message;
      open = [...open, ...e.pins.map((pin, i) => ({ pin, at: e.at, message: m, frame: pin.timeSec !== null || pin.range ? `${i + 1}` : undefined, end: Boolean(pin.range) }))];
      count += e.pins.length;
    }
    const closed = turnEndOf(e);
    if (closed && open.length) {
      const n = closed.n;
      applied.push({ n, items: open.map(({ message: m, frame, end, ...k }) => ({ ...k, ...(m === message && frame && !closed.kept ? { frame: `${n}-${frame}.jpg`, ...(end ? { frameEnd: `${n}-${frame}e.jpg` } : {}) } : {}) })) });
      open = [];
    }
  }
  return { applied: applied.reverse(), open: open.map(({ message: _m, frame: _f, end: _e, ...k }) => k), count };
}

function CommentsTab({ slug, creative, sent, working, formatLabel, onStart }: { slug: string; creative: string; sent: SentComments; working: boolean; formatLabel(id: string): string; onStart(): void }) {
  const t = useT();
  const c = t.web.canvas.comments;
  const locale = useLocale();
  const frames = usePinFrames(slug, creative, sent.applied.filter((g) => g.items.some((k) => k.frame)).map((g) => g.n));
  if (!sent.count) {
    return (
      <div className="ms-cv-tabbody ms-cv-tabempty">
        <Empty icon="comment" title={c.emptyTitle} sub={c.emptySub} action={<Button variant="outline" onClick={onStart}><Icon name="comment" size={13} />{c.start}</Button>} />
      </div>
    );
  }
  const card = (k: SentComment, i: number, state: ReactNode, n?: number) => (
    <div key={i} className="ms-card ms-cv-comment">
      {n !== undefined && k.frame && frames[n]?.[k.frame] ? <img className="ms-cv-comment-frame" src={frames[n]![k.frame]} alt={t.web.render.pinFrame({ n: i + 1 })} draggable={false} /> : null}
      {n !== undefined && k.frameEnd && frames[n]?.[k.frameEnd] ? <img className="ms-cv-comment-frame" src={frames[n]![k.frameEnd]} alt={t.web.render.pinFrame({ n: i + 1 })} draggable={false} /> : null}
      <span className="ms-cv-comment-head">{state}<span className="ms-cv-comment-where">{formatLabel(k.pin.format)}{k.pin.clipId ? ` · ${k.pin.clipName ?? k.pin.clipId}` : ''}{k.pin.range ? ` · ${rangeSeconds(t, locale, k.pin.range)}` : k.pin.timeSec ? ` · ${t.web.conversation.atSeconds({ time: formatNumber(locale, k.pin.timeSec, { maximumFractionDigits: 1 }) })}` : ''}</span>
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
          {g.items.map((k, i) => card(k, i, <Pill tone="ok" dot>v{g.n}</Pill>, g.n))}
        </section>
      ))}
    </div>
  );
}

/** The versions' sum: the fallback when the ledger cannot be read (a lower bound); null when no version has usage. */
export function creativeUsage(versions: VersionEntry[]): { tokens: number; costUsd: number | null; estimated: boolean; partial: boolean } | null {
  const tracked = versions.filter((v) => v.usage);
  if (!tracked.length) return null;
  const tokens = tracked.reduce((sum, v) => addTokens(sum, v.usage!.tokens), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const costs = tracked.map((v) => v.usage!.costUsd).filter((c): c is number => c !== null);
  return {
    tokens: shownTotal(tokens),
    costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    estimated: costs.length < tracked.length || tracked.some((v) => v.usage!.estimated),
    partial: tracked.length < versions.length,
  };
}

/**
 * The creative's tokens (Brief panel): the ledger total of this creative — every run, failed and cancelled ones
 * included — from `/api/usage?project=&creative=`. "≥" when versions predate tracking or a run's figure is partial.
 * While the ledger cannot be read, the versions' sum stands in, always as a lower bound. Nothing when no figure exists.
 */
function CreativeTokens({ project, creative, versions, refresh }: { project: string; creative: string; versions: VersionEntry[]; refresh: string }) {
  const t = useT();
  const locale = useLocale();
  const [ledger, setLedger] = useState<UsageReport['total'] | 'failed' | null>(null);
  useEffect(() => {
    let alive = true;
    // Through a promise: even a synchronous failure lands in the fallback.
    Promise.resolve().then(() => api.getUsage({ project, creative })).then((r) => { if (alive) setLedger(r.total); }, () => { if (alive) setLedger('failed'); });
    return () => { alive = false; };
  }, [project, creative, refresh]);
  const untracked = versions.some((v) => !v.usage);
  let shown: { tokens: number; costUsd: number | null; estimated: boolean; partial: boolean } | null = null;
  if (ledger === 'failed') {
    const sum = creativeUsage(versions);
    shown = sum && { ...sum, partial: true };
  } else if (ledger && shownTotal(ledger.tokens) > 0) {
    shown = { tokens: shownTotal(ledger.tokens), costUsd: ledger.costUsd, estimated: ledger.estimated === true, partial: untracked || ledger.estimated === true };
  }
  if (!shown) return null;
  const cost = costText(t, locale, shown.costUsd, shown.estimated);
  return (
    <div className="ms-cv-brief-row">
      <span className="ms-cap">{t.web.usage.creativeTotal}</span>
      <div className="ms-cv-brief-value">
        <span className="ms-cv-brief-tokens"><TokenCount tokens={shown.tokens} partial={shown.partial} />{cost ? ` · ${cost}` : ''}</span>
        {untracked ? <span className="ms-cv-brief-note">{t.web.usage.untracked}</span> : null}
      </div>
    </div>
  );
}

/** `readOnly`: why the brief cannot be edited here (a discarded variant, phase 15): "Modifica il brief" is disabled and says it. */
function BriefTab({ project, detail, presets, disabled, readOnly, formatLabel, onChanged }: {
  project: string; detail: NonNullable<ReturnType<typeof useCreative>['detail']>; presets: FormatPreset[]; disabled: boolean; readOnly: string | null; formatLabel(id: string): string; onChanged(): void;
}) {
  const t = useT();
  const c = t.web.canvas.brief;
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const b = detail.creative.brief;
  if (editing && readOnly === null) {
    return (
      <div className="ms-cv-tabbody ms-cv-brief-edit">
        <Button size="sm" variant="ghost" className="ms-cv-brief-back" onClick={() => setEditing(false)}><Icon name="back" size={13} />{c.back}</Button>
        <BriefEditor slug={project} detail={detail} presets={presets} disabled={disabled} onChanged={() => { setEditing(false); onChanged(); }} onRefresh={onChanged} />
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
      {row(c.services, servicesSummary(b.services, t))}
      <CreativeTokens project={project} creative={detail.slug} versions={detail.versions}
        refresh={`${detail.versions.map((v) => `${v.n}:${v.status}`).join(',')}|${detail.creative.status}|${detail.creative.updatedAt}`} />
      {readOnly !== null ? <p className="ms-cv-note" role="note">{readOnly}</p> : null}
      <Button variant="outline" className="ms-cv-brief-edit-btn" disabled={readOnly !== null} onClick={() => setEditing(true)}><Icon name="edit" size={13} />{c.edit}</Button>
    </div>
  );
}
