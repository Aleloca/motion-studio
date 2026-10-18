// Per-format versions (spec §3.1, prototype `VersionsPopover` and the CanvasView board header), shared by the canvas and
// the format view: the "★ v5 ▾" badge of a format with its history popover (view a version, ★ it for export, Compare,
// Restart from here, Link to …), "viewing v3", the "Linked to …" chip of a follower with Unlink, the creative's
// "Versions" timeline of the bar, and the actions behind them with their error messages.
import type { VersionEntry } from '@motion-studio/shared';
import { entryHasProblems, formatRuns, shownTotal } from '@motion-studio/shared';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { api } from '../api.ts';
import { formatDate, TIME_OF_DAY, useLocale, useT } from '../i18n.tsx';
import { pop } from '../motion/index.ts';
import { isMac } from '../platform.ts';
import { formatTokens, TokenCount } from '../shell/Tokens.tsx';
import { Button, Icon, Pill, Popover, cx, toast } from '../ui/index.ts';
import { outputMedia } from './canvasModel.ts';
import { entryAt, type FormatState } from './versionModel.ts';
import { abortableWait, errorCode, versionErrorText, withHashRetry, type VersionErrorContext } from './versionErrors.ts';
import { message } from './common.tsx';

const sameDay = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
function useWhen() {
  const locale = useLocale();
  return (iso: string) => formatDate(locale, iso, sameDay(iso) ? TIME_OF_DAY : { day: 'numeric', month: 'short', ...TIME_OF_DAY });
}

export interface VersionActions {
  /**
   * ★ version `n` of `format` for export (the version the default rule gives clears a manual pick: the core decides).
   * `done` runs once it is saved; `fail` takes the error message instead of the page (a dialog that stays open shows it).
   */
  star(format: string, n: number, opts?: { done?(): void; fail?(text: string): void }): void;
  /** Clears the manual ★ of `format`: back to the default rule ("Auto"). */
  resetStar(format: string): void;
  /** A ★ change of `format` is in flight (its retries included): its ★ buttons and "Reset to Auto" wait. */
  pending(format: string): boolean;
  link(follower: string, primary: string): void;
  unlink(follower: string): void;
  /** Restart from version `n` (the whole creative), with Undo back to the previous resume point. */
  restart(n: number): void;
  reveal(n: number): void;
}

/**
 * The version actions of a creative, with their messages: success toasts, a calm toast when the core is still hashing old
 * versions after the automatic retries, and every other refusal as a clear message through `onError` (null when one starts).
 */
