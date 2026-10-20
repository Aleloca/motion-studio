import { CUSTOM_DURATION_MAX, CUSTOM_NAME_MAX, CUSTOM_VIDEO_MAX, isCustomPreset, sameCustomName, type CustomFormatInput, type FormatPreset } from '@motion-studio/shared';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type CatalogState } from '../../api.ts';
import { useT } from '../../i18n.tsx';
import { Button, Chip, Input, Modal, Segmented } from '../../ui/index.ts';
import { message as errText } from '../common.tsx';

/** One-click ratios (report 59): each sets the height from the width. */
export const CUSTOM_RATIOS: ReadonlyArray<readonly [number, number]> = [[1, 1], [4, 5], [9, 16], [16, 9]];
/** The width a ratio starts from when the width field holds no valid size yet. */
const RATIO_BASE = 1080;
const SIZE_MIN = 16;
const SIZE_MAX = 8192;

export interface CustomDraft { name: string; kind: 'video' | 'image'; width: string; height: string; duration: string }
export type CustomField = 'name' | 'width' | 'height' | 'duration';
export type CustomProblem = 'name' | 'nameTaken' | 'size' | 'even' | 'videoMax' | 'duration' | 'durationShort';
/** What the dialog knows of a format's use: the creatives that use it (or might: unreadable ones) and the longest length. */
export interface CustomUsage { creatives: number; unreadable: number; longestSec: number }

const intIn = (s: string, min: number, max: number): number | null => {
  if (!/^\d+$/.test(s.trim())) return null;
  const n = Number(s.trim());
  return n >= min && n <= max ? n : null;
};

/**
 * The problems of the dialog's fields, in field order: a name (unique among the visible custom formats, `except` the one being
 * edited), whole sizes 16–8192 (a video: even, at most 4096: H.264 in yuv420p), and for a video a maximum length in whole
 * seconds 1–3600 or nothing, never under `longestSec` (the longest a creative uses the format at).
 */
export function customDraftProblems(d: CustomDraft, presets: readonly FormatPreset[], except: string | null, longestSec = 0): Partial<Record<CustomField, CustomProblem>> {
  const out: Partial<Record<CustomField, CustomProblem>> = {};
  const name = d.name.trim();
  if (!name) out.name = 'name';
  else if (presets.some((p) => isCustomPreset(p) && !p.hidden && p.id !== except && sameCustomName(p.name, name))) out.name = 'nameTaken';
  for (const k of ['width', 'height'] as const) {
    const v = intIn(d[k], SIZE_MIN, SIZE_MAX);
    if (v === null) out[k] = 'size';
    else if (d.kind === 'video' && v > CUSTOM_VIDEO_MAX) out[k] = 'videoMax';
    else if (d.kind === 'video' && v % 2 !== 0) out[k] = 'even';
  }
  if (d.kind === 'video' && d.duration.trim()) {
    const sec = intIn(d.duration, 1, CUSTOM_DURATION_MAX);
    if (sec === null) out.duration = 'duration';
    else if (sec < longestSec) out.duration = 'durationShort';
  }
  return out;
}

/** The input the core takes, from a draft without problems. */
export function customInputOf(d: CustomDraft): CustomFormatInput {
  return {
    name: d.name.trim(), kind: d.kind, width: Number(d.width), height: Number(d.height),
    ...(d.kind === 'video' && d.duration.trim() ? { maxDurationSec: Number(d.duration) } : {}),
  };
}

/** The height a ratio `a:b` gives for `width`, within the size limits; for a video, even and at most 4096. */
export function heightFor(width: number, [a, b]: readonly [number, number], video = false): number {
  const h = (width * b) / a;
  if (!video) return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(h)));
  return Math.min(CUSTOM_VIDEO_MAX, Math.max(SIZE_MIN, Math.round(h / 2) * 2));
}
/** Whether `width` × `height` is the ratio `a:b`, give or take the pixel a rounding (to even, for a video) moves it. */
export const ratioMatches = (width: number, height: number, [a, b]: readonly [number, number]): boolean => Math.abs((width * b) / a - height) <= 1;

