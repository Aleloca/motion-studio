// Export the ★ versions (spec §3.3, prototype ExportDialog): one row per format with its thumbnail, final file name,
// "★ vN" (and "vM newer" after a manual pick), a check, and "follows Reel ★ vN" for followers, which export their own
// file from the latest version where that file is byte-identical to the primary's ★ file (decisions log 140), named with that ★. The file name pattern has token chips, a live preview, an inline collision error and
// "Save as default" (the workspace's `exportNamePattern`). The destination (native picker on desktop, a field on the web)
// is remembered; progress, then a success screen with Show in Finder. File sizes are not shown: the API does not report
// them (ruling R6). Decision 974: the export runs on the core as a job (user report 20): the dialog may close at any time
// and the export goes on (the app tells when the files are in the folder, `useExportNotice`); Cancel export stops it. The
// videos' resolution and quality are chosen here and remembered in this browser (report 22); the frame rate is chosen
// for each export (report 39, decision 1242).
import {
  DEFAULT_EXPORT_QUALITY, EXPORT_FPS, EXPORT_QUALITIES, EXPORT_RESOLUTIONS, profileApplies, scaledSize, type ExportFps, type ExportQuality,
  EXPORT_NAME_TOKENS, exportDate, exportExtension, exportNameCollisions, exportNameVars, localizedStem, renderName, renderProblems, renderState, separateInstanceNames,
  type FormatPreset, type JobSummary, type LocaleTag, type VersionEntry, type WorkspaceSettings,
} from '@motion-studio/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, ApiError, type GroupExportPlanItem } from '../api.ts';
import { desktop, showExported } from '../desktop.ts';
import { useLocale, useT } from '../i18n.tsx';
import { pop } from '../motion/index.ts';
import { isMac } from '../platform.ts';
import { Button, ChannelMark, Check, Chip, Icon, Input, Modal, ProgressBar, Segmented, Select, cx } from '../ui/index.ts';
import { instanceName, presetFor } from '../instances.ts';
import { boardLabel } from './CanvasBoard.tsx';
import { outputMedia } from './canvasModel.ts';
import { channelOf } from './creativeState.ts';
import { message } from './common.tsx';
import { abortableWait, exportErrorText, withHashRetry } from './versionErrors.ts';
import type { FormatState } from './versionModel.ts';
import { compositionOf, shortProblems } from './renderModel.ts';
import { localeName } from './creative/languagesModel.ts';
import { exportRegistry, stageText } from './exportModel.ts';

/** The last destination folder, kept in this browser only. */
export const EXPORT_FOLDER_KEY = 'ms.exportFolder';
const readFolder = () => { try { return localStorage.getItem(EXPORT_FOLDER_KEY) ?? ''; } catch { return ''; } };
const writeFolder = (v: string) => { try { localStorage.setItem(EXPORT_FOLDER_KEY, v); } catch { /* private mode */ } };
/** The last resolution and quality chosen (decision 974), kept in this browser for every project, as the folder. */
export const EXPORT_PROFILE_KEY = 'ms.exportProfile';
export interface ExportProfileChoice { quality: ExportQuality; resolution: number | null; /** Report 39: null, the format's own; never remembered (decision 1242). */ fps: ExportFps | null }
export function readProfile(): ExportProfileChoice {
  try {
    const v = JSON.parse(localStorage.getItem(EXPORT_PROFILE_KEY) ?? 'null') as Partial<ExportProfileChoice> | null;
    const quality = (EXPORT_QUALITIES as readonly unknown[]).includes(v?.quality) ? v!.quality! : DEFAULT_EXPORT_QUALITY;
    const resolution = (EXPORT_RESOLUTIONS as readonly unknown[]).includes(v?.resolution) ? v!.resolution! : null;
    return { quality, resolution, fps: null };
  } catch { return { quality: DEFAULT_EXPORT_QUALITY, resolution: null, fps: null }; }
}
const writeProfile = ({ quality, resolution }: ExportProfileChoice) => { try { localStorage.setItem(EXPORT_PROFILE_KEY, JSON.stringify({ quality, resolution })); } catch { /* private mode */ } };
/** The workspace settings bound the pattern to 200 characters. */
const PATTERN_MAX = 200;

/** What the dialog exports, taken when it opened (a new version or ★ does not retarget an open export). */
export interface ExportSnapshot { versions: VersionEntry[]; states: Record<string, FormatState> }

