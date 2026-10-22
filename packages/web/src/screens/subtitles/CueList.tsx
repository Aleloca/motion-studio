// The subtitle editor's list of lines (Task 12, spec §6.3, layout B): each row with its start and end (`mm:ss.mmm`), its text,
// its warnings (gentle, never blocking) and its actions; "+ Riga" and find and replace above the list.
import { SUBTITLE_RULES, type CueWarning, type LocaleTag, type SubtitleCue } from '@motion-studio/shared';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useT } from '../../i18n.tsx';
import { Button, Chip, Icon, Input, Tooltip, cx } from '../../ui/index.ts';
import { NEW_CUE_TEXT, normalizeCueText, type EditorOp } from './subtitlesModel.ts';

/** `mm:ss.mmm` (minutes past 59 go on counting). */
export function msText(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  const m = Math.floor(v / 60_000);
  const s = Math.floor((v % 60_000) / 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(v % 1000).padStart(3, '0')}`;
}

/** A typed time: `mm:ss.mmm`, `m:ss`, `ss.mmm` (a comma for the point too); null when it is not one. */
export function parseMs(text: string): number | null {
  const m = /^\s*(?:(\d{1,4}):)?(\d{1,5})(?:[.,](\d{1,3}))?\s*$/.exec(text);
  if (!m) return null;
  const min = m[1] !== undefined ? Number(m[1]) : 0;
  const sec = Number(m[2]);
  if (m[1] !== undefined && sec >= 60) return null;
  const frac = m[3] !== undefined ? Number(m[3].padEnd(3, '0')) : 0;
  return min * 60_000 + sec * 1000 + frac;
}

/** The warnings of a row: the model's, and the placeholder text of a line made with "+ Riga" (it would end up in the files). */
export type RowWarning = CueWarning | 'placeholder';

/**
 * Task 26: a translated line's source: `current` (the text it was translated from), `changed` (its source line says
 * something else now: that text, "Ritraduci" offered) or `gone` (no source line under it any more: the text it came from).
 */
export interface CueSource { state: 'current' | 'changed' | 'gone'; text: string }

/** The row's element, for the screen's scrolling and focus (cue ids are `[a-z0-9-]`: nothing to escape). */
export const rowSelector = (id: string) => `[data-cue="${id}"]`;

export interface CueListProps {
  cues: SubtitleCue[];
  lang: LocaleTag;
  warnings: Map<string, CueWarning[]>;
  selected: string | null;
  /** The cue under the playhead. */
  now: string | null;
  dispatch(op: EditorOp): void;
  /** A row was clicked (or its text focused): select it and show it. */
  onPick(cue: SubtitleCue): void;
  /** Task 26, a translation: each translated line's source (greyed under its text), its language, and "Ritraduci". */
  sources?: Map<string, CueSource>;
  sourceLang?: LocaleTag | undefined;
  retranslating?: boolean;
  onRetranslate?(id: string): void;
}

export function CueList({ cues, lang, warnings, selected, now, dispatch, onPick, sources, sourceLang, retranslating, onRetranslate }: CueListProps) {
  const t = useT();
  return (
    <ol className="ms-subs-list" aria-label={t.subtitles.listLabel}>
      {cues.map((cue, i) => (
        <CueRow key={cue.id} cue={cue} n={i + 1} last={i === cues.length - 1} lang={lang} selected={cue.id === selected} now={cue.id === now}
          warnings={[...(warnings.get(cue.id) ?? []), ...(cue.text === NEW_CUE_TEXT ? ['placeholder' as const] : [])]} dispatch={dispatch} onPick={onPick}
          source={sources?.get(cue.id)} sourceLang={sourceLang} retranslating={retranslating === true} onRetranslate={onRetranslate} />
      ))}
    </ol>
  );
}

function CueRow({ cue, n, last, lang, selected, now, warnings, dispatch, onPick, source, sourceLang, retranslating, onRetranslate }: {
  cue: SubtitleCue; n: number; last: boolean; lang: LocaleTag; selected: boolean; now: boolean; warnings: RowWarning[];
  dispatch(op: EditorOp): void; onPick(cue: SubtitleCue): void;
  source: CueSource | undefined; sourceLang: LocaleTag | undefined; retranslating: boolean; onRetranslate: ((id: string) => void) | undefined;
}) {
  const t = useT();
  const s = t.subtitles;
  const box = useRef<HTMLTextAreaElement>(null);
  // What the user typed, as typed: the model keeps the text normalised (trimmed lines, no blank line), so a space or a new
  // line being typed would vanish under the caret. Dropped on blur, or when the cue's text changes from elsewhere (undo).
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    if (draft === null) return;
    const typed = normalizeCueText(draft, lang);
    // An emptied box keeps the cue's old text in the model (a cue cannot be empty) until something is typed.
    if (typed !== '' && typed !== cue.text) setDraft(null);
  }, [cue.text]); // eslint-disable-line react-hooks/exhaustive-deps

  const click = (e: MouseEvent) => {
    if ((e.target as Element).closest('button')) return;
    onPick(cue);
  };
  const split = () => {
    const el = box.current;
    const at = el ? Math.min(el.selectionStart ?? 0, cue.text.length) : 0;
    dispatch({ type: 'split', id: cue.id, at });
  };
  const hint = (w: RowWarning): string => {
    const h = s.warningHints;
    switch (w) {
      case 'tooLong': return h.tooLong({ lines: SUBTITLE_RULES.maxLines });
      case 'tooFast': return h.tooFast({ cps: SUBTITLE_RULES.maxCps });
      case 'tooShort': return h.tooShort({ seconds: SUBTITLE_RULES.minMs / 1000 });
      case 'tooLongOnScreen': return h.tooLongOnScreen({ seconds: SUBTITLE_RULES.maxMs / 1000 });
      case 'overlap': return h.overlap;
      case 'placeholder': return h.placeholder;
    }
  };
  return (
    <li className={cx('ms-subs-row', selected && 'ms-on', now && 'ms-now')} data-cue={cue.id} aria-current={selected || undefined} onClick={click}>
      <div className="ms-subs-row-head">
        <span className="ms-subs-num" aria-hidden="true">{n}</span>
        <TimeField label={s.start({ n })} value={cue.start} onCommit={(v) => dispatch({ type: 'times', id: cue.id, start: v })} />
        <span className="ms-subs-arrow" aria-hidden="true">→</span>
        <TimeField label={s.end({ n })} value={cue.end} onCommit={(v) => dispatch({ type: 'times', id: cue.id, end: v })} />
        <span className="ms-subs-row-actions">
          <Tooltip label={s.split}>
            <Button size="sm" variant="ghost" icon aria-label={s.split} onClick={split}><Icon name="scissors" size={13} /></Button>
          </Tooltip>
          <Tooltip label={s.merge}>
            <Button size="sm" variant="ghost" icon aria-label={s.merge} disabled={last} onClick={() => dispatch({ type: 'merge', id: cue.id })}><Icon name="link" size={13} /></Button>
          </Tooltip>
          <Tooltip label={s.remove}>
            <Button size="sm" variant="ghost" icon aria-label={s.remove} onClick={() => dispatch({ type: 'delete', id: cue.id })}><Icon name="trash" size={13} /></Button>
          </Tooltip>
        </span>
      </div>
      <textarea ref={box} className="ms-input ms-textarea ms-subs-text" rows={2} aria-label={s.text({ n })} spellCheck lang={lang}
        value={draft ?? cue.text}
        onChange={(e) => { setDraft(e.target.value); dispatch({ type: 'text', id: cue.id, text: e.target.value }); }}
        onFocus={() => { if (!selected) onPick(cue); }}
        onBlur={() => { setDraft(null); dispatch({ type: 'endTyping' }); }} />
      {source ? <p className={cx('ms-subs-source', source.state !== 'current' && 'ms-stale')} aria-label={s.sourceText} lang={sourceLang}>{source.text}</p> : null}
      {source && source.state !== 'current' ? (
        <div className="ms-subs-chips ms-subs-stale">
          <Chip icon="warn" className="ms-subs-warn" title={source.state === 'changed' ? s.staleHint : s.goneHint}>{source.state === 'changed' ? s.staleMark : s.goneMark}</Chip>
          {source.state === 'changed' && onRetranslate ? (
            <Button size="sm" variant="outline" disabled={retranslating} onClick={() => onRetranslate(cue.id)}><Icon name="refresh" size={12} />{s.retranslate}</Button>
          ) : null}
        </div>
      ) : null}
      {warnings.length ? (
        <div className="ms-subs-chips">
          {warnings.map((w) => <Chip key={w} icon="warn" className="ms-subs-warn" title={hint(w)}>{s.warnings[w]}</Chip>)}
        </div>
      ) : null}
    </li>
  );
}

/** A time typed as `mm:ss.mmm`: applied on Enter or when the field is left; a time that does not read goes back. */
function TimeField({ label, value, onCommit }: { label: string; value: number; onCommit(ms: number): void }) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  // The time changed from elsewhere (undo, a merge): what was being typed goes.
  useEffect(() => { setDraft(null); }, [value]);
  const commit = () => {
    if (draft === null) return;
    const ms = parseMs(draft);
    setDraft(null);
    if (ms !== null && ms !== value) onCommit(ms);
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape' && draft !== null) { e.preventDefault(); setDraft(null); }
  };
  return (
    <Input className="ms-subs-time" aria-label={label} title={t.subtitles.timeHint} inputMode="decimal" spellCheck={false}
      value={draft ?? msText(value)} aria-invalid={draft !== null && parseMs(draft) === null ? true : undefined}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={key} />
  );
}

/** Find and replace across every line (one undo step). */
export function FindReplace({ cues, dispatch }: { cues: SubtitleCue[]; dispatch(op: EditorOp): void }) {
  const t = useT();
  const s = t.subtitles;
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const needle = matchCase ? find : find.toLocaleLowerCase();
  const count = find === '' ? 0 : cues.filter((c) => (matchCase ? c.text : c.text.toLocaleLowerCase()).includes(needle)).length;
  return (
    <div className="ms-subs-find" role="search" aria-label={s.findReplace}>
      <Input aria-label={s.find} placeholder={s.find} value={find} onChange={(e) => setFind(e.target.value)} />
      <Input aria-label={s.replaceWith} placeholder={s.replaceWith} value={replace} onChange={(e) => setReplace(e.target.value)} />
      <div className="ms-subs-find-row">
        <Chip on={matchCase} onClick={() => setMatchCase((v) => !v)}>{s.matchCase}</Chip>
        <span className="ms-subs-find-count" role="status">{find === '' ? '' : s.matches({ count })}</span>
        <Button size="sm" variant="outline" disabled={count === 0}
          onClick={() => dispatch({ type: 'replace', find, with: replace, caseSensitive: matchCase })}>{s.replaceAll}</Button>
      </div>
    </div>
  );
}
