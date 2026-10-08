// Export (spec §6.2 #14, points 44–45; prototype ExportDialog): one row per format of the version with its thumbnail,
// final file name and a check; the destination (native picker on desktop, a field on the web) is remembered; progress,
// then a success screen with Show in Finder. File sizes are not shown: the API does not report them (ruling R6).
import type { FormatPreset, VersionEntry } from '@motion-studio/shared';
import { useEffect, useId, useState } from 'react';
import { api } from '../api.ts';
import { desktop } from '../desktop.ts';
import { exportFileName } from '../exportName.ts';
import { useLocale, useT } from '../i18n.tsx';
import { pop } from '../motion/index.ts';
import { isMac } from '../shell/ShellContext.tsx';
import { Button, ChannelMark, Check, Icon, Input, Modal, cx } from '../ui/index.ts';
import { boardLabel } from './CanvasBoard.tsx';
import { outputMedia } from './canvasModel.ts';
import { channelOf } from './creativeState.ts';

/** The last destination folder, kept in this browser only. */
export const EXPORT_FOLDER_KEY = 'ms.exportFolder';
const readFolder = () => { try { return localStorage.getItem(EXPORT_FOLDER_KEY) ?? ''; } catch { return ''; } };
const writeFolder = (v: string) => { try { localStorage.setItem(EXPORT_FOLDER_KEY, v); } catch { /* private mode */ } };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface ExportDialogProps {
  open: boolean;
  onClose(): void;
  slug: string;
  creative: string;
  title: string;
  /** The version being exported, fixed when the dialog opened (a new version does not retarget it). */
  version: VersionEntry | null;
  presets: FormatPreset[];
}

export function ExportDialog(p: ExportDialogProps) {
  const t = useT();
  // While the copy runs the dialog stays: closing it would hide an export that still writes files.
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={p.open} onClose={p.onClose} label={t.web.exportUi.title({ title: p.title })} width={760} dismissible={!busy}>
      {p.version ? <ExportBody key={p.version.n} {...p} version={p.version} onBusy={setBusy} /> : null}
    </Modal>
  );
}

type Phase = { kind: 'idle' } | { kind: 'run' } | { kind: 'done'; destination: string; count: number; skipped: string[] };