export function useVersionActions({ slug, creative, states, labelOf, resumeFrom, onChanged, onError, groupPick }: {
  slug: string; creative: string; states: Record<string, FormatState>; labelOf(id: string): string; resumeFrom: number | null;
  onChanged(): void; onError(text: string | null): void;
  /** Phase 15: in a variant group the ★ is the group's (variant and version): writes it instead of the creative's own `exportPicks`. */
  groupPick?(format: string, n: number | null): Promise<unknown>;
}): VersionActions {
  const t = useT();
  const fv = t.web.formatVersions;
  const v = t.web.canvas.versions;
  // Leaving the page cancels a retry's wait and silences what is still in flight (no late toast or message).
  // One controller per mount, made and aborted by the effect (StrictMode mounts, cleans up and mounts again: a controller
  // made once at render would stay aborted). Each action takes the signal of the mount it started in.
  const life = useRef(new AbortController());
  useEffect(() => {
    const c = new AbortController();
    life.current = c;
    return () => c.abort();
  }, []);
  // Formats whose ★ change is in flight: a ref for the synchronous guard (a double click), state to re-render.
  const inFlight = useRef(new Set<string>());
  const [, setPendingTick] = useState(0);
  const setPending = (format: string, on: boolean) => {
    if (on) inFlight.current.add(format); else inFlight.current.delete(format);
    if (!life.current.signal.aborted) setPendingTick((x) => x + 1);
  };
  const run = (call: () => Promise<unknown>, ctx: VersionErrorContext, done?: () => void, pendingFormat?: string, fail: (text: string) => void = onError) => {
    if (pendingFormat !== undefined) {
      if (inFlight.current.has(pendingFormat)) return;
      setPending(pendingFormat, true);
    }
    onError(null);
    const signal = life.current.signal;
    Promise.resolve().then(() => withHashRetry(call, abortableWait(signal))).then(() => {
      if (signal.aborted) return;
      done?.();
      onChanged();
    }).catch((e: unknown) => {
      if (signal.aborted) return;
      if (errorCode(e) === 'hashes-pending') toast.show(fv.errors.hashesPending);
      else fail(versionErrorText(e, t, ctx));
    }).finally(() => { if (pendingFormat !== undefined) setPending(pendingFormat, false); });
  };
  const restore = (n: number, done: () => void) => {
    onError(null);
    // Like `run`: nothing fires once the page is gone.
    const signal = life.current.signal;
    Promise.resolve().then(() => api.restoreVersion(slug, creative, n)).then(() => {
      if (signal.aborted) return;
      onChanged(); done();
    }).catch((e: unknown) => { if (!signal.aborted) onError(v.actionFailed({ detail: message(e) })); });
  };
  return {
    star: (format, n, opts) => {
      const label = labelOf(format);
      const follows = states[format]?.follows;
      run(() => (groupPick ? groupPick(format, n) : api.setExportPick(slug, creative, format, n)), { label, n, primary: follows ? labelOf(follows) : undefined },
        () => { toast.show(fv.starToast({ n, label }), { tone: 'ok' }); opts?.done?.(); }, format, opts?.fail);
    },
    resetStar: (format) => {
      const label = labelOf(format);
      run(() => (groupPick ? groupPick(format, null) : api.setExportPick(slug, creative, format, null)), { label }, () => toast.show(fv.resetToast({ label }), { tone: 'ok' }), format);
    },
    pending: (format) => inFlight.current.has(format),
    link: (follower, primary) => {
      const label = labelOf(follower);
      const reason = states[follower]?.linkable.find((l) => l.primary === primary)?.reason;
      run(() => api.setFormatLink(slug, creative, follower, primary), { label, primary: labelOf(primary), reason },
        () => toast.show(fv.linked({ label, primary: labelOf(primary) }), { tone: 'ok' }));
    },
    unlink: (follower) => {
      const label = labelOf(follower);
      run(() => api.setFormatLink(slug, creative, follower, null), { label }, () => toast.show(fv.unlinked({ label }), { tone: 'ok' }));
    },
    restart: (n) => {
      // Undo restores exactly the previous resume point. Without one (the latest) there is nothing exact to restore (the
      // core cannot clear a resume point): no Undo; the timeline offers the latest explicitly.
      const previous = resumeFrom;
      restore(n, () => toast.show(v.restarted({ n }), {
        tone: 'ok',
        action: previous !== null && previous !== n ? { label: v.undo, run: () => restore(previous, () => {}) } : undefined,
      }));
    },
    reveal: (n) => {
      onError(null);
      Promise.resolve().then(() => api.revealVersion(slug, creative, n)).catch((e: unknown) => onError(v.actionFailed({ detail: message(e) })));
    },
  };
}

