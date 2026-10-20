import type { AssetEntry } from '@motion-studio/shared';
import type { RefObject } from 'react';
import { api } from '../../api.ts';
import { useT } from '../../i18n.tsx';
import { isVideoFile } from '../../media.ts';
import { href } from '../../routes.ts';
import { go } from '../../shell/ShellContext.tsx';
import { Button, Empty, Icon, Popover, Spinner, cx, type PopoverPlacement } from '../../ui/index.ts';

const VISUAL = /^(image|svg|video)$/;
const baseName = (path: string) => path.split('/').pop() ?? path;
/** Brief paths are project paths; the library lists files inside `assets/`. */
export const assetPath = (file: string) => `assets/${file}`;

/** Thumbnail of a library file: the picture for images, SVGs and videos; an icon and the name otherwise. */
export function AssetFace({ slug, path, entry, small }: { slug: string; path: string; entry: AssetEntry | null; small?: boolean }) {
  const kind = entry?.kind ?? (isVideoFile(path) ? 'video' : /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(path) ? 'image' : 'other');
  const url = api.projectFileUrl(slug, path);
  if (VISUAL.test(kind)) {
    return kind === 'video'
      ? <video className={cx('ms-nc-face', small && 'ms-sm')} src={url} muted preload="metadata" aria-hidden="true" />
      : <img className={cx('ms-nc-face', kind === 'svg' && 'ms-nc-face-svg', small && 'ms-sm')} src={url} alt="" />;
  }
  if (small) return <span className="ms-nc-face ms-sm ms-nc-face-file" aria-hidden="true"><Icon name="folder" size={10} /></span>;
  return <span className="ms-nc-face ms-nc-face-file" aria-hidden="true"><Icon name={kind === 'audio' ? 'play' : 'folder'} size={14} /><span>{baseName(path)}</span></span>;
}

export interface LibraryPickerProps {
  slug: string;
  projectName: string;
  open: boolean;
  onClose(): void;
  anchor: RefObject<HTMLElement | null>;
  placement?: PopoverPlacement;
  library: { value: AssetEntry[] | null; error: string | null };
  onRetry(): void;
  /** The project paths (`assets/…`) chosen now. */
  chosen: readonly string[];
  onToggle(path: string): void;
}

/**
 * The project's library as a 4-column grid in a popover, multi-select (New creative's asset picker; decision 1414: also the
 * brief session's "Asset dalla libreria"). Fonts are left out.
 */
export function LibraryPicker({ slug, projectName, open, onClose, anchor, placement = 'bottom-end', library, onRetry, chosen, onToggle }: LibraryPickerProps) {
  const n = useT().web.newCreative;
  const items = (library.value ?? []).filter((a) => a.kind !== 'font');
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement={placement} width={360}>
      <div role="dialog" aria-label={n.libraryTitle({ project: projectName })} className="ms-nc-picker">
        <span className="ms-nc-cap ms-nc-ell">{n.libraryTitle({ project: projectName })}</span>
        {library.value === null && !library.error ? (
          <div className="ms-nc-pick-state" role="status"><Spinner size={14} decorative />{n.libraryLoading}</div>
        ) : library.error && library.value === null ? (
          <div className="ms-nc-pick-state ms-nc-wrap" role="alert">
            <span>{n.libraryFailed({ detail: library.error })}</span>
            <Button size="sm" variant="outline" onClick={onRetry}>{n.tryAgain}</Button>
          </div>
        ) : null}
        {library.error && library.value !== null ? (
          <p className="ms-nc-pick-warn" role="status"><Icon name="warn" size={13} /><span>{n.libraryPartial({ detail: library.error })}</span></p>
        ) : null}
        {library.value === null ? null : items.length === 0 ? (
          <Empty icon="image" title={n.libraryEmpty} sub={n.libraryEmptyBody} action={<Button size="sm" variant="outline" onClick={() => { onClose(); go(href.project(slug, 'assets')); }}>{n.openAssets}</Button>} />
        ) : (
          <div className="ms-nc-pick-grid">
            {items.map((a) => {
              const path = assetPath(a.file);
              const on = chosen.includes(path);
              return (
                <button key={a.file} type="button" data-row className={cx('ms-nc-pick', on && 'ms-on')} aria-pressed={on} aria-label={a.file} title={a.description || a.file} onClick={() => onToggle(path)}>
                  <AssetFace slug={slug} path={path} entry={a} />
                  {on ? <span className="ms-nc-tick" aria-hidden="true"><Icon name="check" size={10} strokeWidth={2.4} /></span> : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Popover>
  );
}