const draftOf = (p: FormatPreset | null): CustomDraft => (p
  ? { name: p.name, kind: p.kind, width: String(p.width), height: String(p.height), duration: p.maxDurationSec !== undefined ? String(p.maxDurationSec) : '' }
  : { name: '', kind: 'image', width: '1080', height: '1080', duration: '' });

/** The field a refusal of the core is about (report 59, review): said beside it. */
const FIELD_OF_CODE: Record<string, CustomField> = { 'custom-format-name-taken': 'name', 'custom-format-in-use': 'width', 'custom-format-duration-too-short': 'duration' };

export interface CustomFormatDialogProps {
  open: boolean;
  onClose(): void;
  /** The custom preset being edited; null: a new one. */
  editing: FormatPreset | null;
  /** The catalog as the board has it (the name check). */
  presets: readonly FormatPreset[];
  onSaved(preset: FormatPreset, catalog: CatalogState, created: boolean): void;
  onDeleted(preset: FormatPreset, outcome: 'deleted' | 'hidden', catalog: CatalogState): void;
}

/**
 * Report 59: the dialog of a custom format, the essentials only: name, video or image, width × height in px (one-click ratios set
 * the height from the width), the maximum length of a video. The rest (id, channel, extensions) is the core's. Editing a format
 * keeps its type and size locked until its use is known, and for good when creatives use it (or might); it can be deleted here.
 */
