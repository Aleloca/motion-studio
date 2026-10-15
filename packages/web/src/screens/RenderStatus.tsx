// The format view's render status (UX feedback 1, Task 3): next to the version, a pill that says whether what is on screen
// is the live preview or a rendered video ("Live preview" / "Rendering 42%" / "Video ready · 12.4 MB"), and the
// "Render video" action. Both come from the existing render model (`boardRender`): the version's records against the live
// render jobs. A render counts as current only while its composition hash is the version's (`renderState`), so a new
// version or an editor save (a new version with a new hash) is "Live preview" again with nothing to remember or time out.
import type { JobSummary, VersionEntry } from '@motion-studio/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { desktop } from '../desktop.ts';
import { formatNumber, useLocale, useT } from '../i18n.tsx';
import { message } from '../errors.ts';
import { isMac } from '../platform.ts';
import { Button, Icon, Pill, ProgressBar, Tooltip, toast } from '../ui/index.ts';
import { outputUrl } from './canvasModel.ts';
import { boardRender } from './renderModel.ts';

export interface RenderStatusProps {
  slug: string; creative: string;
  /** The version on screen and the format it renders (a follower's is its primary's). */
  version: VersionEntry | null; format: string; label: string;
  jobs: JobSummary[]; jobKey: string;
  /** An agent turn is at work: the composition is about to change, so no render is offered. */
  busy: boolean;
  /** An image format (Phase 14): "Image ready" / "Set ready · N files" instead of the video's texts. Default: a video. */
  image?: boolean;
}

