import { CUSTOM_DURATION_MAX, CUSTOM_NAME_MAX, isCustomPreset, type CustomFormatInput, type FormatPreset } from '@motion-studio/shared';
import { useEffect, useRef, useState } from 'react';
import { api, type CatalogState } from '../../api.ts';
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
export type CustomProblem = 'name' | 'nameTaken' | 'size' | 'duration';

const intIn = (s: string, min: number, max: number): number | null => {
  if (!/^\d+$/.test(s.trim())) return null;
  const n = Number(s.trim());
  return n >= min && n <= max ? n : null;
};

/**
 * The problems of the dialog's fields, in field order: a name (unique among the visible custom formats, `except` the one being
 * edited), whole sizes 16–8192, and for a video a maximum length in whole seconds 1–3600 or nothing.
 */
export function customDraftProblems(d: CustomDraft, presets: readonly FormatPreset[], except: string | null): Partial<Record<CustomField, CustomProblem>> {
  const out: Partial<Record<CustomField, CustomProblem>> = {};
  const name = d.name.trim();
  if (!name) out.name = 'name';
  else if (presets.some((p) => isCustomPreset(p) && !p.hidden && p.id !== except && p.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) out.name = 'nameTaken';
  if (intIn(d.width, SIZE_MIN, SIZE_MAX) === null) out.width = 'size';
  if (intIn(d.height, SIZE_MIN, SIZE_MAX) === null) out.height = 'size';
  if (d.kind === 'video' && d.duration.trim() && intIn(d.duration, 1, CUSTOM_DURATION_MAX) === null) out.duration = 'duration';
  return out;
}

/** The input the core takes, from a draft without problems. */
export function customInputOf(d: CustomDraft): CustomFormatInput {
  return {
    name: d.name.trim(), kind: d.kind, width: Number(d.width), height: Number(d.height),
    ...(d.kind === 'video' && d.duration.trim() ? { maxDurationSec: Number(d.duration) } : {}),
  };
}

/** The height a ratio `a:b` gives for `width`, within the size limits. */
export const heightFor = (width: number, [a, b]: readonly [number, number]): number => Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round((width * b) / a)));

const draftOf = (p: FormatPreset | null): CustomDraft => (p
  ? { name: p.name, kind: p.kind, width: String(p.width), height: String(p.height), duration: p.maxDurationSec !== undefined ? String(p.maxDurationSec) : '' }
  : { name: '', kind: 'image', width: '1080', height: '1080', duration: '' });

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
 * the height from the width), the maximum length of a video. The rest (id, channel, extensions) is the core's. Editing a
 * format that creatives use keeps its type and size (said in the dialog; the core refuses it too); it can be deleted from here.
 */
export function CustomFormatDialog({ open, onClose, editing, presets, onSaved, onDeleted }: CustomFormatDialogProps) {
  const t = useT();
  const n = t.web.newCreative;
  const [draft, setDraft] = useState<CustomDraft>(() => draftOf(editing));
  const [problems, setProblems] = useState<Partial<Record<CustomField, CustomProblem>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [usage, setUsage] = useState<number | null>(null);
  const refs = { name: useRef<HTMLInputElement>(null), width: useRef<HTMLInputElement>(null), height: useRef<HTMLInputElement>(null), duration: useRef<HTMLInputElement>(null) };

  // Every opening starts from the format (or a blank one), and reads whether creatives use it.
  useEffect(() => {
    if (!open) return;
    setDraft(draftOf(editing)); setProblems({}); setError(null); setConfirming(false); setBusy(false); setUsage(null);
    if (!editing) return;
    let alive = true;
    Promise.resolve().then(() => api.customFormatUsage(editing.id)).then((u) => { if (alive) setUsage(u.creatives); }).catch(() => { /* the core still refuses */ });
    return () => { alive = false; };
  }, [open, editing]);

  const locked = editing !== null && (usage ?? 0) > 0;
  const set = (patch: Partial<CustomDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    // A field's problem goes once it is edited; the others stay until the next try.
    setProblems((p) => { const next = { ...p }; for (const k of Object.keys(patch)) delete next[(k === 'kind' ? 'duration' : k) as CustomField]; return next; });
  };
  const digits = (s: string) => s.replace(/\D/g, '').slice(0, 4);
  const width = intIn(draft.width, SIZE_MIN, SIZE_MAX);
  const height = intIn(draft.height, SIZE_MIN, SIZE_MAX);
  const ratioOn = (r: readonly [number, number]) => width !== null && height !== null && width * r[1] === height * r[0];
  const applyRatio = (r: readonly [number, number]) => {
    const w = width ?? RATIO_BASE;
    set({ width: String(w), height: String(heightFor(w, r)) });
  };
  const text = (p: CustomProblem) => (p === 'name' ? n.customErrName : p === 'nameTaken' ? n.customErrNameTaken : p === 'size' ? n.customErrSize : n.customErrDuration);

  const submit = async () => {
    if (busy) return;
    const found = customDraftProblems(draft, presets, editing?.id ?? null);
    setProblems(found);
    const first = (['name', 'width', 'height', 'duration'] as const).find((f) => found[f]);
    if (first) { refs[first].current?.focus(); return; }
    setBusy(true); setError(null);
    try {
      const body = customInputOf(draft);
      const r = editing ? await api.editCustomFormat(editing.id, body) : await api.addCustomFormat(body);
      onSaved(r.preset, r.catalog, editing === null);
    } catch (e) {
      setError(n.customFailed({ detail: errText(e) }));
      setBusy(false);
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
  const err = (f: CustomField) => (problems[f] ? <p id={errId(f)} className="ms-cfd-err" role="alert">{text(problems[f]!)}</p> : null);
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
        {/* A format in use keeps its size: no ratios to pick. */}
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
        {draft.kind === 'video' ? (
          <>
            <label htmlFor="ms-cfd-dur">{n.customDuration}</label>
            <span className="ms-cfd-px ms-cfd-dur">
              <Input id="ms-cfd-dur" ref={refs.duration} inputMode="numeric" value={draft.duration} onChange={(e) => set({ duration: digits(e.target.value) })} {...field('duration')} />
              <span aria-hidden="true">{n.customSecondsUnit}</span>
            </span>
            <p className="ms-cfd-hint" id="ms-cfd-dur-hint">{n.customDurationHint}</p>
            {err('duration')}
          </>
        ) : null}
        {locked ? <p className="ms-cfd-note" id="ms-cfd-locked">{n.customInUse({ count: usage! })}</p> : null}
        {error ? <p className="ms-cfd-err" role="alert">{error}</p> : null}
        {confirming && editing ? (
          <div className="ms-cfd-confirm" role="group" aria-labelledby="ms-cfd-ask">
            <p id="ms-cfd-ask">{n.customDeleteAsk({ name: editing.name })}</p>
            <div className="ms-cfd-actions">
              <Button type="button" variant="ghost" autoFocus onClick={() => setConfirming(false)} disabled={busy}>{t.common.cancel}</Button>
              <Button type="button" variant="danger" loading={busy} onClick={() => void remove()}>{n.customDeleteConfirm}</Button>
            </div>
          </div>
        ) : (
          <div className="ms-cfd-actions">
            {editing ? <Button type="button" variant="ghost" className="ms-cfd-delete" onClick={() => setConfirming(true)} disabled={busy}>{n.customDelete}</Button> : null}
            <span className="ms-grow" />
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
            <Button type="submit" variant="ink" loading={busy}>{editing ? n.customSave : n.customCreate}</Button>
          </div>
        )}
      </form>
    </Modal>
  );
}
