import type { ConversationEntry, LocaleTag } from '@motion-studio/shared';
import { useState } from 'react';
import { api } from '../api.ts';
import { saveBlob } from '../download.ts';
import { message } from '../errors.ts';
import { useLocale, useT } from '../i18n.tsx';
import { href } from '../routes.ts';
import { localeName } from '../screens/creative/languagesModel.ts';
import { Button, Icon, Pill } from '../ui/index.ts';

type SystemEntry = Extract<ConversationEntry, { type: 'system' }>;
const EXTS = ['srt', 'vtt'] as const;

/** A language's name inside a sentence ("inglese", "English"), as the core writes it; its tag when unknown. */
function inlineName(tag: string, ui: string): string {
  try { return new Intl.DisplayNames([ui], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
}

/**
 * Task 14 (spec §6.7): "Rifai i tempi": starts the retime of set `lang` (the job's outcome arrives in the chat as usual), then
 * says it started, or why it did not. Used by the chat's notice and the editor's banner.
 */
export function RetimeAction({ slug, creative, lang, className }: { slug: string; creative: string; lang: LocaleTag; className?: string }) {
  const s = useT().subtitles;
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'started' } | { kind: 'error'; text: string }>({ kind: 'idle' });
  const retime = async () => {
    setState({ kind: 'busy' });
    try {
      await api.startSubtitles(slug, creative, { mode: 'retime', lang });
      setState({ kind: 'started' });
    } catch (e) { setState({ kind: 'error', text: s.retimeFailed({ detail: message(e) }) }); }
  };
  return (
    <>
      <Button size="sm" variant="outline" disabled={state.kind === 'busy' || state.kind === 'started'} aria-busy={state.kind === 'busy' || undefined} onClick={() => void retime()}>
        <Icon name="refresh" size={13} />{s.retime}
      </Button>
      {state.kind === 'started' ? <span role="status" className={className}>{s.retimeStarted}</span> : null}
      {state.kind === 'error' ? <span role="alert" className={className}>{state.text}</span> : null}
    </>
  );
}

/**
 * Decision 1640 (spec §6.2): a subtitles job's outcome in the chat. Ready: "Sottotitoli pronti", the set's language and its
 * `.srt` / `.vtt` downloads (fetched with the UI token, then saved: a plain link to the route would be refused); spoken in
 * another language than the brief's, the note that says so. No speech, an unsupported language or a failure: the core's own
 * line (a failure with its reason), at its level.
 */
export function SubtitlesReadyCard({ slug, creative, entry }: { slug: string; creative: string; entry: SystemEntry }) {
  const t = useT();
  const locale = useLocale();
  const [busy, setBusy] = useState<'srt' | 'vtt' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = entry.subtitles;
  const lang = s?.lang;
  if (s?.state === 'timing-changed' && lang) {
    // Task 14: a new version moved the audio under the set: "Rifai i tempi", or the editor to check the lines by hand.
    return (
      <div className="ms-convo-version ms-convo-subtitles" role="group" aria-label={t.subtitles.timingChanged}>
        <Icon name="warn" size={14} className="ms-convo-subtitles-warn" />
        <b>{t.subtitles.timingChanged}</b>
        <Pill>{localeName(lang, locale)}</Pill>
        <span className="ms-grow" />
        <a className="ms-btn ms-sm ms-outline" href={href.subtitles(slug, creative, lang)}>{t.subtitles.openEditor}</a>
        <RetimeAction slug={slug} creative={creative} lang={lang} className="ms-convo-version-summary" />
      </div>
    );
  }
  if (s?.state !== 'ready' || !lang) {
    if (entry.level === 'error') return <p role="alert" className="ms-convo-system ms-error">{entry.text}</p>;
    if (entry.level === 'warning') return <p className="ms-convo-system ms-warning"><Icon name="warn" size={13} /><span>{entry.text}</span></p>;
    return <p className="ms-convo-system">{entry.text}</p>;
  }
  const download = async (ext: 'srt' | 'vtt', tag: LocaleTag) => {
    setBusy(ext);
    setError(null);
    try { saveBlob(await api.subtitleFile(slug, creative, tag, ext), `${creative}.${tag}.${ext}`); }
    catch (e) { setError(t.subtitles.downloadFailed({ detail: message(e) })); }
    finally { setBusy(null); }
  };
  return (
    <div className="ms-convo-version ms-convo-subtitles" role="group" aria-label={t.subtitles.readyTitle}>
      <Icon name="check" size={14} className="ms-convo-subtitles-mark" />
      <b>{t.subtitles.readyTitle}</b>
      <Pill>{localeName(lang, locale)}</Pill>
      <span className="ms-grow" />
      <a className="ms-btn ms-sm ms-outline" href={href.subtitles(slug, creative, lang)}>{t.subtitles.openEditor}</a>
      {EXTS.map((ext) => (
        <Button key={ext} size="sm" variant="outline" disabled={busy !== null} aria-busy={busy === ext || undefined}
          aria-label={t.subtitles.download({ ext: `.${ext}` })} onClick={() => void download(ext, lang)}>
          <Icon name="download" size={13} />.{ext}
        </Button>
      ))}
      {s.briefLang && s.briefLang !== lang ? (
        <span className="ms-convo-version-summary">{t.subtitles.readyOtherLang({ lang: inlineName(lang, locale), brief: inlineName(s.briefLang, locale) })}</span>
      ) : null}
      {error ? <span className="ms-convo-version-summary ms-convo-error" role="alert">{error}</span> : null}
    </div>
  );
}
