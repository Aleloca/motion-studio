// SVG content of an svg clip (SVG inner editor, Task 3): the colours and texts inside the clip's file, edited without the
// agent; the elements are children of the layer in the Layers panel and one of them, chosen there or on the stage, has an
// inspector of its own (`SvgElementSection`, user test items 12 to 14). The reading and the staging of the edits are the
// clip's session (svgSessions.tsx), shared with the layers tree. In a video (no Layers panel) the section lists the elements
// as links to their inspector.
import { parseColor, replaceColor, setElementPaint, setHidden, setText, type Clip, type SvgElement } from '@motion-studio/shared';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { useT } from '../../../i18n.tsx';
import { Button, ColorField, Icon, Toggle, cx } from '../../../ui/index.ts';
import { useEditor } from '../editorContext.ts';
import { useSvgSession, type SvgFailure } from '../svgSessions.tsx';
import { colorGroups } from './colors.ts';
import { PaintFields } from './PaintFields.tsx';
import { Section, type Ctl } from './common.tsx';

export { SVG_STAGE_DELAY_MS } from '../svgSessions.tsx';

type T = ReturnType<typeof useT>['web']['editor'];
/** The name the editor shows for an element of an SVG: its own (`id`, `<title>`), else its kind and place, translated. */
export const svgElementName = (el: SvgElement, e: Pick<T, 'svgElementName'>): string => (el.named ? el.label : e.svgElementName({ tag: el.tag, n: el.index }));

