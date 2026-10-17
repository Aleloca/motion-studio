// SVG content of an svg clip (SVG inner editor, Task 3): the colours, texts and drawn elements inside the clip's file, edited
// without the agent. The text comes from the core, which answers only text its SVG check accepts (a base file) or that it
// staged itself (an edit), and is parsed into an XML document that never enters the page. Every change is made on a copy of
// the latest text and, 300 ms after the last one, staged through the core (`stageSvg`): on success the clip's `src` moves to
// the staged file and an `svgContent` op feeds the summary, both as one undo step; a refusal shows its reasons here and the
// `src` stays. The texts the core checked are kept in the draft by path, so an undo finds the earlier text again.
import {
  editProblemText, listColors, listElements, listTexts, parseColor, parseSvg, replaceColor, serializeSvg, setElementPaint, setHidden, setText,
  type Clip, type SvgDoc,
} from '@motion-studio/shared';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../../../api.ts';
import { message } from '../../../errors.ts';
import { useLocale, useT } from '../../../i18n.tsx';
import { Button, ColorField, Icon, cx } from '../../../ui/index.ts';
import { useEditor } from '../editorContext.ts';
import { colorGroups } from './colors.ts';
import { Section, type Ctl } from './common.tsx';

/** A burst of changes (several swatches clicked) is staged once, this long after the last. */
export const SVG_STAGE_DELAY_MS = 300;

type Counts = { colors: number; texts: number; hidden: number };
/** Changes not staged yet: the text they made from the file `src`, and how many of each kind. */
type Working = { src: string; text: string; counts: Counts };
type Failure = { text: string; reasons: string[] };

const ZERO: Counts = { colors: 0, texts: 0, hidden: 0 };
const failureOf = (err: unknown): Failure => {
  const problems = (err as { problems?: unknown }).problems;
  return { text: message(err), reasons: Array.isArray(problems) ? problems.filter((x): x is string => typeof x === 'string') : [] };
};
const less = (a: Counts, b: Counts): Counts => ({ colors: Math.max(0, a.colors - b.colors), texts: Math.max(0, a.texts - b.texts), hidden: Math.max(0, a.hidden - b.hidden) });

function Problem({ title, failure }: { title: string; failure: Failure }) {
  return (
    <div className="ms-insp-warn ms-svg-problem" role="alert">
      <p>{`${title}: ${failure.text}`}</p>
      {failure.reasons.length > 0 ? <ul className="ms-svg-reasons">{failure.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
    </div>
  );
}

/** A text of the SVG: committed on blur or Enter (Shift+Enter is a new line); Escape drops what was typed. */
function SvgTextField({ label, value, disabled, onCommit }: { label: string; value: string; disabled: boolean; onCommit(text: string): void }) {
  const [typed, setTyped] = useState<string | null>(null);
  const commit = () => {
    if (typed !== null && typed !== value) onCommit(typed);
    setTyped(null);
  };
  const key = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commit(); } else if (ev.key === 'Escape' && typed !== null) { ev.preventDefault(); ev.stopPropagation(); setTyped(null); }
  };
  const shown = typed ?? value;
  return (
    <label className={cx('ms-field', 'ms-svg-text', disabled && 'ms-off')}>
      <textarea aria-label={label} rows={Math.min(4, shown.split('\n').length)} spellCheck={false} disabled={disabled} value={shown}
        onChange={(ev) => setTyped(ev.target.value)} onKeyDown={key} onBlur={commit} />
    </label>
  );
}

