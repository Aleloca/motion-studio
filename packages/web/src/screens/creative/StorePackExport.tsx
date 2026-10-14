// Export of an App store pack (Phase 12, spec §4.3): the languages (a multiselect, only when the brief has extra languages),
// the destination (the export dialog's own: the native picker on desktop, a field on the web, remembered), then the result with
// every file written and every file that failed its store check, each with its reason. The core renders what is missing first
// and still writes the rest when some files fail, so a result is a list, not a pass/fail.
import type { LocaleTag } from '@motion-studio/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { api, type StorePackExportResult } from '../../api.ts';
import { desktop } from '../../desktop.ts';
import { useLocale, useT } from '../../i18n.tsx';
import { pop } from '../../motion/index.ts';
import { isMac } from '../../platform.ts';
import { Button, Check, Icon, Input, Modal, cx } from '../../ui/index.ts';
import { message } from '../common.tsx';
import { EXPORT_FOLDER_KEY } from '../ExportDialog.tsx';
import { exportErrorText } from '../versionErrors.ts';
import { localeName } from './languagesModel.ts';
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
  /** The brief's languages: with extra ones the dialog offers a multiselect; absent: the pack is exported as before. */
  locales?: { primary: LocaleTag; extra: LocaleTag[] };
  /** The extra languages the version has no (complete) translation for: marked, still selectable. */
  untranslated?: readonly LocaleTag[];
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

function Body({ onClose, slug, creative, version, locales, untranslated = [], onBusy }: StorePackExportProps & { onBusy(busy: boolean): void }) {
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
  useEffect(() => { onBusy(running); }, [running, onBusy]);
  useEffect(() => () => onBusy(false), [onBusy]);
  // Closing the dialog silences the result of a request that is still running.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const wanted = locales && withLanguages ? [locales.primary, ...locales.extra].filter((tag) => langs[tag]) : [];
  const canRun = folder.trim() !== '' && !running && (!withLanguages || wanted.length > 0);
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
      const r = await api.exportStorePack(slug, creative, version, { destination: dest, ...(withLanguages ? { locales: wanted } : {}) });
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
        <span className="ms-exp-sub">{x.sub({ n: version })}</span>
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
          <div className="ms-exp-done-actions">
            {bridge ? (
              <Button variant="outline" onClick={() => { bridge.revealPath(result.folder).catch((e: unknown) => setError(message(e))); }}>
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
                  {untranslated.includes(tag) ? <span className="ms-sp-untr">{x.notTranslated}</span> : null}
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
        <Button size="lg" variant="ink" loading={running} disabled={!canRun} onClick={() => void run()}>{x.run}</Button>
      </div>
    </div>
  );
}
