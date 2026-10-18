// The Export control of the top bars (decision 974: "only Export, no Render"; user report 19). There is no Render button
// any more: Export renders what it needs. While an export of the creative runs, the control says so inside itself
// ("Exporting 26%", a fill behind the text); a render the agent started (or one on its way to an export) shows the same way
// ("Rendering 26%"). Every text the control may show sits in one grid cell, the hidden ones setting the width: the control
// never changes size, and no bar or pill appears next to it.
import { exportJobPrefixOf, renderJobsPct, type JobSummary, type VersionEntry } from '@motion-studio/shared';
import { useT } from '../i18n.tsx';
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

export function ExportButton({ jobs, jobKey, scope, disabled, onClick }: ExportButtonProps) {
  const t = useT();
  const x = t.web.exportUi;
  const r = t.web.render;
  const a = exportActivity(jobs, jobKey, scope);
  const text = !a ? t.web.canvas.export
    : a.kind === 'export' ? (a.pct !== null ? x.exportingPct({ pct: a.pct }) : x.running)
    : a.pct !== null ? r.rendering({ pct: a.pct }) : r.queued;
  const widest = [t.web.canvas.export, x.exportingPct({ pct: 100 }), x.running, r.rendering({ pct: 100 }), r.queued];
  return (
    <Button variant="ink" className={cx('ms-cv-export ms-exp-ctl', a && 'ms-working')} disabled={disabled} onClick={onClick}>
      {a && a.pct !== null ? <span className="ms-exp-ctl-fill" style={{ width: `${a.pct}%` }} aria-hidden="true" /> : null}
      {a ? <Spinner decorative size={13} /> : <Icon name="download" size={13} strokeWidth={1.7} />}
      <span className="ms-exp-ctl-label">
        {widest.map((w) => <span key={w} className="ms-exp-ctl-sizer" aria-hidden="true">{w}</span>)}
        <span className="ms-exp-ctl-text">{text}</span>
      </span>
    </Button>
  );
}
