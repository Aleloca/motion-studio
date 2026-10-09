import type { BrandChange, BrandColor, BrandField, BrandFont, BrandKit, BrandLogo, BrandNote, BrandProposal, BrandSource, SourceRef } from '@motion-studio/shared';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { useT } from '../i18n.tsx';
import { Button, Check, cx, Empty, Icon, Markdown, Modal, Tag, toast } from '../ui/index.ts';
import { specimenFamily, useFontPreview } from './brandFonts.ts';
import { hostOf, stageColor, websiteHosts } from './brandModel.ts';
import './brand.css';
import { message } from './common.tsx';

type GroupId = BrandField | 'guidelines';
const GROUPS: GroupId[] = ['colors', 'fonts', 'logos', 'tone', 'dos', 'donts', 'photoStyle', 'guidelines'];
/** The guidelines are one more item of the sheet (applied with `applyGuidelines`, not by change id). */
const GUIDELINES = '__guidelines';
const shown = (c: BrandChange) => (c.op === 'remove' ? c.before : c.after);

/** What an Apply did, so the page can undo exactly that (as an inverse on the kit as it is then, never a snapshot). */
export interface AppliedProposal {
  proposalId: string;
  /** The kit the server returned. */
  kit: BrandKit;
  /** The accepted changes. */
  changes: BrandChange[];
  /** Set when the guidelines were replaced. */
  guidelines: { before: string; after: string } | null;
}

export interface BrandReviewProps {
  open: boolean;
  slug: string;
  proposal: BrandProposal;
  /** The current kit and guidelines: the palette for the logo stages, the guidelines Undo can put back. */
  kit: BrandKit;
  guidelines: string;
  sources: BrandSource[];
  onClose(): void;
  /** The proposal was applied: the page adopts the new kit (rebasing unsaved edits) and reloads. */
  onApplied(a: AppliedProposal): void;
  /** Undo from the toast: the page reverts the applied changes through its saver. */
  onUndo(a: AppliedProposal): void;
  /** The proposal was discarded: reload. */
  onChanged(): void;
}

/**
 * Brand proposal review (spec §6.2 #9, point 11), ported from the prototype's BrandReview and the BrandReview boards:
 * a near-fullscreen sheet with the groups and their counters on the left and real previews on the right (swatches,
 * font specimens from the downloaded file, logo images), selection per item and per group, "Apply N of M" and
 * "Discard all".
 */
export function BrandReview(props: BrandReviewProps) {
  const t = useT();
  return (
    <Modal open={props.open} onClose={props.onClose} label={t.web.brandReview.dialog} width={1140}>
      <ReviewBody key={props.proposal.id} {...props} />
    </Modal>
  );
}

