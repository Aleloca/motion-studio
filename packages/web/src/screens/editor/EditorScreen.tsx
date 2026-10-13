// The direct editor's shell (Phase 10b, Task 5): the layout of the prototype's VideoEditor / ImageEditor with a slot for each
// panel the next tasks fill (scenes column and stage handles: Task 6, timeline: Task 7, inspector: 8, layers: 9, comments: 10).
// What lives here: the draft (draftStore.ts) opened on the format's composition, the stage player showing the live draft,
// the "Draft · Save as vN" pill, saving through `POST …/edits`, the leave guard and the keyboard map.
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
  channelName, compositionProblemText, formatName, type Composition, type EditorCompositionView, type FormatPreset, type Pin, type StagedAsset, type StageRequest,
} from '@motion-studio/shared';
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../../api.ts';
import { CompositionPlayer, type CompositionMedia } from '../../components/CompositionPlayer.tsx';
import { usePreviewSession } from '../../components/compositionPreview.ts';
import { Conversation } from '../../components/Conversation.tsx';
import { IntegrityNotice, useIntegrity } from '../../components/IntegrityNotice.tsx';
import type { EventsState } from '../../eventsReducer.ts';
import { message } from '../../errors.ts';
import { formatNumber, useLocale, useT } from '../../i18n.tsx';
import { D, enter } from '../../motion/index.ts';
import { href, parseRoute, routeKey } from '../../routes.ts';
import { useBarClaim } from '../../shell/barSlots.ts';
import { setShownVersions, takeShownVersions } from '../../shell/intents.ts';
import { go, ShellContext } from '../../shell/ShellContext.tsx';
import { Button, Empty, Icon, Modal, Pill, Spinner, Tabs, cx, toast } from '../../ui/index.ts';
import { useCreative } from '../../useCreative.ts';
import { pinsKey, usePendingPins } from '../pendingPins.ts';
import { clipPin, findClipById, rangePin, rangeTimes } from '../pinModel.ts';
import { PinNoteDialog } from './PinNoteDialog.tsx';
import { RangeSpans } from './RangeSpans.tsx';
import { RangeDialog } from './RangeDialog.tsx';
import { boardLabel } from '../CanvasBoard.tsx';
import { ExportDialog, type ExportSnapshot } from '../ExportDialog.tsx';
import { compositionOf } from '../renderModel.ts';
import { FPS as DEFAULT_FPS, type Mark, type Speed } from '../Transport.tsx';
import { boardSource, entryAt, followersOf, formatStates } from '../versionModel.ts';
import { compactOps } from './opsCompact.ts';
import { DraftPill, SAVED_MS } from './DraftPill.tsx';
import { draftKey, isDirty, peekDraft, useDraft, type Draft } from './draftStore.ts';
import { EditorContext, type EditorState } from './editorContext.ts';
import { registerLeaveGuard } from './leaveGuard.ts';
import { ScenesColumn } from './ScenesColumn.tsx';
import { nudgeClip, nudgeable } from './nudge.ts';
import { Stage } from './Stage.tsx';
import { Timeline } from './Timeline.tsx';
import { Inspector } from './Inspector.tsx';
import { ZoomBar, zoomFrame } from './ImageEditor.tsx';
import { LayersPanel } from './LayersPanel.tsx';
import { useEditorKeys, useNudgeKeys } from './useEditorKeys.ts';
import { usePlayerControls } from './usePlayerControls.ts';
import { DEFAULT_EXPORT_NAME_PATTERN, editProblemText } from '@motion-studio/shared';
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
const SAVE_STAGED_MAX = 20;

/** The staged files the composition names (only those go with a save). */
function usedStaged(d: Draft): string[] {
  const json = JSON.stringify(d.composition);
  return d.staged.map((s) => s.path).filter((p) => json.includes(JSON.stringify(p).slice(1, -1)));
}

