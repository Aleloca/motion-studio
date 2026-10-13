// "Render" of a creative with languages (Phase 12, spec §3.5): a multiselect of the languages to render (the original and the
// translations that exist). A translation with open problems or outdated texts is refused by the core with the list (409): the
// dialog shows it and offers "Render anyway", which sends `force`. Without languages in the brief the renders start as before.
import type { LocaleTag, LocalizationRow } from '@motion-studio/shared';
import { useId, useRef, useState } from 'react';
import { api, ApiError } from '../../api.ts';
import { message } from '../../errors.ts';
import { useLocale, useT } from '../../i18n.tsx';
import { Button, Check, Icon, Modal, toast } from '../../ui/index.ts';
import { localeName } from './languagesModel.ts';
import './languages.css';

export interface RenderLanguagesDialogProps {
  open: boolean;
  onClose(): void;
  slug: string;
  creative: string;
  /** Per version, the formats to render. */
  plan: Array<[number, string[]]>;
  locales: { primary: LocaleTag; extra: LocaleTag[] };
  /** The translations of version n. */
  rowsOf(n: number): readonly LocalizationRow[];
  labelOf(format: string): string;
}

export function RenderLanguagesDialog(p: RenderLanguagesDialogProps) {
  const t = useT();
  return (
    <Modal open={p.open} onClose={p.onClose} label={t.web.languages.renderTitle} width={560}>
      {p.open ? <Body {...p} /> : null}
    </Modal>
  );
}

function Body({ onClose, slug, creative, plan, locales, rowsOf, labelOf }: RenderLanguagesDialogProps) {
  const t = useT();
  const l = t.web.languages;
  const ui = useLocale();
  const hasAll = (tag: LocaleTag) => plan.every(([n, formats]) => formats.every((f) => rowsOf(n).some((r) => r.locale === tag && r.instanceId === f)));
  const [on, setOn] = useState<Record<string, boolean>>(() => ({ [locales.primary]: true, ...Object.fromEntries(locales.extra.map((tag) => [tag, hasAll(tag)])) }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The translations the core refused until "Render anyway": the versions that must be sent again, with the list. */
  const [refused, setRefused] = useState<{ versions: Array<[number, string[]]>; list: string[] } | null>(null);
  const primaryDone = useRef(false);
  const listId = useId();
  const chosen = locales.extra.filter((tag) => on[tag] && hasAll(tag));
  const withPrimary = Boolean(on[locales.primary]);

  const run = async (force: boolean) => {
    setBusy(true); setError(null);
    const targets = force && refused ? refused.versions : plan;
    const stillRefused: Array<[number, string[]]> = [];
    const list: string[] = [];
    let started = 0;
    let failure: string | null = null;
    for (const [n, formats] of targets) {
      try {
        if (withPrimary && !primaryDone.current) { await api.renderVersion(slug, creative, n, formats); started += formats.length; }
        if (chosen.length) { await api.renderVersion(slug, creative, n, formats, { locales: chosen, force }); started += formats.length * chosen.length; }
      } catch (e) {
        if (e instanceof ApiError && e.code === 'localization-needs-force' && !force) { stillRefused.push([n, formats]); list.push(...(e.problems ?? [e.message])); } else failure ??= message(e);
      }
    }
    // The original is rendered once: a "Render anyway" sends the translations only.
    if (withPrimary) primaryDone.current = true;
    setBusy(false);
    if (stillRefused.length) { setRefused({ versions: stillRefused, list: [...new Set(list)] }); }
    else setRefused(null);
    if (failure) { setError(failure); return; }
    if (stillRefused.length) return;
    toast.show(t.web.render.started({ count: started }), { tone: 'ok' });
    onClose();
  };

  return (
    <div className="ms-lp ms-rl">
      <div className="ms-lp-head">
        <div className="ms-lp-titles"><h2>{l.renderTitle}</h2><span className="ms-lp-sub">{l.renderSub({ formats: [...new Set(plan.flatMap(([, f]) => f.map(labelOf)))].join(', ') })}</span></div>
        <Button variant="ghost" icon aria-label={t.common.close} onClick={onClose}><Icon name="close" size={13} strokeWidth={1.6} /></Button>
      </div>
      <div role="group" aria-label={l.renderLanguages} className="ms-rl-list">
        <label className="ms-lp-format">
          <Check on={withPrimary} label={l.renderOriginal({ language: localeName(locales.primary, ui) })} disabled={busy} onChange={(v) => setOn((s) => ({ ...s, [locales.primary]: v }))} />
          <span>{l.renderOriginal({ language: localeName(locales.primary, ui) })}</span>
        </label>
        {locales.extra.map((tag) => {
          const ok = hasAll(tag);
          return (
            <label key={tag} className="ms-lp-format">
              <Check on={ok && Boolean(on[tag])} label={localeName(tag, ui)} disabled={busy || !ok} onChange={(v) => setOn((s) => ({ ...s, [tag]: v }))} />
              <span>{localeName(tag, ui)}</span>
              {!ok ? <span className="ms-lp-muted">{l.statusNone}</span> : null}
            </label>
          );
        })}
      </div>
      {refused ? (
        <div className="ms-rl-refused" role="alert" aria-labelledby={listId}>
          <b id={listId}>{l.needsForceTitle}</b>
          <ul>{refused.list.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      ) : null}
      {error ? <p role="alert" className="ms-lp-error">{error}</p> : null}
      <div className="ms-lp-foot">
        <Button variant="ghost" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
        {refused ? (
          <Button variant="ink" loading={busy} onClick={() => void run(true)}>{l.renderAnyway}</Button>
        ) : (
          <Button variant="ink" loading={busy} disabled={busy || (!withPrimary && chosen.length === 0)} onClick={() => void run(false)}>{l.renderAction}</Button>
        )}
      </div>
    </div>
  );
}
