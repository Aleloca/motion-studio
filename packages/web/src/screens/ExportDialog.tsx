// Export the ★ versions (spec §3.3, prototype ExportDialog): one row per format with its thumbnail, final file name,
// "★ vN" (and "vM newer" after a manual pick), a check, and "follows Reel ★ vN" for followers, which export their own
// file from the latest version where that file is byte-identical to the primary's ★ file (decisions log 140), named with that ★. The file name pattern has token chips, a live preview, an inline collision error and
// "Save as default" (the workspace's `exportNamePattern`). The destination (native picker on desktop, a field on the web)
// is remembered; progress, then a success screen with Show in Finder. File sizes are not shown: the API does not report
// them (ruling R6).
import {
  EXPORT_NAME_TOKENS, exportDate, exportExtension, exportNameCollisions, exportNameVars, formatName, renderName,
  type FormatPreset, type VersionEntry, type WorkspaceSettings,
} from '@motion-studio/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { desktop } from '../desktop.ts';
import { useLocale, useT } from '../i18n.tsx';
import { pop } from '../motion/index.ts';
import { isMac } from '../platform.ts';
import { Button, ChannelMark, Check, Chip, Icon, Input, Modal, cx } from '../ui/index.ts';
import { boardLabel } from './CanvasBoard.tsx';
import { outputMedia } from './canvasModel.ts';
import { channelOf } from './creativeState.ts';
import { message } from './common.tsx';
import { exportErrorText } from './versionErrors.ts';
import type { FormatState } from './versionModel.ts';

/** The last destination folder, kept in this browser only. */
export const EXPORT_FOLDER_KEY = 'ms.exportFolder';
const readFolder = () => { try { return localStorage.getItem(EXPORT_FOLDER_KEY) ?? ''; } catch { return ''; } };
const writeFolder = (v: string) => { try { localStorage.setItem(EXPORT_FOLDER_KEY, v); } catch { /* private mode */ } };
/** The workspace settings bound the pattern to 200 characters. */
const PATTERN_MAX = 200;

/** What the dialog exports, taken when it opened (a new version or ★ does not retarget an open export). */
export interface ExportSnapshot { versions: VersionEntry[]; states: Record<string, FormatState> }

export interface ExportDialogProps {
  open: boolean;
  onClose(): void;
  slug: string;
  creative: string;
  title: string;
  snapshot: ExportSnapshot | null;
  presets: FormatPreset[];
  /** The workspace's file name pattern: the field starts with it. */
  pattern: string;
  /** The workspace settings after "Save as default". */
  onSettings?(next: WorkspaceSettings): void;
}

export function ExportDialog(p: ExportDialogProps) {
  const t = useT();
  // While the copy runs the dialog stays: closing it would hide an export that still writes files.
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={p.open} onClose={p.onClose} label={t.web.exportUi.title({ title: p.title })} width={760} dismissible={!busy}>
      {p.snapshot ? <ExportBody {...p} snapshot={p.snapshot} onBusy={setBusy} /> : null}
    </Modal>
  );
}

type Phase = { kind: 'idle' } | { kind: 'run' } | { kind: 'done'; destination: string; count: number; skipped: string[] };
type SaveState = { kind: 'idle' | 'saving' | 'saved' } | { kind: 'failed'; detail: string };

interface Row {
  id: string;
  preset: FormatPreset | null;
  /** The ★ shown and named (`{v}`): the format's ★; a follower: its primary's ★ (decisions log 140). */
  n: number;
  /**
   * The version whose file is copied: `n`, or for a follower its resolved `exportVersion` (the latest version where its file
   * is byte-identical to the primary's ★ file, e.g. a follower added without the agent); null when it has none.
   */
  fileN: number | null;
  /** This format's own file in version `fileN`; null when it has none. */
  output: VersionEntry['outputs'][number] | null;
  /** The primary's short name, for a follower. */
  follows: string | null;
  newer: number | null;
  /** Why the row cannot be exported (it is then unchecked and disabled); null when it can. */
  blocked: string | null;
}