export function SvgContentSection({ ctl }: { ctl: Ctl }) {
  const t = useT();
  const e = t.web.editor;
  const locale = useLocale();
  const { slug, creative, draft, actions, token, stageSvg, readOnly, svgElement, selectSvgElement } = useEditor();
  const clip = ctl.clip as Extract<Clip, { type: 'svg' }>;
  const comp = draft.composition;
  const known = draft.svgTexts.get(clip.src);
  const disabled = ctl.locked || readOnly !== null;

  // The clip's text: read once per file (the core checks it), then kept in the draft.
  const [readFailure, setReadFailure] = useState<{ src: string; failure: Failure } | null>(null);
  const failedHere = readFailure?.src === clip.src ? readFailure.failure : null;
  useEffect(() => {
    if (known !== undefined || !token || failedHere) return;
    let alive = true;
    const src = clip.src;
    api.getEditorSvg(slug, creative, token, src).then(
      (r) => { if (alive) actions.svgText(src, r.content); },
      (err: unknown) => { if (alive) setReadFailure({ src, failure: failureOf(err) }); },
    );
    return () => { alive = false; };
  }, [known, token, clip.src, slug, creative, actions, failedHere]);

  // Changes not staged yet, and the staging (one at a time: a burst during one is staged when it is done).
  const [working, setWorkingState] = useState<Working | null>(null);
  const workingRef = useRef<Working | null>(null);
  const setWorking = (w: Working | null) => { workingRef.current = w; setWorkingState(w); };
  const [editFailure, setEditFailure] = useState<Failure | null>(null);
  const timer = useRef(0);
  const busy = useRef(false);
  const again = useRef(false);
  const latest = useRef({ clipId: clip.id, src: clip.src, known, stageSvg, actions, locale });
  latest.current = { clipId: clip.id, src: clip.src, known, stageSvg, actions, locale };

  const flush = async (): Promise<void> => {
    window.clearTimeout(timer.current);
    timer.current = 0;
    const w = workingRef.current;
    if (!w) return;
    if (busy.current) { again.current = true; return; }
    busy.current = true;
    const L = latest.current;
    try {
      const staged = await L.stageSvg({ kind: 'svgEdit', clipId: L.clipId, baseSrc: w.src, content: w.text });
      L.actions.svgText(staged.path, w.text);
      const r = L.actions.applyAll([{ kind: 'clipMedia', clipId: L.clipId, src: staged.path }, { kind: 'svgContent', clipId: L.clipId, ...w.counts }]);
      if (!r.ok) setEditFailure({ text: editProblemText(r.problem, L.locale), reasons: [] });
      const now = workingRef.current;
      // Changes made while this one was on its way go on from the staged file.
      if (now === w || !r.ok) setWorking(null);
      else if (now) setWorking({ src: staged.path, text: now.text, counts: less(now.counts, w.counts) });
    } catch (err) {
      setWorking(null);
      setEditFailure(failureOf(err));
    } finally {
      busy.current = false;
    }
    if (again.current) { again.current = false; await flush(); }
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  // Leaving the clip (another selection) stages what is pending at once.
  useEffect(() => () => { if (timer.current) void flushRef.current(); }, []);
  // An undo or a replaced file moved the clip off the file the pending changes started from: they are dropped.
  useEffect(() => {
    const w = workingRef.current;
    if (w && w.src !== clip.src && !busy.current) { window.clearTimeout(timer.current); timer.current = 0; setWorking(null); }
  }, [clip.src]); // eslint-disable-line react-hooks/exhaustive-deps

  /** One change: applied to a copy of the latest text, staged after the delay. */
  const edit = (kind: keyof Counts, change: (doc: SvgDoc) => void) => {
    if (disabled) return;
    const w = workingRef.current;
    const from = w ? w.text : latest.current.known;
    if (from === undefined) return;
    const parsed = parseSvg(from);
    if (!parsed.ok) return;
    try { change(parsed.doc); } catch { return; }
    const text = serializeSvg(parsed.doc);
    if (text === from) return;
    const counts = { ...(w?.counts ?? ZERO) };
    counts[kind] += 1;
    setWorking({ src: w?.src ?? clip.src, text, counts });
    setEditFailure(null);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void flushRef.current(); }, SVG_STAGE_DELAY_MS);
  };

  const shown = working && working.src === clip.src ? working.text : known;
  const parsed = useMemo(() => (shown !== undefined ? parseSvg(shown) : null), [shown]);
  const doc = parsed?.ok ? parsed.doc : null;
  const colors = useMemo(() => (doc ? listColors(doc) : []), [doc]);
  const texts = useMemo(() => (doc ? listTexts(doc) : []), [doc]);
  const elements = useMemo(() => (doc ? listElements(doc) : []), [doc]);
  const [openColor, setOpenColor] = useState<string | null>(null);
  const picked = elements.find((x) => x.path === svgElement) ?? null;
  const nameOf = (el: (typeof elements)[number]) => (el.named ? el.label : e.svgElementName({ tag: el.tag, n: el.index }));
  const groups = colorGroups(e, ctl);
  // The other versions of an identity logo (the hidden `small` and `dark` clips) keep their own colours.
  const versions = comp.duration === 0 && comp.tracks.some((tr) => tr.clips.some((k) => k.type === 'svg' && (k.id === 'small' || k.id === 'dark') && k.id !== clip.id));

  const recolour = (from: string, to: string) => {
    edit('colors', (d) => { replaceColor(d, from, to); });
    setOpenColor(parseColor(to) ?? null);
  };

  let body;
  if (failedHere) body = <Problem title={e.svgCannot} failure={failedHere} />;
  else if (shown === undefined) body = <p className="ms-insp-note" role="status">{e.svgLoading}</p>;
  else if (!doc) body = <Problem title={e.svgCannot} failure={{ text: parsed && !parsed.ok ? parsed.reason : '', reasons: [] }} />;
  else {
    body = (
      <>
        {editFailure ? <Problem title={e.svgRefused} failure={editFailure} /> : null}
        <div className="ms-svg-part">
          <span className="ms-insp-cap">{e.svgColors}</span>
          {colors.length === 0 ? <p className="ms-insp-note">{e.svgNoColors}</p> : (
            <ul className="ms-svg-colors" aria-label={e.svgColors}>
              {colors.map((c) => (
                <li key={c.hex}>
                  <button type="button" className={cx('ms-svg-color', openColor === c.hex && 'ms-on')} aria-pressed={openColor === c.hex} disabled={disabled}
                    aria-label={e.svgColorCount({ hex: c.hex, n: c.count })} title={e.svgColorCount({ hex: c.hex, n: c.count })}
                    onClick={() => setOpenColor((o) => (o === c.hex ? null : c.hex))}>
                    <span className="ms-svg-swatch" aria-hidden="true" style={{ background: c.hex }} />
                    <span className="ms-svg-hex">{c.hex}</span>
                    <span className="ms-svg-count" aria-hidden="true">{`×${c.count}`}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {openColor !== null && colors.some((c) => c.hex === openColor) ? (
            <ColorField key={openColor} label={e.svgColorNew({ hex: openColor })} value={openColor} disabled={disabled} groups={groups}
              onChange={(hex) => recolour(openColor, hex)} />
          ) : null}
        </div>
        <div className="ms-svg-part">
          <span className="ms-insp-cap">{e.svgTexts}</span>
          {texts.length === 0 ? <p className="ms-insp-note">{e.svgNoTexts}</p> : (
            <>
              {texts.map((x, i) => (
                <SvgTextField key={x.path} label={e.svgText({ n: i + 1 })} value={x.text} disabled={disabled} onCommit={(v) => edit('texts', (d) => setText(d, x.path, v))} />
              ))}
              <p className="ms-insp-note">{e.svgTextFonts}</p>
            </>
          )}
        </div>
        <div className="ms-svg-part">
          <span className="ms-insp-cap">{e.svgElements}</span>
          {elements.length === 0 ? <p className="ms-insp-note">{e.svgNoElements}</p> : (
            <ul className="ms-svg-elements" aria-label={e.svgElementList}>
              {elements.map((el) => {
                const name = nameOf(el);
                const eye = el.hidden ? e.svgShow({ name }) : e.svgHide({ name });
                return (
                  <li key={el.path} className={cx('ms-svg-el', el.hidden && 'ms-dim', svgElement === el.path && 'ms-sel')} style={{ paddingInlineStart: el.depth * 12 }}>
                    <Button size="sm" variant="ghost" icon aria-label={eye} title={eye} disabled={disabled} onClick={() => edit('hidden', (d) => setHidden(d, el.path, !el.hidden))}>
                      <Icon name={el.hidden ? 'eyeOff' : 'eye'} size={13} />
                    </Button>
                    <button type="button" className="ms-svg-el-name" aria-current={svgElement === el.path ? 'true' : undefined} title={name}
                      onClick={() => selectSvgElement(svgElement === el.path ? null : el.path)}>{name}</button>
                  </li>
                );
              })}
            </ul>
          )}
          {picked ? (
            <div className="ms-svg-paint">
              <ColorField label={e.svgFill} value={picked.fill !== undefined && parseColor(picked.fill) ? picked.fill : undefined} disabled={disabled} groups={groups}
                onChange={(hex) => edit('colors', (d) => setElementPaint(d, picked.path, { fill: hex }))} />
              <ColorField label={e.svgStroke} value={picked.stroke !== undefined && parseColor(picked.stroke) ? picked.stroke : undefined} disabled={disabled} groups={groups}
                onChange={(hex) => edit('colors', (d) => setElementPaint(d, picked.path, { stroke: hex }))} />
            </div>
          ) : null}
        </div>
      </>
    );
  }
  return (
    <Section title={e.secSvg} name="svg">
      {versions ? <p className="ms-insp-note">{e.svgOtherVersions}</p> : null}
      {readOnly !== null ? <p className="ms-insp-note" role="status">{readOnly}</p> : null}
      {body}
    </Section>
  );
}