export function CustomFormatDialog({ open, onClose, editing, presets, onSaved, onDeleted }: CustomFormatDialogProps) {
  const t = useT();
  const n = t.web.newCreative;
  const [draft, setDraft] = useState<CustomDraft>(() => draftOf(editing));
  // The text of each field's problem (from the checks here, or from a refusal of the core).
  const [problems, setProblems] = useState<Partial<Record<CustomField, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [usage, setUsage] = useState<CustomUsage | 'failed' | null>(null);
  const [usageNonce, setUsageNonce] = useState(0);
  const refs = { name: useRef<HTMLInputElement>(null), width: useRef<HTMLInputElement>(null), height: useRef<HTMLInputElement>(null), duration: useRef<HTMLInputElement>(null) };
  const deleteBtn = useRef<HTMLButtonElement>(null);
  const backToDelete = useRef(false);

  // Every opening starts from the format (or a blank one).
  useEffect(() => {
    if (!open) return;
    setDraft(draftOf(editing)); setProblems({}); setError(null); setConfirming(false); setBusy(false); setUsage(null);
  }, [open, editing]);
  // And reads whether creatives use it (again on Riprova).
  useEffect(() => {
    if (!open || !editing) return;
    let alive = true;
    setUsage(null);
    Promise.resolve().then(() => api.customFormatUsage(editing.id))
      .then((u) => { if (alive) setUsage(u); })
      .catch(() => { if (alive) setUsage('failed'); });
    return () => { alive = false; };
  }, [open, editing, usageNonce]);
  // Cancelling the delete question gives the focus back to Elimina.
  useEffect(() => {
    if (!confirming && backToDelete.current) { backToDelete.current = false; deleteBtn.current?.focus(); }
  }, [confirming]);

  const known = usage !== null && usage !== 'failed' ? usage : null;
  const users = known ? known.creatives + known.unreadable : 0;
  // Type and size stay locked while the use is unknown (loading, or the check failed) and when creatives use the format.
  const locked = editing !== null && (known === null || users > 0);
  const longestSec = known?.longestSec ?? 0;
  const set = (patch: Partial<CustomDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    // A field's problem goes once it is edited (the type changes what the sizes and the length may be).
    setProblems((p) => {
      const next = { ...p };
      for (const k of Object.keys(patch)) { if (k === 'kind') { delete next.width; delete next.height; delete next.duration; } else delete next[k as CustomField]; }
      return next;
    });
  };
  const digits = (s: string) => s.replace(/\D/g, '').slice(0, 4);
  const video = draft.kind === 'video';
  const width = intIn(draft.width, SIZE_MIN, SIZE_MAX);
  const height = intIn(draft.height, SIZE_MIN, SIZE_MAX);
  const ratioOn = (r: readonly [number, number]) => width !== null && height !== null && ratioMatches(width, height, r);
  const applyRatio = (r: readonly [number, number]) => {
    const w = width ?? RATIO_BASE;
    set({ width: String(w), height: String(heightFor(w, r, video)) });
  };
  const text = (p: CustomProblem): string => ({
    name: n.customErrName, nameTaken: n.customErrNameTaken, size: n.customErrSize, even: n.customErrEven, videoMax: n.customErrVideoMax,
    duration: n.customErrDuration, durationShort: n.customErrDurationShort({ sec: longestSec }),
  })[p];

  const focusFirst = (found: Partial<Record<CustomField, unknown>>) => {
    const first = (['name', 'width', 'height', 'duration'] as const).find((f) => found[f]);
    if (first) refs[first].current?.focus();
    return first;
  };
  const submit = async () => {
    if (busy) return;
    const found = customDraftProblems(draft, presets, editing?.id ?? null, longestSec);
    setProblems(Object.fromEntries(Object.entries(found).map(([k, v]) => [k, text(v)])));
    if (focusFirst(found)) return;
    setBusy(true); setError(null);
    try {
      const body = customInputOf(draft);
      const r = editing ? await api.editCustomFormat(editing.id, body) : await api.addCustomFormat(body);
      onSaved(r.preset, r.catalog, editing === null);
    } catch (e) {
      setBusy(false);
      const field = e instanceof ApiError && e.code ? FIELD_OF_CODE[e.code] : undefined;
      if (field) {
        setProblems({ [field]: errText(e) });
        // A refusal for a format in use: its use changed meanwhile, so it is read again (and the fields lock).
        if (e instanceof ApiError && e.code === 'custom-format-in-use') setUsageNonce((x) => x + 1);
        setTimeout(() => refs[field].current?.focus(), 0);
      } else setError(n.customFailed({ detail: errText(e) }));
    }
  };
  const remove = async () => {
    if (!editing || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await api.deleteCustomFormat(editing.id);
      onDeleted(editing, r.outcome, r.catalog);
    } catch (e) {
      setError(n.customDeleteFailed({ detail: errText(e) }));
      setBusy(false);
    }
  };

  // Width and height share one message under the pair.
  const errId = (f: CustomField) => (f === 'width' || f === 'height' ? 'ms-cfd-size-err' : `ms-cfd-${f}-err`);
  const field = (f: CustomField) => ({
    'aria-invalid': problems[f] ? true : undefined,
    'aria-describedby': [problems[f] ? errId(f) : '', (f === 'width' || f === 'height') && locked ? 'ms-cfd-locked' : '', f === 'duration' ? 'ms-cfd-dur-hint' : ''].filter(Boolean).join(' ') || undefined,
  });
  const err = (f: CustomField) => (problems[f] ? <p id={errId(f)} className="ms-cfd-err" role="alert">{problems[f]}</p> : null);
  const title = editing ? n.customEditTitle : n.customNewTitle;
  return (
    <Modal open={open} onClose={onClose} label={title} width={460} dismissible={!busy}>
      <form className="ms-cfd" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h2>{title}</h2>
        <label htmlFor="ms-cfd-name">{n.customName}</label>
        <Input id="ms-cfd-name" ref={refs.name} autoFocus value={draft.name} maxLength={CUSTOM_NAME_MAX} placeholder={n.customNamePlaceholder}
          onChange={(e) => set({ name: e.target.value })} {...field('name')} />
        {err('name')}
        <span className="ms-cfd-lbl" aria-hidden="true">{n.customKind}</span>
        <Segmented className="ms-cfd-kind" label={n.customKind} value={draft.kind} disabled={locked} describedBy={locked ? 'ms-cfd-locked' : undefined}
          onChange={(v) => set({ kind: v })}
          options={[{ value: 'image', label: n.customKindImage, icon: 'image' }, { value: 'video', label: n.customKindVideo, icon: 'video' }]} />
        <div className="ms-cfd-size">
          <div className="ms-cfd-dim">
            <label htmlFor="ms-cfd-w">{n.customWidth}</label>
            <span className="ms-cfd-px">
              <Input id="ms-cfd-w" ref={refs.width} inputMode="numeric" value={draft.width} disabled={locked} onChange={(e) => set({ width: digits(e.target.value) })} {...field('width')} />
              <span aria-hidden="true">{n.customPx}</span>
            </span>
          </div>
          <span className="ms-cfd-x" aria-hidden="true">×</span>
          <div className="ms-cfd-dim">
            <label htmlFor="ms-cfd-h">{n.customHeight}</label>
            <span className="ms-cfd-px">
              <Input id="ms-cfd-h" ref={refs.height} inputMode="numeric" value={draft.height} disabled={locked} onChange={(e) => set({ height: digits(e.target.value) })} {...field('height')} />
              <span aria-hidden="true">{n.customPx}</span>
            </span>
          </div>
        </div>
        {problems.width ? err('width') : err('height')}
        {/* A locked size has no ratios to pick. */}
        {locked ? null : (
          <>
            <div className="ms-cfd-ratios" role="group" aria-labelledby="ms-cfd-ratio-lbl" aria-describedby="ms-cfd-ratio-hint">
              <span className="ms-cfd-lbl" id="ms-cfd-ratio-lbl">{n.customRatio}</span>
              {CUSTOM_RATIOS.map((r) => {
                const label = `${r[0]}:${r[1]}`;
                return <Chip key={label} on={ratioOn(r)} title={n.customRatioAria({ ratio: label })} onClick={() => applyRatio(r)}>{label}</Chip>;
              })}
            </div>
            <p className="ms-cfd-hint" id="ms-cfd-ratio-hint">{n.customRatioHint}</p>
          </>
        )}
        {video ? (
          <>
            <label htmlFor="ms-cfd-dur">{n.customDuration}</label>
            <span className="ms-cfd-px ms-cfd-dur">
              <Input id="ms-cfd-dur" ref={refs.duration} inputMode="numeric" value={draft.duration} onChange={(e) => set({ duration: digits(e.target.value) })} {...field('duration')} />
              <span aria-hidden="true">{n.customSecondsUnit}</span>
            </span>
            <p className="ms-cfd-hint" id="ms-cfd-dur-hint">{n.customDurationHint}{longestSec > 0 ? ` ${n.customLongest({ sec: longestSec })}` : ''}</p>
            {err('duration')}
          </>
        ) : null}
        {editing && usage === null ? <p className="ms-cfd-note" id="ms-cfd-locked" role="status">{n.customUsageLoading}</p> : null}
        {editing && usage === 'failed' ? (
          <p className="ms-cfd-note ms-cfd-note-row" id="ms-cfd-locked">
            <span>{n.customUsageFailed}</span>
            <Button size="sm" variant="outline" onClick={() => setUsageNonce((x) => x + 1)}>{n.tryAgain}</Button>
          </p>
        ) : null}
        {known && users > 0 ? <p className="ms-cfd-note" id="ms-cfd-locked">{n.customInUse({ count: users })}</p> : null}
        {error ? <p className="ms-cfd-err" role="alert">{error}</p> : null}
        {confirming && editing ? (
          <div className="ms-cfd-confirm" role="group" aria-labelledby="ms-cfd-ask">
            <p id="ms-cfd-ask">{n.customDeleteAsk({ name: editing.name })}</p>
            <div className="ms-cfd-actions">
              <Button type="button" variant="ghost" autoFocus onClick={() => { backToDelete.current = true; setConfirming(false); }} disabled={busy}>{t.common.cancel}</Button>
              <Button type="button" variant="danger" loading={busy} onClick={() => void remove()}>{n.customDeleteConfirm}</Button>
            </div>
          </div>
        ) : (
          <div className="ms-cfd-actions">
            {editing ? <Button ref={deleteBtn} type="button" variant="ghost" className="ms-cfd-delete" onClick={() => setConfirming(true)} disabled={busy}>{n.customDelete}</Button> : null}
            <span className="ms-grow" />
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
            <Button type="submit" variant="ink" loading={busy}>{editing ? n.customSave : n.customCreate}</Button>
          </div>
        )}
      </form>
    </Modal>
  );
}
