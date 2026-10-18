// "Selezione finale" (Phase 15, spec §5; decision 973): the page's main action opens a real chooser. For each format of the
// group, the summary of what the group export takes ("Formato · Variante B · v3", or "· regola predefinita"), then the variants
// side by side with their pictures: a click makes that variant the format's pick (the same group ★ as the cards' "Scegli"), a
// click on the chosen one goes back to the default rule. The summary rows are the core's group export plan (final wave I1);
// `rows` is null while it is read.
import type { OutputFileInfo, VariantLetter } from '@motion-studio/shared';
import { useT } from '../../i18n.tsx';
import { Icon, Modal, cx } from '../../ui/index.ts';
import { posterOf, useStoryboard } from '../../components/compositionPreview.ts';
import { outputMedia } from '../canvasModel.ts';
import { upper, type SelectionRow } from './variantModel.ts';

/** Where a variant's picture of a format comes from: its storyboard poster (a composition) or its file. */
export interface ChooserThumb { creative: string; n: number; format: string; hash: string | null; out: OutputFileInfo | null }

export interface ChooserOption {
  letter: VariantLetter;
  slug: string;
  /** The short name of the variant (null: none). */
  name: string | null;
  /** The version its card shows for the format; null: the variant has no file of it yet. */
  n: number | null;
  /** The format follows another one in this variant: it is chosen with its primary, never alone. */
  follows: boolean;
  thumb: ChooserThumb | null;
}

export interface ChooserFormat { format: string; label: string; width: number; height: number; options: ChooserOption[] }

export function FinalSelection({ open, onClose, slug, rows, label, formats, onPick }: {
  open: boolean; onClose(): void; slug: string; rows: SelectionRow[] | null; label(format: string): string; formats: ChooserFormat[];
  onPick(memberSlug: string, format: string, n: number | null): void;
}) {
  const t = useT();
  const vg = t.web.variantGroup;
  const text = (r: SelectionRow): string => {
    const format = label(r.format);
    if (r.source === 'pick') return vg.finalPick({ format, variant: upper(r.variant), n: r.n });
    return r.variant !== null && r.n !== null ? vg.finalDefaultFrom({ format, variant: upper(r.variant), n: r.n }) : vg.finalDefault({ format });
  };
  return (
    <Modal open={open} onClose={onClose} label={vg.finalSelection} width={760}>
      <div className="ms-vfinal">
        <div className="ms-vfinal-head">
          <h2>{vg.finalSelection}</h2>
          <button type="button" className="ms-vfinal-close" aria-label={t.common.close} onClick={onClose}><Icon name="close" size={14} /></button>
        </div>
        <p className="ms-vfinal-hint">{vg.chooserHint}</p>
        {rows === null ? <p className="ms-vfinal-empty" role="status">{t.web.exportUi.groupLoading}</p> : rows.length === 0 ? <p className="ms-vfinal-empty">{vg.finalEmpty}</p> : (
          <ul className="ms-vfinal-list" aria-label={vg.finalSelection}>
            {rows.map((r) => {
              const f = formats.find((x) => x.format === r.format);
              return (
                <li key={r.format} className="ms-vfinal-format">
                  <p className="ms-vfinal-row" data-source={r.source}>{text(r)}</p>
                  {f && f.options.length ? (
                    <div className="ms-vfinal-options" role="group" aria-label={f.label}>
                      {f.options.map((o) => {
                        const current = r.variant === o.letter;
                        const picked = current && r.source === 'pick';
                        const name = vg.chooserPick({ format: f.label, variant: upper(o.letter), n: o.n ?? 0 });
                        return (
                          <button key={o.letter} type="button" className={cx('ms-vfinal-option', current && 'ms-current', picked && 'ms-on')} aria-pressed={picked}
                            aria-label={name} title={name} disabled={o.n === null || o.follows}
                            onClick={() => { if (o.n !== null) onPick(o.slug, r.format, picked ? null : o.n); }}>
                            <Thumb slug={slug} thumb={o.thumb} width={f.width} height={f.height} />
                            <span className="ms-vfinal-name"><span className="ms-vcard-letter">{upper(o.letter)}</span><span className="ms-vfinal-dir">{o.name ?? vg.letterLabel({ letter: upper(o.letter) })}</span></span>
                            <span className="ms-vfinal-meta">
                              {o.n !== null ? <span className="ms-vbadge">v{o.n}</span> : null}
                              {picked ? <span className="ms-vfinal-tag ms-on"><Icon name="star" size={11} fill />{vg.chosen}</span>
                                : current ? <span className="ms-vfinal-tag">{vg.chooserDefaultTag}</span> : null}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : <p className="ms-vfinal-empty">{vg.chooserNone}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}

/** The height of the chooser's pictures (a wide format is narrower than its tile: lower). */
const THUMB_H = 140;

/** A variant's picture of the format, in its own proportions (never cropped): the storyboard poster, else the file's picture. */
function Thumb({ slug, thumb, width, height }: { slug: string; thumb: ChooserThumb | null; width: number; height: number }) {
  const { storyboard } = useStoryboard({ slug, creative: thumb?.creative ?? '', n: thumb?.n ?? null, format: thumb?.format ?? '', hash: thumb?.hash ?? null, enabled: Boolean(thumb?.hash) });
  const poster = posterOf(storyboard);
  const media = poster ? { src: poster.url, video: false } : thumb?.out ? outputMedia(slug, thumb.creative, thumb.n, thumb.out) : null;
  return (
    <span className="ms-vfinal-thumb" aria-hidden="true">
      <span className="ms-vfinal-pic" style={{ aspectRatio: `${width} / ${height}`, width: `min(100%, ${Math.round((THUMB_H * width) / height)}px)` }}>
        {media ? (media.video ? <video src={media.src} muted playsInline preload="metadata" /> : <img src={media.src} alt="" draggable={false} />) : null}
      </span>
    </span>
  );
}
