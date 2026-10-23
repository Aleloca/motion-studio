import { assetKindOf, type AssetEntry } from '@motion-studio/shared';
import { useContext, useRef, useState } from 'react';
import { api } from '../api.ts';
import { message as errText } from '../errors.ts';
import { useT } from '../i18n.tsx';
import { ShellContext } from '../shell/ShellContext.tsx';
import { ContextPins, PlusMenu } from '../screens/new-creative/BriefContext.tsx';
import { LibraryPicker, assetPath } from '../screens/new-creative/LibraryPicker.tsx';
import '../screens/new-creative/briefsession.css';
import '../screens/newcreative.css';

/**
 * Report 79: the creative chat's "+": files from the computer (saved in the project library, then attached) or from the
 * library. `chosen`: the project paths (`assets/…`) attached now; the composer sends them with its next message.
 */
export function AttachButton({ slug, chosen, onAdd, onRemove, onError, disabled }: {
  slug: string; chosen: readonly string[]; onAdd(paths: string[]): void; onRemove(path: string): void; onError(text: string | null): void; disabled?: boolean;
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
    // A library asset (not a brief's reference: those are swept when no creative's brief uses them).
    try {
      const r = await api.uploadFiles(slug, 'assets', files);
      const paths = (r.assets ?? []).map((a) => assetPath(a.file));
      if (paths.length) onAdd(paths);
      if (library.value !== null) load();
    } catch (e) { onError(t.web.briefSession.uploadFailed({ detail: errText(e) })); }
  };
  return (
    <>
      <PlusMenu label={c.attach} menuLabel={c.attachMenu} disabled={disabled} className="ms-composer-attach" items={[
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

/** Report 79: the files attached in the composer, each removable (the brief's pins, with the picture for images). */
export function AttachedChips({ slug, paths, onRemove }: { slug: string; paths: readonly string[]; onRemove(path: string): void }) {
  const visual = (path: string) => { const k = assetKindOf(path); return k === 'image' || k === 'svg'; };
  return <ContextPins pins={paths.map((path) => ({ kind: 'asset' as const, path }))} onRemove={(p) => onRemove(p.path)}
    thumb={(path) => (visual(path) ? api.projectFileUrl(slug, path) : null)} />;
}