export interface FormatBadgeProps {
  slug: string;
  creative: string;
  /** Display label of the format. */
  label: string;
  state: FormatState;
  versions: VersionEntry[];
  /** The version whose file is on screen. */
  shown: number | null;
  /** The version the next change resumes from (null: the latest). */
  resumeFrom: number | null;
  labelOf(id: string): string;
  actions: VersionActions;
  /** No link changes (a generation is running). */
  busy?: boolean;
  onView(n: number): void;
  onCompare(): void;
  /**
   * Ignored (decision 974: no Render in the UI; the menu's "Render vN" is gone). Still accepted so the pages that pass it
   * keep building until they stop.
   */
  render?: { n: number; run(): void } | null;
  className?: string;
  /**
   * Phase 15, decision 1064: in a variant group the badge says "v5", never with a ★: the group's ★ beside it (or the ★ in
   * the menu's row) says whether it is the export pick, so two stars never stand side by side.
   */
  unstarred?: boolean;
  /**
   * The top bar's one version control (user report 17): a bar-sized button with the number of versions beside the
   * version ("★ v1 · 2 versioni"), the count folding away on a narrow bar.
   */
  bar?: boolean;
  /** The badge's button (the bar pops it when a new version arrives, T11). */
  buttonRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * "★ v5 ▾": the ★ version of a format, opening its history (spec §3.1). "viewing v3" follows it when another version is on
 * screen. Nothing before the format has a version.
 */
export function FormatBadge(p: FormatBadgeProps) {
  const t = useT();
  const fv = t.web.formatVersions;
  const own = useRef<HTMLButtonElement>(null);
  const anchor = p.buttonRef ?? own;
  const [open, setOpen] = useState(false);
  const star = p.state.star.version;
  if (star === null && p.state.history.length === 0) return null;
  const n = star ?? p.state.history.at(-1)!;
  return (
    <>
      <button ref={anchor} type="button" className={cx(p.bar ? 'ms-btn ms-outline ms-fvb-bar' : 'ms-vbadge ms-star', 'ms-fvb', open && 'ms-open', p.className)} aria-haspopup="dialog" aria-expanded={open}
        aria-label={fv.badge({ label: p.label, n })} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
        {p.unstarred || star === null ? '' : '★ '}v{n}
        {p.bar ? <span className="ms-fvb-count ms-bar-label" aria-hidden="true">· {fv.count({ n: p.state.history.length })}</span> : null}
        <Icon name="chevron" size={p.bar ? 11 : 10} />
      </button>
      {p.shown !== null && p.shown !== n ? <span className="ms-fvb-viewing">{fv.viewing({ n: p.shown })}</span> : null}
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-start" width={320} label={fv.title({ label: p.label })}>
        <VersionsPopover {...p} close={() => setOpen(false)} />
      </Popover>
    </>
  );
}

function VersionsPopover({ slug, creative, label, state, versions, shown, resumeFrom, labelOf, actions, busy, onView, onCompare, close }: FormatBadgeProps & { close(): void }) {
  const t = useT();
  const fv = t.web.formatVersions;
  const v = t.web.canvas.versions;
  const locale = useLocale();
  const when = useWhen();
  const latest = versions.at(-1)?.n ?? 0;
  const star = state.star.version;
  // Decision 1061: one row per content of the format: its history entry `n` and the versions up to `last` that kept it
  // (e.g. a turn that only changed the brief, before decision 1060). A v2 version without a render is a row too (its
  // composition is the version); it has no thumbnail file.
  const runs = state.history.length ? formatRuns(versions, state.id) : [];
  const rows = [...state.history].reverse().flatMap((n) => {
    const ver = versions.find((x) => x.n === n);
    const out = ver?.outputs.find((o) => o.format === state.id) ?? null;
    const last = runs.find((r) => r.n === n)?.last ?? n;
    return ver && (out || ver.compositions?.some((c) => c.format === state.id)) ? [{ ver, out, last }] : [];
  });
  const inRun = (x: number | null, n: number, last: number) => x !== null && x >= n && x <= last;
  // Restarting is offered when the file on screen is not the one the next change starts from: compared as history entries,
  // so a format carried unchanged since its last change (its file is the same in the resume version) offers none.
  const canRestart = shown !== null && shown !== entryAt(versions, state, resumeFrom ?? latest);
  const pending = actions.pending(state.id);
  const links = state.linkable.filter((l) => l.ok);
  return (
    <div className="ms-vmenu ms-fvpop">
      <div className="ms-vmenu-head">
        <b>{fv.title({ label })}</b>
        <span className="ms-vmenu-count">{state.star.manual && state.star.newer !== null ? <Pill tone="accent">{fv.newer({ n: state.star.newer })}</Pill> : rows.length}</span>
      </div>
      <p className="ms-vmenu-explain ms-fvpop-only">{fv.onlyChanges}</p>
      {state.starFileMissing && star !== null ? <p className="ms-vmenu-explain ms-fvpop-warn"><Icon name="warn" size={12} />{fv.fileMissing({ n: star })}</p> : null}
      <div className="ms-vmenu-list">
        {rows.map(({ ver, out, last }) => {
          const thumb = out ? outputMedia(slug, creative, ver.n, out) : null;
          const note = ver.request.trim() || v.fromBrief;
          const isStar = inRun(star, ver.n, last);
          const on = inRun(shown, ver.n, last);
          const auto = inRun(state.defaultVersion, ver.n, last);
          // Decision 1063: one pick label per row: the ★ row says who chose it; the rule's row says "Automatica" only
          // when the ★ is elsewhere (a manual pick).
          const pick = isStar ? (state.star.manual ? fv.pickedByYou : fv.automatic) : auto && state.star.manual ? fv.automatic : null;
          const broken = entryHasProblems(versions, state.id, ver.n);
          const kept = last > ver.n ? fv.unchangedUntil({ last }) : null;
          const tokens = ver.usage ? t.web.usage.tokens({ count: formatTokens(locale, shownTotal(ver.usage.tokens)) }) : null;
          const ratio = out && out.width > 0 && out.height > 0 ? `${out.width} / ${out.height}` : undefined;
          return (
            <div key={ver.n} data-row="" className={cx('ms-fvpop-row', on && 'ms-on')}>
              <button type="button" className="ms-vmenu-row" aria-pressed={on}
                aria-label={[fv.viewRow({ n: ver.n, when: when(ver.createdAt), note }), kept, tokens, pick === fv.automatic ? fv.autoTip : null].filter(Boolean).join(' · ')}
                onClick={() => { onView(ver.n); close(); }}>
                <span className={cx('ms-vmenu-thumb', ratio && 'ms-fit')} style={ratio ? { aspectRatio: ratio } : undefined} aria-hidden="true">
                  {!thumb ? <Icon name="video" size={14} /> : thumb.video ? <video src={thumb.src} muted preload="metadata" /> : <img src={thumb.src} alt="" />}
                </span>
                <span className="ms-vmenu-text">
                  <span className="ms-vmenu-line"><b title={kept ?? undefined}>{kept ? fv.range({ n: ver.n, last }) : `v${ver.n}`}</b><span className="ms-vmenu-when">{when(ver.createdAt)}</span>
                    {pick ? <span className="ms-fvpop-auto" title={pick === fv.automatic ? fv.autoTip : undefined}><Pill tone={isStar ? 'accent' : undefined}>{pick}</Pill></span> : null}
                    {broken ? <Pill tone="warn">{v.incomplete}</Pill> : null}
                    <TokenCount tokens={ver.usage ? shownTotal(ver.usage.tokens) : null} className="ms-vmenu-tokens" /></span>
                  <span className="ms-vmenu-note ms-clamp2" title={note}>{note}</span>
                </span>
              </button>
              <button type="button" className={cx('ms-fvpop-star', isStar && 'ms-on')} aria-pressed={isStar} disabled={pending && !isStar} aria-busy={pending || undefined}
                aria-label={isStar ? fv.starred({ n: star! }) : fv.star({ n: ver.n })} title={isStar ? fv.starred({ n: star! }) : fv.star({ n: ver.n })}
                onClick={() => { if (!isStar) actions.star(state.id, ver.n); }}>
                <Icon name="star" size={14} fill={isStar} />
              </button>
            </div>
          );
        })}
      </div>
      {canRestart ? <p className="ms-vmenu-explain">{v.restartNote({ n: shown })}</p> : null}
      {links.length && !busy ? (
        <div className="ms-fvpop-links">
          <p className="ms-vmenu-explain">{fv.linkHint}</p>
          {links.map((l) => (
            <Button key={l.primary} size="sm" variant="outline" onClick={() => { close(); actions.link(state.id, l.primary); }}>
              <Icon name="link" size={13} />{fv.linkTo({ primary: labelOf(l.primary) })}
            </Button>
          ))}
        </div>
      ) : null}
      {/* Decision 974: no Render here; Compare only with something to compare; Reset to Auto only for a manual pick. */}
      {rows.length >= 2 || canRestart || state.star.manual ? (
        <div className="ms-vmenu-foot">
          {rows.length >= 2 ? <Button size="sm" className="ms-grow" onClick={() => { close(); onCompare(); }}>{v.compare}</Button> : null}
          {canRestart ? <Button size="sm" className="ms-grow" onClick={() => { close(); actions.restart(shown); }}>{v.restart}</Button> : null}
          {state.star.manual ? (
            <Button size="sm" className="ms-grow" title={fv.autoTip} loading={pending} onClick={() => actions.resetStar(state.id)}>{fv.resetAuto}</Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A follower's "Linked to Reel ▾" chip (spec §2.3): its menu says it uses the primary's file and ★, and offers
 * "Unlink — make a dedicated version".
 */
export function FollowerChip({ label, primary, short, primaryStar, actions, follower, busy, missing }: {
  /** `short`: the primary's name shown on the chip itself (its format name in a board header); `primary` everywhere else. */
  label: string; primary: string; short?: string; primaryStar: number | null; follower: string; actions: VersionActions; busy?: boolean;
  /** No version holds a byte-identical copy of the primary's ★ file (decisions log 140): Export cannot include it. */
  missing?: boolean;
}) {
  const fv = useT().web.formatVersions;
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const warn = Boolean(missing) && primaryStar !== null;
  return (
    <>
      <button ref={anchor} type="button" className={cx('ms-chip ms-fv-linkchip', open && 'ms-on')} aria-haspopup="dialog" aria-expanded={open}
        aria-label={[fv.linkedMenu({ primary }), warn ? fv.followerMissingShort : null].filter(Boolean).join(' · ')}
        title={warn ? fv.followerMissing({ primary, n: primaryStar! }) : undefined} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
        <Icon name={warn ? 'warn' : 'link'} size={11} className={warn ? 'ms-fv-linkchip-warn' : undefined} />
        <span className="ms-fv-linkchip-text">{fv.linkedTo({ primary: short ?? primary })}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-start" width={280} label={fv.linkedTo({ primary })}>
        <div className="ms-fvlink">
          <p>{fv.followsNote({ label, primary })}</p>
          {primaryStar !== null ? <span className="ms-fvlink-star">{fv.followsStar({ primary, n: primaryStar })}</span> : null}
          {warn ? <p className="ms-fvpop-warn ms-fvlink-warn" role="note"><Icon name="warn" size={12} />{fv.followerMissing({ primary, n: primaryStar! })}</p> : null}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { setOpen(false); actions.unlink(follower); }}>{fv.unlink}</Button>
        </div>
      </Popover>
    </>
  );
}

/**
 * The creative's (a variant's) timeline (spec §3.1): every vN with its request. A row selects it for "Restart from here"
 * and Show in Finder; what each format shows is chosen on its own badge. Decision 972 and user report 17: no "Versions"
 * button in the bars any more; the bar's "…" menu opens this popover on its own button (`anchor`).
 */
export function VersionTimeline({ slug, creative, versions, resumeFrom, actions, open, onClose, anchor }: {
  slug: string; creative: string; versions: VersionEntry[]; resumeFrom: number | null; actions: VersionActions;
  open: boolean; onClose(): void; anchor: RefObject<HTMLElement | null>;
}) {
  const t = useT();
  const v = t.web.canvas.versions;
  const locale = useLocale();
  const when = useWhen();
  const latest = versions.at(-1)?.n ?? 0;
  const current = resumeFrom ?? latest;
  const [selected, setSelected] = useState(current);
  // Each opening starts on the version the next change resumes from.
  useEffect(() => { if (open) setSelected(current); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const canRestart = selected !== current;
  const close = onClose;
  return (
    <>
      <Popover open={open} onClose={close} anchor={anchor} placement="bottom-end" width={320}>
        <div className="ms-vmenu" role="dialog" aria-label={v.title}>
          <div className="ms-vmenu-head"><b>{v.title}</b><span className="ms-vmenu-count">{versions.length}</span></div>
          <div className="ms-vmenu-list">
            {[...versions].reverse().map((ver) => {
              const first = ver.outputs[0];
              const thumb = first ? outputMedia(slug, creative, ver.n, first) : null;
              const note = ver.request.trim() || v.fromBrief;
              const on = ver.n === selected;
              const tokens = ver.usage ? t.web.usage.tokens({ count: formatTokens(locale, shownTotal(ver.usage.tokens)) }) : null;
              return (
                <button key={ver.n} type="button" data-row="" className={cx('ms-vmenu-row', on && 'ms-on')} aria-pressed={on}
                  aria-label={[v.timelineRow({ n: ver.n, when: when(ver.createdAt), note }), tokens].filter(Boolean).join(' · ')} onClick={() => setSelected(ver.n)}>
                  <span className="ms-vmenu-thumb" aria-hidden="true">
                    {thumb ? (thumb.video ? <video src={thumb.src} muted preload="metadata" /> : <img src={thumb.src} alt="" />) : <Icon name="image" size={14} />}
                  </span>
                  <span className="ms-vmenu-text">
                    <span className="ms-vmenu-line"><b>v{ver.n}</b><span className="ms-vmenu-when">{when(ver.createdAt)}</span>
                      {ver.status === 'incomplete' ? <Pill tone="warn">{v.incomplete}</Pill> : null}
                      {/* Versions from before usage tracking have no `usage`: no figure rather than a 0. */}
                      <TokenCount tokens={ver.usage ? shownTotal(ver.usage.tokens) : null} className="ms-vmenu-tokens" /></span>
                    <span className="ms-vmenu-note ms-clamp2" title={note}>{note}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {canRestart ? <p className="ms-vmenu-explain">{v.restartNote({ n: selected })}</p> : null}
          <div className="ms-vmenu-foot">
            {canRestart ? <Button size="sm" className="ms-grow" onClick={() => { close(); actions.restart(selected); }}>{v.restart}</Button> : <span className="ms-grow" />}
            <Button size="sm" variant="ghost" icon aria-label={isMac() ? v.showInFinder : v.showInFolder} title={isMac() ? v.showInFinder : v.showInFolder}
              onClick={() => { close(); actions.reveal(selected); }}>
              <Icon name="folder" size={14} />
            </Button>
          </div>
        </div>
      </Popover>
    </>
  );
}

/**
 * T11: a version newer than the one seen before → "vN is ready" and a spring on `target`, only while `active` (the
 * page is the route's). The first value seen (the page opening) is not news.
 */
export function useNewVersionNotice(loaded: boolean, latest: number | null, active: boolean, target: RefObject<Element | null>): void {
  const t = useT();
  const seen = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (!loaded) return;
    const prev = seen.current;
    seen.current = latest;
    if (prev === undefined || latest === null || (prev !== null && latest <= prev) || !active) return;
    toast.show(t.web.canvas.versionReady({ n: latest }), { tone: 'ok' });
    void pop(target.current);
  }, [loaded, latest, active, t, target]);
}
