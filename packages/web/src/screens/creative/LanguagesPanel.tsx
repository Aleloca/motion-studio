// The "Languages" panel of a creative (Phase 12, spec §3.2-3.3): for the version on screen, one row per extra language with its
// state (not translated, translated, n outdated, n problems), the voice choice (Translate, Keep original, Mute) with the reason
// when Translate is not available, the review table, and "Translate" for the chosen languages and formats. A creative with no
// languages in its brief has no panel at all. While a localize turn runs, its paid-batch confirmation is shown here too.
import type { Composition, CreativeDetail, FormatPreset, LocaleTag, LocalizationRow, VersionEntry } from '@motion-studio/shared';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../api.ts';
import { ApprovalCard } from '../../components/ApprovalCard.tsx';
import { useConfiguredProviders, useKeyChecks } from '../../components/ServicesSelector.tsx';
import type { EventsState } from '../../eventsReducer.ts';
import { message } from '../../errors.ts';
import { instanceName, presetFor } from '../../instances.ts';
import { useLocale, useT } from '../../i18n.tsx';
import { Button, Check, Icon, Modal, Pill, Segmented, cx, toast } from '../../ui/index.ts';
import { LocalizationTable } from './LocalizationTable.tsx';
import { creativeLocales, fallbackReason, localeName, reasonText, rowStatus, statusText, voiceUnavailable, type RowStatus, type VoiceReason } from './languagesModel.ts';
import './languages.css';

type VoiceMode = 'translate' | 'original' | 'muted';

export interface LanguagesPanelProps {
  open: boolean;
  onClose(): void;
  slug: string;
  creative: string;
  detail: CreativeDetail;
  /** The version on screen (the latest by default). */
  version: VersionEntry;
  presets: FormatPreset[];
  live: EventsState;
  /** The creative changed (a save): reload it. */
  onChanged?(): void;
}

export function LanguagesPanel(p: LanguagesPanelProps) {
  const t = useT();
  return (
    <Modal open={p.open} onClose={p.onClose} label={t.web.languages.title} width={880}>
      {p.open ? <PanelBody {...p} /> : null}
    </Modal>
  );
}

const sum = (list: RowStatus[]): RowStatus => {
  const rows = list.filter((s) => s.kind !== 'none');
  if (rows.length === 0) return { kind: 'none' };
  const stale = rows.reduce((n, s) => n + (s.kind === 'stale' ? s.count : s.kind === 'both' ? s.stale : 0), 0);
  const problems = rows.reduce((n, s) => n + (s.kind === 'problems' ? s.count : s.kind === 'both' ? s.problems : 0), 0);
  return stale && problems ? { kind: 'both', stale, problems } : stale ? { kind: 'stale', count: stale } : problems ? { kind: 'problems', count: problems } : { kind: 'ok' };
};

