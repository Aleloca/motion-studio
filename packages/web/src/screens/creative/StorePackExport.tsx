// Export of an App store pack (Phase 12, spec §4.3): the languages (a multiselect, only when the brief has extra languages),
// the destination (the export dialog's own: the native picker on desktop, a field on the web, remembered), then the result with
// every file written and every file that failed its store check, each with its reason. The core renders what is missing first
// and still writes the rest when some files fail, so a result is a list, not a pass/fail.
// Report 48: above the destination, the pack's files by store and device, each with its thumbnail and a checkbox (a tri-state
// one per device and store), all on at first; the core exports only the files chosen (`formats`, only when not all are).
// Report 54 (the user's variant A): two panes. On the left the stores (a tri-state checkbox each) and their items (a device's
// screenshots, a single file) with n/m; a click on an item shows it on the right, a grid of large thumbnails at their real
// shape, each a toggle (a click leaves the file out). The destination and the export button are one footer row.
import type { FormatPreset, LocaleTag, VersionEntry } from '@motion-studio/shared';
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
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
import { gridColumns, groupCheck, groupThumb, packFileGroups, shownItem, stepItem, versionThumb, withFiles, type PackDevice, type PackFileRow } from './storePackFiles.ts';
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

/** Report 54 (variant A): the list, and a grid of four screenshots about 180 px wide (the Modal keeps it inside the window). */
const PACK_WIDTH = 1200;

