import type { ConversationEntry, LocaleTag } from '@motion-studio/shared';
import { useState } from 'react';
import { api } from '../api.ts';
import { saveBlob } from '../download.ts';
import { message } from '../errors.ts';
import { useLocale, useT } from '../i18n.tsx';
import { localeName } from '../screens/creative/languagesModel.ts';
import { Button, Icon, Pill } from '../ui/index.ts';

type SystemEntry = Extract<ConversationEntry, { type: 'system' }>;
const EXTS = ['srt', 'vtt'] as const;

/** A language's name inside a sentence ("inglese", "English"), as the core writes it; its tag when unknown. */
function inlineName(tag: string, ui: string): string {
  try { return new Intl.DisplayNames([ui], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
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
