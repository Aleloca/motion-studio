// The version button of the creative bar and its history popover, shared by the canvas and the format view: pick a
// version, Compare, "Restart from here" (with Undo back to the previous resume point) and Show in Finder. Also the
// T11 notice when a new version lands while the page is the current one.
import type { VersionEntry } from '@motion-studio/shared';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { api } from '../api.ts';
import { useT } from '../i18n.tsx';
import { pop } from '../motion/index.ts';
import { Icon, Popover, cx, toast } from '../ui/index.ts';
import { VersionMenu } from './VersionMenu.tsx';

export interface VersionControlProps {
  slug: string;
  creative: string;
  versions: VersionEntry[];
  /** The version on screen. */
  version: VersionEntry;
  /** The version the next change resumes from, when one was chosen. */
  resumeFrom: number | null;
  /** The button, for the T11 spring. */
  buttonRef: RefObject<HTMLButtonElement | null>;
  onPick(n: number): void;
  onCompare(): void;
  /** After a restart (or its Undo): the creative changed. */
  onChanged(): void;
  /** A version action failed; `null` when a new one starts. */
  onError(message: string | null): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function VersionControl({ slug, creative, versions, version, resumeFrom, buttonRef, onPick, onCompare, onChanged, onError }: VersionControlProps) {
  const t = useT();
  const c = t.web.canvas.versions;
  const [open, setOpen] = useState(false);
  const act = (p: () => Promise<unknown>, then?: () => void) => {
    onError(null);
    Promise.resolve().then(p).then(() => then?.()).catch((e: unknown) => onError(c.actionFailed({ detail: message(e) })));
  };
  return (
    <>
      <button ref={buttonRef} type="button" className={cx('ms-btn ms-outline ms-cv-vbtn', open && 'ms-open')} aria-haspopup="dialog" aria-expanded={open}
        aria-label={c.menu({ n: version.n, total: versions.length })} onClick={() => setOpen((o) => !o)}>
        <span>{c.button({ n: version.n, total: versions.length })}</span><Icon name="chevron" size={11} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={buttonRef} placement="bottom-end" width={320}>
        <VersionMenu slug={slug} creative={creative} versions={versions} shown={version.n} resumeFrom={resumeFrom}
          onPick={(v) => { onPick(v); setOpen(false); }}
          onCompare={() => { setOpen(false); onCompare(); }}
          onRestart={(v) => {
            setOpen(false);
            // Undo restores exactly the previous resume point. Without one (the latest) there is nothing exact to
            // restore (the core cannot clear a resume point): no Undo; the menu offers the latest explicitly.
            const previous = resumeFrom;
            act(() => api.restoreVersion(slug, creative, v), () => {
              onChanged();
              toast.show(c.restarted({ n: v }), {
                tone: 'ok',
                action: previous !== null && previous !== v ? { label: c.undo, run: () => act(() => api.restoreVersion(slug, creative, previous), onChanged) } : undefined,
              });
            });
          }}
          onReveal={(v) => { setOpen(false); act(() => api.revealVersion(slug, creative, v)); }} />
      </Popover>
    </>
  );
}

/**
 * T11: a version newer than the one seen before → "vN is ready" and a spring on `target`, only while `active` (the
 * page is the route's). The first value seen (the page opening) is not news.
 */
export function useNewVersionNotice(loaded: boolean, latest: number | null, active: boolean, target: RefObject<Element | null>): void {
  const t = useT();
  const seen = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (!loaded) return;
    const prev = seen.current;
    seen.current = latest;
    if (prev === undefined || latest === null || (prev !== null && latest <= prev) || !active) return;
    toast.show(t.web.canvas.versionReady({ n: latest }), { tone: 'ok' });
    void pop(target.current);
  }, [loaded, latest, active, t, target]);
}