function ExportBody({ onClose, slug, creative, title, snapshot, presets, pattern: initialPattern, onSettings, onBusy }: ExportDialogProps & { snapshot: ExportSnapshot; onBusy(busy: boolean): void }) {
  const t = useT();
  const x = t.web.exportUi;
  const locale = useLocale();
  const bridge = desktop();
  const { versions, states } = snapshot;
  const rows = useMemo<Row[]>(() => Object.values(states).flatMap((s): Row[] => {
    const n = s.follows ? (states[s.follows]?.star.version ?? null) : s.star.version;
    if (n === null) return [];
    const fileN = s.follows ? s.exportVersion : n;
    const output = fileN === null ? null : versions.find((v) => v.n === fileN)?.outputs.find((o) => o.format === s.id) ?? null;
    const primaryPreset = s.follows ? presets.find((pr) => pr.id === s.follows) : undefined;
    const follows = s.follows ? (primaryPreset ? formatName(primaryPreset, locale) : s.follows) : null;
    const blocked = !output
      ? (follows !== null ? x.noFollowerFile({ n, primary: follows }) : x.fileMissing({ n }))
      : s.starFileMissing ? x.fileMissing({ n: fileN ?? n }) : null;
    return [{ id: s.id, preset: presets.find((pr) => pr.id === s.id) ?? null, n, fileN, output, follows, newer: follows === null ? s.star.newer : null, blocked }];
  }), [states, versions, presets, x, locale]);
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(rows.map((r) => [r.id, r.blocked === null])));
  const [pattern, setPattern] = useState(initialPattern);
  const [savedPattern, setSavedPattern] = useState(initialPattern);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  // One date for the preview and the export (sent along, so a dialog left open past midnight keeps its names).
  const [date] = useState(() => exportDate(new Date()));
  const [folder, setFolder] = useState(readFolder);
  const remembered = folder !== '' && folder === readFolder();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const running = phase.kind === 'run';
  const labelId = useId();
  const namesId = useId();
  const previewId = useId();
  useEffect(() => { onBusy(running); }, [running, onBusy]);
  useEffect(() => () => onBusy(false), [onBusy]);
  const reveal = isMac() ? x.showInFinder : x.showInFolder;

  // The final names: the pattern rendered per row with the same shared code as the core, extension added.
  const vars = (r: Row) => exportNameVars({ title, slug: creative, format: r.id, preset: r.preset ?? undefined, size: r.output ?? undefined, version: r.n, date });
  const named = rows.map((r) => {
    const rendered = r.output ? renderName(pattern, vars(r)) : null;
    return { row: r, name: rendered?.ok && r.output ? `${rendered.name}${exportExtension(r.output.file)}` : null };
  });
  // Unknown variables are the same on every row: they are left out of the names and flagged here.
  const first = rows[0] ? renderName(pattern, vars(rows[0])) : null;
  const unknown = first?.unknown ?? [];
  const chosen = named.filter((c) => c.row.blocked === null && on[c.row.id]);
  const tooLong = pattern.length > PATTERN_MAX;
  const empty = !pattern.trim() || first?.ok === false || chosen.some((c) => c.name === null);
  const collisions = exportNameCollisions(chosen.flatMap((c) => (c.name ? [c.name] : [])));
  const nameProblem = tooLong ? x.errors.invalidPattern : empty ? x.emptyName : collisions.length ? x.collision({ list: collisions.join(', ') }) : null;
  const preview = (chosen[0] ?? named.find((c) => c.name !== null))?.name ?? null;

  const insert = (token: string) => {
    const el = field.current;
    const text = `{${token}}`;
    const start = el?.selectionStart ?? pattern.length;
    const end = el?.selectionEnd ?? pattern.length;
    setPattern(pattern.slice(0, start) + text + pattern.slice(end));
    setSave({ kind: 'idle' });
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(start + text.length, start + text.length); } });
  };
  const saveDefault = async () => {
    setSave({ kind: 'saving' });
    try {
      const next = await api.updateSettings({ exportNamePattern: pattern });
      setSavedPattern(next.exportNamePattern);
      setSave({ kind: 'saved' });
      onSettings?.(next);
    } catch (e) { setSave({ kind: 'failed', detail: message(e) }); }
  };
  const choose = async () => {
    setError(null);
    try {
      const picked = await bridge?.pickFolder(x.pickTitle, folder.trim() || undefined);
      if (picked) setFolder(picked);
    } catch (e) { setError(message(e)); }
  };
  const canRun = chosen.length > 0 && folder.trim() !== '' && nameProblem === null && !running;
  const run = async () => {
    const dest = folder.trim();
    if (!canRun) return;
    setError(null);
    setPhase({ kind: 'run' });
    // Followers are never picked on their own: they go with the version whose file the row shows (resolved from their
    // primary's ★), which the core checks against the primary version it exports.
    const picks: Record<string, number> = {};
    const follow: Record<string, number> = {};
    for (const c of chosen) { if (c.row.follows !== null) follow[c.row.id] = c.row.fileN ?? c.row.n; else picks[c.row.id] = c.row.n; }
    try {
      const r = await api.exportPicks(slug, creative, { destination: dest, picks, ...(Object.keys(follow).length ? { follow } : {}), pattern, date });
      writeFolder(dest);
      setPhase({ kind: 'done', destination: r.destination, count: r.files.length, skipped: r.skipped ?? [] });
    } catch (e) {
      setError(exportErrorText(e, t));
      setPhase({ kind: 'idle' });
    }
  };

  const head = (
    <div className="ms-exp-head">
      <div className="ms-exp-titles">
        <h2>{x.heading}</h2>
        <span className="ms-exp-sub">{x.sub({ title })}</span>
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
      {rows.length ? (
        <div className="ms-exp-rows">
          <div className="ms-exp-row ms-exp-cols ms-cap" aria-hidden="true"><span /><span /><span>{x.format}</span><span>{x.version}</span></div>
          {named.map(({ row: r, name }) => {
            const label = boardLabel({ id: r.id, preset: r.preset, out: r.output }, locale);
            const media = r.output && r.fileN !== null ? outputMedia(slug, creative, r.fileN, r.output) : null;
            const aspect = r.preset ? r.preset.width / r.preset.height : r.output ? r.output.width / r.output.height : 1;
            const blocked = r.blocked !== null;
            return (
              <div key={r.id} className={cx('ms-exp-row', blocked ? 'ms-blocked' : !on[r.id] && 'ms-off')}>
                <Check on={!blocked && Boolean(on[r.id])} label={x.include({ label })} disabled={running || blocked} onChange={(v) => setOn((s) => ({ ...s, [r.id]: v }))} />
                <span className={cx('ms-exp-thumb', aspect > 1.05 ? 'ms-wide' : aspect < 0.95 ? 'ms-tall' : 'ms-square')} aria-hidden="true">
                  {media ? (media.video ? <video src={media.src} muted preload="metadata" /> : <img src={media.src} alt="" />) : null}
                </span>
                <span className="ms-exp-name">
                  <span className="ms-exp-label">{r.preset ? <ChannelMark channel={channelOf(r.preset.channel)} /> : null}<b>{label}</b></span>
                  {blocked ? <span className="ms-exp-blocked">{r.blocked}</span> : <span className="ms-exp-file">{name ?? '—'}</span>}
                </span>
                {r.follows !== null ? (
                  <span className="ms-exp-follows">{x.follows({ primary: r.follows })}<span className="ms-exp-ver">{x.star({ n: r.n })}</span></span>
                ) : (
                  <span className="ms-exp-ver">{x.star({ n: r.n })}{r.newer !== null ? <span className="ms-exp-newer">{x.newer({ n: r.newer })}</span> : null}</span>
                )}
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
        <span className="ms-exp-dest-label" id={namesId}>{x.names}</span>
        <div className="ms-exp-pattern">
          <div className="ms-exp-dest-field">
            <Input ref={field} aria-label={x.pattern} aria-describedby={previewId} aria-invalid={nameProblem !== null || undefined} value={pattern}
              disabled={running} spellCheck={false} autoComplete="off" className="ms-exp-pattern-field"
              onChange={(e) => { setPattern(e.target.value); setSave((s) => (s.kind === 'saving' ? s : { kind: 'idle' })); }} />
            <Button variant="outline" disabled={running || save.kind === 'saving' || pattern === savedPattern || tooLong || !pattern.trim() || first?.ok === false}
              loading={save.kind === 'saving'} onClick={() => void saveDefault()}>{x.saveDefault}</Button>
          </div>
          <div className="ms-exp-tokens" role="group" aria-labelledby={namesId}>
            {EXPORT_NAME_TOKENS.map((token) => (
              <Chip key={token} className="ms-exp-token" disabled={running} title={x.insertToken({ token })} onClick={() => insert(token)}>{`{${token}}`}</Chip>
            ))}
          </div>
          <div id={previewId} className="ms-exp-preview">
            {preview ? <span className="ms-exp-preview-line"><span className="ms-exp-preview-label">{x.preview}</span><span className="ms-exp-file">{preview}</span></span> : null}
            {unknown.length ? <span className="ms-exp-hint">{x.unknownVars({ list: unknown.map((u) => `{${u}}`).join(', ') })}</span> : null}
            {nameProblem ? <span role="alert" className="ms-exp-error">{nameProblem}</span> : null}
            {save.kind === 'saved' ? <span role="status" className="ms-exp-note">{x.savedDefault}</span> : null}
            {save.kind === 'failed' ? <span role="alert" className="ms-exp-error">{x.saveFailed({ detail: save.detail })}</span> : null}
          </div>
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
        <Button size="lg" variant="ink" loading={running} disabled={!canRun} onClick={() => void run()}>
          {x.run({ count: chosen.length })}
        </Button>
      </div>
    </div>
  );
}
