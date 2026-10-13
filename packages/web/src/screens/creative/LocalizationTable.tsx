// The review table of one translation (Phase 12, spec §3.3): per clip the source text, the translation (editable), its state
// (ok, outside the box, outdated, not translated) and the fit (70-100 %). Saving calls PUT of the overlay (origin `editor`);
// an overflow found by the checks is shown inline on its row, the advisory warnings below. The voice choice of the language
// sits on top. Voice clips the core cannot translate (no known script) are listed apart.
import { localizableEntries, type Composition, type LocaleTag, type LocalizationRow } from '@motion-studio/shared';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { api, ApiError, type LocalizationEdit, type LocalizationView } from '../../api.ts';
import { useLocale, useT } from '../../i18n.tsx';
import { message } from '../../errors.ts';
import { Button, cx, Pill, Segmented, Slider, Textarea } from '../../ui/index.ts';
import { clipDisplay, localeName, problemsOfClip, reasonText, type VoiceReason } from './languagesModel.ts';
import './languages.css';

export interface LocalizationTableProps {
  slug: string; creative: string; n: number; locale: LocaleTag;
  /** The format instance the translation is for, and its name. */
  instanceId: string; formatLabel: string;
  /** The base composition of the instance (the source texts). */
  composition: Composition;
  /** The row of the translation in the version; undefined: not translated yet. */
  row: LocalizationRow | undefined;
  /** Why "Translate" is not available for the voice (null: it is). */
  voiceReason: VoiceReason | null;
  /** A turn runs: the core refuses edits meanwhile. */
  busy?: boolean;
  /** Called after a save, so the version's rows are read again. */
  onSaved?(view: LocalizationView): void;
}

type VoiceMode = 'translate' | 'original' | 'muted';
const modeOf = (voice: LocalizationRow['voice'] | undefined): VoiceMode => (voice === 'translated' ? 'translate' : voice === 'muted' ? 'muted' : 'original');

