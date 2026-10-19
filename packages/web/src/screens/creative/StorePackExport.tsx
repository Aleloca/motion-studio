// Export of an App store pack (Phase 12, spec §4.3): the languages (a multiselect, only when the brief has extra languages),
// the destination (the export dialog's own: the native picker on desktop, a field on the web, remembered), then the result with
// every file written and every file that failed its store check, each with its reason. The core renders what is missing first
// and still writes the rest when some files fail, so a result is a list, not a pass/fail.
// Report 48: above the destination, the pack's files by store and device, each with its thumbnail and a checkbox (a tri-state
// one per device and store), all on at first; the core exports only the files chosen (`formats`, only when not all are).
// Report 54: the files are a gallery per store: one row per device of large thumbnails side by side at their real shape, the row
// scrolling sideways; a click on a thumbnail leaves it out (dimmed and marked), checkboxes only on the device and the store.
import type { FormatPreset, LocaleTag, VersionEntry } from '@motion-studio/shared';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, type GroupExportPlanItem, type StorePackExportResult } from '../../api.ts';
import { StillImg } from '../../components/CoverStill.tsx';
import { desktop, showExported } from '../../desktop.ts';
import { useLocale, useT } from '../../i18n.tsx';
import { pop } from '../../motion/index.ts';
import { isMac } from '../../platform.ts';
import { Button, ChannelMark, Check, Icon, Input, Modal, cx } from '../../ui/index.ts';
import { message } from '../common.tsx';
import { EXPORT_FOLDER_KEY } from '../ExportDialog.tsx';
import { exportErrorText } from '../versionErrors.ts';
import { localeName } from './languagesModel.ts';
import { galleryRows, groupCheck, groupThumb, packFileGroups, revealLeft, scrollEdges, versionThumb, withFiles, type PackFileRow } from './storePackFiles.ts';
import '../canvas.css';
import '../new-creative/storepack.css';
import './languages.css';

export interface StorePackExportProps {
  open: boolean;
  onClose(): void;
  slug: string;
  creative: string;
  title: string;
  /** The version the pack is made from. */
  version: number;
  /** Phase 15: the pack of a variant group: each file from the group selection (`creative` is any member), not from one version. */
  group?: boolean;
  /** The brief's languages: with extra ones the dialog offers a multiselect; absent: the pack is exported as before. */
  locales?: { primary: LocaleTag; extra: LocaleTag[] };
  /** The extra languages the version has no (complete) translation for: marked, still selectable. */
  untranslated?: readonly LocaleTag[];
  /** Languages translated in full whose translation of a pack format is outdated or has problems (the export may fail for them). */
  needsReview?: readonly LocaleTag[];
  /**
   * Report 48: the pack's formats (its instances, in the brief's order), listed to pick from. A group reads them from the core
   * instead (the host's brief, the one its pack export reads: decision 1333).
   */
  formats?: readonly string[];
  presets: readonly FormatPreset[];
  /** The brief's instance labels ("1 · caption"). */
  labels?: Record<string, string>;
  /** The version the pack is made from (its thumbnails); a group reads its selection instead. */
  entry?: VersionEntry;
}

const readFolder = () => { try { return localStorage.getItem(EXPORT_FOLDER_KEY) ?? ''; } catch { return ''; } };
const writeFolder = (v: string) => { try { localStorage.setItem(EXPORT_FOLDER_KEY, v); } catch { /* private mode */ } };

/** Report 54: wide enough for a store's row of nine screenshots at the gallery's height (the Modal keeps it inside the window). */
const GALLERY_WIDTH = 1200;

export function StorePackExport(p: StorePackExportProps) {
  const t = useT();
  // While the pack is being made the dialog stays: closing it would hide an export that still writes files.
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={p.open} onClose={p.onClose} label={t.web.storePack.export.title({ title: p.title })} width={GALLERY_WIDTH} dismissible={!busy}>
      {p.open ? <Body {...p} onBusy={setBusy} /> : null}
    </Modal>
  );
}

