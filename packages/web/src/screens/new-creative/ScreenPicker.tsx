// The app screen of a store screenshot (Phase 12, spec §4.1): a modal over the project's library (images only) with an inline
// upload. An uploaded image lands in `assets/` through the library's own route, which registers it; any file it left loose is
// registered here. The core checks the file again when the pack is created (it refuses links, for one) and says why.
import type { AssetEntry } from '@motion-studio/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.ts';
import { useT } from '../../i18n.tsx';
import { Button, Icon, Modal, Spinner } from '../../ui/index.ts';
import { message } from '../common.tsx';

/** Brief paths are project paths; the library lists files inside `assets/`. */
export const assetPath = (file: string) => `assets/${file}`;
const isImage = (a: AssetEntry) => a.kind === 'image';

export interface ScreenPickerProps {
  open: boolean;
  onClose(): void;
  slug: string;
  /** The project path (`assets/…`) picked. */
  onPick(path: string): void;
}

export function ScreenPicker({ open, onClose, slug, onPick }: ScreenPickerProps) {
  const t = useT();
  const s = t.web.storePack;
  const [entries, setEntries] = useState<AssetEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    setEntries(null);
    Promise.resolve().then(() => api.listAssets(slug))
      .then((l) => { if (alive) setEntries(l.assets); })
      .catch((err: unknown) => { if (alive) setError(s.pickerLoadFailed({ detail: message(err) })); });
    return () => { alive = false; };
  }, [open, slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const res = (await api.uploadFiles(slug, 'assets', files)) as { assets?: AssetEntry[] };
      let added = res.assets ?? [];
      if (added.length === 0) {
        // The upload kept the file but did not register it: register what the library lists as loose.
        const listing = await api.listAssets(slug);
        added = listing.unregistered.length > 0 ? (await api.registerAssets(slug, listing.unregistered)).assets : [];
      }
      setEntries((cur) => [...(cur ?? []).filter((a) => !added.some((n) => n.file === a.file)), ...added]);
      const first = added.find(isImage);
      if (first) onPick(assetPath(first.file));
      else setError(s.pickerWrongFile);
    } catch (err) {
      setError(s.pickerUploadFailed({ detail: message(err) }));
    } finally {
      setUploading(false);
    }
  };

  const shown = entries ? entries.filter(isImage) : [];
  return (
    <Modal open={open} onClose={onClose} label={s.pickerTitle} width={520} dismissible={!uploading}>
      <div className="ms-sp-picker">
        <header className="ms-sp-pick-head">
          <h2>{s.pickerTitle}</h2>
          <Button size="sm" variant="outline" disabled={uploading} onClick={() => input.current?.click()}><Icon name="upload" size={13} />{uploading ? s.pickerUploading : s.pickerUpload}</Button>
          <input ref={input} type="file" accept="image/png,image/jpeg" hidden aria-label={s.pickerUploadInput} onChange={(ev) => { void upload(Array.from(ev.target.files ?? [])); ev.target.value = ''; }} />
        </header>
        {error ? <p className="ms-sp-error" role="alert">{error}</p> : null}
        {entries === null && !error ? <div className="ms-sp-pick-state"><Spinner size={16} label={s.pickerLoading} /></div> : null}
        {entries !== null && shown.length === 0 ? <p className="ms-sp-pick-empty">{s.pickerEmpty}</p> : null}
        {shown.length > 0 ? (
          <ul className="ms-sp-list" aria-label={s.pickerList}>
            {shown.map((a) => (
              <li key={a.file}>
                <button type="button" className={'ms-sp-item'} disabled={uploading} onClick={() => onPick(assetPath(a.file))}>
                  <img className="ms-sp-thumb" src={api.projectFileUrl(slug, assetPath(a.file))} alt="" />
                  <span className="ms-sp-pick-name">{a.file}</span>
                  {a.description ? <span className="ms-sp-pick-desc">{a.description}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <footer className="ms-sp-pick-foot"><Button size="sm" variant="ghost" disabled={uploading} onClick={onClose}>{s.pickerClose}</Button></footer>
      </div>
    </Modal>
  );
}