export function StorePackExport(p: StorePackExportProps) {
  const t = useT();
  // While the pack is being made the dialog stays: closing it would hide an export that still writes files.
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={p.open} onClose={p.onClose} label={t.web.storePack.export.title({ title: p.title })} width={PACK_WIDTH} dismissible={!busy}>
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
  // The item the right pane shows (report 54): the first device of the first store until another is clicked.
  const [picked, setPicked] = useState<string | null>(null);
  const shown = shownItem(stores, picked);
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

  const storeName = (id: string) => (id === 'appstore' ? t.variants.storePack.appStore : t.variants.storePack.googlePlay);
  const meta = (d: PackDevice, withSize: boolean) => {
    const size = x.size({ width: d.width, height: d.height });
    if (d.kind === 'shots') return withSize ? `${x.shots({ count: d.rows.length })} · ${size}` : x.shots({ count: d.rows.length });
    return d.kind === 'video' ? x.video({ size }) : x.image({ size });
  };
  const keys = stores.flatMap((s) => s.devices.map((d) => d.key));
  // Arrow keys move along the items (each a button; Tab goes on to the grid).
  const onNavKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const from = (e.target as HTMLElement).closest<HTMLElement>('.ms-spx-item')?.dataset.item;
    if (!from) return;
    e.preventDefault();
    const to = stepItem(keys, from, e.key === 'ArrowDown' ? 1 : -1);
    e.currentTarget.querySelector<HTMLElement>(`.ms-spx-item[data-item="${to}"]`)?.focus();
  };
  const languages = withLanguages && locales ? (
    <div className="ms-spx-langs" role="group" aria-label={x.languages}>
      <span className="ms-spx-langs-title">{x.languages}</span>
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
  ) : null;

  return (
    <div className="ms-exp ms-spx ms-spx-pick">
      {head}
      {group && !files ? (
        groupFiles && 'error' in groupFiles
          ? <p className="ms-exp-error ms-exp-empty" role="alert">{t.web.exportUi.groupLoadFailed({ detail: groupFiles.error })}</p>
          : <p className="ms-exp-empty" role="status">{t.web.exportUi.groupLoading}</p>
      ) : all.length > 0 && shown ? (
        <div className="ms-spx-body">
          <nav className="ms-spx-nav" aria-label={x.nav} onKeyDown={onNavKey}>
            {stores.map((s) => {
              const ids = s.devices.flatMap((d) => d.rows.map((r) => r.id));
              const c = groupCheck(ids, off);
              const name = storeName(s.store);
              return (
                <div key={s.store} className="ms-spx-store">
                  {/* The store's row turns the whole store on or off (a click on its name too). */}
                  <label className="ms-spx-storehead">
                    <Check on={c.on} mixed={c.mixed} label={name} disabled={running} onChange={(v) => setMany(ids, v)} />
                    <span className="ms-spx-mark" aria-hidden="true"><ChannelMark channel={s.store === 'appstore' ? 'appstore' : 'googleplay'} size={20} /></span>
                    <span className="ms-spx-store-name">{name}</span>
                    <span className="ms-spx-count">{c.n}/{c.of}</span>
                  </label>
                  {s.devices.map((d) => {
                    const dc = groupCheck(d.rows.map((r) => r.id), off);
                    const on = d.key === shown.key;
                    return (
                      <button key={d.key} type="button" className={cx('ms-spx-item', on && 'ms-on')} data-item={d.key} aria-current={on ? 'true' : undefined} onClick={() => setPicked(d.key)}>
                        <span className="ms-spx-item-text"><span className="ms-spx-item-name">{d.label}</span><span className="ms-spx-item-meta">{meta(d, false)}</span></span>
                        <span className="ms-spx-item-count">{dc.n}/{dc.of}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {languages}
            <p className="ms-spx-total">{x.selectedOf({ n: chosen.length, of: all.length })}</p>
          </nav>
          <div className="ms-spx-pane">
            <div className="ms-spx-pane-head">
              <h3>{shown.label}</h3>
              <span className="ms-spx-pane-meta">{meta(shown, true)}</span>
              <span className="ms-grow" />
              <button type="button" className="ms-spx-link" disabled={running} onClick={() => setMany(shown.rows.map((r) => r.id), true)}>{x.selectAll}</button>
              <button type="button" className="ms-spx-link" disabled={running} onClick={() => setMany(shown.rows.map((r) => r.id), false)}>{x.selectNone}</button>
            </div>
            <div className="ms-spx-grid" role="group" aria-label={x.files} style={{ '--spx-cols': gridColumns(shown) } as CSSProperties}>
              {shown.rows.map((r) => (
                <FileTile key={r.id} row={r} name={shown.single ? r.label : x.fileOf({ group: shown.label, file: r.label })} excluded={x.excluded}
                  on={!off.has(r.id)} disabled={running} onToggle={(v) => setMany([r.id], v)} />
              ))}
            </div>
          </div>
        </div>
      ) : <p className="ms-exp-empty">{x.noFiles}</p>}
      {/* Without the list (still reading, or no files) the languages stay above the footer. */}
      {(group && !files) || !(all.length > 0 && shown) ? languages : null}
      {running || error ? (
        <div className="ms-spx-status">
          {running ? (
            <div className="ms-exp-progress">
              <span>{x.running}</span>
              <div className="ms-progress ms-indet" role="progressbar" aria-label={x.running}><i /></div>
            </div>
          ) : <span role="alert" className="ms-exp-error ms-sp-error">{error}</span>}
        </div>
      ) : null}
      {/* One footer row: the destination, the folder picker, Cancel and Export. */}
      <div className="ms-spx-foot">
        <span className="ms-exp-dest-label" id={labelId}>{x.saveTo}</span>
        <div className="ms-spx-dest">
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
        </div>
        {bridge ? <Button variant="outline" size="lg" disabled={running} onClick={() => void choose()}>{x.choose}</Button> : null}
        <Button size="lg" variant="ghost" disabled={running} onClick={onClose}>{x.cancel}</Button>
        <Button size="lg" variant="ink" loading={running} disabled={!canRun} onClick={() => void run()}>{x.run({ count })}</Button>
      </div>
    </div>
  );
}

/**
 * One file of the pack: its thumbnail (render or still, as the ★ export rows) at the file's shape, its name under it. A toggle:
 * pressed (an accent check in the corner) while the file is in the export; left out the corner is an empty ring and the
 * thumbnail and its name are grey.
 */
function FileTile({ row, name, excluded, on, disabled, onToggle }: { row: PackFileRow; name: string; excluded: string; on: boolean; disabled: boolean; onToggle(v: boolean): void }) {
  const thumb = row.thumb;
  return (
    <button type="button" className={cx('ms-spx-tile', !on && 'ms-off')} aria-pressed={on} aria-label={name} title={row.label} disabled={disabled}
      onClick={() => onToggle(!on)} style={{ '--spx-a': row.aspect } as CSSProperties}>
      <span className="ms-spx-thumb">
        {thumb && 'still' in thumb ? <StillImg still={thumb.still} />
          : thumb ? (thumb.media.video ? <video src={thumb.media.src} muted preload="metadata" /> : <img src={thumb.media.src} alt="" />) : null}
        <span className="ms-spx-badge" title={on ? undefined : excluded}>{on ? <Icon name="check" size={14} strokeWidth={2.6} /> : null}</span>
      </span>
      <span className="ms-spx-file-name">{row.label}</span>
    </button>
  );
}