function Body({ onClose, slug, creative, version, group, locales, untranslated = [], needsReview = [], formats: ownFormats, presets, labels: ownLabels, entry, onBusy }: StorePackExportProps & { onBusy(busy: boolean): void }) {
  const t = useT();
  const x = t.web.storePack.export;
  const ui = useLocale();
  const bridge = desktop();
  const [folder, setFolder] = useState(readFolder);
  const remembered = folder !== '' && folder === readFolder();
  const withLanguages = Boolean(locales && locales.extra.length > 0);
  const [langs, setLangs] = useState<Record<string, boolean>>(() => (locales ? Object.fromEntries([locales.primary, ...locales.extra].map((tag) => [tag, true])) : {}));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StorePackExportResult | null>(null);
  const labelId = useId();
  // A group's thumbnails come from its selection (the member and version of each format), read once.
  const [plan, setPlan] = useState<GroupExportPlanItem[] | null>(null);
  // Decision 1333: a group's files are the host's pack (read from the core), never a member's brief that may lag behind.
  const [groupFiles, setGroupFiles] = useState<{ formats: string[]; labels: Record<string, string> } | { error: string } | null>(null);
  useEffect(() => {
    if (!group) return undefined;
    let live = true;
    Promise.resolve().then(() => api.groupExportPlan(slug, creative)).then((r) => { if (live) setPlan(r.items); }, () => { /* no thumbnails */ });
    Promise.resolve().then(() => api.storePackGroupFiles(slug, creative)).then((r) => { if (live) setGroupFiles(r); }, (e: unknown) => { if (live) setGroupFiles({ error: message(e) }); });
    return () => { live = false; };
  }, [group, slug, creative]);
  const files = group ? (groupFiles && 'formats' in groupFiles ? groupFiles : null) : { formats: ownFormats ?? [], labels: ownLabels };
  const formats = useMemo(() => files?.formats ?? [], [files?.formats]);
  const labels = files?.labels;
  const stores = useMemo(() => packFileGroups(formats, {
    presets, ...(labels ? { labels } : {}), locale: ui, deviceName: (d) => t.web.storePack.devices[d],
    thumbOf: (id) => (group ? groupThumb(slug, plan?.find((g) => g.format === id)) : versionThumb(slug, creative, entry, id)),
  }), [formats, presets, labels, ui, t, group, slug, creative, plan, entry]);
  const all = useMemo(() => stores.flatMap((s) => s.devices.flatMap((d) => d.rows.map((r) => r.id))), [stores]);
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set());
  const chosen = all.filter((id) => !off.has(id));
  const setMany = (ids: readonly string[], v: boolean) => setOff((s) => withFiles(s, ids, v));
  const gallery = useMemo(() => stores.map((s) => ({ store: s, rows: galleryRows(s) })), [stores]);
  useEffect(() => { onBusy(running); }, [running, onBusy]);
  useEffect(() => () => onBusy(false), [onBusy]);
  // Closing the dialog silences the result of a request that is still running.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const wanted = locales && withLanguages ? [locales.primary, ...locales.extra].filter((tag) => langs[tag]) : [];
  // The core writes each chosen file once per language asked.
  const count = chosen.length * (withLanguages ? wanted.length : 1);
  const canRun = folder.trim() !== '' && !running && count > 0;
  const choose = async () => {
    setError(null);
    try {
      const picked = await bridge?.pickFolder(x.pickTitle, folder.trim() || undefined);
      if (picked) setFolder(picked);
    } catch (e) { setError(message(e)); }
  };
  const run = async () => {
    if (!canRun) return;
    const dest = folder.trim();
    setError(null);
    setRunning(true);
    try {
      const body = { destination: dest, ...(withLanguages ? { locales: wanted } : {}), ...(chosen.length < all.length ? { formats: chosen } : {}) };
      const r = await (group ? api.exportStorePackGroup(slug, creative, body) : api.exportStorePack(slug, creative, version, body));
      if (!alive.current) return;
      writeFolder(dest);
      setResult(r);
    } catch (e) {
      if (!alive.current) return;
      const code = (e as { code?: string }).code;
      setError(code === 'not-store-pack' ? x.notAPack : x.failed({ detail: exportErrorText(e, t) }));
    } finally {
      if (alive.current) setRunning(false);
    }
  };

  const head = (
    <div className="ms-exp-head">
      <div className="ms-exp-titles">
        <h2>{x.heading}</h2>
        <span className="ms-exp-sub">{group ? x.subGroup : x.sub({ n: version })}</span>
      </div>
      <Button variant="ghost" icon aria-label={t.common.close} disabled={running} onClick={onClose}><Icon name="close" size={13} strokeWidth={1.6} /></Button>
    </div>
  );

  if (result) {
    const none = result.written.length === 0;
    const rendered = result.rendered?.reduce((k, r) => k + r.formats.length, 0) ?? 0;
    const reveal = isMac() ? t.web.exportUi.showInFinder : t.web.exportUi.showInFolder;
    return (
      <div className="ms-exp ms-spx">
        {head}
        <div className="ms-exp-done ms-sp-result" role={none ? 'alert' : 'status'}>
          {none ? (
            <span className="ms-sp-mark ms-bad" aria-hidden="true"><Icon name="warn" size={22} strokeWidth={2} /></span>
          ) : (
            <span className="ms-exp-done-mark" ref={(el) => { if (el) void pop(el); }}><Icon name="check" size={24} strokeWidth={2.2} /></span>
          )}
          <b>{none ? x.noneWritten : x.writtenTitle({ count: result.written.length })}</b>
          <span className="ms-exp-path">{result.folder}</span>
          {rendered > 0 ? <span className="ms-sp-note">{x.rendered({ count: rendered })}</span> : null}
          {result.written.length > 0 ? (
            <ul className="ms-sp-files" aria-label={x.writtenTitle({ count: result.written.length })}>
              {result.written.map((f) => <li key={f}>{f}</li>)}
            </ul>
          ) : null}
          {result.failed.length > 0 ? (
            <div className="ms-sp-failed">
              <b>{x.failedTitle({ count: result.failed.length })}</b>
              <ul className="ms-sp-files ms-bad" aria-label={x.failedTitle({ count: result.failed.length })}>
                {result.failed.map((f) => <li key={f.file}>{x.reason(f)}</li>)}
              </ul>
            </div>
          ) : null}
          {result.notInPack?.length ? (
            <div className="ms-sp-failed">
              <b>{x.notInPack({ count: result.notInPack.length })}</b>
              <ul className="ms-sp-files" aria-label={x.notInPack({ count: result.notInPack.length })}>
                {result.notInPack.map((f) => <li key={f}>{f}</li>)}
              </ul>
            </div>
          ) : null}
          <div className="ms-exp-done-actions">
            {bridge ? (
              <Button variant="outline" onClick={() => { showExported(bridge, result.folder, []).catch((e: unknown) => setError(message(e))); }}>
                <Icon name="folder" size={14} />{reveal}
              </Button>
            ) : null}
            <Button variant="ink" onClick={onClose}>{x.finish}</Button>
          </div>
          {error ? <p role="alert" className="ms-exp-error">{error}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="ms-exp ms-spx">
      {head}
      {group && !files ? (
        groupFiles && 'error' in groupFiles
          ? <p className="ms-exp-error ms-exp-empty" role="alert">{t.web.exportUi.groupLoadFailed({ detail: groupFiles.error })}</p>
          : <p className="ms-exp-empty" role="status">{t.web.exportUi.groupLoading}</p>
      ) : all.length > 0 ? (
        // The thumbnails' height shares the window's height among the rows (storepack.css).
        <div className="ms-spx-files" role="group" aria-label={x.files} style={{ '--spx-rows': gallery.reduce((k, g) => k + g.rows.length, 0) } as CSSProperties}>
          <p className="ms-spx-hint">{x.galleryHint}</p>
          {gallery.map(({ store: s, rows }) => {
            const ids = s.devices.flatMap((d) => d.rows.map((r) => r.id));
            const name = s.store === 'appstore' ? t.variants.storePack.appStore : t.variants.storePack.googlePlay;
            const c = groupCheck(ids, off);
            return (
              <section key={s.store} className="ms-spx-store">
                {/* Review: the store's name toggles the store, as a device's name toggles the device. */}
                <h3 className="ms-spx-storehead">
                  <label>
                    <Check on={c.on} mixed={c.mixed} label={name} disabled={running} onChange={(v) => setMany(ids, v)} />
                    <span className="ms-spx-mark" aria-hidden="true"><ChannelMark channel={s.store === 'appstore' ? 'appstore' : 'googleplay'} size={20} /></span>
                    <span className="ms-spx-store-name">{name}</span><span className="ms-spx-count">{c.n}/{c.of}</span>
                  </label>
                </h3>
                {rows.map((row) => {
                  const rowIds = row.files.map((r) => r.id);
                  const rc = groupCheck(rowIds, off);
                  const tile = (r: PackFileRow, group: string | null) => (
                    <FileTile key={r.id} row={r} name={group ? x.fileOf({ group, file: r.label }) : r.label} excluded={x.excluded}
                      on={!off.has(r.id)} disabled={running} onToggle={(v) => setMany([r.id], v)} />
                  );
                  return (
                    <div key={row.key} className="ms-spx-row">
                      {row.label ? (
                        <label className="ms-spx-rowhead">
                          <Check on={rc.on} mixed={rc.mixed} label={row.label} disabled={running} onChange={(v) => setMany(rowIds, v)} />
                          <span className="ms-spx-head-name" title={row.label}>{row.label}</span>
                          <span className="ms-spx-count">{rc.n}/{rc.of}</span>
                        </label>
                      ) : <span className="ms-spx-rowhead" />}
                      {/* Review: with single files after them, each part has its caption, so the device's n/m reads as its screenshots only. */}
                      <Strip back={x.scrollBack} more={x.scrollMore} capped={row.tail.length > 0}>
                        {row.tail.length ? (
                          <>
                            {row.files.length ? (
                              <div className="ms-spx-seg">
                                <span className="ms-spx-seg-cap">{x.screenshots}</span>
                                <div className="ms-spx-seg-tiles">{row.files.map((r) => tile(r, row.label))}</div>
                              </div>
                            ) : null}
                            {row.files.length ? <span className="ms-spx-sep" aria-hidden="true" /> : null}
                            <div className="ms-spx-seg" role="group" aria-label={x.otherFiles}>
                              <span className="ms-spx-seg-cap" aria-hidden="true">{x.otherFiles}</span>
                              <div className="ms-spx-seg-tiles">{row.tail.map((r) => tile(r, null))}</div>
                            </div>
                          </>
                        ) : row.files.map((r) => tile(r, row.label))}
                      </Strip>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      ) : <p className="ms-exp-empty">{x.noFiles}</p>}
      {withLanguages && locales ? (
        <div className="ms-exp-langs ms-sp-langs" role="group" aria-label={x.languages}>
          <span className="ms-exp-dest-label">{x.languages}</span>
          <div className="ms-exp-langs-list">
            {[locales.primary, ...locales.extra].map((tag) => {
              const name = tag === locales.primary ? x.original({ language: localeName(tag, ui) }) : localeName(tag, ui);
              return (
                <label key={tag} className="ms-exp-lang">
                  <Check on={Boolean(langs[tag])} label={name} disabled={running} onChange={(v) => setLangs((s) => ({ ...s, [tag]: v }))} />
                  <span>{name}</span>
                  {untranslated.includes(tag) ? <span className="ms-sp-untr">{x.notTranslated}</span> : needsReview.includes(tag) ? <span className="ms-sp-untr">{x.needsReview}</span> : null}
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
      <div className="ms-exp-dest">
        <span className="ms-exp-dest-label" id={labelId}>{x.saveTo}</span>
        <div className="ms-exp-dest-field">
          {bridge ? (
            <div className="ms-exp-folder" aria-labelledby={labelId}>
              <Icon name="folder" size={14} />
              <span className={cx('ms-exp-path', !folder && 'ms-faint')}>{folder || x.noFolder}</span>
              {remembered ? <span className="ms-exp-last">{x.lastUsed}</span> : null}
            </div>
          ) : (
            <Input aria-label={x.folder} value={folder} disabled={running} placeholder={x.placeholder} spellCheck={false}
              onChange={(e) => setFolder(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} />
          )}
          {bridge ? <Button variant="outline" disabled={running} onClick={() => void choose()}>{x.choose}</Button> : null}
        </div>
      </div>
      <div className="ms-exp-foot">
        {running ? (
          <div className="ms-exp-progress">
            <span>{x.running}</span>
            <div className="ms-progress ms-indet" role="progressbar" aria-label={x.running}><i /></div>
          </div>
        ) : error ? (
          <span role="alert" className="ms-exp-error ms-sp-error">{error}</span>
        ) : <div className="ms-grow" />}
        <Button size="lg" variant="ghost" disabled={running} onClick={onClose}>{x.cancel}</Button>
        <Button size="lg" variant="ink" loading={running} disabled={!canRun} onClick={() => void run()}>{x.run({ count })}</Button>
      </div>
    </div>
  );
}

/** The faded edge's width (storepack.css) and room for a focus ring: a focused thumbnail scrolls this far clear of the edge. */
const EDGE = 64 + 6;

/**
 * Report 54: a gallery row's thumbnails side by side, scrolling sideways. Where there is more to see the edge fades and an arrow
 * scrolls by most of a row (for a mouse without a sideways wheel; the keyboard reaches every thumbnail with Tab, and a focused
 * one scrolls clear of the faded edge). The edges follow the strip's box and its content's width (review).
 */
function Strip({ back, more, capped, children }: { back: string; more: string; capped: boolean; children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ back: false, more: false });
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return undefined;
    const update = () => setEdges((e) => { const n = scrollEdges(el); return n.back === e.back && n.more === e.more ? e : n; });
    update();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    if (content.current) ro?.observe(content.current);
    el.addEventListener('scroll', update, { passive: true });
    return () => { ro?.disconnect(); el.removeEventListener('scroll', update); };
  }, []);
  const by = (dir: 1 | -1) => { const el = track.current; el?.scrollBy?.({ left: dir * el.clientWidth * 0.8 }); };
  const reveal = (target: EventTarget) => {
    const el = track.current;
    const tile = target instanceof HTMLElement ? target.closest('.ms-spx-tile') : null;
    if (!el || !tile) return;
    const r = tile.getBoundingClientRect();
    const left = r.left - el.getBoundingClientRect().left + el.scrollLeft;
    const to = revealLeft({ left, width: r.width }, el, EDGE);
    if (to !== null) el.scrollLeft = to;
  };
  return (
    <div className={cx('ms-spx-strip', capped && 'ms-capped', edges.back && 'ms-back', edges.more && 'ms-more')}>
      <div ref={track} className="ms-spx-track" onFocus={(e) => reveal(e.target)}>
        <div ref={content} className="ms-spx-content">{children}</div>
      </div>
      {edges.back ? <button type="button" className="ms-spx-nav ms-prev" tabIndex={-1} aria-hidden="true" title={back} onClick={() => by(-1)}><Icon name="chevron" size={16} strokeWidth={1.8} /></button> : null}
      {edges.more ? <button type="button" className="ms-spx-nav ms-next" tabIndex={-1} aria-hidden="true" title={more} onClick={() => by(1)}><Icon name="chevron" size={16} strokeWidth={1.8} /></button> : null}
    </div>
  );
}

/**
 * One file of the pack: its thumbnail (render or still, as the ★ export rows) at the file's shape and the row's height, its name
 * under it. A toggle: pressed while the file is in the export; left out it is dimmed and marked.
 */
function FileTile({ row, name, excluded, on, disabled, onToggle }: { row: PackFileRow; name: string; excluded: string; on: boolean; disabled: boolean; onToggle(v: boolean): void }) {
  const thumb = row.thumb;
  return (
    <button type="button" className={cx('ms-spx-tile', !on && 'ms-off')} aria-pressed={on} aria-label={name} title={row.label} disabled={disabled}
      onClick={() => onToggle(!on)} style={{ '--spx-a': row.aspect } as CSSProperties}>
      <span className="ms-spx-thumb">
        {thumb && 'still' in thumb ? <StillImg still={thumb.still} />
          : thumb ? (thumb.media.video ? <video src={thumb.media.src} muted preload="metadata" /> : <img src={thumb.media.src} alt="" />) : null}
        {on ? null : <span className="ms-spx-excl" title={excluded}><Icon name="eyeOff" size={13} strokeWidth={1.6} /></span>}
      </span>
      <span className="ms-spx-file-name">{row.label}</span>
    </button>
  );
}