function ExportBody({ onClose, slug, creative, title, version, presets, onBusy }: ExportDialogProps & { version: VersionEntry; onBusy(busy: boolean): void }) {
  const t = useT();
  const x = t.web.exportUi;
  const locale = useLocale();
  const bridge = desktop();
  const outputs = version.outputs;
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(outputs.map((o) => [o.format, true])));
  const [folder, setFolder] = useState(readFolder);
  const remembered = folder !== '' && folder === readFolder();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const chosen = outputs.filter((o) => on[o.format]).map((o) => o.format);
  const running = phase.kind === 'run';
  const labelId = useId();
  useEffect(() => { onBusy(running); }, [running, onBusy]);
  useEffect(() => () => onBusy(false), [onBusy]);
  const reveal = isMac() ? x.showInFinder : x.showInFolder;

  const choose = async () => {
    setError(null);
    try {
      const picked = await bridge?.pickFolder(x.pickTitle, folder.trim() || undefined);
      if (picked) setFolder(picked);
    } catch (e) { setError(message(e)); }
  };
  const run = async () => {
    const dest = folder.trim();
    if (!dest || !chosen.length || running) return;
    setError(null);
    setPhase({ kind: 'run' });
    try {
      const r = await api.exportVersion(slug, creative, version.n, dest, chosen);
      writeFolder(dest);
      setPhase({ kind: 'done', destination: r.destination, count: r.files.length, skipped: r.skipped ?? [] });
    } catch (e) {
      setError(message(e));
      setPhase({ kind: 'idle' });
    }
  };

  const head = (
    <div className="ms-exp-head">
      <div className="ms-exp-titles">
        <h2>{x.title({ title })}</h2>
        <span className="ms-exp-sub">{x.sub({ n: version.n })}</span>
      </div>
      <Button variant="ghost" icon aria-label={t.common.close} disabled={running} onClick={onClose}><Icon name="close" size={13} strokeWidth={1.6} /></Button>
    </div>
  );

  if (phase.kind === 'done') {
    return (
      <div className="ms-exp">
        {head}
        <div className="ms-exp-done" role="status">
          <span className="ms-exp-done-mark" ref={(el) => { if (el) void pop(el); }}><Icon name="check" size={24} strokeWidth={2.2} /></span>
          <b>{x.done({ count: phase.count })}</b>
          <span className="ms-exp-path">{phase.destination}</span>
          {phase.skipped.length ? <span className="ms-exp-skipped">{x.skipped({ list: phase.skipped.join(', ') })}</span> : null}
          {error ? <p role="alert" className="ms-exp-error">{error}</p> : null}
          <div className="ms-exp-done-actions">
            {bridge ? (
              <Button variant="outline" onClick={() => { bridge.revealPath(phase.destination).catch((e: unknown) => setError(message(e))); }}>
                <Icon name="folder" size={14} />{reveal}
              </Button>
            ) : null}
            <Button variant="ink" onClick={onClose}>{x.finish}</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ms-exp">
      {head}
      {outputs.length ? (
        <div className="ms-exp-rows">
          <div className="ms-exp-row ms-exp-cols ms-cap" aria-hidden="true"><span /><span /><span>{x.format}</span><span>{x.version}</span></div>
          {outputs.map((o) => {
            const preset = presets.find((pr) => pr.id === o.format) ?? null;
            const label = boardLabel({ id: o.format, preset, out: o }, locale);
            const media = outputMedia(slug, creative, version.n, o);
            const aspect = preset ? preset.width / preset.height : o.width / o.height;
            return (
              <div key={o.format} className={cx('ms-exp-row', !on[o.format] && 'ms-off')}>
                <Check on={Boolean(on[o.format])} label={x.include({ label })} disabled={running} onChange={(v) => setOn((s) => ({ ...s, [o.format]: v }))} />
                <span className={cx('ms-exp-thumb', aspect > 1.05 ? 'ms-wide' : aspect < 0.95 ? 'ms-tall' : 'ms-square')} aria-hidden="true">
                  {media.video ? <video src={media.src} muted preload="metadata" /> : <img src={media.src} alt="" />}
                </span>
                <span className="ms-exp-name">
                  <span className="ms-exp-label">{preset ? <ChannelMark channel={channelOf(preset.channel)} /> : null}<b>{label}</b></span>
                  <span className="ms-exp-file">{exportFileName({ title, creative, format: o.format, n: version.n, file: o.file })}</span>
                </span>
                <span className="ms-exp-ver">v{version.n}</span>
              </div>
            );
          })}
        </div>
      ) : <p className="ms-exp-empty">{x.empty}</p>}
      <div className="ms-exp-dest">
        <span className="ms-exp-dest-label" id={labelId}>{x.saveTo}</span>
        <div className="ms-exp-dest-field">
          {bridge ? (
            <div className="ms-exp-folder" aria-labelledby={labelId}>
              <Icon name="folder" size={14} />
              <span className={cx('ms-exp-path', !folder && 'ms-faint')}>{folder || x.noFolder}</span>
              {remembered ? <span className="ms-exp-last">{x.lastUsed}</span> : null}
            </div>
          ) : (
            <Input aria-label={x.folder} value={folder} disabled={running} placeholder={x.placeholder} spellCheck={false}
              onChange={(e) => setFolder(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} />
          )}
          {bridge ? <Button variant="outline" disabled={running} onClick={() => void choose()}>{x.choose}</Button> : null}
        </div>
      </div>
      <div className="ms-exp-foot">
        {running ? (
          <div className="ms-exp-progress">
            <span>{x.running}</span>
            {/* One request copies every file: there is no per-file progress to show. */}
            <div className="ms-progress ms-indet" role="progressbar" aria-label={x.running}><i /></div>
          </div>
        ) : (
          <div className="ms-exp-summary">
            <b>{x.files({ count: chosen.length })}</b>
            {error ? <span role="alert" className="ms-exp-error">{error}</span> : <span className="ms-exp-note">{x.noOverwrite}</span>}
          </div>
        )}
        <Button size="lg" variant="ghost" disabled={running} onClick={onClose}>{t.common.cancel}</Button>
        <Button size="lg" variant="ink" loading={running} disabled={!chosen.length || !folder.trim() || running} onClick={() => void run()}>
          {x.run({ count: chosen.length })}
        </Button>
      </div>
    </div>
  );
}