export interface ExportDialogProps {
  open: boolean;
  onClose(): void;
  slug: string;
  creative: string;
  title: string;
  snapshot: ExportSnapshot | null;
  presets: FormatPreset[];
  /** The brief's labels of format instances: rows are named after them (Phase 12). */
  labels?: Record<string, string>;
  /** The workspace's file name pattern: the field starts with it. */
  pattern: string;
  /** The workspace settings after "Save as default". */
  onSettings?(next: WorkspaceSettings): void;
  /** The live jobs (the render jobs a ★ export waits for show their progress, Task 8). */
  jobs?: Record<string, JobSummary>;
  /** The creative's languages (Phase 12): with extra languages the dialog offers a multiselect; absent: as before. */
  locales?: { primary: LocaleTag; extra: LocaleTag[] };
  /**
   * Phase 15 (spec §6): the export of a variant group. The rows come from the group selection (each format from its ★, in any
   * variant, or from the default rule on variant A) and the export is `exportGroup`; `snapshot` is not used.
   */
  group?: boolean;
}

/** The extension a render will have (core render-jobs `renderExtension`): the preset's first H.264 container or image type. */
export function renderedExtension(preset: FormatPreset | null): string {
  const still = preset?.kind === 'image';
  const prefer = still ? ['png', 'jpg', 'jpeg', 'webp'] : ['mp4', 'mov', 'm4v'];
  return `.${prefer.find((e) => preset?.extensions.includes(e)) ?? prefer[0]!}`;
}

export function ExportDialog(p: ExportDialogProps) {
  const t = useT();
  // The export runs on the core (decision 974): the dialog may always be closed, the export goes on.
  return (
    <Modal open={p.open} onClose={p.onClose} label={p.group ? `${t.web.exportUi.groupHeading}: ${p.title}` : t.web.exportUi.title({ title: p.title })} width={760}>
      {p.group ? <GroupLoader {...p} /> : p.snapshot ? <ExportBody {...p} snapshot={p.snapshot} /> : null}
    </Modal>
  );
}

const NO_SNAPSHOT: ExportSnapshot = { versions: [], states: {} };

/** Reads the group selection when the dialog opens (the modal unmounts it on close), then shows the export of it. */
function GroupLoader(p: ExportDialogProps) {
  const t = useT();
  const [plan, setPlan] = useState<GroupExportPlanItem[] | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    api.groupExportPlan(p.slug, p.creative).then((r) => { if (live) setPlan(r.items); }, (e: unknown) => { if (live) setPlan({ error: message(e) }); });
    return () => { live = false; };
  }, [p.slug, p.creative]);
  if (plan === null) return <p className="ms-exp-empty" role="status">{t.web.exportUi.groupLoading}</p>;
  if (!Array.isArray(plan)) return <p className="ms-exp-error" role="alert">{t.web.exportUi.groupLoadFailed({ detail: plan.error })}</p>;
  return <ExportBody {...p} snapshot={NO_SNAPSHOT} groupPlan={plan} />;
}

/** `run`: the request is on its way; `job`: the export job runs on the core (decision 974); `done`: the files are in the folder. */
type Phase = { kind: 'idle' } | { kind: 'run' } | { kind: 'job'; id: string }
  | { kind: 'done'; destination: string; files: string[]; skipped: string[]; excluded: string[] };
type SaveState = { kind: 'idle' | 'saving' | 'saved' } | { kind: 'failed'; detail: string };

interface Row {
  id: string;
  preset: FormatPreset | null;
  /** The ★ shown and named (`{v}`): the format's ★; a follower: its primary's ★ (decisions log 140). */
  n: number;
  /**
   * The version whose file is copied: `n`, or for a follower its resolved `exportVersion` (the latest version where its file
   * is byte-identical to the primary's ★ file, e.g. a follower added without the agent); null when it has none.
   */
  fileN: number | null;
  /** This format's own file in version `fileN`; null when it has none. */
  output: VersionEntry['outputs'][number] | null;
  /** A v2 composition without a current render: rendered first, then exported (Task 8). */
  needsRender: boolean;
  /** A composition (v2): the core renders it, so the resolution and quality apply (decision 974); a legacy file is copied as it is. */
  composed: boolean;
  /** The name the file will have (its extension): the output's, or the render's to come. */
  file: string | null;
  /** The primary's short name, for a follower. */
  follows: string | null;
  newer: number | null;
  /** A group export (phase 15): the member the file comes from, and the label of where it comes from ("Variante B · v3"). */
  member?: string; sourceLabel?: string;
  /** Why the row cannot be exported (it is then unchecked and disabled); null when it can. */
  blocked: string | null;
  /**
   * The problems of the row's current render (I2: too large, duration off, resolution, unreadable). The row starts
   * unchecked with the reasons shown: ticking it is the confirmation to export it anyway.
   */
  problems: string[];
}