function ReviewBody({ slug, proposal, kit, guidelines, sources, onClose, onApplied, onUndo, onChanged }: BrandReviewProps) {
  const t = useT();
  const r = t.web.brandReview;
  const all = useMemo(() => [...proposal.changes.map((c) => c.id), ...(proposal.guidelines ? [GUIDELINES] : [])], [proposal]);
  const [on, setOn] = useState<Set<string>>(() => new Set(all));
  const [busy, setBusy] = useState<'apply' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<GroupId | null>(null);
  const [confirming, setConfirming] = useState(false);

  const idsOf = (g: GroupId) => (g === 'guidelines' ? (proposal.guidelines ? [GUIDELINES] : []) : proposal.changes.filter((c) => c.field === g).map((c) => c.id));
  const groups = GROUPS.filter((g) => idsOf(g).length > 0);
  const n = all.filter((id) => on.has(id)).length;
  const toggle = (id: string, value: boolean) => setOn((s) => { const next = new Set(s); if (value) next.add(id); else next.delete(id); return next; });
  const setGroup = (g: GroupId, value: boolean) => setOn((s) => { const next = new Set(s); for (const id of idsOf(g)) { if (value) next.add(id); else next.delete(id); } return next; });
  const hosts = websiteHosts(sources, proposal.sourceIds);
  const palette = [...kit.colors, ...proposal.changes.filter((c) => c.field === 'colors' && c.after).map((c) => c.after as BrandColor)];

  const apply = async () => {
    setBusy('apply'); setError(null);
    const useGuidelines = on.has(GUIDELINES);
    const accepted = proposal.changes.filter((c) => on.has(c.id));
    try {
      const res = await api.applyProposal(slug, proposal.id, accepted.map((c) => c.id), useGuidelines);
      const applied: AppliedProposal = {
        proposalId: proposal.id, kit: res.kit, changes: accepted,
        guidelines: useGuidelines && proposal.guidelines ? { before: guidelines, after: proposal.guidelines.proposed } : null,
      };
      onApplied(applied);
      onClose();
      // Undo: the API keeps the proposal applied; the page reverts exactly these changes on the kit as it is then.
      toast.show(r.applied({ count: n }), { tone: 'ok', action: { label: r.undo, run: () => onUndo(applied) } });
    } catch (e) { setError(message(e)); } finally { setBusy(null); }
  };
  const discard = async () => {
    setBusy('discard'); setError(null);
    try {
      await api.discardProposal(slug, proposal.id);
      onClose();
      onChanged();
      toast.show(r.discarded);
    } catch (e) { setError(message(e)); } finally { setBusy(null); }
  };
  const goTo = (g: GroupId) => {
    setCurrent(g);
    document.querySelector(`[data-rg="${g}"]`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="ms-review">
      <header className="ms-review-head">
        <span className="ms-bready-icon ms-big" aria-hidden="true"><Icon name="sparkle" size={18} /></span>
        <div className="ms-review-title">
          <h2>{r.title({ hosts: hosts.length ? hosts.join(', ') : r.yourSources })}</h2>
          <span className="ms-muted">{r.sub({ count: all.length })}</span>
        </div>
        <Button variant="ghost" icon aria-label={r.close} className="ms-review-close" onClick={onClose}><Icon name="close" size={12} strokeWidth={1.6} /></Button>
      </header>
      {all.length === 0 ? (
        <div className="ms-review-nothing"><Empty icon="check" title={r.nothing} sub={r.nothingSub} /></div>
      ) : (
        <div className="ms-review-main">
          <nav className="ms-review-nav" aria-label={r.groupsLabel}>
            {groups.map((g) => {
              const ids = idsOf(g);
              const k = ids.filter((id) => on.has(id)).length;
              return (
                <button key={g} type="button" className={cx('ms-review-group', current === g && 'ms-on')} onClick={() => goTo(g)}>
                  <GroupGlyph g={g} proposal={proposal} slug={slug} />
                  <span className="ms-grow ms-ell">{r.groups[g]}</span>
                  <span className={cx('ms-review-count', k > 0 && k < ids.length && 'ms-partial')}>{`${k}/${ids.length}`}</span>
                </button>
              );
            })}
            {proposal.assetsAdded.length ? <><div className="ms-review-sep" /><span className="ms-review-assets">{r.assetsAdded({ count: proposal.assetsAdded.length })}</span></> : null}
          </nav>
          <div className="ms-review-list">
            {proposal.summary.trim() ? <p className="ms-review-summary">{proposal.summary}</p> : null}
            {groups.map((g) => {
              const ids = idsOf(g);
              const k = ids.filter((id) => on.has(id)).length;
              return (
                <Group key={g} g={g} title={r.groups[g]} note={r.selected({ n: k, m: ids.length })} allOn={k === ids.length} onAll={(v) => setGroup(g, v)}>
                  {g === 'guidelines' ? (
                    <GuidelinesCard proposed={proposal.guidelines!.proposed} replaces={Boolean(proposal.guidelines!.current.trim())} on={on.has(GUIDELINES)} onToggle={(v) => toggle(GUIDELINES, v)} />
                  ) : (
                    <div className={cx('ms-review-grid', `ms-g-${g}`)}>
                      {proposal.changes.filter((c) => c.field === g).map((c) => (
                        <ChangeCard key={c.id} c={c} slug={slug} palette={palette} on={on.has(c.id)} onToggle={(v) => toggle(c.id, v)} />
                      ))}
                    </div>
                  )}
                </Group>
              );
            })}
          </div>
        </div>
      )}
      <footer className="ms-review-foot">
        {error ? <span className="ms-bwarn" role="alert">{error}</span> : confirming ? null : <span className="ms-muted ms-bsmall-text">{r.footnote}</span>}
        <div className="ms-grow" />
        {all.length === 0 ? (
          <Button variant="ink" size="lg" loading={busy === 'discard'} onClick={() => void discard()}>{r.close}</Button>
        ) : confirming ? (
          <span className="ms-review-confirm" role="group" aria-label={r.discardAll}>
            <span className="ms-bwarn">{r.confirmDiscard({ count: all.length })}</span>
            <Button variant="ghost" size="lg" disabled={busy !== null} onClick={() => setConfirming(false)}>{r.keepReviewing}</Button>
            <Button variant="danger" size="lg" loading={busy === 'discard'} autoFocus onClick={() => void discard()}>{r.discardAll}</Button>
          </span>
        ) : (
          <>
            <Button variant="ghost" size="lg" disabled={busy !== null} onClick={() => setConfirming(true)}>{r.discardAll}</Button>
            <Button variant="ink" size="lg" loading={busy === 'apply'} disabled={n === 0 || busy !== null} onClick={() => void apply()}>{r.apply({ n, m: all.length })}</Button>
          </>
        )}
      </footer>
    </div>
  );
}

function Group({ g, title, note, allOn, onAll, children }: { g: GroupId; title: string; note: string; allOn: boolean; onAll(v: boolean): void; children: ReactNode }) {
  const t = useT();
  const id = useId();
  return (
    <section className="ms-review-sec" data-rg={g} aria-labelledby={id}>
      <div className="ms-review-sec-head">
        <h3 id={id}>{title}</h3>
        <span className="ms-muted ms-bsmall-text">{note}</span>
        <button type="button" className="ms-blink-btn ms-bpush" onClick={() => onAll(!allOn)}>{allOn ? t.web.brandReview.deselectAll : t.web.brandReview.selectAll}</button>
      </div>
      {children}
    </section>
  );
}

function GroupGlyph({ g, proposal, slug }: { g: GroupId; proposal: BrandProposal; slug: string }) {
  if (g === 'colors') {
    const hexes = proposal.changes.filter((c) => c.field === 'colors').map((c) => (shown(c) as BrandColor | null)?.hex).filter(Boolean).slice(0, 3) as string[];
    return <span className="ms-review-dots" aria-hidden="true">{hexes.map((h, i) => <i key={`${h}${i}`} style={{ background: h }} />)}</span>;
  }
  if (g === 'logos') {
    const logo = proposal.changes.find((c) => c.field === 'logos' && c.after);
    const file = logo ? (logo.after as BrandLogo).file : null;
    return <span className="ms-review-glyph ms-thumb" aria-hidden="true">{file ? <img src={api.projectFileUrl(slug, file)} alt="" /> : null}</span>;
  }
  const glyph: Record<Exclude<GroupId, 'colors' | 'logos'>, ReactNode> = {
    fonts: 'Aa', tone: '“', dos: <Icon name="check" size={12} strokeWidth={2.2} />, donts: <Icon name="close" size={11} strokeWidth={2.2} />,
    photoStyle: <Icon name="image" size={13} />, guidelines: '¶',
  };
  return <span className={cx('ms-review-glyph', g === 'dos' && 'ms-ok', g === 'donts' && 'ms-warn')} aria-hidden="true">{glyph[g]}</span>;
}

function SourceLine({ source }: { source: SourceRef | undefined }) {
  const t = useT();
  if (!source || source.kind === 'manual' || !source.ref) return null;
  const text = source.kind === 'website' ? t.web.source.website({ host: hostOf(source.ref) }) : t.web.source.image({ name: source.ref.split('/').pop() ?? '' });
  return <span className="ms-faint ms-bsmall-text ms-ell" title={source.ref}>{text}</span>;
}

/** A selectable suggestion: the whole card toggles with the mouse; the check is the keyboard / screen reader control. */
function Pick({ on, label, onToggle, className, children }: { on: boolean; label: string; onToggle(v: boolean): void; className?: string; children: ReactNode }) {
  const t = useT();
  return (
    <div className={cx('ms-rcard', on && 'ms-on', className)} onClick={(e) => { if (!(e.target as Element).closest('a')) onToggle(!on); }}>
      {children}
      <Check on={on} label={t.web.brandReview.keep({ label })} onChange={onToggle} className="ms-rcard-check" />
    </div>
  );
}

function OpTag({ op }: { op: BrandChange['op'] }) {
  const t = useT();
  if (op === 'add') return null;
  return <Tag className={cx('ms-review-op', op === 'remove' && 'ms-remove')}>{t.web.brandReview.ops[op]}</Tag>;
}

function ChangeCard({ c, slug, palette, on, onToggle }: { c: BrandChange; slug: string; palette: BrandColor[]; on: boolean; onToggle(v: boolean): void }) {
  const t = useT();
  const r = t.web.brandReview;
  const item = shown(c) as Record<string, unknown> | null;
  if (!item) return null;
  const source = (item as { source?: SourceRef }).source;
  switch (c.field) {
    case 'colors': {
      const color = item as unknown as BrandColor;
      const before = c.op === 'update' ? (c.before as BrandColor | null) : null;
      return (
        <Pick on={on} label={color.name} onToggle={onToggle} className={cx('ms-rcolor', c.op === 'remove' && 'ms-removing')}>
          <span className="ms-rcolor-swatch">
            {before ? <i style={{ background: before.hex }} /> : null}
            <i data-testid={`swatch-${color.id}`} style={{ background: color.hex }} />
          </span>
          <span className="ms-rcard-body">
            <span className="ms-brow ms-bnowrap"><b className="ms-ell">{color.name}</b><OpTag op={c.op} /></span>
            <span className="ms-mono ms-muted">{`${color.hex.slice(1)} · ${t.web.labels.colorRoles[color.role]}`}</span>
            <SourceLine source={source} />
          </span>
        </Pick>
      );
    }
    case 'fonts': return <FontChange c={c} font={item as unknown as BrandFont} slug={slug} on={on} onToggle={onToggle} />;
    case 'logos': {
      const logo = item as unknown as BrandLogo;
      const stage = stageColor(logo.background === 'dark' ? 'dark' : 'light', palette);
      const bg = logo.background === 'light' ? t.web.brand.logos.onLight : logo.background === 'dark' ? t.web.brand.logos.onDark : t.web.brand.logos.onAny;
      return (
        <Pick on={on} label={logo.file} onToggle={onToggle} className={cx('ms-rlogo', c.op === 'remove' && 'ms-removing')}>
          <span className={cx('ms-rlogo-stage', `ms-bg-${logo.background}`)} style={stage ? { background: stage } : undefined}>
            <img src={api.projectFileUrl(slug, logo.file)} alt={t.web.brand.logos.alt({ file: logo.file })} />
          </span>
          <span className="ms-rcard-body">
            <span className="ms-brow ms-bnowrap"><b>{t.web.labels.logoVariants[logo.variant]}</b><Tag>{bg}</Tag><OpTag op={c.op} /></span>
            <span className="ms-mono ms-faint ms-ell" title={logo.file}>{logo.file}</span>
            <SourceLine source={source} />
          </span>
        </Pick>
      );
    }
    default: {
      const note = item as unknown as BrandNote;
      const before = c.op === 'update' ? (c.before as BrandNote | null) : null;
      return (
        <Pick on={on} label={c.field === 'tone' || c.field === 'photoStyle' ? r.groups[c.field] : note.text} onToggle={onToggle} className={cx('ms-rnote', c.op === 'remove' && 'ms-removing')}>
          <span className="ms-rcard-body">
            <span className={cx('ms-rnote-text', c.op === 'remove' && 'ms-struck')}>{note.text}</span>
            {before ? <span className="ms-muted ms-bsmall-text">{r.replaces({ text: before.text })}</span> : null}
            <span className="ms-brow"><OpTag op={c.op} /><SourceLine source={source} /></span>
          </span>
        </Pick>
      );
    }
  }
}

/** Point 15: the specimen uses the downloaded font file; without it, a system font and a note saying so. */
function FontChange({ c, font, slug, on, onToggle }: { c: BrandChange; font: BrandFont; slug: string; on: boolean; onToggle(v: boolean): void }) {
  const t = useT();
  const r = t.web.brandReview;
  const preview = useFontPreview(font.file ? api.projectFileUrl(slug, font.file) : null);
  const family = specimenFamily(preview);
  return (
    <Pick on={on} label={font.family} onToggle={onToggle} className={cx('ms-rfont', c.op === 'remove' && 'ms-removing')}>
      <span className="ms-rcard-body">
        <span className="ms-rfont-specimen" style={{ fontFamily: family }}>{t.web.brand.fonts.specimen}</span>
        <span className="ms-rfont-sample" style={{ fontFamily: family }}>{t.web.brand.fonts.sample}</span>
        <span className="ms-brow ms-bnowrap"><b className="ms-ell">{font.family}</b><Tag>{t.web.labels.fontRoles[font.role]}</Tag><OpTag op={c.op} /></span>
        <span className="ms-mono ms-muted">{font.weights.join(' · ')}</span>
        {preview.state === 'none' ? <span className="ms-bnote">{r.fontNoFile}</span> : null}
        {preview.state === 'failed' ? <span className="ms-bnote">{r.fontFailed}</span> : null}
        <SourceLine source={font.source} />
      </span>
    </Pick>
  );
}

function GuidelinesCard({ proposed, replaces, on, onToggle }: { proposed: string; replaces: boolean; on: boolean; onToggle(v: boolean): void }) {
  const t = useT();
  const r = t.web.brandReview;
  return (
    <Pick on={on} label={r.groups.guidelines} onToggle={onToggle} className="ms-rguide">
      <span className="ms-rcard-body">
        <span className="ms-brow"><b>{r.useGuidelines}</b>{replaces ? <Tag className="ms-review-op">{r.replacesGuidelines}</Tag> : null}</span>
        <div className="ms-rguide-doc"><Markdown text={proposed} headings /></div>
      </span>
    </Pick>
  );
}
