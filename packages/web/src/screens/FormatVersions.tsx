// Per-format versions (spec §3.1, prototype `VersionsPopover` and the CanvasView board header), shared by the canvas and
// the format view: the "★ v5 ▾" badge of a format with its history popover (view a version, ★ it for export, Compare,
// Restart from here, Link to …), "viewing v3", the "Linked to …" chip of a follower with Unlink, the creative's
// "Versions" timeline of the bar, and the actions behind them with their error messages.
import type { VersionEntry } from '@motion-studio/shared';
import { shownTotal } from '@motion-studio/shared';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api } from '../api.ts';
import { formatDate, TIME_OF_DAY, useLocale, useT } from '../i18n.tsx';
import { pop } from '../motion/index.ts';
import { isMac } from '../platform.ts';
import { formatTokens, TokenCount } from '../shell/Tokens.tsx';
import { Button, Icon, Pill, Popover, cx, toast } from '../ui/index.ts';
import { outputMedia } from './canvasModel.ts';
import { entryAt, type FormatState } from './versionModel.ts';
import { errorCode, versionErrorText, withHashRetry, type VersionErrorContext } from './versionErrors.ts';
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
export function useVersionActions({ slug, creative, states, labelOf, resumeFrom, onChanged, onError }: {
  slug: string; creative: string; states: Record<string, FormatState>; labelOf(id: string): string; resumeFrom: number | null;
  onChanged(): void; onError(text: string | null): void;
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
  const waitFor = (signal: AbortSignal) => (ms: number) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const id = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(id); reject(signal.reason); }, { once: true });
  });
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
    Promise.resolve().then(() => withHashRetry(call, waitFor(signal))).then(() => {
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
    Promise.resolve().then(() => api.restoreVersion(slug, creative, n)).then(() => { onChanged(); done(); })
      .catch((e: unknown) => onError(v.actionFailed({ detail: message(e) })));
  };
  return {
    star: (format, n, opts) => {
      const label = labelOf(format);
      const follows = states[format]?.follows;
      run(() => api.setExportPick(slug, creative, format, n), { label, n, primary: follows ? labelOf(follows) : undefined },
        () => { toast.show(fv.starToast({ n, label }), { tone: 'ok' }); opts?.done?.(); }, format, opts?.fail);
    },
    resetStar: (format) => {
      const label = labelOf(format);
      run(() => api.setExportPick(slug, creative, format, null), { label }, () => toast.show(fv.resetToast({ label }), { tone: 'ok' }), format);
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
  className?: string;
}

/**
 * "★ v5 ▾": the ★ version of a format, opening its history (spec §3.1). "viewing v3" follows it when another version is on
 * screen. Nothing before the format has a version.
 */
export function FormatBadge(p: FormatBadgeProps) {
  const t = useT();
  const fv = t.web.formatVersions;
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const star = p.state.star.version;
  if (star === null && p.state.history.length === 0) return null;
  const n = star ?? p.state.history.at(-1)!;
  return (
    <>
      <button ref={anchor} type="button" className={cx('ms-vbadge ms-star ms-fvb', open && 'ms-open', p.className)} aria-haspopup="dialog" aria-expanded={open}
        aria-label={fv.badge({ label: p.label, n })} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
        ★ v{n}<Icon name="chevron" size={10} />
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
  const rows = [...state.history].reverse().flatMap((n) => {
    const ver = versions.find((x) => x.n === n);
    const out = ver?.outputs.find((o) => o.format === state.id);
    return ver && out ? [{ ver, out }] : [];
  });
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
      {state.starFileMissing && star !== null ? <p className="ms-vmenu-explain ms-fvpop-warn"><Icon name="warn" size={12} />{fv.fileMissing({ n: star })}</p> : null}
      <div className="ms-vmenu-list">
        {rows.map(({ ver, out }) => {
          const thumb = outputMedia(slug, creative, ver.n, out);
          const note = ver.request.trim() || v.fromBrief;
          const isStar = ver.n === star;
          const on = ver.n === shown;
          const auto = ver.n === state.defaultVersion;
          const tokens = ver.usage ? t.web.usage.tokens({ count: formatTokens(locale, shownTotal(ver.usage.tokens)) }) : null;
          return (
            <div key={ver.n} data-row="" className={cx('ms-fvpop-row', on && 'ms-on')}>
              <button type="button" className={cx('ms-vmenu-row', on && 'ms-on')} aria-pressed={on}
                aria-label={[fv.viewRow({ n: ver.n, when: when(ver.createdAt), note }), tokens, auto ? fv.autoTip : null].filter(Boolean).join(' · ')}
                onClick={() => { onView(ver.n); close(); }}>
                <span className="ms-vmenu-thumb" aria-hidden="true">
                  {thumb.video ? <video src={thumb.src} muted preload="metadata" /> : <img src={thumb.src} alt="" />}
                </span>
                <span className="ms-vmenu-text">
                  <span className="ms-vmenu-line"><b>v{ver.n}</b><span className="ms-vmenu-when">{when(ver.createdAt)}</span>
                    {on && !isStar ? <Pill>{fv.viewingTag}</Pill> : null}
                    {isStar && state.star.manual ? <Pill tone="accent">{fv.manual}</Pill> : null}
                    {auto ? <span className="ms-fvpop-auto" title={fv.autoTip}><Pill>{fv.auto}</Pill></span> : null}
                    {ver.status === 'incomplete' ? <Pill tone="warn">{v.incomplete}</Pill> : null}
                    <TokenCount tokens={ver.usage ? shownTotal(ver.usage.tokens) : null} className="ms-vmenu-tokens" /></span>
                  <span className="ms-vmenu-note">{note}</span>
                </span>
              </button>
              <button type="button" className={cx('ms-fvpop-star', isStar && 'ms-on')} aria-pressed={isStar} disabled={pending && !isStar} aria-busy={pending || undefined}
                aria-label={isStar ? fv.starred({ n: ver.n }) : fv.star({ n: ver.n })} title={isStar ? fv.starred({ n: ver.n }) : fv.star({ n: ver.n })}
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
      <div className="ms-vmenu-foot">
        <Button size="sm" className="ms-grow" disabled={rows.length < 2} onClick={() => { close(); onCompare(); }}>{v.compare}</Button>
        {canRestart ? <Button size="sm" className="ms-grow" onClick={() => { close(); actions.restart(shown); }}>{v.restart}</Button> : null}
        {state.star.manual ? (
          <Button size="sm" className="ms-grow" title={fv.autoTip} loading={pending} onClick={() => actions.resetStar(state.id)}>{fv.resetAuto}</Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A follower's "Linked to Reel ▾" chip (spec §2.3): its menu says it uses the primary's file and ★, and offers
 * "Unlink — make a dedicated version".
 */
export function FollowerChip({ label, primary, primaryStar, actions, follower, busy }: {
  label: string; primary: string; primaryStar: number | null; follower: string; actions: VersionActions; busy?: boolean;
}) {
  const fv = useT().web.formatVersions;
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={anchor} type="button" className={cx('ms-chip ms-fv-linkchip', open && 'ms-on')} aria-haspopup="dialog" aria-expanded={open}
        aria-label={fv.linkedMenu({ primary })} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
        <Icon name="link" size={11} />{fv.linkedTo({ primary })}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-start" width={280} label={fv.linkedTo({ primary })}>
        <div className="ms-fvlink">
          <p>{fv.followsNote({ label, primary })}</p>
          {primaryStar !== null ? <span className="ms-fvlink-star">{fv.followsStar({ primary, n: primaryStar })}</span> : null}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { setOpen(false); actions.unlink(follower); }}>{fv.unlink}</Button>
        </div>
      </Popover>
    </>
  );
}

/**
 * The bar's "Versions" (spec §3.1): the creative's timeline, every vN with its request. A row selects it for "Restart from
 * here" and Show in Finder; what each board shows is chosen on the board itself.
 */
export function VersionTimeline({ slug, creative, versions, resumeFrom, actions, buttonRef }: {
  slug: string; creative: string; versions: VersionEntry[]; resumeFrom: number | null; actions: VersionActions; buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  const t = useT();
  const v = t.web.canvas.versions;
  const locale = useLocale();
  const when = useWhen();
  const [open, setOpen] = useState(false);
  const latest = versions.at(-1)?.n ?? 0;
  const current = resumeFrom ?? latest;
  const [selected, setSelected] = useState(current);
  // Each opening starts on the version the next change resumes from.
  useEffect(() => { if (open) setSelected(current); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const canRestart = selected !== current;
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button ref={buttonRef} type="button" className={cx('ms-btn ms-outline ms-cv-vbtn ms-no-drag', open && 'ms-open')} aria-haspopup="dialog" aria-expanded={open}
        aria-label={v.timelineMenu({ total: versions.length })} onClick={() => setOpen((o) => !o)}>
        <span>{v.timeline}</span><span className="ms-cv-vbtn-count">{versions.length}</span><Icon name="chevron" size={11} />
      </button>
      <Popover open={open} onClose={close} anchor={buttonRef} placement="bottom-end" width={320}>
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
                    <span className="ms-vmenu-note">{note}</span>
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