function ExportBody({ onClose, slug, creative, title, snapshot, presets, labels, pattern: initialPattern, onSettings, jobs = {}, locales, groupPlan }: ExportDialogProps & { snapshot: ExportSnapshot; groupPlan?: GroupExportPlanItem[] }) {
  const t = useT();
  const x = t.web.exportUi;
  const locale = useLocale();
  const bridge = desktop();
  const { versions, states } = snapshot;
  const rows = useMemo<Row[]>(() => groupPlan ? groupPlan.map((g): Row => {
    const preset = presetFor(presets, g.format);
    const needsRender = g.state === 'needs-render';
    const output = g.state === 'needs-render' || g.file === '' ? null : { format: g.format, file: g.file, width: g.width, height: g.height, durationSec: null, verified: true, preview: null } as VersionEntry['outputs'][number];
    const sourceLabel = g.source === 'pick' ? x.groupPick({ variant: g.letter.toUpperCase(), n: g.version }) : x.groupDefault({ variant: g.letter.toUpperCase(), n: g.version });
    return { id: g.format, preset, n: g.v ?? g.version, fileN: g.version, output, needsRender, composed: g.composed === true, file: output?.file ?? (needsRender ? `${g.format}${renderedExtension(preset)}` : null),
      follows: null, newer: null, blocked: g.state === 'missing' ? x.fileMissing({ n: g.version }) : null, problems: [], member: g.slug, sourceLabel };
  }) : Object.values(states).flatMap((s): Row[] => {
    const n = s.follows ? (states[s.follows]?.star.version ?? null) : s.star.version;
    if (n === null) return [];
    // A v2 follower without its own render yet: its file comes with the primary's render, in the primary's ★ version.
    const fileN = s.follows ? s.exportVersion ?? (compositionOf(versions.find((v) => v.n === n), s.id) ? n : null) : n;
    const version = fileN === null ? undefined : versions.find((v) => v.n === fileN);
    const output = version?.outputs.find((o) => o.format === s.id) ?? null;
    const needsRender = version !== undefined && compositionOf(version, s.id) !== null && renderState(version, s.id) !== 'rendered';
    const preset = presetFor(presets, s.id);
    const follows = s.follows ? instanceName(presetFor(presets, s.follows), s.follows, locale, labels) : null;
    const blocked = needsRender ? null : !output
      ? (follows !== null ? x.noFollowerFile({ n, primary: follows }) : x.fileMissing({ n }))
      : s.starFileMissing ? x.fileMissing({ n: fileN ?? n }) : null;
    const file = output?.file ?? (needsRender ? `${s.id}${renderedExtension(preset)}` : null);
    const problems = version && !needsRender && renderProblems(version, s.id).length ? shortProblems(output, t, locale) : [];
    return [{ id: s.id, preset, n, fileN, output, needsRender, composed: version !== undefined && compositionOf(version, s.id) !== null, file, follows, newer: follows === null ? s.star.newer : null, blocked, problems }];
  }), [groupPlan, states, versions, presets, labels, x, locale, t]);
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(rows.map((r) => [r.id, r.blocked === null && r.problems.length === 0])));
  const [pattern, setPattern] = useState(initialPattern);
  const [savedPattern, setSavedPattern] = useState(initialPattern);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  // One date for the preview and the export (sent along, so a dialog left open past midnight keeps its names).
  const [date] = useState(() => exportDate(new Date()));
  const [folder, setFolder] = useState(readFolder);
  const remembered = folder !== '' && folder === readFolder();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  // Languages (Phase 12): the original is on, the translations are chosen. A translation with open problems or outdated texts
  // is refused by the core with the list; "Render anyway" sends `force`.
  const withLanguages = Boolean(locales && locales.extra.length > 0);
  const [langs, setLangs] = useState<Record<string, boolean>>(() => (locales ? { [locales.primary]: true } : {}));
  const [refused, setRefused] = useState<string[] | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const running = phase.kind === 'run' || phase.kind === 'job';
  const labelId = useId();
  const namesId = useId();
  const previewId = useId();
  const resolutionId = useId();
  const qualityId = useId();
  const fpsId = useId();
  const qualityHintId = useId();
  // The videos' resolution and quality (decision 974), as last chosen. With other languages the videos keep the default
  // profile: translations are rendered at the format size and High quality.
  const [profile, setProfile] = useState<ExportProfileChoice>(readProfile);
  // The export job this dialog started: its end is shown here while the dialog is open (the app tells it anyway).
  const job = phase.kind === 'job' ? jobs[phase.id] : undefined;
  const watchedId = phase.kind === 'job' ? phase.id : null;
  useEffect(() => (watchedId ? exportRegistry.watch(watchedId) : undefined), [watchedId]);
  useEffect(() => {
    if (phase.kind !== 'job' || !job || job.state === 'queued' || job.state === 'running') return;
    const info = job.export;
    if (job.state === 'succeeded' && info) {
      // A render made now that had problems was not copied: said apart, with its short reasons (P2).
      const excluded = (info.excluded ?? []).map((e) => {
        const row = rows.find((r) => r.id === e.format);
        const label = boardLabel({ id: e.format, preset: row?.preset ?? null, out: row?.output ?? null, labels }, locale);
        return x.excludedItem({ label: e.locale ? `${label} (${e.locale})` : label, n: e.version, list: shortProblems({ problems: e.problems, issues: e.issues ?? [] }, t, locale).join('; ') });
      });
      setPhase({ kind: 'done', destination: info.destination, files: info.files ?? [], skipped: info.skipped ?? [], excluded });
      return;
    }
    setPhase({ kind: 'idle' });
    // A translation with open problems (decisions log 854): "Render anyway" sends the export again with `force`.
    if (info?.refusal?.code === 'localization-needs-force') { setRefused(info.refusal.problems?.length ? info.refusal.problems : [job.error ?? '']); return; }
    setError(job.state === 'cancelled' ? x.cancelled : x.failed({ detail: job.error ?? t.web.jobState.failed }));
  }, [phase, job, x, t, rows, labels, locale]);
  // Closing the dialog cancels a retry's wait (an export refused while old versions are hashed) and silences its result.
  // One controller per mount, made by the effect (StrictMode mounts twice).
  const life = useRef(new AbortController());
  useEffect(() => {
    const c = new AbortController();
    life.current = c;
    return () => c.abort();
  }, []);
  const reveal = isMac() ? x.showInFinder : x.showInFolder;

  // The final names: the pattern rendered per row with the same shared code as the core, extension added. With extra
  // languages the original's `{locale}` is the primary tag, as the core renders it.
  const primaryTag: string | undefined = locales && withLanguages ? locales.primary : undefined;
  const vars = (r: Row, tag: string | undefined = primaryTag) => exportNameVars({ title, slug: creative, format: r.id, preset: r.preset ?? undefined, size: r.output ?? undefined, version: r.n, date, ...(tag ? { locale: tag } : {}) });
  const rendered = rows.map((r) => (r.file ? renderName(pattern, vars(r)) : null));
  // Instances that would share a name are told apart exactly as the core does it on export (shared code).
  const stems = separateInstanceNames(rows.flatMap((r, i) => (rendered[i]?.ok && r.file ? [{ format: r.id, stem: rendered[i]!.name, ext: exportExtension(r.file) }] : [])));
  let k = 0;
  const named = rows.map((r, i) => {
    const ok = rendered[i]?.ok && r.file;
    return { row: r, name: ok ? `${stems[k++]!}${exportExtension(r.file!)}` : null };
  });
  const chosen = named.filter((c) => c.row.blocked === null && on[c.row.id]);
  // The files of the export as the core names them (final review I2): the original's (when its language is ticked) and each
  // ticked translation's, which gains its language when the pattern has no `{locale}`; instances kept apart over all of them.
  const otherTags = locales && withLanguages ? locales.extra.filter((tag) => langs[tag]) : [];
  const withOriginal = !locales || !withLanguages || Boolean(langs[locales.primary]);
  const exportEntries = [
    ...(withOriginal ? chosen.map((c) => ({ row: c.row, tag: undefined as string | undefined })) : []),
    ...otherTags.flatMap((tag) => chosen.map((c) => ({ row: c.row, tag: tag as string | undefined }))),
  ].flatMap((e) => {
    const r = e.row.file ? renderName(pattern, vars(e.row, e.tag ?? primaryTag)) : null;
    return r?.ok ? [{ ...e, format: e.row.id, stem: localizedStem(pattern, r.name, e.tag, e.tag !== undefined), ext: exportExtension(e.row.file!) }] : [];
  });
  const exportStems = separateInstanceNames(exportEntries);
  const exportNames = exportEntries.map((e, i) => ({ tag: e.tag, name: `${exportStems[i]!}${e.ext}` }));
  const translatedNames = otherTags.map((tag) => ({ tag, names: exportNames.filter((e) => e.tag === tag).map((e) => e.name) })).filter((x) => x.names.length > 0);
  // Unknown variables are the same on every row: they are left out of the names and flagged here.
  const firstRow = chosen[0]?.row ?? rows[0];
  const unknown = firstRow ? renderName(pattern, vars(firstRow)).unknown : [];
  const tooLong = pattern.length > PATTERN_MAX;
  // Export needs a name for each chosen row only; a default pattern must name every row (blocked or not chosen too).
  const empty = !pattern.trim() || chosen.some((c) => c.name === null);
  const anyRowEmpty = rows.some((r) => !renderName(pattern, vars(r)).ok);
  const collisions = exportNameCollisions(exportNames.map((e) => e.name));
  const nameProblem = tooLong ? x.errors.invalidPattern : empty ? x.emptyName : collisions.length ? x.collision({ list: collisions.join(', ') }) : null;
  const preview = withOriginal ? (chosen[0] ?? named.find((c) => c.name !== null))?.name ?? null : null;

  const insert = (token: string) => {
    const el = field.current;
    const text = `{${token}}`;
    const start = el?.selectionStart ?? pattern.length;
    const end = el?.selectionEnd ?? pattern.length;
    setPattern(pattern.slice(0, start) + text + pattern.slice(end));
    setSave({ kind: 'idle' });
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(start + text.length, start + text.length); } });
  };
  const saveDefault = async () => {
    setSave({ kind: 'saving' });
    try {
      const next = await api.updateSettings({ exportNamePattern: pattern });
      setSavedPattern(next.exportNamePattern);
      setSave({ kind: 'saved' });
      onSettings?.(next);
    } catch (e) { setSave({ kind: 'failed', detail: message(e) }); }
  };
  const choose = async () => {
    setError(null);
    try {
      const picked = await bridge?.pickFolder(x.pickTitle, folder.trim() || undefined);
      if (picked) setFolder(picked);
    } catch (e) { setError(message(e)); }
  };
  const canRun = chosen.length > 0 && folder.trim() !== '' && nameProblem === null && !running;
  const wanted = locales && withLanguages ? [locales.primary, ...locales.extra].filter((tag) => langs[tag]) : [];
  const otherLanguages = locales ? wanted.some((tag) => tag !== locales.primary) : false;
  const languageBody = otherLanguages ? { locales: wanted } : {};
  const lockProfile = otherLanguages;
  // The resolution and quality are the videos' (decision 974): stills, identity and store pack formats keep their own.
  const videoRow = (r: Row) => r.composed && r.preset !== null && profileApplies(r.preset, r.id);
  const anyVideo = rows.some(videoRow);
  /** The size and frame rate a video row is exported at, when chosen ("1280×720 · 60 fps"); null otherwise. */
  const sizeOf = (r: Row): string | null => {
    if (lockProfile || !videoRow(r) || (profile.resolution === null && profile.fps === null)) return null;
    const z = profile.resolution !== null ? scaledSize(r.preset!, profile.resolution) : null;
    return [z ? `${z.width}×${z.height}` : null, profile.fps !== null ? t.render.fpsName({ fps: profile.fps }) : null].filter(Boolean).join(' · ');
  };
  // Report 39 (decision 1235): the format's own frame rate, named when every video row's render recorded the same one.
  const recordedFps = rows.filter(videoRow).map((r) => r.output?.render?.fps ?? null);
  const ownFps = recordedFps.length > 0 && recordedFps.every((f) => f !== null && f === recordedFps[0]) ? String(recordedFps[0]) : null;
  const profileBody = lockProfile ? { quality: DEFAULT_EXPORT_QUALITY }
    : { quality: profile.quality, ...(profile.resolution !== null ? { resolution: profile.resolution } : {}), ...(profile.fps !== null ? { fps: profile.fps } : {}) };
  const run = async (force = false) => {
    const dest = folder.trim();
    if (!canRun) return;
    setError(null);
    setRefused(null);
    setPhase({ kind: 'run' });
    // Followers are never picked on their own: they go with the version whose file the row shows (resolved from their
    // primary's ★), which the core checks against the primary version it exports.
    const picks: Record<string, number> = {};
    const follow: Record<string, number> = {};
    for (const c of chosen) { if (c.row.follows !== null) follow[c.row.id] = c.row.fileN ?? c.row.n; else picks[c.row.id] = c.row.n; }
    const signal = life.current.signal;
    const followed = Object.keys(follow).length ? { follow } : {};
    try {
      // Decision 974: the core renders what still needs a render (translations included) and copies, as a job; the request
      // answers at once with it (its refusals still come now). A follower's version is decided on hashes: while old versions
      // are still hashed the core answers hashes-pending, retried after its Retry-After (bounded, like a ★ pick).
      const send = (forced: boolean, wait: Parameters<typeof withHashRetry>[1]) => (groupPlan
        ? api.exportGroupJob(slug, creative, { destination: dest, formats: chosen.map((c) => c.row.id), pattern, date, ...languageBody, ...profileBody, ...(forced ? { force: true } : {}) })
        : withHashRetry(() => api.exportPicksJob(slug, creative, { destination: dest, picks, ...followed, pattern, date, ...languageBody, ...profileBody, ...(forced ? { force: true } : {}) }), wait));
      const started = await send(force, abortableWait(signal));
      // Review #9: the same export with "Render anyway", for the app's notice when this dialog is closed by then.
      if (!force) exportRegistry.setRetry(started.job.id, () => send(true, abortableWait(new AbortController().signal)));
      writeFolder(dest);
      if (!lockProfile) writeProfile(profile);
      if (signal.aborted) return;
      setPhase({ kind: 'job', id: started.job.id });
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof ApiError && e.code === 'localization-needs-force') {
        setRefused(e.problems?.length ? e.problems : [e.message]);
        setPhase({ kind: 'idle' });
        return;
      }
      setError(exportErrorText(e, t));
      setPhase({ kind: 'idle' });
    }
  };
  const cancelJob = () => {
    if (phase.kind !== 'job') return;
    Promise.resolve().then(() => api.cancelJob(phase.id)).catch((e: unknown) => setError(message(e)));
  };

  const head = (
    <div className="ms-exp-head">
      <div className="ms-exp-titles">
        <h2>{groupPlan ? x.groupHeading : x.heading}</h2>
        <span className="ms-exp-sub">{groupPlan ? x.groupSub({ title }) : x.sub({ title })}</span>
      </div>
      <Button variant="ghost" icon aria-label={t.common.close} onClick={onClose}><Icon name="close" size={13} strokeWidth={1.6} /></Button>
    </div>
  );

  if (phase.kind === 'done') {
    return (
      <div className="ms-exp">
        {head}
        <div className="ms-exp-done" role="status">
          <span className="ms-exp-done-mark" ref={(el) => { if (el) void pop(el); }}><Icon name="check" size={24} strokeWidth={2.2} /></span>
          <b>{x.done({ count: phase.files.length })}</b>
          <span className="ms-exp-path">{phase.destination}</span>
          {phase.skipped.length ? <span className="ms-exp-skipped">{x.skipped({ list: phase.skipped.join(', ') })}</span> : null}
          {phase.excluded.length ? <span className="ms-exp-problem" role="alert">{x.excluded({ list: phase.excluded.join(', ') })}</span> : null}
          {error ? <p role="alert" className="ms-exp-error">{error}</p> : null}
          <div className="ms-exp-done-actions">
            {bridge ? (
              <Button variant="outline" onClick={() => { showExported(bridge, phase.destination, phase.files).catch((e: unknown) => setError(message(e))); }}>
                <Icon name="folder" size={14} />{reveal}
              </Button>
            ) : null}
            <Button variant="ink" onClick={onClose}>{x.finish}</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ms-exp">
      {head}
      {rows.length ? (
        <div className="ms-exp-rows">
          <div className="ms-exp-row ms-exp-cols ms-cap" aria-hidden="true"><span /><span /><span>{x.format}</span><span>{x.version}</span></div>
          {named.map(({ row: r, name }) => {
            const label = boardLabel({ id: r.id, preset: r.preset, out: r.output, labels }, locale);
            const media = r.output && r.fileN !== null ? outputMedia(slug, r.member ?? creative, r.fileN, r.output) : null;
            const aspect = r.preset ? r.preset.width / r.preset.height : r.output ? r.output.width / r.output.height : 1;
            const blocked = r.blocked !== null;
            return (
              <div key={r.id} className={cx('ms-exp-row', blocked ? 'ms-blocked' : !on[r.id] && 'ms-off')}>
                <Check on={!blocked && Boolean(on[r.id])} label={x.include({ label })} disabled={running || blocked} onChange={(v) => setOn((s) => ({ ...s, [r.id]: v }))} />
                <span className={cx('ms-exp-thumb', aspect > 1.05 ? 'ms-wide' : aspect < 0.95 ? 'ms-tall' : 'ms-square')} aria-hidden="true">
                  {media ? (media.video ? <video src={media.src} muted preload="metadata" /> : <img src={media.src} alt="" />) : null}
                </span>
                <span className="ms-exp-name">
                  <span className="ms-exp-label">{r.preset ? <ChannelMark channel={channelOf(r.preset.channel)} /> : null}<b>{label}</b></span>
                  {blocked ? <span className="ms-exp-blocked">{r.blocked}</span> : <span className="ms-exp-file">{name ?? '—'}{sizeOf(r) ? <span className="ms-exp-size"> {x.outputSize({ size: sizeOf(r)! })}</span> : null}</span>}
                  {r.needsRender && !blocked ? <span className="ms-exp-render">{t.web.render.rendersFirst}</span> : null}
                  {r.problems.length && !blocked ? <span className="ms-exp-problem">{x.renderProblems({ list: r.problems.join('; ') })}</span> : null}
                </span>
                {r.sourceLabel !== undefined ? (
                  <span className="ms-exp-ver">{r.sourceLabel}</span>
                ) : r.follows !== null ? (
                  <span className="ms-exp-follows">{x.follows({ primary: r.follows })}<span className="ms-exp-ver">{x.star({ n: r.n })}</span></span>
                ) : (
                  <span className="ms-exp-ver">{x.star({ n: r.n })}{r.newer !== null ? <span className="ms-exp-newer">{x.newer({ n: r.newer })}</span> : null}</span>
                )}
              </div>
            );
          })}
        </div>
      ) : <p className="ms-exp-empty">{x.empty}</p>}
      {locales && withLanguages ? (
        <div className="ms-exp-langs" role="group" aria-label={t.web.languages.exportLanguages}>
          <span className="ms-exp-dest-label">{t.web.languages.exportLanguages}</span>
          <div className="ms-exp-langs-list">
            {[locales.primary, ...locales.extra].map((tag) => (
              <label key={tag} className="ms-exp-lang">
                <Check on={Boolean(langs[tag])} label={tag === locales.primary ? t.web.languages.renderOriginal({ language: localeName(tag, locale) }) : localeName(tag, locale)}
                  disabled={running} onChange={(v) => { setRefused(null); setLangs((s) => ({ ...s, [tag]: v })); }} />
                <span>{tag === locales.primary ? t.web.languages.renderOriginal({ language: localeName(tag, locale) }) : localeName(tag, locale)}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
      {refused ? (
        <div className="ms-exp-refused" role="alert">
          <b>{t.web.languages.needsForceTitle}</b>
          <ul>{refused.map((r) => <li key={r}>{r}</li>)}</ul>
          <Button variant="outline" size="sm" disabled={running} onClick={() => void run(true)}>{t.web.languages.renderAnyway}</Button>
        </div>
      ) : null}
      <div className="ms-exp-dest">
        <span className="ms-exp-dest-label" id={labelId}>{x.saveTo}</span>
        <div className="ms-exp-dest-field">
          {bridge ? (
            <div className="ms-exp-folder" aria-labelledby={labelId}>
              <Icon name="folder" size={14} />
              <span className={cx('ms-exp-path', !folder && 'ms-faint')}>{folder || x.noFolder}</span>
              {remembered ? <span className="ms-exp-last">{x.lastUsed}</span> : null}
            </div>
          ) : (
            <Input aria-label={x.folder} value={folder} disabled={running} placeholder={x.placeholder} spellCheck={false}
              onChange={(e) => setFolder(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} />
          )}
          {bridge ? <Button variant="outline" disabled={running} onClick={() => void choose()}>{x.choose}</Button> : null}
        </div>
        {anyVideo ? (
          <>
            <span className="ms-exp-dest-label" id={resolutionId}>{x.resolution}</span>
            <div className="ms-exp-dest-field" aria-labelledby={resolutionId}>
              <Select label={x.resolution} value={lockProfile || profile.resolution === null ? 'original' : String(profile.resolution)} disabled={running || lockProfile}
                options={[{ value: 'original', label: x.resolutionOriginal }, ...EXPORT_RESOLUTIONS.map((n) => ({ value: String(n), label: x.resolutionOption({ n }) }))]}
                onChange={(v) => setProfile((p) => ({ ...p, resolution: v === 'original' ? null : Number(v) }))} />
            </div>
            <span className="ms-exp-dest-label" id={fpsId}>{x.frameRate}</span>
            <div className="ms-exp-dest-field" aria-labelledby={fpsId}>
              <Select label={x.frameRate} value={lockProfile || profile.fps === null ? 'original' : String(profile.fps)} disabled={running || lockProfile}
                options={[{ value: 'original', label: x.frameRateOriginal({ fps: ownFps }) }, ...EXPORT_FPS.map((n) => ({ value: String(n), label: x.frameRateOption({ n }) }))]}
                onChange={(v) => setProfile((p) => ({ ...p, fps: v === 'original' ? null : Number(v) as ExportFps }))} />
            </div>
            <span className="ms-exp-dest-label" id={qualityId}>{x.quality}</span>
            <div className="ms-exp-quality">
              <Segmented label={x.quality} value={lockProfile ? DEFAULT_EXPORT_QUALITY : profile.quality} disabled={running || lockProfile} describedBy={qualityHintId}
                options={EXPORT_QUALITIES.map((q) => ({ value: q, label: x.qualityNames[q] }))} onChange={(q) => setProfile((p) => ({ ...p, quality: q }))} />
              <span id={qualityHintId} className="ms-exp-note">{lockProfile ? x.profileLocked : `${x.qualityHints[profile.quality]}. ${x.profileHint}.`}</span>
            </div>
          </>
        ) : null}
        <span className="ms-exp-dest-label" id={namesId}>{x.names}</span>
        <div className="ms-exp-pattern">
          <div className="ms-exp-dest-field">
            <Input ref={field} aria-label={x.pattern} aria-describedby={previewId} aria-invalid={nameProblem !== null || undefined} value={pattern}
              disabled={running} spellCheck={false} autoComplete="off" className="ms-exp-pattern-field"
              onChange={(e) => { setPattern(e.target.value); setSave((s) => (s.kind === 'saving' ? s : { kind: 'idle' })); }} />
            <Button variant="outline" disabled={running || save.kind === 'saving' || pattern === savedPattern || tooLong || !pattern.trim() || anyRowEmpty}
              loading={save.kind === 'saving'} onClick={() => void saveDefault()}>{x.saveDefault}</Button>
          </div>
          <div className="ms-exp-tokens" role="group" aria-labelledby={namesId}>
            {EXPORT_NAME_TOKENS.map((token) => (
              <Chip key={token} className="ms-exp-token" disabled={running} title={x.insertToken({ token })} onClick={() => insert(token)}>{`{${token}}`}</Chip>
            ))}
          </div>
          <div id={previewId} className="ms-exp-preview">
            {preview ? <span className="ms-exp-preview-line"><span className="ms-exp-preview-label">{x.preview}</span><span className="ms-exp-file">{preview}</span></span> : null}
            {translatedNames.map((l) => (
              <span key={l.tag} className="ms-exp-preview-line">
                <span className="ms-exp-preview-label">{x.previewLanguage({ language: localeName(l.tag, locale) })}</span>
                <span className="ms-exp-file">{l.names.join(', ')}</span>
              </span>
            ))}
            {unknown.length ? <span className="ms-exp-hint">{x.unknownVars({ list: unknown.map((u) => `{${u}}`).join(', ') })}</span> : null}
            {nameProblem ? <span role="alert" className="ms-exp-error">{nameProblem}</span> : null}
            {save.kind === 'saved' ? <span role="status" className="ms-exp-note">{x.savedDefault}</span> : null}
            {save.kind === 'failed' ? <span role="alert" className="ms-exp-error">{x.saveFailed({ detail: save.detail })}</span> : null}
          </div>
        </div>
      </div>
      <div className="ms-exp-foot">
        {phase.kind === 'job' ? (
          <div className="ms-exp-progress">
            <span>{stageText(job, x)}</span>
            <JobProgress job={job} label={stageText(job, x)} />
            <span className="ms-exp-note" role="status">{x.background}</span>
          </div>
        ) : running ? (
          <div className="ms-exp-progress">
            <span>{x.running}</span>
            <div className="ms-progress ms-indet" role="progressbar" aria-label={x.running}><i /></div>
          </div>
        ) : (
          <div className="ms-exp-summary">
            <b>{x.files({ count: chosen.length })}</b>
            {error ? <span role="alert" className="ms-exp-error">{error}</span> : <span className="ms-exp-note">{x.noOverwrite}</span>}
          </div>
        )}
        {phase.kind === 'job' ? (
          <>
            {/* Cancel stops the export on the core (and the renders it started); Close leaves it running. */}
            <Button size="lg" variant="ghost" onClick={cancelJob}>{x.cancelExport}</Button>
            <Button size="lg" variant="ink" onClick={onClose}>{t.common.close}</Button>
          </>
        ) : (
          <>
            <Button size="lg" variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
            <Button size="lg" variant="ink" loading={running} disabled={!canRun || (withLanguages && wanted.length === 0)} onClick={() => void run()}>
              {x.run({ count: chosen.length })}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** The export job's progress: its renders' percent, indeterminate before any reports and while the files are copied. */
function JobProgress({ job, label }: { job: JobSummary | undefined; label: string }) {
  const pct = job?.export?.stage === 'rendering' && job.export.renders?.length ? job.export.pct : null;
  return pct === null || pct === undefined ? <div className="ms-progress ms-indet" role="progressbar" aria-label={label}><i /></div> : <ProgressBar value={pct} label={label} />;
}