export function LocalizationTable({ slug, creative, n, locale, instanceId, formatLabel, composition, row, voiceReason, busy = false, onSaved }: LocalizationTableProps) {
  const t = useT();
  const l = t.web.languages;
  const ui = useLocale();
  const entries = useMemo(() => localizableEntries(composition), [composition]);
  const [view, setView] = useState<LocalizationView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [params, setParams] = useState<Record<string, string>>({});
  const [fit, setFit] = useState<Record<string, number>>({});
  const [mode, setMode] = useState<VoiceMode>(modeOf(row?.voice));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const titleId = useId();

  // The stored translation, read again when its row changes (a turn, a save).
  const rowHash = row?.hash ?? null;
  useEffect(() => {
    let alive = true;
    setLoadError(null);
    if (rowHash === null) { setView(null); setTexts({}); setParams({}); setFit({}); setMode('original'); return; }
    Promise.resolve().then(() => api.getLocalization(slug, creative, n, locale, instanceId))
      .then((v) => {
        if (!alive) return;
        setView(v);
        setTexts(Object.fromEntries(Object.entries(v.overlay.texts).map(([id, x]) => [id, x.text])));
        setParams(Object.fromEntries(Object.entries(v.overlay.params).map(([id, x]) => [id, x.text])));
        setFit(Object.fromEntries(Object.entries(v.overlay.fit).map(([id, x]) => [id, Math.round(x * 100)])));
        setMode(modeOf(v.voice));
      })
      .catch((e: unknown) => { if (alive) setLoadError(message(e)); });
    return () => { alive = false; };
  }, [slug, creative, n, locale, instanceId, rowHash]);

  const stale = new Set(view?.stale ?? row?.stale ?? []);
  const problems = view?.problems ?? row?.problems ?? [];
  const overlay = view?.overlay;

  const edit = useMemo<LocalizationEdit>(() => {
    const out: LocalizationEdit = {};
    const stored = overlay?.texts ?? {};
    for (const e of entries.texts) {
      const now = (texts[e.clipId] ?? '').trim() === '' ? null : texts[e.clipId]!;
      const was = stored[e.clipId]?.text ?? null;
      if (now !== was) (out.texts ??= {})[e.clipId] = now;
    }
    for (const e of entries.params) {
      const now = (params[e.key] ?? '').trim() === '' ? null : params[e.key]!;
      const was = overlay?.params[e.key]?.text ?? null;
      if (now !== was) (out.params ??= {})[e.key] = now;
    }
    for (const e of entries.texts) {
      const f = fit[e.clipId];
      const was = overlay?.fit[e.clipId];
      // A fit is sent only when the person moved it (the core picks one for a text it just got).
      if (f !== undefined && (was === undefined ? false : Math.round(was * 100) !== f) && texts[e.clipId] !== undefined && stored[e.clipId]) (out.fit ??= {})[e.clipId] = f / 100;
    }
    if (mode !== 'translate' && mode !== modeOf(view?.voice ?? row?.voice)) out.voice = mode;
    return out;
  }, [entries, texts, params, fit, mode, overlay, view, row]);
  const dirty = Object.keys(edit).length > 0;

  const save = useCallback(async () => {
    setSaving(true); setSaveError(null); setSaved(false);
    try {
      const v = await api.saveLocalization(slug, creative, n, locale, instanceId, edit);
      setView(v);
      setTexts(Object.fromEntries(Object.entries(v.overlay.texts).map(([id, x]) => [id, x.text])));
      setParams(Object.fromEntries(Object.entries(v.overlay.params).map(([id, x]) => [id, x.text])));
      setFit(Object.fromEntries(Object.entries(v.overlay.fit).map(([id, x]) => [id, Math.round(x * 100)])));
      setMode(modeOf(v.voice));
      setSaved(true);
      onSaved?.(v);
    } catch (e) {
      setSaveError(e instanceof ApiError && e.code === 'localization-busy' ? l.busy : message(e));
    } finally { setSaving(false); }
  }, [slug, creative, n, locale, instanceId, edit, onSaved, l.busy]);

  const rowState = (id: string, label: string, translated: boolean) => {
    const own = problemsOfClip(problems, label);
    if (!translated) return { tone: 'neutral' as const, text: l.rowNotTranslated, own };
    if (stale.has(id)) return { tone: 'warn' as const, text: l.rowStale, own };
    if (own.length) return { tone: 'warn' as const, text: l.rowOverflow, own };
    return { tone: 'ok' as const, text: l.rowOk, own };
  };
  const noScript = row?.noScript ?? [];
  const labelOf = (id: string) => clipDisplay(entries.texts.find((e) => e.clipId === id) ?? entries.voices.find((e) => e.clipId === id) ?? { clipId: id });
  const matched = new Set(entries.texts.flatMap((e) => problemsOfClip(problems, clipDisplay(e))));
  const general = problems.filter((p) => !matched.has(p));

  return (
    <section className="ms-lt" aria-labelledby={titleId}>
      <div className="ms-lt-head">
        <b id={titleId}>{l.tableTitle({ language: localeName(locale, ui), format: formatLabel })}</b>
        <Segmented<VoiceMode> label={l.voiceLabel} value={mode} onChange={setMode} disabled={busy || !row}
          options={[
            { value: 'translate', label: l.voiceTranslate, disabled: row?.voice !== 'translated', title: row?.voice === 'translated' ? undefined : voiceReason ? reasonText(voiceReason, t) : l.voiceTranslateFromPanel },
            { value: 'original', label: l.voiceOriginal },
            { value: 'muted', label: l.voiceMuted },
          ]} />
      </div>
      {loadError ? <p role="alert" className="ms-lt-error">{loadError}</p> : null}
      {general.length ? (
        <ul className="ms-lt-general" aria-label={l.problemsLabel}>{general.map((p) => <li key={p}>{p}</li>)}</ul>
      ) : null}
      {entries.texts.length + entries.params.length === 0 ? <p className="ms-lt-empty">{l.nothingToTranslate}</p> : (
        <table className="ms-lt-table">
          <thead>
            <tr><th scope="col">{l.colSource}</th><th scope="col">{l.colTranslation}</th><th scope="col">{l.colStatus}</th><th scope="col">{l.colFit}</th></tr>
          </thead>
          <tbody>
            {entries.texts.map((e) => {
              const label = clipDisplay(e);
              const has = Boolean(overlay?.texts[e.clipId]) || (texts[e.clipId] ?? '').trim() !== '';
              const st = rowState(e.clipId, label, Boolean(overlay?.texts[e.clipId]));
              const f = fit[e.clipId] ?? 100;
              return (
                <tr key={e.clipId} data-clip={e.clipId} className={cx(st.own.length > 0 && 'ms-lt-over', stale.has(e.clipId) && 'ms-lt-stale')}>
                  <th scope="row" className="ms-lt-src"><span className="ms-lt-name">{label}</span><span className="ms-lt-text">{e.text}</span></th>
                  <td>
                    <Textarea rows={2} aria-label={l.translationOf({ clip: label })} value={texts[e.clipId] ?? ''} disabled={busy}
                      aria-invalid={st.own.length > 0 || undefined} onChange={(ev) => setTexts((s) => ({ ...s, [e.clipId]: ev.target.value }))} />
                    {st.own.map((p) => <p key={p} role="alert" className="ms-lt-inline">{p}</p>)}
                  </td>
                  <td><Pill tone={st.tone}>{st.text}</Pill></td>
                  <td className="ms-lt-fit">
                    {has ? <Slider label={l.fitOf({ clip: label })} value={f} min={70} max={100} step={5} valueText={`${f}%`} disabled={busy}
                      onChange={(v) => setFit((s) => ({ ...s, [e.clipId]: v }))} /> : null}
                    {has ? <span className="ms-lt-fit-value" aria-hidden="true">{f}%</span> : null}
                  </td>
                </tr>
              );
            })}
            {entries.params.map((e) => {
              const label = e.label ?? e.key;
              const st = rowState(e.key, label, Boolean(overlay?.params[e.key]));
              return (
                <tr key={e.key} data-param={e.key} className={cx(stale.has(e.key) && 'ms-lt-stale')}>
                  <th scope="row" className="ms-lt-src"><span className="ms-lt-name">{label}</span><span className="ms-lt-text">{e.text}</span></th>
                  <td><Textarea rows={2} aria-label={l.translationOf({ clip: label })} value={params[e.key] ?? ''} disabled={busy}
                    onChange={(ev) => setParams((s) => ({ ...s, [e.key]: ev.target.value }))} /></td>
                  <td><Pill tone={st.tone}>{st.text}</Pill></td>
                  <td />
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {noScript.length ? (
        <div className="ms-lt-noscript" role="note">
          <b>{l.noScriptTitle}</b>
          <ul>{noScript.map((id) => <li key={id}>{l.noScriptItem({ clip: labelOf(id) })}</li>)}</ul>
        </div>
      ) : null}
      {view?.warnings?.length ? (
        <ul className="ms-lt-warnings" aria-label={l.warningsLabel}>{view.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
      ) : null}
      <div className="ms-lt-foot">
        {saveError ? <span role="alert" className="ms-lt-error">{saveError}</span> : saved ? <span role="status" className="ms-lt-saved">{l.saved}</span> : <span />}
        <Button variant="ink" size="sm" loading={saving} disabled={!dirty || busy || saving} onClick={() => void save()}>{l.save}</Button>
      </div>
    </section>
  );
}
