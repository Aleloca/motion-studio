// A format's page (decision 916: one screen): the direct editor (Phase 10b) with everything the format view had. The layout
// of the prototype's VideoEditor / ImageEditor: scenes (or layers) left, the stage centre, the timeline under a video, and the
// tabs Chat | Inspector right; the bar has "← All formats" (T4), the format, its ★ badge with its versions, the Versions
// timeline, the render status, Languages, Duplicate and Export. What lives here: the draft (draftStore.ts) opened on the
// format's composition, the stage player showing the live draft, the "Draft · Save as vN" pill, saving through
// `POST …/edits`, the leave guard, the keyboard map, comments (a spot of the frame, a clip, a range) and the read-only states.
//
// The version on screen (one screen, decision 916):
// - The editable version is the format's latest composition (the history entry at the latest version). Any other version
//   (from the ★ badge, a chat card's "View vN", the canvas, or a manual ★ on an older one) opens read-only in a throw-away
//   draft of its own: the editable draft, unsaved edits included, is never replaced and is there again on the way back.
// - Read-only also for a discarded variant and while an agent turn or a render works on the creative. The reason is said
//   on the stage and in the inspector; edits are refused at the source (the context's draft actions refuse).
// - A version without a composition (a legacy one), no version yet, or a format outside the creative: the viewer
//   (FormatView) is shown inside the same route, its version choice owned here.
//
// Concerns carried from the earlier tasks:
// - Save sends the PRIMARY format, base version + hash, the draft's composition, the staged paths it uses, the ops and the
//   token of the preview session that owns the staging; the core is authoritative (409 busy / baseChanged / carry-failed,
//   422 with problems). A 409 base-changed keeps the draft and offers "Reopen on the latest version" (discards it only
//   after a confirmation): the draft is never lost.
// - Discard re-sends the BASE composition to the player (`clearDraft()` sends nothing).
// - A renewed preview session moves the staged files in the core (also from a session that ended within the core's grace,
//   decisions log 264): the frame is replaced by the player (a new `key`, never a new `src`), the staged list is updated
//   from the new session's `staged` (its media indices), a staged file that did not come along (used or not) is staged
//   again from where it came from (Save waits meanwhile), the staged videos' session media are sent again, and staging and saving use the new
//   token.
// - The draft goes to the player with `setComposition` (coalesced per animation frame); a draft the runtime refuses is
//   shown as a problem, never ignored.
import {
  channelName, compositionProblem, compositionProblemText, EDITOR_SAVE_STAGED_MAX, isDurationOffBrief, listElements, parseSvg, pinClipName, type Composition, type EditorCompositionView, type EditResult, type FormatPreset, type Pin,
  type StagedAsset, type StagedSvgEdit, type StageRequest,
} from '@motion-studio/shared';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError, type SvgEditFrom } from '../../api.ts';
import { CompositionPlayer, type CompositionMedia } from '../../components/CompositionPlayer.tsx';
import { LocaleOutline, LocaleSwitcher } from '../creative/LocaleSwitcher.tsx';
import { localePreviewSource, useLocalePreview } from '../creative/useLocalePreview.ts';
import { LanguagesButton } from '../creative/LanguagesButton.tsx';
import { creativeLocales } from '../creative/languagesModel.ts';
import { usePreviewSession } from '../../components/compositionPreview.ts';
import { Conversation } from '../../components/Conversation.tsx';
import { chatTick, useGroupChat } from '../variants/useGroupChat.ts';
import { IntegrityNotice, useIntegrity } from '../../components/IntegrityNotice.tsx';
import type { EventsState } from '../../eventsReducer.ts';
import { message } from '../../errors.ts';
import { formatNumber, useLocale, useT } from '../../i18n.tsx';
import { D, enter, flip } from '../../motion/index.ts';
import { href, parseRoute, routeKey } from '../../routes.ts';
import { useBarClaim } from '../../shell/barSlots.ts';
import { setFrameOrigin, setShownVersions, takeFrameOrigin, takeShownVersions } from '../../shell/intents.ts';
import { go, ShellContext } from '../../shell/ShellContext.tsx';
import { Button, ChannelMark, Empty, Icon, Modal, Pill, Segmented, Spinner, Tabs, Toggle, cx, toast } from '../../ui/index.ts';
import { useCreative } from '../../useCreative.ts';
import { useChatPins } from '../pendingPins.ts';
import { clipPin, findClipById, rangePin, rangeTimes } from '../pinModel.ts';
import { PinNoteDialog } from './PinNoteDialog.tsx';
import { RangeSpans } from './RangeSpans.tsx';
import { RangeDialog } from './RangeDialog.tsx';
import { instanceName, presetFor } from '../../instances.ts';
import { boardLabel, SafeZoneBands } from '../CanvasBoard.tsx';
import { appliesGroups, outputUrl, pointIn } from '../canvasModel.ts';
import { CompareDialog } from '../CompareDialog.tsx';
import { channelOf, lastStep } from '../creativeState.ts';
import { ExportDialog, type ExportSnapshot } from '../ExportDialog.tsx';
import { CommentHint, HitArea, PinLayer } from '../framePins.tsx';
import { FollowerChip, FormatBadge, useNewVersionNotice, useVersionActions, VersionTimeline } from '../FormatVersions.tsx';
import { FormatView } from '../FormatView.tsx';
import { IdentitySizes } from '../identity/IdentitySizes.tsx';
import { UseAsBrandLogo } from '../identity/UseAsBrandLogo.tsx';
import { compositionOf } from '../renderModel.ts';
import { ExportButton } from '../ExportButton.tsx';
import { BriefOffChip } from '../BriefOffChip.tsx';
import { BarMenu, BarMenuItem } from '../../shell/BarMenu.tsx';
import { FPS as DEFAULT_FPS, round3, timecode, type Mark, type Speed } from '../Transport.tsx';
import { entryAt, followersOf, formatStates, shownOf } from '../versionModel.ts';
import { discardedSelf } from '../variants/variantModel.ts';
import '../canvas.css';
import '../format.css';
import '../identity/identity.css';
import { compactOps } from './opsCompact.ts';
import { DraftPill, SAVED_MS } from './DraftPill.tsx';
import { draftKey, isDirty, peekDraft, useDraft, type Draft, type DraftActions } from './draftStore.ts';
import { EditorContext, type EditorState } from './editorContext.ts';
import { registerLeaveGuard } from './leaveGuard.ts';
import { ScenesColumn } from './ScenesColumn.tsx';
import { nudgeClip, nudgeable } from './nudge.ts';
import { Stage } from './Stage.tsx';
import { Timeline } from './Timeline.tsx';
import { Inspector } from './Inspector.tsx';
import { ZoomBar, zoomFrame } from './ImageEditor.tsx';
import { LayersPanel } from './LayersPanel.tsx';
import { SvgSessions } from './svgSessions.tsx';
import { isMac } from '../../platform.ts';
import { useEditorKeys, useNudgeKeys } from './useEditorKeys.ts';
import { usePlayerControls } from './usePlayerControls.ts';
import { DEFAULT_EXPORT_NAME_PATTERN, DEFAULT_FORMATS, editProblemText } from '@motion-studio/shared';
import './editor.css';

export interface EditorScreenProps {
  slug: string;
  creative: string;
  format: string;
  live: EventsState;
  exportNamePattern?: string;
  onSettings?(next: import('@motion-studio/shared').WorkspaceSettings): void;
}

/** What asked to leave with unsaved edits: a route change (go there afterwards) or a chat message (send it afterwards). */
type Leave = { mode: 'route'; target: string } | { mode: 'chat'; resolve(ok: boolean): void };

/** What the core accepts in a save body (`directEditBodySchema`); the ops are compacted (opsCompact.ts) so the body stays small. */
const SAVE_STAGED_MAX = EDITOR_SAVE_STAGED_MAX;

/** The staged files the composition names (only those go with a save). */
function usedStaged(d: Draft): string[] {
  const json = JSON.stringify(d.composition);
  return d.staged.map((s) => s.path).filter((p) => json.includes(JSON.stringify(p).slice(1, -1)));
}

/** A draft refused because nothing may be written from this screen now (`EditorState.readOnly` says why). */
const READ_ONLY_EDIT: EditResult = { ok: false, problem: compositionProblem('editor.readOnly') };
/** T3 only while the board's rect is fresh: a frame that shows up later than this simply appears. */
const FLIP_WINDOW_MS = 400;

