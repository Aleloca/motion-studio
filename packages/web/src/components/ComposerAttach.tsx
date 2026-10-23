import { assetKindOf, type AssetEntry } from '@motion-studio/shared';
import { useContext, useRef, useState } from 'react';
import { api } from '../api.ts';
import { message as errText } from '../errors.ts';
import { useT } from '../i18n.tsx';
import { ShellContext } from '../shell/ShellContext.tsx';
import { PlusMenu } from '../screens/new-creative/BriefContext.tsx';
import { LibraryPicker, assetPath } from '../screens/new-creative/LibraryPicker.tsx';
import { Icon, Spinner, type IconName } from '../ui/index.ts';
import '../screens/new-creative/briefsession.css';
import '../screens/newcreative.css';

/** Report 79: an attached file's icon, by its kind (the chips in the composer and on the sent message). */
export const fileIcon = (path: string): IconName => {
  const k = assetKindOf(path);
  return k === 'image' || k === 'svg' ? 'image' : k === 'video' ? 'video' : k === 'audio' ? 'music' : 'folder';
};

/** Round 1 (finding 1): files on their way to the library; the composer shows them and does not send until they land. */
export interface PendingUpload { id: number; names: string[] }

let uploads = 0;

/**
 * Report 79: the creative chat's "+": files from the computer (saved in the project library, then attached) or from the
 * library. `chosen`: the project paths (`assets/…`) attached now; the composer sends them with its next message.
 */
export function AttachButton({ slug, chosen, onAdd, onRemove, onError, onPending, disabled }: {
  /** `upload`: the id of the upload a result comes from (round 2: the composer ignores an abandoned one's). */
  slug: string; chosen: readonly string[]; onAdd(paths: string[], upload?: number): void; onRemove(path: string): void; onError(text: string | null, upload?: number): void;
  /** An upload started (`started`) or settled (`settled`, its id). */
  onPending(change: { started: PendingUpload } | { settled: number }): void;
  disabled?: boolean;
}) {
  const t = useT();
  const c = t.web.chat;
  const shell = useContext(ShellContext);
  const projectName = shell?.catalog.projects?.find((p) => p.slug === slug)?.name ?? slug;
  const [library, setLibrary] = useState<{ value: AssetEntry[] | null; error: string | null }>({ value: null, error: null });
  const [pickerOpen, setPickerOpen] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const load = () => {
    setLibrary((l) => ({ value: l.value, error: null }));
    api.listAssets(slug)
      .then((r) => setLibrary({ value: r.assets, error: r.error }))
      .catch((e: unknown) => setLibrary((l) => ({ value: l.value, error: errText(e) })));
  };
  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    onError(null);
    const id = ++uploads;
    onPending({ started: { id, names: files.map((f) => f.name) } });
    // A library asset (not a brief's reference: those are swept when no creative's brief uses them).
    try {
      const r = await api.uploadFiles(slug, 'assets', files);
      const paths = (r.assets ?? []).map((a) => assetPath(a.file));
      if (paths.length) onAdd(paths, id);
      if (library.value !== null) load();
    } catch (e) { onError(t.web.briefSession.uploadFailed({ detail: errText(e) }), id); }
    finally { onPending({ settled: id }); }
  };
  return (
    <>
      <PlusMenu label={c.attach} menuLabel={c.attachMenu} disabled={disabled} size="sm" className="ms-composer-attach" items={[
        { key: 'computer', icon: 'upload', title: c.attachComputer.title, hint: c.attachComputer.hint, run: () => input.current?.click() },
        { key: 'library', icon: 'image', title: c.attachLibrary.title, hint: c.attachLibrary.hint, run: (el) => { anchor.current = el; load(); setPickerOpen(true); } },
      ]} />
      <input ref={input} type="file" multiple hidden aria-hidden="true" tabIndex={-1} data-testid="attach-input"
        onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; void upload(files); }} />
      <LibraryPicker slug={slug} projectName={projectName} open={pickerOpen} onClose={() => setPickerOpen(false)} anchor={anchor} placement="top-start" library={library}
        onRetry={load} chosen={chosen} onUpload={() => input.current?.click()}
        onToggle={(path) => (chosen.includes(path) ? onRemove(path) : onAdd([path]))} />
    </>
  );
}

/** An image's picture, or the kind icon (any other file, or a picture that does not load). */
function ChipFace({ slug, path }: { slug: string; path: string }) {
  const [broken, setBroken] = useState(false);
  const k = assetKindOf(path);
  if ((k === 'image' || k === 'svg') && !broken) {
    return <img className="ms-attach-thumb" src={api.projectFileUrl(slug, path)} alt="" onError={() => setBroken(true)} />;
  }
  return <Icon name={fileIcon(path)} size={11} />;
}

/**
 * Report 79: the files attached in the composer, each removable, and (round 1) the uploads still on their way, with a
 * spinner: the message waits for them.
 */
export function AttachedChips({ slug, paths, pending, onRemove, onCancel }: { slug: string; paths: readonly string[]; pending: readonly PendingUpload[]; onRemove(path: string): void;
  /** Round 2: abandons upload `id` (the file may still reach the library; it is not attached). */
  onCancel(id: number): void }) {
  const t = useT();
  const b = t.web.briefSession;
  const names = pending.flatMap((u) => u.names.map((name, k) => ({ key: `${u.id}:${k}`, id: u.id, name })));
  if (paths.length === 0 && names.length === 0) return null;
  return (
    <div className="ms-composer-pins ms-brief-pins">
      {paths.map((path) => {
        const name = path.split('/').pop() ?? path;
        return (
          <span key={path} className="ms-chip ms-on ms-composer-pin ms-brief-pin" title={path}>
            <ChipFace slug={slug} path={path} />
            <span className="ms-brief-pin-name">{name}</span>
            <button type="button" className="ms-x" aria-label={b.removePin({ name })} onClick={() => onRemove(path)}><Icon name="close" size={10} /></button>
          </span>
        );
      })}
      {names.map((n) => (
        <span key={n.key} role="status" aria-label={t.web.chat.uploading({ name: n.name })} className="ms-chip ms-composer-pin ms-brief-pin ms-attach-pending">
          <Spinner size={11} decorative /><span className="ms-brief-pin-name">{n.name}</span>
          <button type="button" className="ms-x" aria-label={t.web.chat.cancelUpload({ name: n.name })} onClick={() => onCancel(n.id)}><Icon name="close" size={10} /></button>
        </span>
      ))}
    </div>
  );
}