export function Problem({ title, failure }: { title: string; failure: SvgFailure }) {
  return (
    <div className="ms-insp-warn ms-svg-problem" role="alert">
      <p>{`${title}: ${failure.text}`}</p>
      {failure.reasons.length > 0 ? <ul className="ms-svg-reasons">{failure.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
    </div>
  );
}

/** A text of the SVG: committed on blur or Enter (Shift+Enter is a new line); Escape drops what was typed. */
export function SvgTextField({ label, value, disabled, onCommit }: { label: string; value: string; disabled: boolean; onCommit(text: string): void }) {
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
  const { draft, readOnly, selectSvgElement } = useEditor();
  const clip = ctl.clip as Extract<Clip, { type: 'svg' }>;
  const comp = draft.composition;
  const session = useSvgSession(clip.id);
  const [openColor, setOpenColor] = useState<string | null>(null);
  // The colour field is a new one only when another entry is chosen: a change (which renames the entry) keeps it, focus included.
  const [openKey, setOpenKey] = useState(0);
  const groups = colorGroups(e, ctl);
  // The other versions of an identity logo (the hidden `small` and `dark` clips) keep their own colours.
  const versions = comp.duration === 0 && comp.tracks.some((tr) => tr.clips.some((k) => k.type === 'svg' && (k.id === 'small' || k.id === 'dark') && k.id !== clip.id));
  const video = comp.duration > 0;
  // The open colour goes when the content no longer has it (an undo); a change's own new colour arrives with the session's
  // next content, so the field is kept until then (and keeps its focus).
  const doc = session?.doc ?? null;
  useEffect(() => {
    if (doc && openColor !== null && !session!.colors.some((c) => c.hex === openColor)) setOpenColor(null);
  }, [doc]); // eslint-disable-line react-hooks/exhaustive-deps

  let body;
  if (!session || session.status === 'loading') body = <p className="ms-insp-note" role="status">{e.svgLoading}</p>;
  else if (session.status === 'failed') body = <Problem title={e.svgCannot} failure={session.failure!} />;
  else {
    const { colors, texts, elements, disabled, edit } = session;
    const recolour = (from: string, to: string) => {
      edit('colors', (d) => { replaceColor(d, from, to); });
      setOpenColor(parseColor(to) ?? null);
    };
    body = (
      <>
        {session.editFailure ? <Problem title={e.svgRefused} failure={session.editFailure} /> : null}
        <div className="ms-svg-part">
          <span className="ms-insp-cap">{e.svgColors}</span>
          {colors.length === 0 ? <p className="ms-insp-note">{e.svgNoColors}</p> : (
            <ul className="ms-svg-colors" aria-label={e.svgColors}>
              {colors.map((c) => (
                <li key={c.hex}>
                  <button type="button" className={cx('ms-svg-color', openColor === c.hex && 'ms-on')} aria-pressed={openColor === c.hex} disabled={disabled}
                    aria-label={e.svgColorCount({ hex: c.hex, n: c.count })} title={e.svgColorCount({ hex: c.hex, n: c.count })}
                    onClick={() => { setOpenKey((k) => k + 1); setOpenColor((o) => (o === c.hex ? null : c.hex)); }}>
                    <span className="ms-svg-swatch" aria-hidden="true" style={{ background: c.hex }} />
                    <span className="ms-svg-hex">{c.hex}</span>
                    <span className="ms-svg-count" aria-hidden="true">{`×${c.count}`}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {openColor !== null ? (
            <ColorField key={openKey} label={e.svgColorNew({ hex: openColor })} value={openColor} disabled={disabled} groups={groups}
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
        {video ? (
          <div className="ms-svg-part">
            <span className="ms-insp-cap">{e.svgElements}</span>
            {elements.length === 0 ? <p className="ms-insp-note">{e.svgNoElements}</p> : (
              <ul className="ms-svg-elements" aria-label={e.svgElementList}>
                {elements.map((el) => {
                  const name = svgElementName(el, e);
                  return (
                    <li key={el.path} className={cx('ms-svg-el', el.hidden && 'ms-dim')} style={{ paddingInlineStart: el.depth * 12 }}>
                      <button type="button" className="ms-svg-el-name" title={name} onClick={() => selectSvgElement(el.path, clip.id)}>{name}</button>
                      <Icon name="forward" size={12} className="ms-svg-el-go" />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
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

/**
 * One element of an svg clip (user test items 12 to 14): its visibility, its text when it is one, its fill and stroke, and
 * "Ask the agent to change it" (a comment bound to the clip and the element). An SVG without any text says that its
 * lettering is drawn as shapes, so the words are the agent's to change.
 */
export function SvgElementSection({ ctl, element }: { ctl: Ctl; element: SvgElement }) {
  const t = useT();
  const e = t.web.editor;
  const { readOnly, askElement } = useEditor();
  const clip = ctl.clip as Extract<Clip, { type: 'svg' }>;
  const session = useSvgSession(clip.id)!;
  const { texts, disabled, edit } = session;
  const name = svgElementName(element, e);
  const text = element.tag === 'text' ? texts.find((x) => x.path === element.path) ?? null : null;
  const groups = colorGroups(e, ctl);
  return (
    <Section title={e.secSvgElement} name="svg-element">
      {readOnly !== null ? <p className="ms-insp-note" role="status">{readOnly}</p> : null}
      {session.editFailure ? <Problem title={e.svgRefused} failure={session.editFailure} /> : null}
      <div className="ms-insp-lab ms-svg-visible">
        <span className="ms-insp-cap" aria-hidden="true">{e.svgVisible}</span>
        <Toggle size="sm" label={e.svgVisible} on={!element.hidden} disabled={disabled} onChange={(on) => edit('hidden', (d) => setHidden(d, element.path, !on))} />
      </div>
      {text ? <SvgTextField label={e.svgText({ n: texts.indexOf(text) + 1 })} value={text.text} disabled={disabled} onCommit={(v) => edit('texts', (d) => setText(d, text.path, v))} /> : null}
      <PaintFields fill={element.fill} stroke={element.stroke} groups={groups} disabled={disabled}
        onChange={(prop, value) => edit('colors', (d) => setElementPaint(d, element.path, { [prop]: value }))} />
      <div className="ms-svg-ask">
        {texts.length === 0 && element.tag !== 'text' ? <p className="ms-insp-note" role="note">{e.svgOutlined}</p> : null}
        {askElement ? (
          <Button size="sm" variant="outline" className="ms-insp-ask" title={e.svgAskElementTip({ name })}
            disabled={readOnly !== null} onClick={() => askElement(clip.id, { path: element.path, name })}>
            <Icon name="comment" size={13} />{e.svgAskElement}
          </Button>
        ) : null}
      </div>
    </Section>
  );
}