export function EditorScreen({ slug, creative, format, live, exportNamePattern, onSettings }: EditorScreenProps) {
  const t = useT();
  const e = t.web.editor;
  const c = t.web.canvas;
  const f = t.web.formatView;
  const locale = useLocale();
  const shell = useContext(ShellContext);
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const integrity = useIntegrity(slug, live);
  // Decision 980: a group's one chat is read again when any of its members changes.
  const { detail, conversation, error, reload } = useCreative(slug, creative, chatTick(live.creativeTicks, slug, creative));
  const groupChat = useGroupChat(live, slug, creative, detail);

  // The bar belongs to this page only while it is the route's page (a leaving page stays mounted ~200 ms), and to the viewer
  // instead while that is shown (below).
  const ownKey = routeKey({ name: 'format', slug, creative, format });
  const active = !shell || routeKey(shell.route) === ownKey;
  // T3: the rect of the board this page grows from, taken once, and when the page mounted.
  const [origin] = useState(() => takeFrameOrigin(`format:${slug}/${creative}/${format}`));
  const [mountedAt] = useState(() => performance.now());

  // Catalog, versions and the format's state.
  const [presets, setPresets] = useState<FormatPreset[]>([]);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  const [presetsFailure, setPresetsFailure] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getFormats())
      .then((s) => { if (alive) { setPresets(s.presets); setPresetsLoaded(true); } })
      .catch((err: unknown) => { if (alive) { setPresetsFailure(message(err)); setPresetsLoaded(true); } });
    return () => { alive = false; };
  }, []);
  const versions = useMemo(() => detail?.versions ?? [], [detail]);
  const latest = versions.at(-1) ?? null;
  const states = useMemo(() => (detail ? formatStates(detail, presets) : {}), [detail, presets]);
  const primary = states[format]?.follows ?? format;
  const followers = useMemo(() => followersOf(states, primary), [states, primary]);
  const preset = presetFor(presets, primary) ?? undefined;
  /** The format of the route (a follower's own preset: its channel and name in the bar). */
  const ownPreset = presetFor(presets, format) ?? (presetsLoaded ? null : presetFor(DEFAULT_FORMATS, format));
  const labels = detail?.creative.brief.formatLabels;
  const labelOf = useCallback((id: string) => boardLabel({ id, preset: presetFor(presets, id), out: null, labels }, locale), [presets, locale, labels]);

  // The version on screen. `viewN`: a version chosen here (read-only unless it is the editable one), null for the editable
  // one, undefined for what the canvas showed (its viewed version, else the ★).
  const [intent] = useState(() => takeShownVersions(`${slug}/${creative}`));
  const [viewN, setViewN] = useState<number | null | undefined>(undefined);
  const editN = latest && compositionOf(latest, primary) ? entryAt(versions, states[primary], latest.n) : null;
  const compAt = (n: number | null) => (n === null ? null : compositionOf(versions.find((v) => v.n === n), primary));
  const editHash = compAt(editN)?.hash ?? null;
  /** Version `v` shows the editable composition (the latest entry, or an older one with the same composition). */
  const isEditable = useCallback((v: number) => v === editN || (editHash !== null && compAt(v)?.hash === editHash), [editN, editHash, versions, primary]); // eslint-disable-line react-hooks/exhaustive-deps
  const wanted = viewN === null ? null : viewN ?? intent[primary];

  // The editable draft of (creative, primary format): a module store, found again after a route change.
  const editKey = draftKey(slug, creative, primary);
  const [editDraft, editActions] = useDraft(editKey);
  const editDirty = editDraft !== null && isDirty(editDraft);
  const [openN, setOpenN] = useState<number | null>(null);
  /** Bumped to load the view again for the same version (a reopen after a discard). */
  const [reload1, setReload1] = useState(0);
  // What the canvas showed (the ★ by default) opens read-only when it is not the editable composition, unless a draft with
  // edits waits; a version chosen here is shown as asked (a version not in the history yet: the one a save just made).
  const shownDefault = wanted === null ? null : shownOf(states[primary], wanted);
  const viewOnly = shownDefault !== null && !isEditable(shownDefault) && !(wanted === undefined && editDirty)
    && (wanted === undefined || (wanted !== null && Boolean(states[primary]?.history.includes(wanted))));
  const n = viewOnly ? shownDefault : openN ?? editDraft?.base.n ?? editN;
  /** An older version opens in a draft of its own, never in the editable one. */
  const key = viewOnly ? `${editKey}#v${n}` : editKey;
  const [ownDraft, ownActions] = useDraft(key);
  const draft = viewOnly ? ownDraft : editDraft;
  const actions = viewOnly ? ownActions : editActions;
  const version = n !== null ? versions.find((v) => v.n === n) ?? null : null;
  const comp = compositionOf(version, primary);
  const latestComp = compositionOf(latest, primary);
  // No composition to edit (a legacy version, no version yet, a format outside the creative): the viewer. A version not in
  // the list yet (the one a save just made, until the reload) is not one.
  const loadingAll = !detail || !presetsLoaded;
  const known = Boolean(detail && (detail.creative.brief.formats.includes(format)
    || versions.some((v) => v.outputs.some((o) => o.format === format) || v.compositions?.some((x) => x.format === format))));
  const viewer = !loadingAll && (!known || n === null || (version !== null && comp === null));
  // The bar's creative crumb is the way back (user report 23): the creative's title, the variant, and `back` (T4).
  const backRef = useRef<() => void>(() => {});
  const crumbVariant = detail?.variants && !detail.variants.orphan ? detail.variants.letter.toUpperCase() : null;
  const bar = useBarClaim(ownKey, active && !viewer, { title: detail?.creative.title ?? null, variant: crumbVariant, open: () => backRef.current() });
  // A read-only view's draft goes when another version is shown (it never has edits).
  useEffect(() => (viewOnly ? () => { ownActions.discard(); } : undefined), [viewOnly, ownActions]);
  /** Shows version `v` of the format: the editable one in the editor, another one read-only. */
  const onView = useCallback((v: number) => setViewN(isEditable(v) ? null : v), [isEditable]);

  // The editor's view of the composition → the draft.
  const [view, setView] = useState<EditorCompositionView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const hasComp = comp !== null;
  useEffect(() => {
    if (n === null || !hasComp || !presetsLoaded) return;
    let alive = true;
    setLoadError(null);
    Promise.resolve().then(() => api.getEditorComposition(slug, creative, n, primary)).then((v) => {
      if (!alive) return;
      setView(v);
      actions.open(v, preset);
    }).catch((err: unknown) => { if (alive) setLoadError(message(err)); });
    return () => { alive = false; };
  }, [slug, creative, n, primary, hasComp, presetsLoaded, reload1, key]); // eslint-disable-line react-hooks/exhaustive-deps

  // A job (agent turn or render) at work on this creative.
  const job = useMemo(() => {
    if (!detail) return undefined;
    const mine = Object.values(live.jobs).filter((j) => j.key === detail.jobKey);
    return mine.find((j) => j.state === 'queued' || j.state === 'running') ?? mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }, [live.jobs, detail]);
  const working = job?.state === 'queued' || job?.state === 'running';
  const step = job && working ? (job.state === 'queued' ? t.web.creatives.queued : lastStep(live.events[job.id]) ?? t.web.creatives.working) : null;
  // A render of any version of this creative also stops a save (the core answers 409 `editor-busy`): final review M2.
  const renderPrefix = detail && detail.jobKey.startsWith('creative:') ? `render:${detail.jobKey.slice('creative:'.length)}:v` : null;
  const rendering = renderPrefix !== null && Object.values(live.jobs).some((j) => j.key.startsWith(renderPrefix) && (j.state === 'queued' || j.state === 'running'));

  // The base moved under the draft: another version changed the format.
  const dirty = draft !== null && isDirty(draft);
  // (a draft saved a moment ago may be newer than the version list still loading: not stale)
  const stale = !viewOnly && Boolean(draft && latestComp && latest && draft.base.n < latest.n && draft.base.hash !== latestComp.hash);
  const [conflict, setConflict] = useState(false);
  /** The core said the base moved (409), whatever the version list says yet. */
  const [moved, setMoved] = useState(false);
  const baseMoved = stale || moved;
  const [reopening, setReopening] = useState(false);
  useEffect(() => {
    // An untouched draft simply moves to the latest version; one with edits is kept and the user is told.
    if (!stale || !latest) return;
    if (!dirty) setOpenN(latest.n); else setConflict(true);
  }, [stale, dirty, latest?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // The live preview session of the base (shared and renewed by usePreviewSession) and the player.
  const preview = usePreviewSession({ slug, creative, n, format: primary, enabled: hasComp && n !== null });
  const [player, setPlayer] = useState<CompositionMedia | null>(null);
  const [attempt, setAttempt] = useState(0);
  const token = preview.state.kind === 'ready' ? preview.state.session.token : null;
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;
  const fps = draft?.composition.fps ?? DEFAULT_FPS;
  const controls = usePlayerControls(player, `${n}/${primary}`, fps);
  const [rate, setRate] = useState<Speed>('1');
  const [loop, setLoop] = useState(false);
  useEffect(() => { if (player) { player.loop = loop; player.playbackRate = Number(rate); } }, [player, loop, rate]);

  // The language shown (Phase 12): a read-only preview of a translation; the draft is shown again on the way back.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const localeSource = useMemo(() => (version ? localePreviewSource(versions, version, format) : null), [versions, version, format]);
  const localePreview = useLocalePreview({
    slug, creative, n: hasComp && localeSource ? localeSource.n : null, format, rows: localeSource?.rows ?? [], player, token, original: () => draftRef.current?.composition ?? null,
  });
  const localeActive = localePreview.locale !== null;

  // The draft → the player, once per change (the player coalesces per animation frame).
  const lastSeq = useRef(0);
  const sent = useRef<{ player: CompositionMedia | null; composition: Composition | null }>({ player: null, composition: null });
  useEffect(() => {
    if (!player || !draft || localeActive) return;
    if (sent.current.player === player && sent.current.composition === draft.composition) return;
    const first = sent.current.player !== player;
    sent.current = { player, composition: draft.composition };
    if (first && draft.ops.length === 0) return; // the frame shows the session's own composition
    lastSeq.current = player.setComposition(draft.composition);
  }, [player, draft?.composition, localeActive]); // eslint-disable-line react-hooks/exhaustive-deps
  // The runtime's answer to the latest draft: a refusal is shown (carry 6), never ignored.
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!player) return;
    const on = () => {
      const a = player.applied;
      if (!a || a.seq !== lastSeq.current) return;
      const first = a.errors.find((x) => x.code === 'compositionInvalid') ?? a.errors[0];
      setPreviewProblem(first ? t.web.render.runtimeError[first.code] ?? first.code : null);
    };
    player.addEventListener('compositionapplied', on);
    return () => player.removeEventListener('compositionapplied', on);
  }, [player, t]);

  // A frame of a (renewed) session is showing: its staged videos' session media go again (the player drops another
  // session's), then the draft once more so the runtime plays them.
  const stagedRef = useRef<StagedAsset[]>([]);
  stagedRef.current = draft?.staged ?? [];
  const onShowing = useCallback((shown: string | null) => {
    preview.showing(shown);
    if (!shown || !player) return;
    let any = false;
    for (const s of stagedRef.current) if (s.media && player.addSessionMedia(s.path, s.media)) any = true;
    const d = peekDraft(key);
    if (any && d) lastSeq.current = player.setComposition(d.composition);
  }, [preview, player, key]);

  // Staging (library assets and brand fonts): the large videos block the stage response until normalised.
  const [staging, setStaging] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const stageAsset = useCallback(async (from: StageRequest['from']): Promise<StagedAsset | null> => {
    setStageError(null);
    setStaging(true);
    try {
      const attemptStage = async (): Promise<StagedAsset> => {
        const used = tokenRef.current;
        if (!used) throw new Error(e.previewBusy);
        try {
          return await api.stageEditorAsset(slug, creative, { token: used, from });
        } catch (err) {
          // The session was renewed while the request was on its way: once more with the new token.
          if (err instanceof ApiError && err.code === 'editor-no-session' && tokenRef.current && tokenRef.current !== used) {
            return api.stageEditorAsset(slug, creative, { token: tokenRef.current, from });
          }
          throw err;
        }
      };
      const asset = await attemptStage();
      actions.stage(asset, { from, token: tokenRef.current ?? undefined });
      if (asset.media && player) player.addSessionMedia(asset.path, asset.media);
      return asset;
    } catch (err) {
      setStageError(e.stageFailed({ detail: message(err) }));
      return null;
    } finally {
      setStaging(false);
    }
  }, [slug, creative, actions, player, e]);

  // SVG inner editor: an edited SVG is staged like a library file, but a refusal goes back to the section that made it.
  const stageSvg = useCallback(async (from: SvgEditFrom): Promise<StagedSvgEdit> => {
    const used = tokenRef.current;
    if (!used) throw new Error(e.previewBusy);
    let asset: StagedSvgEdit;
    try {
      asset = await api.stageSvgEdit(slug, creative, { token: used, from });
    } catch (err) {
      // The session was renewed while the request was on its way: once more with the new token.
      if (!(err instanceof ApiError && err.code === 'editor-no-session' && tokenRef.current && tokenRef.current !== used)) throw err;
      asset = await api.stageSvgEdit(slug, creative, { token: tokenRef.current, from });
    }
    actions.stage(asset, { from, token: tokenRef.current ?? undefined });
    return asset;
  }, [slug, creative, actions, e]);

  // A new preview session (a renewal, or a fresh one after an expiry or an eviction): the draft's staged files must be in it
  // (decisions log 264). Those it took over come back in `session.staged`, with this session's media indices (final review
  // M1); a staged file that did not come along (used now or not: an undo may bring it back) is staged again from where it
  // came from, once. Save waits meanwhile.
  const session = preview.state.kind === 'ready' ? preview.state.session : null;
  const [restaging, setRestaging] = useState(false);
  useEffect(() => {
    const d = peekDraft(key);
    if (!session || !d || d.stagedIn === session.token) return;
    if (d.staged.length === 0) { actions.stagedIn(session.token); return; }
    const tok = session.token;
    const came = new Map((session.staged ?? []).map((a) => [a.path, a] as const));
    for (const a of came.values()) if (d.staged.some((x) => x.path === a.path)) actions.stage(a, { token: tok });
    // Every file staged for this draft, used now or not: an undo may bring an unused one back (final review N4).
    const missing = d.staged.filter((x) => !came.has(x.path));
    if (missing.length === 0) { actions.stagedIn(tok); return; }
    let alive = true;
    setRestaging(true);
    void (async () => {
      let lost: string | null = null;
      for (const m of missing) {
        const again = m.from ? await api.stageEditorAsset(slug, creative, { token: tok, from: m.from }).catch(() => null) : null;
        if (!alive || tokenRef.current !== tok) return;
        if (again && again.path === m.path) {
          actions.stage(again, { token: tok });
          if (again.media && player) player.addSessionMedia(again.path, again.media);
        } else lost ??= m.path;
      }
      actions.stagedIn(tok);
      const now = peekDraft(key);
      if (player && now) lastSeq.current = player.setComposition(now.composition);
      if (lost) setStageError(e.stagedLost({ file: lost }));
      else toast.show(e.stagedRestored);
    })().finally(() => { if (alive) setRestaging(false); });
    // A renewal during the re-stage ends this run: its flag must not stay up (the next run raises it again if needed).
    return () => { alive = false; setRestaging(false); };
  }, [session?.token, key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save as vN. (`retargetPins` is set below, where the pending comments are.)
  const retargetPins = useRef<(base: number, to: number) => void>(() => {});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ name: string; n: number } | null>(null);
  const savedTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(savedTimer.current), []);
  const nextN = (latest?.n ?? n ?? 0) + 1;
  const reelName = instanceName(preset ?? null, primary, locale, labels);
  const save = useCallback(async (): Promise<boolean> => {
    const d = peekDraft(key);
    if (!d || saving) return false;
    if (d.svgPending.size > 0) { setSaveError(e.saveWhileStaging); return false; }
    setSaving(true);
    setSaveError(null);
    const body = (tok: string) => ({
      baseVersion: d.base.n, format: d.primaryFormat, baseHash: d.base.hash, composition: d.composition, staged: usedStaged(d).slice(0, SAVE_STAGED_MAX), ops: compactOps(d.ops), token: tok,
    });
    try {
      const first = tokenRef.current;
      if (!first) throw new Error(e.previewBusy);
      let res: { version: number };
      try {
        res = await api.saveEdits(slug, creative, body(first));
      } catch (err) {
        // The session was renewed meanwhile: the staging moved with it, save with the new token.
        if (err instanceof ApiError && tokenRef.current && tokenRef.current !== first && (err.status === 422 || err.status === 404)) res = await api.saveEdits(slug, creative, body(tokenRef.current));
        else throw err;
      }
      // Comments not sent yet move to the new version (final review I4): the pin source becomes it, and the clip ids carry over.
      retargetPins.current(d.base.n, res.version);
      actions.discard();
      setView(null);
      setOpenN(res.version);
      setViewN(null);
      setConflict(false);
      setMoved(false);
      reload();
      setSaved({ name: reelName, n: res.version });
      window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSaved(null), SAVED_MS);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'editor-base-changed') { setConflict(true); setMoved(true); setSaveError(err.message); reload(); } else if (err instanceof ApiError && err.problems?.length) setSaveError(err.message);
      else setSaveError(err instanceof ApiError ? err.message : e.saveFailed({ detail: message(err) }));
      return false;
    } finally {
      setSaving(false);
    }
  }, [key, saving, slug, creative, actions, reload, reelName, e]);

  // Discard: the player is told the base again (clearing the draft sends nothing), then the editor starts a new draft.
  const discardDraft = useCallback(() => {
    const base = peekDraft(key)?.baseComposition;
    actions.discard();
    if (player && base) lastSeq.current = player.setComposition(base);
    setSaveError(null);
    setPreviewProblem(null);
    if (view) actions.open(view, preset);
    // The fresh draft is the base itself: the player already shows it.
    const fresh = peekDraft(key);
    if (player && fresh) sent.current = { player, composition: fresh.composition };
  }, [key, actions, player, view, preset]);

  // The leave guard (Review Focus 3): back, a format or version switch, the browser's back button, a link, a chat message.
  const [leave, setLeave] = useState<Leave | null>(null);
  useEffect(() => registerLeaveGuard({
    blocks: (hash) => { const d = peekDraft(editKey); return d !== null && isDirty(d) && routeKey(parseRoute(hash)) !== ownKey; },
    ask: (hash) => setLeave({ mode: 'route', target: hash }),
  }), [editKey, ownKey]);
  const beforeSend = useCallback(() => new Promise<boolean>((resolve) => {
    const d = peekDraft(editKey);
    if (!d || !isDirty(d)) { resolve(true); return; }
    setLeave({ mode: 'chat', resolve });
  }), [editKey]);
  const settle = (ok: boolean) => {
    const l = leave;
    setLeave(null);
    if (!l) return;
    if (l.mode === 'chat') l.resolve(ok); else if (ok) go(l.target);
  };
  const leaveSave = async () => { settle(await save()); };
  // An older version on screen: the editable draft goes without touching the player (it shows the older version).
  const leaveDiscard = () => { if (viewOnly) editActions.discard(); else discardDraft(); settle(true); };
  // A dialog closed any other way (Esc, the scrim) is "Keep editing".
  const leaveKeep = () => settle(false);

  // Selection (set by the stage handles, the timeline, the layers and the scenes: Tasks 6 to 9). Selecting a clip shows its
  // inspector, unless the user is writing in the chat (user test item 16: the composer focused, or with text in it); a
  // comment shows the chat (the right column's tabs, decision 930).
  const [selection, setSelection] = useState<string | null>(null);
  const [tab, setTab] = useState<'chat' | 'inspector'>('chat');
  const toInspector = useCallback(() => {
    // The chat's text fields (the composer above all): any of them focused or holding text means the user is writing there.
    const panel = root.current?.querySelector('#ms-ed-panel');
    const fields = panel ? [...panel.querySelectorAll<HTMLTextAreaElement>('textarea')] : [];
    if (fields.some((f) => f === document.activeElement || f.value.trim() !== '')) return;
    setTab('inspector');
  }, []);
  const select = useCallback((id: string | null) => { setSelection(id); if (id !== null) toInspector(); }, [toInspector]);
  // The magnet (stage guides now, the timeline's edges in Task 7): per editor, not saved.
  const [snap, setSnap] = useState(true);
  /** The image editor's zoom: null is Fit, otherwise 50 to 400 %. Not saved. */
  const [zoom, setZoom] = useState<number | null>(null);
  useEffect(() => { setSelection(null); }, [n, primary]);
  // The SVG element chosen belongs to the clip it was chosen in: another selection is the layer again.
  const [svgPick, setSvgPick] = useState<{ clip: string; path: string } | null>(null);
  const svgElement = svgPick !== null && svgPick.clip === selection ? svgPick.path : null;
  const selectSvgElement = useCallback((path: string | null, clipId?: string) => {
    const clip = clipId ?? selection;
    if (clip === null) return;
    if (clip !== selection) setSelection(clip);
    setSvgPick(path === null ? null : { clip, path });
    toInspector();
  }, [selection, toInspector]);
  const video = draft ? draft.composition.duration > 0 : preset?.kind !== 'image';

  // Comments (Task 10, and the format view's spot of the frame). Like the format view's, they go on the pin source (the version
  // resumed from, else the latest) and become chips in the conversation; the note is asked in a small dialog. The version
  // edited is the format's history entry: a pin source that carried the format unchanged (another format changed) has the
  // same composition.
  // Phase 3 of the single agent: in a group with one agent the pending comments are the group's (each with its variant).
  const { stored: storedPins, setStored: setStoredPins, others: otherPins, drop: dropPins } = useChatPins(slug, creative, groupChat.pinScope);
  const pinSource = detail ? detail.creative.resumeFrom?.version ?? latest?.n ?? null : null;
  const canComment = n !== null && entryAt(versions, states[primary], pinSource) === n;
  const sourcePins = useMemo(() => storedPins.flatMap((p, i) => (p.version === pinSource ? [{ pin: p.pin, at: i }] : [])), [storedPins, pinSource]);
  // The pending comments as markers on the ruler and the picture, numbered as the chips (only on the version they apply to).
  const marks = useMemo<Mark[]>(() => (canComment ? sourcePins.map((p, i) => ({ pin: p.pin, number: i + 1 })) : [])
    .filter((m) => m.pin.format === format || m.pin.format === primary), [canComment, sourcePins, format, primary]);
  retargetPins.current = (base, to) => setStoredPins((ps) => (ps.some((p) => p.version === base || p.version === pinSource)
    ? ps.map((p) => (p.version === base || p.version === pinSource ? { ...p, version: to } : p)) : ps));
  const [rangeOpen, setRangeOpen] = useState(false);
  const askRange = () => { if (commentVideo) setRangeOpen(true); };
  /** The note dialog of a comment; `stay`: the user stays where they are once it is added (the chat tab is not shown). */
  const [noteFor, setNoteFor] = useState<{ pin: Pin; index: number | null; stay?: boolean } | null>(null);
  const commentVideo = Boolean(draft && draft.composition.duration > 0);
  const startComment = (pin: Pin, o: { stay?: boolean } = {}) => {
    if (!canComment) { toast.show(t.web.conversation.onlyOnVersion({ n: pinSource ?? 0 })); return; }
    setNoteFor({ pin, index: null, ...(o.stay ? { stay: true } : {}) });
  };
  /** The name of the picked SVG element, as the layers tree and the inspector show it (null without one). */
  const pickedElement = (): { path: string; name: string } | null => {
    if (svgElement === null || !draft || !selection) return null;
    const clip = findClipById(draft.composition, selection);
    const text = clip && clip.type === 'svg' ? draft.svgTexts.get(clip.src) : undefined;
    const parsed = text !== undefined ? parseSvg(text) : null;
    const el = parsed?.ok ? listElements(parsed.doc).find((x) => x.path === svgElement) : undefined;
    return el ? { path: el.path, name: pinClipName(el.named ? el.label : e.svgElementName({ tag: el.tag, n: el.index })) } : null;
  };
  const commentClip = () => {
    if (!draft) return;
    const clip = selection ? findClipById(draft.composition, selection) : null;
    if (!clip) { toast.show(video ? t.web.conversation.clipCommentNeeds : e.commentLayerNeeds); return; }
    const drawn = player?.clipBounds && player.clipBounds.clipId === clip.id ? player.clipBounds : null;
    const time = commentVideo ? controls.clock.get().time : 0;
    const element = pickedElement();
    const pin = { ...clipPin({ format: primary, comp: draft.composition, clip, time, drawn }), ...(element ? { element } : {}) };
    startComment(commentVideo ? pin : { ...pin, timeSec: null });
  };
  const commentRange = (r: { start: number; end: number }) => {
    if (!draft) return;
    const pin = rangePin({ format: primary, start: r.start, end: r.end, duration: draft.composition.duration });
    if (pin) startComment(pin);
  };
  // A spot of the frame (the format view's click on the paused picture): "Comment a spot" or `P`, then a click on the frame.
  const [spotMode, setSpotMode] = useState(false);
  useEffect(() => { if (!canComment) setSpotMode(false); }, [canComment]);
  const toggleSpot = () => {
    if (!canComment) { toast.show(t.web.conversation.onlyOnVersion({ n: pinSource ?? 0 })); return; }
    if (controls.playing) controls.pause();
    setSpotMode((m) => !m);
  };
  const placeSpot = (ev: ReactMouseEvent<HTMLButtonElement>) => {
    ev.stopPropagation();
    const pt = pointIn(ev.currentTarget.getBoundingClientRect(), ev);
    setSpotMode(false);
    startComment({ format, x: pt.x, y: pt.y, timeSec: video ? round3(controls.clock.get().time) : null });
  };
  /**
   * "Ask the agent" on a custom animation (user test items 10, 18): the note dialog of a comment bound to the clip and its
   * animation slot, as a clip or spot comment; the user stays in the editor and the comment waits in the chat's pending list.
   */
  const askAnimation = (clipId: string, slot: 'in' | 'out') => {
    const clip = draft ? findClipById(draft.composition, clipId) : null;
    if (!draft || !clip || pinSource === null) return;
    const time = slot === 'in' ? clip.start : Math.max(clip.start, clip.start + clip.duration - 1 / draft.composition.fps);
    const pin: Pin = { ...clipPin({ format: primary, comp: draft.composition, clip, time }), animation: slot };
    startComment(commentVideo ? pin : { ...pin, timeSec: null }, { stay: true });
  };
  /** "Ask the agent to change it" on an element of an svg clip (user test item 13): the same, bound to the clip and the element. */
  const askElement = (clipId: string, element: { path: string; name: string }) => {
    const clip = draft ? findClipById(draft.composition, clipId) : null;
    if (!draft || !clip || pinSource === null) return;
    const drawn = player?.clipBounds && player.clipBounds.clipId === clip.id ? player.clipBounds : null;
    const pin: Pin = { ...clipPin({ format: primary, comp: draft.composition, clip, time: commentVideo ? controls.clock.get().time : 0, drawn }), element: { path: element.path, name: pinClipName(element.name) } };
    startComment(commentVideo ? pin : { ...pin, timeSec: null }, { stay: true });
  };
  const submitNote = (note: string) => {
    const open = noteFor;
    setNoteFor(null);
    if (!open || pinSource === null) return;
    const withNote: Pin = { ...open.pin, ...(note ? { note } : {}) };
    if (!note) delete withNote.note;
    if (open.index === null) {
      setStoredPins((ps) => [...ps, { pin: withNote, version: pinSource }]);
      if (open.stay) toast.show(t.web.conversation.commentWaiting); else setTab('chat');
    } else {
      const at = sourcePins[open.index]?.at;
      setStoredPins((ps) => ps.map((p, k) => (k === at ? { ...p, pin: withNote } : p)));
    }
  };
  const removePin = useCallback((i: number) => {
    const at = sourcePins[i]?.at;
    setStoredPins((ps) => ps.filter((_, k) => k !== at));
  }, [sourcePins, setStoredPins]);
  const editPin = useCallback((i: number) => {
    const pin = sourcePins[i]?.pin;
    if (pin) setNoteFor({ pin, index: i });
  }, [sourcePins]);
  const pinsSent = useCallback(({ pins: sentPins }: { pins: Pin[] }) => { dropPins(sentPins); }, [dropPins]);
  const noteName = noteFor ? noteFor.pin.clipName ?? noteFor.pin.clipId ?? '' : '';
  const noteTitle = noteFor ? (noteFor.pin.clipId && noteFor.pin.animation
    ? (noteFor.pin.animation === 'in' ? t.web.conversation.noteTitleAnimIn : t.web.conversation.noteTitleAnimOut)({ name: noteName })
    : noteFor.pin.clipId && noteFor.pin.element ? t.web.conversation.noteTitleElement({ name: noteName, element: noteFor.pin.element.name })
    : noteFor.pin.clipId && !noteFor.pin.range
    ? t.web.conversation.noteTitleClip({ name: noteName })
    : noteFor.pin.range ? t.web.conversation.noteTitleRange(rangeTimes(locale, noteFor.pin.range))
      : noteFor.pin.timeSec !== null ? f.commentFrame({ time: timecode(noteFor.pin.timeSec) }) : c.commentOn({ label: labelOf(format) })) : '';

  // Read-only (decision 916): a discarded variant, an older version on screen, an agent turn or a render at work. The draft
  // actions refuse and the panels disable their controls; the reason is said on the stage and in the inspector.
  const discarded = discardedSelf(detail?.variants).discarded;
  const readOnly = discarded ? t.web.variantGroup.discardedReadOnly
    : viewOnly && n !== null && editN !== null ? e.olderVersion({ n, latest: editN })
      : working || rendering ? e.busyAgent : null;
  const safeActions = useMemo<DraftActions>(() => (readOnly === null ? actions
    : { ...actions, apply: () => READ_ONLY_EDIT, applyAll: () => READ_ONLY_EDIT, undo: () => {}, redo: () => {} }), [actions, readOnly]);

  // Keys.
  useEditorKeys(root, Boolean(draft) && active && leave === null, {
    commentClip,
    commentRange: askRange,
    commentSpot: toggleSpot,
    undo: () => safeActions.undo(),
    redo: () => safeActions.redo(),
    toggle: controls.toggle,
    step: controls.step,
    deselect: () => { if (spotMode) setSpotMode(false); else setSelection(null); },
    remove: () => toast.show(e.keysDeleteClip),
  });

  // Alt+arrows nudge the selected clip (the inspector's X and Y are the other keyboard path): one undo step per burst.
  useNudgeKeys(root, Boolean(draft) && active && leave === null, {
    can: () => (draft ? nudgeable(draft, selection) : false),
    nudge: (dx, dy) => {
      const fresh = peekDraft(key) ?? draft; // the store now: two presses in one tick must not start from the same x
      if (!fresh) return;
      const r = nudgeClip(fresh, safeActions, selection, dx, dy);
      if (r.ok) return;
      if (r.reason === 'locked') toast.show(e.locked);
      else if (r.reason === 'refused') toast.show(editProblemText(r.result.problem, locale));
    },
  });

  // T4: back to the canvas (the board grows back from the stage), showing there the version that was on screen.
  const back = () => {
    controls.pause();
    if (frame.current) setFrameOrigin(`canvas:${slug}/${creative}/${format}`, frame.current.getBoundingClientRect());
    if (n !== null) setShownVersions(`${slug}/${creative}`, { [primary]: n });
    go(href.creative(slug, creative));
  };
  backRef.current = back;

  // T3: the board grows into the stage's frame, there from the first render (sized from the catalog); then the side panels.
  const flipped = useRef(false);
  useLayoutEffect(() => {
    if (flipped.current || !frame.current) return;
    flipped.current = true;
    const fresh = origin && performance.now() - mountedAt <= FLIP_WINDOW_MS ? origin : null;
    if (fresh) void flip(frame.current, fresh, D.l);
  });
  const appeared = useRef(false);
  const ready = Boolean(draft) && !loadError;
  useEffect(() => {
    if (appeared.current || !ready || !root.current) return;
    appeared.current = true;
    root.current.querySelectorAll<HTMLElement>('[data-part]').forEach((el) => {
      const part = el.dataset.part;
      void enter(el, { x: part === 'l' ? -16 : part === 'r' ? 16 : 0, y: part === 'b' ? 24 : 0, ms: D.m });
    });
  }, [ready]);

  const [exporting, setExporting] = useState<{ open: boolean; snapshot: ExportSnapshot } | null>(null);
  // Decision 980: the group's one chat shows every variant's approvals.
  const myApprovals = useMemo(() => Object.values(live.approvals).filter(groupChat.shows), [live.approvals, groupChat]);
  // Phase 3 of the single agent: the chat follows the group's turn (the composer sends to the group).
  const chatJob = groupChat.single ? groupChat.groupJob : job;
  const chatLive = useMemo(() => (chatJob ? live.events[chatJob.id] ?? [] : []), [chatJob, live.events]);
  const primaries = (detail?.creative.brief.formats ?? []).filter((id) => states[id] && !states[id]!.follows);
  const appliesTo = useMemo(() => (versions.length && primaries.length > 1 ? {
    primaries: primaries.map((id) => ({ id, label: labelOf(id), followers: followersOf(states, id).map(labelOf) })),
    followerOf: (id: string) => states[id]?.follows ?? null,
    fallback: [primary],
    groups: appliesGroups(primaries, presets, detail?.creative.brief ?? {}, locale, t.web.formatUi.other),
  } : undefined), [versions.length, primaries.join(','), states, labelOf, primary, presets, detail?.creative.brief, locale, t]); // eslint-disable-line react-hooks/exhaustive-deps
  // After a message the page shows what the canvas would (the ★ or the version being edited).
  const onSent = useCallback((sent: { pins: Pin[] }) => { pinsSent(sent); setViewN(undefined); reload(); }, [reload, pinsSent]);
  // "View vN" of a version card: this format as it was in vN (read-only unless it is the editable composition).
  const onSelectVersion = useCallback((v: number) => {
    const entry = entryAt(versions, states[primary], v);
    if (entry !== null) onView(entry);
  }, [versions, states, primary, onView]);

  // Versions, render, duplicate, compare (what the format view's bar had).
  const [actionError, setActionError] = useState<string | null>(null);
  const vdetail = detail?.variants;
  const group = vdetail && !vdetail.orphan ? vdetail : null;
  const versionActions = useVersionActions({ slug, creative, states, labelOf, resumeFrom: detail?.creative.resumeFrom?.version ?? null, onChanged: reload, onError: setActionError,
    // Phase 15: in a variant group the ★ is the group's (this variant, this version), written through the host.
    ...(group ? { groupPick: (id: string, v: number | null) => api.setVariantPick(slug, group.host, id, v === null ? null : { slug: creative, version: v }) } : {}) });
  const versionButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [history, setHistory] = useState(false);
  // The viewer announces new versions itself while it is shown.
  useNewVersionNotice(Boolean(detail) && !viewer, latest?.n ?? null, active && !viewer, versionButton);
  const [compare, setCompare] = useState<{ open: boolean; init: [number, number] } | null>(null);
  /** Compare (the badge): the version on screen against the entry before it in the format's history. */
  const openCompare = () => {
    const s = states[primary];
    if (!s || n === null || s.history.length < 2) return;
    const i = s.history.indexOf(n);
    const other = s.history[i - 1] ?? s.history[i + 1]!;
    setCompare({ open: true, init: other < n ? [other, n] : [n, other] });
  };
  // Duplicate format (Phase 12): the next free instance of this format, copied from the version on screen; opens the new one.
  const [duplicating, setDuplicating] = useState(false);
  const duplicate = async () => {
    if (!version || duplicating) return;
    setDuplicating(true);
    setActionError(null);
    try {
      const r = await api.duplicateFormat(slug, creative, version.n, { instanceId: format });
      controls.pause();
      reload();
      toast.show(t.web.instances.duplicated({ label: instanceName(ownPreset ?? null, r.instanceId, locale, labels) }), { tone: 'ok' });
      go(href.format(slug, creative, r.instanceId));
    } catch (err) {
      setActionError(t.web.instances.duplicateFailed({ detail: message(err) }));
    }
    setDuplicating(false);
  };
  // Identity formats (Phase 14): the editor, the rendered picture (a logo on light and on dark) or the sizes grid of its set.
  const out = version?.outputs.find((o) => o.format === primary) ?? null;
  const idKind = ownPreset?.identity ?? null;
  const idSet = idKind && out?.identitySet ? out.identitySet : null;
  const darkLogo = idKind === 'logo' && idSet ? idSet.files.find((x) => x.path === 'logo-dark.png') ?? null : null;
  const [idView, setIdView] = useState<'edit' | 'image' | 'sizes'>('edit');
  const [safe, setSafe] = useState(false);

  const ctx: EditorState | null = draft ? {
    slug, creative, format, primary, draft, actions: safeActions, player, controls, selection, select, snap, setSnap, token, staging,
    stageAsset: readOnly === null ? stageAsset : async () => null,
    stageSvg: readOnly === null ? stageSvg : async () => { throw new Error(readOnly); },
    readOnly, svgElement, selectSvgElement, askAnimation, askElement,
  } : null;

  // ---- states without an editor
  if (error && !detail) {
    return (
      <div className="ms-cv-state">
        <Empty icon="warn" title={c.tryAgain} sub={<span role="alert">{c.loadFailed({ detail: error })}</span>}
          action={<Button variant="ink" onClick={reload}><Icon name="refresh" size={13} />{c.tryAgain}</Button>} />
      </div>
    );
  }
  if (viewer) {
    // No composition to edit: the viewer, inside this route, with the version choice kept here.
    const viewing = wanted !== undefined && wanted !== null ? { [primary]: wanted } : {};
    return (
      <FormatView slug={slug} creative={creative} format={format} live={live} exportNamePattern={exportNamePattern} onSettings={onSettings} origin={origin}
        viewing={viewing} onViewing={(u) => {
          const next = typeof u === 'function' ? u(viewing) : u;
          const v = next[primary];
          setViewN(v === undefined ? undefined : isEditable(v) ? null : v);
        }} />
    );
  }

  const width = draft?.composition.width ?? preset?.width ?? 1080;
  const height = draft?.composition.height ?? preset?.height ?? 1920;
  const label = labelOf(primary);
  const ownLabel = labelOf(format);
  // The version's duration against the brief's (decisions log 262): a discreet note, never a change of the brief.
  const briefSec = detail?.creative.brief.durationSec ?? null;
  const offBrief = Boolean(draft && video && briefSec !== null && isDurationOffBrief(draft.composition.duration, briefSec));
  const meta = draft
    ? video
      ? e.meta({ size: `${width}×${height}`, seconds: formatNumber(locale, draft.composition.duration, { maximumFractionDigits: 1 }), fps: draft.composition.fps })
      : e.metaImage({ size: `${width}×${height}` })
    : '';
  const frameStyle: CSSProperties = zoomFrame(width, height, video ? null : zoom);
  const alsoList = followers.map(labelOf).join(', ');
  const blocked = !draft ? null
    : viewOnly ? e.saveFromLatest
      : working || rendering ? e.busyAgent
        : baseMoved ? e.baseChangedTitle
          // A file being staged (a video converting) or staged again in a new session: the save would wait on it (M3).
          // So are the SVG changes not applied yet (SVG inner editor): the save would miss the last one.
          : staging || restaging || draft.svgPending.size > 0 ? e.saveWhileStaging
            : draft.problems.length > 0 ? compositionProblemText(draft.problems[0]!, locale) : null;
  const cr = detail?.creative ?? null;
  const state = states[format];
  const primaryLabel = state?.follows ? labelOf(state.follows) : null;
  const primaryStar = state?.follows ? states[state.follows]?.star.version ?? null : null;
  const otherView = idSet !== null && idView !== 'edit';
  const imgSrc = out && version ? outputUrl(slug, creative, version.n, out.file) : null;
  const darkSrc = darkLogo && idSet && version ? outputUrl(slug, creative, version.n, `${idSet.dir}/${darkLogo.path}`) : null;
  const pickedBy = group?.group.picks[primary];
  const channel = ownPreset ? channelName(ownPreset.channel, locale) : null;

  const page = (
    <div ref={root} className={cx('ms-ed', video ? 'ms-ed-video' : 'ms-ed-image')} aria-busy={!draft || undefined}>
      {bar?.title ? createPortal(
        <>
          <span className="ms-crumb ms-last ms-fv-crumb">
            <span className="ms-crumb-sep" aria-hidden="true">/</span>
            {ownPreset ? <ChannelMark channel={channelOf(ownPreset.channel)} /> : null}
            <b aria-current="page" title={[channel, meta].filter(Boolean).join(' · ') || undefined}>{instanceName(ownPreset ?? null, format, locale, labels)}</b>
          </span>
          {meta ? <span className="ms-fv-meta" title={meta}>{meta}</span> : null}
          {offBrief && draft && cr ? (
            <BriefOffChip slug={slug} creative={creative} brief={cr.brief} actual={draft.composition.duration} edited={version?.origin === 'editor'}
              disabled={discarded ? t.web.variantGroup.discardedReadOnly : working ? e.busyAgent : null} onChanged={reload} />
          ) : null}
          {out && !out.verified ? <Pill tone="warn" className="ms-cv-state-pill">{t.web.formatUi.unverified}</Pill> : null}
        </>,
        bar.title,
      ) : null}
      {bar?.end ? createPortal(
        <>
          {state && cr && state.follows && primaryLabel ? (
            <span className="ms-fv-badge">
              <FollowerChip label={ownLabel} primary={primaryLabel} primaryStar={primaryStar} follower={format} actions={versionActions} busy={working} />
              <span className="ms-fv-follows">{primaryStar !== null ? t.web.formatVersions.followsStar({ primary: primaryLabel, n: primaryStar }) : t.web.formatVersions.follows({ primary: primaryLabel })}</span>
            </span>
          ) : state && cr ? (
            <span className="ms-fv-badge">
              <FormatBadge bar buttonRef={versionButton} slug={slug} creative={creative} label={ownLabel} versions={versions} shown={n} resumeFrom={cr.resumeFrom?.version ?? null}
                state={group ? { ...state, star: { ...state.star, version: pickedBy?.slug === creative ? pickedBy.version : null, manual: pickedBy?.slug === creative, newer: null } } : state}
                labelOf={labelOf} actions={versionActions} busy={working} onView={onView} onCompare={openCompare} />
            </span>
          ) : null}
          <LanguagesButton slug={slug} creative={creative} detail={detail} version={version ?? latest} presets={presets} live={live} onChanged={reload} readOnly={discarded ? t.web.variantGroup.discardedReadOnly : null} />
          {/* Decision 974: no Render button; Export renders what it needs and shows a render or an export in progress. */}
          <ExportButton jobs={Object.values(live.jobs)} jobKey={detail?.jobKey ?? null} scope={comp !== null ? { version, format: primary } : null} disabled={!latest}
            onClick={() => { if (latest) setExporting({ open: true, snapshot: { versions, states } }); }} />
          {/* User report 17: the rare actions in "…": Duplicate format, and the variant's version history (decision 972). */}
          {(comp !== null && !working) || (versions.length && cr) ? (
            <BarMenu buttonRef={moreButton}>
              {(close) => (
                <>
                  {comp !== null && !working ? (
                    <BarMenuItem icon="copy" close={close} run={() => void duplicate()} hint={t.web.instances.duplicateHint({ label: ownLabel })}
                      disabled={discarded ? t.web.variantGroup.discardedReadOnly : duplicating ? t.web.instances.duplicate : null}>{t.web.instances.duplicate}</BarMenuItem>
                  ) : null}
                  {versions.length && cr ? (
                    <BarMenuItem icon="clock" close={close} run={() => setHistory(true)}>
                      {crumbVariant ? t.web.canvas.versions.historyItemVariant({ letter: crumbVariant }) : t.web.canvas.versions.historyItem}
                    </BarMenuItem>
                  ) : null}
                </>
              )}
            </BarMenu>
          ) : null}
          {versions.length && cr ? (
            <VersionTimeline slug={slug} creative={creative} versions={versions} resumeFrom={cr.resumeFrom?.version ?? null} actions={versionActions}
              open={history} onClose={() => setHistory(false)} anchor={moreButton} />
          ) : null}
        </>,
        bar.end,
      ) : null}

      <aside className="ms-ed-side ms-ed-left" aria-label={video ? e.scenes : e.layers} data-part="l">
        <div className="ms-fv-side-head"><b>{video ? e.scenes : e.layers}</b></div>
        {draft ? (video ? <ScenesColumn /> : <LayersPanel />) : (
          <div className="ms-ed-slot" data-slot={video ? 'scenes' : 'layers'}>
            <p>{video ? e.scenesSoon : e.layersSoon}</p>
          </div>
        )}
      </aside>

      <main className="ms-fv-main ms-ed-main" aria-label={e.stage({ label })}>
        <div className="ms-ed-tools">
          {/* The stage's tools (user test item 15): undo and redo as icons with their shortcut; the comments with a visible
              label, disabled with the reason when they do not apply; the magnet only on an image (a video has the timeline's). */}
          <div className="ms-ed-undo" role="toolbar" aria-label={e.draft({ n: draft?.ops.length ?? 0 })}>
            <Button size="sm" variant="ghost" icon aria-label={e.undo} title={e.undoTip({ keys: isMac() ? '⌘Z' : 'Ctrl+Z' })} aria-keyshortcuts={isMac() ? 'Meta+Z' : 'Control+Z'}
              disabled={!draft || readOnly !== null || draft.past.length === 0} onClick={() => safeActions.undo()}><Icon name="undo" size={14} /></Button>
            <Button size="sm" variant="ghost" icon aria-label={e.redo} title={e.redoTip({ keys: isMac() ? '⇧⌘Z' : 'Ctrl+Shift+Z' })} aria-keyshortcuts={isMac() ? 'Shift+Meta+Z' : 'Control+Shift+Z'}
              disabled={!draft || readOnly !== null || draft.future.length === 0} onClick={() => safeActions.redo()}><Icon name="redo" size={14} /></Button>
            {draft && !video ? (
              <Button size="sm" variant="ghost" icon className="ms-ed-snap" aria-label={e.snap} title={e.snapTip} aria-pressed={snap} onClick={() => setSnap(!snap)}><Icon name="magnet" size={14} /></Button>
            ) : null}
          </div>
          <div className="ms-ed-comments" role="toolbar" aria-label={e.commentTools}>
            <Button size="sm" variant={spotMode ? 'outline' : 'ghost'} className="ms-ed-spot" aria-pressed={spotMode} aria-keyshortcuts="P"
              title={canComment ? e.commentSpotTip : e.commentSpotLocked({ n: pinSource ?? 0 })} disabled={!draft || !canComment} onClick={toggleSpot}>
              <Icon name="pin" size={13} />{e.commentSpot}
            </Button>
            {draft && !video ? (
              <Button size="sm" variant="ghost" className="ms-ed-comment" aria-keyshortcuts="C" disabled={selection === null || !canComment}
                title={!canComment ? e.commentSpotLocked({ n: pinSource ?? 0 }) : selection === null ? e.commentLayerNeeds : svgElement !== null ? e.commentElementTip : e.commentLayerTip} onClick={commentClip}>
                <Icon name="comment" size={13} />{svgElement !== null ? e.commentElement : e.commentLayer}
              </Button>
            ) : null}
          </div>
          <span className="ms-grow" />
          {draft && (dirty || saved) ? (
            <DraftPill edits={draft.ops.length} nextN={nextN} blocked={blocked} saving={saving} saved={saved} onSave={() => { void save(); }} onDiscard={discardDraft} />
          ) : null}
          <span className="ms-grow" />
          {preset?.safeZone && draft && !otherView ? (
            <span className="ms-fv-safe-toggle"><Toggle size="sm" on={safe} onChange={setSafe} label={c.safeZones} /><span aria-hidden="true">{c.safeZones}</span></span>
          ) : null}
        </div>
        <div className="ms-fv-notes">
          {integrity.state ? <IntegrityNotice slug={slug} state={integrity.state} reload={integrity.reload} /> : null}
          {presetsFailure ? <p role="alert" className="ms-cv-note ms-err">{t.web.creative.formatsLoadFailed({ detail: presetsFailure })}</p> : null}
          {cr?.resumeFrom ? <p className="ms-cv-note ms-info">{t.web.creative.resumeNote({ n: cr.resumeFrom.version })}</p> : null}
          {cr && (cr.status === 'error' || cr.status === 'interrupted') && cr.error && !working ? <p role="alert" className="ms-cv-note ms-err">{cr.error}</p> : null}
          {actionError ? <p role="alert" className="ms-cv-note ms-err">{actionError}</p> : null}
          {primary !== format ? <p className="ms-cv-note ms-info" role="status">{e.editingPrimary({ primary: labelOf(primary), also: alsoList })}</p>
            : followers.length > 0 ? <p className="ms-cv-note ms-info ms-ed-also" role="status">{e.alsoUsedBy({ list: alsoList })}</p> : null}
          {readOnly ? (
            <p className="ms-cv-note ms-info ms-ed-readonly" role="status">
              <Icon name="lock" size={13} /><span>{readOnly}</span>
              {viewOnly && editN !== null ? <Button size="sm" variant="outline" onClick={() => setViewN(null)}>{e.editLatest({ n: editN })}</Button> : null}
            </p>
          ) : null}
          {working && step ? (
            <div className="ms-cv-note ms-info ms-fv-gen">
              <div className="ms-progress ms-indet" role="progressbar" aria-label={t.web.ui.progress}><i /></div>
              <span className="ms-cv-gen-step">{step}</span>
            </div>
          ) : null}
          {idSet && idKind && n !== null ? (
            <div className="ms-idn-bar">
              <Segmented<'edit' | 'image' | 'sizes'> label={t.web.identity.view} value={idView} onChange={setIdView}
                options={[{ value: 'edit', label: e.edit, icon: 'edit' }, { value: 'image', label: t.web.identity.viewImage, icon: 'image' }, { value: 'sizes', label: t.web.identity.viewSizes, icon: 'grid' }]} />
              {idSet.files.some((x) => x.role === 'vector') ? (
                <UseAsBrandLogo slug={slug} creative={creative} n={n} format={primary} label={label} kind={idKind} disabled={working} hasDark={darkLogo !== null} />
              ) : null}
              {idKind === 'logo' && darkLogo === null ? (
                <span className="ms-idn-nodark" role="note" title={t.web.identity.noDarkLogoTip}><Icon name="refresh" size={13} />{t.web.identity.noDarkLogo}</span>
              ) : null}
            </div>
          ) : null}
          {loadError ? <p role="alert" className="ms-cv-note ms-err">{e.loadFailed({ detail: loadError })}</p> : null}
          {baseMoved && !conflict && dirty ? (
            <p className="ms-cv-note ms-err ms-ed-stale" role="alert">
              {e.baseChangedBody({ name: labelOf(primary), n: latest?.n ?? 0 })}
              <Button size="sm" variant="outline" onClick={() => setReopening(true)}>{e.reopenLatest}</Button>
            </p>
          ) : null}
          {saveError ? <p role="alert" className="ms-cv-note ms-err">{saveError}</p> : null}
          {previewProblem ? <p role="alert" className="ms-cv-note ms-err">{e.previewRefused({ text: previewProblem })}</p> : null}
          {stageError ? <p role="alert" className="ms-cv-note ms-err">{stageError}</p> : null}
          {staging ? <p className="ms-cv-note ms-info ms-ed-staging" role="status"><Spinner size={13} label={e.stagingLong} />{e.stagingLong}</p> : null}
        </div>
        {otherView && idSet && idKind && n !== null ? (
          idView === 'sizes' ? (
            <section className="ms-fv-stage ms-idn-stage" aria-label={t.web.identity.sizesTitle}>
              <IdentitySizes slug={slug} creative={creative} n={n} set={idSet} kind={idKind} />
            </section>
          ) : (
            <section className="ms-fv-stage" aria-label={f.stage({ label })}>
              <div className="ms-fv-frame" style={frameStyle}>
                <div className="ms-fv-media">
                  {imgSrc && idKind === 'logo' ? (
                    <div className="ms-idn-split" role="img" aria-label={t.web.identity.logoSides({ label: `${label} v${n}` })}>
                      <span className="ms-idn-side ms-idn-light"><img key={imgSrc} src={imgSrc} alt="" draggable={false} /><span className="ms-idn-sidelbl">{t.web.identity.onLight}</span></span>
                      <span className="ms-idn-side ms-idn-dark"><img key={darkSrc ?? imgSrc} src={darkSrc ?? imgSrc} alt="" draggable={false} /><span className="ms-idn-sidelbl">{t.web.identity.onDark}</span></span>
                    </div>
                  ) : imgSrc ? <img key={imgSrc} src={imgSrc} alt={`${label} v${n}`} draggable={false} /> : null}
                </div>
              </div>
            </section>
          )
        ) : null}
        <section className="ms-fv-stage ms-ed-stage" aria-label={e.stage({ label })} hidden={otherView}>
          <div ref={frame} className="ms-fv-frame" style={frameStyle} data-slot="stage">
            <div className="ms-fv-media">
              {!draft || preview.state.kind === 'loading' || preview.state.kind === 'busy' || preview.state.kind === 'idle' ? (
                <span className="ms-cplayer-state" role="status">{!draft ? e.loading : preview.state.kind === 'busy' ? t.web.render.busy : t.web.render.loading}</span>
              ) : null}
              {preview.state.kind === 'ready' ? (
                <CompositionPlayer key={attempt} session={preview.state.session} title={t.web.render.playerFrame({ label: `${label} v${n ?? ''}` })}
                  onMedia={setPlayer} onStall={preview.stalled} onShowing={onShowing} />
              ) : null}
              {preview.state.kind === 'failed' ? (
                <span className="ms-fv-failed" role="alert">
                  <span>{e.previewFailed({ detail: preview.state.message })}</span>
                  <Button size="sm" variant="outline" onClick={() => { preview.retry(); setAttempt((a) => a + 1); }}><Icon name="refresh" size={12} />{t.web.render.retry}</Button>
                </span>
              ) : null}
              {safe && preset ? <SafeZoneBands preset={preset} /> : null}
            </div>
            {draft && !localeActive ? <Stage /> : null}
            <LocaleOutline player={player} preview={localePreview} />
            {canComment && ready && controls.ready && (!video || !controls.playing) ? (
              <PinLayer clock={controls.clock} video={video} marks={marks} open={noteFor?.index ?? null} onOpen={(num) => editPin(num - 1)} />
            ) : null}
            {spotMode && ready ? <HitArea clock={controls.clock} video={video} label={label} onPlace={placeSpot} /> : null}
          </div>
        </section>
        {spotMode && ready ? <CommentHint clock={controls.clock} video={video} /> : null}
        {detail ? <LocaleSwitcher brief={detail.creative.brief} preview={localePreview} className="ms-ed-locales" /> : null}
        {localeActive ? <p className="ms-cv-note ms-info" role="status">{t.web.languages.editorPreviewNote}</p> : null}
        {draft && !video && !otherView ? <ZoomBar zoom={zoom} onZoom={setZoom} /> : null}
      </main>

      <aside className="ms-ed-side ms-ed-right" aria-label={e.panelTabs} data-part="r">
        <Tabs label={e.panelTabs} value={tab} onChange={setTab} className="ms-fv-tabs ms-ed-tabs"
          tabs={[{ value: 'chat', label: e.chat, controls: 'ms-ed-panel', ...(sourcePins.length ? { count: sourcePins.length } : {}) }, { value: 'inspector', label: e.inspector, controls: 'ms-ed-panel' }]} />
        {sourcePins.length ? <span className="ms-sr" role="status">{e.pendingComments({ n: sourcePins.length })}</span> : null}
        <div id="ms-ed-panel" role="tabpanel" className="ms-ed-panel">
          {tab === 'chat' ? (
            detail ? (
              <Conversation slug={slug} creative={creative} entries={conversation} approvals={myApprovals} job={chatJob} live={chatLive}
                self={groupChat.self} memberJobs={groupChat.memberJobs}
                single={groupChat.single} otherPins={otherPins} onRemoveOtherPin={(p) => dropPins([p])}
                pins={sourcePins.map((p) => p.pin)} onRemovePin={removePin} onEditPin={editPin} onSelectVersion={onSelectVersion}
                formatName={labelOf} canGenerate={versions.length === 0} onSent={onSent} beforeSend={beforeSend} snapshots={live.snapshots}
                versionSummary={(vn) => { const v = versions.find((x) => x.n === vn); return v?.origin === 'editor' && v.request ? v.request : null; }} appliesTo={appliesTo}
                brief={detail.creative.brief} onBriefSaved={reload} queued={detail.creative.queued} onQueueChanged={reload} />
            ) : <div className="ms-cv-state"><Spinner size={16} label={c.loading} /></div>
          ) : (
            ctx ? <Inspector /> : <div className="ms-ed-slot" data-slot="inspector"><p>{e.inspectorSoon}</p></div>
          )}
        </div>
      </aside>

      <section className="ms-ed-timeline" aria-label={e.timeline} data-part="b" data-slot="timeline">
        {video && draft ? <Timeline loop={loop} onLoop={setLoop} speed={rate} onSpeed={setRate} marks={marks}
          overlay={({ pps }) => <RangeSpans marks={marks} pps={pps} />} onRange={commentRange} onCommentClip={commentClip} onCommentRange={askRange} canCommentClip={selection !== null} /> : null}
      </section>

      {rangeOpen ? <RangeDialog open playhead={player?.currentTime ?? controls.clock.get().time} duration={draft?.composition.duration ?? 0}
        onSubmit={(r) => { setRangeOpen(false); commentRange(r); }} onCancel={() => setRangeOpen(false)} /> : null}
      <PinNoteDialog open={noteFor !== null} title={noteTitle} initial={noteFor?.pin.note ?? ''} adding={noteFor?.index === null} onSubmit={submitNote} onCancel={() => setNoteFor(null)} />
      <Modal open={leave !== null} onClose={leaveKeep} label={e.leaveTitle} width={480} dismissible={!saving}>
        <div className="ms-ed-dialog">
          <h2>{e.leaveTitle}</h2>
          <p>{e.leaveBody({ n: editDraft?.ops.length ?? 0 })}</p>
          {leave?.mode === 'chat' ? <p>{e.leaveBodyChat}</p> : null}
          <div className="ms-ed-dialog-foot">
            <Button variant="ghost" disabled={saving} onClick={leaveKeep}>{e.leaveKeep}</Button>
            <Button variant="outline" disabled={saving} onClick={leaveDiscard}>{e.leaveDiscard}</Button>
            <Button variant="ink" loading={saving} disabled={blocked !== null} title={blocked ?? undefined} onClick={() => { void leaveSave(); }}>{e.leaveSave({ n: nextN })}</Button>
          </div>
          {blocked !== null ? <p className="ms-ed-dialog-why" role="note">{blocked}</p> : null}
        </div>
      </Modal>
      <Modal open={conflict && dirty} onClose={() => setConflict(false)} label={e.baseChangedTitle} width={480}>
        <div className="ms-ed-dialog">
          <h2>{e.baseChangedTitle}</h2>
          <p>{e.baseChangedBody({ name: labelOf(primary), n: latest?.n ?? 0 })}</p>
          {saveError ? <p>{saveError}</p> : null}
          <div className="ms-ed-dialog-foot">
            <Button variant="ghost" onClick={() => setConflict(false)}>{e.keepEditing}</Button>
            <Button variant="ink" onClick={() => { setConflict(false); setReopening(true); }}>{e.reopenLatest}</Button>
          </div>
        </div>
      </Modal>
      <Modal open={reopening} onClose={() => setReopening(false)} label={e.reopenTitle} width={440}>
        <div className="ms-ed-dialog">
          <h2>{e.reopenTitle}</h2>
          <p>{e.reopenBody}</p>
          <div className="ms-ed-dialog-foot">
            <Button variant="ghost" onClick={() => setReopening(false)}>{e.keepEditing}</Button>
            <Button variant="danger" onClick={() => {
              setReopening(false); setConflict(false); setMoved(false); setSaveError(null);
              actions.discard();
              setView(null);
              if (latest) setOpenN(latest.n);
              setReload1((x) => x + 1);
            }}>{e.reopenConfirm}</Button>
          </div>
        </div>
      </Modal>
      {compare ? (
        <CompareDialog open={compare.open} onClose={() => setCompare((x) => (x ? { ...x, open: false } : x))} slug={slug} creative={creative}
          versions={versions} presets={presets} labels={labels} states={states} format={primary} initial={compare.init} actions={versionActions} />
      ) : null}
      <ExportDialog open={Boolean(exporting?.open)} onClose={() => setExporting((x) => (x ? { ...x, open: false } : x))} slug={slug} creative={creative}
        title={detail?.creative.title ?? ''} snapshot={exporting?.snapshot ?? null} presets={presets} labels={detail?.creative.brief.formatLabels} pattern={exportNamePattern ?? DEFAULT_EXPORT_NAME_PATTERN} onSettings={onSettings}
        jobs={live.jobs} {...(detail && creativeLocales(detail.creative.brief) ? { locales: creativeLocales(detail.creative.brief)! } : {})} />
    </div>
  );
  // Tasks 6 to 10 read the draft, the player and the selection from here (`useEditor()`).
  // The svg clips' content (user test item 12) is shared by the layers tree and the inspector: svgSessions.tsx.
  return ctx ? <EditorContext.Provider value={ctx}><SvgSessions>{page}</SvgSessions></EditorContext.Provider> : page;
}