export function EditorScreen({ slug, creative, format, live, exportNamePattern, onSettings }: EditorScreenProps) {
  const t = useT();
  const e = t.web.editor;
  const c = t.web.canvas;
  const locale = useLocale();
  const shell = useContext(ShellContext);
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const integrity = useIntegrity(slug, live);
  const { detail, conversation, error, reload } = useCreative(slug, creative, live.creativeTicks[`${slug}/${creative}`] ?? 0);

  // The bar belongs to this page only while it is the route's page.
  const ownKey = routeKey({ name: 'edit', slug, creative, format });
  const active = !shell || routeKey(shell.route) === ownKey;
  const bar = useBarClaim(ownKey, active);

  // Catalog, versions and the format's state.
  const [presets, setPresets] = useState<FormatPreset[]>([]);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getFormats()).then((s) => { if (alive) { setPresets(s.presets); setPresetsLoaded(true); } }).catch(() => { if (alive) setPresetsLoaded(true); });
    return () => { alive = false; };
  }, []);
  const versions = useMemo(() => detail?.versions ?? [], [detail]);
  const latest = versions.at(-1) ?? null;
  const states = useMemo(() => (detail ? formatStates(detail, presets) : {}), [detail, presets]);
  const primary = states[format]?.follows ?? format;
  const followers = useMemo(() => followersOf(states, primary), [states, primary]);
  const preset = presets.find((p) => p.id === primary);
  const labelOf = useCallback((id: string) => boardLabel({ id, preset: presets.find((p) => p.id === id) ?? null, out: null }, locale), [presets, locale]);

  // The draft of (creative, primary format): a module store, found again after a route change.
  const key = draftKey(slug, creative, primary);
  const [draft, actions] = useDraft(key);
  const [viewing] = useState(() => takeShownVersions(`${slug}/${creative}`));
  const [openN, setOpenN] = useState<number | null>(null);
  /** Bumped to load the view again for the same version (a reopen after a discard). */
  const [reload1, setReload1] = useState(0);
  const sourceN = boardSource(states, format, viewing).n;
  const n = openN ?? draft?.base.n ?? sourceN;
  const version = n !== null ? versions.find((v) => v.n === n) ?? null : null;
  const comp = compositionOf(version, primary);
  const latestComp = compositionOf(latest, primary);

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
  }, [slug, creative, n, primary, hasComp, presetsLoaded, reload1]); // eslint-disable-line react-hooks/exhaustive-deps

  // A job (agent turn or render) at work on this creative.
  const job = useMemo(() => {
    if (!detail) return undefined;
    const mine = Object.values(live.jobs).filter((j) => j.key === detail.jobKey);
    return mine.find((j) => j.state === 'queued' || j.state === 'running') ?? mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }, [live.jobs, detail]);
  const working = job?.state === 'queued' || job?.state === 'running';
  // A render of any version of this creative also stops a save (the core answers 409 `editor-busy`): final review M2.
  const renderPrefix = detail && detail.jobKey.startsWith('creative:') ? `render:${detail.jobKey.slice('creative:'.length)}:v` : null;
  const rendering = renderPrefix !== null && Object.values(live.jobs).some((j) => j.key.startsWith(renderPrefix) && (j.state === 'queued' || j.state === 'running'));

  // The base moved under the draft: another version changed the format.
  const dirty = draft !== null && isDirty(draft);
  // (a draft saved a moment ago may be newer than the version list still loading: not stale)
  const stale = Boolean(draft && latestComp && latest && draft.base.n < latest.n && draft.base.hash !== latestComp.hash);
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

  // The draft → the player, once per change (the player coalesces per animation frame).
  const lastSeq = useRef(0);
  const sent = useRef<{ player: CompositionMedia | null; composition: Composition | null }>({ player: null, composition: null });
  useEffect(() => {
    if (!player || !draft) return;
    if (sent.current.player === player && sent.current.composition === draft.composition) return;
    const first = sent.current.player !== player;
    sent.current = { player, composition: draft.composition };
    if (first && draft.ops.length === 0) return; // the frame shows the session's own composition
    lastSeq.current = player.setComposition(draft.composition);
  }, [player, draft?.composition]); // eslint-disable-line react-hooks/exhaustive-deps
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
    return () => { alive = false; };
  }, [session?.token, key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save as vN.
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ name: string; n: number } | null>(null);
  const savedTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(savedTimer.current), []);
  const nextN = (latest?.n ?? n ?? 0) + 1;
  const reelName = preset ? formatName(preset, locale) : primary;
  const save = useCallback(async (): Promise<boolean> => {
    const d = peekDraft(key);
    if (!d || saving) return false;
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
      actions.discard();
      setView(null);
      setOpenN(res.version);
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
    blocks: (hash) => { const d = peekDraft(key); return d !== null && isDirty(d) && routeKey(parseRoute(hash)) !== ownKey; },
    ask: (hash) => setLeave({ mode: 'route', target: hash }),
  }), [key, ownKey]);
  const beforeSend = useCallback(() => new Promise<boolean>((resolve) => {
    const d = peekDraft(key);
    if (!d || !isDirty(d)) { resolve(true); return; }
    setLeave({ mode: 'chat', resolve });
  }), [key]);
  const settle = (ok: boolean) => {
    const l = leave;
    setLeave(null);
    if (!l) return;
    if (l.mode === 'chat') l.resolve(ok); else if (ok) go(l.target);
  };
  const leaveSave = async () => { settle(await save()); };
  const leaveDiscard = () => { discardDraft(); settle(true); };
  // A dialog closed any other way (Esc, the scrim) is "Keep editing".
  const leaveKeep = () => settle(false);

  // Selection (set by the stage handles, the timeline, the layers and the scenes: Tasks 6 to 9).
  const [selection, setSelection] = useState<string | null>(null);
  // The magnet (stage guides now, the timeline's edges in Task 7): per editor, not saved.
  const [snap, setSnap] = useState(true);
  /** The image editor's zoom: null is Fit, otherwise 50 to 400 %. Not saved. */
  const [zoom, setZoom] = useState<number | null>(null);
  useEffect(() => { setSelection(null); }, [n, primary]);
  // The conversation's pins on the version being edited, as markers on the timeline ruler (numbered as in the format view).
  const [storedPins, setStoredPins] = usePendingPins(pinsKey(slug, creative));
  const marks = useMemo<Mark[]>(() => storedPins.filter((p) => p.version === n).map((p, i) => ({ pin: p.pin, number: i + 1 }))
    .filter((m) => m.pin.format === format || m.pin.format === primary), [storedPins, n, format, primary]);

  // Comments on clips and ranges (Task 10). Like the format view's, they go on the pin source (the version resumed from, else
  // the latest) and become chips in the conversation; the note is asked in a small dialog. The version edited is the format's
  // history entry: a pin source that carried the format unchanged (another format changed) has the same composition.
  const pinSource = detail ? detail.creative.resumeFrom?.version ?? latest?.n ?? null : null;
  const canComment = n !== null && entryAt(versions, states[primary], pinSource) === n;
  const sourcePins = useMemo(() => storedPins.flatMap((p, i) => (p.version === pinSource ? [{ pin: p.pin, at: i }] : [])), [storedPins, pinSource]);
  const [rangeOpen, setRangeOpen] = useState(false);
  const askRange = () => { if (commentVideo) setRangeOpen(true); };
  const [noteFor, setNoteFor] = useState<{ pin: Pin; index: number | null } | null>(null);
  const commentVideo = Boolean(draft && draft.composition.duration > 0);
  const startComment = (pin: Pin) => {
    if (!canComment) { toast.show(t.web.conversation.onlyOnVersion({ n: pinSource ?? 0 })); return; }
    setNoteFor({ pin, index: null });
  };
  const commentClip = () => {
    if (!draft) return;
    const clip = selection ? findClipById(draft.composition, selection) : null;
    if (!clip) { toast.show(t.web.conversation.clipCommentNeeds); return; }
    const drawn = player?.clipBounds && player.clipBounds.clipId === clip.id ? player.clipBounds : null;
    const time = commentVideo ? controls.clock.get().time : 0;
    const pin = clipPin({ format: primary, comp: draft.composition, clip, time, drawn });
    startComment(commentVideo ? pin : { ...pin, timeSec: null });
  };
  const commentRange = (r: { start: number; end: number }) => {
    if (!draft) return;
    const pin = rangePin({ format: primary, start: r.start, end: r.end, duration: draft.composition.duration });
    if (pin) startComment(pin);
  };
  const submitNote = (note: string) => {
    const open = noteFor;
    setNoteFor(null);
    if (!open || pinSource === null) return;
    const withNote: Pin = { ...open.pin, ...(note ? { note } : {}) };
    if (!note) delete withNote.note;
    if (open.index === null) {
      setStoredPins((ps) => [...ps, { pin: withNote, version: pinSource }]);
      setTab('chat');
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
  const pinsSent = useCallback(({ pins: sentPins }: { pins: Pin[] }) => { setStoredPins((ps) => ps.filter((p) => !sentPins.includes(p.pin))); }, [setStoredPins]);
  const noteTitle = noteFor ? (noteFor.pin.clipId && !noteFor.pin.range
    ? t.web.conversation.noteTitleClip({ name: noteFor.pin.clipName ?? noteFor.pin.clipId })
    : noteFor.pin.range ? t.web.conversation.noteTitleRange(rangeTimes(locale, noteFor.pin.range)) : t.web.conversation.clipComment) : '';

  // Keys.
  useEditorKeys(root, Boolean(draft) && active && leave === null, {
    commentClip,
    commentRange: askRange,
    undo: () => actions.undo(),
    redo: () => actions.redo(),
    toggle: controls.toggle,
    step: controls.step,
    deselect: () => setSelection(null),
    remove: () => toast.show(e.keysDeleteClip),
  });

  // Alt+arrows nudge the selected clip (the inspector's X and Y are the other keyboard path): one undo step per burst.
  useNudgeKeys(root, Boolean(draft) && active && leave === null, {
    can: () => (draft ? nudgeable(draft, selection) : false),
    nudge: (dx, dy) => {
      const fresh = peekDraft(key) ?? draft; // the store now: two presses in one tick must not start from the same x
      if (!fresh) return;
      const r = nudgeClip(fresh, actions, selection, dx, dy);
      if (r.ok) return;
      if (r.reason === 'locked') toast.show(e.locked);
      else if (r.reason === 'refused') toast.show(editProblemText(r.result.problem, locale));
    },
  });

  // Back to the format view (the version stays the one edited).
  const back = () => {
    controls.pause();
    if (n !== null) setShownVersions(`${slug}/${creative}`, { [primary]: n });
    go(href.format(slug, creative, format));
  };

  // T3-like arrival of the side panels.
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

  const [tab, setTab] = useState<'chat' | 'inspector'>('inspector');
  const [exporting, setExporting] = useState<{ open: boolean; snapshot: ExportSnapshot } | null>(null);
  const myApprovals = useMemo(() => Object.values(live.approvals).filter((a) => a.projectSlug === slug && a.creativeSlug === creative), [live.approvals, slug, creative]);
  const chatLive = useMemo(() => (job ? live.events[job.id] ?? [] : []), [job, live.events]);
  const primaries = (detail?.creative.brief.formats ?? []).filter((f) => states[f] && !states[f]!.follows);
  const appliesTo = useMemo(() => (versions.length && primaries.length > 1 ? {
    primaries: primaries.map((id) => ({ id, label: labelOf(id), followers: followersOf(states, id).map(labelOf) })),
    followerOf: (id: string) => states[id]?.follows ?? null,
    fallback: [primary],
  } : undefined), [versions.length, primaries.join(','), states, labelOf, primary]); // eslint-disable-line react-hooks/exhaustive-deps
  const onSent = useCallback((sent: { pins: Pin[] }) => { pinsSent(sent); reload(); }, [reload, pinsSent]);

  const ctx: EditorState | null = draft ? {
    slug, creative, format, primary, draft, actions, player, controls, selection, select: setSelection, snap, setSnap, token, stageAsset, staging,
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
  const backButton = <Button className="ms-back" onClick={back}><Icon name="back" size={16} strokeWidth={1.5} />{e.back}</Button>;
  const loadingAll = !detail || !presetsLoaded;
  if (!loadingAll && ((version && !comp) || n === null)) {
    return (
      <div ref={root} className="ms-cv-state">
        {bar?.start ? createPortal(backButton, bar.start) : null}
        <Empty icon="grid" title={e.edit} sub={e.legacy} action={<Button variant="ink" onClick={back}><Icon name="back" size={13} />{e.back}</Button>} />
      </div>
    );
  }

  const video = draft ? draft.composition.duration > 0 : preset?.kind !== 'image';
  const width = draft?.composition.width ?? preset?.width ?? 1080;
  const height = draft?.composition.height ?? preset?.height ?? 1920;
  const label = labelOf(primary);
  const meta = draft
    ? (video
      ? e.meta({ size: `${width}×${height}`, seconds: formatNumber(locale, draft.composition.duration, { maximumFractionDigits: 1 }), fps: draft.composition.fps })
      : e.metaImage({ size: `${width}×${height}` }))
    : '';
  const frameStyle: CSSProperties = zoomFrame(width, height, video ? null : zoom);
  const alsoList = followers.map(labelOf).join(', ');
  const blocked = !draft ? null
    : working || rendering ? e.busyAgent
      : baseMoved ? e.baseChangedTitle
        // A file being staged (a video converting) or staged again in a new session: the save would wait on it (M3).
        : staging || restaging ? e.saveWhileStaging
          : draft.problems.length > 0 ? compositionProblemText(draft.problems[0]!, locale) : null;

  const page = (
    <div ref={root} className={cx('ms-ed', video ? 'ms-ed-video' : 'ms-ed-image')} aria-busy={!draft || undefined}>
      {bar?.start ? createPortal(backButton, bar.start) : null}
      {bar?.title ? createPortal(
        <>
          <span className="ms-crumb ms-last ms-fv-crumb">
            <span className="ms-faint" aria-hidden="true">/</span>
            <b aria-current="page" title={preset ? channelName(preset.channel, locale) : undefined}>{preset ? formatName(preset, locale) : primary}</b>
          </span>
          {meta ? <span className="ms-fv-meta">{meta}</span> : null}
        </>,
        bar.title,
      ) : null}
      {bar?.end ? createPortal(
        <>
          {followers.length > 0 ? <Pill tone="neutral" className="ms-ed-also">{e.alsoUsedBy({ list: alsoList })}</Pill> : null}
          {n !== null ? <Pill tone="neutral" className="ms-ed-version">{e.version({ n })}</Pill> : null}
          <Button variant="ink" className="ms-cv-export" disabled={!latest} onClick={() => { if (latest) setExporting({ open: true, snapshot: { versions, states } }); }}>
            <Icon name="download" size={13} strokeWidth={1.7} />{c.export}
          </Button>
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
        <div className="ms-fv-notes">
          {integrity.state ? <IntegrityNotice slug={slug} state={integrity.state} reload={integrity.reload} /> : null}
          {primary !== format ? <p className="ms-cv-note ms-info" role="status">{e.editingPrimary({ primary: labelOf(primary), also: alsoList })}</p> : null}
          {loadError ? <p role="alert" className="ms-cv-note ms-err">{e.loadFailed({ detail: loadError })}</p> : null}
          {working ? <p className="ms-cv-note ms-info" role="status">{e.busyAgent}</p> : null}
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
        <section className="ms-fv-stage ms-ed-stage" aria-label={e.stage({ label })}>
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
            </div>
            {draft ? <Stage /> : null}
          </div>
        </section>
        {draft && (dirty || saved) ? (
          <DraftPill edits={draft.ops.length} nextN={nextN} blocked={blocked} saving={saving} saved={saved} onSave={() => { void save(); }} onDiscard={discardDraft} />
        ) : null}
        {draft && !video ? <ZoomBar zoom={zoom} onZoom={setZoom} /> : null}
        <div className="ms-ed-undo" role="toolbar" aria-label={e.draft({ n: draft?.ops.length ?? 0 })}>
          <Button size="sm" variant="ghost" icon aria-label={e.undo} title={e.undo} disabled={!draft || draft.past.length === 0} onClick={() => actions.undo()}><Icon name="undo" size={14} /></Button>
          <Button size="sm" variant="ghost" icon aria-label={e.redo} title={e.redo} disabled={!draft || draft.future.length === 0} onClick={() => actions.redo()}><Icon name="redo" size={14} /></Button>
          {draft && !video ? (
            <Button size="sm" variant="outline" className="ms-ed-comment" aria-keyshortcuts="C" disabled={selection === null} title={selection === null ? t.web.conversation.clipCommentNeeds : undefined} onClick={commentClip}>
              <Icon name="comment" size={13} />{t.web.conversation.clipComment}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" icon className="ms-ed-snap" aria-label={e.snap} title={e.snap} aria-pressed={snap} onClick={() => setSnap(!snap)}><Icon name="magnet" size={14} /></Button>
        </div>
      </main>

      <aside className="ms-ed-side ms-ed-right" aria-label={e.panelTabs} data-part="r">
        <Tabs label={e.panelTabs} value={tab} onChange={setTab} className="ms-fv-tabs"
          tabs={[{ value: 'chat', label: e.chat, controls: 'ms-ed-panel' }, { value: 'inspector', label: e.inspector, controls: 'ms-ed-panel' }]} />
        <div id="ms-ed-panel" role="tabpanel" className="ms-ed-panel">
          {tab === 'chat' ? (
            detail ? (
              <Conversation slug={slug} creative={creative} entries={conversation} approvals={myApprovals} job={job} live={chatLive}
                pins={sourcePins.map((p) => p.pin)} onRemovePin={removePin} onEditPin={editPin}
                formatName={labelOf} canGenerate={versions.length === 0} onSent={onSent} beforeSend={beforeSend} snapshots={live.snapshots} appliesTo={appliesTo} />
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
          <p>{e.leaveBody({ n: draft?.ops.length ?? 0 })}</p>
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
      <ExportDialog open={Boolean(exporting?.open)} onClose={() => setExporting((s) => (s ? { ...s, open: false } : s))} slug={slug} creative={creative}
        title={detail?.creative.title ?? ''} snapshot={exporting?.snapshot ?? null} presets={presets} pattern={exportNamePattern ?? DEFAULT_EXPORT_NAME_PATTERN} onSettings={onSettings} />
    </div>
  );
  // Tasks 6 to 10 read the draft, the player and the selection from here (`useEditor()`).
  return ctx ? <EditorContext.Provider value={ctx}>{page}</EditorContext.Provider> : page;
}
