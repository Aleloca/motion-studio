// The asset picker (Phase 10b, Task 8): a modal over the project's library, filtered by the kind of clip being replaced,
// with "Upload…" (the library's own upload, which registers the file; any file it left unregistered is registered here), then
// the file is picked. Picking is the caller's: it stages the file and edits the draft (the picker shows the busy state).
import type { AssetEntry, AssetKind } from '@motion-studio/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.ts';
import { useT } from '../../i18n.tsx';
import { Button, Icon, Modal, Spinner, cx } from '../../ui/index.ts';
import { message } from '../../errors.ts';
import { useEditor } from './editorContext.ts';

export interface AssetPickerProps {
  open: boolean;
  onClose(): void;
  /** The library kinds that fit what is being replaced. */
  kinds: readonly AssetKind[];
  /** The file chosen. The picker stays open (busy) until the caller closes it. */
  onPick(entry: AssetEntry): void | Promise<void>;
}

const baseName = (file: string) => file.split('/').pop() ?? file;

export function AssetPicker({ open, onClose, kinds, onPick }: AssetPickerProps) {
  const t = useT();
  const e = t.web.editor;
  const { slug, staging } = useEditor();
  const [entries, setEntries] = useState<AssetEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const fits = useCallback((list: AssetEntry[]) => list.filter((a) => kinds.includes(a.kind)), [kinds]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    setEntries(null);
    Promise.resolve().then(() => api.listAssets(slug)).then((l) => { if (alive) setEntries(l.assets); }).catch((err) => { if (alive) setError(e.pickerLoadFailed({ detail: message(err) })); });
    return () => { alive = false; };
  }, [open, slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = async (entry: AssetEntry) => {
    setBusy(entry.file);
    try { await onPick(entry); } finally { setBusy(null); }
  };

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
      const first = fits(added)[0];
      if (first) await choose(first);
    } catch (err) {
      setError(e.pickerUploadFailed({ detail: message(err) }));
    } finally {
      setUploading(false);
    }
  };

  const kindName = kinds.map((k) => (k === 'image' ? e.kindImageFile : k === 'svg' ? e.kindSvgFile : k === 'video' ? e.kindVideoFile : k === 'audio' ? e.kindAudioFile : k)).join(' / ');
  const shown = entries ? fits(entries) : [];
  const working = uploading || busy !== null || staging;
  return (
    <Modal open={open} onClose={onClose} label={e.pickerFor({ kind: kindName })} width={520} dismissible={!working}>
      <div className="ms-picker">
        <header className="ms-picker-head">
          <h2>{e.pickerFor({ kind: kindName })}</h2>
          <Button size="sm" variant="outline" disabled={working} onClick={() => input.current?.click()}><Icon name="upload" size={13} />{uploading ? e.pickerUploading : e.pickerUpload}</Button>
          <input ref={input} type="file" hidden aria-label={e.pickerUploadInput} onChange={(ev) => { void upload(Array.from(ev.target.files ?? [])); ev.target.value = ''; }} />
        </header>
        {error ? <p className="ms-insp-err" role="alert">{error}</p> : null}
        {entries === null && !error ? <div className="ms-picker-state"><Spinner size={16} label={e.pickerLoading} /></div> : null}
        {entries !== null && shown.length === 0 ? <p className="ms-picker-empty">{e.pickerEmpty({ kind: kindName })}</p> : null}
        {shown.length > 0 ? (
          <ul className="ms-picker-list" aria-label={e.pickerList}>
            {shown.map((a) => (
              <li key={a.file}>
                <button type="button" className={cx('ms-picker-item', busy === a.file && 'ms-on')} disabled={working} onClick={() => void choose(a)}>
                  <span className="ms-picker-name">{baseName(a.file)}</span>
                  {a.description ? <span className="ms-picker-desc">{a.description}</span> : null}
                  {busy === a.file ? <span className="ms-picker-busy" role="status"><Spinner size={13} decorative /><span>{e.pickerPreparing({ file: baseName(a.file) })}</span>{staging ? <small>{e.stagingLong}</small> : null}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <footer className="ms-picker-foot"><Button size="sm" variant="ghost" disabled={working} onClick={onClose}>{e.pickerClose}</Button></footer>
      </div>
    </Modal>
  );
}
