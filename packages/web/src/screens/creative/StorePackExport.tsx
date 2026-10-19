// Export of an App store pack (Phase 12, spec §4.3): the languages (a multiselect, only when the brief has extra languages),
// the destination (the export dialog's own: the native picker on desktop, a field on the web, remembered), then the result with
// every file written and every file that failed its store check, each with its reason. The core renders what is missing first
// and still writes the rest when some files fail, so a result is a list, not a pass/fail.
// Report 48: above the destination, the pack's files by store and device, each with its thumbnail and a checkbox (a tri-state
// one per device and store), all on at first; the core exports only the files chosen (`formats`, only when not all are).
import type { FormatPreset, LocaleTag, VersionEntry } from '@motion-studio/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, type GroupExportPlanItem, type StorePackExportResult } from '../../api.ts';
import { StillImg } from '../../components/CoverStill.tsx';
import { desktop, showExported } from '../../desktop.ts';
import { useLocale, useT } from '../../i18n.tsx';
import { pop } from '../../motion/index.ts';
import { isMac } from '../../platform.ts';
import { Button, Check, Icon, Input, Modal, cx } from '../../ui/index.ts';
import { message } from '../common.tsx';
import { EXPORT_FOLDER_KEY } from '../ExportDialog.tsx';
import { exportErrorText } from '../versionErrors.ts';
import { localeName } from './languagesModel.ts';
import { groupThumb, packFileGroups, versionThumb, type PackFileRow } from './storePackFiles.ts';
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
  /** Report 48: the pack's formats (its instances, in the brief's order), listed to pick from. */
  formats: readonly string[];
  presets: readonly FormatPreset[];
  /** The brief's instance labels ("1 · caption"). */
  labels?: Record<string, string>;
  /** The version the pack is made from (its thumbnails); a group reads its selection instead. */
  entry?: VersionEntry;
}

const readFolder = () => { try { return localStorage.getItem(EXPORT_FOLDER_KEY) ?? ''; } catch { return ''; } };
const writeFolder = (v: string) => { try { localStorage.setItem(EXPORT_FOLDER_KEY, v); } catch { /* private mode */ } };

export function StorePackExport(p: StorePackExportProps) {
  const t = useT();
  // While the pack is being made the dialog stays: closing it would hide an export that still writes files.
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={p.open} onClose={p.onClose} label={t.web.storePack.export.title({ title: p.title })} width={640} dismissible={!busy}>
      {p.open ? <Body {...p} onBusy={setBusy} /> : null}
    </Modal>
  );
}

function Body({ onClose, slug, creative, version, group, locales, untranslated = [], needsReview = [], formats, presets, labels, entry, onBusy }: StorePackExportProps & { onBusy(busy: boolean): void }) {
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
  useEffect(() => {
    if (!group) return undefined;
    let live = true;
    Promise.resolve().then(() => api.groupExportPlan(slug, creative)).then((r) => { if (live) setPlan(r.items); }, () => { /* no thumbnails */ });
    return () => { live = false; };
  }, [group, slug, creative]);
  const stores = useMemo(() => packFileGroups(formats, {
    presets, ...(labels ? { labels } : {}), locale: ui, deviceName: (d) => t.web.storePack.devices[d],
    thumbOf: (id) => (group ? groupThumb(slug, plan?.find((g) => g.format === id)) : versionThumb(slug, creative, entry, id)),
  }), [formats, presets, labels, ui, t, group, slug, creative, plan, entry]);
  const all = useMemo(() => stores.flatMap((s) => s.devices.flatMap((d) => d.rows.map((r) => r.id))), [stores]);
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set());
  const chosen = all.filter((id) => !off.has(id));
  const setMany = (ids: readonly string[], v: boolean) => setOff((s) => { const n = new Set(s); for (const id of ids) { if (v) n.delete(id); else n.add(id); } return n; });
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
      {all.length > 0 ? (
        <div className="ms-spx-files" role="group" aria-label={x.files}>
          {stores.map((s) => {
            const ids = s.devices.flatMap((d) => d.rows.map((r) => r.id));
            const name = s.store === 'appstore' ? t.variants.storePack.appStore : t.variants.storePack.googlePlay;
            const singles = s.devices.filter((d) => d.single).flatMap((d) => d.rows);
            return (
              <section key={s.store} className="ms-spx-store">
                <GroupHead ids={ids} off={off} label={name} disabled={running} onChange={setMany} strong />
                {s.devices.filter((d) => !d.single).map((d) => (
                  <div key={d.key} className="ms-spx-device">
                    <GroupHead ids={d.rows.map((r) => r.id)} off={off} label={d.label} disabled={running} onChange={setMany} />
                    <div className="ms-spx-grid">
                      {d.rows.map((r) => <FileTile key={r.id} row={r} slug={slug} name={x.fileOf({ group: d.label, file: r.label })} on={!off.has(r.id)} disabled={running} onChange={(v) => setMany([r.id], v)} />)}
                    </div>
                  </div>
                ))}
                {singles.length ? (
                  <div className="ms-spx-grid ms-spx-singles">
                    {singles.map((r) => <FileTile key={r.id} row={r} slug={slug} name={r.label} on={!off.has(r.id)} disabled={running} onChange={(v) => setMany([r.id], v)} />)}
                  </div>
                ) : null}
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

/** A store's or a device's checkbox: on when all its files are, mixed when some are; a click turns all on (or all off). */
function GroupHead({ ids, off, label, disabled, onChange, strong = false }: { ids: string[]; off: ReadonlySet<string>; label: string; disabled: boolean; onChange(ids: string[], v: boolean): void; strong?: boolean }) {
  const n = ids.filter((id) => !off.has(id)).length;
  return (
    <label className={cx('ms-spx-head', strong && 'ms-spx-storehead')}>
      <Check on={n === ids.length} mixed={n > 0} label={label} disabled={disabled} onChange={(v) => onChange(ids, v)} />
      <span className="ms-spx-head-name">{label}</span>
      <span className="ms-spx-count">{n}/{ids.length}</span>
    </label>
  );
}

/** One file of the pack: its checkbox, its thumbnail (render or still, as the ★ export rows) and its short name. */
function FileTile({ row, slug, name, on, disabled, onChange }: { row: PackFileRow; slug: string; name: string; on: boolean; disabled: boolean; onChange(v: boolean): void }) {
  const shape = row.aspect > 1.05 ? 'ms-wide' : row.aspect < 0.95 ? 'ms-tall' : 'ms-square';
  const thumb = row.thumb;
  return (
    <label className={cx('ms-spx-file', !on && 'ms-off')} title={name}>
      <Check on={on} label={name} disabled={disabled} onChange={onChange} className="ms-spx-check" />
      <span className={cx('ms-spx-thumb', shape)} aria-hidden="true">
        {thumb && 'still' in thumb ? <StillImg still={thumb.still} />
          : thumb ? (thumb.media.video ? <video src={thumb.media.src} muted preload="metadata" /> : <img src={thumb.media.src} alt="" />) : null}
      </span>
      <span className="ms-spx-file-name">{row.label}</span>
    </label>
  );
}
