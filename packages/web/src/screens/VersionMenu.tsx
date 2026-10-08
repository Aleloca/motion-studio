// The creative's version history (prototype VersionsPopover; spec §6.2 #6, point 41): per creative in Phase 7 (per
// format with Phase 9), so no ★ and no per-format versions. Thumbnail, number, time and the request that made it;
// Compare, "Restart from here" with what it means, and Show in Finder.
import type { VersionEntry } from '@motion-studio/shared';
import { formatDate, TIME_OF_DAY, useLocale, useT } from '../i18n.tsx';
import { isMac } from '../shell/ShellContext.tsx';
import { Button, Icon, Pill, cx } from '../ui/index.ts';
import { versionThumb } from './canvasModel.ts';

export interface VersionMenuProps {
  slug: string;
  creative: string;
  versions: VersionEntry[];
  /** The version on the canvas. */
  shown: number;
  onPick(n: number): void;
  onCompare(): void;
  onRestart(n: number): void;
  onReveal(n: number): void;
}

const sameDay = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();

export function VersionMenu({ slug, creative, versions, shown, onPick, onCompare, onRestart, onReveal }: VersionMenuProps) {
  const t = useT();
  const v = t.web.canvas.versions;
  const locale = useLocale();
  const latest = versions.at(-1)?.n ?? 0;
  const when = (iso: string) => formatDate(locale, iso, sameDay(iso) ? TIME_OF_DAY : { day: 'numeric', month: 'short', ...TIME_OF_DAY });
  return (
    <div className="ms-vmenu" role="dialog" aria-label={v.title}>
      <div className="ms-vmenu-head"><b>{v.title}</b><span className="ms-vmenu-count">{versions.length}</span></div>
      <div className="ms-vmenu-list">
        {[...versions].reverse().map((ver) => {
          const thumb = versionThumb(slug, creative, ver);
          const note = ver.request.trim() || v.fromBrief;
          return (
            <button key={ver.n} type="button" data-row="" className={cx('ms-vmenu-row', ver.n === shown && 'ms-on')} aria-pressed={ver.n === shown}
              aria-label={`${t.web.ui.version({ n: ver.n })} · ${when(ver.createdAt)} · ${note}`} onClick={() => onPick(ver.n)}>
              <span className="ms-vmenu-thumb" aria-hidden="true">
                {thumb ? (thumb.video ? <video src={thumb.src} muted preload="metadata" /> : <img src={thumb.src} alt="" />) : <Icon name="image" size={14} />}
              </span>
              <span className="ms-vmenu-text">
                <span className="ms-vmenu-line"><b>v{ver.n}</b><span className="ms-vmenu-when">{when(ver.createdAt)}</span>
                  {ver.status === 'incomplete' ? <Pill tone="warn">{v.incomplete}</Pill> : null}</span>
                <span className="ms-vmenu-note">{note}</span>
              </span>
            </button>
          );
        })}
      </div>
      {shown !== latest ? <p className="ms-vmenu-explain">{v.restartNote({ n: shown })}</p> : null}
      <div className="ms-vmenu-foot">
        <Button size="sm" className="ms-grow" disabled={versions.length < 2} onClick={onCompare}>{v.compare}</Button>
        {shown !== latest ? <Button size="sm" className="ms-grow" onClick={() => onRestart(shown)}>{v.restart}</Button> : null}
        <Button size="sm" variant="ghost" icon aria-label={isMac() ? v.showInFinder : v.showInFolder} title={isMac() ? v.showInFinder : v.showInFolder} onClick={() => onReveal(shown)}>
          <Icon name="folder" size={14} />
        </Button>
      </div>
    </div>
  );
}