export function RenderStatus({ slug, creative, version, format, label, jobs, jobKey, busy, image = false }: RenderStatusProps) {
  const t = useT();
  const locale = useLocale();
  const r = t.web.render;
  const state = boardRender(version, format, jobs, jobKey);
  const out = version?.outputs.find((o) => o.format === format) ?? null;
  const url = version && out ? outputUrl(slug, creative, version.n, out.file) : null;
  const done = state?.kind === 'rendered' || state?.kind === 'problem';
  // An identity format's render is a set of files: the pill says how many.
  const setCount = image ? out?.identitySet?.files.length ?? null : null;

  // The file's size, read once per render (its hash tells a new file of the same version from the old one).
  const sizeKey = !image && done && url ? `${url}|${out?.sha256 ?? ''}` : null;
  const [size, setSize] = useState<{ key: string; bytes: number | null } | null>(null);
  useEffect(() => {
    if (sizeKey === null || !url) return;
    let alive = true;
    void api.fileBytes(url).then((bytes) => { if (alive) setSize({ key: sizeKey, bytes }); });
    return () => { alive = false; };
  }, [sizeKey, url]);
  const bytes = size && size.key === sizeKey ? size.bytes : null;

  const [starting, setStarting] = useState(false);
  // A new version or format: a start that was in flight is no longer this one's.
  const scope = version ? `${version.n}/${format}` : '';
  const current = useRef(scope);
  current.current = scope;
  useEffect(() => { setStarting(false); }, [scope]);
  useEffect(() => () => { current.current = ''; }, []);
  if (!version || !state) return null;

  const start = async () => {
    const key = scope;
    setStarting(true);
    try { await api.renderVersion(slug, creative, version.n, [format]); }
    // Another version or format on screen since the click: its failure is not news here.
    catch (e) { if (current.current === key) toast.show(r.startFailed({ detail: message(e) })); }
    finally { if (current.current === key) setStarting(false); }
  };
  const bridge = desktop();
  const reveal = isMac() ? t.web.canvas.versions.showInFinder : t.web.canvas.versions.showInFolder;
  const working = state.kind === 'queued' || state.kind === 'rendering';
  const sizeText = bytes !== null ? sizeLabel(bytes, (n) => formatNumber(locale, n, { maximumFractionDigits: 1 })) : null;

  // What shows, and what a screen reader hears: the pill ticks every percent, the announcement does not.
  const shown = state.kind === 'rendering' ? r.rendering({ pct: state.pct })
    : state.kind === 'queued' ? (state.ahead ? r.queuedAhead({ count: state.ahead }) : r.queued)
    : state.kind === 'rendered' ? (image ? (setCount !== null && setCount > 0 ? r.setReady({ count: setCount }) : r.imageReady) : r.videoReady({ size: sizeText }))
    : state.kind === 'problem' ? (image ? r.imageProblems : r.videoProblems)
    : state.kind === 'failed' ? r.failedState
    : r.livePreview;
  // The announcement is the state alone: no percent while rendering, no size when ready (the size is for the eyes).
  const renderingSr = image ? r.renderingImageSr : r.renderingVideoSr;
  const spoken = state.kind === 'rendering' ? renderingSr : state.kind === 'rendered' ? (image ? shown : r.videoReady({ size: null })) : shown;
  const tone = state.kind === 'rendered' ? 'ok' : state.kind === 'problem' || state.kind === 'failed' ? 'warn' : working ? 'accent' : 'neutral';

  return (
    <span className="ms-fv-render">
      <Pill tone={tone} spinner={working} dot={!working && state.kind !== 'rendered'} className="ms-fv-render-pill">
        <span aria-hidden="true" title={state.kind === 'none' && !image ? r.livePreviewHint : undefined}>
          {!image && state.kind === 'rendered' && sizeText !== null
            // A narrow bar drops the size (format.css, the bar's container query): the long and the short text, one shown.
            ? <><span className="ms-fv-render-long">{shown}</span><span className="ms-fv-render-short">{r.videoReady({ size: null })}</span></>
            : shown}
        </span>
      </Pill>
      {state.kind === 'rendering' ? <ProgressBar value={state.pct} label={renderingSr} className="ms-fv-render-bar" /> : null}
      <span className="ms-sr" role="status" aria-live="polite">{spoken}</span>
      {done ? (
        bridge ? (
          <Tooltip label={reveal} whenHidden=".ms-bar-label"><Button size="sm" variant="outline" className="ms-fold-1" aria-label={reveal} onClick={() => { void api.revealVersion(slug, creative, version.n).catch((e: unknown) => toast.show(t.web.canvas.versions.actionFailed({ detail: message(e) }))); }}>
            <Icon name="folder" size={13} /><span className="ms-bar-label">{reveal}</span>
          </Button></Tooltip>
        ) : url ? (
          <Tooltip label={image ? r.downloadImageOf({ label }) : r.downloadVideoOf({ label })} whenHidden=".ms-bar-label"><Button size="sm" variant="outline" className="ms-fold-1" aria-label={image ? r.downloadImageOf({ label }) : r.downloadVideoOf({ label })} onClick={() => download(url, out?.file ?? (image ? 'image.png' : 'video.mp4'))}>
            <Icon name="download" size={13} /><span className="ms-bar-label">{r.downloadVideo}</span>
          </Button></Tooltip>
        ) : null
      ) : null}
      {!working ? (
        <Tooltip label={image ? r.renderImageOf({ label }) : r.renderVideoOf({ label })} whenHidden=".ms-bar-label"><Button size="sm" variant={done ? 'ghost' : 'outline'} className={done ? 'ms-fold-1' : 'ms-fold-3'} disabled={busy} loading={starting} aria-label={image ? r.renderImageOf({ label }) : r.renderVideoOf({ label })} onClick={() => void start()}>
          <Icon name={image ? 'image' : 'video'} size={13} /><span className="ms-bar-label">{done ? r.renderAgain : image ? r.renderImage : r.renderVideo}</span>
        </Button></Tooltip>
      ) : null}
    </span>
  );
}

/** The browser saves the file (same origin, so `download` is honoured). */
function download(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** `12.4 MB`: decimal units like the file manager's, one decimal from KB up (the assets helper rounds 10+ to whole numbers). */
function sizeLabel(bytes: number, fmt: (n: number) => string): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes, u = 0;
  while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
  return `${fmt(u === 0 ? v : Math.round(v * 10) / 10)} ${units[u]}`;
}