function PanelBody({ onClose, slug, creative, detail, version, presets, live, onChanged }: LanguagesPanelProps) {
  const t = useT();
  const l = t.web.languages;
  const ui = useLocale();
  const langs = creativeLocales(detail.creative.brief);
  const configured = useConfiguredProviders();
  const checks = useKeyChecks();
  const labels = detail.creative.brief.formatLabels;
  const instances = useMemo(() => (version.compositions ?? []).map((c) => c.format), [version]);
  const formatName = (id: string) => instanceName(presetFor(presets, id), id, ui, labels);
  const rows = version.localizations ?? [];
  const rowsOf = (tag: LocaleTag) => rows.filter((r) => r.locale === tag);
  const unavailable = voiceUnavailable(detail.creative.brief, configured, checks);

  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [formats, setFormats] = useState<Record<string, boolean>>({});
  const [voice, setVoice] = useState<Record<string, VoiceMode>>({});
  const [reviewing, setReviewing] = useState<{ locale: LocaleTag; instanceId: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A localize turn of this creative: it blocks edits and its confirmation card shows here.
  const jobs = Object.values(live.jobs).filter((j) => j.key === detail.jobKey && j.kind === 'localize');
  const working = jobs.some((j) => j.state === 'queued' || j.state === 'running');
  const cards = Object.values(live.approvals).filter((a) => a.projectSlug === slug && a.creativeSlug === creative);

  const modeOf = (tag: LocaleTag): VoiceMode => {
    const set = voice[tag];
    if (set) return set;
    const own = rowsOf(tag);
    const stored = own.find((r) => r.voice !== 'original')?.voice;
    if (stored === 'muted') return 'muted';
    return unavailable === null ? 'translate' : 'original';
  };

  if (!langs) return null;

  const chosen = langs.extra.filter((tag) => picked[tag] ?? true);
  const formatList = instances.filter((id) => formats[id] ?? true);
  const start = async () => {
    setStarting(true); setError(null);
    try {
      await api.localize(slug, creative, version.n, {
        locales: chosen,
        ...(formatList.length !== instances.length ? { formats: formatList } : {}),
        voice: Object.fromEntries(chosen.map((tag) => [tag, modeOf(tag)])),
      });
      toast.show(l.started({ count: chosen.length }), { tone: 'ok' });
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'locale-not-in-brief' ? l.notInBrief : message(e));
    } finally { setStarting(false); }
  };

  return (
    <div className="ms-lp">
      <div className="ms-lp-head">
        <div className="ms-lp-titles">
          <h2>{l.title}</h2>
          <span className="ms-lp-sub">{l.sub({ n: version.n, primary: localeName(langs.primary, ui) })}</span>
        </div>
        <Button variant="ghost" icon aria-label={t.common.close} onClick={onClose}><Icon name="close" size={13} strokeWidth={1.6} /></Button>
      </div>

      {instances.length === 0 ? <p className="ms-lp-note">{l.noCompositions({ n: version.n })}</p> : (
        <>
          {instances.length > 1 ? (
            <div className="ms-lp-formats" role="group" aria-label={l.formatsLabel}>
              <span className="ms-cap">{l.formatsLabel}</span>
              {instances.map((id) => (
                <label key={id} className="ms-lp-format">
                  <Check on={formats[id] ?? true} label={formatName(id)} disabled={working} onChange={(on) => setFormats((s) => ({ ...s, [id]: on }))} />
                  <span>{formatName(id)}</span>
                </label>
              ))}
            </div>
          ) : null}
          <ul className="ms-lp-list">
            {langs.extra.map((tag) => {
              const own = rowsOf(tag);
              const status = sum(instances.map((id) => rowStatus(own.find((r) => r.instanceId === id))));
              const fell = fallbackReason(own);
              const reason: VoiceReason | null = unavailable ?? null;
              const note: VoiceReason | null = reason ?? (fell === 'declined' || fell === 'failed' ? fell : null);
              const mode = modeOf(tag);
              const name = localeName(tag, ui);
              const noScript = own.flatMap((r) => r.noScript ?? []);
              const noteId = `ms-lp-voice-${tag}`;
              return (
                <li key={tag} className="ms-lp-lang" data-locale={tag}>
                  <div className="ms-lp-line">
                    <Check on={picked[tag] ?? true} label={l.pick({ language: name })} disabled={working} onChange={(on) => setPicked((s) => ({ ...s, [tag]: on }))} />
                    <b className="ms-lp-name">{name}</b>
                    <Pill tone={status.kind === 'ok' ? 'ok' : status.kind === 'none' ? 'neutral' : 'warn'}>{statusText(status, t)}</Pill>
                    <Segmented<VoiceMode> className="ms-lp-voice" label={l.voiceFor({ language: name })} value={mode} disabled={working} onChange={(m) => setVoice((s) => ({ ...s, [tag]: m }))}
                      describedBy={note ? noteId : undefined}
                      options={[
                        { value: 'translate', label: l.voiceTranslate, disabled: reason !== null, ...(reason ? { title: reasonText(reason, t) } : {}) },
                        { value: 'original', label: l.voiceOriginal },
                        { value: 'muted', label: l.voiceMuted },
                      ]} />
                  </div>
                  {note ? <p id={noteId} className="ms-lp-reason"><Icon name="warn" size={12} />{note === reason ? l.voiceUnavailable({ reason: reasonText(note, t) }) : l.voiceFellBack({ reason: reasonText(note, t) })}</p> : null}
                  {noScript.length ? <p className="ms-lp-reason"><Icon name="warn" size={12} />{l.noScriptCount({ count: noScript.length })}</p> : null}
                  <div className="ms-lp-review">
                    {instances.map((id) => {
                      const row = own.find((r) => r.instanceId === id);
                      const on = reviewing?.locale === tag && reviewing.instanceId === id;
                      return (
                        <Button key={id} size="sm" variant={on ? 'ink' : 'outline'} aria-pressed={on} disabled={!row} title={row ? undefined : l.statusNone}
                          onClick={() => setReviewing(on ? null : { locale: tag, instanceId: id })}>
                          {l.review({ format: formatName(id) })}
                        </Button>
                      );
                    })}
                  </div>
                  {reviewing?.locale === tag ? (
                    <Review slug={slug} creative={creative} version={version} locale={tag} instanceId={reviewing.instanceId} formatLabel={formatName(reviewing.instanceId)}
                      row={own.find((r) => r.instanceId === reviewing.instanceId)} voiceReason={reason} busy={working} onSaved={() => onChanged?.()} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {cards.length ? (
        <div className="ms-lp-cards" aria-label={l.confirmations}>
          {cards.map((a) => <ApprovalCard key={a.id} approval={a} />)}
        </div>
      ) : null}
      {working && cards.length === 0 ? <p className="ms-lp-note" role="status">{l.working}</p> : null}
      {error ? <p role="alert" className="ms-lp-error">{error}</p> : null}
      <div className="ms-lp-foot">
        <Button variant="ghost" onClick={onClose}>{t.common.close}</Button>
        <Button variant="ink" loading={starting} disabled={working || starting || chosen.length === 0 || formatList.length === 0 || instances.length === 0} onClick={() => void start()}>
          {l.translate({ count: chosen.length })}
        </Button>
      </div>
    </div>
  );
}

/** The review table of one translation: loads the base composition of the format. */
function Review({ slug, creative, version, locale, instanceId, formatLabel, row, voiceReason, busy, onSaved }: {
  slug: string; creative: string; version: VersionEntry; locale: LocaleTag; instanceId: string; formatLabel: string;
  row: LocalizationRow | undefined; voiceReason: VoiceReason | null; busy: boolean; onSaved(): void;
}) {
  const l = useT().web.languages;
  const [composition, setComposition] = useState<Composition | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setComposition(null); setError(null);
    Promise.resolve().then(() => api.getEditorComposition(slug, creative, version.n, instanceId))
      .then((v) => { if (alive) setComposition(v.composition); })
      .catch((e: unknown) => { if (alive) setError(message(e)); });
    return () => { alive = false; };
  }, [slug, creative, version.n, instanceId]);
  if (error) return <p role="alert" className="ms-lp-error">{error}</p>;
  if (!composition) return <p className="ms-lp-note" role="status">{l.loading}</p>;
  return (
    <div className={cx('ms-lp-table')}>
      <LocalizationTable slug={slug} creative={creative} n={version.n} locale={locale} instanceId={instanceId} formatLabel={formatLabel}
        composition={composition} row={row} voiceReason={voiceReason} busy={busy} onSaved={onSaved} />
    </div>
  );
}
