// The Export control of the top bars (decision 974: "only Export, no Render"; user report 19). There is no Render button
// any more: Export renders what it needs. While an export of the creative runs, the control says so inside itself
// ("Exporting 26%", a fill behind the text); a render the agent started (or one on its way to an export) shows the same way
// ("Rendering 26%"). No bar or pill appears next to it.
// Report 50: at rest it is a normal button (its icon and "Export"); while it works it widens, with its own animation (`stretch`),
// to the widest of its working texts (they sit in one grid cell, so a new percent never moves it), and shrinks back at the end.
import { exportJobPrefixOf, renderJobsPct, type JobSummary, type VersionEntry } from '@motion-studio/shared';
import { useLayoutEffect, useRef } from 'react';
import { useT } from '../i18n.tsx';
import { stretch } from '../motion/index.ts';
import { Button, Icon, Spinner, cx } from '../ui/index.ts';
import { boardRender } from './renderModel.ts';
import './export.css';

export interface ExportButtonProps {
  jobs: readonly JobSummary[];
  /** The creative's job key (`creative:<root>:<project>:<creative>`): its export and render jobs. */
  jobKey: string | null;
  /** The editor: the version and format on screen (only their render shows). Absent: any render of the creative. */
  scope?: { version: VersionEntry | null; format: string } | null;
  disabled?: boolean;
  /**
   * Not the bar's primary action (an outline control): on the variants page "Selezione finale" is (decision 1045), so the
   * bar's Export steps back there (user report 17: one filled action per bar).
   */
  secondary?: boolean;
  onClick(): void;
}

export type ExportActivity = { kind: 'export' | 'render'; pct: number | null };

const active = (j: JobSummary) => j.state === 'queued' || j.state === 'running';

/** What the Export control shows: an export of the creative (its renders' percent), else a render in progress, else nothing. */
export function exportActivity(jobs: readonly JobSummary[], jobKey: string | null, scope?: ExportButtonProps['scope']): ExportActivity | null {
  const prefix = jobKey ? exportJobPrefixOf(jobKey) : null;
  const exporting = prefix ? jobs.find((j) => j.kind === 'export' && active(j) && j.key.startsWith(prefix)) : undefined;
  if (exporting) {
    const info = exporting.export;
    return { kind: 'export', pct: info?.stage === 'rendering' && info.renders?.length ? info.pct ?? 0 : null };
  }
  if (!jobKey?.startsWith('creative:')) return null;
  if (scope) {
    const r = boardRender(scope.version, scope.format, [...jobs], jobKey);
    return r?.kind === 'rendering' ? { kind: 'render', pct: r.pct } : r?.kind === 'queued' ? { kind: 'render', pct: null } : null;
  }
  const rest = jobKey.slice('creative:'.length);
  const renders = jobs.filter((j) => j.kind === 'render' && active(j) && (j.key.startsWith(`render:${rest}:v`) || j.key.startsWith(`render-export:${rest}:v`)));
  if (!renders.length) return null;
  return { kind: 'render', pct: renders.some((j) => j.state === 'running') ? renderJobsPct(renders) : null };
}

/** The control's running width animations (its `stretch`), not its other transitions. */
function widthAnimations(el: Element): Animation[] {
  if (typeof el.getAnimations !== 'function') return [];
  return el.getAnimations().filter((a) => (a.effect as KeyframeEffect | null)?.getKeyframes?.().some((k) => 'width' in k) === true);
}

export function ExportButton({ jobs, jobKey, scope, disabled, secondary, onClick }: ExportButtonProps) {
  const t = useT();
  const x = t.web.exportUi;
  const r = t.web.render;
  const a = exportActivity(jobs, jobKey, scope);
  const text = !a ? t.web.canvas.export
    : a.kind === 'export' ? (a.pct !== null ? x.exportingPct({ pct: a.pct }) : x.running)
    : a.pct !== null ? r.rendering({ pct: a.pct }) : r.queued;
  const widest = [x.exportingPct({ pct: 100 }), x.running, r.rendering({ pct: 100 }), r.queued];
  const working = a !== null;
  // Its laid-out width (never an in-flight one): when it starts or stops working it moves from there to its new width, or from
  // where a stretch still running has got to (an export that fails mid-grow shrinks back from there: decision 1335).
  const ref = useRef<HTMLButtonElement>(null);
  const width = useRef<number | null>(null);
  const was = useRef(working);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const moving = widthAnimations(el);
    if (was.current !== working) {
      const shown = el.getBoundingClientRect().width;
      for (const m of moving) m.cancel();
      const now = el.getBoundingClientRect().width;
      if (width.current !== null) void stretch(el, moving.length ? shown : width.current);
      width.current = now;
    } else if (!moving.length) width.current = el.getBoundingClientRect().width;
    was.current = working;
  });
  return (
    <Button ref={ref} variant={secondary ? 'outline' : 'ink'} className={cx('ms-cv-export ms-exp-ctl', a && 'ms-working')} disabled={disabled} onClick={onClick}>
      {a && a.pct !== null ? <span className="ms-exp-ctl-fill" style={{ width: `${a.pct}%` }} aria-hidden="true" /> : null}
      {a ? <Spinner decorative size={13} /> : <Icon name="download" size={13} strokeWidth={1.7} />}
      {working ? (
        <span className="ms-exp-ctl-label">
          {widest.map((w) => <span key={w} className="ms-exp-ctl-sizer" aria-hidden="true">{w}</span>)}
          <span className="ms-exp-ctl-text">{text}</span>
        </span>
      ) : <span className="ms-exp-ctl-text">{text}</span>}
    </Button>
  );
}
